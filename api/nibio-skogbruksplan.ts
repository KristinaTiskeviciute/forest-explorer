import type { VercelRequest, VercelResponse } from "@vercel/node";
import { proxyToUpstream } from "./_lib/passthroughProxy";

/** Hogstklasse (stand-age) WMS — see vite.config.ts's
 *  /api/nibio-skogbruksplan dev-proxy rule for the equivalent dev-time behavior. */
export default function handler(req: VercelRequest, res: VercelResponse) {
    return proxyToUpstream(req, res, "https://wms.nibio.no/cgi-bin/skogbruksplan", "/api/nibio-skogbruksplan");
}
