import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleYrRequest } from "../server/yrProxy.js";

/** Yr/Locationforecast relay — see server/yrProxy.ts's handleYrRequest for
 *  the shared logic also used by the Vite dev-server proxy. Locationforecast
 *  itself sends permissive CORS headers (confirmed live), so this isn't
 *  strictly required to dodge a CORS block the way Frost/thredds are — kept
 *  anyway so production reuses the same caching/dedup/rate-limiting this
 *  already does in dev, and so the client never needs environment-specific
 *  URLs. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const result = await handleYrRequest(url.searchParams.get("lat") ?? "", url.searchParams.get("lon") ?? "");

    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.send(result.body);
}
