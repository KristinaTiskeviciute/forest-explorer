import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        // e2e/ is Playwright-only — vitest must never try to collect those files.
        exclude: ["e2e/**", "node_modules/**"],
    },
});
