import type { VercelRequest, VercelResponse } from "@vercel/node";
import { proxyToUpstream } from "./_lib/passthroughProxy.js";

/** AR5 Arealtype WMS — see vite.config.ts's /api/nibio dev-proxy rule for
 *  the equivalent dev-time behavior. */
export default function handler(req: VercelRequest, res: VercelResponse) {
    return proxyToUpstream(req, res, "https://wms.nibio.no/cgi-bin/ar5", "/api/nibio");
}
