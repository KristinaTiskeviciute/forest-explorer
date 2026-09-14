import { describe, expect, test } from "vitest";
import { compositeScore } from "./compositeScore";
import type { HistoricalConditions } from "./historicalConditions";
import type { YrForecast } from "../../api/yrApi";

const forecast: YrForecast = {
    temperature: 14,
    humidity: 75,
    temperatureMax24hForecast: 17,
    precipitation24h: 5,
    precipitation72hForecast: 20,
};

const conditions: HistoricalConditions = {
    precipitationRecentMm: 10,
    precipitationProvenance: "gridded",
    daysSinceRain: 4,
    daysSinceRainProvenance: "gridded",
    tempMeanRecentC: 14,
    tempProvenance: "gridded",
    windMeanMs: 3,
    windProvenance: "gridded",
    humidityMeanPct: 70,
    humidityProvenance: "gridded",
};

function score(zoom: number, opts: { slope?: number; aspect?: number } = {}) {
    return compositeScore({
        zoom,
        forecast,
        conditions,
        forestClass: "skog",
        slope: opts.slope,
        aspect: opts.aspect,
        foragingTarget: "general",
    });
}

// terrainWeight() ramp from compositeScore.ts, reproduced here as the
// expected values a regression should catch if the ramp ever changes
// unintentionally.
const ZOOM_TERRAIN_WEIGHT: Array<[number, number]> = [
    [10, 0], // below MIN_TERRAIN_GRID_ZOOM (11) — terrain isn't fetched at all
    [11, 0.15],
    [12, 0.15],
    [13, 0.2],
    [14, 0.2],
    [15, 0.25],
    [16, 0.3],
    [17, 0.35],
    [20, 0.35],
];

describe("compositeScore — weighting", () => {
    test.each(ZOOM_TERRAIN_WEIGHT)("zoom %i assigns terrain weight %f when terrain data is present", (zoom, expected) => {
        const breakdown = score(zoom, { slope: 0.1, aspect: 180 });
        expect(breakdown.weights.terrain).toBeCloseTo(expected, 10);
    });

    test("weights always sum to 1, with or without terrain", () => {
        for (const [zoom] of ZOOM_TERRAIN_WEIGHT) {
            const withTerrain = score(zoom, { slope: 0.1, aspect: 180 });
            const sumWith =
                withTerrain.weights.weather + withTerrain.weights.rainfall + withTerrain.weights.forest + withTerrain.weights.terrain;
            expect(sumWith).toBeCloseTo(1, 10);

            const withoutTerrain = score(zoom);
            const sumWithout =
                withoutTerrain.weights.weather +
                withoutTerrain.weights.rainfall +
                withoutTerrain.weights.forest +
                withoutTerrain.weights.terrain;
            expect(sumWithout).toBeCloseTo(1, 10);
        }
    });

    test("composite is exactly the weighted sum of its own reported sub-scores and weights", () => {
        for (const [zoom] of ZOOM_TERRAIN_WEIGHT) {
            const breakdown = score(zoom, { slope: 0.2, aspect: 90 });
            const expected =
                breakdown.weather * breakdown.weights.weather +
                breakdown.rainfall * breakdown.weights.rainfall +
                breakdown.forest * breakdown.weights.forest +
                (breakdown.terrain ?? 0) * breakdown.weights.terrain;
            expect(breakdown.composite).toBeCloseTo(expected, 10);
        }
    });

    test("terrain weight is 0 at a zoom that supports terrain when slope/aspect are missing (fetch failed)", () => {
        // Same weight shape as the below-MIN_TERRAIN_GRID_ZOOM case, even
        // though this zoom does support terrain — compositeScore can't tell
        // "unsupported at this zoom" apart from "terrain fetch failed here".
        const breakdown = score(17); // no slope/aspect passed
        expect(breakdown.terrain).toBeNull();
        expect(breakdown.weights.terrain).toBe(0);
        expect(breakdown.weights.weather).toBeCloseTo(0.35, 10);
        expect(breakdown.weights.rainfall).toBeCloseTo(0.35, 10);
        expect(breakdown.weights.forest).toBeCloseTo(0.3, 10);
    });

    test("below MIN_TERRAIN_GRID_ZOOM, terrain is excluded even if slope/aspect are supplied", () => {
        const breakdown = score(9, { slope: 0.1, aspect: 180 });
        expect(breakdown.weights.terrain).toBe(0);
    });

    test("terrainSupportedAtZoom distinguishes 'unsupported at this zoom' from 'fetch failed at a supported zoom'", () => {
        // Both cases end up with terrain: null and weights.terrain: 0, but
        // display code needs to tell them apart (see tooltips.ts) instead of
        // always claiming terrain "isn't used at this zoom level".
        const belowMinZoom = score(9); // MIN_TERRAIN_GRID_ZOOM is 11
        expect(belowMinZoom.terrain).toBeNull();
        expect(belowMinZoom.terrainSupportedAtZoom).toBe(false);

        const fetchFailedAtSupportedZoom = score(17); // no slope/aspect passed
        expect(fetchFailedAtSupportedZoom.terrain).toBeNull();
        expect(fetchFailedAtSupportedZoom.terrainSupportedAtZoom).toBe(true);
    });
});
