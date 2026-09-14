import { MapContainer, TileLayer, WMSTileLayer, Marker, Popup, Circle, CircleMarker, Tooltip, useMapEvents, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useState, useCallback, useEffect, useMemo } from "react";
import DataSourceLayers from "./DataSourceLayers";
import { GridPointLoader } from "./GridPointLoader";
import { DebugPanel } from "./DebugPanel";
import { DebugOverlays } from "./DebugOverlays";
import { ProtectedAreaOverlay } from "./ProtectedAreaOverlay";
import { emptyGrid, type GridPoint, type LoadGridResult, type LoadStage, type TerrainDebugData } from "../../lib/grid/types";
import { getNorwayBounds } from "../../lib/water/waterExclusion";
import { gridStepForBounds, findNearestGridPoint, coordKey } from "../../lib/terrain/types";
import { useLayers } from "../../lib/layers/layerStore";
import { compositeScore } from "../../lib/scoring/compositeScore";

const center: LatLngExpression = [58.998287, 10.035595];
const norwayBounds = getNorwayBounds();

const LOAD_STAGES: readonly LoadStage[] = ["terrain", "forest", "weather", "historical"];
const STAGE_LABELS: Record<LoadStage, string> = {
    terrain: "Reading terrain…",
    forest: "Checking forest cover…",
    weather: "Fetching weather…",
    historical: "Refining with historical data…",
};

type Props = {
    onSelectLocation: (lat: number, lon: number, zoom: number, point?: GridPoint) => void;
    onAnalysisActiveChange: (active: boolean) => void;
    /** Fires on every zoom change, not just clicks, so a selected location's zoom stays live */
    onLiveZoomChange?: (zoom: number) => void;
    /** Radius in km around the clicked point to sample — set on the side panel */
    radiusKm: number;
};

function MapContents({
    onSelectLocation,
    onSelectPoint,
    onZoomChange,
    onTerrainDebugLoaded,
    onAnalysisActiveChange,
    radiusKm,
}: Props & {
    onSelectPoint: (point: GridPoint | null) => void;
    onZoomChange: (zoom: number) => void;
    onTerrainDebugLoaded: (data: TerrainDebugData) => void;
}) {
    const [markerPos, setMarkerPos] = useState<LatLngExpression | null>(null);
    const [anchor, setAnchor] = useState<{ lat: number; lon: number } | null>(null);
    const [analysisActive, setAnalysisActive] = useState(false);
    const [loadVersion, setLoadVersion] = useState(0);
    const [gridData, setGridData] = useState<LoadGridResult>(emptyGrid);
    const [gridLoading, setGridLoading] = useState(false);
    const [loadStage, setLoadStage] = useState<LoadStage>("terrain");
    const map = useMap();
    const { foragingTarget } = useLayers();

    // Changing the foraging target only re-weights forest-type scoring — it
    // doesn't need any new network fetch, since every already-loaded point's
    // debug.inputs already has the raw forecast/historical/forestClass/
    // slope/aspect it was scored from. Recompute locally instead of
    // reloading (the initial load itself still gets the current target via
    // GridPointLoader → loadGridData, this only handles later changes).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberately recomputing derived scores when foragingTarget changes, not new data from an external system
        setGridData((prev) => {
            if (!prev.points.length) return prev;
            const zoom = map.getZoom();
            const points = prev.points.map((p) => {
                if (!p.debug) return p;
                const { forecast, conditions, forestClass, slope, aspect } = p.debug.inputs;
                const breakdown = compositeScore({ zoom, forecast, conditions, forestClass, slope, aspect, foragingTarget });
                return {
                    ...p,
                    scores: {
                        composite: breakdown.composite,
                        weather: breakdown.weather,
                        rainfall: breakdown.rainfall,
                        forest: breakdown.forest,
                        terrain: breakdown.terrain,
                    },
                    debug: breakdown,
                };
            });
            return { ...prev, points };
        });
    }, [foragingTarget, map]);

    const updateZoom = useCallback(
        (z: number) => onZoomChange(z),
        [onZoomChange],
    );

    useEffect(() => {
        updateZoom(map.getZoom());
    }, [map, updateZoom]);

    useEffect(() => {
        onAnalysisActiveChange(analysisActive);
    }, [analysisActive, onAnalysisActiveChange]);

    useMapEvents({
        click: (e) => {
            const { lat, lng } = e.latlng;
            const z = e.target.getZoom();
            setMarkerPos([lat, lng]);
            setAnchor({ lat, lon: lng });
            setAnalysisActive(true);
            setLoadVersion((v) => v + 1);
            const matchDist = gridStepForBounds(e.target.getBounds(), z) * 1.5;
            const nearest = findNearestGridPoint(gridData.points, lat, lng, matchDist);
            onSelectPoint(nearest);
            onSelectLocation(lat, lng, z, nearest ?? undefined);
        },
        moveend: (e) => updateZoom(e.target.getZoom()),
        zoomend: (e) => updateZoom(e.target.getZoom()),
    });

    const handleLoaded = useCallback(
        (result: LoadGridResult) => {
            setGridData(result);
            onTerrainDebugLoaded(result.terrainDebug);
        },
        [onTerrainDebugLoaded],
    );

    // Merging a partial (checkpoint-A) result into state is exactly the same
    // operation as merging the final one — DataSourceLayers reactively
    // rebuilds from gridData.points/gridStep/terrainDebug either way, so the
    // heatmap just fills in, then refines again when the final result lands.
    const handlePartialResult = useCallback(
        (result: LoadGridResult) => {
            setGridData(result);
            onTerrainDebugLoaded(result.terrainDebug);
        },
        [onTerrainDebugLoaded],
    );

    // Resets the stepper back to "terrain" the instant a new load starts,
    // independent of how soon loadGridData's own first onProgress call
    // actually arrives.
    const handleLoadingChange = useCallback((loading: boolean) => {
        setGridLoading(loading);
        if (loading) setLoadStage("terrain");
    }, []);

    // Unique real weather stations actually backing points in the current
    // view — free to derive (already fetched, just carried on each point's
    // historical data) rather than a new request for station locations.
    const activeStations = useMemo(() => {
        const byId = new Map<string, { stationId: string; lat: number; lon: number; name: string; distanceKm: number }>();
        for (const p of gridData.points) {
            const h = p.historical;
            if (!h) continue;
            if (!byId.has(h.stationId)) {
                byId.set(h.stationId, {
                    stationId: h.stationId,
                    lat: h.stationLat,
                    lon: h.stationLon,
                    name: h.stationName,
                    distanceKm: h.distanceKm,
                });
            }
        }
        return [...byId.values()];
    }, [gridData.points]);

    // The N best-scoring points by composite score, N = the current radius
    // in km (a 6km radius highlights the top 6) — plus any points tied with
    // the Nth-place score, so a tie at the cutoff never arbitrarily drops one
    // of the tied points. Recomputes whenever gridData changes, which
    // already includes the foraging-target re-score effect above, so this
    // re-ranks live when the target changes with no extra wiring needed.
    const topSpotKeys = useMemo(() => {
        if (!gridData.points.length) return new Set<string>();
        const n = Math.min(Math.max(0, Math.round(radiusKm)), gridData.points.length);
        if (n === 0) return new Set<string>();
        const sorted = [...gridData.points].sort((a, b) => b.scores.composite - a.scores.composite);
        const cutoffScore = sorted[n - 1].scores.composite;
        return new Set(
            sorted.filter((p) => p.scores.composite >= cutoffScore).map((p) => coordKey(p.lat, p.lon)),
        );
    }, [gridData.points, radiusKm]);

    return (
        <>
            <GridPointLoader
                active={analysisActive}
                anchor={anchor}
                radiusKm={radiusKm}
                loadVersion={loadVersion}
                onLoaded={handleLoaded}
                onLoadingChange={handleLoadingChange}
                onPartialResult={handlePartialResult}
                onProgress={setLoadStage}
            />
            <DataSourceLayers
                points={gridData.points}
                terrainDebug={gridData.terrainDebug}
                active={analysisActive}
                gridStep={gridData.gridStep}
                topSpotKeys={topSpotKeys}
            />
            {analysisActive && <ProtectedAreaOverlay key={loadVersion} areas={gridData.protectedAreas} />}
            <DebugOverlays />
            {markerPos && (
                <Marker position={markerPos}>
                    <Popup>Selected location</Popup>
                </Marker>
            )}
            {anchor && (
                <Circle
                    center={[anchor.lat, anchor.lon]}
                    radius={radiusKm * 1000}
                    pathOptions={{ color: "#3388ff", weight: 1, dashArray: "4 4", fillOpacity: 0.02 }}
                />
            )}
            {activeStations.map((s) => (
                <CircleMarker
                    key={s.stationId}
                    center={[s.lat, s.lon]}
                    radius={6}
                    pathOptions={{ color: "#059669", weight: 2, fillColor: "#34d399", fillOpacity: 0.9 }}
                >
                    <Tooltip>
                        {s.name} · {s.distanceKm.toFixed(1)}km away
                    </Tooltip>
                </CircleMarker>
            ))}
            {gridLoading && (
                <div
                    style={{
                        position: "absolute",
                        top: 12,
                        left: "50%",
                        transform: "translateX(-50%)",
                        zIndex: 1000,
                        background: "rgba(255,255,255,0.9)",
                        padding: "6px 14px",
                        borderRadius: 20,
                        boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <style>{"@keyframes forest-explorer-spin { to { transform: rotate(360deg); } }"}</style>
                    <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {LOAD_STAGES.map((stage, i) => {
                            const stageIndex = LOAD_STAGES.indexOf(loadStage);
                            if (i < stageIndex) {
                                // Completed stage — solid filled dot.
                                return (
                                    <span
                                        key={stage}
                                        style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: "50%",
                                            background: "#3388ff",
                                            display: "inline-block",
                                        }}
                                    />
                                );
                            }
                            if (i === stageIndex) {
                                // Active stage — small spinner.
                                return (
                                    <span
                                        key={stage}
                                        style={{
                                            width: 8,
                                            height: 8,
                                            border: "2px solid #ccc",
                                            borderTopColor: "#3388ff",
                                            borderRadius: "50%",
                                            display: "inline-block",
                                            animation: "forest-explorer-spin 0.8s linear infinite",
                                        }}
                                    />
                                );
                            }
                            // Upcoming stage — dim outline dot.
                            return (
                                <span
                                    key={stage}
                                    style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: "50%",
                                        border: "1px solid #ccc",
                                        display: "inline-block",
                                    }}
                                />
                            );
                        })}
                    </span>
                    {STAGE_LABELS[loadStage]}
                    {loadStage === "historical" && (
                        <span style={{ color: "#3388ff" }}>· refining</span>
                    )}
                </div>
            )}
        </>
    );
}

export default function MapView({ onSelectLocation, onAnalysisActiveChange, onLiveZoomChange, radiusKm }: Props) {
    const { referenceOverlays } = useLayers();
    const [selectedBreakdown, setSelectedBreakdown] = useState<GridPoint["debug"]>();
    const [selectedElevation, setSelectedElevation] = useState<number | undefined>();
    const [mapZoom, setMapZoom] = useState(13);
    const [terrainDebug, setTerrainDebug] = useState<TerrainDebugData>({ samples: [], targets: [] });

    const handleZoomChange = useCallback(
        (z: number) => {
            setMapZoom(z);
            onLiveZoomChange?.(z);
        },
        [onLiveZoomChange],
    );

    return (
        <>
            <MapContainer
                center={center}
                zoom={13}
                minZoom={8}
                maxZoom={17}
                maxBounds={norwayBounds}
                maxBoundsViscosity={0.85}
                scrollWheelZoom={true}
                style={{ height: "100vh", width: "100%" }}
            >
                <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution="© OpenStreetMap contributors"
                />
                {referenceOverlays.hogstklasser && (
                    <WMSTileLayer
                        url="/api/nibio-skogbruksplan"
                        params={{ layers: "hogstklasser", format: "image/png", transparent: true }}
                        version="1.3.0"
                        opacity={0.6}
                    />
                )}
                {referenceOverlays.crownCover && (
                    <WMSTileLayer
                        url="/api/nibio-sr16"
                        params={{ layers: "SRRKRONEDEK", format: "image/png", transparent: true }}
                        version="1.3.0"
                        opacity={0.6}
                    />
                )}
                {referenceOverlays.recentCutSatellite && (
                    <WMSTileLayer
                        url="https://image001.miljodirektoratet.no/arcgis/services/naturskog/naturskog_v1/MapServer/WMSServer"
                        params={{ layers: "stoettelag_hogst_satelitt", format: "image/png", transparent: true }}
                        version="1.3.0"
                        opacity={0.75}
                    />
                )}
                <MapContents
                    onSelectLocation={onSelectLocation}
                    onAnalysisActiveChange={onAnalysisActiveChange}
                    radiusKm={radiusKm}
                    onSelectPoint={(point) => {
                        setSelectedBreakdown(point?.debug);
                        setSelectedElevation(point?.elevation);
                    }}
                    onZoomChange={handleZoomChange}
                    onTerrainDebugLoaded={setTerrainDebug}
                />
            </MapContainer>
            <DebugPanel
                zoom={mapZoom}
                selectedBreakdown={selectedBreakdown}
                selectedElevation={selectedElevation}
                terrainDebug={terrainDebug}
            />
        </>
    );
}
