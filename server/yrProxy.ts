import type { Connect } from "vite";

const MET_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const USER_AGENT = "ForestExplorer/1.0 github.com/forest-explorer (dev-proxy)";
const CACHE_TTL_MS = 3_600_000;
const MIN_UPSTREAM_INTERVAL_MS = 50;

type CacheEntry = { body: string; fetchedAt: number };
type UpstreamResult = { body: string; status: number; statusText: string; ok: boolean };

// Same caveat as frostProxy.ts: this Map and upstreamChain are a real,
// process-wide guarantee under the Vite dev server, but on Vercel
// (api/yr.ts) each function invocation can land on a different or cold
// container, so caching/pacing across requests is best-effort in
// production, not the same strength as here. handleYrRequest's behavior is
// otherwise identical in both environments.
const serverCache = new Map<string, CacheEntry>();
let upstreamChain: Promise<void> = Promise.resolve();

// Single-flight de-dup: without this, a burst of near-simultaneous requests
// for the same not-yet-cached point (e.g. many grid points sharing one
// dedup bucket right after a page load) each independently entered
// scheduleUpstream instead of sharing the one upstream call they actually need.
const inFlightRequests = new Map<string, Promise<UpstreamResult>>();

function cacheKey(lat: string, lon: string): string {
    return `${lat},${lon}`;
}

function dedupedFetch(lat: string, lon: string): Promise<UpstreamResult> {
    const key = cacheKey(lat, lon);
    const existing = inFlightRequests.get(key);
    if (existing) return existing;

    const request = fetchFromMet(lat, lon).then(async (upstream) => ({
        body: await upstream.text(),
        status: upstream.status,
        statusText: upstream.statusText,
        ok: upstream.ok,
    }));
    inFlightRequests.set(key, request);
    request.finally(() => inFlightRequests.delete(key));
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

async function fetchFromMet(lat: string, lon: string): Promise<Response> {
    const url = `${MET_URL}?lat=${lat}&lon=${lon}`;
    return scheduleUpstream(() =>
        fetch(url, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "application/json",
            },
        }),
    );
}

export type YrResult = { status: number; headers: Record<string, string>; body: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Core Yr proxy logic — framework-agnostic, driven by both the Vite
 *  dev-server middleware below and a Vercel serverless function (api/yr.ts). */
export async function handleYrRequest(lat: string, lon: string): Promise<YrResult> {
    const latNum = Number(lat);
    const lonNum = Number(lon);

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

    // Reformatted from the validated numbers (not the raw query string)
    // before use in either the cache key or the upstream URL.
    const fixedLat = latNum.toFixed(4);
    const fixedLon = lonNum.toFixed(4);

    const key = cacheKey(fixedLat, fixedLon);
    const cached = serverCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return { status: 200, headers: { ...JSON_HEADERS, "X-Yr-Cache": "HIT" }, body: cached.body };
    }

    try {
        const { body, status, statusText, ok } = await dedupedFetch(fixedLat, fixedLon);

        if (!ok) {
            return { status, headers: { ...JSON_HEADERS, "X-Yr-Cache": "MISS" }, body: body || JSON.stringify({ error: statusText }) };
        }

        serverCache.set(key, { body, fetchedAt: Date.now() });
        return { status: 200, headers: { ...JSON_HEADERS, "X-Yr-Cache": "MISS" }, body };
    } catch (err) {
        return {
            status: 502,
            headers: JSON_HEADERS,
            body: JSON.stringify({ error: err instanceof Error ? err.message : "upstream fetch failed" }),
        };
    }
}

/** Vite dev/preview middleware wrapper — writes handleYrRequest's result to
 *  the raw Node response. */
export function createYrProxyMiddleware(): Connect.NextHandleFunction {
    return async (req, res, next) => {
        if (req.method !== "GET") {
            next();
            return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const result = await handleYrRequest(url.searchParams.get("lat") ?? "", url.searchParams.get("lon") ?? "");
        res.statusCode = result.status;
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
        res.end(result.body);
    };
}
