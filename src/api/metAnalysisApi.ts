// met.no's hourly, observation-based gridded analysis
// (met_analysis_1_0km_nordic) — a second THREDDS/OPeNDAP source alongside
// senorgeNetcdf.ts, providing humidity and wind (neither of which seNorge
// has) at 1km resolution, gridded, for the whole Nordic region. Closes
// Frost's remaining load-bearing gap: once this and seNorge's bulk fetch
// both succeed, Frost has nothing left to uniquely contribute and can be
// skipped entirely (see loadGridData.ts).
//
// Uses a different projection than seNorge — Lambert Conformal Conic, not
// UTM33 — confirmed via the file's own `projection_lcc` attribute:
// "+proj=lcc +lat_0=63 +lon_0=15 +lat_1=63 +lat_2=63 +R=6371000". All three
// parallels are equal (tangent case), so n = sin(lat0), the simplest form
// of the spherical Snyder LCC formula — no ellipsoid eccentricity terms.
//
// windMeanMs/humidityPct/solarRadiationWm2/cloudCoverPct are averaged over
// the last several days (see fetchRecentTrend) rather than one hourly
// snapshot — a single windy hour barely dries anything, a windy week does,
// same "recent conditions beat an instant reading" reasoning already
// applied to temp/rain elsewhere in this pipeline. Each prior complete day
// is itself an average of several hours (see DAY_SAMPLE_HOURS) rather than
// one repeated hour, so the trend reflects a real day shape (solar
// radiation in particular swings hundreds of W/m² across a day) instead of
// whatever moment happened to be "now" when the page loaded. met.no's own
// catalog page explicitly asks not to parallelize OPeNDAP sessions, so the
// whole multi-day, multi-hour fetch stays at low concurrency.

import { mapPool } from "./concurrency";
import { buildThreddsUrl, encodeOpendapSlice, findGridHeader, parseGridBlock, readGridValue, type DecodedGrid, type GridIndexBounds } from "./opendapAscii";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { threddsGate } from "./threddsGate";

// Routed through the dev-server's /api/thredds proxy, not the raw host —
// thredds.met.no sends no CORS headers on these OPeNDAP queries, so a direct
// browser fetch fails every time (confirmed live: net::ERR_FAILED on 100% of
// requests). See vite.config.ts. This is the ONLY source for solar radiation
// and cloud cover (no fallback tier — see historicalConditions.ts), so this
// proxy isn't optional the way it might be for fields with a fallback.
// Exported (not just module-local) so a test can assert these never regress
// back to a direct https://thredds.met.no/... URL, which would silently
// reintroduce the CORS failure this proxy exists to avoid.
export const LATEST_URL = "/api/thredds/dodsC/metpplatest/met_analysis_1_0km_nordic_latest.nc";
export const ARCHIVE_BASE = "/api/thredds/dodsC/metpparchive";

const TREND_DAYS = 7;

const LCC_R = 6_371_000;
const LCC_LAT0 = (63 * Math.PI) / 180;
const LCC_LON0 = (15 * Math.PI) / 180;
const LCC_N = Math.sin(LCC_LAT0);
const LCC_F = (Math.cos(LCC_LAT0) * Math.pow(Math.tan(Math.PI / 4 + LCC_LAT0 / 2), LCC_N)) / LCC_N;
const LCC_RHO0 = (LCC_R * LCC_F) / Math.pow(Math.tan(Math.PI / 4 + LCC_LAT0 / 2), LCC_N);

export function latLonToLcc(lat: number, lon: number): { x: number; y: number } {
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    const rho = (LCC_R * LCC_F) / Math.pow(Math.tan(Math.PI / 4 + latR / 2), LCC_N);
    const theta = LCC_N * (lonR - LCC_LON0);
    return {
        x: rho * Math.sin(theta),
        y: LCC_RHO0 - rho * Math.cos(theta),
    };
}

// Confirmed live by fetching the x/y coordinate arrays directly: 1km LCC
// grid, x ascending from -897442.2, y ascending from -1104322.0.
const GRID_X0 = -897442.2;
const GRID_Y0 = -1104322.0;
const GRID_CELL = 1000;
const GRID_NX = 1796;
const GRID_NY = 2321;

function lccToGridIndex(x: number, y: number): { xi: number; yi: number } {
    return {
        xi: Math.round((x - GRID_X0) / GRID_CELL),
        yi: Math.round((y - GRID_Y0) / GRID_CELL),
    };
}

function boundsToIndexBounds(corners: Array<{ x: number; y: number }>, padCells = 2): GridIndexBounds {
    const indices = corners.map((c) => lccToGridIndex(c.x, c.y));
    const xi0 = Math.max(0, Math.min(...indices.map((i) => i.xi)) - padCells);
    const xi1 = Math.min(GRID_NX - 1, Math.max(...indices.map((i) => i.xi)) + padCells);
    const yi0 = Math.max(0, Math.min(...indices.map((i) => i.yi)) - padCells);
    const yi1 = Math.min(GRID_NY - 1, Math.max(...indices.map((i) => i.yi)) + padCells);
    return { xi0, xi1, yi0, yi1 };
}

export type MetAnalysisObservation = {
    humidityPct?: number;
    windMeanMs?: number;
    /** Average solar power received, W/m² — converted from the raw
     *  accumulated-energy reading (J/m² over the past hour) by /3600.
     *  Fetched and merged for display only so far; not yet wired into
     *  weatherScore/rainfallScore. */
    solarRadiationWm2?: number;
    cloudCoverPct?: number;
};

/** `metpparchive/YYYY/MM/DD/met_analysis_1_0km_nordic_YYYYMMDDTHHZ.nc` — one
 *  file per hour, confirmed live going back to at least 2018. */
function buildArchiveUrl(date: Date, hour: number): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    return `${ARCHIVE_BASE}/${y}/${m}/${d}/met_analysis_1_0km_nordic_${y}${m}${d}T${h}Z.nc`;
}

type HourlyPair = { humidity: DecodedGrid; wind: DecodedGrid; solar: DecodedGrid; cloud: DecodedGrid };

/**
 * Which UTC hours to sample for each of the 6 prior (complete) trend days.
 * Not uniform — chosen from real 24h solar-radiation data for this area
 * (Stavern, a July day): radiation is flat at ~0 overnight, changes fastest
 * across roughly 04-09 and 14-19 UTC (up to ~180 W/m²/hour), and is
 * comparatively flat again near the midday peak (10-13 UTC). This schedule
 * puts a sample roughly every 3h through the fast-changing ramps and
 * relies on the plateau/night hours changing little between samples,
 * rather than fetching all 24 hours for a marginal accuracy gain at ~4x
 * the request cost. Applies to humidity/wind/cloud too since they're
 * bundled into the same request — a reasonable trade for all of them.
 */
const DAY_SAMPLE_HOURS = [0, 3, 6, 9, 12, 15, 18];

/** Cell-wise mean across same-shaped grids (all share the same bounds/size
 *  since they came from the same indexBounds query) — NaN/missing cells are
 *  skipped per-cell rather than poisoning the whole average. */
function averageGrid(grids: DecodedGrid[]): DecodedGrid {
    const bounds = grids[0].bounds;
    const rows = grids[0].values.length;
    const cols = grids[0].values[0]?.length ?? 0;
    const values: number[][] = [];

    for (let r = 0; r < rows; r++) {
        const row: number[] = [];
        for (let c = 0; c < cols; c++) {
            const samples = grids.map((g) => g.values[r][c]).filter(Number.isFinite);
            row.push(samples.length ? samples.reduce((s, v) => s + v, 0) / samples.length : NaN);
        }
        values.push(row);
    }

    return { bounds, values };
}

function averageHourlyPairs(pairs: HourlyPair[]): HourlyPair {
    return {
        humidity: averageGrid(pairs.map((p) => p.humidity)),
        wind: averageGrid(pairs.map((p) => p.wind)),
        solar: averageGrid(pairs.map((p) => p.solar)),
        cloud: averageGrid(pairs.map((p) => p.cloud)),
    };
}

const VARS = ["relative_humidity_2m", "wind_speed_10m", "integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time", "cloud_area_fraction"] as const;

/** Exported for testing — see metAnalysisApi.test.ts's regression guard
 *  against raw, un-percent-encoded brackets in the built query string. */
export function buildVarSlice(varName: string, indexBounds: GridIndexBounds): string {
    return encodeOpendapSlice(`${varName}[0:1:0][${indexBounds.yi0}:1:${indexBounds.yi1}][${indexBounds.xi0}:1:${indexBounds.xi1}]`);
}

// Keyed on the exact request URL (which already encodes both the hour/day
// file and the spatial bounds), so an unchanged anchor+radius reuses
// whatever was already fetched instead of re-hitting the network — a
// zoomend-triggered reload (see GridPointLoader.tsx) asks for the identical
// bounds every time, and going from 1 to 7 sampled hours/day made re-fetching
// all of it on every reload much more painful than it used to be. Archive
// hours are immutable once published, so they cache for the session, same
// "lives forever" precedent as tileCache.ts/nibioApi.ts's raster cache;
// LATEST_URL ("today") genuinely updates through the day, so it gets a
// short TTL instead of permanent caching.
const hourlyPairCache = new Map<string, { data: HourlyPair; fetchedAt: number }>();
const LATEST_CACHE_TTL_MS = 15 * 60 * 1000;

/** One hour's humidity + wind + solar radiation + cloud cover over a bbox,
 *  in a single request (met.no's OPeNDAP endpoint accepts any number of
 *  variables in one query string, so bundling more fields here is free —
 *  no extra requests). */
async function fetchHourlyPair(datasetUrl: string, indexBounds: GridIndexBounds): Promise<HourlyPair | null> {
    const { fetchLog } = await import("../lib/debug/fetchLog");

    const query = VARS.map((v) => buildVarSlice(v, indexBounds)).join(",");
    const url = buildThreddsUrl(`${datasetUrl}.ascii`, query);

    const isLatest = datasetUrl === LATEST_URL;
    const cached = hourlyPairCache.get(url);
    if (cached && (!isLatest || Date.now() - cached.fetchedAt < LATEST_CACHE_TTL_MS)) {
        fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: true, ms: 0 });
        return cached.data;
    }

    const start = performance.now();

    try {
        const res = await threddsGate(() => fetchWithTimeout(url));
        const ms = Math.round(performance.now() - start);
        if (!res.ok) {
            fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: false, ms, error: String(res.status) });
            return null;
        }
        const text = await res.text();

        const rows = indexBounds.yi1 - indexBounds.yi0 + 1;
        const cols = indexBounds.xi1 - indexBounds.xi0 + 1;
        const grids: Partial<Record<(typeof VARS)[number], number[][]>> = {};
        for (const v of VARS) {
            const header = findGridHeader(text, v);
            if (header === null) {
                fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: false, ms, fallback: true, error: "unparseable" });
                return null;
            }
            const values = parseGridBlock(text, text.indexOf("\n", header) + 1, rows, cols).values;
            if (!values) {
                fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: false, ms, fallback: true, error: "unparseable" });
                return null;
            }
            grids[v] = values;
        }
        fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: false, ms });
        const result: HourlyPair = {
            humidity: { bounds: indexBounds, values: grids.relative_humidity_2m! },
            wind: { bounds: indexBounds, values: grids.wind_speed_10m! },
            solar: { bounds: indexBounds, values: grids.integral_of_surface_downwelling_shortwave_flux_in_air_wrt_time! },
            cloud: { bounds: indexBounds, values: grids.cloud_area_fraction! },
        };
        // Only successful, fully-parsed results are cached — a transient
        // network error or a mid-publish partial file shouldn't poison the
        // cache for the rest of the session.
        hourlyPairCache.set(url, { data: result, fetchedAt: Date.now() });
        return result;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({ type: "metAnalysis", lat: 0, lon: 0, hit: false, ms, fallback: true, error: err instanceof Error ? err.message : "fetch failed" });
        return null;
    }
}

/**
 * Last `days` days' humidity/wind/solar/cloud over `bounds`. Today is a
 * single latest-hour reading (via the always-available `latest.nc` alias —
 * today isn't a complete day yet, so there's nothing to average across).
 * Each of the `days - 1` prior *complete* days is sampled at DAY_SAMPLE_HOURS
 * and averaged into one real intra-day mean per day (see averageGrid) —
 * previously this used a single fixed hour repeated across every day, which
 * meant the "trend" never actually saw a day's shape, just whatever moment
 * happened to be "now" when the page loaded, 7 times over.
 *
 * All (day, hour) fetches are flattened into one pool rather than nesting
 * per-day concurrency inside per-day concurrency, which would spike above
 * the low concurrency met.no's catalog page asks for ("don't spawn multiple
 * parallel opendap sessions").  A day with some hours missing/unpublished
 * still contributes a mean of whichever hours succeeded, not a fatal error.
 */
async function fetchRecentTrend(indexBounds: GridIndexBounds, days: number): Promise<HourlyPair[]> {
    const now = new Date();

    const today = await fetchHourlyPair(LATEST_URL, indexBounds);

    type Task = { taskIndex: number; dayIndex: number; url: string };
    const tasks: Task[] = [];
    for (let i = 1; i < days; i++) {
        const date = new Date(now.getTime() - i * 86_400_000);
        for (const hour of DAY_SAMPLE_HOURS) {
            tasks.push({ taskIndex: tasks.length, dayIndex: i, url: buildArchiveUrl(date, hour) });
        }
    }

    const taskResults = new Array<HourlyPair | null>(tasks.length);
    await mapPool(tasks, 2, async (task) => {
        taskResults[task.taskIndex] = await fetchHourlyPair(task.url, indexBounds);
    });

    const byDay = new Map<number, HourlyPair[]>();
    for (const task of tasks) {
        const result = taskResults[task.taskIndex];
        if (!result) continue;
        if (!byDay.has(task.dayIndex)) byDay.set(task.dayIndex, []);
        byDay.get(task.dayIndex)!.push(result);
    }

    const dayMeans = [...byDay.values()].map(averageHourlyPairs);
    return today ? [today, ...dayMeans] : dayMeans;
}

/**
 * Bulk humidity + wind for an entire loaded grid — a bbox-subset request per
 * trend day (today + up to TREND_DAYS-1 prior days), covering the *whole*
 * radius per request, averaged per point once decoded. Returns null only if
 * every day failed, so the caller (loadGridData.ts) falls back to Frost.
 */
export async function getMetAnalysisConditionsForRadius(
    points: Array<{ lat: number; lon: number }>,
    center: { lat: number; lon: number },
    radiusKm: number,
): Promise<Map<string, MetAnalysisObservation> | null> {
    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) return null;

    const { boundsFromCenterRadius, coordKey } = await import("../lib/terrain/types");
    const bounds = boundsFromCenterRadius(center.lat, center.lon, radiusKm);
    const corners = [
        latLonToLcc(bounds.getNorth(), bounds.getWest()),
        latLonToLcc(bounds.getNorth(), bounds.getEast()),
        latLonToLcc(bounds.getSouth(), bounds.getWest()),
        latLonToLcc(bounds.getSouth(), bounds.getEast()),
    ];
    const indexBounds = boundsToIndexBounds(corners);

    const trend = await fetchRecentTrend(indexBounds, TREND_DAYS);
    if (trend.length === 0) return null; // every day failed — caller falls back

    const result = new Map<string, MetAnalysisObservation>();
    for (const p of points) {
        const { x, y } = latLonToLcc(p.lat, p.lon);
        const { xi, yi } = lccToGridIndex(x, y);

        const humidityFractions = trend.map((day) => readGridValue(day.humidity, xi, yi)).filter((v): v is number => v !== undefined);
        const windSpeeds = trend.map((day) => readGridValue(day.wind, xi, yi)).filter((v): v is number => v !== undefined);
        const solarJoules = trend.map((day) => readGridValue(day.solar, xi, yi)).filter((v): v is number => v !== undefined);
        const cloudFractions = trend.map((day) => readGridValue(day.cloud, xi, yi)).filter((v): v is number => v !== undefined);

        const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : undefined);

        const humidityMean = mean(humidityFractions);
        const windMeanMs = mean(windSpeeds);
        // Raw values are accumulated energy (J/m²) over the past hour — /3600
        // converts to average power (W/m²), the conventional way solar
        // irradiance is expressed and compared.
        const solarMean = mean(solarJoules);
        const cloudMean = mean(cloudFractions);

        const humidityPct = humidityMean !== undefined ? humidityMean * 100 : undefined;
        const solarRadiationWm2 = solarMean !== undefined ? solarMean / 3600 : undefined;
        const cloudCoverPct = cloudMean !== undefined ? cloudMean * 100 : undefined;

        result.set(coordKey(p.lat, p.lon), { humidityPct, windMeanMs, solarRadiationWm2, cloudCoverPct });
    }
    return result;
}

/**
 * Single-point, single-hour ("latest" only) convenience path — for App.tsx's
 * sidebar fallback fetch, used only when no grid point exists yet nearby to
 * reuse (e.g. the very first click of a session). Deliberately NOT a
 * thin wrapper around getMetAnalysisConditionsForRadius: that fetches a full
 * TREND_DAYS-day, multi-hour-per-day trend (up to ~43 requests) to get a
 * properly averaged reading, which is the right cost for a bulk grid load
 * but far too heavy for one ad-hoc click — and would contend with
 * threddsGate's shared concurrency=2 cap against the *real* bulk fetch this
 * same click is about to kick off for the grid. One "latest" hour is less
 * precise (an instant reading, not a multi-day mean) but fast and cheap,
 * matching the same "good enough for now, refined once the real grid point
 * loads" spirit this fallback already applies to twi (see App.tsx).
 */
export async function getMetAnalysisLatestAtPoint(lat: number, lon: number): Promise<MetAnalysisObservation | null> {
    const { fetchLog } = await import("../lib/debug/fetchLog");
    if (fetchLog.isDryRun()) return null;

    const { x, y } = latLonToLcc(lat, lon);
    const { xi, yi } = lccToGridIndex(x, y);
    const indexBounds: GridIndexBounds = { xi0: xi, xi1: xi, yi0: yi, yi1: yi };

    const pair = await fetchHourlyPair(LATEST_URL, indexBounds);
    if (!pair) return null;

    const humidityFrac = readGridValue(pair.humidity, xi, yi);
    const windMeanMs = readGridValue(pair.wind, xi, yi);
    const solarJoules = readGridValue(pair.solar, xi, yi);
    const cloudFrac = readGridValue(pair.cloud, xi, yi);

    const observation: MetAnalysisObservation = {
        humidityPct: humidityFrac !== undefined ? humidityFrac * 100 : undefined,
        windMeanMs,
        // Same J/m² -> W/m² conversion as the bulk path above.
        solarRadiationWm2: solarJoules !== undefined ? solarJoules / 3600 : undefined,
        cloudCoverPct: cloudFrac !== undefined ? cloudFrac * 100 : undefined,
    };
    const anyField = Object.values(observation).some((v) => v !== undefined);
    return anyField ? observation : null;
}
