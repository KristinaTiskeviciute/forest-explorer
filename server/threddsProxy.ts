import type { Connect } from "vite";

const THREDDS_BASE = "https://thredds.met.no/thredds";

export type ThreddsResult = { status: number; headers: Record<string, string>; body: Buffer };

/**
 * Relays a same-origin /api/thredds request to thredds.met.no, reconstructing
 * the real upstream OPeNDAP URL from two well-formed query parameters
 * (`path`, `q`) instead of forwarding a bare, non-standard query string
 * straight through — see buildThreddsUrl in src/api/opendapAscii.ts for why:
 * OPeNDAP's constraint-expression syntax (`var[0:1:0]`, comma-separated, no
 * `=`/`&`) doesn't survive being re-parsed/re-serialized anywhere in a
 * request path. Confirmed live in production: an earlier version of this
 * relay (a dynamic catch-all route + a vercel.json rewrite) re-encoded the
 * expression's raw `:`/`,` characters while merging in a path parameter,
 * and thredds.met.no's OPeNDAP server doesn't decode them back before
 * parsing the constraint syntax — the subset request silently fell back to
 * returning the entire variable instead of a slice (a few-KB request became
 * 233MB). Wrapping the whole expression as the value of one normal query
 * parameter means it only ever passes through as opaque text end to end.
 *
 * Framework-agnostic (plain data in, plain data out) so both the Vite
 * dev-server middleware below and the Vercel serverless function
 * (api/thredds.ts) share this without duplicating the fetch/error handling.
 */
export async function handleThreddsRequest(datasetPath: string, constraintQuery: string): Promise<ThreddsResult> {
    const upstreamUrl = `${THREDDS_BASE}/${datasetPath}?${constraintQuery}`;

    try {
        const upstream = await fetch(upstreamUrl);
        const buffer = Buffer.from(await upstream.arrayBuffer());
        const headers: Record<string, string> = {};
        const contentType = upstream.headers.get("content-type");
        if (contentType) headers["Content-Type"] = contentType;
        return { status: upstream.status, headers, body: buffer };
    } catch (err) {
        return {
            status: 502,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify({ error: err instanceof Error ? err.message : "upstream fetch failed" })),
        };
    }
}

/** Vite dev/preview middleware wrapper — reads path/q from the (already
 *  mount-prefix-stripped, see threddsProxyPlugin.ts) request URL and writes
 *  handleThreddsRequest's result to the raw Node response. */
export function createThreddsProxyMiddleware(): Connect.NextHandleFunction {
    return async (req, res, next) => {
        if (req.method !== "GET") {
            next();
            return;
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.searchParams.get("path");
        const q = url.searchParams.get("q");
        if (!path || q === null) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "path and q query params required" }));
            return;
        }

        const result = await handleThreddsRequest(path, q);
        res.statusCode = result.status;
        for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
        res.end(result.body);
    };
}
