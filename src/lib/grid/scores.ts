import type { DataSourceId } from "../layers/types";
import type { GridPoint } from "./types";
import type { SourceScores } from "./types";
import { effectiveSolarRadiation } from "../scoring/terrainScore";

export function scoreForSource(point: GridPoint, source: DataSourceId): number | null {
    if (!(source in point.scores)) return null;
    return point.scores[source as keyof SourceScores];
}

/** Raw/derived values for the "value"-mode layers — mirrors
 *  scoreForSource's shape/nullability so callers can treat both uniformly,
 *  but reads straight from the merged conditions (and, for the adjusted
 *  radiation, the same slope/aspect terrainScore.ts already used to
 *  compute it) rather than SourceScores, since these aren't foraging-
 *  suitability sub-scores. */
export function valueForSource(point: GridPoint, source: DataSourceId): number | null {
    // twi lives directly on GridPoint (a terrain quantity, like
    // elevation/slope/aspect), not inside the weather-sourced `conditions` —
    // handled before the conditions-gated switch below since it has no
    // dependency on weather data being present.
    if (source === "twi") return point.twi ?? null;

    const conditions = point.debug?.inputs.conditions;
    if (!conditions) return null;
    switch (source) {
        case "temperature":
            return conditions.tempMeanRecentC ?? null;
        case "wind":
            return conditions.windMeanMs ?? null;
        case "humidity":
            return conditions.humidityMeanPct ?? null;
        case "snow":
            return conditions.snowDepthCm ?? null;
        case "precipitationRecent":
            return conditions.precipitationRecentMm ?? null;
        case "vpd":
            return conditions.vpdKpa ?? null;
        case "solarRadiationAdjusted": {
            if (conditions.solarRadiationWm2 === undefined) return null;
            const { slope, aspect } = point.debug?.inputs ?? {};
            return effectiveSolarRadiation(conditions.solarRadiationWm2, slope, aspect);
        }
        default:
            return null;
    }
}

export function pointsWithScore(points: GridPoint[], source: DataSourceId): GridPoint[] {
    return points.filter((p) => scoreForSource(p, source) !== null);
}
