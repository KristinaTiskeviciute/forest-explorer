import { fetchLog } from "../debug/fetchLog";
import { isTileOverLand } from "../water/waterExclusion";

export function getMapboxToken(): string {
    return (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) ?? "";
}

export function latLonToTileAndPixel(lat: number, lon: number, zoom: number) {
    const scale = Math.pow(2, zoom);
    const sinLat = Math.sin((lat * Math.PI) / 180);

    const worldX = ((lon + 180) / 360) * scale;
    const worldY = ((1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2) * scale;

    const tileX = Math.floor(worldX);
    const tileY = Math.floor(worldY);
    const pixelX = Math.floor((worldX - tileX) * 256);
    const pixelY = Math.floor((worldY - tileY) * 256);

    return { tileX, tileY, pixelX, pixelY };
}

export function rgbToElevation(r: number, g: number, b: number): number {
    return -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
}

export function shouldFetchTerrainTile(z: number, x: number, y: number, ignoreBudget = false): boolean {
    if (!isTileOverLand(z, x, y)) {
        fetchLog.record({ type: "tile", z, x, y, hit: false, skipped: true, reason: "no land" });
        return false;
    }
    if (!ignoreBudget && !fetchLog.canFetchTile()) {
        fetchLog.record({ type: "tile", z, x, y, hit: false, skipped: true, reason: "budget" });
        return false;
    }
    if (fetchLog.isDryRun()) {
        fetchLog.record({ type: "tile", z, x, y, hit: false, skipped: true, reason: "dry-run" });
        return false;
    }
    return true;
}

export function tileBounds(z: number, x: number, y: number) {
    const n = Math.pow(2, z);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
    return {
        west,
        east,
        north: (northRad * 180) / Math.PI,
        south: (southRad * 180) / Math.PI,
    };
}
