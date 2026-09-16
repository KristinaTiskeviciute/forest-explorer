import { DATA_SOURCES, LAYER_GROUP, LAYER_PARENT, SOURCE_COLORS, SOURCE_LABELS, type DataSourceId } from "../../lib/layers/types";
import { FORAGING_TARGETS, FORAGING_TARGET_LABELS, type ForagingTarget } from "../../lib/scoring/foragingTargets";
import { useLayers } from "../../lib/layers/layerStore";

const COMPOSITE_SOURCES = DATA_SOURCES.filter((s) => LAYER_GROUP[s] === "composite");
const RAW_SOURCES = DATA_SOURCES.filter((s) => LAYER_GROUP[s] === "raw");

type Props = {
    analysisActive: boolean;
    radiusKm: number;
    onRadiusKmChange: (radiusKm: number) => void;
    /** Live weather/rainfall/forest/terrain weights for the current zoom
     *  (see weightsForZoom in compositeScore.ts) — shown next to each
     *  sub-score's label so the table reflects how much each one actually
     *  counts right now, not just that it's one of four inputs. */
    weights: { weather: number; rainfall: number; forest: number; terrain: number };
};

export function LayerControls({ analysisActive, radiusKm, onRadiusKmChange, weights }: Props) {
    const {
        dataSources,
        setSourceLayer,
        foragingTarget,
        setForagingTarget,
        heatmapOpacity,
        setHeatmapOpacity,
        referenceOverlays,
        setReferenceOverlay,
    } = useLayers();

    return (
        <div
            style={{
                marginTop: 14,
                background: "var(--fe-card-bg)",
                border: "1px solid var(--fe-border)",
                borderRadius: 10,
                padding: "12px 14px",
                boxShadow: "var(--fe-shadow-sm)",
            }}
        >
            <h4 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600 }}>Data layers</h4>

            <div style={{ marginBottom: 12 }}>
                <label
                    htmlFor="fe-foraging-target"
                    style={{ fontSize: 12, fontWeight: 500, color: "var(--fe-text-muted)", display: "block", marginBottom: 4 }}
                >
                    Foraging target
                </label>
                <select
                    id="fe-foraging-target"
                    className="fe-select"
                    value={foragingTarget}
                    onChange={(e) => setForagingTarget(e.target.value as ForagingTarget)}
                >
                    {FORAGING_TARGETS.map((t) => (
                        <option key={t} value={t}>
                            {FORAGING_TARGET_LABELS[t]}
                        </option>
                    ))}
                </select>
                <p style={{ fontSize: 12, color: "var(--fe-text-faint)", margin: "4px 0 0" }}>
                    Re-weights forest-type scoring instantly, no reload needed
                </p>
            </div>

            <div style={{ marginBottom: 12 }}>
                <label
                    htmlFor="fe-radius-km"
                    style={{ fontSize: 12, fontWeight: 500, color: "var(--fe-text-muted)", display: "block", marginBottom: 4 }}
                >
                    Analysis radius: {radiusKm} km
                </label>
                <input
                    id="fe-radius-km"
                    type="range"
                    className="fe-range"
                    min={3}
                    max={30}
                    step={1}
                    value={radiusKm}
                    onChange={(e) => onRadiusKmChange(Number(e.target.value))}
                />
                <p style={{ fontSize: 12, color: "var(--fe-text-faint)", margin: "4px 0 0" }}>Applies on next click</p>
            </div>

            <div style={{ marginBottom: 14 }}>
                <label
                    htmlFor="fe-heatmap-opacity"
                    style={{ fontSize: 12, fontWeight: 500, color: "var(--fe-text-muted)", display: "block", marginBottom: 4 }}
                >
                    Heatmap opacity: {Math.round(heatmapOpacity * 100)}%
                </label>
                <input
                    id="fe-heatmap-opacity"
                    type="range"
                    className="fe-range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={heatmapOpacity}
                    onChange={(e) => setHeatmapOpacity(Number(e.target.value))}
                />
            </div>

            {!analysisActive && (
                <p
                    style={{
                        fontSize: 12,
                        color: "var(--fe-text-muted)",
                        background: "var(--fe-panel-bg)",
                        border: "1px dashed var(--fe-border)",
                        borderRadius: 8,
                        padding: "6px 8px",
                        margin: "0 0 12px",
                    }}
                >
                    Click the map to load data for this view.
                </p>
            )}

            <p style={{ fontSize: 12, color: "var(--fe-text-faint)", margin: "0 0 10px", lineHeight: 1.5 }}>
                <strong>Heatmap</strong> colors the whole analyzed area; <strong>grid</strong> shows individual
                sample points you can hover for details. Enable more than one heatmap at once to compare them —
                each one's opacity thins out automatically so they stay legible stacked together.
            </p>

            <LayerTable
                heading="Composite score components"
                description="Weather/rainfall/forest/terrain feed the composite score directly, at the % weight shown — terrain's share grows with zoom, taken proportionally from the other three. Everything nested under one of them feeds that sub-score instead."
                sources={COMPOSITE_SOURCES}
                dataSources={dataSources}
                analysisActive={analysisActive}
                setSourceLayer={setSourceLayer}
                weights={weights}
            />
            <div style={{ marginTop: 16 }}>
                <LayerTable
                    heading="Also worth checking"
                    description="Not used in scoring, but relevant on the ground regardless."
                    sources={RAW_SOURCES}
                    dataSources={dataSources}
                    analysisActive={analysisActive}
                    setSourceLayer={setSourceLayer}
                />
            </div>

            <div style={{ marginTop: 16 }}>
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
                    Reference overlays
                </h5>
                <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fe-text-faint)" }}>
                    Raw NIBIO map layers, shown as-is — not used in scoring. Visible immediately, no click needed.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 12, cursor: "pointer" }}>
                    <input
                        className="fe-checkbox"
                        type="radio"
                        name="fe-reference-overlay"
                        checked={referenceOverlays.hogstklasser}
                        onChange={() => setReferenceOverlay("hogstklasser", true)}
                    />
                    Hogstklasse (stand age)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 12, cursor: "pointer" }}>
                    <input
                        className="fe-checkbox"
                        type="radio"
                        name="fe-reference-overlay"
                        checked={referenceOverlays.crownCover}
                        onChange={() => setReferenceOverlay("crownCover", true)}
                    />
                    Crown cover (canopy density)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 12, cursor: "pointer" }}>
                    <input
                        className="fe-checkbox"
                        type="radio"
                        name="fe-reference-overlay"
                        checked={referenceOverlays.recentCutSatellite}
                        onChange={() => setReferenceOverlay("recentCutSatellite", true)}
                    />
                    Recent clear-cuts by year (Miljødirektoratet, satellite, darker = more recent, 1985–2024)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 12, cursor: "pointer" }}>
                    <input
                        className="fe-checkbox"
                        type="radio"
                        name="fe-reference-overlay"
                        checked={!referenceOverlays.hogstklasser && !referenceOverlays.crownCover && !referenceOverlays.recentCutSatellite}
                        onChange={() => setReferenceOverlay("hogstklasser", false)}
                    />
                    None
                </label>
            </div>
        </div>
    );
}

type LayerTableProps = {
    heading: string;
    description: string;
    sources: readonly DataSourceId[];
    dataSources: ReturnType<typeof useLayers>["dataSources"];
    analysisActive: boolean;
    setSourceLayer: ReturnType<typeof useLayers>["setSourceLayer"];
    /** Weight (0-1) for whichever of these sources it has a live weight for
     *  (weather/rainfall/forest/terrain) — everything else is just omitted
     *  from this map, so the row renders without a percentage. */
    weights?: Partial<Record<DataSourceId, number>>;
};

function LayerTable({ heading, description, sources, dataSources, analysisActive, setSourceLayer, weights }: LayerTableProps) {
    return (
        <div>
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
                {heading}
            </h5>
            <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fe-text-faint)" }}>{description}</p>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                <thead>
                    <tr style={{ textAlign: "left", color: "var(--fe-text-faint)" }}>
                        <th
                            style={{
                                paddingBottom: 6,
                                borderBottom: "1px solid var(--fe-border)",
                                fontWeight: 500,
                            }}
                        >
                            Source
                        </th>
                        <th style={{ paddingBottom: 6, borderBottom: "1px solid var(--fe-border)", fontWeight: 500 }}>
                            Heatmap
                        </th>
                        <th style={{ paddingBottom: 6, borderBottom: "1px solid var(--fe-border)", fontWeight: 500 }}>
                            Grid
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {sources.map((source) => {
                        // Only treat it as nested when its parent is also in
                        // this same table — LAYER_PARENT is a global mapping,
                        // but a table showing just one section shouldn't
                        // indent a row whose "parent" isn't even listed here.
                        const isNested = LAYER_PARENT[source] !== undefined && sources.includes(LAYER_PARENT[source]!);
                        return (
                            <tr className="fe-layer-row" key={source}>
                                <td style={{ padding: "6px 4px 6px 0", paddingLeft: isNested ? 20 : 0 }}>
                                    {isNested ? (
                                        <span
                                            style={{
                                                display: "inline-block",
                                                marginRight: 6,
                                                color: "var(--fe-text-faint)",
                                                fontSize: 11,
                                            }}
                                        >
                                            ↳
                                        </span>
                                    ) : (
                                        <span
                                            style={{
                                                display: "inline-block",
                                                width: 10,
                                                height: 10,
                                                borderRadius: "50%",
                                                background: SOURCE_COLORS[source],
                                                marginRight: 6,
                                                verticalAlign: "middle",
                                            }}
                                        />
                                    )}
                                    <span style={isNested ? { color: "var(--fe-text-muted)", fontSize: 11 } : undefined}>
                                        {SOURCE_LABELS[source]}
                                    </span>
                                    {weights?.[source] !== undefined && (
                                        <span style={{ color: "var(--fe-text-faint)", fontSize: 11 }}>
                                            {" "}
                                            ({Math.round(weights[source]! * 100)}%)
                                        </span>
                                    )}
                                </td>
                                <td style={{ padding: "6px 4px", textAlign: "center" }}>
                                    <input
                                        className="fe-checkbox"
                                        type="checkbox"
                                        aria-label={`${SOURCE_LABELS[source]} heatmap`}
                                        checked={dataSources[source].heatmap}
                                        disabled={!analysisActive}
                                        onChange={(e) => setSourceLayer(source, "heatmap", e.target.checked)}
                                    />
                                </td>
                                <td style={{ padding: "6px 4px", textAlign: "center" }}>
                                    <input
                                        className="fe-checkbox"
                                        type="checkbox"
                                        aria-label={`${SOURCE_LABELS[source]} grid`}
                                        checked={dataSources[source].grid}
                                        disabled={!analysisActive}
                                        onChange={(e) => setSourceLayer(source, "grid", e.target.checked)}
                                    />
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
