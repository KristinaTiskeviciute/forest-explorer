import { useEffect, useSyncExternalStore } from "react";
import type { GridPoint, TerrainDebugData } from "../../lib/grid/types";
import { MIN_MAPBOX_ZOOM } from "../../lib/terrain/types";
import { useLayers } from "../../lib/layers/layerStore";
import { fetchLog } from "../../lib/debug/fetchLog";
import { tileCache } from "../../lib/terrain/tileCache";

export function DebugPanel({
    zoom,
    selectedBreakdown,
    selectedElevation,
    terrainDebug,
}: {
    zoom: number;
    selectedBreakdown?: GridPoint["debug"];
    selectedElevation?: number;
    terrainDebug: TerrainDebugData;
}) {
    const {
        debugMode,
        setDebugMode,
        debugLayers,
        setDebugLayer,
        dryRun,
        setDryRun,
        tileBudget,
        setTileBudget,
        dataSources,
    } = useLayers();

    const events = useSyncExternalStore(fetchLog.subscribe, fetchLog.getEvents, fetchLog.getEvents);
    const stats = useSyncExternalStore(fetchLog.subscribe, fetchLog.getStats, fetchLog.getStats);

    const terrainGridOn = dataSources.terrain.grid;

    useEffect(() => {
        if (!debugMode) return;

        const id = setTimeout(() => {
            const fetchLogLines = events.slice(0, 20).map(formatEvent);
            const panel = {
                zoom,
                dryRun,
                tileBudget,
                debugLayers,
                dataSources,
                stats: {
                    mapboxTilesFetched: stats.mapboxTilesFetched,
                    mapboxTileBudget: stats.mapboxTileBudget,
                    mapboxTilesSkipped: stats.mapboxTilesSkipped,
                    yrRequests: stats.yrRequests,
                    yrCacheHits: stats.yrCacheHits,
                    nibioRequests: stats.nibioRequests,
                    nibioCacheHits: stats.nibioCacheHits,
                    tilesCached: tileCache.size,
                },
                scoreBreakdown: selectedBreakdown ?? null,
                elevation: selectedElevation ?? null,
                fetchLog: fetchLogLines,
            };

            console.groupCollapsed("[Forest Explorer Debug]");
            console.log("panel", panel);
            console.log("fetch log (latest first)");
            fetchLogLines.forEach((line) => console.log(line));
            if (selectedBreakdown) {
                console.log("score breakdown (clicked point)", selectedBreakdown);
            }
            console.groupEnd();
        }, 200);

        return () => clearTimeout(id);
    }, [
        debugMode,
        zoom,
        dryRun,
        tileBudget,
        debugLayers,
        dataSources,
        stats,
        events,
        selectedBreakdown,
        selectedElevation,
    ]);

    if (!debugMode) {
        return (
            <button
                type="button"
                onClick={() => setDebugMode(true)}
                className="fe-btn"
                style={{
                    position: "fixed",
                    bottom: 12,
                    left: 12,
                    zIndex: 10000,
                    pointerEvents: "auto",
                }}
            >
                Debug (D)
            </button>
        );
    }

    return (
        <div
            style={{
                position: "fixed",
                bottom: 0,
                left: 0,
                right: 320,
                maxHeight: "40vh",
                overflow: "auto",
                background: "rgba(20,20,20,0.92)",
                color: "#eee",
                fontSize: 11,
                padding: 12,
                zIndex: 10000,
                fontFamily: "monospace",
                pointerEvents: "auto",
                userSelect: "text",
                borderTopLeftRadius: 10,
                borderTopRightRadius: 10,
                boxShadow: "0 -2px 10px rgba(0,0,0,0.3)",
            }}
        >
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
                <strong>Debug mode</strong>
                <span style={{ color: "#9cf" }}>zoom {zoom.toFixed(2)}</span>
                {zoom >= MIN_MAPBOX_ZOOM ? (
                    <span style={{ color: "#9cf" }}>Mapbox terrain z{MIN_MAPBOX_ZOOM}+</span>
                ) : (
                    <span style={{ color: "#888" }}>Mapbox off (need z{MIN_MAPBOX_ZOOM})</span>
                )}
                {dryRun && zoom >= MIN_MAPBOX_ZOOM && (
                    <span style={{ color: "#f96" }}>tiles blocked (dry run)</span>
                )}
                {dryRun && <span style={{ color: "#ff6" }}>DRY RUN</span>}
                <button
                    type="button"
                    onClick={() => setDebugMode(false)}
                    style={{
                        marginLeft: "auto",
                        fontSize: 11,
                        padding: "3px 10px",
                        borderRadius: 4,
                        background: "rgba(255,255,255,0.12)",
                        border: "1px solid rgba(255,255,255,0.2)",
                        color: "#eee",
                        cursor: "pointer",
                    }}
                >
                    Close
                </button>
            </div>

            <label style={{ marginRight: 12 }}>
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                Dry run (no network)
            </label>
            <label>
                Tile budget:{" "}
                <input
                    type="number"
                    value={tileBudget}
                    min={0}
                    max={500}
                    onChange={(e) => setTileBudget(Number(e.target.value))}
                    style={{ width: 50 }}
                />
            </label>

            <div style={{ marginTop: 8 }}>
                Debug overlays:{" "}
                {(Object.keys(debugLayers) as Array<keyof typeof debugLayers>).map((k) => (
                    <label key={k} style={{ marginRight: 10 }}>
                        <input
                            type="checkbox"
                            checked={debugLayers[k]}
                            onChange={(e) => setDebugLayer(k, e.target.checked)}
                        />
                        {k}
                    </label>
                ))}
            </div>

            {terrainGridOn && (
                <div style={{ marginTop: 6, color: "#9cf" }}>
                    Terrain grid: {terrainDebug.samples.length} Mapbox samples / {terrainDebug.targets.length}{" "}
                    targets
                    {zoom < MIN_MAPBOX_ZOOM && " — zoom to z15+ to sample"}
                    {terrainDebug.targets.length > 0 &&
                        terrainDebug.samples.length === 0 &&
                        zoom >= MIN_MAPBOX_ZOOM && (
                            <span style={{ color: "#f96" }}> — no Mapbox data (dry-run or tile skip?)</span>
                        )}
                </div>
            )}

            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                Mapbox: {stats.mapboxTilesFetched}/{stats.mapboxTileBudget} fetched | skipped{" "}
                {stats.mapboxTilesSkipped}
                {stats.mapboxTilesFetched >= stats.mapboxTileBudget && (
                    <span style={{ color: "#f96" }}>budget exhausted</span>
                )}
                <button
                    type="button"
                    onClick={() => fetchLog.resetMapboxBudget()}
                    style={{ fontSize: 10 }}
                >
                    Reset Mapbox budget
                </button>
                {" | "}yr: {stats.yrRequests} req / {stats.yrCacheHits} cache | nibio:{" "}
                {stats.nibioRequests} req / {stats.nibioCacheHits} cache | frost: {stats.frostRequests} req /{" "}
                {stats.frostCacheHits} cache / {stats.frostFallbacks} fallback | senorge: {stats.senorgeRequests} req /{" "}
                {stats.senorgeFallbacks} fallback | met_analysis: {stats.metAnalysisRequests} req /{" "}
                <span style={{ color: stats.metAnalysisFallbacks > 0 ? "#f96" : undefined }}>
                    {stats.metAnalysisFallbacks} fallback
                </span>{" "}
                (solar/cloud have no further fallback — a fallback here means they're missing entirely) | tiles
                cached: {tileCache.size}
            </div>

            {selectedBreakdown && (
                <div style={{ marginTop: 8, padding: 8, background: "#333" }}>
                    <div>Score breakdown (clicked point)</div>
                    {selectedElevation !== undefined && (
                        <div>elevation={selectedElevation.toFixed(0)} m</div>
                    )}
                    <div>
                        weather={selectedBreakdown.weather.toFixed(2)} rainfall=
                        {selectedBreakdown.rainfall.toFixed(2)} forest={selectedBreakdown.forest.toFixed(2)}{" "}
                        terrain={selectedBreakdown.terrain?.toFixed(2) ?? "n/a"} → composite=
                        {selectedBreakdown.composite.toFixed(2)}
                    </div>
                    {selectedBreakdown.inputs.slope !== undefined && (
                        <div>
                            slope={selectedBreakdown.inputs.slope.toFixed(3)} aspect=
                            {selectedBreakdown.inputs.aspect?.toFixed(0)}°
                        </div>
                    )}
                    <div>
                        weights: W{(selectedBreakdown.weights.weather * 100).toFixed(0)}% R
                        {(selectedBreakdown.weights.rainfall * 100).toFixed(0)}% F
                        {(selectedBreakdown.weights.forest * 100).toFixed(0)}% T
                        {(selectedBreakdown.weights.terrain * 100).toFixed(0)}%
                    </div>
                </div>
            )}

            <div style={{ marginTop: 8 }}>
                <div>Fetch log (latest first)</div>
                {events.slice(0, 20).map((e) => (
                    <div key={e.id} style={{ color: "#aaa" }}>
                        {formatEvent(e)}
                    </div>
                ))}
            </div>
        </div>
    );
}

function formatEvent(e: ReturnType<typeof fetchLog.getEvents>[0]): string {
    if (e.type === "tile") {
        const tag = e.skipped ? `SKIP (${e.reason})` : e.hit ? "HIT" : "MISS";
        return `[tile] ${tag} z${e.z}/${e.x}/${e.y}`;
    }
    if (e.type === "grid") {
        const terrain =
            e.terrainMatched !== undefined ? `, ${e.terrainMatched} w/ terrain` : "";
        const z = e.mapZoom !== undefined ? `z${e.mapZoom} ` : "";
        const err = e.error ? ` ERROR: ${e.error}` : "";
        return `[grid] ${z}${e.points} pts (${e.land} land, ${e.water} water)${terrain} ${e.ms}ms${err}`;
    }
    return `[${e.type}] ${e.hit ? "HIT" : "MISS"} ${e.lat.toFixed(3)},${e.lon.toFixed(3)} ${e.ms}ms${e.error ? ` (${e.error})` : ""}`;
}
