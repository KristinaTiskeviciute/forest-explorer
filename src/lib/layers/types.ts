export const DATA_SOURCES = [
    "composite",
    "weather",
    "rainfall",
    "forest",
    "terrain",
    "solarRadiationAdjusted",
    "vpd",
    "twi",
    "wind",
    "humidity",
    "snow",
    "solarRadiation",
    "cloudCover",
] as const;

export type DataSourceId = (typeof DATA_SOURCES)[number];

export type SourceLayerToggles = {
    heatmap: boolean;
    grid: boolean;
};

export type DataSourceLayers = Record<DataSourceId, SourceLayerToggles>;

export const SOURCE_LABELS: Record<DataSourceId, string> = {
    composite: "Composite",
    weather: "Weather",
    rainfall: "Rainfall",
    forest: "Forest",
    terrain: "Terrain",
    solarRadiationAdjusted: "Solar radiation, adjusted (W/m²)",
    vpd: "Vapor pressure deficit (kPa)",
    twi: "Topographic wetness index",
    wind: "Wind (m/s)",
    humidity: "Humidity (%)",
    snow: "Snow depth (cm)",
    solarRadiation: "Solar radiation (W/m²)",
    cloudCover: "Cloud cover (%)",
};

/** Marker / accent color per data source */
export const SOURCE_COLORS: Record<DataSourceId, string> = {
    composite: "#7c3aed",
    weather: "#2563eb",
    rainfall: "#0891b2",
    forest: "#16a34a",
    terrain: "#ea580c",
    solarRadiationAdjusted: "#b45309",
    vpd: "#a16207",
    twi: "#0369a1",
    wind: "#64748b",
    humidity: "#0d9488",
    snow: "#38bdf8",
    solarRadiation: "#f59e0b",
    cloudCover: "#94a3b8",
};

/**
 * "score" layers (composite/weather/rainfall/forest/terrain) are 0-1
 * foraging-suitability opinions, rendered red→green via scoreColors.ts.
 * "value" layers are raw or derived physical readings with no good/bad
 * meaning — they render via valueColors.ts's magnitude ramp instead, so a
 * viewer never confuses "red = high wind" with "red = bad score".
 */
export const LAYER_MODE: Record<DataSourceId, "score" | "value"> = {
    composite: "score",
    weather: "score",
    rainfall: "score",
    forest: "score",
    terrain: "score",
    solarRadiationAdjusted: "value",
    vpd: "value",
    twi: "value",
    wind: "value",
    humidity: "value",
    snow: "value",
    solarRadiation: "value",
    cloudCover: "value",
};

/**
 * Separate from LAYER_MODE — this controls which sidebar section a layer
 * appears under, not how it's colored. "composite" = actually used by the
 * composite score (the 5 sub-scores, plus the exact adjusted/derived
 * quantities their formulas use — e.g. aspect-corrected radiation, not the
 * raw reading). "raw" = the untouched external readings, shown for
 * reference even when not (yet) wired into any score.
 */
export const LAYER_GROUP: Record<DataSourceId, "composite" | "raw"> = {
    composite: "composite",
    weather: "composite",
    rainfall: "composite",
    forest: "composite",
    terrain: "composite",
    solarRadiationAdjusted: "composite",
    vpd: "composite",
    twi: "composite",
    wind: "raw",
    humidity: "raw",
    snow: "raw",
    solarRadiation: "raw",
    cloudCover: "raw",
};

export type DebugLayers = {
    landMask: boolean;
    tileGrid: boolean;
};

/**
 * Raw external WMS reference overlays — plain GetMap tiles rendered
 * straight from NIBIO, not derived from the grid-point scoring pipeline.
 * Kept separate from DataSourceLayers since these don't have a
 * heatmap/grid/score/value shape, just an on/off tile layer.
 */
export type ReferenceOverlays = {
    hogstklasser: boolean;
    crownCover: boolean;
    recentCutSatellite: boolean;
};

export function defaultDataSourceLayers(): DataSourceLayers {
    return {
        composite: { heatmap: true, grid: true },
        weather: { heatmap: false, grid: false },
        rainfall: { heatmap: false, grid: false },
        forest: { heatmap: false, grid: false },
        terrain: { heatmap: false, grid: false },
        solarRadiationAdjusted: { heatmap: false, grid: false },
        vpd: { heatmap: false, grid: false },
        twi: { heatmap: false, grid: false },
        wind: { heatmap: false, grid: false },
        humidity: { heatmap: false, grid: false },
        snow: { heatmap: false, grid: false },
        solarRadiation: { heatmap: false, grid: false },
        cloudCover: { heatmap: false, grid: false },
    };
}

export function defaultDebugLayers(): DebugLayers {
    return { landMask: false, tileGrid: false };
}

export function defaultReferenceOverlays(): ReferenceOverlays {
    return { hogstklasser: false, crownCover: false, recentCutSatellite: false };
}
