import { describe, expect, test } from "vitest";
import { buildSliceExpr, DAILY_BASE, SNOW_URL } from "./senorgeNetcdf";

// Regression guard for two stacked bugs that made solar radiation, cloud
// cover, and (with less severity, thanks to a working fallback tier)
// precipitation/temp/snow/wind silently disappear: (1) thredds.met.no sends
// no CORS headers, so a direct browser fetch always fails — fixed by routing
// through the /api/thredds dev-server proxy; (2) even through the proxy, the
// built query strings had raw [/] that thredds.met.no's server rejected with
// a 400. Either regression (reverting to a direct thredds.met.no URL, or
// reintroducing an unencoded bracket) would silently reproduce the original
// bug, so both are asserted here directly.
describe("senorgeNetcdf URL construction", () => {
    test("base URLs are the relative /api/thredds proxy path, never the raw host", () => {
        for (const url of [DAILY_BASE, SNOW_URL]) {
            expect(url.startsWith("/api/thredds/")).toBe(true);
            expect(url).not.toContain("thredds.met.no");
        }
    });

    test("buildSliceExpr output never contains a raw bracket", () => {
        const expr = buildSliceExpr("tg", 0, { xi0: 10, xi1: 20, yi0: 30, yi1: 40 });
        expect(expr).not.toMatch(/[[\]]/);
        expect(expr).toContain("%5B");
        expect(expr).toContain("%5D");
    });

    test("buildSliceExpr supports both a single time index and a [start, end] range", () => {
        const bounds = { xi0: 1, xi1: 2, yi0: 3, yi1: 4 };
        expect(buildSliceExpr("rr", 0, bounds)).toContain("0:1:0");
        expect(buildSliceExpr("rr", [190, 205], bounds)).toContain("190:1:205");
    });
});
