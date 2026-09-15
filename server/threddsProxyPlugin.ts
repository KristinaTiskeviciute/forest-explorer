import type { Plugin } from "vite";
import { createThreddsProxyMiddleware } from "./threddsProxy";

export function threddsProxyPlugin(): Plugin {
    const middleware = createThreddsProxyMiddleware();

    const attach = (server: { middlewares: { use: (path: string, handler: typeof middleware) => void } }) => {
        server.middlewares.use("/api/thredds", middleware);
    };

    return {
        name: "forest-explorer-thredds-proxy",
        configureServer: attach,
        configurePreviewServer: attach,
    };
}
