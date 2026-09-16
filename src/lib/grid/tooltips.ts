import { SOURCE_LABELS, type DataSourceId } from "../layers/types";
import type { GridPoint } from "./types";
import type { FieldProvenance, HistoricalConditions } from "../scoring/historicalConditions";
import { FORAGING_TARGET_LABELS, type ForagingTarget } from "../scoring/foragingTargets";
import { WEATHER_PROFILES, triangularScore } from "../scoring/weatherProfiles";
import { effectiveSolarRadiation, slopeScore, aspectScore } from "../scoring/terrainScore";

const SCORE_HINT = "0–1, higher is better";

/** Plain-English wording for where a value actually came from — surfaced so
 *  blending three possible sources across the map is never silent about
 *  which one a given point actually used. */
const PROVENANCE_LABEL: Record<FieldProvenance, string> = {
    gridded: "regional dataset",
    observed: "nearby weather station",
    forecast: "forecast estimate",
};

/** "forecast" is the only tier with no real observation behind it at all
 *  (gridded/observed both come from actual measurements) — flagged visually,
 *  not just via word choice, so a degraded field is obvious at a glance
 *  rather than something you only notice by reading closely. */
function styleProvenance(provenance: FieldProvenance): string {
    const label = PROVENANCE_LABEL[provenance];
    return provenance === "forecast"
        ? `<span style="color:#dc2626;font-weight:600">${label} — not a real observation</span>`
        : label;
}

function provenanceLabel(conditions: HistoricalConditions, field: "precipitation" | "temp" | "humidity"): string {
    return styleProvenance(conditions[`${field}Provenance`]);
}

/** conditions.tempMeanRecentC is a 7-day recent mean, not the current
 *  reading — mergeHistoricalConditions always fills it (gridded/observed/
 *  forecast tiers), so the `currentTemp` fallback here is only a type-level
 *  safety net, not a path real data takes. Labeled either way so a "14°C"
 *  in a tooltip is never mistaken for "right now". */
function tempLabel(conditions: HistoricalConditions, currentTemp: number): string {
    return conditions.tempMeanRecentC !== undefined
        ? `${conditions.tempMeanRecentC.toFixed(1)}°C 7-day mean`
        : `${currentTemp.toFixed(1)}°C current`;
}

/** rainfallScore no longer scores off just the single most recent rain day
 *  (see rainEventsDaysAgo in historicalConditions.ts / senorgeApi.ts) — it
 *  picks whichever rain day in the window is closest to this target's peak
 *  fruiting window. Surfaces that same reasoning here so the tooltip never
 *  shows a "days since rain" number that doesn't match what actually drove
 *  the score, e.g. a spot that rained today *and* 10 days ago should read
 *  "10d" (the day driving the score), not "0d" (merely the most recent). */
function rainRecencyLabel(conditions: HistoricalConditions, target: ForagingTarget): string | null {
    const events = conditions.rainEventsDaysAgo;
    if (events && events.length > 0) {
        const profile = WEATHER_PROFILES[target];
        const fit = (d: number) => triangularScore(d, profile.idealDaysSinceRain, profile.daysSinceRainSpread);
        const best = events.reduce((a, b) => (fit(b) > fit(a) ? b : a));
        if (events.length === 1) return `${best}d since last rain`;
        return `${best}d since best-matching rain (${events.length} rain days in the last 14: ${events.join("d, ")}d ago)`;
    }
    if (conditions.daysSinceRain !== undefined) return `${conditions.daysSinceRain} days since last rain`;
    return null;
}

export function gridTooltip(point: GridPoint, source: DataSourceId): string {
    // twi lives directly on GridPoint (a terrain quantity, like elevation/
    // slope/aspect), not inside weather-sourced `conditions` — handled
    // before the conditions-gated block below since it has no dependency on
    // weather data being present.
    if (source === "twi") {
        return point.twi !== undefined
            ? `<strong>Topographic wetness index:</strong> ${point.twi.toFixed(1)}<br>Higher = flatter terrain where water collects and lingers`
            : `${SOURCE_LABELS.twi}: no data`;
    }

    // Value-mode layers (raw physical readings, not suitability scores)
    // aren't part of SourceScores at all — handle them before the
    // score-mode lookup below.
    if (
        source === "temperature" ||
        source === "wind" ||
        source === "humidity" ||
        source === "snow" ||
        source === "vpd" ||
        source === "solarRadiationAdjusted" ||
        source === "precipitationRecent"
    ) {
        const conditions = point.debug?.inputs.conditions;
        if (!conditions) return `${SOURCE_LABELS[source]}: no data`;
        switch (source) {
            case "temperature":
                return conditions.tempMeanRecentC !== undefined
                    ? `<strong>Temperature:</strong> ${conditions.tempMeanRecentC.toFixed(1)}°C 7-day mean<br>Source: ${styleProvenance(conditions.tempProvenance)}`
                    : `${SOURCE_LABELS.temperature}: no data`;
            case "wind":
                // windProvenance is always set alongside windMeanMs (see
                // mergeHistoricalConditions) — it's only optional in the type
                // to allow "genuinely no data" when neither is present.
                return conditions.windMeanMs !== undefined && conditions.windProvenance !== undefined
                    ? `<strong>Wind speed:</strong> ${conditions.windMeanMs.toFixed(1)} m/s<br>Source: ${styleProvenance(conditions.windProvenance)}`
                    : `${SOURCE_LABELS.wind}: no data`;
            case "humidity":
                return conditions.humidityMeanPct !== undefined
                    ? `<strong>Humidity:</strong> ${conditions.humidityMeanPct.toFixed(0)}%<br>Source: ${styleProvenance(conditions.humidityProvenance)}`
                    : `${SOURCE_LABELS.humidity}: no data`;
            case "snow":
                return conditions.snowDepthCm !== undefined
                    ? `<strong>Snow depth:</strong> ${conditions.snowDepthCm.toFixed(0)} cm`
                    : `${SOURCE_LABELS.snow}: no data`;
            case "vpd":
                return conditions.vpdKpa !== undefined
                    ? `<strong>Vapor pressure deficit:</strong> ${conditions.vpdKpa.toFixed(2)} kPa<br>Lower = more humid air, generally better for fungal growth`
                    : `${SOURCE_LABELS.vpd}: no data`;
            case "solarRadiationAdjusted": {
                if (conditions.solarRadiationWm2 === undefined) return `${SOURCE_LABELS.solarRadiationAdjusted}: no data`;
                const { slope, aspect } = point.debug?.inputs ?? {};
                const adjusted = effectiveSolarRadiation(conditions.solarRadiationWm2, slope, aspect);
                return `<strong>Solar radiation, adjusted for slope/aspect:</strong> ${adjusted.toFixed(0)} W/m²<br>Raw (flat-ground) reading: ${conditions.solarRadiationWm2.toFixed(0)} W/m²`;
            }
            case "precipitationRecent": {
                if (conditions.precipitationRecentMm === undefined) return `${SOURCE_LABELS.precipitationRecent}: no data`;
                const target = point.debug?.inputs.foragingTarget ?? "general";
                const recencyLabel = rainRecencyLabel(conditions, target);
                const recency = recencyLabel ? `<br>${recencyLabel}` : "";
                return `<strong>Rainfall amount:</strong> ${conditions.precipitationRecentMm.toFixed(1)} mm recent<br>Source: ${styleProvenance(conditions.precipitationProvenance)}${recency}`;
            }
        }
    }

    const score = point.scores[source];
    if (score === null) return `${SOURCE_LABELS[source]}: no data at this zoom level`;

    switch (source) {
        case "weather": {
            const conditions = point.debug?.inputs.conditions;
            const f = point.forecast;
            if (!f || !conditions) return `<strong>Weather score:</strong> ${score.toFixed(2)} (${SCORE_HINT})`;
            return `<strong>Weather score:</strong> ${score.toFixed(2)} (${SCORE_HINT})<br>${tempLabel(conditions, f.temperature)} · ${(conditions.humidityMeanPct ?? f.humidity).toFixed(0)}% humidity<br>Temperature source: ${provenanceLabel(conditions, "temp")}`;
        }
        case "rainfall": {
            const conditions = point.debug?.inputs.conditions;
            const f = point.forecast;
            if (!f || !conditions) return `<strong>Rainfall score:</strong> ${score.toFixed(2)} (${SCORE_HINT})`;
            const mm = conditions.precipitationRecentMm ?? f.precipitation72hForecast;
            const target = point.debug?.inputs.foragingTarget ?? "general";
            const recencyLabel = rainRecencyLabel(conditions, target);
            const recency = recencyLabel ? `<br>${recencyLabel}` : "";
            return `<strong>Rainfall score:</strong> ${score.toFixed(2)} (${SCORE_HINT})<br>${mm.toFixed(1)} mm recent precipitation (${provenanceLabel(conditions, "precipitation")})${recency}`;
        }
        case "forest": {
            const cls = point.debug?.inputs.forestClass;
            return cls
                ? `<strong>Forest score:</strong> ${score.toFixed(2)} (${SCORE_HINT})<br>Forest type: ${cls}`
                : `<strong>Forest score:</strong> ${score.toFixed(2)} (${SCORE_HINT})`;
        }
        case "terrain":
            if (point.elevation !== undefined && point.slope !== undefined) {
                return `<strong>Terrain score:</strong> ${score.toFixed(2)} (${SCORE_HINT})<br>Elevation ${point.elevation.toFixed(0)} m · slope ${point.slope.toFixed(3)}`;
            }
            return `<strong>Terrain score:</strong> ${score.toFixed(2)} (${SCORE_HINT})`;
        case "composite": {
            const debug = point.debug;
            if (!debug) return `<strong>Composite suitability score:</strong> ${score.toFixed(2)} (${SCORE_HINT})`;
            const w = debug.weights;
            const { forecast, conditions, forestClass, slope, aspect, foragingTarget } = debug.inputs;
            const mm = conditions.precipitationRecentMm ?? forecast.precipitation72hForecast;
            const recencyLabel = rainRecencyLabel(conditions, foragingTarget);
            const recency = recencyLabel ? ` · ${recencyLabel}` : "";

            // Surfaces the inputs to sub-formulas added after the original
            // tooltip was written (frost penalty, wind/VPD/solar drying) so
            // a viewer can see *why* a score is what it is, not just the
            // number — e.g. a rainy point that still scores low because of
            // high wind/VPD/solar would otherwise look unexplained.
            const frostNote =
                conditions.tempMinRecentC !== undefined
                    ? ` · overnight low ${conditions.tempMinRecentC.toFixed(1)}°C${conditions.tempMinRecentC < 0 ? " (frost penalty applied)" : ""}`
                    : "";

            const dryingParts: string[] = [];
            if (conditions.windMeanMs !== undefined) dryingParts.push(`wind ${conditions.windMeanMs.toFixed(1)} m/s`);
            if (conditions.vpdKpa !== undefined) {
                // VPD is derived from temp+humidity, which can resolve from
                // different provenance tiers (e.g. a real 7d gridded temp
                // mean paired with a forecast-only humidity reading) — shown
                // here since that mismatch changes what the number means,
                // same reasoning as showing provenance on temp/rain above.
                dryingParts.push(
                    `vapor pressure deficit ${conditions.vpdKpa.toFixed(2)} kPa (temp: ${styleProvenance(conditions.tempProvenance)}, humidity: ${styleProvenance(conditions.humidityProvenance)})`,
                );
            }
            if (conditions.solarRadiationWm2 !== undefined) {
                const adjusted = effectiveSolarRadiation(conditions.solarRadiationWm2, slope, aspect);
                dryingParts.push(`sun exposure ${adjusted.toFixed(0)} W/m²`);
            }
            if (conditions.maxDrySpellDays !== undefined) {
                dryingParts.push(`${conditions.maxDrySpellDays}-day dry spell in the past 2 weeks`);
            }
            // twi isn't another drying cause, it's resistance to the ones
            // above — surfaced here anyway so a point that dries less than
            // its wind/VPD/solar numbers alone would suggest isn't a
            // mystery (see rainfallScore.ts's twiDryingRelief).
            if (point.twi !== undefined) dryingParts.push(`wetness index ${point.twi.toFixed(1)} (offsets some drying)`);
            const dryingLine = dryingParts.length
                ? `<strong>Drying factors (already applied to Rainfall above, not a separate score):</strong> ${dryingParts.join(", ")}`
                : null;

            const weatherContribution = debug.weather * w.weather;
            const rainfallContribution = debug.rainfall * w.rainfall;
            const forestContribution = debug.forest * w.forest;
            const terrainContribution = debug.terrain !== null ? debug.terrain * w.terrain : 0;

            const terrainLine =
                debug.terrain !== null && slope !== undefined && aspect !== undefined
                    ? `<strong>Terrain</strong> ${debug.terrain.toFixed(2)} (weight ${(w.terrain * 100).toFixed(0)}%) → contributes ${terrainContribution.toFixed(2)} · slope ${slope.toFixed(3)} (${slopeScore(slope).toFixed(2)}) · aspect ${aspect.toFixed(0)}° (${aspectScore(aspect).toFixed(2)})`
                    : debug.terrainSupportedAtZoom
                      ? "<strong>Terrain:</strong> data unavailable for this point (fetch failed or was skipped)"
                      : "<strong>Terrain:</strong> not used at this zoom level";

            return [
                `<strong>Composite suitability score: ${score.toFixed(2)}</strong> (${SCORE_HINT}) · target: ${FORAGING_TARGET_LABELS[foragingTarget] ?? foragingTarget}`,
                `<strong>Weather</strong> ${debug.weather.toFixed(2)} (weight ${(w.weather * 100).toFixed(0)}%) → contributes ${weatherContribution.toFixed(2)} · ${tempLabel(conditions, forecast.temperature)} (${provenanceLabel(conditions, "temp")}) · ${(conditions.humidityMeanPct ?? forecast.humidity).toFixed(0)}% humidity (${provenanceLabel(conditions, "humidity")})${frostNote}`,
                `<strong>Rainfall</strong> ${debug.rainfall.toFixed(2)} (weight ${(w.rainfall * 100).toFixed(0)}%) → contributes ${rainfallContribution.toFixed(2)} · ${mm.toFixed(1)}mm recent${recency} · ${provenanceLabel(conditions, "precipitation")}`,
                dryingLine,
                `<strong>Forest</strong> ${debug.forest.toFixed(2)} (weight ${(w.forest * 100).toFixed(0)}%) → contributes ${forestContribution.toFixed(2)} · type: ${forestClass}`,
                terrainLine,
                `<strong>Total:</strong> ${weatherContribution.toFixed(2)} + ${rainfallContribution.toFixed(2)} + ${forestContribution.toFixed(2)}${debug.terrain !== null ? ` + ${terrainContribution.toFixed(2)}` : ""} = ${score.toFixed(2)}`,
            ]
                .filter((line): line is string => line !== null)
                .join("<br>");
        }
        default:
            return `${SOURCE_LABELS[source]}: ${score.toFixed(2)} (${SCORE_HINT})`;
    }
}
