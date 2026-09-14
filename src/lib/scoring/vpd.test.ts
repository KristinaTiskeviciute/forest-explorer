import { describe, expect, test } from "vitest";
import { calculateVpd } from "./vpd";

describe("calculateVpd", () => {
    test("is zero at 100% relative humidity, regardless of temperature", () => {
        expect(calculateVpd(20, 100)).toBeCloseTo(0, 10);
        expect(calculateVpd(-5, 100)).toBeCloseTo(0, 10);
        expect(calculateVpd(35, 100)).toBeCloseTo(0, 10);
    });

    test("matches the Tetens saturation-vapor-pressure formula directly", () => {
        const tempC = 20;
        const rh = 50;
        const saturation = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
        const expected = saturation - saturation * (rh / 100);
        expect(calculateVpd(tempC, rh)).toBeCloseTo(expected, 10);
    });

    test("increases as relative humidity drops at a fixed temperature", () => {
        const vpdAt80 = calculateVpd(20, 80);
        const vpdAt50 = calculateVpd(20, 50);
        const vpdAt20 = calculateVpd(20, 20);
        expect(vpdAt50).toBeGreaterThan(vpdAt80);
        expect(vpdAt20).toBeGreaterThan(vpdAt50);
    });

    test("increases with temperature at a fixed relative humidity", () => {
        const vpdCold = calculateVpd(5, 50);
        const vpdWarm = calculateVpd(25, 50);
        expect(vpdWarm).toBeGreaterThan(vpdCold);
    });

    test("never returns a negative value", () => {
        expect(calculateVpd(10, 100)).toBeGreaterThanOrEqual(0);
        expect(calculateVpd(-20, 30)).toBeGreaterThanOrEqual(0);
    });
});
