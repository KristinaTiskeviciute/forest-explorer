import { describe, expect, test } from "vitest";
import { isInProtectedArea } from "./protectedAreasApi";
import type { FeatureCollection, Polygon } from "geojson";

// A simple square "protected area" roughly matching how getProtectedAreasForBounds
// returns geometry (GeoJSON FeatureCollection of Polygon/MultiPolygon, EPSG:4326).
const squareAreas: FeatureCollection<Polygon> = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            properties: { navn: "Test Verneområde" },
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [10.0, 59.0],
                        [10.1, 59.0],
                        [10.1, 59.1],
                        [10.0, 59.1],
                        [10.0, 59.0],
                    ],
                ],
            },
        },
    ],
};

describe("isInProtectedArea", () => {
    test("a point inside the polygon is flagged as protected", () => {
        expect(isInProtectedArea(59.05, 10.05, squareAreas)).toBe(true);
    });

    test("a point outside the polygon is not flagged", () => {
        expect(isInProtectedArea(59.5, 10.5, squareAreas)).toBe(false);
    });

    test("an empty feature collection never flags anything", () => {
        const empty: FeatureCollection<Polygon> = { type: "FeatureCollection", features: [] };
        expect(isInProtectedArea(59.05, 10.05, empty)).toBe(false);
    });

    test("checks every feature, not just the first", () => {
        const twoAreas: FeatureCollection<Polygon> = {
            type: "FeatureCollection",
            features: [
                squareAreas.features[0],
                {
                    type: "Feature",
                    properties: { navn: "Second area" },
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                [20.0, 60.0],
                                [20.1, 60.0],
                                [20.1, 60.1],
                                [20.0, 60.1],
                                [20.0, 60.0],
                            ],
                        ],
                    },
                },
            ],
        };
        expect(isInProtectedArea(60.05, 20.05, twoAreas)).toBe(true);
    });
});
