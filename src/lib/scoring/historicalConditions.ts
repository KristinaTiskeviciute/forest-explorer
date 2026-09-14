import type { YrForecast } from "../../api/yrApi";
import type { FrostObservation } from "../../api/frostApi";
import type { SenorgeObservation } from "../../api/senorgeApi";
import type { MetAnalysisObservation } from "../../api/metAnalysisApi";
import { calculateVpd } from "./vpd";

export type FieldProvenance = "gridded" | "observed" | "forecast";

/**
 * One merged view of weather history, resolved in priority order per field:
 * gridded (seNorge and/or met_analysis — real values, no station-distance
 * approximation) → Frost (real station observation) → Yr (forecast, always
 * available as the last resort). Humidity and wind can each come from
 * met_analysis; rain/temp/snow come from seNorge; both are "gridded" tier.
 */
export type HistoricalConditions = {
    precipitationRecentMm?: number;
    precipitationProvenance: FieldProvenance;
    daysSinceRain?: number;
    /** Optional, unlike the other provenance fields — there's no forecast
     *  tier for this field (forward-looking data can't say what already
     *  happened), so when neither seNorge nor Frost has it, both this and
     *  daysSinceRain itself are genuinely absent rather than "forecast". */
    daysSinceRainProvenance?: FieldProvenance;
    /** Every qualifying rain day in the 14-day window (days-ago,
     *  most-recent-first), when the underlying source tracked the full
     *  series — same gridded → observed priority as daysSinceRain, no
     *  forecast tier (forward-looking data can't say what already
     *  happened). See rainfallScore.ts for why daysSinceRain alone (just
     *  the most recent event) understates a spot that also rained further
     *  back and may already be mid-flush. */
    rainEventsDaysAgo?: number[];
    /** Longest consecutive dry stretch in the 14-day window — distinct from
     *  daysSinceRain, which only says when the *most recent* rain was, not
     *  how severe the drought leading up to it was. Feeds rainfallScore's
     *  drying modifier as a recovery-lag penalty. */
    maxDrySpellDays?: number;
    tempMeanRecentC?: number;
    tempProvenance: FieldProvenance;
    tempMinRecentC?: number;
    windMeanMs?: number;
    /** Optional, unlike the other provenance fields — there's no forecast
     *  tier for wind, so when neither met_analysis nor seNorge has it, both
     *  this and windMeanMs itself are genuinely absent rather than "forecast". */
    windProvenance?: FieldProvenance;
    humidityMeanPct?: number;
    humidityProvenance: FieldProvenance;
    vpdKpa?: number;
    snowDepthCm?: number;
    /** met_analysis only, no fallback tier. solarRadiationWm2 feeds
     *  rainfallScore's drying penalty (via effectiveSolarRadiation);
     *  cloudCoverPct is display-only — redundant with solar radiation as a
     *  drying signal, so deliberately not wired into any score. */
    solarRadiationWm2?: number;
    cloudCoverPct?: number;
};

export function mergeHistoricalConditions(
    senorge: SenorgeObservation | null,
    frost: FrostObservation | null,
    forecast: YrForecast,
    metAnalysis: MetAnalysisObservation | null = null,
): HistoricalConditions {
    let precipitationRecentMm: number | undefined;
    // No initializer: every branch below (including the final else) assigns
    // this before it's read — a placeholder default here would be dead code.
    let precipitationProvenance: FieldProvenance;
    if (senorge?.precipitation7dMm !== undefined) {
        precipitationRecentMm = senorge.precipitation7dMm;
        precipitationProvenance = "gridded";
    } else if (frost?.precipitation7dObserved !== undefined) {
        precipitationRecentMm = frost.precipitation7dObserved;
        precipitationProvenance = "observed";
    } else {
        precipitationRecentMm = frost?.precipitation72hObserved ?? forecast.precipitation72hForecast;
        precipitationProvenance = frost?.precipitation72hObserved !== undefined ? "observed" : "forecast";
    }

    let daysSinceRain: number | undefined;
    // No initializer: left undefined (not "forecast") when neither branch
    // below fires — there's no forecast tier for this field, so a missing
    // value is genuinely missing, not degraded-but-present.
    let daysSinceRainProvenance: FieldProvenance | undefined;
    if (senorge?.daysSinceRain !== undefined) {
        daysSinceRain = senorge.daysSinceRain;
        daysSinceRainProvenance = "gridded";
    } else if (frost?.daysSinceRainObserved !== undefined) {
        daysSinceRain = frost.daysSinceRainObserved;
        daysSinceRainProvenance = "observed";
    }

    const rainEventsDaysAgo = senorge?.rainEventsDaysAgo ?? frost?.rainEventsDaysAgoObserved;
    // No forecast-derived days-since-rain equivalent exists — forward-looking
    // data can't tell you what already happened. Left undefined if neither
    // seNorge nor Frost has it; callers treat missing as neutral, not zero.

    let maxDrySpellDays: number | undefined;
    if (senorge?.maxDrySpellDays !== undefined) {
        maxDrySpellDays = senorge.maxDrySpellDays;
    } else if (frost?.maxDrySpellObserved !== undefined) {
        maxDrySpellDays = frost.maxDrySpellObserved;
    }
    // Same reasoning as daysSinceRain above — no forecast tier, left
    // undefined if neither past-observation source has it.

    let tempMeanRecentC: number | undefined;
    // No initializer — same reasoning as precipitationProvenance above.
    let tempProvenance: FieldProvenance;
    if (senorge?.tempMean7dC !== undefined) {
        tempMeanRecentC = senorge.tempMean7dC;
        tempProvenance = "gridded";
    } else if (frost?.tempMean7dObserved !== undefined) {
        tempMeanRecentC = frost.tempMean7dObserved;
        tempProvenance = "observed";
    } else {
        tempMeanRecentC = frost?.tempMax72hObserved ?? forecast.temperatureMax24hForecast;
        tempProvenance = frost?.tempMax72hObserved !== undefined ? "observed" : "forecast";
    }

    const tempMinRecentC = senorge?.tempMinRecentC ?? frost?.tempMinRecentObserved;

    let windMeanMs: number | undefined;
    // No initializer — same reasoning as daysSinceRainProvenance above.
    let windProvenance: FieldProvenance | undefined;
    if (metAnalysis?.windMeanMs !== undefined) {
        windMeanMs = metAnalysis.windMeanMs;
        windProvenance = "gridded";
    } else if (senorge?.windMeanMs !== undefined) {
        windMeanMs = senorge.windMeanMs;
        windProvenance = "gridded";
    }

    let humidityMeanPct: number | undefined;
    // No initializer — same reasoning as precipitationProvenance above.
    let humidityProvenance: FieldProvenance;
    if (metAnalysis?.humidityPct !== undefined) {
        humidityMeanPct = metAnalysis.humidityPct;
        humidityProvenance = "gridded";
    } else if (frost?.humidityMeanObserved !== undefined) {
        humidityMeanPct = frost.humidityMeanObserved;
        humidityProvenance = "observed";
    } else {
        humidityMeanPct = forecast.humidity;
        humidityProvenance = "forecast";
    }

    const vpdKpa =
        tempMeanRecentC !== undefined && humidityMeanPct !== undefined
            ? calculateVpd(tempMeanRecentC, humidityMeanPct)
            : undefined;

    return {
        precipitationRecentMm,
        precipitationProvenance,
        daysSinceRain,
        daysSinceRainProvenance,
        rainEventsDaysAgo,
        maxDrySpellDays,
        tempMeanRecentC,
        tempProvenance,
        tempMinRecentC,
        windMeanMs,
        windProvenance,
        humidityMeanPct,
        humidityProvenance,
        vpdKpa,
        snowDepthCm: senorge?.snowDepthCm,
        solarRadiationWm2: metAnalysis?.solarRadiationWm2,
        cloudCoverPct: metAnalysis?.cloudCoverPct,
    };
}
