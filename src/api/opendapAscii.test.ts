import { describe, expect, test } from "vitest";
import { encodeOpendapSlice } from "./opendapAscii";

// Regression guard for the bug where thredds.met.no's Tomcat rejected raw
// [/] in the request target with a 400 ("Invalid character found in the
// request target") — invisible for a long time because the CORS failure
// that predated the /api/thredds proxy fix blocked the browser from ever
// seeing that status code. See senorgeNetcdf.test.ts / metAnalysisApi.test.ts
// for the corresponding checks on the actual call sites.
describe("encodeOpendapSlice", () => {
    test("percent-encodes brackets", () => {
        expect(encodeOpendapSlice("rr[0:1:0][657:1:683][412:1:430]")).toBe(
            "rr%5B0:1:0%5D%5B657:1:683%5D%5B412:1:430%5D",
        );
    });

    test("leaves colons and commas untouched (OPeNDAP needs them literal)", () => {
        const encoded = encodeOpendapSlice("rr[0:1:0]");
        expect(encoded).toContain(":");
        expect(encoded).not.toContain("[");
        expect(encoded).not.toContain("]");
    });

    test("output never contains a raw bracket, whatever the input shape", () => {
        const inputs = [
            "wind_speed_10m[0:1:0][900:1:901][900:1:901]",
            "snow_depth[190:1:205][10:1:20][30:1:40]",
            "tg[0:1:0][0:1:0][0:1:0]",
        ];
        for (const expr of inputs) {
            const encoded = encodeOpendapSlice(expr);
            expect(encoded).not.toMatch(/[[\]]/);
        }
    });
});
