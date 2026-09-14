import { describe, expect, test } from "vitest";
import { weatherScore } from "./weatherScore";
import type { HistoricalConditions } from "./historicalConditions";

// general profile: idealTempC 14, tempSpreadC 14, idealDaysSinceRain 6, daysSinceRainSpread 6
const base: HistoricalConditions = {
    precipitationProvenance: "forecast",
    daysSinceRainProvenance: "forecast",
    tempProvenance: "forecast",
    windProvenance: "forecast",
    humidityProvenance: "forecast",
};

describe("weatherScore", () => {
    test("at the ideal temperature with no humidity reading, uses the 0.6 humidity default", () => {
        // tempMeanRecentC defaults to 14 (the ideal), so tempScore == 1;
        // humScore defaults to 0.6 when humidityMeanPct is absent.
        // 1 * 0.5 + 0.6 * 0.5 = 0.8
        expect(weatherScore(base)).toBeCloseTo(0.8, 10);
    });

    test("humidity above 0 scales the score down from the no-data default", () => {
        const half = weatherScore({ ...base, humidityMeanPct: 50 });
        // 1 * 0.5 + 0.5 * 0.5 = 0.75
        expect(half).toBeCloseTo(0.75, 10);
    });

    test("temperature away from ideal falls off, squared", () => {
        // 7C away from ideal (half of tempSpreadC=14) -> linear triangularScore = 0.5, squared = 0.25
        const score = weatherScore({ ...base, tempMeanRecentC: 21 });
        // 0.25 * 0.5 + 0.6 * 0.5 = 0.425
        expect(score).toBeCloseTo(0.425, 10);
    });

    test("temperature at or beyond the spread floors the temperature term at zero", () => {
        const atEdge = weatherScore({ ...base, tempMeanRecentC: 28 }); // exactly ideal + spread
        const beyond = weatherScore({ ...base, tempMeanRecentC: 50 });
        expect(atEdge).toBeCloseTo(0.3, 10); // 0 * 0.5 + 0.6 * 0.5
        expect(beyond).toBeCloseTo(0.3, 10);
    });

    test("a cool-but-not-cold night gives a small bonus, capped so it can't dominate", () => {
        // tempMinRecentC at its own ideal (9) with base score 0.8
        const withBonus = weatherScore({ ...base, tempMinRecentC: 9 });
        // min(1, 0.8*0.9 + 1*0.1) = 0.82
        expect(withBonus).toBeCloseTo(0.82, 10);
    });

    test("a below-freezing night applies an additional frost penalty on top of the night-bonus term", () => {
        // -3C: nightBonus triangularScore(-3, 9, 8) clamps to 0 -> score = 0.8*0.9 = 0.72
        // frostPenalty = min(0.5, 3/10) = 0.3 -> 0.72 * 0.7
        expect(weatherScore({ ...base, tempMinRecentC: -3 })).toBeCloseTo(0.504, 10);
    });

    test("frost penalty is capped at 0.5 regardless of how far below freezing", () => {
        const hardFrost = weatherScore({ ...base, tempMinRecentC: -8 });
        const extremeFrost = weatherScore({ ...base, tempMinRecentC: -20 });
        // Both already at the penalty cap: 0.8*0.9 * (1 - 0.5) = 0.36
        expect(hardFrost).toBeCloseTo(0.36, 10);
        expect(extremeFrost).toBeCloseTo(hardFrost, 10);
    });

    test("humidity is clamped on both ends, not just the upper bound", () => {
        // A malformed/out-of-range upstream reading shouldn't be able to
        // push the humidity term negative or above 1.
        const negative = weatherScore({ ...base, humidityMeanPct: -20 });
        const over100 = weatherScore({ ...base, humidityMeanPct: 150 });
        expect(negative).toBeCloseTo(0.5, 10); // 1 * 0.5 + 0 * 0.5
        expect(over100).toBeCloseTo(1.0, 10); // 1 * 0.5 + 1 * 0.5
    });

    test("score never exceeds 1", () => {
        const score = weatherScore({ ...base, tempMeanRecentC: 14, humidityMeanPct: 100, tempMinRecentC: 9 });
        expect(score).toBeLessThanOrEqual(1);
    });
});
