/**
 * Piecewise-linear interpolation through a sorted table of [x, y] points.
 * Values below the first point or above the last point clamp to that
 * point's y — no extrapolation past the table's edges.
 */
export function lerpTable(value: number, points: Array<[number, number]>): number {
    if (value <= points[0][0]) return points[0][1];

    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        if (value <= x1) {
            const t = (value - x0) / (x1 - x0);
            return y0 + t * (y1 - y0);
        }
    }

    return points[points.length - 1][1];
}
