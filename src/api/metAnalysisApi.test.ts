import { describe, expect, test } from "vitest";
import { ARCHIVE_BASE, buildVarSlice, LATEST_URL } from "./metAnalysisApi";

// Same regression class as senorgeNetcdf.test.ts, but for met_analysis —
// the ONLY source for solar radiation and cloud cover (no fallback tier at
// all, see historicalConditions.ts), so a regression here means those two
// fields go completely missing, not just degrade to a lower tier.
describe("metAnalysisApi URL construction", () => {
    test("base URLs are the relative /api/thredds proxy path, never the raw host", () => {
        for (const url of [LATEST_URL, ARCHIVE_BASE]) {
            expect(url.startsWith("/api/thredds/")).toBe(true);
            expect(url).not.toContain("thredds.met.no");
        }
    });

    test("buildVarSlice output never contains a raw bracket", () => {
        const expr = buildVarSlice("cloud_area_fraction", { xi0: 900, xi1: 901, yi0: 900, yi1: 901 });
        expect(expr).not.toMatch(/[[\]]/);
        expect(expr).toContain("%5B");
        expect(expr).toContain("%5D");
    });
});
