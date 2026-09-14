import type { HistoricalConditions } from "./historicalConditions";
import type { ForagingTarget } from "./foragingTargets";
import { WEATHER_PROFILES, triangularScore } from "./weatherProfiles";

/**
 * Temperature (per-target ideal, from the merged recent-mean when
 * available) + humidity + a small night-minimum-temperature bonus (cooler
 * nights mean less overnight evaporation, so a bit of extra credit when we
 * actually have that reading — Frost only, no forecast/seNorge equivalent).
 */
export function weatherScore(conditions: HistoricalConditions, target: ForagingTarget = "general"): number {
    const profile = WEATHER_PROFILES[target];
    const temp = conditions.tempMeanRecentC ?? 14;
    // Squared rather than the raw linear triangularScore: tempSpreadC (10-14)
    // is calibrated for a whole season's tolerance, so the linear curve is
    // nearly flat across realistic same-day/same-radius temperature
    // variance (a couple degrees) — verified live against a real seNorge
    // grid, where a real 2.6°C spread across an 8km radius moved the linear
    // score by under 0.005. Squaring keeps the same ideal point and overall
    // zero-crossing width (still 1.0 at ideal, still 0 at ±spread) but
    // roughly doubles sensitivity near the peak — where realistic
    // conditions actually cluster — while making genuinely bad days
    // (already far from ideal) fall off faster rather than needing equal
    // differentiation once they're clearly unsuitable.
    const tempScore = triangularScore(temp, profile.idealTempC, profile.tempSpreadC) ** 2;
    const humScore =
        conditions.humidityMeanPct !== undefined ? Math.max(0, Math.min(conditions.humidityMeanPct / 100, 1)) : 0.6;

    let score = tempScore * 0.5 + humScore * 0.5;

    if (conditions.tempMinRecentC !== undefined) {
        // Cool-but-not-cold nights get a modest bonus, capped so it can't
        // swing the score much on its own.
        const nightBonus = triangularScore(conditions.tempMinRecentC, 9, 8) * 0.1;
        score = Math.min(1, score * 0.9 + nightBonus);

        if (conditions.tempMinRecentC < 0) {
            // A recent hard frost typically halts fruiting outright for most
            // species, not just "less ideal" — a much bigger effect than the
            // bonus/malus above, so it's layered on top as an additional
            // penalty rather than folded into that triangular curve (which
            // floors at 0 and can't express "much worse than merely cold").
            // Continuous at 0°C (this multiplier starts at 1, i.e. no extra
            // penalty right at freezing) so there's no discontinuity between
            // "just above freezing" and "just below." Scaled by how far
            // below freezing — a light -1°C dip matters less than a hard
            // -8°C freeze — and capped short of zeroing the score entirely,
            // since this field is only the coldest night in the trend
            // window: we can't tell a frost from last night apart from one a
            // week ago, which would have already thawed out.
            const frostPenalty = Math.min(0.5, Math.abs(conditions.tempMinRecentC) / 10);
            score *= 1 - frostPenalty;
        }
    }

    return score;
}
