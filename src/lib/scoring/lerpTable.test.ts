import { describe, expect, test } from "vitest";
import { lerpTable } from "./lerpTable";

const TABLE: Array<[number, number]> = [
    [0, 0.1],
    [10, 1.0],
    [40, 1.0],
    [80, 0.5],
];

describe("lerpTable", () => {
    test("clamps to the first point's y below the table's start", () => {
        expect(lerpTable(-100, TABLE)).toBe(0.1);
        expect(lerpTable(0, TABLE)).toBe(0.1);
    });

    test("clamps to the last point's y above the table's end", () => {
        expect(lerpTable(80, TABLE)).toBe(0.5);
        expect(lerpTable(1000, TABLE)).toBe(0.5);
    });

    test("returns the exact y at a table point", () => {
        expect(lerpTable(10, TABLE)).toBe(1.0);
        expect(lerpTable(40, TABLE)).toBe(1.0);
    });

    test("interpolates linearly between two points", () => {
        // Halfway between (0, 0.1) and (10, 1.0)
        expect(lerpTable(5, TABLE)).toBeCloseTo(0.55, 10);
        // Halfway between (40, 1.0) and (80, 0.5)
        expect(lerpTable(60, TABLE)).toBeCloseTo(0.75, 10);
    });

    test("holds flat across a plateau segment", () => {
        expect(lerpTable(25, TABLE)).toBe(1.0);
    });

    test("a repeated x value resolves via the first (leftward) match, never dividing by zero", () => {
        // The loop's own <=-and-return-immediately structure guarantees
        // `value` is always strictly greater than the previous point's x by
        // the time a later point is compared, so two equal consecutive x's
        // can never both be candidates for the same lookup — documenting
        // that as a concrete case rather than leaving it implicit.
        const repeated: Array<[number, number]> = [
            [0, 0.2],
            [10, 0.9],
            [10, 0.4],
            [20, 1.0],
        ];
        expect(lerpTable(10, repeated)).toBeCloseTo(0.9, 10);
        expect(Number.isNaN(lerpTable(10, repeated))).toBe(false);
    });

    test("a single-point table always returns that point's y", () => {
        const single: Array<[number, number]> = [[5, 0.42]];
        expect(lerpTable(-10, single)).toBe(0.42);
        expect(lerpTable(5, single)).toBe(0.42);
        expect(lerpTable(1000, single)).toBe(0.42);
    });
});
