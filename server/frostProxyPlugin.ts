import type { Plugin } from "vite";
import { createFrostProxyMiddleware } from "./frostProxy";

export function frostProxyPlugin(clientId: string | undefined): Plugin {
    const middleware = createFrostProxyMiddleware(clientId);

    const attach = (server: { middlewares: { use: (path: string, handler: typeof middleware) => void } }) => {
        server.middlewares.use("/api/frost", middleware);
    };

    return {
        name: "forest-explorer-frost-proxy",
        configureServer: attach,
        configurePreviewServer: attach,
    };
}
