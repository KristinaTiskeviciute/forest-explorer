import { DATA_SOURCES, LAYER_GROUP, SOURCE_COLORS, SOURCE_LABELS, type DataSourceId } from "../../lib/layers/types";
import { FORAGING_TARGETS, FORAGING_TARGET_LABELS, type ForagingTarget } from "../../lib/scoring/foragingTargets";
import { useLayers } from "../../lib/layers/layerStore";
import { PANEL_CARD_STYLE, PANEL_CARD_TITLE_STYLE } from "../../components/ui/panelStyles";

const COMPOSITE_SOURCES = DATA_SOURCES.filter((s) => LAYER_GROUP[s] === "composite");
const RAW_SOURCES = DATA_SOURCES.filter((s) => LAYER_GROUP[s] === "raw");

type Props = {
    analysisActive: boolean;
    radiusKm: number;
    onRadiusKmChange: (radiusKm: number) => void;
};

export function LayerControls({ analysisActive, radiusKm, onRadiusKmChange }: Props) {
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
        <div style={PANEL_CARD_STYLE}>
            <h4 style={PANEL_CARD_TITLE_STYLE}>Data layers</h4>

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
                sample points you can hover for details.
            </p>

            <LayerTable
                heading="Composite score components"
                description="Feed directly into the composite suitability score."
                sources={COMPOSITE_SOURCES}
                dataSources={dataSources}
                analysisActive={analysisActive}
                setSourceLayer={setSourceLayer}
            />
            <details className="fe-collapsible" style={{ marginTop: 16 }}>
                <summary>Raw values</summary>
                <div style={{ marginTop: 8 }}>
                    <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fe-text-faint)" }}>
                        Reference readings shown for context — not used in scoring.
                    </p>
                    <LayerTable
                        sources={RAW_SOURCES}
                        dataSources={dataSources}
                        analysisActive={analysisActive}
                        setSourceLayer={setSourceLayer}
                    />
                </div>
            </details>

            <details className="fe-collapsible" style={{ marginTop: 16 }}>
                <summary>Reference overlays</summary>
                <div style={{ marginTop: 8 }}>
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
            </details>
        </div>
    );
}

type LayerTableProps = {
    /** Omit when the caller already provides its own heading/description
     *  (e.g. a <details><summary> wrapper) — see the "Raw values" usage. */
    heading?: string;
    description?: string;
    sources: readonly DataSourceId[];
    dataSources: ReturnType<typeof useLayers>["dataSources"];
    analysisActive: boolean;
    setSourceLayer: ReturnType<typeof useLayers>["setSourceLayer"];
};

function LayerTable({ heading, description, sources, dataSources, analysisActive, setSourceLayer }: LayerTableProps) {
    return (
        <div>
            {heading && (
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
            )}
            {description && <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--fe-text-faint)" }}>{description}</p>}
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
                    {sources.map((source) => (
                        <tr className="fe-layer-row" key={source}>
                            <td style={{ padding: "6px 4px 6px 0" }}>
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
                                {SOURCE_LABELS[source]}
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
                    ))}
                </tbody>
            </table>
        </div>
    );
}
