import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Generic same-origin relay for upstream services that already send
 * permissive CORS headers (NIBIO WMS, thredds.met.no) — proxied anyway so
 * production uses the exact same /api/* paths as the Vite dev-server proxy
 * (vite.config.ts), with no environment-conditional URL logic needed in the
 * client API layer. Forwards bytes as-is (via arrayBuffer/Buffer, not text)
 * since NIBIO's WMS GetMap responses are PNG tiles, not just JSON/XML/HTML —
 * treating them as text would corrupt the image data.
 *
 * `stripPrefix` is the mounted Vercel route's own path (e.g. "/api/nibio"),
 * removed before the remainder + query string is appended to `targetBase`.
 */
export async function proxyToUpstream(
    req: VercelRequest,
    res: VercelResponse,
    targetBase: string,
    stripPrefix: string,
): Promise<void> {
    if (req.method !== "GET") {
        res.status(405).json({ error: "method not allowed" });
        return;
    }

    const incoming = new URL(req.url ?? "/", "http://localhost");
    const remainder = incoming.pathname.startsWith(stripPrefix) ? incoming.pathname.slice(stripPrefix.length) : "";
    const upstreamUrl = `${targetBase}${remainder}${incoming.search}`;

    try {
        const upstream = await fetch(upstreamUrl);
        const buffer = Buffer.from(await upstream.arrayBuffer());

        res.status(upstream.status);
        // Vite's dev-server proxy (vite.config.ts) forwards every upstream
        // header via http-proxy; this only forwards the handful that matter
        // for correct rendering/caching of what these upstreams actually
        // return (WMS tiles, OPeNDAP text) — a known, documented divergence
        // from dev, not an oversight.
        for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
            const value = upstream.headers.get(name);
            if (value) res.setHeader(name, value);
        }
        res.send(buffer);
    } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : "upstream fetch failed" });
    }
}
