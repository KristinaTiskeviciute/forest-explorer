import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { ScoreBreakdown } from "../scoring/compositeScore";
import type { YrForecast } from "../../api/yrApi";
import type { FrostObservation } from "../../api/frostApi";
import type { TerrainSample } from "../terrain/types";

export type SourceScores = {
    composite: number;
    weather: number;
    rainfall: number;
    forest: number;
    terrain: number | null;
};

export type GridPoint = {
    lat: number;
    lon: number;
    elevation?: number;
    slope?: number;
    aspect?: number;
    twi?: number;
    forecast?: YrForecast;
    historical?: FrostObservation | null;
    scores: SourceScores;
    debug?: ScoreBreakdown;
};

export type TerrainDebugData = {
    samples: TerrainSample[];
    targets: Array<{ lat: number; lon: number }>;
};

export type LoadGridResult = {
    points: GridPoint[];
    terrainDebug: TerrainDebugData;
    gridStep: number;
    /** National parks/nature reserves/landscape protection areas etc.
     *  overlapping the loaded area — see protectedAreasApi.ts. Points inside
     *  these are already excluded from `points` above; this is carried along
     *  so the map can show *why* there's a gap there instead of a silent one. */
    protectedAreas: FeatureCollection<Polygon | MultiPolygon>;
};

/** Stage of loadGridData's pipeline, for a progress indicator — see
 *  loadGridData.ts's onProgress option. */
export type LoadStage = "terrain" | "forest" | "weather" | "historical";

/** The inert placeholder result shared by every "nothing loaded yet / load
 *  failed" case — kept as one constant so its shape can't quietly drift out
 *  of sync between the callers that need it. */
export const emptyGrid: LoadGridResult = {
    points: [],
    terrainDebug: { samples: [], targets: [] },
    gridStep: 0,
    protectedAreas: { type: "FeatureCollection", features: [] },
};
