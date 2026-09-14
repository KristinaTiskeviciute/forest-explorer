import type { Map as LeafletMap } from "leaflet";
import {
    buildCoarseGrid,
    coordKey,
    gridStepForZoom,
    isPointInBounds,
    MIN_MAPBOX_GRID_ZOOM,
    MIN_TERRAIN_GRID_ZOOM,
    padMapBounds,
    type MapBounds,
    type TerrainSample,
} from "../terrain/types";
import { getTerrainSamplesAtPoints } from "../terrain/slopeApi";
import { getTwiForPoints } from "../terrain/twiApi";
import { getYrForecast, FALLBACK_FORECAST } from "../../api/yrApi";
import { yrCacheKeyAtStep, yrFetchCoordAtStep, yrDedupStepForRadius, yrDedupStepForZoom } from "../../api/yrDedup";
import { getForestClass, getForestClassesForRadius, nibioCacheSnap } from "../../api/nibioApi";
import { getFrostConditions, frostStationBucketKey, type FrostObservation } from "../../api/frostApi";
import {
    getSenorgeConditions,
    getSenorgeConditionsForRadius,
    getSenorgeGridValue,
    senorgeBucketKey,
    type SenorgeObservation,
} from "../../api/senorgeApi";
import { getMetAnalysisConditionsForRadius, type MetAnalysisObservation } from "../../api/metAnalysisApi";
import { getProtectedAreasForBounds, isInProtectedArea } from "../../api/protectedAreasApi";
import { isLand } from "../water/waterExclusion";
import { haversineKm } from "../geo/haversine";
import { compositeScore } from "../scoring/compositeScore";
import { mergeHistoricalConditions } from "../scoring/historicalConditions";
import type { ForagingTarget } from "../scoring/foragingTargets";
import { mapPool } from "../../api/concurrency";
import { fetchLog } from "../debug/fetchLog";
import type { GridPoint, LoadGridResult, LoadStage } from "./types";

/** How often to re-emit an in-progress partial result while the slow
 *  historical sub-stages are running — see emitPeriodically in loadGridData. */
const PROGRESS_TICK_MS = 3000;

/**
 * Caches keyed the same way the pipeline above already builds them — pulled
 * out into its own type only so buildDisplayResult can be called with
 * exactly one shape of arguments.
 */
type DisplayResultCaches = {
    forecastCache: Map<string, Awaited<ReturnType<typeof getYrForecast>>>;
    forestCache: Map<string, Awaited<ReturnType<typeof getForestClass>>>;
    historicalCache: Map<string, FrostObservation | null>;
    senorgeByCoord: Map<string, SenorgeObservation | null>;
    bulkMetAnalysis: Map<string, MetAnalysisObservation> | null;
    terrainByKey: Map<string, TerrainSample>;
    twiByKey: Map<string, number>;
};

type DisplayResultContext = {
    mapZoom: number;
    foragingTarget: ForagingTarget | undefined;
    yrStep: number;
    interpBounds: MapBounds;
};

/**
 * Scores every land point and trims to the display bounds — pulled out of
 * loadGridData itself so it can run twice (an early pass with empty
 * historical caches, then the final pass) without duplicating the scoring
 * logic. Pure function of its inputs: same caches in, same points out,
 * regardless of which pipeline stage called it.
 */
function buildDisplayResult(
    landPoints: Array<{ lat: number; lon: number }>,
    caches: DisplayResultCaches,
    ctx: DisplayResultContext,
): { displayPoints: GridPoint[]; terrainMatched: number } {
    const { forecastCache, forestCache, historicalCache, senorgeByCoord, bulkMetAnalysis, terrainByKey, twiByKey } = caches;
    const { mapZoom, foragingTarget, yrStep, interpBounds } = ctx;

    let terrainMatched = 0;

    const points: GridPoint[] = landPoints.map((p) => {
        const forecast = forecastCache.get(yrCacheKeyAtStep(p.lat, p.lon, yrStep))!;
        const forestClass = forestCache.get(coordKey(p.lat, p.lon))!;
        const historical = historicalCache.get(frostStationBucketKey(p.lat, p.lon)) ?? null;
        const senorge = senorgeByCoord.get(coordKey(p.lat, p.lon)) ?? null;
        const metAnalysis = bulkMetAnalysis?.get(coordKey(p.lat, p.lon)) ?? null;
        const conditions = mergeHistoricalConditions(senorge, historical, forecast, metAnalysis);
        const terrain = terrainByKey.get(coordKey(p.lat, p.lon));
        const twi = twiByKey.get(coordKey(p.lat, p.lon));

        if (terrain) terrainMatched++;

        const breakdown = compositeScore({
            zoom: mapZoom,
            forecast,
            conditions,
            forestClass,
            slope: terrain?.slope,
            aspect: terrain?.aspect,
            twi,
            foragingTarget,
        });

        return {
            lat: p.lat,
            lon: p.lon,
            elevation: terrain?.elevation,
            slope: terrain?.slope,
            aspect: terrain?.aspect,
            twi,
            forecast,
            historical,
            scores: {
                composite: breakdown.composite,
                weather: breakdown.weather,
                rainfall: breakdown.rainfall,
                forest: breakdown.forest,
                terrain: breakdown.terrain,
            },
            debug: breakdown,
        };
    });

    const displayPoints = points.filter((p) => isPointInBounds(p.lat, p.lon, interpBounds));
    return { displayPoints, terrainMatched };
}

export type LoadGridOptions = {
    bounds: MapBounds;
    mapZoom: number;
    /** When set with radiusKm, trims sampled points to a true geodesic disc
     *  around this point instead of the full (rectangular) bounds — this is
     *  what actually cuts request volume, not just the display area. */
    center?: { lat: number; lon: number };
    radiusKm?: number;
    foragingTarget?: ForagingTarget;
    /** Bypass Mapbox tile budget (debug) */
    ignoreTerrainBudget?: boolean;
    signal?: AbortSignal;
    /** Fired once, right after weather resolves but before the (potentially
     *  slow, Frost-fallback-prone) historical stage — a fully-scored but
     *  less-refined result the caller can show immediately instead of
     *  waiting on the whole pipeline. The function's own return value is
     *  always the final, fully-refined result regardless of this callback. */
    onPartialResult?: (result: LoadGridResult) => void;
    /** Fired at each pipeline stage transition, for a progress indicator. */
    onProgress?: (stage: LoadStage) => void;
};

export async function loadGridData(options: LoadGridOptions): Promise<LoadGridResult> {
    const {
        bounds,
        mapZoom,
        center,
        radiusKm,
        foragingTarget,
        ignoreTerrainBudget = false,
        signal,
        onPartialResult,
        onProgress,
    } = options;

    // Safe unconditionally — a freshly-created AbortController can't be
    // pre-aborted, so no abort check is needed before this first call.
    onProgress?.("terrain");

    const start = performance.now();
    const sampleBounds = padMapBounds(bounds, 0.35);
    // When anchored, cell size is pinned to the same absolute per-zoom
    // resolution used elsewhere (terrain/NIBIO gating) instead of being
    // re-derived as "~12 lines across whatever bounds I was given" — that
    // viewport-fitting heuristic made sense when bounds were an unpredictable
    // live viewport, but now that bounds are a radius we chose ourselves, it
    // decoupled resolution (and cost) from the radius entirely. Pinning to
    // gridStepForZoom means point count — and request cost — scales honestly
    // with radius² at a given zoom; the tradeoff is a small radius at low
    // zoom renders coarser (zoom in for detail, same as everywhere else).
    const anchoredStep = center && radiusKm !== undefined ? gridStepForZoom(mapZoom) : undefined;
    const { points: rawGrid, step: gridStep } = buildCoarseGrid(sampleBounds, mapZoom, anchoredStep);
    // Reused at every abort-guard return below — an aborted load (superseded
    // by a newer click/zoom) always resolves to this same empty shape.
    const emptyResult: LoadGridResult = {
        points: [],
        terrainDebug: { samples: [], targets: [] },
        gridStep,
        protectedAreas: { type: "FeatureCollection", features: [] },
    };
    // A pure function of `bounds` (fixed for this whole call) — computed
    // once, shared between the checkpoint-A partial result and the final one.
    const interpBounds = padMapBounds(bounds, 0.25);
    // Trim to radius minus half a cell so a point's rendered square (which
    // extends gridStep/2 beyond its own center) stays within the circle
    // instead of visibly poking past it.
    const effectiveRadiusKm = radiusKm !== undefined ? Math.max(0, radiusKm - gridStep / 2) : radiusKm;

    // One bulk query for the whole loaded area (not per point) — excludes
    // national parks/nature reserves/landscape protection areas etc. the
    // same way isLand() excludes water, before any further fetching happens
    // for a point that would just get thrown away anyway.
    const protectedAreas = await getProtectedAreasForBounds(sampleBounds);
    if (signal?.aborted) {
        return emptyResult;
    }

    const landPoints = rawGrid
        .filter((p) => isLand(p.lat, p.lon) && !isInProtectedArea(p.lat, p.lon, protectedAreas))
        .filter((p) =>
            center && effectiveRadiusKm !== undefined
                ? haversineKm(center.lat, center.lon, p.lat, p.lon) <= effectiveRadiusKm
                : true,
        );

    // Terrain: tiles are now sized to blanket the whole chosen radius (a
    // handful of tiles), so every land point gets real terrain data directly
    // — no candidate subsampling, no nearest-terrain fallback needed.
    const terrainTargets = mapZoom >= MIN_TERRAIN_GRID_ZOOM ? landPoints : [];
    const terrainByKey =
        mapZoom >= MIN_TERRAIN_GRID_ZOOM && radiusKm !== undefined
            ? await getTerrainSamplesAtPoints(landPoints, radiusKm, gridStep, { ignoreBudget: ignoreTerrainBudget })
            : new Map();

    // TWI needs a stitched multi-tile elevation surface (flow accumulation
    // crosses tile boundaries), so it's a separate fetch from the per-point
    // slope/aspect path above rather than folded into it — see twiApi.ts.
    // Same zoom/radius gate as terrain; additionally needs `center` (which
    // the per-point terrain path above doesn't) to know what area to stitch.
    const twiByKey =
        mapZoom >= MIN_TERRAIN_GRID_ZOOM && center !== undefined && radiusKm !== undefined
            ? await getTwiForPoints(landPoints, center, radiusKm, { ignoreBudget: ignoreTerrainBudget })
            : new Map<string, number>();

    if (signal?.aborted) {
        return emptyResult;
    }
    onProgress?.("forest");

    const terrainSamples = [...terrainByKey.values()];
    // Terrain never changes after this point — compute the display-trimmed
    // version once and reuse it for every partial result (checkpoint A,
    // periodic ticks below, and the final one) instead of re-filtering the
    // same arrays repeatedly.
    const displayTerrain = terrainSamples.filter((s) => isPointInBounds(s.lat, s.lon, interpBounds));
    const displayTargets = terrainTargets.filter((t) => isPointInBounds(t.lat, t.lon, interpBounds));

    const forecastCache = new Map<string, Awaited<ReturnType<typeof getYrForecast>>>();
    const historicalCache = new Map<string, FrostObservation | null>();

    const yrKeys = new Set<string>();
    const frostKeys = new Set<string>();
    const yrCoords = new Map<string, ReturnType<typeof yrFetchCoordAtStep>>();
    const frostCoords = new Map<string, { lat: number; lon: number }>();

    // Ties weather/rainfall dedup granularity to the chosen radius instead of
    // zoom — a zoom-derived bucket could be bigger than the whole analysis
    // area, flattening temperature/rainfall across the entire loaded circle.
    const yrStep = radiusKm !== undefined ? yrDedupStepForRadius(radiusKm) : yrDedupStepForZoom(mapZoom);

    for (const p of landPoints) {
        const key = yrCacheKeyAtStep(p.lat, p.lon, yrStep);
        yrKeys.add(key);
        if (!yrCoords.has(key)) yrCoords.set(key, yrFetchCoordAtStep(p.lat, p.lon, yrStep));
    }

    // Dedup key is the same coarse station bucket frostApi.ts uses internally —
    // real station spacing is far coarser than the sample grid, so many
    // points legitimately share one nearest-station/observation fetch.
    for (const p of landPoints) {
        const key = frostStationBucketKey(p.lat, p.lon);
        frostKeys.add(key);
        if (!frostCoords.has(key)) frostCoords.set(key, { lat: p.lat, lon: p.lon });
    }

    // Forest: a single GetMap raster covering the whole radius replaces one
    // GetFeatureInfo request per point — getForestClassesForRadius returns
    // null when that path isn't applicable (SR16 experiment off, or no
    // radius context), falling back to the untouched per-point path below.
    const bulkForest =
        center && radiusKm !== undefined
            ? await getForestClassesForRadius(landPoints, center, radiusKm)
            : null;

    const forestCache = bulkForest ?? new Map<string, Awaited<ReturnType<typeof getForestClass>>>();

    if (!bulkForest) {
        // Bucket-dedup for the fetch itself (still genuinely per-request
        // costly here), then expand results out to every point's own exact
        // coordKey so downstream lookup is uniform regardless of which path ran.
        const bucketResults = new Map<string, Awaited<ReturnType<typeof getForestClass>>>();
        const nibioKeys = new Set<string>();
        const nibioCoords = new Map<string, { lat: number; lon: number }>();
        for (const p of landPoints) {
            const nibio = nibioCacheSnap(p.lat, p.lon, gridStep);
            const key = `${nibio.lat},${nibio.lon}`;
            nibioKeys.add(key);
            nibioCoords.set(key, nibio);
        }

        // getForestClass only samples a 5-point neighborhood at zoom 15+ (see
        // MIN_MAPBOX_GRID_ZOOM in nibioApi.ts) — below that it's still a
        // single cheap request per point, so a lower concurrency is only
        // needed once the 5x multiplier is actually active.
        await mapPool([...nibioKeys], mapZoom >= MIN_MAPBOX_GRID_ZOOM ? 2 : 6, async (key) => {
            if (signal?.aborted || bucketResults.has(key)) return;
            const c = nibioCoords.get(key)!;
            bucketResults.set(key, await getForestClass(c.lat, c.lon, gridStep, mapZoom));
        });

        for (const p of landPoints) {
            const nibio = nibioCacheSnap(p.lat, p.lon, gridStep);
            forestCache.set(coordKey(p.lat, p.lon), bucketResults.get(`${nibio.lat},${nibio.lon}`)!);
        }
    }

    // Not previously checked here (only before this point and after the
    // historical stage) — closes that gap now that a checkpoint sits right
    // after this next await, so a load aborted mid-weather-fetch can't reach it.
    if (signal?.aborted) {
        return emptyResult;
    }
    onProgress?.("weather");

    await mapPool([...yrKeys], mapZoom < 12 ? 3 : 6, async (key) => {
        if (signal?.aborted || forecastCache.has(key)) return;
        const c = yrCoords.get(key)!;
        try {
            forecastCache.set(key, await getYrForecast(c.lat, c.lon, mapZoom));
        } catch (err) {
            // Unlike every other source in this pipeline, getYrForecast
            // throws rather than resolving to null — left uncaught, one
            // failed bucket rejects this whole mapPool's Promise.all and
            // aborts the entire grid load instead of degrading one point.
            // getYrForecast already logs the failure to fetchLog itself.
            console.error("[loadGridData] Yr forecast failed, using fallback", err);
            forecastCache.set(key, FALLBACK_FORECAST);
        }
    });

    if (signal?.aborted) {
        return emptyResult;
    }

    // Checkpoint A: weather + forest + terrain are all in hand — enough to
    // produce a fully-scored (just less-refined) result well before the
    // historical stage below, which can take up to ~60s on the Frost
    // fallback path. mergeHistoricalConditions tolerates all-null
    // senorge/historical/metAnalysis by falling back to forecast-derived
    // values for everything except wind/snow (no forecast tier for those
    // two), so this isn't a placeholder — it's a real, if less-refined,
    // score. Not logged to fetchLog (only the final assembly is) so one
    // click doesn't show up as two "grid" events in the debug panel.
    if (onPartialResult) {
        const { displayPoints: earlyPoints } = buildDisplayResult(
            landPoints,
            {
                forecastCache,
                forestCache,
                historicalCache: new Map(),
                senorgeByCoord: new Map(),
                bulkMetAnalysis: null,
                terrainByKey,
                twiByKey,
            },
            { mapZoom, foragingTarget, yrStep, interpBounds },
        );
        onPartialResult({
            points: earlyPoints,
            terrainDebug: { samples: displayTerrain, targets: displayTargets },
            gridStep,
            protectedAreas,
        });
    }
    onProgress?.("historical");

    // Both slow historical sub-stages below (the Frost mapPool, and the
    // seNorge per-bucket fallback further down) fill a cache one station/
    // bucket at a time rather than all-at-once — so instead of only ever
    // showing checkpoint A and then the final result, periodically snapshot
    // whatever's landed so far and re-emit. Throttled to PROGRESS_TICK_MS
    // rather than firing per-completion: recomputing scores for the whole
    // grid on every single station would be wasteful when there are dozens.
    // No-op (returns an inert stop()) when the caller didn't ask for partial
    // results at all.
    function emitPeriodically(snapshotCaches: () => DisplayResultCaches): { stop: () => void } {
        if (!onPartialResult) return { stop: () => {} };
        const timer = setInterval(() => {
            if (signal?.aborted) return;
            const { displayPoints: tickPoints } = buildDisplayResult(
                landPoints,
                snapshotCaches(),
                { mapZoom, foragingTarget, yrStep, interpBounds },
            );
            onPartialResult!({
                points: tickPoints,
                terrainDebug: { samples: displayTerrain, targets: displayTargets },
                gridStep,
                protectedAreas,
            });
        }, PROGRESS_TICK_MS);
        return { stop: () => clearInterval(timer) };
    }

    // The two snapshot builders below mirror the *final* senorgeByCoord
    // assembly further down (bulk-with-wind-merge, and per-bucket-expanded)
    // but read whatever's in the caches right now rather than waiting for
    // them to fully settle — safe to call repeatedly since they're just
    // per-point Map lookups, no network involved.
    function senorgeByCoordFromBulk(
        bulk: Map<string, SenorgeObservation>,
        wind: Map<string, number | null>,
    ): Map<string, SenorgeObservation | null> {
        const m = new Map<string, SenorgeObservation | null>();
        for (const p of landPoints) {
            const base = bulk.get(coordKey(p.lat, p.lon)) ?? null;
            const w = wind.get(senorgeBucketKey(p.lat, p.lon));
            m.set(coordKey(p.lat, p.lon), base ? { ...base, windMeanMs: w ?? undefined } : null);
        }
        return m;
    }
    function senorgeByCoordFromBucketCache(cache: Map<string, SenorgeObservation | null>): Map<string, SenorgeObservation | null> {
        const m = new Map<string, SenorgeObservation | null>();
        for (const p of landPoints) {
            m.set(coordKey(p.lat, p.lon), cache.get(senorgeBucketKey(p.lat, p.lon)) ?? null);
        }
        return m;
    }

    // seNorge + met_analysis: try both bulk NetCDF/OPeNDAP paths first — a
    // fixed request count covering the *entire* radius with exact values,
    // instead of one round of point-queries per unique bucket. Each falls
    // back independently to its own per-bucket path when there's no radius
    // context or the bulk fetch fails outright.
    const shouldTryBulk = center !== undefined && radiusKm !== undefined;

    const [bulkSenorge, bulkMetAnalysis] = await Promise.all([
        shouldTryBulk ? getSenorgeConditionsForRadius(landPoints, center!, radiusKm!) : Promise.resolve(null),
        shouldTryBulk ? getMetAnalysisConditionsForRadius(landPoints, center!, radiusKm!) : Promise.resolve(null),
    ]);

    // Frost's only remaining load-bearing contribution (once seNorge covers
    // rain/temp/snow and met_analysis covers humidity/wind) is as a fallback
    // for either of those failing — so it's only worth its cost (48 requests
    // through a hard 1.1s-per-request upstream rate limit, ~60s) when at
    // least one of the two bulk sources actually failed. When both succeed,
    // skip it entirely: historicalCache stays empty, every point's
    // `historical` resolves to null, which every merge field already treats
    // as optional. (Side effect: the weather-station markers on the map,
    // sourced from Frost's per-point station data, won't appear on a
    // healthy/fast load — only on the fallback path below, same as before.)
    const skipFrost = bulkSenorge !== null && bulkMetAnalysis !== null;

    // met_analysis's bulk wind (when available) takes priority over the old
    // per-bucket seNorge wind endpoint (see historicalConditions.ts) — so
    // that per-bucket fetch is now itself only a fallback-of-a-fallback,
    // needed only when met_analysis didn't supply wind.
    const windKeys = new Set<string>();
    const windCoords = new Map<string, { lat: number; lon: number }>();
    if (shouldTryBulk && !bulkMetAnalysis) {
        for (const p of landPoints) {
            const key = senorgeBucketKey(p.lat, p.lon);
            windKeys.add(key);
            if (!windCoords.has(key)) windCoords.set(key, { lat: p.lat, lon: p.lon });
        }
    }
    const windCache = new Map<string, number | null>();

    // While Frost stations resolve one at a time below (the ~60s worst
    // case), senorgeByCoord itself doesn't exist yet as a variable — but
    // bulkSenorge (if the bulk fetch succeeded) already fully has, so ticks
    // during this stage can show real refined rain/temp data immediately,
    // refining further only as historicalCache/windCache themselves fill in.
    const frostTicker = emitPeriodically(() => ({
        forecastCache,
        forestCache,
        historicalCache,
        senorgeByCoord: bulkSenorge ? senorgeByCoordFromBulk(bulkSenorge, windCache) : new Map(),
        bulkMetAnalysis,
        terrainByKey,
        twiByKey,
    }));
    try {
        await Promise.all([
            !skipFrost
                ? mapPool([...frostKeys], 3, async (key) => {
                      if (signal?.aborted || historicalCache.has(key)) return;
                      const c = frostCoords.get(key)!;
                      historicalCache.set(key, await getFrostConditions(c.lat, c.lon));
                  })
                : Promise.resolve(),
            windKeys.size > 0
                ? mapPool([...windKeys], 4, async (key) => {
                      if (signal?.aborted || windCache.has(key)) return;
                      const c = windCoords.get(key)!;
                      windCache.set(key, await getSenorgeGridValue(c.lat, c.lon, "windSpeed10m24h06"));
                  })
                : Promise.resolve(),
        ]);
    } finally {
        frostTicker.stop();
    }

    const senorgeByCoord = new Map<string, SenorgeObservation | null>();

    if (bulkSenorge) {
        for (const p of landPoints) {
            const base = bulkSenorge.get(coordKey(p.lat, p.lon)) ?? null;
            const wind = windCache.get(senorgeBucketKey(p.lat, p.lon));
            senorgeByCoord.set(coordKey(p.lat, p.lon), base ? { ...base, windMeanMs: wind ?? undefined } : null);
        }
    } else {
        // Fallback: today's full per-bucket point-query path (also covers wind).
        const senorgeKeys = new Set<string>();
        const senorgeCoords = new Map<string, { lat: number; lon: number }>();
        for (const p of landPoints) {
            const key = senorgeBucketKey(p.lat, p.lon);
            senorgeKeys.add(key);
            if (!senorgeCoords.has(key)) senorgeCoords.set(key, { lat: p.lat, lon: p.lon });
        }

        const senorgeCache = new Map<string, SenorgeObservation | null>();
        // historicalCache is already fully settled by this point (this
        // fallback only runs after the Frost stage above completes), so
        // ticks here only need to reflect senorgeCache filling in.
        const senorgeTicker = emitPeriodically(() => ({
            forecastCache,
            forestCache,
            historicalCache,
            senorgeByCoord: senorgeByCoordFromBucketCache(senorgeCache),
            bulkMetAnalysis,
            terrainByKey,
            twiByKey,
        }));
        try {
            // Lower concurrency than the others — each call already fans out to a
            // few parallel requests internally (rain series/temp series/snow/wind),
            // and this is an undocumented API with no stated rate limits, worth
            // staying polite. Still bumped from 2: cutting getSenorgeConditions's
            // own fan-out from 7 to 4 sub-requests (deriving 3d/7d rain from the
            // 14d series instead of separate calls) freed up headroom to raise this
            // without exceeding the old in-flight-request ceiling.
            await mapPool([...senorgeKeys], 4, async (key) => {
                if (signal?.aborted || senorgeCache.has(key)) return;
                const c = senorgeCoords.get(key)!;
                senorgeCache.set(key, await getSenorgeConditions(c.lat, c.lon));
            });
        } finally {
            senorgeTicker.stop();
        }

        for (const p of landPoints) {
            senorgeByCoord.set(coordKey(p.lat, p.lon), senorgeCache.get(senorgeBucketKey(p.lat, p.lon)) ?? null);
        }
    }

    if (signal?.aborted) {
        return emptyResult;
    }

    const { displayPoints, terrainMatched } = buildDisplayResult(
        landPoints,
        { forecastCache, forestCache, historicalCache, senorgeByCoord, bulkMetAnalysis, terrainByKey, twiByKey },
        { mapZoom, foragingTarget, yrStep, interpBounds },
    );

    fetchLog.record({
        type: "grid",
        points: displayPoints.length,
        land: landPoints.length,
        water: rawGrid.length - landPoints.length,
        ms: Math.round(performance.now() - start),
        terrainMatched,
        mapZoom,
    });

    return {
        points: displayPoints,
        terrainDebug: { samples: displayTerrain, targets: displayTargets },
        gridStep,
        protectedAreas,
    };
}

export function leafletBounds(map: LeafletMap): MapBounds {
    const b = map.getBounds();
    return {
        getNorth: () => b.getNorth(),
        getSouth: () => b.getSouth(),
        getEast: () => b.getEast(),
        getWest: () => b.getWest(),
    };
}
