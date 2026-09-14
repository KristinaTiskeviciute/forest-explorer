// Every external fetch in this app was previously unbounded — confirmed
// live (via Playwright) that a met.no THREDDS request can hang for over 48
// minutes before the connection finally resets, which meant a single slow
// server response could leave the whole grid load stuck "loading"
// indefinitely with no way to recover short of a page reload. Root cause
// was requests to the same external host piling up across quickly-switched
// areas (switching areas cancels our own bookkeeping, but not the
// already-in-flight fetch itself), hitting a server that explicitly asks
// not to be parallelized. A timeout is a robust backstop regardless of
// *why* a given request hangs — server-side throttling, a real network
// blip, or anything else — so every fetch in the API layer goes through
// this rather than a bare `fetch(url)`.
const DEFAULT_TIMEOUT_MS = 20_000;

export function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
    return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/** Same bounding, for the `new Image()`-based tile/raster loads (Mapbox
 *  terrain-rgb, NIBIO SR16 GetMap) that can't use fetch's AbortSignal directly. */
export function loadImageWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const timer = setTimeout(() => {
            img.onload = null;
            img.onerror = null;
            reject(new Error(`image load timed out after ${timeoutMs}ms: ${url}`));
        }, timeoutMs);
        img.onload = () => {
            clearTimeout(timer);
            resolve(img);
        };
        img.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`image load failed: ${url}`));
        };
        img.src = url;
    });
}
