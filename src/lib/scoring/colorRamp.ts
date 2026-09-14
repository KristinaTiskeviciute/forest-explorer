export type ColorStop = [number, number, number];

/**
 * Continuous linear interpolation through an ordered list of RGB stops —
 * shared by scoreColors.ts (red→green suitability) and valueColors.ts
 * (blue→red magnitude). Both used to bucket their input into hard bands,
 * which made adjacent values on either side of a bucket boundary jump to a
 * completely different color while values within the same bucket looked
 * identical regardless of how far apart they actually were. Interpolating
 * instead means a small change in the input always produces a
 * proportionally small change in color.
 */
export function interpolateColorStops(t: number, stops: ColorStop[]): string {
    const clamped = Math.max(0, Math.min(1, t));
    const segments = stops.length - 1;
    const scaled = clamped * segments;
    const i = Math.min(segments - 1, Math.floor(scaled));
    const localT = scaled - i;

    const [r0, g0, b0] = stops[i];
    const [r1, g1, b1] = stops[i + 1];
    const r = Math.round(r0 + (r1 - r0) * localT);
    const g = Math.round(g0 + (g1 - g0) * localT);
    const b = Math.round(b0 + (b1 - b0) * localT);
    return `rgb(${r}, ${g}, ${b})`;
}
