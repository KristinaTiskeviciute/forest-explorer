import { describe, expect, test } from "vitest";
import { forestScore } from "./forestScore";
import type { AR5Class } from "../../api/nibioApi";
import { FORAGING_TARGETS } from "./foragingTargets";

const AR5_CLASSES: AR5Class[] = [
    "skog",
    "myr",
    "aapen",
    "dyrka",
    "bebygd",
    "gran",
    "furu",
    "lauv",
    "none",
    "unknown",
];

// The scoring table is a plain object literal indexed by [target][class] with
// no runtime guard (see forestScore.ts) — a class added to the AR5Class union
// without a matching row in every target's table would silently resolve to
// `undefined` here and NaN once it reaches compositeScore. This test pins
// down that every (target, class) pair the app can actually produce has a
// real numeric entry.
describe("forestScore", () => {
    test("every foraging target has a finite 0-1 score for every AR5 class", () => {
        for (const target of FORAGING_TARGETS) {
            for (const c of AR5_CLASSES) {
                const score = forestScore(c, target);
                expect(Number.isFinite(score)).toBe(true);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(1);
            }
        }
    });

    test("defaults to the general target when none is given", () => {
        expect(forestScore("skog")).toBe(forestScore("skog", "general"));
    });

    test("cloudberry strongly prefers bog over forest, unlike every other target", () => {
        expect(forestScore("myr", "cloudberry")).toBeGreaterThan(forestScore("skog", "cloudberry"));
        for (const target of FORAGING_TARGETS) {
            if (target === "cloudberry") continue;
            expect(forestScore("skog", target)).toBeGreaterThan(forestScore("myr", target));
        }
    });

    test("cultivated and built-up land score zero for every target", () => {
        for (const target of FORAGING_TARGETS) {
            expect(forestScore("dyrka", target)).toBe(0);
            expect(forestScore("bebygd", target)).toBe(0);
        }
    });
});
