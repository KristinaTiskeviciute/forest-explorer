import type { Feature, Polygon } from "geojson";
import type { GridPoint } from "../grid/types";

export const CANVAS_CELL_THRESHOLD = 5_000;

export type ScoreCellSurface = {
    cells: Feature<Polygon>[];
    cellCount: number;
};

/**
 * One square polygon per scored point, sized to the point's own lattice
 * spacing (gridStep, lat-corrected to stepLon — same idiom as
 * buildCoarseGrid/buildElevationGrid) so adjacent squares tile edge-to-edge
 * with no gaps or overlaps. No interpolation, no blending with neighbors —
 * a cell's color is that exact point's own raw score.
 */
export function buildScoreCells(
    points: GridPoint[],
    getScore: (point: GridPoint) => number | null | undefined,
    gridStep: number,
): ScoreCellSurface {
    const cells: Feature<Polygon>[] = [];

    for (const p of points) {
        const score = getScore(p);
        if (score === null || score === undefined) continue;

        const stepLon = gridStep / Math.cos((p.lat * Math.PI) / 180);
        const halfLat = gridStep / 2;
        const halfLon = stepLon / 2;

        const west = p.lon - halfLon;
        const east = p.lon + halfLon;
        const south = p.lat - halfLat;
        const north = p.lat + halfLat;

        cells.push({
            type: "Feature",
            properties: { score },
            geometry: {
                type: "Polygon",
                coordinates: [[
                    [west, south],
                    [east, south],
                    [east, north],
                    [west, north],
                    [west, south],
                ]],
            },
        });
    }

    return { cells, cellCount: cells.length };
}
