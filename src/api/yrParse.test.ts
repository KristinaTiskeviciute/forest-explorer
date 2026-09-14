import { describe, expect, test } from "vitest";
import { parseYrForecast } from "./yrParse";

function timeseriesEntry(airTempC: number, humidityPct: number, precip1h?: number, precip6h?: number) {
    return {
        data: {
            instant: { details: { air_temperature: airTempC, relative_humidity: humidityPct } },
            ...(precip1h !== undefined ? { next_1_hours: { details: { precipitation_amount: precip1h } } } : {}),
            ...(precip6h !== undefined ? { next_6_hours: { details: { precipitation_amount: precip6h } } } : {}),
        },
    };
}

describe("parseYrForecast", () => {
    test("throws instead of crashing on index access when the response has an empty timeseries", () => {
        // A malformed/degraded upstream response (schema change, empty
        // payload) previously crashed with an uncaught TypeError on
        // `timeseries[0]` — this pins down the guarded, catchable failure
        // mode instead.
        expect(() => parseYrForecast({ properties: { timeseries: [] } })).toThrow();
    });

    test("reads the current instant reading from the first timeseries entry", () => {
        const json = { properties: { timeseries: [timeseriesEntry(12.5, 80, 1)] } };
        const result = parseYrForecast(json);
        expect(result.temperature).toBe(12.5);
        expect(result.humidity).toBe(80);
    });

    test("sums next_1_hours precipitation across the first 24 entries for precipitation24h", () => {
        const entries = Array.from({ length: 24 }, () => timeseriesEntry(10, 70, 2));
        const json = { properties: { timeseries: entries } };
        expect(parseYrForecast(json).precipitation24h).toBeCloseTo(48, 10);
    });

    test("falls back to next_6_hours / 6 per hour when next_1_hours is absent", () => {
        const entries = Array.from({ length: 6 }, () => timeseriesEntry(10, 70, undefined, 12));
        const json = { properties: { timeseries: entries } };
        // Each of the 6 hourly entries contributes 12/6 = 2mm -> 12mm total
        expect(parseYrForecast(json).precipitation24h).toBeCloseTo(12, 10);
    });

    test("precipitation72hForecast sums across up to 72 entries, beyond the 24h window", () => {
        const entries = Array.from({ length: 72 }, () => timeseriesEntry(10, 70, 1));
        const json = { properties: { timeseries: entries } };
        const result = parseYrForecast(json);
        expect(result.precipitation24h).toBeCloseTo(24, 10);
        expect(result.precipitation72hForecast).toBeCloseTo(72, 10);
    });

    test("temperatureMax24hForecast is the highest instant reading in the next 24 entries, including the current one", () => {
        const entries = [
            timeseriesEntry(10, 70),
            timeseriesEntry(22, 70),
            timeseriesEntry(15, 70),
        ];
        const json = { properties: { timeseries: entries } };
        expect(parseYrForecast(json).temperatureMax24hForecast).toBe(22);
    });

    test("only considers the first 24 entries for temperatureMax24hForecast, not later ones", () => {
        const entries = [
            ...Array.from({ length: 24 }, () => timeseriesEntry(5, 70)),
            timeseriesEntry(99, 70), // entry 25 — outside the 24h window
        ];
        const json = { properties: { timeseries: entries } };
        expect(parseYrForecast(json).temperatureMax24hForecast).toBe(5);
    });
});
