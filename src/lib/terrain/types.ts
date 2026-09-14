/** Mapbox terrain-rgb is fetched at this zoom and above (sidebar/single-point) */
export const MIN_MAPBOX_ZOOM = 11;

/** Bulk grid terrain sampling zoom floor — kept separate from
 *  MIN_MAPBOX_GRID_ZOOM (NIBIO neighborhood-voting's own gate) so lowering
 *  one doesn't silently change the other's cost profile too. */
export const MIN_TERRAIN_GRID_ZOOM = 11;

/** NIBIO 5-point neighborhood-voting zoom floor — unrelated to terrain now
 *  that terrain has its own dedicated MIN_TERRAIN_GRID_ZOOM gate above. */
export const MIN_MAPBOX_GRID_ZOOM = 15;

/** Terrain candidate cap grows with zoom: pixel-based sampling needs only ~1
 *  Mapbox tile per candidate, so higher zoom (where you're looking closely
 *  and far more real per-pixel terrain detail exists) can afford denser
 *  sampling. Kept under the session-wide tile budget (see fetchLog.ts) so a
 *  single load can't exhaust it outright. */
export function maxTerrainSamplePointsForZoom(zoom: number): number {
    if (zoom >= 17) return 200;
    if (zoom >= 16) return 144;
    return 96; // zoom 15 baseline
}

/** Per-load Mapbox tile-fetch cap — tracks maxTerrainSamplePointsForZoom since
 *  pixel-based sampling needs at most one new tile per candidate point. */
export function maxNewMapboxTilesForZoom(zoom: number): number {
    return maxTerrainSamplePointsForZoom(zoom);
}

export type TerrainSample = {
    lat: number;
    lon: number;
    elevation: number;
    slope: number;
    aspect: number;
    /** Topographic wetness index — persistent structural drainage/moisture
     *  potential from terrain shape, independent of current weather. Only
     *  populated in the radius-based bulk path (needs a stitched multi-tile
     *  elevation surface for flow accumulation); undefined elsewhere. */
    twi?: number;
};

export type { GridPoint } from "../grid/types";
import type { GridPoint } from "../grid/types";

export type MapBounds = {
    getNorth(): number;
    getSouth(): number;
    getEast(): number;
    getWest(): number;
};

/** Max grid step in degrees — ceiling so zoomed-out views stay coarse.
 *  Quartered from the original ladder (0.1/0.05/0.02/0.01/0.005) to subdivide
 *  4x as finely at every zoom level — roughly 16x the points (and request
 *  cost) per load at any given zoom/radius, in exchange for a much denser grid. */
export function gridStepForZoom(zoom: number): number {
    if (zoom < 11) return 0.025;
    if (zoom < 14) return 0.0125;
    if (zoom < 16) return 0.005;
    if (zoom < 17) return 0.0025;
    return 0.00125;
}

const TARGET_GRID_LINES = 12;
const MIN_GRID_STEP_DEG = 0.0002;

/** Step sized to the visible bounds so the grid always spans multiple rows/columns */
export function gridStepForBounds(bounds: MapBounds, zoom: number): number {
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const span = Math.min(latSpan, lonSpan);
    if (span <= 0) return gridStepForZoom(zoom);

    const viewportStep = span / TARGET_GRID_LINES;
    const maxStep = gridStepForZoom(zoom);
    return Math.max(MIN_GRID_STEP_DEG, Math.min(maxStep, viewportStep));
}

/** Bounding box of radiusKm around a center point (cos(lat)-corrected for longitude) */
export function boundsFromCenterRadius(lat: number, lon: number, radiusKm: number): MapBounds {
    const KM_PER_DEG_LAT = 111;
    const latDelta = radiusKm / KM_PER_DEG_LAT;
    const lonDelta = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    return {
        getNorth: () => lat + latDelta,
        getSouth: () => lat - latDelta,
        getEast: () => lon + lonDelta,
        getWest: () => lon - lonDelta,
    };
}

/** Expand bounds by a fraction of their span (for stable edge interpolation) */
export function padMapBounds(bounds: MapBounds, fraction: number): MapBounds {
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lonSpan = bounds.getEast() - bounds.getWest();
    const latPad = latSpan * fraction;
    const lonPad = lonSpan * fraction;
    return {
        getNorth: () => bounds.getNorth() + latPad,
        getSouth: () => bounds.getSouth() - latPad,
        getEast: () => bounds.getEast() + lonPad,
        getWest: () => bounds.getWest() - lonPad,
    };
}

export function isPointInBounds(lat: number, lon: number, bounds: MapBounds): boolean {
    return lat >= bounds.getSouth() && lat <= bounds.getNorth() && lon >= bounds.getWest() && lon <= bounds.getEast();
}

export type CoarseGrid = {
    points: Array<{ lat: number; lon: number }>;
    step: number;
};

export function buildCoarseGrid(bounds: MapBounds, zoom: number, stepOverride?: number): CoarseGrid {
    const step = stepOverride ?? gridStepForBounds(bounds, zoom);
    const points: Array<{ lat: number; lon: number }> = [];

    // A degree of longitude is physically shorter than a degree of latitude by
    // cos(lat) — inflate the longitude step so rows and columns are equally
    // spaced in real distance instead of packing columns 2-3x denser at
    // Norway's latitudes (mirrors the same correction in buildElevationGrid).
    const centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
    const stepLon = step / Math.cos((centerLat * Math.PI) / 180);

    const startLat = Math.ceil(bounds.getSouth() / step) * step;
    const startLon = Math.ceil(bounds.getWest() / stepLon) * stepLon;

    for (let lat = startLat; lat <= bounds.getNorth(); lat += step) {
        for (let lon = startLon; lon <= bounds.getEast(); lon += stepLon) {
            points.push({
                lat: Math.round(lat * 1e6) / 1e6,
                lon: Math.round(lon * 1e6) / 1e6,
            });
        }
    }

    return { points, step };
}

export function coordKey(lat: number, lon: number): string {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Degree-lon delta expressed in latitude-equivalent degrees, so hypot() distance is comparable on both axes */
function latEquivLonDelta(lat: number, lon: number, targetLon: number): number {
    return (lon - targetLon) * Math.cos((lat * Math.PI) / 180);
}

/** Nearest scored grid point to a map click */
export function findNearestGridPoint(
    points: GridPoint[],
    lat: number,
    lon: number,
    maxDistDeg: number,
): GridPoint | null {
    let best: GridPoint | null = null;
    let bestDist = maxDistDeg;
    for (const p of points) {
        const dist = Math.hypot(p.lat - lat, latEquivLonDelta(p.lat, p.lon, lon));
        if (dist <= bestDist) {
            bestDist = dist;
            best = p;
        }
    }
    return best;
}

/** Match coarse grid points to finer terrain samples from Mapbox */
export function findNearestTerrain(
    points: TerrainSample[],
    lat: number,
    lon: number,
    maxDistDeg: number,
): TerrainSample | undefined {
    let best: TerrainSample | undefined;
    let bestDist = maxDistDeg;
    for (const p of points) {
        const dist = Math.hypot(p.lat - lat, latEquivLonDelta(p.lat, p.lon, lon));
        if (dist <= bestDist) {
            bestDist = dist;
            best = p;
        }
    }
    return best;
}
