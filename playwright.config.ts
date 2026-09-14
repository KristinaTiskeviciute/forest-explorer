import { defineConfig, devices } from "@playwright/test";

const PORT = 5180;

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    // These tests hit the real network (thredds.met.no, Frost, Yr) by design —
    // that's the whole point (see e2e/thredds-weather-data.spec.ts's header
    // comment). Retry once for genuine upstream flakiness before failing.
    retries: 1,
    timeout: 60_000,
    reporter: "list",
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: "retain-on-failure",
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: `npm run dev -- --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
