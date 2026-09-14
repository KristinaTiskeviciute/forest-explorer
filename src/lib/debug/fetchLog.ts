export type FetchEvent =
    | { type: "tile"; z: number; x: number; y: number; hit: boolean; skipped?: boolean; reason?: string }
    | { type: "yr" | "nibio"; lat: number; lon: number; hit: boolean; ms: number; error?: string }
    | {
          type: "frost";
          lat: number;
          lon: number;
          hit: boolean;
          ms: number;
          error?: string;
          stationId?: string;
          distanceKm?: number;
          /** Resolved to null (disabled, no nearby station, or a gap in data) — using forecast fallback instead */
          fallback?: boolean;
      }
    | {
          type: "senorge";
          lat: number;
          lon: number;
          hit: boolean;
          ms: number;
          error?: string;
          /** Resolved to null (unreachable, or no data at this point/field) — falling back to Frost/Yr instead */
          fallback?: boolean;
      }
    | {
          /** met.no's met_analysis OPeNDAP source (humidity/wind/solar/cloud) —
           *  previously logged under "senorge" with a placeholder lat=0,lon=0,
           *  indistinguishable from real senorge activity in the debug panel.
           *  Split out so a met_analysis-specific outage (e.g. the thredds.met.no
           *  CORS issue) is visible on its own, not hidden inside senorge's stats. */
          type: "metAnalysis";
          lat: number;
          lon: number;
          hit: boolean;
          ms: number;
          error?: string;
          /** solarRadiationWm2/cloudCoverPct have no fallback tier at all — a
           *  fallback here means those two fields go missing entirely, not just
           *  degrade to a lower tier. */
          fallback?: boolean;
      }
    | {
          /** Miljødirektoratet's national protected-areas register — one
           *  bulk query per grid load (not per point), used to exclude
           *  national parks/nature reserves/landscape protection areas etc.
           *  from foraging suggestions entirely. See protectedAreasApi.ts. */
          type: "naturvern";
          lat: number;
          lon: number;
          hit: boolean;
          ms: number;
          error?: string;
          areasFound?: number;
      }
    | { type: "grid"; points: number; land: number; water: number; ms: number; terrainMatched?: number; mapZoom?: number; error?: string };

export type SessionStats = {
    mapboxTilesFetched: number;
    mapboxTilesSkipped: number;
    mapboxTileBudget: number;
    yrRequests: number;
    yrCacheHits: number;
    nibioRequests: number;
    nibioCacheHits: number;
    frostRequests: number;
    frostCacheHits: number;
    frostFallbacks: number;
    senorgeRequests: number;
    senorgeFallbacks: number;
    metAnalysisRequests: number;
    metAnalysisFallbacks: number;
};

const MAX_EVENTS = 100;

/** A stable id per event, distinct from array position — this list is
 *  rebuilt newest-first on every record(), so an index would identify
 *  "the Nth-from-the-top slot" rather than a specific event, the classic
 *  index-as-key trap for a reordering list. */
export type StampedFetchEvent = FetchEvent & { id: number };

let nextEventId = 0;
let events: StampedFetchEvent[] = [];
const listeners = new Set<() => void>();

let stats: SessionStats = {
    mapboxTilesFetched: 0,
    mapboxTilesSkipped: 0,
    // Raised alongside maxTerrainSamplePointsForZoom (terrain/types.ts) — at
    // its zoom-17 cap (200), a single load can need close to 100 tiles on its
    // own, so 500 gives headroom for a few dense loads per 10-min reset window.
    mapboxTileBudget: 500,
    yrRequests: 0,
    yrCacheHits: 0,
    nibioRequests: 0,
    nibioCacheHits: 0,
    frostRequests: 0,
    frostCacheHits: 0,
    frostFallbacks: 0,
    senorgeRequests: 0,
    senorgeFallbacks: 0,
    metAnalysisRequests: 0,
    metAnalysisFallbacks: 0,
};

let dryRun = false;

// Auto-reset so a long session can't permanently strand terrain data behind
// an exhausted budget — checked lazily (not a timer) so it's unaffected by
// throttled background tabs.
const BUDGET_RESET_INTERVAL_MS = 10 * 60 * 1000;
let budgetWindowStart = Date.now();

function maybeResetBudgetWindow() {
    const now = Date.now();
    if (now - budgetWindowStart >= BUDGET_RESET_INTERVAL_MS) {
        stats = { ...stats, mapboxTilesFetched: 0, mapboxTilesSkipped: 0 };
        budgetWindowStart = now;
        notify();
    }
}

function notify() {
    listeners.forEach((l) => l());
}

export const fetchLog = {
    record(event: FetchEvent) {
        events = [{ ...event, id: nextEventId++ }, ...events].slice(0, MAX_EVENTS);
        if (event.type === "tile") {
            if (event.skipped) stats.mapboxTilesSkipped++;
            else if (!event.hit) stats.mapboxTilesFetched++;
        } else if (event.type === "yr") {
            if (event.hit) stats.yrCacheHits++;
            else stats.yrRequests++;
        } else if (event.type === "nibio") {
            if (event.hit) stats.nibioCacheHits++;
            else stats.nibioRequests++;
        } else if (event.type === "frost") {
            if (event.fallback) stats.frostFallbacks++;
            else if (event.hit) stats.frostCacheHits++;
            else stats.frostRequests++;
        } else if (event.type === "senorge") {
            if (event.fallback) stats.senorgeFallbacks++;
            else stats.senorgeRequests++;
        } else if (event.type === "metAnalysis") {
            if (event.fallback) stats.metAnalysisFallbacks++;
            else stats.metAnalysisRequests++;
        }
        notify();
    },

    getEvents: () => events,
    getStats: () => stats,

    setTileBudget(budget: number) {
        stats = { ...stats, mapboxTileBudget: budget };
        notify();
    },

    canFetchTile(): boolean {
        if (dryRun) return false;
        maybeResetBudgetWindow();
        return stats.mapboxTilesFetched < stats.mapboxTileBudget;
    },

    isDryRun: () => dryRun,

    setDryRun(value: boolean) {
        dryRun = value;
        notify();
    },

    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    reset() {
        events = [];
        stats = {
            mapboxTilesFetched: 0,
            mapboxTilesSkipped: 0,
            mapboxTileBudget: stats.mapboxTileBudget,
            yrRequests: 0,
            yrCacheHits: 0,
            nibioRequests: 0,
            nibioCacheHits: 0,
            frostRequests: 0,
            frostCacheHits: 0,
            frostFallbacks: 0,
            senorgeRequests: 0,
            senorgeFallbacks: 0,
            metAnalysisRequests: 0,
            metAnalysisFallbacks: 0,
        };
        notify();
    },

    resetMapboxBudget() {
        stats = {
            ...stats,
            mapboxTilesFetched: 0,
            mapboxTilesSkipped: 0,
        };
        budgetWindowStart = Date.now();
        notify();
    },
};
