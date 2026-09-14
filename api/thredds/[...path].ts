import type { VercelRequest, VercelResponse } from "@vercel/node";
import { proxyToUpstream } from "../_lib/passthroughProxy";

/** thredds.met.no OPeNDAP relay (senorge/met_analysis NetCDF queries) — see
 *  vite.config.ts's /api/thredds dev-proxy rule for the equivalent dev-time
 *  behavior. Catch-all since real queries have variable path depth, e.g.
 *  /api/thredds/dodsC/senorge/seNorge_2018/Latest/seNorge2018_2026.nc.ascii. */
export default function handler(req: VercelRequest, res: VercelResponse) {
    return proxyToUpstream(req, res, "https://thredds.met.no/thredds", "/api/thredds");
}
