import { useCallback, useMemo, useState } from "react";
import { supportsEmojiSequence } from "../lib/emojiSupport";
import { useQuery } from "@tanstack/react-query";
import Skeleton from "../components/ui/Skeleton";
import { PANEL_CARD_STYLE, PANEL_CARD_TITLE_STYLE } from "../components/ui/panelStyles";
import MapView from "../features/map/MapView";
import { LayerControls } from "../features/map/LayerControls";
import type { GridPoint } from "../lib/grid/types";
import { getYrForecast } from "../api/yrApi";
import { getForestClass } from "../api/nibioApi";
import { getFrostConditions } from "../api/frostApi";
import { getSenorgeConditions } from "../api/senorgeApi";
import { getMetAnalysisLatestAtPoint } from "../api/metAnalysisApi";
import { compositeScore, weightsForZoom } from "../lib/scoring/compositeScore";
import { mergeHistoricalConditions } from "../lib/scoring/historicalConditions";
import { getTerrainAtPoint } from "../lib/terrain/slopeApi";
import { MIN_MAPBOX_ZOOM, gridStepForZoom } from "../lib/terrain/types";
import { useLayers } from "../lib/layers/layerStore";
import { scoreToColor } from "../lib/scoring/scoreColors";

// Rule-of-thumb reading of the composite score, derived from how the
// sub-scores actually behave (see compositeScore.ts / weatherScore.ts /
// rainfallScore.ts) rather than an arbitrary split — a genuinely excellent
// day+spot realistically tops out around 0.9, not 1.0, so "good" starts
// well below the top of the scale.
const SCORE_GUIDE: Array<{ range: string; label: string; sample: number }> = [
    { range: "0.70+", label: "Worth the trip", sample: 0.85 },
    { range: "0.45 – 0.70", label: "Marginal", sample: 0.58 },
    { range: "< 0.45", label: "Not worth it", sample: 0.25 },
];

// A recently-added ZWJ sequence (Unicode 15.1) — not every browser's emoji
// font can render it as one merged glyph yet, so it's only shown once
// supportsEmojiSequence confirms this browser can (see emojiSupport.ts);
// otherwise it's omitted entirely rather than showing a broken fallback.
const BROWN_MUSHROOM = "\u{1F344}‍\u{1F7EB}";

export default function App() {
    const [location, setLocation] = useState<{ lat: number; lon: number; zoom: number } | null>(null);
    const [selectedPoint, setSelectedPoint] = useState<GridPoint | undefined>();
    const [analysisActive, setAnalysisActive] = useState(false);
    const [radiusKm, setRadiusKm] = useState(6);
    // Tracked independently of `location` (which stays null until the first
    // click) so the sidebar's live sub-score weights — see weightsForZoom
    // below — are meaningful even before anywhere's been analyzed. Starting
    // value matches MapView's own initial MapContainer zoom.
    const [zoom, setZoom] = useState(13);
    const { foragingTarget } = useLayers();
    // Lazy initializer runs the canvas check once on first render, client-side only.
    const [supportsMushroomEmoji] = useState(() => supportsEmojiSequence(BROWN_MUSHROOM));

    // Memoized so its identity stays stable across App re-renders — MapView
    // wires this into a useCallback (handleZoomChange) that feeds an effect
    // dependency array in MapContents, so an unstable identity here
    // previously re-fired that effect (and re-called this handler with the
    // already-current zoom) on every single App render, not just real zoom
    // changes. setLocation itself is the stable setter from useState, so
    // this callback never needs to change.
    const onLiveZoomChange = useCallback((z: number) => {
        setZoom(z);
        // Bail out on an unchanged value — otherwise this always returns a
        // new object, which never lets React's setState bail out either,
        // and the callback identity change cascades into MapContents'
        // zoom-sync effect re-firing every render (infinite loop).
        setLocation((prev) => (prev && prev.zoom !== z ? { ...prev, zoom: z } : prev));
    }, []);

    const weights = useMemo(() => weightsForZoom(zoom), [zoom]);

    const detailQuery = useQuery({
        queryKey: [
            "location-detail",
            location?.lat,
            location?.lon,
            location?.zoom,
            selectedPoint?.elevation,
            selectedPoint?.slope,
            selectedPoint?.aspect,
            foragingTarget,
        ],
        queryFn: async () => {
            if (!location) throw new Error("no location");

            // A nearby grid point already carries the exact same conditions
            // the heatmap uses (including a proper multi-day-averaged solar
            // radiation/cloud cover reading from met_analysis's bulk fetch —
            // the fallback below only ever gets a single-hour snapshot, see
            // getMetAnalysisLatestAtPoint) — reuse them instead of doing a
            // second, slower, less-complete fetch for the same spot.
            // Recompute compositeScore locally (cheap, no fetch) so
            // switching foraging target here stays instant, same as the
            // heatmap's own local re-score effect in MapView.tsx.
            if (selectedPoint?.debug) {
                const { forecast, conditions, forestClass, slope, aspect, twi } = selectedPoint.debug.inputs;
                return {
                    breakdown: compositeScore({ zoom: location.zoom, forecast, conditions, forestClass, slope, aspect, twi, foragingTarget }),
                    elevation: selectedPoint.elevation,
                    slope,
                    aspect,
                    twi,
                    conditions,
                };
            }

            // Fallback: no matching grid point yet (e.g. the very first
            // click, before any grid has loaded) — independent per-point
            // fetch. metAnalysis added here too (previously omitted
            // entirely, silently dropping solar radiation/cloud cover and
            // met_analysis's gridded-tier humidity/wind for this path) —
            // via getMetAnalysisLatestAtPoint, a lightweight single-hour
            // fetch rather than a full multi-day trend, since this fallback
            // is specifically the fast/ad-hoc case and a full trend fetch
            // would contend with the real bulk grid load this same click is
            // about to kick off (see that function's own comment).
            const [forecast, forestClass, terrain, historical, senorge, metAnalysis] = await Promise.all([
                getYrForecast(location.lat, location.lon, location.zoom),
                getForestClass(location.lat, location.lon, gridStepForZoom(location.zoom), location.zoom),
                location.zoom >= MIN_MAPBOX_ZOOM
                    ? getTerrainAtPoint(location.lat, location.lon, location.zoom)
                    : Promise.resolve(null),
                getFrostConditions(location.lat, location.lon),
                getSenorgeConditions(location.lat, location.lon),
                getMetAnalysisLatestAtPoint(location.lat, location.lon),
            ]);

            const slope = terrain?.slope ?? selectedPoint?.slope;
            const aspect = terrain?.aspect ?? selectedPoint?.aspect;
            const elevation = terrain?.elevation ?? selectedPoint?.elevation;
            // No single-point TWI fetch exists (it needs a stitched
            // multi-tile flow-accumulation pass over a whole radius, not
            // worth doing for one ad-hoc click) — reuse a stale nearby grid
            // point's value if one's available, same fallback convention as
            // slope/aspect/elevation above, rather than always going without.
            const twi = selectedPoint?.twi;
            const conditions = mergeHistoricalConditions(senorge, historical, forecast, metAnalysis);

            return {
                breakdown: compositeScore({ zoom: location.zoom, forecast, conditions, forestClass, slope, aspect, twi, foragingTarget }),
                elevation,
                slope,
                aspect,
                twi,
                conditions,
            };
        },
        enabled: !!location,
    });

    return (
        <div style={{ height: "100vh", display: "flex" }}>
            <div style={{ flex: 1, position: "relative" }}>
                <MapView
                    radiusKm={radiusKm}
                    onSelectLocation={(lat, lon, zoom, point) => {
                        setLocation({ lat, lon, zoom });
                        setSelectedPoint(point);
                    }}
                    onLiveZoomChange={onLiveZoomChange}
                    onAnalysisActiveChange={setAnalysisActive}
                />
            </div>

            <div
                style={{
                    width: 320,
                    padding: 16,
                    overflowY: "auto",
                    background: "var(--fe-panel-bg)",
                    borderLeft: "1px solid var(--fe-border)",
                }}
            >
                <div style={PANEL_CARD_STYLE}>
                    <h2 style={PANEL_CARD_TITLE_STYLE}>
                        Forest Explorer{supportsMushroomEmoji && ` ${BROWN_MUSHROOM}`}
                    </h2>
                    <p style={{ fontSize: 12, color: "var(--fe-text-muted)", lineHeight: 1.5, margin: 0 }}>
                        Scores foraging spots in Norway using live terrain, weather, and forest-cover data. Click
                        anywhere on the map to analyze the area around that point.
                    </p>
                </div>

                <div style={PANEL_CARD_STYLE}>
                    <h3 style={PANEL_CARD_TITLE_STYLE}>Selected location</h3>

                    {!location && (
                        <p style={{ fontSize: 13, color: "var(--fe-text-muted)" }}>Click on the map to analyze an area.</p>
                    )}

                    {location && (
                        <div>
                            <p style={{ margin: "0 0 4px", fontSize: 13 }}>Lat: {location.lat.toFixed(4)}</p>
                            <p style={{ margin: "0 0 4px", fontSize: 13 }}>Lon: {location.lon.toFixed(4)}</p>
                            <p style={{ margin: 0, fontSize: 13 }}>Zoom: {location.zoom.toFixed(1)}</p>

                            {detailQuery.isLoading && (
                                <div style={{ marginTop: 10 }}>
                                    <Skeleton height={20} />
                                    <Skeleton height={20} />
                                </div>
                            )}

                            {detailQuery.error && (
                                <p style={{ marginTop: 10, fontSize: 13, color: "#c0392b" }}>Error loading data</p>
                            )}

                            {detailQuery.data && (
                                <div
                                    style={{
                                        fontSize: 13,
                                        marginTop: 10,
                                        paddingTop: 10,
                                        borderTop: "1px solid var(--fe-border)",
                                    }}
                                >
                                    <p style={{ margin: "0 0 4px" }}>
                                        <strong>Composite:</strong> {detailQuery.data.breakdown.composite.toFixed(2)}
                                    </p>
                                    <p style={{ margin: "0 0 4px" }}>
                                        Weather: {detailQuery.data.breakdown.weather.toFixed(2)}
                                    </p>
                                    <p style={{ margin: "0 0 4px" }}>
                                        Rainfall: {detailQuery.data.breakdown.rainfall.toFixed(2)}
                                    </p>
                                    <p style={{ margin: "0 0 4px" }}>
                                        Forest ({detailQuery.data.breakdown.inputs.forestClass}):{" "}
                                        {detailQuery.data.breakdown.forest.toFixed(2)}
                                    </p>
                                    <p style={{ margin: "0 0 4px" }}>
                                        Terrain:{" "}
                                        {detailQuery.data.breakdown.terrain?.toFixed(2) ??
                                            `n/a (zoom in to z${MIN_MAPBOX_ZOOM}+)`}
                                    </p>
                                    {detailQuery.data.elevation !== undefined && (
                                        <p style={{ margin: 0 }}>
                                            Elevation: {detailQuery.data.elevation.toFixed(0)} m
                                            {detailQuery.data.slope !== undefined && (
                                                <>
                                                    {" "}
                                                    · Slope: {detailQuery.data.slope.toFixed(3)} · Aspect:{" "}
                                                    {detailQuery.data.aspect?.toFixed(0)}°
                                                </>
                                            )}
                                            {detailQuery.data.twi !== undefined && (
                                                <> · TWI: {detailQuery.data.twi.toFixed(1)}</>
                                            )}
                                        </p>
                                    )}

                                    <p
                                        style={{
                                            marginTop: 10,
                                            paddingTop: 10,
                                            borderTop: "1px solid var(--fe-border)",
                                            color: "var(--fe-text-muted)",
                                            fontSize: 12,
                                            lineHeight: 1.6,
                                        }}
                                    >
                                        {detailQuery.data.breakdown.inputs.forecast.temperature.toFixed(1)}°C now
                                        {detailQuery.data.conditions.tempMeanRecentC !== undefined && (
                                            <> · {detailQuery.data.conditions.tempMeanRecentC.toFixed(1)}°C 7d-mean ({detailQuery.data.conditions.tempProvenance})</>
                                        )}
                                        {detailQuery.data.conditions.tempMinRecentC !== undefined && (
                                            <> · {detailQuery.data.conditions.tempMinRecentC.toFixed(1)}°C last night</>
                                        )}
                                        <br />
                                        {detailQuery.data.conditions.humidityMeanPct !== undefined && (
                                            <>{detailQuery.data.conditions.humidityMeanPct.toFixed(0)}% humidity ({detailQuery.data.conditions.humidityProvenance})</>
                                        )}
                                        {detailQuery.data.conditions.precipitationRecentMm !== undefined && (
                                            <>
                                                {" "}· {detailQuery.data.conditions.precipitationRecentMm.toFixed(1)} mm recent ({detailQuery.data.conditions.precipitationProvenance})
                                            </>
                                        )}
                                        {detailQuery.data.conditions.daysSinceRain !== undefined && (
                                            <> · {detailQuery.data.conditions.daysSinceRain}d since rain ({detailQuery.data.conditions.daysSinceRainProvenance})</>
                                        )}
                                        {detailQuery.data.conditions.windMeanMs !== undefined && (
                                            <> · wind {detailQuery.data.conditions.windMeanMs.toFixed(1)} m/s</>
                                        )}
                                        {detailQuery.data.conditions.vpdKpa !== undefined && (
                                            <> · VPD {detailQuery.data.conditions.vpdKpa.toFixed(2)} kPa</>
                                        )}
                                        {detailQuery.data.conditions.solarRadiationWm2 !== undefined && (
                                            <> · {detailQuery.data.conditions.solarRadiationWm2.toFixed(0)} W/m² solar</>
                                        )}
                                        {detailQuery.data.conditions.cloudCoverPct !== undefined && (
                                            <> · {detailQuery.data.conditions.cloudCoverPct.toFixed(0)}% cloud</>
                                        )}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div style={PANEL_CARD_STYLE}>
                    <h5
                        style={{
                            margin: "0 0 2px",
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--fe-text-muted)",
                            textTransform: "uppercase",
                            letterSpacing: "0.03em",
                        }}
                    >
                        Composite score guide
                    </h5>
                    <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--fe-text-faint)" }}>
                        A rough read, not a hard rule — see a point's tooltip for what's actually driving its score.
                    </p>
                    {SCORE_GUIDE.map((row) => (
                        <div
                            key={row.label}
                            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}
                        >
                            <span
                                style={{
                                    display: "inline-block",
                                    width: 10,
                                    height: 10,
                                    borderRadius: "50%",
                                    background: scoreToColor(row.sample),
                                    flexShrink: 0,
                                }}
                            />
                            <span style={{ color: "var(--fe-text-muted)", minWidth: 84 }}>{row.range}</span>
                            <span>{row.label}</span>
                        </div>
                    ))}
                </div>

                <LayerControls
                    analysisActive={analysisActive}
                    radiusKm={radiusKm}
                    onRadiusKmChange={setRadiusKm}
                    weights={weights}
                />

                <p style={{ marginTop: 20, fontSize: 12, color: "var(--fe-text-faint)" }}>
                    Press <kbd>D</kbd> for debug panel (tile budget, API log)
                </p>
            </div>
        </div>
    );
}
