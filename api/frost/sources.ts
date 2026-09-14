import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleFrostRoute } from "../../server/frostProxy";

/** Nearest-station lookup — see server/frostProxy.ts's handleFrostRoute for
 *  the shared logic also used by the Vite dev-server proxy. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const result = await handleFrostRoute("sources", url.searchParams, process.env.FROST_CLIENT_ID);

    res.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    res.send(result.body);
}
