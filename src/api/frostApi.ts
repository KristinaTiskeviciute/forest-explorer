import { haversineKm } from "../lib/geo/haversine";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type FrostStation = {
    stationId: string;
    name: string;
    lat: number;
    lon: number;
    distanceKm: number;
};

export type FrostObservation = {
    stationId: string;
    stationName: string;
    stationLat: number;
    stationLon: number;
    distanceKm: number;
    /** Undefined if the station has a gap for this element in the requested window */
    precipitation72hObserved?: number;
    precipitation3dObserved?: number;
    precipitation7dObserved?: number;
    precipitation14dObserved?: number;
    /** Days since the most recent day with >= RAIN_THRESHOLD_MM, within the 14-day window */
    daysSinceRainObserved?: number;
    /** Every qualifying rain day in the 14-day window, as days-ago,
     *  most-recent-first — see the equivalent field in senorgeApi.ts and
     *  rainfallScore.ts for why daysSinceRainObserved alone isn't enough. */
    rainEventsDaysAgoObserved?: number[];
    /** Longest run of consecutive days below RAIN_THRESHOLD_MM within the
     *  14-day window — see the equivalent field in senorgeApi.ts for why
     *  this is distinct from daysSinceRainObserved. */
    maxDrySpellObserved?: number;
    tempMax72hObserved?: number;
    tempMean7dObserved?: number;
    /** Most recent day's minimum ("last night's low") */
    tempMinRecentObserved?: number;
    humidityMeanObserved?: number;
    observedAt: number;
};

/** Beyond this, a "nearest" station is too far to be a meaningful proxy for
 *  local conditions. Tightened from 50 to 20 — a distant station otherwise
 *  flattens scores across a much larger area than intended for near-home use;
 *  loosen this again if pointed at a more remote area with sparser stations. */
const MAX_STATION_DISTANCE_KM = 20;
/** Cache-key granularity for station lookups — far coarser than the sample grid,
 *  matching real station spacing rather than display resolution */
const STATION_BUCKET_DEG = 0.1;
const OBSERVATION_CACHE_TTL_MS = 15 * 60 * 1000;

// Sticky for the session once we learn Frost isn't configured — avoids
// hundreds of redundant "not configured" round-trips across a grid load.
let frostDisabledForSession = false;

const stationCache = new Map<string, FrostStation | null>();
// Dedup key is the RESOLVED station id, not coordinates — station spacing is
// far coarser than grid spacing, so many different grid points legitimately
// share the same nearest station.
const observationCache = new Map<string, { data: FrostObservation | null; fetchedAt: number }>();

/** Exported so callers batching many points (loadGridData.ts) can dedup by
 *  the same bucket this module uses internally, before calling getFrostConditions. */
export function frostStationBucketKey(lat: number, lon: number): string {
    const snap = (v: number) => Math.round(v / STATION_BUCKET_DEG) * STATION_BUCKET_DEG;
    return `${snap(lat).toFixed(2)},${snap(lon).toFixed(2)}`;
}

function parseNearestStation(
    json: {
        data?: Array<{
            id: string;
            name?: string;
            distance?: number;
            geometry?: { coordinates: [number, number] };
        }>;
    },
    lat: number,
    lon: number,
): FrostStation | null {
    const entry = json.data?.[0];
    if (!entry?.geometry?.coordinates) return null;
    const [stationLon, stationLat] = entry.geometry.coordinates;
    return {
        stationId: entry.id,
        name: entry.name ?? entry.id,
        lat: stationLat,
        lon: stationLon,
        // Frost's own `distance` (km, from the nearest() geo query) is
        // authoritative — haversine is only a fallback if it's ever absent.
        distanceKm: entry.distance ?? haversineKm(lat, lon, stationLat, stationLon),
    };
}

type DailyValue = { date: Date; value: number };

/**
 * Parses the raw daily series out of a single-element observation response.
 * Frost commonly reports the SAME daily value twice per entry under
 * different timeOffset conventions (e.g. PT6H and PT18H day boundaries) —
 * take the first match per entry rather than every one, or precipitation
 * would be double-counted.
 */
function parseDailySeries(json: {
    data?: Array<{ referenceTime?: string; observations?: Array<{ value: number }> }>;
}): DailyValue[] {
    const entries = json.data;
    if (!entries || entries.length === 0) return [];

    const series: DailyValue[] = [];
    for (const entry of entries) {
        const value = entry.observations?.[0]?.value;
        if (value === undefined || !entry.referenceTime) continue;
        series.push({ date: new Date(entry.referenceTime), value });
    }
    return series;
}

function sumSeries(series: DailyValue[], sinceDaysAgo: number): number | undefined {
    const cutoff = Date.now() - sinceDaysAgo * 86_400_000;
    const inWindow = series.filter((d) => d.date.getTime() >= cutoff);
    if (inWindow.length === 0) return undefined;
    return inWindow.reduce((sum, d) => sum + d.value, 0);
}

function maxSeries(series: DailyValue[], sinceDaysAgo: number): number | undefined {
    const cutoff = Date.now() - sinceDaysAgo * 86_400_000;
    const inWindow = series.filter((d) => d.date.getTime() >= cutoff);
    if (inWindow.length === 0) return undefined;
    return Math.max(...inWindow.map((d) => d.value));
}

function meanSeries(series: DailyValue[], sinceDaysAgo: number): number | undefined {
    const cutoff = Date.now() - sinceDaysAgo * 86_400_000;
    const inWindow = series.filter((d) => d.date.getTime() >= cutoff);
    if (inWindow.length === 0) return undefined;
    return inWindow.reduce((sum, d) => sum + d.value, 0) / inWindow.length;
}

function mostRecentValue(series: DailyValue[]): number | undefined {
    if (series.length === 0) return undefined;
    return [...series].sort((a, b) => b.date.getTime() - a.date.getTime())[0].value;
}

const RAIN_THRESHOLD_MM = 5;

function daysSinceThreshold(series: DailyValue[], thresholdMm: number): number | undefined {
    const sorted = [...series].sort((a, b) => b.date.getTime() - a.date.getTime());
    if (sorted.length === 0) return undefined;
    const now = Date.now();
    for (const day of sorted) {
        if (day.value >= thresholdMm) {
            return Math.round((now - day.date.getTime()) / 86_400_000);
        }
    }
    return undefined;
}

/** Every qualifying day in the series (not just the first), most-recent-first. */
function rainEventsDaysAgoFromSeries(series: DailyValue[], thresholdMm: number): number[] {
    const sorted = [...series].sort((a, b) => b.date.getTime() - a.date.getTime());
    const now = Date.now();
    return sorted
        .filter((day) => day.value >= thresholdMm)
        .map((day) => Math.round((now - day.date.getTime()) / 86_400_000));
}

/** Longest run of consecutive below-threshold days, oldest-first — same
 *  "how severe was the prior dry stretch" question as senorgeApi.ts's
 *  maxDrySpell, computed from the station's own daily series instead. */
function maxDrySpellFromSeries(series: DailyValue[], thresholdMm: number): number | undefined {
    if (series.length === 0) return undefined;
    const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
    let longest = 0;
    let current = 0;
    for (const day of sorted) {
        if (day.value < thresholdMm) {
            current++;
            longest = Math.max(longest, current);
        } else {
            current = 0;
        }
    }
    return longest;
}

async function findNearestStation(lat: number, lon: number): Promise<FrostStation | null> {
    const key = frostStationBucketKey(lat, lon);
    if (stationCache.has(key)) return stationCache.get(key)!;

    const start = performance.now();
    const { fetchLog } = await import("../lib/debug/fetchLog");

    if (frostDisabledForSession) {
        stationCache.set(key, null);
        return null;
    }

    if (fetchLog.isDryRun()) {
        const mock: FrostStation = { stationId: "SN18700", name: "dry-run", lat, lon, distanceKm: 1 };
        stationCache.set(key, mock);
        fetchLog.record({ type: "frost", lat, lon, hit: false, ms: 0, error: "dry-run" });
        return mock;
    }

    try {
        // MAX_STATION_DISTANCE_KM is enforced client-side (getFrostConditions,
        // via the returned station's distanceKm) — the API has no distance-cutoff param.
        const res = await fetchWithTimeout(`/api/frost/sources?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
        const ms = Math.round(performance.now() - start);

        if (res.status === 501) {
            frostDisabledForSession = true;
            stationCache.set(key, null);
            fetchLog.record({ type: "frost", lat, lon, hit: false, ms, fallback: true, error: "not configured" });
            return null;
        }

        if (!res.ok) {
            stationCache.set(key, null);
            fetchLog.record({ type: "frost", lat, lon, hit: false, ms, fallback: true, error: String(res.status) });
            return null;
        }

        const json = await res.json();
        const station = parseNearestStation(json, lat, lon);
        stationCache.set(key, station);
        fetchLog.record({
            type: "frost",
            lat,
            lon,
            hit: res.headers.get("X-Frost-Cache") === "HIT",
            ms,
            fallback: !station,
            stationId: station?.stationId,
            distanceKm: station?.distanceKm,
        });
        return station;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        stationCache.set(key, null);
        fetchLog.record({
            type: "frost",
            lat,
            lon,
            hit: false,
            ms,
            fallback: true,
            error: err instanceof Error ? err.message : "fetch failed",
        });
        return null;
    }
}

/**
 * Fetches one element's daily series over the last 14 days for a station.
 * Kept as an independent request per element (not a single combined query)
 * because Frost appears to fail the WHOLE query with a 412 when a station
 * lacks a sensor for even one of several requested elements — common in
 * practice, since plain rain-gauge stations without a thermometer (or vice
 * versa) are routine. Querying separately means a station missing one
 * sensor still contributes the others. Widening the window to 14 days (from
 * the original 72h) costs nothing extra per request — Frost just returns
 * more daily rows — but lets multiple windows/days-since-rain be derived
 * from one fetch instead of one request per window.
 */
async function fetchElementSeries(station: FrostStation, element: string): Promise<DailyValue[] | undefined> {
    const start = performance.now();
    const { fetchLog } = await import("../lib/debug/fetchLog");

    const referenceEnd = new Date();
    const referenceStart = new Date(referenceEnd.getTime() - 14 * 86_400_000);
    const referencetime = `${referenceStart.toISOString()}/${referenceEnd.toISOString()}`;

    try {
        const res = await fetchWithTimeout(
            `/api/frost/observations?sources=${station.stationId}` +
                `&elements=${encodeURIComponent(element)}&referencetime=${encodeURIComponent(referencetime)}`,
        );
        const ms = Math.round(performance.now() - start);

        if (!res.ok) {
            fetchLog.record({
                type: "frost",
                lat: station.lat,
                lon: station.lon,
                hit: false,
                ms,
                fallback: true,
                stationId: station.stationId,
                error: String(res.status),
            });
            return undefined;
        }

        const json = await res.json();
        const series = parseDailySeries(json);
        fetchLog.record({
            type: "frost",
            lat: station.lat,
            lon: station.lon,
            hit: res.headers.get("X-Frost-Cache") === "HIT",
            ms,
            fallback: series.length === 0,
            stationId: station.stationId,
            distanceKm: station.distanceKm,
        });
        return series.length > 0 ? series : undefined;
    } catch (err) {
        const ms = Math.round(performance.now() - start);
        fetchLog.record({
            type: "frost",
            lat: station.lat,
            lon: station.lon,
            hit: false,
            ms,
            fallback: true,
            stationId: station.stationId,
            error: err instanceof Error ? err.message : "fetch failed",
        });
        return undefined;
    }
}

async function getStationObservation(station: FrostStation): Promise<FrostObservation | null> {
    const cached = observationCache.get(station.stationId);
    if (cached && Date.now() - cached.fetchedAt < OBSERVATION_CACHE_TTL_MS) {
        return cached.data;
    }

    const { fetchLog } = await import("../lib/debug/fetchLog");

    if (fetchLog.isDryRun()) {
        const mock: FrostObservation = {
            stationId: station.stationId,
            stationName: station.name,
            stationLat: station.lat,
            stationLon: station.lon,
            distanceKm: station.distanceKm,
            precipitation72hObserved: 18,
            precipitation3dObserved: 18,
            precipitation7dObserved: 30,
            precipitation14dObserved: 45,
            daysSinceRainObserved: 1,
            rainEventsDaysAgoObserved: [1],
            maxDrySpellObserved: 4,
            tempMax72hObserved: 16,
            tempMean7dObserved: 13,
            tempMinRecentObserved: 8,
            humidityMeanObserved: 78,
            observedAt: Date.now(),
        };
        observationCache.set(station.stationId, { data: mock, fetchedAt: Date.now() });
        fetchLog.record({ type: "frost", lat: station.lat, lon: station.lon, hit: false, ms: 0, error: "dry-run" });
        return mock;
    }

    const [precipSeries, tempMaxSeries, tempMinSeries, tempMeanSeries, humiditySeries] = await Promise.all([
        fetchElementSeries(station, "sum(precipitation_amount P1D)"),
        fetchElementSeries(station, "max(air_temperature P1D)"),
        fetchElementSeries(station, "min(air_temperature P1D)"),
        fetchElementSeries(station, "mean(air_temperature P1D)"),
        fetchElementSeries(station, "mean(relative_humidity P1D)"),
    ]);

    const precipitation72hObserved = precipSeries ? sumSeries(precipSeries, 3) : undefined;
    const precipitation3dObserved = precipSeries ? sumSeries(precipSeries, 3) : undefined;
    const precipitation7dObserved = precipSeries ? sumSeries(precipSeries, 7) : undefined;
    const precipitation14dObserved = precipSeries ? sumSeries(precipSeries, 14) : undefined;
    const daysSinceRainObserved = precipSeries ? daysSinceThreshold(precipSeries, RAIN_THRESHOLD_MM) : undefined;
    const rainEvents = precipSeries ? rainEventsDaysAgoFromSeries(precipSeries, RAIN_THRESHOLD_MM) : [];
    const rainEventsDaysAgoObserved = rainEvents.length > 0 ? rainEvents : undefined;
    const maxDrySpellObserved = precipSeries ? maxDrySpellFromSeries(precipSeries, RAIN_THRESHOLD_MM) : undefined;
    const tempMax72hObserved = tempMaxSeries ? maxSeries(tempMaxSeries, 3) : undefined;
    const tempMean7dObserved = tempMeanSeries ? meanSeries(tempMeanSeries, 7) : undefined;
    const tempMinRecentObserved = tempMinSeries ? mostRecentValue(tempMinSeries) : undefined;
    // Was mostRecentValue (a single latest reading despite the field's name)
    // — meant VPD could silently mix a real 7-day mean temp with a single
    // instantaneous humidity reading. meanSeries matches tempMean7dObserved's
    // own window exactly, on data already fetched over the full 14-day series.
    const humidityMeanObserved = humiditySeries ? meanSeries(humiditySeries, 7) : undefined;

    const anyField =
        precipitation72hObserved !== undefined ||
        tempMax72hObserved !== undefined ||
        tempMean7dObserved !== undefined ||
        tempMinRecentObserved !== undefined ||
        humidityMeanObserved !== undefined;

    const observation: FrostObservation | null = !anyField
        ? null
        : {
              stationId: station.stationId,
              stationName: station.name,
              stationLat: station.lat,
              stationLon: station.lon,
              distanceKm: station.distanceKm,
              precipitation72hObserved,
              precipitation3dObserved,
              precipitation7dObserved,
              precipitation14dObserved,
              daysSinceRainObserved,
              rainEventsDaysAgoObserved,
              maxDrySpellObserved,
              tempMax72hObserved,
              tempMean7dObserved,
              tempMinRecentObserved,
              humidityMeanObserved,
              observedAt: Date.now(),
          };

    observationCache.set(station.stationId, { data: observation, fetchedAt: Date.now() });
    return observation;
}

/** Real observed past-72h conditions near (lat, lon), or null to fall back to forecast-derived values */
export async function getFrostConditions(lat: number, lon: number): Promise<FrostObservation | null> {
    if (frostDisabledForSession) return null;
    const station = await findNearestStation(lat, lon);
    if (!station) return null;
    // Recomputed for this exact (lat, lon) rather than trusting
    // station.distanceKm — that field is baked in from whichever point in
    // the shared ~11km cache bucket (see frostStationBucketKey) first
    // triggered the lookup, which can wrongly admit or reject a station near
    // the cutoff for every other point sharing that bucket.
    const distanceKm = haversineKm(lat, lon, station.lat, station.lon);
    if (distanceKm > MAX_STATION_DISTANCE_KM) return null;
    return getStationObservation(station);
}
