// Topographic Wetness Index — fetches a stitched block of Mapbox terrain-rgb
// tiles covering an analysis radius (not just the tiles that happen to
// contain a scoring-grid point, the way slopeApi.ts's slope/aspect path
// does), runs flow-accumulation over the combined elevation surface, and
// returns per-point TWI. Deliberately a separate path from slopeApi.ts's
// working slope/aspect fetch rather than a rewrite of it — this only needs
// the same underlying tiles and a couple of its helpers.

import { tileCache, tileKey } from "./tileCache";
import { latLonToTileAndPixel, rgbToElevation, tileBounds } from "./tileMath";
import { fetchTerrainTileCached, metersPerPixel, terrainTileZoomForRadius } from "./slopeApi";
import { computeTwiGrid } from "./flowAccumulation";
import { boundsFromCenterRadius, coordKey } from "./types";
import { isLand } from "../water/waterExclusion";
import { haversineKm } from "../geo/haversine";
import { fetchLog } from "../debug/fetchLog";

type TileBlock = { zoom: number; xMin: number; xMax: number; yMin: number; yMax: number };

type StitchedTwiGrid = {
    twi: Float32Array;
    width: number;
    height: number;
    zoom: number;
    xMin: number;
    yMin: number;
};

// Keyed on the exact tile block (not fuzzy-rounded bounds) so cache hits are
// unambiguous. Never evicted — same "lives for the session" precedent as
// tileCache itself and nibioApi.ts's raster cache; the flow-accumulation
// pass is the expensive part worth avoiding on repeat loads of the same area.
const twiGridCache = new Map<string, StitchedTwiGrid>();

function tileBlockKey(block: TileBlock): string {
    return `${block.zoom}/${block.xMin}/${block.xMax}/${block.yMin}/${block.yMax}`;
}

/** Closest point on a lat/lon rectangle to a given point, then haversine —
 *  same approximation level as the rest of this codebase's radius math
 *  (boundsFromCenterRadius etc. also treat degrees as locally flat). Used to
 *  skip tiles in the bounding *square* that don't actually touch the
 *  analysis *circle*, so a wide radius doesn't fetch every corner tile. */
function tileIntersectsCircle(
    bounds: { west: number; east: number; north: number; south: number },
    center: { lat: number; lon: number },
    radiusKm: number,
): boolean {
    const nearestLat = Math.max(bounds.south, Math.min(bounds.north, center.lat));
    const nearestLon = Math.max(bounds.west, Math.min(bounds.east, center.lon));
    return haversineKm(center.lat, center.lon, nearestLat, nearestLon) <= radiusKm;
}

async function buildTwiGrid(
    block: TileBlock,
    center: { lat: number; lon: number },
    radiusKm: number,
    ignoreBudget: boolean,
): Promise<StitchedTwiGrid> {
    const { zoom, xMin, xMax, yMin, yMax } = block;
    const tilesWide = xMax - xMin + 1;
    const tilesHigh = yMax - yMin + 1;
    const width = tilesWide * 256;
    const height = tilesHigh * 256;
    const elevation = new Float32Array(width * height).fill(NaN);

    for (let ty = yMin; ty <= yMax; ty++) {
        for (let tx = xMin; tx <= xMax; tx++) {
            if (!tileIntersectsCircle(tileBounds(zoom, tx, ty), center, radiusKm)) continue;

            const key = tileKey(zoom, tx, ty);
            if (!tileCache.has(key) && !ignoreBudget && !fetchLog.canFetchTile()) {
                fetchLog.record({ type: "tile", z: zoom, x: tx, y: ty, hit: false, skipped: true, reason: "budget" });
                continue;
            }

            const imageData = await fetchTerrainTileCached(zoom, tx, ty, { ignoreBudget });
            if (!imageData) continue; // no land / dry-run / budget exhausted mid-loop — leaves NaN, handled downstream

            const offsetX = (tx - xMin) * 256;
            const offsetY = (ty - yMin) * 256;
            for (let py = 0; py < 256; py++) {
                for (let px = 0; px < 256; px++) {
                    const i = (py * 256 + px) * 4;
                    const elev = rgbToElevation(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
                    elevation[(offsetY + py) * width + (offsetX + px)] = elev;
                }
            }
        }
    }

    const cellSizeM = metersPerPixel(center.lat, zoom);
    const twi = computeTwiGrid({ elevation, width, height, cellSizeM });

    return { twi, width, height, zoom, xMin, yMin };
}

/**
 * TWI for every land point in `points`, covering the whole `radiusKm` around
 * `center` — one stitched-tile-block computation shared across all of them,
 * not a per-point fetch. Same signature shape as the other bulk per-radius
 * fetchers (getSenorgeConditionsForRadius, getMetAnalysisConditionsForRadius)
 * so loadGridData.ts can merge it the same way. Missing values (budget
 * exhausted, no land, dry-run) are simply absent from the returned map,
 * same convention as every other optional field in this pipeline.
 */
export async function getTwiForPoints(
    points: Array<{ lat: number; lon: number }>,
    center: { lat: number; lon: number },
    radiusKm: number,
    options?: { ignoreBudget?: boolean },
): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (fetchLog.isDryRun()) return result;

    const landPoints = points.filter((p) => isLand(p.lat, p.lon));
    if (!landPoints.length) return result;

    const ignoreBudget = options?.ignoreBudget ?? false;
    const zoom = terrainTileZoomForRadius(radiusKm);
    const bounds = boundsFromCenterRadius(center.lat, center.lon, radiusKm);

    const corners = [
        latLonToTileAndPixel(bounds.getNorth(), bounds.getWest(), zoom),
        latLonToTileAndPixel(bounds.getNorth(), bounds.getEast(), zoom),
        latLonToTileAndPixel(bounds.getSouth(), bounds.getWest(), zoom),
        latLonToTileAndPixel(bounds.getSouth(), bounds.getEast(), zoom),
    ];
    const block: TileBlock = {
        zoom,
        xMin: Math.min(...corners.map((c) => c.tileX)),
        xMax: Math.max(...corners.map((c) => c.tileX)),
        yMin: Math.min(...corners.map((c) => c.tileY)),
        yMax: Math.max(...corners.map((c) => c.tileY)),
    };

    const key = tileBlockKey(block);
    let grid = twiGridCache.get(key);
    if (!grid) {
        grid = await buildTwiGrid(block, center, radiusKm, ignoreBudget);
        twiGridCache.set(key, grid);
    }

    for (const p of landPoints) {
        const { tileX, tileY, pixelX, pixelY } = latLonToTileAndPixel(p.lat, p.lon, zoom);
        const gx = (tileX - grid.xMin) * 256 + pixelX;
        const gy = (tileY - grid.yMin) * 256 + pixelY;
        if (gx < 0 || gx >= grid.width || gy < 0 || gy >= grid.height) continue;

        const value = grid.twi[gy * grid.width + gx];
        if (Number.isFinite(value)) result.set(coordKey(p.lat, p.lon), value);
    }

    return result;
}
