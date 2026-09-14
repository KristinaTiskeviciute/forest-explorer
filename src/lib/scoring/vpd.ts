/**
 * Vapor pressure deficit (VPD) in kPa — our practical substitute for direct
 * soil-moisture data (not available from any source this app has access to).
 * Low VPD = humid air, slow drying; high VPD = dry air, faster moisture
 * loss from soil/mycelium regardless of how much it recently rained.
 * Standard Tetens-equation saturation vapor pressure, no fetch required.
 */
export function calculateVpd(tempC: number, relativeHumidityPct: number): number {
    const saturationVaporPressureKpa = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
    const actualVaporPressureKpa = saturationVaporPressureKpa * (relativeHumidityPct / 100);
    return Math.max(0, saturationVaporPressureKpa - actualVaporPressureKpa);
}
