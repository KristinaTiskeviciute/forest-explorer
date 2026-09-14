import { describe, expect, test } from "vitest";
import { mergeHistoricalConditions } from "./historicalConditions";
import type { SenorgeObservation } from "../../api/senorgeApi";
import type { FrostObservation } from "../../api/frostApi";
import type { YrForecast } from "../../api/yrApi";
import type { MetAnalysisObservation } from "../../api/metAnalysisApi";

const forecast: YrForecast = {
    temperature: 14,
    humidity: 75,
    temperatureMax24hForecast: 17,
    precipitation24h: 5,
    precipitation72hForecast: 20,
};

const senorge: SenorgeObservation = {
    precipitation7dMm: 30,
    tempMean7dC: 12,
    daysSinceRain: 2,
};

const frost: FrostObservation = {
    stationId: "SN18700",
    stationName: "TEST",
    stationLat: 59,
    stationLon: 10,
    distanceKm: 5,
    precipitation7dObserved: 25,
    tempMean7dObserved: 11,
    humidityMeanObserved: 70,
    observedAt: Date.now(),
};

const metAnalysis: MetAnalysisObservation = {
    humidityPct: 80,
    windMeanMs: 3.5,
    solarRadiationWm2: 220,
    cloudCoverPct: 40,
};

// Regression guard for the bug where solar radiation and cloud cover went
// silently missing app-wide (met_analysis was the only source and its
// thredds.met.no requests were failing) while everything else kept looking
// fine because those other fields have a fallback tier to degrade to. These
// tests pin down exactly which fields have a fallback and which don't, so
// that distinction stays an enforced fact rather than something only a code
// comment says.
describe("mergeHistoricalConditions field provenance", () => {
    test("solar radiation and cloud cover have NO fallback — undefined when met_analysis is unavailable, even with senorge/frost/forecast all present", () => {
        const merged = mergeHistoricalConditions(senorge, frost, forecast, null);
        expect(merged.solarRadiationWm2).toBeUndefined();
        expect(merged.cloudCoverPct).toBeUndefined();
    });

    test("solar radiation and cloud cover DO populate when met_analysis succeeds", () => {
        const merged = mergeHistoricalConditions(senorge, frost, forecast, metAnalysis);
        expect(merged.solarRadiationWm2).toBe(220);
        expect(merged.cloudCoverPct).toBe(40);
    });

    test("precipitation falls back senorge (gridded) -> frost (observed) -> forecast, in that order", () => {
        expect(mergeHistoricalConditions(senorge, frost, forecast, null).precipitationProvenance).toBe("gridded");
        expect(mergeHistoricalConditions(null, frost, forecast, null).precipitationProvenance).toBe("observed");
        expect(mergeHistoricalConditions(null, null, forecast, null).precipitationProvenance).toBe("forecast");
    });

    test("temperature falls back senorge (gridded) -> frost (observed) -> forecast, in that order", () => {
        expect(mergeHistoricalConditions(senorge, frost, forecast, null).tempProvenance).toBe("gridded");
        expect(mergeHistoricalConditions(null, frost, forecast, null).tempProvenance).toBe("observed");
        expect(mergeHistoricalConditions(null, null, forecast, null).tempProvenance).toBe("forecast");
    });

    test("humidity falls back met_analysis (gridded) -> frost (observed) -> forecast, in that order", () => {
        expect(mergeHistoricalConditions(senorge, frost, forecast, metAnalysis).humidityProvenance).toBe("gridded");
        expect(mergeHistoricalConditions(senorge, frost, forecast, null).humidityProvenance).toBe("observed");
        expect(mergeHistoricalConditions(senorge, null, forecast, null).humidityProvenance).toBe("forecast");
    });

    test("wind falls back met_analysis -> senorge, with no forecast tier — undefined (not a fake forecast value) when both are unavailable", () => {
        expect(mergeHistoricalConditions(senorge, frost, forecast, metAnalysis).windMeanMs).toBe(3.5);
        expect(mergeHistoricalConditions(senorge, frost, forecast, null).windMeanMs).toBeUndefined();
    });

    test("windProvenance is undefined (not a phantom 'forecast') when windMeanMs itself is undefined", () => {
        // Regression: windProvenance used to default to "forecast" at
        // declaration and never get reset when neither source had wind data
        // — misreporting where a nonexistent value came from.
        const merged = mergeHistoricalConditions(senorge, frost, forecast, null);
        expect(merged.windMeanMs).toBeUndefined();
        expect(merged.windProvenance).toBeUndefined();
    });

    test("days-since-rain and dry-spell have no forecast tier — undefined, not a guess, when senorge/frost both lack it", () => {
        const sparseFrost: FrostObservation = {
            stationId: "SN18700",
            stationName: "TEST",
            stationLat: 59,
            stationLon: 10,
            distanceKm: 5,
            observedAt: Date.now(),
        };
        const merged = mergeHistoricalConditions({}, sparseFrost, forecast, null);
        expect(merged.daysSinceRain).toBeUndefined();
        expect(merged.maxDrySpellDays).toBeUndefined();
    });

    test("daysSinceRainProvenance is undefined (not a phantom 'forecast') when daysSinceRain itself is undefined", () => {
        // Same regression as windProvenance above.
        const sparseFrost: FrostObservation = {
            stationId: "SN18700",
            stationName: "TEST",
            stationLat: 59,
            stationLon: 10,
            distanceKm: 5,
            observedAt: Date.now(),
        };
        const merged = mergeHistoricalConditions({}, sparseFrost, forecast, null);
        expect(merged.daysSinceRainProvenance).toBeUndefined();
    });
});
