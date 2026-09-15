import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { yrProxyPlugin } from "./server/yrProxyPlugin";
import { frostProxyPlugin } from "./server/frostProxyPlugin";
import { threddsProxyPlugin } from "./server/threddsProxyPlugin";

export default defineConfig(({ mode }) => {
    // Empty prefix so non-VITE_-prefixed secrets (FROST_CLIENT_ID) load too —
    // those must never be exposed client-side the way VITE_-prefixed vars are.
    const env = loadEnv(mode, ".", "");

    return {
        plugins: [react(), yrProxyPlugin(), frostProxyPlugin(env.FROST_CLIENT_ID || undefined), threddsProxyPlugin()],
        server: {
            // Every rule below is a fixed-target relay (the destination host is
            // hardcoded, never derived from the request) to wms.nibio.no /
            // thredds.met.no with no path allowlist, size cap, or rate limit —
            // unlike frostProxy.ts/yrProxy.ts, which are bespoke middleware with
            // their own throttling and caching. That's an acceptable trust
            // boundary for a dev-only server reachable at localhost during
            // `npm run dev`, but this config is not meant to be reused as-is for
            // any deployment reachable beyond localhost — see .env.example's note
            // that production needs "an equivalent proxy" of its own.
            proxy: {
                // /api/nibio-sr16 and /api/nibio-skogbruksplan MUST be registered
                // before /api/nibio — Vite's dev proxy matches by string prefix, and
                // both also start with "/api/nibio", so the more specific rules have
                // to come first or the general one intercepts them (mangling the
                // rewrite into e.g. "/cgi-bin/ar5-sr16", a path that doesn't exist
                // upstream).
                "/api/nibio-sr16": {
                    target: "https://wms.nibio.no",
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api\/nibio-sr16/, "/cgi-bin/sr16"),
                },
                "/api/nibio-skogbruksplan": {
                    target: "https://wms.nibio.no",
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api\/nibio-skogbruksplan/, "/cgi-bin/skogbruksplan"),
                },
                "/api/nibio": {
                    target: "https://wms.nibio.no",
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/api\/nibio/, "/cgi-bin/ar5"),
                },
                // /api/thredds is NOT declared here — thredds.met.no sends no
                // Access-Control-Allow-Origin header on real senorge/met_analysis
                // OPeNDAP queries, so it still needs proxying, but a bare passthrough
                // rule can't correctly forward these non-standard, bracket/comma-
                // structured constraint-expression query strings (see
                // server/threddsProxy.ts for what that broke in production).
                // threddsProxyPlugin() above handles it with real reconstruction logic.
            },
        },
    };
});
