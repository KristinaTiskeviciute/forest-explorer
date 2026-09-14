import type { ForagingTarget } from "./foragingTargets";

export type WeatherProfile = {
    idealTempC: number;
    tempSpreadC: number;
    idealDaysSinceRain: number;
    daysSinceRainSpread: number;
};

// Per-target tuning — there's no single "best weather" independent of what's
// being foraged (chanterelles tolerate cooler temps and like sustained
// moisture over more time; ceps/porcini respond more strongly to warmth and
// peak sooner after rain; lingonberries prefer things drier overall).
// Starting values — a hypothesis per the user's research, flagged as
// tunable, same honesty as every other scoring table this session.
export const WEATHER_PROFILES: Record<ForagingTarget, WeatherProfile> = {
    general: { idealTempC: 14, tempSpreadC: 14, idealDaysSinceRain: 6, daysSinceRainSpread: 6 },
    chanterelle: { idealTempC: 13, tempSpreadC: 12, idealDaysSinceRain: 7, daysSinceRainSpread: 8 },
    cep: { idealTempC: 16, tempSpreadC: 10, idealDaysSinceRain: 5, daysSinceRainSpread: 5 },
    blueberry: { idealTempC: 15, tempSpreadC: 14, idealDaysSinceRain: 8, daysSinceRainSpread: 10 },
    lingonberry: { idealTempC: 16, tempSpreadC: 14, idealDaysSinceRain: 10, daysSinceRainSpread: 12 },
    cloudberry: { idealTempC: 12, tempSpreadC: 10, idealDaysSinceRain: 5, daysSinceRainSpread: 6 },
};

/** Triangular curve: 1.0 at the ideal value, falling off linearly to 0 at ±spread. */
export function triangularScore(value: number, ideal: number, spread: number): number {
    return Math.max(0, 1 - Math.abs(value - ideal) / spread);
}
