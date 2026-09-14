/**
 * Topographic Wetness Index (TWI = ln(A / tan(β))) computation over a raw
 * elevation grid. Pure computation, no fetching/DOM — takes a stitched
 * elevation surface (see twiApi.ts for how that's assembled from Mapbox
 * terrain-rgb tiles) and returns per-cell TWI. Kept separate so it can be
 * unit-tested/verified against real elevation data in isolation before any
 * of the fetch/caching/scoring plumbing around it.
 *
 * D8 flow routing: each cell drains to its single steepest-downhill
 * neighbor (of 8) — the standard, simplest flow-direction model. Known
 * simplification: no pit-filling. A cell with no downhill neighbor (a local
 * depression, real or DEM noise) just terminates flow there rather than
 * being resolved through a proper priority-flood fill. Acceptable for a
 * first version; revisit if real output looks broken in flat/noisy areas.
 */

const NO_DOWNSTREAM = -1;

export type ElevationGrid = {
    /** Row-major, length width*height. NaN marks a missing/unfetched cell. */
    elevation: Float32Array;
    width: number;
    height: number;
    /** Real-world size of one cell, in meters (assumed square/uniform across
     *  the grid — a reasonable approximation for a stitched block spanning
     *  a few km, same simplification metersPerPixel already makes elsewhere). */
    cellSizeM: number;
};

/** 8 neighbor offsets with their distance multiplier (1 for orthogonal, √2 for diagonal). */
const NEIGHBORS: Array<[number, number, number]> = [
    [-1, -1, Math.SQRT2],
    [0, -1, 1],
    [1, -1, Math.SQRT2],
    [-1, 0, 1],
    [1, 0, 1],
    [-1, 1, Math.SQRT2],
    [0, 1, 1],
    [1, 1, Math.SQRT2],
];

/** For each cell, the flat index of its single steepest-downhill neighbor,
 *  or NO_DOWNSTREAM if every neighbor is higher/equal/missing (a pit, a
 *  flat cell, or the grid edge). */
export function computeFlowDirections(grid: ElevationGrid): Int32Array {
    const { elevation, width, height } = grid;
    const downstream = new Int32Array(width * height).fill(NO_DOWNSTREAM);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const z = elevation[i];
            if (!Number.isFinite(z)) continue;

            let bestGradient = 0;
            let bestIndex = NO_DOWNSTREAM;

            for (const [dx, dy, dist] of NEIGHBORS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const ni = ny * width + nx;
                const nz = elevation[ni];
                if (!Number.isFinite(nz)) continue;

                const gradient = (z - nz) / dist;
                if (gradient > bestGradient) {
                    bestGradient = gradient;
                    bestIndex = ni;
                }
            }

            downstream[i] = bestIndex;
        }
    }

    return downstream;
}

/** Each cell's own contribution (1 unit) plus everything that drains through
 *  it, in cell-count units — multiply by cellSizeM² for area in m². Standard
 *  single-pass topological algorithm: processing cells from highest to
 *  lowest elevation guarantees every contributor to a cell (necessarily
 *  higher or equal elevation) is already finalized before that cell is
 *  processed. */
export function computeFlowAccumulation(grid: ElevationGrid, downstream: Int32Array): Float64Array {
    const { elevation, width, height } = grid;
    const n = width * height;
    const accumulation = new Float64Array(n);

    const validIndices: number[] = [];
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(elevation[i])) {
            accumulation[i] = 1;
            validIndices.push(i);
        }
    }

    validIndices.sort((a, b) => elevation[b] - elevation[a]);

    for (const i of validIndices) {
        const target = downstream[i];
        if (target !== NO_DOWNSTREAM) {
            accumulation[target] += accumulation[i];
        }
    }

    return accumulation;
}

/** Central-difference slope magnitude (unitless, rise/run) per cell — NOT
 *  the same technique as the per-point calc in slopeApi.ts, which uses
 *  Horn's (1981) 3×3 weighted gradient for lower noise (a prior version of
 *  this comment incorrectly claimed the two matched). Horn's method reads
 *  twice as many neighbors per cell; affordable at the handful of sample
 *  points slopeApi.ts scores, not yet revisited for every cell of the whole
 *  stitched elevation grid TWI needs here. Edge cells (no full neighbor set)
 *  are left NaN. */
export function computeSlopeGrid(grid: ElevationGrid): Float32Array {
    const { elevation, width, height, cellSizeM } = grid;
    const slope = new Float32Array(width * height).fill(NaN);

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            const west = elevation[i - 1];
            const east = elevation[i + 1];
            const north = elevation[i - width];
            const south = elevation[i + width];
            if (![west, east, north, south].every(Number.isFinite)) continue;

            const dzdx = (east - west) / (2 * cellSizeM);
            const dzdy = (south - north) / (2 * cellSizeM);
            slope[i] = Math.hypot(dzdx, dzdy);
        }
    }

    return slope;
}

/** Floor on tan(β) (not an angle in radians, despite names like this often
 *  denoting one elsewhere — slope[] is already a rise/run tangent, see
 *  computeSlopeGrid above) before the TWI division — a perfectly flat cell
 *  would otherwise divide by zero and produce Infinity. Standard practical
 *  fix used throughout TWI literature/tooling, not a magic number specific
 *  to this codebase. */
const MIN_TAN_SLOPE = 0.001;

/**
 * TWI = ln(SCA / tan(β)) per cell. SCA (specific catchment area) is
 * approximated as accumulation-in-cells × cellSizeM — the standard raster
 * simplification (each cell's flow width is treated as one cell-width),
 * used by most GIS tools rather than a true per-unit-contour-length
 * calculation. β is the slope angle in radians; since computeSlopeGrid
 * returns rise/run (a tangent already, not an angle), tan(β) here is used
 * directly as that same rise/run value — no atan/tan round-trip needed.
 */
export function computeTWI(grid: ElevationGrid, accumulation: Float64Array, slope: Float32Array): Float32Array {
    const { elevation, cellSizeM } = grid;
    const twi = new Float32Array(elevation.length).fill(NaN);

    for (let i = 0; i < elevation.length; i++) {
        if (!Number.isFinite(elevation[i]) || !Number.isFinite(slope[i])) continue;
        const sca = accumulation[i] * cellSizeM;
        const tanBeta = Math.max(MIN_TAN_SLOPE, slope[i]);
        twi[i] = Math.log(sca / tanBeta);
    }

    return twi;
}

/** Convenience: run the full pipeline (slope → flow direction → accumulation → TWI). */
export function computeTwiGrid(grid: ElevationGrid): Float32Array {
    const slope = computeSlopeGrid(grid);
    const downstream = computeFlowDirections(grid);
    const accumulation = computeFlowAccumulation(grid, downstream);
    return computeTWI(grid, accumulation, slope);
}
