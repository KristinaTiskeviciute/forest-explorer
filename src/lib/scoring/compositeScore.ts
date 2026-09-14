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

    const baseWeather = 0.35;
    const baseRain = 0.35;
    const baseForest = 0.3;

    let composite: number;
    let weights = { weather: baseWeather, rainfall: baseRain, forest: baseForest, terrain: 0 };

    if (tw === 0 || t === null) {
        composite = w * baseWeather + r * baseRain + f * baseForest;
    } else {
        const remaining = 1 - tw;
        weights = {
            weather: baseWeather * remaining,
            rainfall: baseRain * remaining,
            forest: baseForest * remaining,
            terrain: tw,
        };
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
