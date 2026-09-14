import type { HistoricalConditions } from "./historicalConditions";
import type { ForagingTarget } from "./foragingTargets";
import { WEATHER_PROFILES, triangularScore } from "./weatherProfiles";
import { lerpTable } from "./lerpTable";
import { effectiveSolarRadiation } from "./terrainScore";

const RAINFALL_CURVE: Array<[number, number]> = [
    [0, 0.1],
    [5, 0.3],
    [10, 1.0],
    [40, 1.0],
    [80, 0.5],
    [120, 0.15],
];

/**
 * Combines rain-amount (how much) with days-since-rain (how long ago —
 * mushrooms need time to absorb water and fruit, per the 0-2 days low /
 * 5-10 days peak / 20+ days declining pattern) and a wind/VPD-based drying
 * modifier. Roughly 55/45 amount:recency when both are available; recency
 * has no forecast equivalent (forward-looking data can't say what already
 * happened), so it's dropped from the blend rather than guessed at when
 * neither seNorge nor Frost has it.
 */
export function rainfallScore(
    conditions: HistoricalConditions,
    target: ForagingTarget = "general",
    slope?: number,
    aspect?: number,
    twi?: number,
): number {
    const amountScore =
        conditions.precipitationRecentMm !== undefined ? lerpTable(conditions.precipitationRecentMm, RAINFALL_CURVE) : 0.3;

    const recencyScore = bestRecencyScore(conditions, target);
    if (recencyScore === undefined) {
        return applyDryingModifier(amountScore, conditions, slope, aspect, twi);
    }

    const combined = amountScore * 0.55 + recencyScore * 0.45;
    return applyDryingModifier(combined, conditions, slope, aspect, twi);
}

/**
 * daysSinceRain alone only remembers the single most recent qualifying rain
 * day — a spot that rained today *and* 10 days ago (likely already
 * mid-flush from the earlier rain, now just topped up) would score
 * identically to one that rained today after two bone-dry weeks, since both
 * have daysSinceRain=0. rainEventsDaysAgo (when the underlying source
 * tracked the full window — see senorgeApi.ts/frostApi.ts) carries every
 * qualifying rain day, so this takes whichever one lands closest to the
 * target's peak-fruiting window instead of always defaulting to the
 * freshest rain regardless of whether it's actually the more favorable one.
 * Falls back to the single-event daysSinceRain when only that's available
 * (e.g. sources that don't expose the full series).
 */
function bestRecencyScore(conditions: HistoricalConditions, target: ForagingTarget): number | undefined {
    const profile = WEATHER_PROFILES[target];
    if (conditions.rainEventsDaysAgo && conditions.rainEventsDaysAgo.length > 0) {
        return Math.max(
            ...conditions.rainEventsDaysAgo.map((daysAgo) =>
                triangularScore(daysAgo, profile.idealDaysSinceRain, profile.daysSinceRainSpread),
            ),
        );
    }
    if (conditions.daysSinceRain !== undefined) {
        return triangularScore(conditions.daysSinceRain, profile.idealDaysSinceRain, profile.daysSinceRainSpread);
    }
    return undefined;
}

/**
 * Wind, VPD, solar radiation, and prior dry-spell severity are independent
 * drying factors, not restatements of each other: wind determines how fast
 * moisture leaves once there's a deficit, VPD (temp+humidity combined)
 * determines how much deficit there is to begin with, radiation supplies
 * the energy that actually drives evaporation, and dry-spell severity
 * captures a recovery-lag effect none of the other three can (see
 * dryingRelief below) — a still, dry-air day and a windy, humid day and a
 * sunny, calm day and a location just coming out of an 11-day drought can
 * all end up less suitable than the raw rain numbers suggest, for
 * different reasons. Combined multiplicatively (not summed) so any one
 * alone still moves the score, but several being high compounds rather
 * than double-counts. Modest ranges (0.85-1.0 each) since none of them
 * captures per-point soil type.
 *
 * Radiation is corrected for local terrain before use — see
 * effectiveSolarRadiation in terrainScore.ts (shared with the map layer that
 * displays this same adjusted value directly).
 *
 * TWI (topographic wetness index) is a different kind of factor from the
 * others — it's not another drying *cause*, it's persistent structural
 * *resistance* to whatever drying is happening (a valley bottom holds onto
 * moisture longer than a ridge under identical wind/VPD/solar conditions,
 * and plausibly recovers faster from a prior dry spell too). So rather than
 * another multiplied penalty, it scales down the combined penalty from the
 * other factors — deliberately not folded into terrainScore.ts, which
 * already carries aspect and shouldn't pick up a second hydrology-flavored
 * quantity on top of it (see terrainScore.ts's own comment on why aspect's
 * weight there was dialed back this session).
 *
 * Thresholds verified against real computed TWI across 4 quite different
 * locations — flat coastal (Stavern), inland forested hills (Siljan),
 * a steep forested valley (Hjartdal, mean slope ~3x Stavern's), and
 * moderate relief (Notodden). The distribution shape held remarkably
 * steady across all of them (median 4.8-5.5, p90 7.1-7.9, max 13.7-15.7)
 * despite very different elevation/slope — an expected property of TWI,
 * not a coincidence: it's a normalized ln(area/slope) ratio built to
 * capture "wetter than its surroundings," not absolute steepness, so
 * steeper terrain's larger denominator tends to be offset by more
 * concentrated flow accumulation in its valleys. TWI_RELIEF_LOW=5 sits
 * almost exactly at the median everywhere tested (no relief for the
 * drier/steeper half of terrain); TWI_RELIEF_HIGH=12 sits between p90 and
 * the max everywhere (full relief reserved for the genuinely exceptional
 * wet tail). No change needed from the original single-site calibration.
 */
function applyDryingModifier(
    score: number,
    conditions: HistoricalConditions,
    slope?: number,
    aspect?: number,
    twi?: number,
): number {
    const windPenalty = conditions.windMeanMs !== undefined ? Math.min(0.15, conditions.windMeanMs / 40) : 0;
    const vpdPenalty = conditions.vpdKpa !== undefined ? Math.min(0.15, conditions.vpdKpa / 10) : 0;

    let solarPenalty = 0;
    if (conditions.solarRadiationWm2 !== undefined) {
        const effectiveRadiation = effectiveSolarRadiation(conditions.solarRadiationWm2, slope, aspect);
        solarPenalty = Math.min(0.15, effectiveRadiation / 600);
    }

    const drySpellPenalty = dryingLagPenalty(conditions.maxDrySpellDays);

    const combinedPenalty =
        1 - (1 - windPenalty) * (1 - vpdPenalty) * (1 - solarPenalty) * (1 - drySpellPenalty);
    const relief = twiDryingRelief(twi);
    return score * (1 - combinedPenalty * (1 - relief));
}

const DRY_SPELL_PENALTY_FLOOR = 5; // no penalty at/below this many consecutive dry days
const DRY_SPELL_PENALTY_CEIL = 14; // full penalty at/above this — the whole lookback window was dry
const DRY_SPELL_MAX_PENALTY = 0.15; // same cap as the other three drying factors

/**
 * A location that was dry for a long stretch before its most recent rain
 * plausibly hasn't fully recovered even once daysSinceRain/amount look
 * fine — soil moisture and mycelium networks don't rehydrate instantly.
 * Floor/ceiling/cap are placeholders, same tunable-hypothesis honesty as
 * everything else in this file.
 */
function dryingLagPenalty(maxDrySpellDays: number | undefined): number {
    if (maxDrySpellDays === undefined) return 0;
    const t = Math.max(
        0,
        Math.min(1, (maxDrySpellDays - DRY_SPELL_PENALTY_FLOOR) / (DRY_SPELL_PENALTY_CEIL - DRY_SPELL_PENALTY_FLOOR)),
    );
    return t * DRY_SPELL_MAX_PENALTY;
}

const TWI_RELIEF_LOW = 5; // no relief at/below this — ordinary, well-drained terrain
const TWI_RELIEF_HIGH = 12; // full relief at/above this — a real valley-bottom/drainage-convergence point
const TWI_MAX_RELIEF = 0.5; // caps out at cutting the combined drying penalty in half, never fully canceling it

function twiDryingRelief(twi: number | undefined): number {
    if (twi === undefined) return 0;
    const t = Math.max(0, Math.min(1, (twi - TWI_RELIEF_LOW) / (TWI_RELIEF_HIGH - TWI_RELIEF_LOW)));
    return t * TWI_MAX_RELIEF;
}
