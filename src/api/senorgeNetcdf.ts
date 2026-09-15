// met.no's own documented, licensed (NLOD/CC-BY) THREDDS archive of the raw
// seNorge NetCDF grids, accessed via OPeNDAP — a real alternative to the
// reverse-engineered per-point endpoints in senorgeApi.ts. One request here
// returns exact (not rendered/color-approximated) values for an entire
// bounding box at once, instead of one request per point. Grid geometry
// matches senorgeApi.ts's UTM33 transform, and a spot-checked value agreed
// exactly with the per-point endpoint. Routed through /api/thredds (see the
// DAILY_BASE/SNOW_URL constants below) — thredds.met.no itself sends no CORS
// headers on these queries, so this must go through the dev-server proxy,
// not fetched directly from the browser.
//
// met.no's catalog page explicitly asks not to parallelize OPeNDAP sessions
// ("Don't spawn multiple parallel opendap sessions or file downloads") —
// every multi-file fetch here stays at the low concurrency that respects that.

import { mapPool } from "./concurrency";
import { buildThreddsUrl, encodeOpendapSlice, findGridHeader, parseAsciiGrid, parseGridBlock, type DecodedGrid, type GridIndexBounds } from "./opendapAscii";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { threddsGate } from "./threddsGate";
export { readGridValue, type DecodedGrid, type GridIndexBounds } from "./opendapAscii";

// Routed through the dev-server's /api/thredds proxy, not the raw host —
// thredds.met.no sends no CORS headers on these OPeNDAP queries, so a direct
// browser fetch fails every time (confirmed live: net::ERR_FAILED on 100% of
// requests). See vite.config.ts.
// Exported (not just module-local) so a test can assert these never regress
// back to a direct https://thredds.met.no/... URL, which would silently
// reintroduce the CORS failure this proxy exists to avoid.
export const DAILY_BASE = "/api/thredds/dodsC/senorge/seNorge_2018/Latest";
export const SNOW_URL = "/api/thredds/dodsC/senorge/seNorge_snow/sd/sd_latest.nc";

// Confirmed live by fetching the X/Y coordinate arrays directly: 1km UTM33
// grid, X ascending from -74500, Y *descending* from 7999500.
const GRID_X0 = -74500;
const GRID_Y0 = 7999500;
const GRID_CELL = 1000;
const GRID_NX = 1195;
const GRID_NY = 1550;

// Snow file holds this many days of history in one file (time = 206,
// confirmed ascending — last index is most recent).
const SNOW_TIME_LEN = 206;

export function utmToGridIndex(x: number, y: number): { xi: number; yi: number } {
    return {
        xi: Math.round((x - GRID_X0) / GRID_CELL),
        yi: Math.round((GRID_Y0 - y) / GRID_CELL),
    };
}

export function boundsToIndexBounds(corners: Array<{ x: number; y: number }>, padCells = 1): GridIndexBounds {
    const indices = corners.map((c) => utmToGridIndex(c.x, c.y));
    const xi0 = Math.max(0, Math.min(...indices.map((i) => i.xi)) - padCells);
    const xi1 = Math.min(GRID_NX - 1, Math.max(...indices.map((i) => i.xi)) + padCells);
    const yi0 = Math.max(0, Math.min(...indices.map((i) => i.yi)) - padCells);
    const yi1 = Math.min(GRID_NY - 1, Math.max(...indices.map((i) => i.yi)) + padCells);
    return { xi0, xi1, yi0, yi1 };
}

/** Exported for testing — see senorgeNetcdf.test.ts's regression guard
 *  against raw, un-percent-encoded brackets in the built query string. */
export function buildSliceExpr(varName: string, timeIndex: number | [number, number], bounds: GridIndexBounds): string {
    const t = Array.isArray(timeIndex) ? `${timeIndex[0]}:1:${timeIndex[1]}` : `${timeIndex}:1:${timeIndex}`;
    return encodeOpendapSlice(`${varName}[${t}][${bounds.yi0}:1:${bounds.yi1}][${bounds.xi0}:1:${bounds.xi1}]`);
}

export type DailyGrids = { rr: DecodedGrid; tg: DecodedGrid; tn: DecodedGrid; tx: DecodedGrid };

function dateToFileSuffix(date: Date): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isSameUtcDay(a: Date, b: Date): boolean {
    return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

// Keyed on the exact request URL (date + bounds), so an unchanged
// anchor+radius reuses what's already been fetched instead of re-hitting
// the network on every zoomend-triggered reload (see GridPointLoader.tsx —
// it re-requests the identical bounds every time). Past days are immutable
// once published, so they cache for the session; today's file may still be
// updating through the day, so it gets a short TTL instead.
const dailyGridCache = new Map<string, { data: DailyGrids; fetchedAt: number }>();
const TODAY_CACHE_TTL_MS = 15 * 60 * 1000;

/** One day's rain + mean/min/max temp, for a whole bbox, in a single request. */
async function fetchDailyGrid(date: Date, bounds: GridIndexBounds): Promise<DailyGrids | null> {
    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) return null;

    const vars = ["rr", "tg", "tn", "tx"];
    const query = vars.map((v) => buildSliceExpr(v, 0, bounds)).join(",");
    const suffix = dateToFileSuffix(date);
    const url = buildThreddsUrl(`${DAILY_BASE}/seNorge2018_${suffix}.nc.ascii`, query);

    const isToday = isSameUtcDay(date, new Date());
    const cached = dailyGridCache.get(url);
    if (cached && (!isToday || Date.now() - cached.fetchedAt < TODAY_CACHE_TTL_MS)) {
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: true, ms: 0 });
        return cached.data;
    }

    const start = performance.now();

    try {
        const res = await threddsGate(() => fetchWithTimeout(url));
        const ms = Math.round(performance.now() - start);
        if (!res.ok) {
            fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms, error: String(res.status) });
            return null;
        }
        const text = await res.text();
        const grids = Object.fromEntries(
            vars.map((v) => [v, { bounds, values: parseAsciiGrid(text, v, bounds) }]),
        ) as Record<string, DecodedGrid>;
        if (Object.values(grids).some((g) => g.values === null)) {
            fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms, fallback: true, error: "unparseable" });
            return null;
        }
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms });
        const result = grids as unknown as DailyGrids;
        dailyGridCache.set(url, { data: result, fetchedAt: Date.now() });
        return result;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms, fallback: true, error: err instanceof Error ? err.message : "fetch failed" });
        return null;
    }
}

/** Last `days` daily rain+temp grids covering `bounds`, oldest first. Fetched
 *  at low concurrency (met.no asks not to parallelize OPeNDAP sessions); a
 *  missing/unpublished single day is skipped rather than failing the batch. */
export async function fetchRecentDailyGrids(bounds: GridIndexBounds, days: number): Promise<Array<{ date: Date; grids: DailyGrids }>> {
    const now = new Date();
    const dated = Array.from({ length: days }, (_, i) => ({
        index: i,
        date: new Date(now.getTime() - i * 86_400_000),
    }));

    const results = new Array<{ date: Date; grids: DailyGrids } | null>(dated.length);
    await mapPool(dated, 2, async ({ index, date }) => {
        const grids = await fetchDailyGrid(date, bounds);
        results[index] = grids ? { date, grids } : null;
    });

    return results.filter((r): r is { date: Date; grids: DailyGrids } => r !== null).reverse(); // oldest first
}

// sd_latest.nc is a continuously-updating rolling window (not a per-day
// immutable file like the daily rain/temp grids above), so every cache
// entry here gets the same short TTL rather than caching forever.
const snowCache = new Map<string, { data: Array<{ grid: DecodedGrid }>; fetchedAt: number }>();

/** Last `days` of snow depth (cm) covering `bounds`, oldest first — one
 *  request, since sd_latest.nc already holds a rolling multi-day window. */
export async function fetchRecentSnowDepth(bounds: GridIndexBounds, days: number): Promise<Array<{ grid: DecodedGrid }> | null> {
    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) return null;

    const t1 = SNOW_TIME_LEN - 1;
    const t0 = Math.max(0, t1 - days + 1);
    const query = encodeOpendapSlice(`snow_depth[${t0}:1:${t1}][${bounds.yi0}:1:${bounds.yi1}][${bounds.xi0}:1:${bounds.xi1}]`);
    const url = buildThreddsUrl(`${SNOW_URL}.ascii`, query);

    const cached = snowCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < TODAY_CACHE_TTL_MS) {
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: true, ms: 0 });
        return cached.data;
    }

    const start = performance.now();

    try {
        const res = await threddsGate(() => fetchWithTimeout(url));
        const ms = Math.round(performance.now() - start);
        if (!res.ok) {
            fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms, error: String(res.status) });
            return null;
        }
        const text = await res.text();
        const timeSteps = t1 - t0 + 1;
        const rows = bounds.yi1 - bounds.yi0 + 1;
        const cols = bounds.xi1 - bounds.xi0 + 1;

        // 3D var "snow_depth[time][y][x]" — ascii emits one 2D block per time
        // step, each headed by "snow_depth.snow_depth[T][R][C]" once, then
        // rows labeled "[t][r], v0, v1, ...". Parse each time step's block in
        // sequence via the shared block-parser, advancing past each one.
        const headerPos = findGridHeader(text, "snow_depth");
        if (headerPos === null) return null;

        let pos = text.indexOf("\n", headerPos) + 1;
        const steps: DecodedGrid[] = [];
        for (let t = 0; t < timeSteps; t++) {
            const { values, endPos } = parseGridBlock(text, pos, rows, cols);
            if (!values || values.length !== rows) return null;
            steps.push({ bounds, values });
            pos = endPos;
        }
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms });
        const result = steps.map((grid) => ({ grid }));
        snowCache.set(url, { data: result, fetchedAt: Date.now() });
        return result;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({ type: "senorge", lat: 0, lon: 0, hit: false, ms, fallback: true, error: err instanceof Error ? err.message : "fetch failed" });
        return null;
    }
}
