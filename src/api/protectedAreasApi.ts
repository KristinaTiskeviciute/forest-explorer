import { booleanPointInPolygon, point } from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { MapBounds } from "../lib/terrain/types";

/**
 * Miljødirektoratet's national protected-areas register ("Naturvernområder")
 * — national parks, nature reserves, landscape protection areas, etc. Used
 * to exclude protected land from foraging suggestions entirely, the same
 * treatment isLand() already gives water and AR5's "Bebygd" class already
 * gives built-up land: not just because several protection categories
 * legally restrict picking, but because suggesting foraging on land that
 * isn't openly available to forage on isn't something this app should do,
 * confirmed vs. the real Fritzøehus landskapsvernområde (Larvik) via this
 * exact endpoint during development.
 *
 * This ArcGIS Server host sends permissive CORS headers itself (confirmed
 * live: Access-Control-Allow-Origin: *), unlike thredds.met.no or the NIBIO
 * WMS services — so this is called directly, with no dev-proxy needed.
 */
const PROTECTED_AREAS_URL =
    "https://kart.miljodirektoratet.no/arcgis/rest/services/vern/mapserver/0/query";

/** One bulk query per grid load (not per point) covers the whole loaded
 *  area — mirrors getForestClassesForRadius/getSenorgeConditionsForRadius's
 *  own "one request for the whole radius" pattern. Cached by rounded bounds
 *  so re-panning the same area doesn't re-fetch; only successful fetches are
 *  cached — a transient failure shouldn't permanently stop excluding areas
 *  for this session (see nibioApi.ts's rasterCache for the same reasoning). */
const boundsCache = new Map<string, FeatureCollection<Polygon | MultiPolygon>>();

function boundsCacheKey(bounds: MapBounds): string {
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
        .map((v) => v.toFixed(4))
        .join(",");
}

function emptyCollection(): FeatureCollection<Polygon | MultiPolygon> {
    return { type: "FeatureCollection", features: [] };
}

export async function getProtectedAreasForBounds(
    bounds: MapBounds,
): Promise<FeatureCollection<Polygon | MultiPolygon>> {
    const key = boundsCacheKey(bounds);
    const cached = boundsCache.get(key);
    if (cached) return cached;

    const { fetchLog } = await import("../lib/debug/fetchLog");
    const start = performance.now();

    const envelope = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
    const params = new URLSearchParams({
        geometry: envelope,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "navn,offisieltNavn,verneform,kommune",
        outSR: "4326",
        f: "geojson",
    });

    try {
        const res = await fetchWithTimeout(`${PROTECTED_AREAS_URL}?${params.toString()}`);
        const ms = Math.round(performance.now() - start);

        if (!res.ok) {
            fetchLog.record({
                type: "naturvern",
                lat: bounds.getNorth(),
                lon: bounds.getWest(),
                hit: false,
                ms,
                error: String(res.status),
            });
            return emptyCollection();
        }

        const geojson = (await res.json()) as FeatureCollection<Polygon | MultiPolygon>;
        fetchLog.record({
            type: "naturvern",
            lat: bounds.getNorth(),
            lon: bounds.getWest(),
            hit: false,
            ms,
            areasFound: geojson.features.length,
        });
        boundsCache.set(key, geojson);
        return geojson;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({
            type: "naturvern",
            lat: bounds.getNorth(),
            lon: bounds.getWest(),
            hit: false,
            ms,
            error: err instanceof Error ? err.message : "fetch failed",
        });
        // Fail open, same as every other source in this app: a network
        // hiccup on this one check shouldn't block the rest of the grid load.
        return emptyCollection();
    }
}

/** True if (lat, lon) falls inside any protected-area polygon in `areas`
 *  (as returned by getProtectedAreasForBounds for the enclosing load). */
export function isInProtectedArea(
    lat: number,
    lon: number,
    areas: FeatureCollection<Polygon | MultiPolygon>,
): boolean {
    if (areas.features.length === 0) return false;
    const p = point([lon, lat]);
    return areas.features.some((feature) => booleanPointInPolygon(p, feature as Feature<Polygon | MultiPolygon>));
}
