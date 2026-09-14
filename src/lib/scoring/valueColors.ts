import type { DataSourceId } from "../layers/types";
import { interpolateColorStops, type ColorStop } from "./colorRamp";

/**
 * Magnitude ramp for raw-value layers (wind/humidity/snow) — deliberately
 * distinct from scoreColors.ts's red→green "bad→good" ramp, since a raw
 * physical reading has no good/bad meaning on its own. Blue→cyan→yellow→red
 * is a conventional "cool→warm" magnitude scale.
 */
const STOPS: ColorStop[] = [
    [59, 130, 246], // blue
    [34, 211, 238], // cyan
    [250, 204, 21], // yellow
    [239, 68, 68], // red
];

function magnitudeToColor(t: number): string {
    return interpolateColorStops(t, STOPS);
}

/** Expected real-world range per value layer — tunable defaults, same
 *  honesty as every other scoring threshold in this codebase. */
export const VALUE_DOMAINS: Partial<Record<DataSourceId, { min: number; max: number }>> = {
    wind: { min: 0, max: 15 },
    humidity: { min: 30, max: 100 },
    snow: { min: 0, max: 50 },
    // 0 (night hours, or the trend's fixed sample hour landing after dark)
    // through ~800 (bright clear midday at Norway's latitude in summer).
    solarRadiation: { min: 0, max: 800 },
    solarRadiationAdjusted: { min: 0, max: 800 },
    cloudCover: { min: 0, max: 100 },
    // kPa — observed range this session was ~0.4-0.95; a wider ceiling
    // leaves room for genuinely dry/warm conditions without saturating.
    vpd: { min: 0, max: 2 },
    // Unitless (ln of area/tan(slope)) — real observed range this session
    // was ~1-14 over a small coastal patch near Stavern; wider terrain will
    // likely need this refined once seen.
    twi: { min: 1, max: 14 },
};

export function valueToColor(value: number, source: DataSourceId): string {
    if (!Number.isFinite(value)) return magnitudeToColor(0.5);
    const domain = VALUE_DOMAINS[source];
    if (!domain) return magnitudeToColor(0.5);
    const t = (value - domain.min) / (domain.max - domain.min);
    return magnitudeToColor(t);
}
