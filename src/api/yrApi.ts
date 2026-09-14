import { yrCacheKey, yrFetchCoord } from "./yrDedup";
import type { YrForecast } from "./yrParse";
import { parseYrForecast } from "./yrParse";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type { YrForecast } from "./yrParse";
export { yrCacheKey, yrDedupStepForZoom, yrFetchCoord } from "./yrDedup";

const yrCache = new Map<string, { data: YrForecast; fetchedAt: number }>();
const CACHE_TTL_MS = 3_600_000;

/** Neutral placeholder values — used for dry-run mocking, and as the
 *  degraded fallback in loadGridData.ts when a real fetch fails. Yr is the
 *  last-resort forecast tier (see mergeHistoricalConditions), so there's
 *  nothing further down to fall back to on failure. */
export const FALLBACK_FORECAST: YrForecast = {
    temperature: 14,
    humidity: 75,
    temperatureMax24hForecast: 17,
    precipitation24h: 5,
    precipitation72hForecast: 20,
};

function clientCacheKey(lat: number, lon: number, zoom: number): string {
    return `${yrCacheKey(lat, lon, zoom)}@z${zoom}`;
}

export async function getYrForecast(lat: number, lon: number, zoom = 17): Promise<YrForecast> {
    const { lat: fetchLat, lon: fetchLon } = yrFetchCoord(lat, lon, zoom);
    const key = clientCacheKey(fetchLat, fetchLon, zoom);
    const cached = yrCache.get(key);
    const start = performance.now();

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        const { fetchLog } = await import("../lib/debug/fetchLog");
        fetchLog.record({ type: "yr", lat: fetchLat, lon: fetchLon, hit: true, ms: 0 });
        return cached.data;
    }

    if ((await import("../lib/debug/fetchLog")).fetchLog.isDryRun()) {
        const { fetchLog } = await import("../lib/debug/fetchLog");
        fetchLog.record({ type: "yr", lat: fetchLat, lon: fetchLon, hit: false, ms: 0, error: "dry-run" });
        return FALLBACK_FORECAST;
    }

    const res = await fetchWithTimeout(
        `/api/yr?lat=${fetchLat.toFixed(2)}&lon=${fetchLon.toFixed(2)}`,
    );

    const ms = Math.round(performance.now() - start);
    const { fetchLog } = await import("../lib/debug/fetchLog");

    if (!res.ok) {
        fetchLog.record({ type: "yr", lat: fetchLat, lon: fetchLon, hit: false, ms, error: String(res.status) });
        throw new Error(`yr.no fetch failed: ${res.status}`);
    }

    const json = await res.json();
    const data = parseYrForecast(json);

    yrCache.set(key, { data, fetchedAt: Date.now() });
    const proxyCache = res.headers.get("X-Yr-Cache");
    fetchLog.record({
        type: "yr",
        lat: fetchLat,
        lon: fetchLon,
        hit: proxyCache === "HIT",
        ms,
    });
    return data;
}
