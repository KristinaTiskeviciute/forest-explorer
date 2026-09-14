// Imported from the @turf/turf meta-package (the project's only declared
// turf dependency) rather than these scoped sub-packages directly — the
// sub-packages aren't in package.json themselves and only resolved before
// because npm happens to hoist @turf/turf's own dependencies into
// node_modules, a phantom-dependency pattern that isn't guaranteed to
// survive a stricter package manager or a future @turf/turf version.
import { booleanPointInPolygon, booleanIntersects, buffer, bbox, point, polygon } from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import norwayLandRaw from "./norway-land.json";

/** Outward buffer on simplified coastlines so near-shore land isn't marked as water */
export const LAND_MASK_BUFFER_KM = 1.5;

function buildBufferedLandMask(raw: Feature<Polygon | MultiPolygon>): Feature<Polygon | MultiPolygon> {
    const buffered = buffer(raw, LAND_MASK_BUFFER_KM, { units: "kilometers", steps: 8 });
    return (buffered ?? raw) as Feature<Polygon | MultiPolygon>;
}

const norwayLand = buildBufferedLandMask(norwayLandRaw as Feature<Polygon | MultiPolygon>);

const landBbox = bbox(norwayLand) as [number, number, number, number];

export function isLand(lat: number, lon: number): boolean {
    const [minLon, minLat, maxLon, maxLat] = landBbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
    return booleanPointInPolygon(point([lon, lat]), norwayLand);
}

/** Web Mercator tile bounds → test against Norway land (polygon + corner samples) */
export function isTileOverLand(z: number, x: number, y: number): boolean {
    const n = Math.pow(2, z);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
    const north = (northRad * 180) / Math.PI;
    const south = (southRad * 180) / Math.PI;

    const [minLon, minLat, maxLon, maxLat] = landBbox;
    if (east < minLon || west > maxLon || north < minLat || south > maxLat) return false;

    const midLat = (north + south) / 2;
    const midLon = (west + east) / 2;
    const samples: [number, number][] = [
        [midLat, midLon],
        [north, west],
        [north, east],
        [south, west],
        [south, east],
    ];

    if (samples.some(([lat, lon]) => isLand(lat, lon))) return true;

    const tilePoly = polygon([[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
    ]]);

    return booleanIntersects(tilePoly, norwayLand);
}

export function getNorwayLandFeature(): Feature<Polygon | MultiPolygon> {
    return norwayLand;
}

/** Leaflet maxBounds: [[south, west], [north, east]] */
export function getNorwayBounds(): [[number, number], [number, number]] {
    const [minLon, minLat, maxLon, maxLat] = landBbox;
    return [
        [minLat, minLon],
        [maxLat, maxLon],
    ];
}
