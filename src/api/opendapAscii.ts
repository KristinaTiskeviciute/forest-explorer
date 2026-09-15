// Shared OPeNDAP `.ascii` response parsing — generic across any THREDDS
// dataset (seNorge, met_analysis, ...), not tied to a particular grid or
// projection. OPeNDAP's `.ascii` format is plain text, so no binary DAP2
// decoding is needed:
//   varname.varname[T][R][C]
//   [0][0], v00, v01, ...
//   [0][1], v10, v11, ...
//   (blank line)

export type GridIndexBounds = { xi0: number; xi1: number; yi0: number; yi1: number };

/**
 * OPeNDAP array-slice constraint expressions (`var[0:1:0][657:1:683]`) use
 * literal `[`/`]` — but thredds.met.no's Tomcat rejects raw brackets in the
 * request target with a 400 ("Invalid character found in the request
 * target"), confirmed live against both the proxy and the upstream host
 * directly. Percent-encoding just the brackets (not the colons/commas
 * OPeNDAP needs literally) fixes this. This bug predates and is independent
 * of the thredds.met.no CORS issue — CORS blocked the browser from ever
 * seeing this 400, so it went unnoticed until the CORS fix (routing through
 * a same-origin proxy) exposed it.
 */
export function encodeOpendapSlice(expr: string): string {
    return expr.replace(/\[/g, "%5B").replace(/\]/g, "%5D");
}

/**
 * Builds a same-origin request to the thredds relay (server/threddsProxy.ts
 * locally, api/thredds.ts on Vercel) from a proxy-prefixed dataset path
 * (e.g. "/api/thredds/dodsC/senorge/seNorge_2018/Latest/seNorge2018_20260101.nc.ascii")
 * and an OPeNDAP constraint expression. Wraps the whole constraint as the
 * value of one well-formed query parameter (`q`) instead of appending it
 * directly as a bare, non-standard query string — that bare format (no
 * `=`/`&`, using `:`/`,`/`[`/`]` as its own structural syntax) doesn't
 * survive being re-parsed/re-serialized anywhere in the request path.
 * Confirmed live in production: an earlier relay design re-encoded the
 * expression's raw `:`/`,` while merging in a path parameter, and
 * thredds.met.no's OPeNDAP server doesn't decode them back before parsing
 * the constraint syntax — the subset request silently fell back to
 * returning the entire variable instead of a slice (a few-KB request became
 * 233MB). Wrapping it as one normal parameter value means it only ever
 * passes through as opaque text end to end, immune to that class of bug.
 */
export function buildThreddsUrl(proxiedPath: string, constraintQuery: string): string {
    const datasetPath = proxiedPath.replace(/^\/api\/thredds\//, "");
    return `/api/thredds?path=${encodeURIComponent(datasetPath)}&q=${encodeURIComponent(constraintQuery)}`;
}

/** A decoded 2D grid slice, indexed [row][col] matching [yi0..yi1][xi0..xi1]. */
export type DecodedGrid = { bounds: GridIndexBounds; values: number[][] };

/**
 * Parses one `rows`-line 2D block starting at `startPos` (the position right
 * after the header line). Returns the parsed values and the position right
 * after the block, so callers with multiple consecutive blocks (e.g. one per
 * time step) can keep parsing forward from `endPos`.
 */
export function parseGridBlock(
    text: string,
    startPos: number,
    rows: number,
    cols: number,
): { values: number[][] | null; endPos: number } {
    const values: number[][] = [];
    let pos = startPos;

    for (let r = 0; r < rows; r++) {
        const lineEnd = text.indexOf("\n", pos);
        const line = (lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd)).trim();
        if (!line) return { values: values.length ? values : null, endPos: pos };
        // Line looks like: "[0][3], 1.2, 3.4, 5.6, ..."
        const commaIdx = line.indexOf("],");
        const rest = commaIdx === -1 ? line : line.slice(commaIdx + 2);
        const row = rest
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map(Number);
        if (row.length !== cols) return { values: null, endPos: pos };
        values.push(row);
        pos = lineEnd === -1 ? text.length : lineEnd + 1;
    }
    return { values, endPos: pos };
}

/** Locates `varname.varname[` header line's start, or null if absent. */
export function findGridHeader(text: string, varName: string): number | null {
    const headerRe = new RegExp(`^${varName}\\.${varName}\\[`, "m");
    const match = headerRe.exec(text);
    return match ? match.index : null;
}

/** Parses a single (already time-sliced) 2D block for one variable. */
export function parseAsciiGrid(text: string, varName: string, bounds: GridIndexBounds): number[][] | null {
    const headerPos = findGridHeader(text, varName);
    if (headerPos === null) return null;

    const rows = bounds.yi1 - bounds.yi0 + 1;
    const cols = bounds.xi1 - bounds.xi0 + 1;
    const bodyStart = text.indexOf("\n", headerPos) + 1;
    return parseGridBlock(text, bodyStart, rows, cols).values;
}

/** Masked/no-data grid cells (e.g. snow depth over most of Norway in
 *  summer) come back from OPeNDAP as the literal text "NaN" — confirmed
 *  live (702 such tokens in one snow-grid bbox in July). `Number("NaN")`
 *  parses cleanly to the numeric NaN rather than throwing, so it silently
 *  passes every `!== undefined`/`!== null` check downstream unless caught
 *  here at the shared read boundary — every consumer (seNorge rain/temp/
 *  snow, met_analysis humidity/wind) goes through this one function. */
export function readGridValue(grid: DecodedGrid, xi: number, yi: number): number | undefined {
    const row = yi - grid.bounds.yi0;
    const col = xi - grid.bounds.xi0;
    if (row < 0 || row >= grid.values.length || col < 0 || col >= (grid.values[0]?.length ?? 0)) return undefined;
    const value = grid.values[row][col];
    return Number.isFinite(value) ? value : undefined;
}
