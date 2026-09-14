import type { Connect } from "vite";

const FROST_SOURCES_URL = "https://frost.met.no/sources/v0.jsonld";
const FROST_OBSERVATIONS_URL = "https://frost.met.no/observations/v0.jsonld";
const USER_AGENT = "ForestExplorer/1.0 github.com/forest-explorer (dev-proxy)";

// Station locations are effectively immutable — cache for the whole process lifetime.
const STATION_CACHE_TTL_MS = Infinity;
// "Genuinely recent" is the entire point of this feature, unlike station
// locations above — keep this short so staleness doesn't quietly undermine it.
const OBSERVATION_CACHE_TTL_MS = 15 * 60 * 1000;
// Frost's own guidance: sustained >1 req/sec counts as "heavy traffic" to
// avoid. No published hard limit like YR's, so this is deliberately looser
// than yrProxy.ts's 50ms.
const MIN_UPSTREAM_INTERVAL_MS = 1100;
// Purely a server-side cache-key granularity — real station spacing is much
// coarser than this, so nearby points reusing one lookup is a safe, cheap win.
const STATION_BUCKET_DEG = 0.1;

type CacheEntry = { body: string; status: number; fetchedAt: number };
type UpstreamResult = { body: string; status: number; statusText: string };

// These are real, effective caching/dedup/pacing guarantees under the Vite
// dev server, which is one long-lived Node process — but on a serverless
// deployment (api/frost/*.ts on Vercel), each function invocation can land
// on a different or cold container, so these module-level Maps/chain don't
// persist or coordinate across instances the way they do here. handleFrostRoute
// itself behaves identically either way; what differs is only how much a
// warm, shared process actually gets to help in production. Not a correctness
// issue (Frost's own upstream still enforces its own limits), just not the
// same strength of protection this file's comments might otherwise imply.
const stationCache = new Map<string, CacheEntry>();
const observationCache = new Map<string, CacheEntry>();
let upstreamChain: Promise<void> = Promise.resolve();

// Single-flight de-dup: a burst of near-simultaneous requests for the same
// not-yet-cached key (e.g. many grid points sharing one station bucket right
// after a page load) previously each independently entered scheduleUpstream,
// multiplying real Frost calls beyond the queue's own MIN_UPSTREAM_INTERVAL_MS
// pacing. Keyed by pathname+key since /sources and /observations otherwise
// use unrelated key spaces that could theoretically collide.
const inFlightRequests = new Map<string, Promise<UpstreamResult>>();

function dedupedFetch(dedupeKey: string, upstreamUrl: string, clientId: string): Promise<UpstreamResult> {
    const existing = inFlightRequests.get(dedupeKey);
    if (existing) return existing;

    const request = fetchFromFrost(upstreamUrl, clientId).then(async (upstream) => ({
        body: await upstream.text(),
        status: upstream.status,
        statusText: upstream.statusText,
    }));
    inFlightRequests.set(dedupeKey, request);
    request.finally(() => inFlightRequests.delete(dedupeKey));
    return request;
}

function scheduleUpstream<T>(fn: () => Promise<T>): Promise<T> {
    const run = upstreamChain.then(async () => {
        await new Promise((r) => setTimeout(r, MIN_UPSTREAM_INTERVAL_MS));
        return fn();
    });
    upstreamChain = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

function bucketCoord(lat: number, lon: number): string {
    const snap = (v: number) => Math.round(v / STATION_BUCKET_DEG) * STATION_BUCKET_DEG;
    return `${snap(lat).toFixed(2)},${snap(lon).toFixed(2)}`;
}

/**
 * referencetime is "<start>/<end>" ISO 8601, where the client rebuilds <end>
 * as `new Date().toISOString()` on every single call — millisecond
 * precision means no two requests ever produce the same string, so using it
 * verbatim as a cache key made this cache miss on every request. Bucketing
 * the <end> timestamp to the same granularity as the cache's own TTL means
 * requests within one TTL window share a cache entry, while the exact
 * (unbucketed) referencetime is still what's sent upstream to Frost.
 */
function observationCacheBucket(referencetime: string): string {
    const end = referencetime.split("/")[1] ?? referencetime;
    const ms = Date.parse(end);
    if (Number.isNaN(ms)) return referencetime;
    const bucketMs = Math.floor(ms / OBSERVATION_CACHE_TTL_MS) * OBSERVATION_CACHE_TTL_MS;
    return new Date(bucketMs).toISOString();
}

async function fetchFromFrost(url: string, clientId: string): Promise<Response> {
    // Basic Auth with the client ID as username, empty password — sufficient
    // for Frost's freely-available observation data (OAuth2 is only required
    // for confidential/restricted data, not our use case).
    return scheduleUpstream(() =>
        fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "application/json",
                Authorization: `Basic ${btoa(`${clientId}:`)}`,
            },
        }),
    );
}

export type FrostRoute = "sources" | "observations";
export type FrostRouteResult = { status: number; headers: Record<string, string>; body: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Core Frost proxy logic for /sources (nearest-station lookup) and
 * /observations (pass-through observation query) — framework-agnostic (plain
 * data in, plain data out) so it can be driven by both the Vite dev-server
 * middleware below and a Vercel serverless function (api/frost/*.ts) without
 * duplicating the caching/dedup/validation logic between them.
 */
export async function handleFrostRoute(
    route: FrostRoute,
    params: URLSearchParams,
    clientId: string | undefined,
): Promise<FrostRouteResult> {
    if (!clientId) {
        return { status: 501, headers: JSON_HEADERS, body: JSON.stringify({ error: "frost not configured" }) };
    }

    let cache: Map<string, CacheEntry>;
    let key: string;
    let ttlMs: number;
    let upstreamUrl: string;

    if (route === "sources") {
        const rawLat = params.get("lat");
        const rawLon = params.get("lon");
        const latNum = rawLat === null ? NaN : Number(rawLat);
        const lonNum = rawLon === null ? NaN : Number(rawLon);
        if (
            !Number.isFinite(latNum) ||
            !Number.isFinite(lonNum) ||
            latNum < -90 ||
            latNum > 90 ||
            lonNum < -180 ||
            lonNum > 180
        ) {
            return {
                status: 400,
                headers: JSON_HEADERS,
                body: JSON.stringify({ error: "lat and lon must be finite numbers within valid range" }),
            };
        }
        // Reformatted from the validated numbers (not the raw query
        // string) before use in the cache key or interpolated into the
        // upstream WKT geometry query below.
        const lat = latNum.toFixed(4);
        const lon = lonNum.toFixed(4);
        cache = stationCache;
        key = bucketCoord(latNum, lonNum);
        ttlMs = STATION_CACHE_TTL_MS;
        // Verified against the live v0 API: maxdist/maxcount (from Frost's
        // beta docs) don't exist here — the stable API only supports
        // nearestmaxcount, and has no distance-cutoff param at all. The
        // returned station's own `distance` field is filtered client-side
        // instead (see MAX_STATION_DISTANCE_KM in src/api/frostApi.ts).
        upstreamUrl =
            `${FROST_SOURCES_URL}?types=SensorSystem&geometry=nearest(POINT(${lon} ${lat}))` +
            `&nearestmaxcount=1`;
    } else {
        const sources = params.get("sources");
        const elements = params.get("elements");
        const referencetime = params.get("referencetime");
        if (!sources || !elements || !referencetime) {
            return {
                status: 400,
                headers: JSON_HEADERS,
                body: JSON.stringify({ error: "sources, elements and referencetime query params required" }),
            };
        }
        cache = observationCache;
        key = `${sources}|${elements}|${observationCacheBucket(referencetime)}`;
        ttlMs = OBSERVATION_CACHE_TTL_MS;
        upstreamUrl =
            `${FROST_OBSERVATIONS_URL}?sources=${encodeURIComponent(sources)}` +
            `&elements=${encodeURIComponent(elements)}&referencetime=${encodeURIComponent(referencetime)}`;
    }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
        return { status: cached.status, headers: { ...JSON_HEADERS, "X-Frost-Cache": "HIT" }, body: cached.body };
    }

    try {
        const dedupeKey = `${route}:${key}`;
        const { body, status, statusText } = await dedupedFetch(dedupeKey, upstreamUrl, clientId);

        if (status >= 200 && status < 300) {
            cache.set(key, { body, status, fetchedAt: Date.now() });
        }

        return {
            status,
            headers: { ...JSON_HEADERS, "X-Frost-Cache": "MISS" },
            body: body || JSON.stringify({ error: statusText }),
        };
    } catch (err) {
        return {
            status: 502,
            headers: JSON_HEADERS,
            body: JSON.stringify({ error: err instanceof Error ? err.message : "upstream fetch failed" }),
        };
    }
}

/** Vite dev/preview middleware wrapper — parses the route out of the
 *  (already-mount-prefix-stripped, see frostProxyPlugin.ts) request URL and
 *  writes handleFrostRoute's result to the raw Node response. */
export function createFrostProxyMiddleware(clientId: string | undefined): Connect.NextHandleFunction {
    return async (req, res, next) => {
        if (req.method !== "GET") {
            next();
            return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const route: FrostRoute | null =
            url.pathname === "/sources" ? "sources" : url.pathname === "/observations" ? "observations" : null;
        if (!route) {
            next();
            return;
        }

        const result = await handleFrostRoute(route, url.searchParams, clientId);
        res.statusCode = result.status;
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
        res.end(result.body);
    };
}
