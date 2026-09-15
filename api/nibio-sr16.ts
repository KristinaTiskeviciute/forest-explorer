import type { VercelRequest, VercelResponse } from "@vercel/node";
import { proxyToUpstream } from "./_lib/passthroughProxy.js";

/** SR16 tree-species/crown-cover WMS — see vite.config.ts's
 *  /api/nibio-sr16 dev-proxy rule for the equivalent dev-time behavior. */
export default function handler(req: VercelRequest, res: VercelResponse) {
    return proxyToUpstream(req, res, "https://wms.nibio.no/cgi-bin/sr16", "/api/nibio-sr16");
}
