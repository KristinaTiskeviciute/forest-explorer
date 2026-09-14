import { interpolateColorStops, type ColorStop } from "./colorRamp";

// ColorBrewer RdYlGn-5 anchors — same hues as before, now interpolated
// continuously instead of snapped to whichever band a score falls in.
const STOPS: ColorStop[] = [
    [215, 48, 39], // d73027 red
    [252, 141, 89], // fc8d59 orange
    [254, 224, 139], // fee08b yellow
    [166, 217, 106], // a6d96a light green
    [26, 150, 65], // 1a9641 green
];

/** Map a 0–1 suitability score to the display color ramp */
export function scoreToColor(score: number): string {
    return interpolateColorStops(score, STOPS);
}
