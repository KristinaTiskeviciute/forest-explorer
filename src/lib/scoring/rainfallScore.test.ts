import { describe, expect, test } from "vitest";
import { rainfallScore } from "./rainfallScore";
import type { HistoricalConditions } from "./historicalConditions";

const base: HistoricalConditions = {
    precipitationProvenance: "forecast",
    daysSinceRainProvenance: "forecast",
    tempProvenance: "forecast",
    windProvenance: "forecast",
    humidityProvenance: "forecast",
};

describe("rainfallScore — amount and recency blend", () => {
    test("with no recency data at all, the score is amount-only (no drying factors present)", () => {
        // precip 10mm sits exactly on the RAINFALL_CURVE's [10, 1.0] point.
        expect(rainfallScore({ ...base, precipitationRecentMm: 10 })).toBeCloseTo(1.0, 10);
    });

    test("blends amount (55%) and recency (45%) when both are available", () => {
        // amount at 0mm -> 0.1, recency at the general profile's ideal (6 days) -> 1.0
        const score = rainfallScore({ ...base, precipitationRecentMm: 0, daysSinceRain: 6 });
        expect(score).toBeCloseTo(0.1 * 0.55 + 1.0 * 0.45, 10);
    });

    test("rainEventsDaysAgo takes priority over daysSinceRain, and uses whichever event scores best", () => {
        // daysSinceRain alone (20 days, far past the ideal) would score much
        // worse than the best of several tracked events, one of which lands
        // right on the ideal.
        const withSeries = rainfallScore({
            ...base,
            precipitationRecentMm: 10,
            daysSinceRain: 20,
            rainEventsDaysAgo: [1, 6, 20],
        });
        const daysSinceRainOnly = rainfallScore({ ...base, precipitationRecentMm: 10, daysSinceRain: 20 });
        expect(withSeries).toBeCloseTo(1.0, 10); // amount 1.0 blended with recency 1.0 (day 6 is the ideal)
        expect(withSeries).toBeGreaterThan(daysSinceRainOnly);
    });
});

describe("rainfallScore — drying modifier", () => {
    test("each of wind/VPD/solar/dry-spell caps its own penalty at 0.15", () => {
        const maxed = rainfallScore({
            ...base,
            precipitationRecentMm: 10,
            windMeanMs: 100,
            vpdKpa: 100,
            solarRadiationWm2: 10_000,
            maxDrySpellDays: 30,
        });
        // combinedPenalty = 1 - (1-0.15)^4 = 0.47799375; amountScore=1.0, no TWI relief
        expect(maxed).toBeCloseTo(1 - 0.47799375, 6);
    });

    test("a below-cap wind reading scales the penalty proportionally", () => {
        // windPenalty = min(0.15, 3/40) = 0.075, everything else absent
        const score = rainfallScore({ ...base, precipitationRecentMm: 10, windMeanMs: 3 });
        expect(score).toBeCloseTo(1 - 0.075, 10);
    });

    test("high TWI (valley-bottom drainage) cuts the combined drying penalty in half", () => {
        const withoutRelief = rainfallScore({
            ...base,
            precipitationRecentMm: 10,
            windMeanMs: 100,
            vpdKpa: 100,
            solarRadiationWm2: 10_000,
            maxDrySpellDays: 30,
        });
        const withFullRelief = rainfallScore(
            {
                ...base,
                precipitationRecentMm: 10,
                windMeanMs: 100,
                vpdKpa: 100,
                solarRadiationWm2: 10_000,
                maxDrySpellDays: 30,
            },
            "general",
            undefined,
            undefined,
            12, // TWI_RELIEF_HIGH — full relief
        );
        const combinedPenalty = 1 - Math.pow(0.85, 4);
        expect(withFullRelief).toBeCloseTo(1 - combinedPenalty * 0.5, 6);
        expect(withFullRelief).toBeGreaterThan(withoutRelief);
    });

    test("TWI at or below the low threshold gives no relief", () => {
        const score = rainfallScore(
            { ...base, precipitationRecentMm: 10, windMeanMs: 100 },
            "general",
            undefined,
            undefined,
            5, // TWI_RELIEF_LOW
        );
        const withoutTwi = rainfallScore({ ...base, precipitationRecentMm: 10, windMeanMs: 100 });
        expect(score).toBeCloseTo(withoutTwi, 10);
    });
});
