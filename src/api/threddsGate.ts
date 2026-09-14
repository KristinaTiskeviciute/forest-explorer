// met.no's THREDDS catalog page explicitly asks not to spawn multiple
// parallel OPeNDAP sessions. senorgeNetcdf.ts and metAnalysisApi.ts each
// respect that internally (mapPool concurrency 2), but loadGridData.ts runs
// them *alongside* each other via Promise.all — so a single area load could
// open up to 4 simultaneous sessions against the same host, not the 2 either
// file's own limit implied. This gate is shared across both so the real
// ceiling matches what's actually promised to met.no, regardless of how many
// independent callers there are.
const MAX_CONCURRENT_SESSIONS = 2;

let active = 0;
const queue: Array<() => void> = [];

function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
}

export function threddsGate<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const run = () => {
            active++;
            fn().then(
                (v) => {
                    release();
                    resolve(v);
                },
                (e) => {
                    release();
                    reject(e);
                },
            );
        };
        if (active < MAX_CONCURRENT_SESSIONS) run();
        else queue.push(run);
    });
}
