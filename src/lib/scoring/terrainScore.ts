import { lerpTable } from "./lerpTable";

const SLOPE_CURVE: Array<[number, number]> = [
    [0, 1.0],
    [0.05, 0.85],
    [0.15, 0.5],
    [0.3, 0.1],
    [0.45, 0.0],
];

export function slopeScore(slope: number): number {
    return lerpTable(slope, SLOPE_CURVE);
}

export function aspectScore(aspect: number): number {
    return Math.cos((aspect * Math.PI) / 180) * 0.5 + 0.5;
}

/**
 * Aspect gets a reduced weight here (down from an original 0.4) because its
 * "north-facing is better" signal is no longer this function's alone —
 * effectiveSolarRadiation below applies the same north-favors-moisture
 * logic to the drying penalty in rainfallScore.ts, via real radiation
 * readings rather than this flat heuristic. Keeping this at 0.4 would
 * compound the same directional preference twice through two different
 * sub-scores; this residual weight covers what the radiation correction
 * doesn't (e.g. general moisture retention/vegetation differences by
 * aspect, independent of any specific day's solar drying).
 */
export function terrainScore(slope: number, aspect: number): number {
    return slopeScore(slope) * 0.8 + aspectScore(aspect) * 0.2;
}

/**
 * Local-terrain-corrected solar radiation, shared between rainfallScore.ts
 * (which turns this into a drying penalty) and the map layer that displays
 * it directly. The raw reading is a flat, region-wide value that doesn't
 * know about slope/orientation, so a south-facing slope and a shaded
 * north-facing gully at the same point would otherwise get an identical
 * value. On flat ground aspect barely matters (physically correct, and
 * this reduces to the raw value); on steep terrain, north-facing loses up
 * to 30% of the ambient reading, south-facing keeps the full amount.
 */
export function effectiveSolarRadiation(radiationWm2: number, slope?: number, aspect?: number): number {
    if (slope === undefined || aspect === undefined) return radiationWm2;
    const northFacingness = aspectScore(aspect);
    const slopeSteepness = Math.min(1, slope / 0.3);
    return radiationWm2 * (1 - 0.3 * northFacingness * slopeSteepness);
}
