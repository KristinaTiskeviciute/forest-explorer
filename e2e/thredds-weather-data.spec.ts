import { expect, test } from "@playwright/test";

/**
 * Deliberately hits the REAL network (thredds.met.no via the dev-server's
 * /api/thredds proxy, plus Frost/Yr) — no mocking. That's the whole point:
 * this app once had solar radiation and cloud cover silently missing
 * app-wide for two stacked reasons that only ever showed up as a real
 * browser talking to the real upstream host:
 *   1. thredds.met.no sends no CORS headers, so a direct browser fetch
 *      always failed with a generic "Failed to fetch" — invisible to any
 *      test that mocks fetch or runs in Node (Node's fetch doesn't enforce
 *      CORS at all, so a "passing" mocked/Node-only test would have stayed
 *      green through this entire incident).
 *   2. Once routed through a same-origin proxy, the OPeNDAP query strings'
 *      un-percent-encoded [/] characters triggered a real 400 from
 *      thredds.met.no's server — a genuine upstream contract this app's
 *      code has to get right, not something a unit test alone can verify.
 * A real, unmocked browser click against the real network is the only test
 * shape that would have caught either of these before shipping.
 */
test("clicking the map loads solar radiation and cloud cover from the real thredds.met.no proxy", async ({ page }) => {
    await page.goto("/");

    const map = page.locator(".leaflet-container");
    await expect(map).toBeVisible();
    const box = await map.boundingBox();
    if (!box) throw new Error("map container has no bounding box");
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // First click: triggers the real bulk grid load (loadGridData.ts ->
    // getMetAnalysisConditionsForRadius) against the real network — this is
    // the path the CORS/encoding bugs actually broke, and what backs the
    // heatmap/every grid point in normal use.
    //
    // "Composite:" appearing in the sidebar is NOT proof this finished —
    // that text comes from App.tsx's *own*, separate quick per-point fetch
    // (which on this first click also hits the independent-fetch fallback,
    // since no grid point exists yet — see the comment above
    // `selectedPoint?.debug` in App.tsx). The bulk grid load that actually
    // exercises the fixed code path is a different, typically slower,
    // background process (GridPointLoader / MapView.tsx's floating loading
    // pill). Wait for that pill's last stage to appear, then disappear, to
    // know the bulk load has genuinely finished before clicking again.
    await page.mouse.click(center.x, center.y);
    const sidebar = page.locator("body");
    await expect(sidebar).toContainText(/Refining with historical data/, { timeout: 30_000 });
    await expect(sidebar).not.toContainText(/Refining with historical data/, { timeout: 60_000 });

    // Second click, same spot, now that the grid has actually finished
    // loading: the sidebar reuses the grid's own already-fetched conditions
    // (met_analysis included) instead of falling back again.
    await page.mouse.click(center.x, center.y);
    await expect(sidebar).toContainText(/\d+ W\/m² solar/, { timeout: 15_000 });
    await expect(sidebar).toContainText(/\d+% cloud/, { timeout: 5_000 });
});

/**
 * Separate regression: App.tsx's sidebar detail fetch has two code paths —
 * reuse an already-loaded grid point's conditions (exercised above), or an
 * independent per-point fallback fetch used only when no grid point exists
 * yet (the very first click of a session, before any grid has loaded). That
 * fallback used to omit met_analysis entirely (mergeHistoricalConditions was
 * called with no 4th argument), so solar radiation/cloud cover — and
 * met_analysis's gridded-tier humidity/wind — were silently missing on
 * every session's first click, regardless of network health. Fixed via
 * getMetAnalysisLatestAtPoint (a lightweight single-hour fetch, not the full
 * multi-day trend the bulk path uses — see that function's own comment for
 * why). This test's whole point is clicking exactly ONCE, immediately on
 * page load, to stay on that fallback path — do not add a second click or
 * a wait-for-grid-load step here, that would silently start testing the
 * *other* code path instead and defeat the purpose.
 */
test("the very first click of a session (before any grid loads) also gets solar radiation and cloud cover", async ({
    page,
}) => {
    await page.goto("/");

    const map = page.locator(".leaflet-container");
    await expect(map).toBeVisible();
    const box = await map.boundingBox();
    if (!box) throw new Error("map container has no bounding box");

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const sidebar = page.locator("body");
    await expect(sidebar).toContainText(/\d+ W\/m² solar/, { timeout: 20_000 });
    await expect(sidebar).toContainText(/\d+% cloud/, { timeout: 5_000 });
});
