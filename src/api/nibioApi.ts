import { MIN_MAPBOX_GRID_ZOOM, boundsFromCenterRadius, coordKey, type MapBounds } from "../lib/terrain/types";
import { fetchWithTimeout, loadImageWithTimeout } from "./fetchWithTimeout";

// "gran"/"furu"/"lauv"/"none" are from the SR16 tree-species experiment (see
// USE_TRESLAG_EXPERIMENT below) — kept in this same union for now to avoid
// touching every consumer; split out properly if the experiment becomes permanent.
export type AR5Class =
    | "skog"
    | "myr"
    | "aapen"
    | "dyrka"
    | "bebygd"
    | "gran"
    | "furu"
    | "lauv"
    | "none"
    | "unknown";

const nibioCache = new Map<string, AR5Class>();

// Bucket size is the caller's actual sample-grid spacing (gridStep), not a
// zoom-derived ceiling — gridStepForZoom alone is only an upper bound, and
// the real per-load spacing (gridStepForBounds, viewport-aware) is usually
// finer, so using the ceiling here still let many adjacent points collapse
// onto the same cached classification.
function nibioSnapCoord(lat: number, lon: number, gridStep: number): { lat: number; lon: number } {
    const snappedLat = Math.round(lat / gridStep) * gridStep;
    // lonStep derives from the snapped lat (not raw lat) so two points in the
    // same lat bucket always agree on lon bucket boundaries.
    const lonStep = gridStep / Math.cos((snappedLat * Math.PI) / 180);
    const snappedLon = Math.round(lon / lonStep) * lonStep;
    return { lat: snappedLat, lon: snappedLon };
}

function cacheKey(lat: number, lon: number, gridStep: number): string {
    const { lat: la, lon: lo } = nibioSnapCoord(lat, lon, gridStep);
    return `${la.toFixed(6)},${lo.toFixed(6)}`;
}

const classMap: Record<string, AR5Class> = {
    "11": "bebygd",
    // "12" (Samferdsel — roads/tracks) intentionally scored like open ground,
    // not built-up. A forest road running through otherwise-good habitat
    // shouldn't zero out the score the way an actual town does, and — since
    // classification is sampled at points — a road pixel is common even deep
    // inside real forest (logging roads, cabin driveways, hiking tracks).
    "12": "aapen",
    "21": "dyrka",
    "22": "dyrka",
    "23": "dyrka",
    "30": "skog",
    "31": "skog",
    "32": "skog",
    "33": "skog",
    "50": "aapen",
    "60": "myr",
};

function parseArtypeFromGml(xml: string): string | null {
    if (xml.includes("ServiceException")) return null;
    return xml.match(/<artype>(\d+)<\/artype>/)?.[1] ?? null;
}

function buildNibioUrl(lat: number, lon: number): string {
    const bbox = `${lat - 0.001},${lon - 0.001},${lat + 0.001},${lon + 0.001}`;
    const params = new URLSearchParams({
        SERVICE: "WMS",
        VERSION: "1.3.0",
        REQUEST: "GetFeatureInfo",
        LAYERS: "Arealtype",
        QUERY_LAYERS: "Arealtype",
        BBOX: bbox,
        CRS: "EPSG:4326",
        WIDTH: "21",
        HEIGHT: "21",
        I: "10",
        J: "10",
        INFO_FORMAT: "application/vnd.ogc.gml",
    });
    return `/api/nibio?${params.toString()}`;
}

/** Single WMS point query — the building block neighborhood voting samples 5 of.
 *  Returns null (rather than "unknown") on a transient fetch/service failure,
 *  so callers can tell "genuinely no data here" apart from "couldn't ask" and
 *  avoid caching the latter as if it were a stable answer. */
async function fetchArtypeClass(lat: number, lon: number): Promise<AR5Class | null> {
    const start = performance.now();
    const { fetchLog } = await import("../lib/debug/fetchLog");

    try {
        const res = await fetchWithTimeout(buildNibioUrl(lat, lon));
        const ms = Math.round(performance.now() - start);
        const text = await res.text();

        if (!res.ok || text.includes("ServiceException")) {
            fetchLog.record({
                type: "nibio",
                lat,
                lon,
                hit: false,
                ms,
                error: text.includes("ServiceException") ? "wms error" : String(res.status),
            });
            return null;
        }

        const code = parseArtypeFromGml(text);
        fetchLog.record({ type: "nibio", lat, lon, hit: false, ms });
        return code ? (classMap[code] ?? "unknown") : "unknown";
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({
            type: "nibio",
            lat,
            lon,
            hit: false,
            ms,
            error: err instanceof Error ? err.message : "fetch failed",
        });
        return null;
    }
}

function buildTreslagUrl(lat: number, lon: number): string {
    const bbox = `${lat - 0.001},${lon - 0.001},${lat + 0.001},${lon + 0.001}`;
    const params = new URLSearchParams({
        SERVICE: "WMS",
        VERSION: "1.3.0",
        REQUEST: "GetFeatureInfo",
        LAYERS: "SRRTRESLAG",
        QUERY_LAYERS: "SRRTRESLAG",
        BBOX: bbox,
        CRS: "EPSG:4326",
        WIDTH: "21",
        HEIGHT: "21",
        I: "10",
        J: "10",
        // Unlike Arealtype, SRRTRESLAG's GML response has no usable value —
        // verified live against wms.nibio.no/cgi-bin/sr16: GML comes back
        // with just a bounding box, no attribute. text/html embeds the value
        // inside a `document.write(...)` call instead, so that's parsed here.
        INFO_FORMAT: "text/html",
    });
    return `/api/nibio-sr16?${params.toString()}`;
}

const treslagMap: Record<string, AR5Class> = {
    "1": "gran",
    "2": "furu",
    "3": "lauv",
    "-9999": "none",
};

function parseTreslagFromHtml(html: string): string | null {
    return html.match(/SRRTRESLAG:<\/td><td>(-?\d+)<\/td>/)?.[1] ?? null;
}

/** Single WMS point query against NIBIO's SR16 tree-species layer. Returns
 *  null (rather than "unknown") on a transient fetch failure — see
 *  fetchArtypeClass above for why that distinction matters for caching. */
async function fetchTreslagClass(lat: number, lon: number): Promise<AR5Class | null> {
    const start = performance.now();
    const { fetchLog } = await import("../lib/debug/fetchLog");

    try {
        const res = await fetchWithTimeout(buildTreslagUrl(lat, lon));
        const ms = Math.round(performance.now() - start);
        const text = await res.text();

        if (!res.ok) {
            fetchLog.record({ type: "nibio", lat, lon, hit: false, ms, error: String(res.status) });
            return null;
        }

        const code = parseTreslagFromHtml(text);
        fetchLog.record({ type: "nibio", lat, lon, hit: false, ms });
        return code ? (treslagMap[code] ?? "unknown") : "unknown";
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({
            type: "nibio",
            lat,
            lon,
            hit: false,
            ms,
            error: err instanceof Error ? err.message : "fetch failed",
        });
        return null;
    }
}

export function majorityClass<T>(classes: T[]): T {
    let best = classes[0];
    let bestCount = 0;
    const counts = new Map<T, number>();
    for (const c of classes) {
        const count = (counts.get(c) ?? 0) + 1;
        counts.set(c, count);
        if (count > bestCount) {
            best = c;
            bestCount = count;
        }
    }
    return best;
}

// ~50m at Norway's latitudes — enough to step past a narrow forest road/track
// (typically a few meters to ~20m wide) without straying into a genuinely
// different neighborhood, capped by gridStep/2 so the cluster never overlaps
// an adjacent grid point's own territory at fine zoom.
const NEIGHBORHOOD_RADIUS_DEG = 0.00045;

/**
 * A single WMS sample often lands on a narrow non-forest feature (a road,
 * track, or small clearing) inside what's overwhelmingly forest — sample a
 * small cross around the point and take the majority class instead of
 * trusting one pixel. Also the only defense against small forest patches
 * being missed by an unlucky single sample (though a patch smaller than
 * AR5's own minimum mapping unit won't exist as a polygon at all, and no
 * amount of sampling here can recover that). Generic over the per-point
 * fetch so both the Arealtype and SR16 tree-species paths can reuse the same
 * sampling geometry.
 */
export async function sampleNeighborhood<T>(
    lat: number,
    lon: number,
    gridStep: number,
    fetchOne: (lat: number, lon: number) => Promise<T | null>,
): Promise<T | null> {
    const radius = Math.min(NEIGHBORHOOD_RADIUS_DEG, gridStep / 2);
    const lonRadius = radius / Math.cos((lat * Math.PI) / 180);

    const points: Array<[number, number]> = [
        [lat, lon],
        [lat + radius, lon],
        [lat - radius, lon],
        [lat, lon + lonRadius],
        [lat, lon - lonRadius],
    ];

    const classes = await Promise.all(points.map(([plat, plon]) => fetchOne(plat, plon)));
    // Failed samples (null — see fetchArtypeClass/fetchTreslagClass) don't
    // get a vote; if every sample in the neighborhood failed, propagate that
    // as a total failure rather than silently voting among zero results.
    const successful = classes.filter((c) => c !== null) as T[];
    if (successful.length === 0) return null;
    return majorityClass(successful);
}

async function classifyNeighborhood(lat: number, lon: number, gridStep: number): Promise<AR5Class | null> {
    return sampleNeighborhood(lat, lon, gridStep, fetchArtypeClass);
}

// Exact colors NIBIO's SR16 WMS renders SRRTRESLAG with — verified live via
// GetMap + canvas pixel readback: flat, non-anti-aliased, one color per
// class (transparent for "-9999"/not-forest, via TRANSPARENT=true).
const TRESLAG_COLORS: Array<{ rgb: [number, number, number]; cls: AR5Class }> = [
    { rgb: [82, 176, 56], cls: "gran" },
    { rgb: [205, 170, 101], cls: "furu" },
    { rgb: [255, 220, 130], cls: "lauv" },
];

/** Nearest-match (not exact) as a defensive fallback — observed colors were
 *  exact and flat, but this costs nothing and protects against any future
 *  rendering difference (e.g. a style change upstream). */
function classifyPixel(r: number, g: number, b: number, a: number): AR5Class {
    if (a === 0) return "none";
    let best: AR5Class = "none";
    let bestDist = Infinity;
    for (const { rgb, cls } of TRESLAG_COLORS) {
        const dist = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
        if (dist < bestDist) {
            bestDist = dist;
            best = cls;
        }
    }
    return best;
}

function buildTreslagMapUrl(bounds: MapBounds, widthPx: number, heightPx: number): string {
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    const params = new URLSearchParams({
        SERVICE: "WMS",
        VERSION: "1.3.0",
        REQUEST: "GetMap",
        LAYERS: "SRRTRESLAG",
        STYLES: "",
        BBOX: bbox,
        CRS: "EPSG:4326",
        WIDTH: String(widthPx),
        HEIGHT: String(heightPx),
        FORMAT: "image/png",
        TRANSPARENT: "true",
    });
    return `/api/nibio-sr16?${params.toString()}`;
}

type TreslagRaster = {
    imageData: ImageData;
    widthPx: number;
    heightPx: number;
    bounds: MapBounds;
};

// SR16's own native resolution — no point requesting finer pixels than the
// source data has. Caps well under NIBIO's advertised MaxWidth/MaxHeight of
// 5120, confirmed live: a 30km-diameter area (the slider's max) only needs
// ~3750px at this resolution.
const SR16_METERS_PER_PIXEL = 16;
const MAX_RASTER_DIM = 4096;

// Cached indefinitely for the session, same philosophy as terrain's tileCache
// — SR16 data doesn't change mid-session, so a zoomend-triggered reload of
// the same anchor+radius reuses the already-decoded raster for free. Only
// ever holds successful fetches (see the catch branch below) so a fetch
// failure doesn't get stuck as a permanent cache entry.
const rasterCache = new Map<string, TreslagRaster>();

function rasterCacheKey(bounds: MapBounds): string {
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
        .map((v) => v.toFixed(5))
        .join(",");
}

async function fetchTreslagRaster(bounds: MapBounds): Promise<TreslagRaster | null> {
    const key = rasterCacheKey(bounds);
    if (rasterCache.has(key)) return rasterCache.get(key)!;

    const centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
    const centerLon = (bounds.getEast() + bounds.getWest()) / 2;
    const heightM = (bounds.getNorth() - bounds.getSouth()) * 111_320;
    const widthM = (bounds.getEast() - bounds.getWest()) * 111_320 * Math.cos((centerLat * Math.PI) / 180);
    const heightPx = Math.min(MAX_RASTER_DIM, Math.max(1, Math.round(heightM / SR16_METERS_PER_PIXEL)));
    const widthPx = Math.min(MAX_RASTER_DIM, Math.max(1, Math.round(widthM / SR16_METERS_PER_PIXEL)));

    const start = performance.now();
    const { fetchLog } = await import("../lib/debug/fetchLog");
    const url = buildTreslagMapUrl(bounds, widthPx, heightPx);

    try {
        const img = await loadImageWithTimeout(url);

        const canvas = document.createElement("canvas");
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, widthPx, heightPx);

        const raster: TreslagRaster = { imageData, widthPx, heightPx, bounds };
        rasterCache.set(key, raster);
        fetchLog.record({
            type: "nibio",
            lat: centerLat,
            lon: centerLon,
            hit: false,
            ms: Math.round(performance.now() - start),
        });
        return raster;
    } catch (err) {
        // Deliberately not cached: a transient failure here shouldn't
        // permanently blank forest classification for this viewport for the
        // rest of the session — only a successful raster is cached above.
        fetchLog.record({
            type: "nibio",
            lat: centerLat,
            lon: centerLon,
            hit: false,
            ms: Math.round(performance.now() - start),
            error: err instanceof Error ? err.message : "fetch failed",
        });
        return null;
    }
}

/** Majority vote over a 3×3 pixel neighborhood — free now that the whole
 *  area is already decoded, replacing the old 5-point *network* vote with
 *  a pixel vote that costs nothing extra and needs no zoom gating. */
function classifyFromRaster(raster: TreslagRaster, lat: number, lon: number): AR5Class {
    const { imageData, widthPx, heightPx, bounds } = raster;
    const xFrac = (lon - bounds.getWest()) / (bounds.getEast() - bounds.getWest());
    const yFrac = (bounds.getNorth() - lat) / (bounds.getNorth() - bounds.getSouth());
    const cx = Math.round(xFrac * (widthPx - 1));
    const cy = Math.round(yFrac * (heightPx - 1));

    const votes: AR5Class[] = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const px = Math.max(0, Math.min(widthPx - 1, cx + dx));
            const py = Math.max(0, Math.min(heightPx - 1, cy + dy));
            const i = (py * widthPx + px) * 4;
            votes.push(classifyPixel(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2], imageData.data[i + 3]));
        }
    }
    return majorityClass(votes);
}

/**
 * Bulk forest classification for an entire loaded grid — one GetMap raster
 * covering the whole radius instead of one GetFeatureInfo request per point.
 * Returns null if the SR16 experiment is off, signaling the caller to fall
 * back to the per-point path (which stays untouched for that case).
 */
export async function getForestClassesForRadius(
    points: Array<{ lat: number; lon: number }>,
    center: { lat: number; lon: number },
    radiusKm: number,
): Promise<Map<string, AR5Class> | null> {
    if (!USE_TRESLAG_EXPERIMENT) return null;

    const { fetchLog } = await import("../lib/debug/fetchLog");
    const result = new Map<string, AR5Class>();

    if (fetchLog.isDryRun()) {
        for (const p of points) result.set(coordKey(p.lat, p.lon), "unknown");
        return result;
    }

    const bounds = boundsFromCenterRadius(center.lat, center.lon, radiusKm);
    const raster = await fetchTreslagRaster(bounds);

    for (const p of points) {
        result.set(coordKey(p.lat, p.lon), raster ? classifyFromRaster(raster, p.lat, p.lon) : "unknown");
    }
    return result;
}

// Neighborhood voting only kicks in at MIN_MAPBOX_GRID_ZOOM+ — the same band
// where the app already starts caring about fine local precision (terrain
// sampling). Measured in practice: voting every point in a dense forest
// viewport can mean 800+ NIBIO requests for one load — worth it when zoomed
// in on a specific area, wasteful for a wide low-zoom overview where you're
// less likely to be evaluating one exact spot anyway.
//
// TEMPORARY EXPERIMENT: use NIBIO's SR16 tree-species classification
// (gran/furu/lauv/none) instead of Arealtype's forest/non-forest/bog/etc.
// The Arealtype path below is untouched and still fully wired up — flip this
// back to false to instantly revert to today's behavior.
const USE_TRESLAG_EXPERIMENT = true;

export async function getForestClass(lat: number, lon: number, gridStep: number, mapZoom: number): Promise<AR5Class> {
    const key = cacheKey(lat, lon, gridStep);

    if (nibioCache.has(key)) {
        const { fetchLog } = await import("../lib/debug/fetchLog");
        fetchLog.record({ type: "nibio", lat, lon, hit: true, ms: 0 });
        return nibioCache.get(key)!;
    }

    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) {
        fetchLog.record({ type: "nibio", lat, lon, hit: false, ms: 0, error: "dry-run" });
        nibioCache.set(key, "unknown");
        return "unknown";
    }

    const result = USE_TRESLAG_EXPERIMENT
        ? mapZoom >= MIN_MAPBOX_GRID_ZOOM
            ? await sampleNeighborhood(lat, lon, gridStep, fetchTreslagClass)
            : await fetchTreslagClass(lat, lon)
        : mapZoom >= MIN_MAPBOX_GRID_ZOOM
          ? await classifyNeighborhood(lat, lon, gridStep)
          : await fetchArtypeClass(lat, lon);

    // null means every attempt was a fetch/service failure, not a genuine
    // "no data here" — don't cache it, so the next request for this point
    // gets a real retry instead of being stuck with a guess for the session.
    if (result === null) return "unknown";

    nibioCache.set(key, result);
    return result;
}

export function nibioCacheSnap(lat: number, lon: number, gridStep: number) {
    return nibioSnapCoord(lat, lon, gridStep);
}
