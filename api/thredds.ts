import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleThreddsRequest } from "../server/threddsProxy.js";

/** thredds.met.no OPeNDAP relay — see server/threddsProxy.ts's
 *  handleThreddsRequest for the shared logic also used by the Vite
 *  dev-server proxy, and for why this is a plain flat route (path/q as
 *  ordinary query parameters) rather than a dynamic catch-all route. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.searchParams.get("path");
    const q = url.searchParams.get("q");
    if (!path || q === null) {
        res.status(400).json({ error: "path and q query params required" });
        return;
    }

    const result = await handleThreddsRequest(path, q);
    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.send(result.body);
}
