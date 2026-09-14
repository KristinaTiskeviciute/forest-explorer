import type { Plugin } from "vite";
import { createYrProxyMiddleware } from "./yrProxy";

export function yrProxyPlugin(): Plugin {
    const middleware = createYrProxyMiddleware();

    const attach = (server: { middlewares: { use: (path: string, handler: typeof middleware) => void } }) => {
        server.middlewares.use("/api/yr", middleware);
    };

    return {
        name: "forest-explorer-yr-proxy",
        configureServer: attach,
        configurePreviewServer: attach,
    };
}
