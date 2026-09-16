import type { YrForecast } from "../../api/yrApi";
import type { AR5Class } from "../../api/nibioApi";
import { weatherScore } from "./weatherScore";
import { rainfallScore } from "./rainfallScore";
import { forestScore } from "./forestScore";
import { terrainScore } from "./terrainScore";
import type { ForagingTarget } from "./foragingTargets";
import type { HistoricalConditions } from "./historicalConditions";
import { MIN_TERRAIN_GRID_ZOOM } from "../terrain/types";

export type ScoreBreakdown = {
    weather: number;
    rainfall: number;
    forest: number;
    terrain: number | null;
    /** Whether this zoom level fetches terrain data at all — lets a null
     *  `terrain` above be told apart from "unsupported at this zoom" (false)
     *  vs "terrain fetch failed for this specific point" (true, terrain
     *  still null). Both currently get the same flat fallback weighting
     *  (terrain data that isn't there can't be weighted in either way), but
     *  display code needs the distinction to avoid claiming terrain "isn't
     *  used at this zoom level" when it actually just failed to fetch. */
    terrainSupportedAtZoom: boolean;
    composite: number;
    weights: { weather: number; rainfall: number; forest: number; terrain: number };
    inputs: {
        forecast: YrForecast;
        conditions: HistoricalConditions;
        forestClass: AR5Class;
        slope?: number;
        aspect?: number;
        twi?: number;
        foragingTarget: ForagingTarget;
    };
};

const BASE_WEATHER = 0.35;
const BASE_RAIN = 0.35;
const BASE_FOREST = 0.3;

function terrainWeight(zoom: number): number {
    // Terrain data isn't fetched below MIN_TERRAIN_GRID_ZOOM, so the ramp
    // must not start until then or this weight gets silently discarded.
    if (zoom < MIN_TERRAIN_GRID_ZOOM) return 0;
    if (zoom >= 17) return 0.35;
    if (zoom >= 16) return 0.3;
    if (zoom >= 15) return 0.25;
    if (zoom >= 13) return 0.2;
    return 0.15; // zoom 11-12
}

/**
 * The actual weight each sub-score carries at a given zoom, independent of
 * any specific point — terrain's weight ramps from 0 (below
 * MIN_TERRAIN_GRID_ZOOM) up to 0.35 as zoom increases (see terrainWeight
 * above), proportionally shrinking the other three rather than being added
 * on top. Exported so the sidebar can show these live percentages instead of
 * listing weather/rainfall/forest/terrain as if they always counted equally
 * (they don't, and terrain sometimes counts for nothing at all). Assumes
 * terrain data is actually available at this zoom — a specific point whose
 * terrain fetch failed still falls back to the tw===0 weighting inside
 * compositeScore below, which this can't know about without a real point.
 */
export function weightsForZoom(zoom: number): { weather: number; rainfall: number; forest: number; terrain: number } {
    const tw = terrainWeight(zoom);
    if (tw === 0) return { weather: BASE_WEATHER, rainfall: BASE_RAIN, forest: BASE_FOREST, terrain: 0 };
    const remaining = 1 - tw;
    return {
        weather: BASE_WEATHER * remaining,
        rainfall: BASE_RAIN * remaining,
        forest: BASE_FOREST * remaining,
        terrain: tw,
    };
}

export function compositeScore(params: {
    zoom: number;
    forecast: YrForecast;
    conditions: HistoricalConditions;
    forestClass: AR5Class;
    slope?: number;
    aspect?: number;
    twi?: number;
    foragingTarget?: ForagingTarget;
}): ScoreBreakdown {
    const { zoom, forecast, conditions, forestClass, slope, aspect, twi, foragingTarget = "general" } = params;
    const tw = terrainWeight(zoom);

    const w = weatherScore(conditions, foragingTarget);
    const r = rainfallScore(conditions, foragingTarget, slope, aspect, twi);
    const f = forestScore(forestClass, foragingTarget);
    const t =
        slope !== undefined && aspect !== undefined
            ? terrainScore(slope, aspect)
            : null;

    let composite: number;
    // A specific point's terrain fetch can fail even when this zoom
    // otherwise supports it (t === null) — falls back to the flat
    // zoom-only weighting in that case too, same as weightsForZoom(zoom)
    // would give for a zoom below MIN_TERRAIN_GRID_ZOOM.
    const weights = tw === 0 || t === null
        ? { weather: BASE_WEATHER, rainfall: BASE_RAIN, forest: BASE_FOREST, terrain: 0 }
        : weightsForZoom(zoom);

    if (tw === 0 || t === null) {
        composite = w * weights.weather + r * weights.rainfall + f * weights.forest;
    } else {
        composite =
            w * weights.weather +
            r * weights.rainfall +
            f * weights.forest +
            t * weights.terrain;
    }

    return {
        weather: w,
        rainfall: r,
        forest: f,
        terrain: t,
        terrainSupportedAtZoom: tw > 0,
        composite,
        weights,
        inputs: { forecast, conditions, forestClass, slope, aspect, twi, foragingTarget },
    };
}
