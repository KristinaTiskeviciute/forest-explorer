// NVE's seNorge gridded hydro-meteorological data (1km resolution, covers all
// of Norway — no "nearest station" approximation the way Frost has). Found by
// inspecting senorge.no's own map traffic, not a published developer API —
// no registered access, no stated ToS. Every call here must fail gracefully
// (return null) so callers fall back to Frost/Yr transparently if this ever
// breaks or changes upstream.

import { fetchWithTimeout } from "./fetchWithTimeout";

const GRID_INFO_URL = "https://services.xgeo.no/seNorgeMapAppServices/Services/UIService.svc/GetMapGridInfo";
const CHART_URL = "https://chartserver.nve.no/ShowData.aspx";

// GRS80 ellipsoid (ETRS89), UTM zone 33N (EPSG:25833) — the CRS seNorge's
// grid is published in. Standard Snyder transverse-Mercator series, accurate
// to well under a meter — far finer than the 1km grid this feeds.
const UTM_A = 6378137.0;
const UTM_F = 1 / 298.257222101;
const UTM_K0 = 0.9996;
const UTM_LON0_DEG = 15; // zone 33 central meridian
const UTM_FALSE_EASTING = 500000;

// ~5.5km at Norway's latitudes. Deliberately coarser than the grid's native
// 1km resolution: the heatmap's own point spacing (gridStepForBounds) is
// usually *wider* than 1km, so a fine dedup bucket barely dedupes anything —
// nearly every sampled point lands in its own bucket, firing its own round
// of sub-fetches. Measured progression this session: 1km bucket → ~63
// unique buckets/441 requests for a 10km/zoom13 load, load never settling
// within 90s; 3km bucket → ~45 buckets/180 requests, ~65-70s. A raster-
// decode alternative (fetch one WMS image, no per-point requests at all)
// was investigated and rejected: NVE's own color legend for these
// continuous variables is banded (~9 colors for rainfall) and adjacent
// bands overlap in real value (confirmed via calibration against the point
// API), too coarse for the mid-range precision this scoring needs — unlike
// NIBIO's forest classes, which map to fixed non-overlapping colors by
// design. So per-point queries are the only path to real numbers; the bucket
// size is the only lever. Weather doesn't vary meaningfully at sub-5km
// granularity anyway, so trading a bit more spatial precision for fewer
// requests is the right call, and still far finer than Frost's station
// fallback (which can be tens of km away).
const SENORGE_BUCKET_DEG = 0.05;

export function senorgeBucketKey(lat: number, lon: number): string {
    const snap = (v: number) => Math.round(v / SENORGE_BUCKET_DEG) * SENORGE_BUCKET_DEG;
    return `${snap(lat).toFixed(3)},${snap(lon).toFixed(3)}`;
}

export function latLonToUtm33(lat: number, lon: number): { x: number; y: number } {
    const rad = Math.PI / 180;
    const latR = lat * rad;
    const lonR = lon * rad;
    const lon0R = UTM_LON0_DEG * rad;

    const e2 = UTM_F * (2 - UTM_F);
    const ep2 = e2 / (1 - e2);

    const N = UTM_A / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
    const T = Math.tan(latR) ** 2;
    const C = ep2 * Math.cos(latR) ** 2;
    const A = (lonR - lon0R) * Math.cos(latR);

    const M =
        UTM_A *
        ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * latR -
            ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latR) +
            ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latR) -
            ((35 * e2 ** 3) / 3072) * Math.sin(6 * latR));

    const x =
        UTM_FALSE_EASTING +
        UTM_K0 *
            N *
            (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120);

    const y =
        UTM_K0 *
        (M +
            N *
                Math.tan(latR) *
                ((A ** 2) / 2 +
                    ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
                    ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));

    return { x, y };
}

/** Snaps to the grid's real 1km resolution so nearby points legitimately
 *  share one cached fetch, same spirit as nibioCacheSnap/station bucketing. */
function gridSnapKey(x: number, y: number, layerId: string): string {
    const snap = (v: number) => Math.round(v / 1000) * 1000;
    return `${layerId}:${snap(x)},${snap(y)}`;
}

const pointCache = new Map<string, number | null>();
const seriesCache = new Map<string, Array<{ date: Date; value: number }> | null>();

type GridInfoResponse = {
    ErrorMessage: string | null;
    MapGridValue: number[] | null;
    Unit: string | null;
    NoDataValue: number;
};

/** Real gridded value at an exact point for a given date (defaults to now). */
export async function getSenorgeGridValue(lat: number, lon: number, layerId: string, date?: Date): Promise<number | null> {
    const { x, y } = latLonToUtm33(lat, lon);
    const key = gridSnapKey(x, y, layerId) + (date ? `@${date.toISOString().slice(0, 10)}` : "");
    if (pointCache.has(key)) return pointCache.get(key)!;

    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) {
        pointCache.set(key, null);
        return null;
    }

    const at = date ?? new Date();
    const iso = at.toISOString().replace(/\.\d+Z$/, ".999Z");
    const request = { x: Math.round(x), y: Math.round(y), id: layerId, startDateTime: iso, endDateTime: iso };
    const start = performance.now();

    try {
        const res = await fetchWithTimeout(`${GRID_INFO_URL}?request=${encodeURIComponent(JSON.stringify(request))}`);
        const ms = Math.round(performance.now() - start);
        if (!res.ok) {
            fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, error: String(res.status) });
            pointCache.set(key, null);
            return null;
        }
        const json: GridInfoResponse = await res.json();
        const value = json.MapGridValue?.[0];
        const ok = !json.ErrorMessage && value !== undefined && value !== json.NoDataValue;
        fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, fallback: !ok, error: ok ? undefined : json.ErrorMessage ?? "no data" });
        const result = ok ? value! : null;
        pointCache.set(key, result);
        return result;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, fallback: true, error: err instanceof Error ? err.message : "fetch failed" });
        pointCache.set(key, null);
        return null;
    }
}

/** Daily time series over [startDate, endDate] — used for days-since-rain
 *  and any rolling window not already a pre-built seNorge layer. */
export async function getSenorgeSeries(
    lat: number,
    lon: number,
    layerId: string,
    startDate: Date,
    endDate: Date,
): Promise<Array<{ date: Date; value: number }> | null> {
    const { x, y } = latLonToUtm33(lat, lon);
    const key = gridSnapKey(x, y, layerId) + `@${startDate.toISOString().slice(0, 10)}..${endDate.toISOString().slice(0, 10)}`;
    if (seriesCache.has(key)) return seriesCache.get(key)!;

    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) {
        seriesCache.set(key, null);
        return null;
    }

    const fmt = (d: Date) =>
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const chd = `id=${Math.round(x)};${Math.round(y)};${layerId},ds=hgts,time=${fmt(startDate)};${fmt(endDate)},mth=inst,rt=1`;
    const start = performance.now();

    try {
        const res = await fetchWithTimeout(
            `${CHART_URL}?vfmt=json&ver=1.0&req=getchart&time=null;null&lang=no&chd=${encodeURIComponent(chd)}`,
        );
        const ms = Math.round(performance.now() - start);
        if (!res.ok) {
            fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, error: String(res.status) });
            seriesCache.set(key, null);
            return null;
        }
        const json = await res.json();
        const points = json?.[0]?.SeriesPoints as Array<{ Key: string; Value: number }> | undefined;
        if (!points || points.length === 0) {
            fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, fallback: true, error: "no data" });
            seriesCache.set(key, null);
            return null;
        }
        const series = points.map((p) => ({
            date: new Date(Number(p.Key.match(/\d+/)?.[0])),
            value: p.Value,
        }));
        fetchLog.record({ type: "senorge", lat, lon, hit: false, ms });
        seriesCache.set(key, series);
        return series;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({ type: "senorge", lat, lon, hit: false, ms, fallback: true, error: err instanceof Error ? err.message : "fetch failed" });
        seriesCache.set(key, null);
        return null;
    }
}

/**
 * Bulk conditions for an entire loaded grid — a fixed ~15 requests (14 daily
 * rain+temp files + 1 snow-series request), each covering the *whole*
 * radius, instead of one round of point-queries per unique bucket. Mirrors
 * getForestClassesForRadius in nibioApi.ts: returns null on any outright
 * failure so the caller falls back to the untouched per-bucket path below.
 * Wind isn't in this archive at all, so it's deliberately absent here — the
 * caller prefers met_analysis's gridded wind instead, falling back to
 * per-bucket getSenorgeGridValue only if that also fails (see loadGridData.ts).
 */
export async function getSenorgeConditionsForRadius(
    points: Array<{ lat: number; lon: number }>,
    center: { lat: number; lon: number },
    radiusKm: number,
): Promise<Map<string, SenorgeObservation> | null> {
    const { boundsFromCenterRadius, coordKey } = await import("../lib/terrain/types");
    const { boundsToIndexBounds, fetchRecentDailyGrids, fetchRecentSnowDepth, readGridValue, utmToGridIndex } = await import(
        "./senorgeNetcdf"
    );

    const bounds = boundsFromCenterRadius(center.lat, center.lon, radiusKm);
    const corners = [
        latLonToUtm33(bounds.getNorth(), bounds.getWest()),
        latLonToUtm33(bounds.getNorth(), bounds.getEast()),
        latLonToUtm33(bounds.getSouth(), bounds.getWest()),
        latLonToUtm33(bounds.getSouth(), bounds.getEast()),
    ];
    const indexBounds = boundsToIndexBounds(corners, 2);

    const [dailyGrids, snowSteps] = await Promise.all([
        fetchRecentDailyGrids(indexBounds, 14),
        fetchRecentSnowDepth(indexBounds, 14),
    ]);

    if (dailyGrids.length === 0) return null; // total failure — caller falls back

    const result = new Map<string, SenorgeObservation>();
    for (const p of points) {
        const { x, y } = latLonToUtm33(p.lat, p.lon);
        const { xi, yi } = utmToGridIndex(x, y);

        const rrByDay = dailyGrids.map((d) => readGridValue(d.grids.rr, xi, yi));
        const tgByDay = dailyGrids.map((d) => readGridValue(d.grids.tg, xi, yi));
        const tnByDay = dailyGrids.map((d) => readGridValue(d.grids.tn, xi, yi));

        const last = (n: number) => rrByDay.slice(-n).filter((v): v is number => v !== undefined);
        const precipitation3dMm = last(3).length ? last(3).reduce((s, v) => s + v, 0) : undefined;
        const precipitation7dMm = last(7).length ? last(7).reduce((s, v) => s + v, 0) : undefined;
        const precipitation14dMm = last(14).length ? last(14).reduce((s, v) => s + v, 0) : undefined;

        // Every qualifying rain day in the window, most-recent-first — not
        // just the first match. daysSinceRain alone only remembers the single
        // most recent rain, so a spot that rained today *and* 10 days ago
        // (likely already mid-flush from the earlier rain, now topped up)
        // would look identical to one that rained today after two bone-dry
        // weeks. rainfallScore takes whichever event here best matches the
        // target's peak-fruiting window instead of always defaulting to the
        // freshest one.
        let daysSinceRain: number | undefined;
        const rainEventsDaysAgo: number[] = [];
        for (let i = rrByDay.length - 1; i >= 0; i--) {
            const v = rrByDay[i];
            if (v !== undefined && v >= RAIN_THRESHOLD_MM) {
                const daysAgo = rrByDay.length - 1 - i;
                if (daysSinceRain === undefined) daysSinceRain = daysAgo;
                rainEventsDaysAgo.push(daysAgo);
            }
        }

        // rrByDay already spans the full 14-day window fetched above — this
        // is a free derived value, not a new fetch.
        const maxDrySpellDays = maxDrySpell(rrByDay, RAIN_THRESHOLD_MM);

        const recentTemps = tgByDay.slice(-7).filter((v): v is number => v !== undefined);
        const tempMean7dC = recentTemps.length ? recentTemps.reduce((s, v) => s + v, 0) / recentTemps.length : undefined;

        const snowDepthCm = snowSteps?.length ? readGridValue(snowSteps[snowSteps.length - 1].grid, xi, yi) : undefined;

        // Most recent available day's minimum — same "last known value" shape
        // as snowDepthCm above. Only ever populated by this bulk path (the old
        // per-point fallback doesn't fetch tn at all); that's fine, since
        // falling back to that path also means falling back to Frost, which
        // has its own tempMinRecentObserved.
        const tempMinRecentC = [...tnByDay].reverse().find((v): v is number => v !== undefined);

        result.set(coordKey(p.lat, p.lon), {
            precipitation3dMm,
            precipitation7dMm,
            precipitation14dMm,
            daysSinceRain,
            rainEventsDaysAgo: rainEventsDaysAgo.length > 0 ? rainEventsDaysAgo : undefined,
            maxDrySpellDays,
            tempMean7dC,
            tempMinRecentC,
            snowDepthCm,
        });
    }

    return result;
}

export type SenorgeObservation = {
    precipitation3dMm?: number;
    precipitation7dMm?: number;
    precipitation14dMm?: number;
    daysSinceRain?: number;
    /** Every qualifying (>= RAIN_THRESHOLD_MM) rain day in the 14-day window,
     *  as days-ago, most-recent-first — see rainfallScore.ts for why the
     *  single most-recent daysSinceRain above isn't enough on its own. */
    rainEventsDaysAgo?: number[];
    /** Longest run of consecutive days below RAIN_THRESHOLD_MM within the
     *  14-day window — distinct from daysSinceRain, which only says when the
     *  *most recent* rain was. Two points can share the same daysSinceRain
     *  (e.g. 3) while one had steady light rain all along and the other was
     *  bone-dry for 11 days before one recent rain — this field is what
     *  tells those apart. Only ever populated by the bulk radius path (needs
     *  the full 14-day series, not just per-bucket point queries). */
    maxDrySpellDays?: number;
    tempMean7dC?: number;
    /** Only ever populated by the bulk radius path — see getSenorgeConditionsForRadius. */
    tempMinRecentC?: number;
    snowDepthCm?: number;
    windMeanMs?: number;
};

const RAIN_THRESHOLD_MM = 5;

/** Longest run of consecutive below-threshold days in an ordered (oldest
 *  first) daily series — gaps (undefined, e.g. a failed fetch for that day)
 *  are skipped without breaking OR extending the current run, same
 *  "missing isn't zero" treatment as daysSinceRain's own undefined handling
 *  just below. */
function maxDrySpell(byDay: Array<number | undefined>, thresholdMm: number): number | undefined {
    let longest = 0;
    let current = 0;
    let sawAny = false;
    for (const v of byDay) {
        if (v === undefined) continue;
        sawAny = true;
        if (v < thresholdMm) {
            current++;
            longest = Math.max(longest, current);
        } else {
            current = 0;
        }
    }
    return sawAny ? longest : undefined;
}

function daysSinceRainFromSeries(series: Array<{ date: Date; value: number }>): number | undefined {
    const sorted = [...series].sort((a, b) => b.date.getTime() - a.date.getTime());
    const now = sorted[0]?.date ?? new Date();
    for (const day of sorted) {
        if (day.value >= RAIN_THRESHOLD_MM) {
            return Math.round((now.getTime() - day.date.getTime()) / 86_400_000);
        }
    }
    return undefined;
}

/** Every qualifying day in the series (not just the first) — same "now"
 *  reference (the series' own latest date) as daysSinceRainFromSeries above,
 *  so the two never disagree about what day zero is. */
function rainEventsDaysAgoFromSeries(series: Array<{ date: Date; value: number }>): number[] {
    const sorted = [...series].sort((a, b) => b.date.getTime() - a.date.getTime());
    const now = sorted[0]?.date ?? new Date();
    return sorted
        .filter((day) => day.value >= RAIN_THRESHOLD_MM)
        .map((day) => Math.round((now.getTime() - day.date.getTime()) / 86_400_000));
}

function sumRecentDays(series: Array<{ date: Date; value: number }>, days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    return series.filter((d) => d.date.getTime() >= cutoff).reduce((sum, d) => sum + d.value, 0);
}

/** Real gridded conditions at (lat, lon) — every field independently
 *  nullable so callers can fall back to Frost per-field, not all-or-nothing.
 *  Deliberately just 4 sub-fetches (a 14-day rain series covers 3d/7d/14d/
 *  days-since-rain all at once, instead of separate point queries per
 *  window) — this fans out per grid bucket, so keeping it lean matters. */
export async function getSenorgeConditions(lat: number, lon: number): Promise<SenorgeObservation | null> {
    const now = new Date();
    const start14d = new Date(now.getTime() - 14 * 86_400_000);

    const [precip14dSeries, tempSeries7d, snowDepth, wind] = await Promise.all([
        getSenorgeSeries(lat, lon, "rr", start14d, now),
        getSenorgeSeries(lat, lon, "tm", new Date(now.getTime() - 7 * 86_400_000), now),
        getSenorgeGridValue(lat, lon, "sd"),
        getSenorgeGridValue(lat, lon, "windSpeed10m24h06"),
    ]);

    const precipitation3dMm = precip14dSeries ? sumRecentDays(precip14dSeries, 3) : undefined;
    const precipitation7dMm = precip14dSeries ? sumRecentDays(precip14dSeries, 7) : undefined;
    const precipitation14dMm = precip14dSeries?.reduce((sum, d) => sum + d.value, 0);
    const daysSinceRain = precip14dSeries ? daysSinceRainFromSeries(precip14dSeries) : undefined;
    const rainEvents = precip14dSeries ? rainEventsDaysAgoFromSeries(precip14dSeries) : [];
    const rainEventsDaysAgo = rainEvents.length > 0 ? rainEvents : undefined;
    const tempMean7dC = tempSeries7d?.length
        ? tempSeries7d.reduce((sum, d) => sum + d.value, 0) / tempSeries7d.length
        : undefined;

    const observation: SenorgeObservation = {
        precipitation3dMm,
        precipitation7dMm,
        precipitation14dMm,
        daysSinceRain,
        rainEventsDaysAgo,
        tempMean7dC,
        snowDepthCm: snowDepth ?? undefined,
        windMeanMs: wind ?? undefined,
    };

    const anyField = Object.values(observation).some((v) => v !== undefined);
    return anyField ? observation : null;
}
