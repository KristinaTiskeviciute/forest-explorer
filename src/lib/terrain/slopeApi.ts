import { tileCache, tileKey } from "./tileCache";
import { fetchLog } from "../debug/fetchLog";
import {
    getMapboxToken,
    latLonToTileAndPixel,
    rgbToElevation,
    shouldFetchTerrainTile,
} from "./tileMath";
import { isLand } from "../water/waterExclusion";
import { loadImageWithTimeout } from "../../api/fetchWithTimeout";
import {
    coordKey,
    type TerrainSample,
    MIN_MAPBOX_ZOOM,
} from "./types";

export type { GridPoint } from "./types";

type Point = { lat: number; lon: number };

function getElevationAtPixel(imageData: ImageData, x: number, y: number): number {
    const i = (y * 256 + x) * 4;
    return rgbToElevation(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
}

/**
 * Slope/aspect via Horn's (1981) 3×3 weighted gradient — the same algorithm
 * ArcGIS/QGIS use by default for slope rasters, not a homegrown shortcut.
 * More robust to single-pixel DEM noise than the plain 2-point central
 * difference this replaced (which only ever looked at the 4 pixels directly
 * N/E/S/W of the sample point): this factors in all 8 surrounding pixels,
 * weighting direct neighbors twice as heavily as diagonals. Same overall
 * dzdx/dzdy → slope/aspect conversion as before, just a steadier gradient
 * estimate feeding it. px/py must be pre-clamped to [1,254] by the caller so
 * every neighbor (including diagonals) stays inside the same tile.
 */
function computeSlopeAspect(
    imageData: ImageData,
    px: number,
    py: number,
    cellSizeM: number,
): { slope: number; aspect: number } {
    const elev = (dx: number, dy: number) => getElevationAtPixel(imageData, px + dx, py + dy);

    const nw = elev(-1, -1);
    const n = elev(0, -1);
    const ne = elev(1, -1);
    const w = elev(-1, 0);
    const e = elev(1, 0);
    const sw = elev(-1, 1);
    const s = elev(0, 1);
    const se = elev(1, 1);

    const dzdx = (ne + 2 * e + se - (nw + 2 * w + sw)) / (8 * cellSizeM);
    const dzdy = (nw + 2 * n + ne - (sw + 2 * s + se)) / (8 * cellSizeM);

    const slope = Math.hypot(dzdx, dzdy);
    const aspect = ((Math.atan2(-dzdx, dzdy) * 180) / Math.PI + 360) % 360;

    return { slope, aspect };
}

/** Sub-samples per axis when averaging slope/aspect across a display cell's
 *  footprint (5x5 = 25 samples) — fixed regardless of zoom. It's the
 *  footprint WIDTH (cellHalfWidthPx below) that scales with zoom, not the
 *  sample count, so this stays cheap (a few hundred thousand array reads
 *  across a whole grid load, well under a millisecond of real work) at
 *  every zoom level while still resolving real spatial variation within a
 *  coarse cell. */
const TERRAIN_SUBSAMPLES_PER_AXIS = 5;

/**
 * Averages slope (arithmetic mean) and aspect (circular mean — naive
 * averaging would wrongly put 350° and 10° at 180° instead of 0°) over a
 * grid of Horn's-gradient samples spread across the *display cell's*
 * real-world footprint, instead of reading a single pixel at its center.
 *
 * Why this matters: the terrain-RGB source pixel is ~20m regardless of map
 * zoom, but the display cell it's asked to represent can be 100x that wide
 * at low zoom (see gridStepForZoom in terrain/types.ts) — a single lucky or
 * unlucky pixel there was standing in for an area that can easily contain a
 * ridge, a valley, and several different aspects. Sampling across the
 * cell's actual footprint (data already sitting in the tile we fetched
 * anyway — no extra network cost) makes the result represent what's really
 * there. Naturally converges back to essentially a single-pixel read once
 * the display cell is already close to the source resolution (e.g. zoom
 * 17), since every sub-sample offset then rounds to the same pixel anyway.
 */
function computeAreaAverageSlopeAspect(
    imageData: ImageData,
    centerPx: number,
    centerPy: number,
    cellSizeM: number,
    cellHalfWidthPx: number,
): { slope: number; aspect: number } {
    const n = TERRAIN_SUBSAMPLES_PER_AXIS;
    let slopeSum = 0;
    let sinSum = 0;
    let cosSum = 0;

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const fx = (i / (n - 1)) * 2 - 1; // -1..1
            const fy = (j / (n - 1)) * 2 - 1;
            const px = Math.max(1, Math.min(254, Math.round(centerPx + fx * cellHalfWidthPx)));
            const py = Math.max(1, Math.min(254, Math.round(centerPy + fy * cellHalfWidthPx)));

            const { slope, aspect } = computeSlopeAspect(imageData, px, py, cellSizeM);
            slopeSum += slope;
            const rad = (aspect * Math.PI) / 180;
            sinSum += Math.sin(rad);
            cosSum += Math.cos(rad);
        }
    }

    const count = n * n;
    const meanSlope = slopeSum / count;
    const meanAspect = ((Math.atan2(sinSum, cosSum) * 180) / Math.PI + 360) % 360;
    return { slope: meanSlope, aspect: meanAspect };
}

export async function fetchTerrainTileCached(
    z: number,
    x: number,
    y: number,
    options?: { ignoreBudget?: boolean },
): Promise<ImageData | null> {
    const key = tileKey(z, x, y);

    if (tileCache.has(key)) {
        fetchLog.record({ type: "tile", z, x, y, hit: true });
        return tileCache.get(key)!;
    }

    if (!shouldFetchTerrainTile(z, x, y, options?.ignoreBudget)) {
        return null;
    }

    const token = getMapboxToken();
    if (!token) {
        // No VITE_MAPBOX_TOKEN configured — degrade to "no terrain data"
        // rather than attempting a doomed fetch. Every caller already treats
        // a null tile as absent, the same as a network failure below.
        fetchLog.record({ type: "tile", z, x, y, hit: false, skipped: true, reason: "no mapbox token" });
        return null;
    }
    const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`;

    try {
        const img = await loadImageWithTimeout(url);

        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, 256, 256);
        tileCache.set(key, imageData);
        fetchLog.record({ type: "tile", z, x, y, hit: false });
        return imageData;
    } catch (err) {
        // A bad/expired/rate-limited token surfaces here as an image load
        // failure — degrade the same way a missing token does above, rather
        // than letting this reject uncaught and abort the whole grid load
        // (every other optional source in this app degrades the same way).
        fetchLog.record({
            type: "tile",
            z,
            x,
            y,
            hit: false,
            skipped: true,
            reason: err instanceof Error ? err.message : "tile fetch failed",
        });
        return null;
    }
}

function terrainTileZoom(mapZoom: number): number {
    return Math.min(Math.max(Math.round(mapZoom), 15), 17);
}

export function metersPerPixel(lat: number, zoom: number): number {
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/**
 * Tile footprint in km ≈ 20660 / 2^zoom at Norway's latitudes (256px tile,
 * same metersPerPixel formula used throughout this file). Solve for the zoom
 * that makes ~4 tiles span the full diameter, so terrain-fetch cost is
 * bounded by the chosen radius (a handful of tiles) instead of by how many
 * scoring-grid points happen to exist — a wide-radius/low-zoom load no
 * longer needs one fine tile per point when a few coarse tiles already
 * blanket the whole area.
 */
export function terrainTileZoomForRadius(radiusKm: number): number {
    const targetTilesAcrossDiameter = 4;
    const footprintKmNeeded = (2 * radiusKm) / targetTilesAcrossDiameter;
    const rawZoom = Math.log2(20660 / footprintKmNeeded);
    return Math.min(Math.max(Math.round(rawZoom), 10), 17);
}

/**
 * Terrain for every land point in the loaded grid, not a subsampled
 * fraction — sized so the *tiles* (not the points) are the cost driver. All
 * points landing in the same tile share one fetch; slope/aspect is the
 * area-average across that point's own display cell (see
 * computeAreaAverageSlopeAspect above), not a single pixel reading —
 * gridStepDeg is what tells it how wide that cell actually is.
 */
export async function getTerrainSamplesAtPoints(
    points: Point[],
    radiusKm: number,
    gridStepDeg: number,
    options?: { ignoreBudget?: boolean },
): Promise<Map<string, TerrainSample>> {
    const landPoints = points.filter((p) => isLand(p.lat, p.lon));
    if (!landPoints.length) return new Map();

    const tileZoom = terrainTileZoomForRadius(radiusKm);
    const ignoreBudget = options?.ignoreBudget ?? false;
    const samples = new Map<string, TerrainSample>();

    type Candidate = { lat: number; lon: number; pixelX: number; pixelY: number };
    const byTile = new Map<string, Candidate[]>();

    for (const p of landPoints) {
        const { tileX, tileY, pixelX, pixelY } = latLonToTileAndPixel(p.lat, p.lon, tileZoom);
        const key = tileKey(tileZoom, tileX, tileY);
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key)!.push({ lat: p.lat, lon: p.lon, pixelX, pixelY });
    }

    // Only a handful of tiles now (tied to radius, not point count) —
    // sequential fetch is fine, no load-cap needed the way per-candidate
    // fetching used to require one.
    for (const [key, candidates] of byTile) {
        const [z, x, y] = key.split("/").map(Number);

        if (!tileCache.has(key) && !ignoreBudget && !fetchLog.canFetchTile()) {
            fetchLog.record({ type: "tile", z, x, y, hit: false, skipped: true, reason: "budget" });
            continue;
        }

        const imageData = await fetchTerrainTileCached(z, x, y, { ignoreBudget });
        if (!imageData) continue;

        for (const c of candidates) {
            const px = Math.max(1, Math.min(254, c.pixelX));
            const py = Math.max(1, Math.min(254, c.pixelY));

            const center = getElevationAtPixel(imageData, px, py);
            const mpp = metersPerPixel(c.lat, z);
            // gridStepDeg is the point's own display cell width (in latitude
            // degrees); 111_320 m/degree is the same lat→meters constant
            // already used for this purpose elsewhere in this file (see
            // computeSlopeGrid's dy above).
            const cellMeters = gridStepDeg * 111_320;
            const cellHalfWidthPx = cellMeters / mpp / 2;
            const { slope, aspect } = computeAreaAverageSlopeAspect(imageData, px, py, mpp, cellHalfWidthPx);

            samples.set(coordKey(c.lat, c.lon), {
                lat: c.lat,
                lon: c.lon,
                elevation: center,
                slope,
                aspect,
            });
        }
    }

    return samples;
}

/** Single-point terrain lookup for sidebar / click detail (bypasses tile budget) */
export async function getTerrainAtPoint(
    lat: number,
    lon: number,
    mapZoom: number,
): Promise<TerrainSample | null> {
    if (mapZoom < MIN_MAPBOX_ZOOM || !isLand(lat, lon)) return null;

    const z = terrainTileZoom(mapZoom);
    const { tileX, tileY, pixelX, pixelY } = latLonToTileAndPixel(lat, lon, z);
    const imageData = await fetchTerrainTileCached(z, tileX, tileY, { ignoreBudget: true });
    if (!imageData) return null;

    const px = Math.max(1, Math.min(254, pixelX));
    const py = Math.max(1, Math.min(254, pixelY));

    const center = getElevationAtPixel(imageData, px, py);
    const mpp = metersPerPixel(lat, z);
    const { slope, aspect } = computeSlopeAspect(imageData, px, py, mpp);

    return { lat, lon, elevation: center, slope, aspect };
}

