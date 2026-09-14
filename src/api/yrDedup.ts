/** Finest dedup — matches YR Locationforecast practical resolution */
export const YR_DEDUP_MIN_DEG = 0.01;

function snapDecimals(step: number): number {
    if (step >= 0.1) return 1;
    if (step >= 0.01) return 2;
    return 3;
}

/** Coarser dedup when zoomed out → fewer unique YR requests. Only used by
 *  the standalone/sidebar path (getYrForecast) now — bucketing there is a
 *  caching nicety for one point at a time, not a source of area-wide
 *  flatness the way the bulk grid's dedup was. */
export function yrDedupStepForZoom(zoom: number): number {
    if (zoom < 10) return 0.25;
    if (zoom < 12) return 0.15;
    if (zoom < 14) return 0.08;
    if (zoom < 16) return 0.04;
    return YR_DEDUP_MIN_DEG;
}

/** Ties dedup bucket size to the chosen analysis radius instead of zoom —
 *  aims for ~8 buckets across the diameter, floored at YR's real practical
 *  resolution so a small radius shows genuine local variation instead of
 *  being swallowed by one zoom-derived bucket bigger than the whole area. */
export function yrDedupStepForRadius(radiusKm: number): number {
    return Math.max(YR_DEDUP_MIN_DEG, radiusKm / 8 / 111);
}

export function yrFetchCoordAtStep(lat: number, lon: number, step: number) {
    const d = snapDecimals(step);
    const snappedLat = Math.round(lat / step) * step;
    // lonStep derives from the snapped lat (not raw lat) so two points in the
    // same lat bucket always agree on lon bucket boundaries.
    const lonStep = step / Math.cos((snappedLat * Math.PI) / 180);
    const snappedLon = Math.round(lon / lonStep) * lonStep;
    return {
        lat: Number(snappedLat.toFixed(d)),
        lon: Number(snappedLon.toFixed(d)),
        step,
    };
}

export function yrCacheKeyAtStep(lat: number, lon: number, step: number): string {
    const { lat: la, lon: lo } = yrFetchCoordAtStep(lat, lon, step);
    const d = snapDecimals(step);
    return `${la.toFixed(d)},${lo.toFixed(d)}`;
}

export function yrFetchCoord(lat: number, lon: number, zoom: number) {
    return yrFetchCoordAtStep(lat, lon, yrDedupStepForZoom(zoom));
}

export function yrCacheKey(lat: number, lon: number, zoom: number): string {
    return yrCacheKeyAtStep(lat, lon, yrDedupStepForZoom(zoom));
}
