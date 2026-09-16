export const DATA_SOURCES = [
    "composite",
    "weather",
    "temperature",
    "humidity",
    "rainfall",
    "precipitationRecent",
    "wind",
    "solarRadiationAdjusted",
    "vpd",
    "twi",
    "forest",
    "terrain",
    "snow",
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
    temperature: "Temperature, recent mean (°C)",
    humidity: "Humidity (%)",
    precipitationRecent: "Rainfall amount, recent (mm)",
    wind: "Wind (m/s)",
    solarRadiationAdjusted: "Solar radiation, adjusted (W/m²)",
    vpd: "Vapor pressure deficit (kPa)",
    twi: "Topographic wetness index",
    snow: "Snow depth (cm)",
};

/** Marker / accent color per data source */
export const SOURCE_COLORS: Record<DataSourceId, string> = {
    composite: "#7c3aed",
    weather: "#2563eb",
    rainfall: "#0891b2",
    forest: "#16a34a",
    terrain: "#ea580c",
    temperature: "#e11d48",
    humidity: "#0d9488",
    precipitationRecent: "#67e8f9",
    wind: "#64748b",
    solarRadiationAdjusted: "#b45309",
    vpd: "#a16207",
    twi: "#0369a1",
    snow: "#38bdf8",
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
    temperature: "value",
    humidity: "value",
    precipitationRecent: "value",
    wind: "value",
    solarRadiationAdjusted: "value",
    vpd: "value",
    twi: "value",
    snow: "value",
};

/**
 * Separate from LAYER_MODE — this controls which sidebar section a layer
 * appears under, not how it's colored. "composite" = actually used by the
 * composite score (the 5 sub-scores, plus the exact adjusted/derived
 * quantities their formulas use — e.g. aspect-corrected radiation, not the
 * raw reading — and readings that go in completely unmodified, like wind and
 * humidity). "raw" = genuinely not wired into any score — currently just
 * snow depth, kept for its own sake (relevant to a forager even though the
 * scoring formula doesn't use it). Raw (unadjusted) solar radiation and
 * cloud cover used to live here too, but were dropped: unadjusted radiation
 * was fully superseded by its terrain-corrected version shown under
 * Rainfall, and cloud cover was, per historicalConditions.ts's own comment,
 * "display-only — redundant with solar radiation."
 */
export const LAYER_GROUP: Record<DataSourceId, "composite" | "raw"> = {
    composite: "composite",
    weather: "composite",
    rainfall: "composite",
    forest: "composite",
    terrain: "composite",
    temperature: "composite",
    humidity: "composite",
    precipitationRecent: "composite",
    wind: "composite",
    solarRadiationAdjusted: "composite",
    vpd: "composite",
    twi: "composite",
    snow: "raw",
};

/**
 * Which score a composite-group layer is actually an input to — shown as a
 * nested/indented row under that parent in the sidebar so it doesn't look
 * like an unrelated peer of the five sub-scores.
 *
 * - temperature and humidity feed weatherScore.ts directly (its temp-match
 *   and humidity-match halves).
 * - precipitationRecent is rainfallScore.ts's dominant input (amount +
 *   recency); wind, solarRadiationAdjusted, vpd, and twi are its secondary
 *   drying-modifier/relief inputs. Despite the "weather"/"terrain" flavor of
 *   some of these names, all five currently feed rainfallScore.ts
 *   specifically, not weatherScore or terrainScore — see that file's own
 *   comment on why.
 *
 * humidity is also an input to vpd (see historicalConditions.ts's
 * calculateVpd), but vpd — not humidity itself — is what rainfallScore.ts
 * actually reads, so humidity is nested only under weather to avoid
 * implying it's independently double-counted.
 */
export const LAYER_PARENT: Partial<Record<DataSourceId, DataSourceId>> = {
    temperature: "weather",
    humidity: "weather",
    precipitationRecent: "rainfall",
    wind: "rainfall",
    solarRadiationAdjusted: "rainfall",
    vpd: "rainfall",
    twi: "rainfall",
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
        temperature: { heatmap: false, grid: false },
        humidity: { heatmap: false, grid: false },
        precipitationRecent: { heatmap: false, grid: false },
        wind: { heatmap: false, grid: false },
        solarRadiationAdjusted: { heatmap: false, grid: false },
        vpd: { heatmap: false, grid: false },
        twi: { heatmap: false, grid: false },
        snow: { heatmap: false, grid: false },
    };
}

export function defaultDebugLayers(): DebugLayers {
    return { landMask: false, tileGrid: false };
}

export function defaultReferenceOverlays(): ReferenceOverlays {
    return { hogstklasser: false, crownCover: false, recentCutSatellite: false };
}
