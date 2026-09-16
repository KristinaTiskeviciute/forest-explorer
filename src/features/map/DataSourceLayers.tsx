import { useCallback, useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import type { FeatureCollection, Polygon } from "geojson";
import type { GridPoint, TerrainDebugData } from "../../lib/grid/types";
import { scoreForSource, valueForSource } from "../../lib/grid/scores";
import { gridTooltip } from "../../lib/grid/tooltips";
import {
    DATA_SOURCES,
    LAYER_MODE,
    SOURCE_COLORS,
    type DataSourceId,
} from "../../lib/layers/types";
import { useLayers } from "../../lib/layers/layerStore";
import { scoreToColor } from "../../lib/scoring/scoreColors";
import { valueToColor } from "../../lib/scoring/valueColors";
import {
    CANVAS_CELL_THRESHOLD,
    buildScoreCells,
} from "../../lib/scoring/scoreGridCells";
import { coordKey } from "../../lib/terrain/types";
import { CanvasHeatLayer } from "./CanvasHeatLayer";

type Props = {
    points: GridPoint[];
    terrainDebug: TerrainDebugData;
    active: boolean;
    gridStep: number;
    /** coordKey()s of the top-scoring points (by composite score) — given a
     *  distinct marker style in the grid layer wherever they appear. See
     *  MapView.tsx's topSpotKeys for how membership is decided. */
    topSpotKeys: Set<string>;
};

const GRID_PANE = "sourceGridPane";

function sourceZIndex(source: DataSourceId): number {
    const order: Record<DataSourceId, number> = {
        composite: 400,
        weather: 401,
        temperature: 402,
        humidity: 403,
        rainfall: 404,
        precipitationRecent: 405,
        wind: 406,
        solarRadiationAdjusted: 407,
        vpd: 408,
        twi: 409,
        forest: 410,
        terrain: 411,
        snow: 412,
    };
    return order[source];
}

/** Score-mode layers use scoreForSource/scoreToColor (0-1 suitability);
 *  value-mode layers (wind/humidity/snow) use valueForSource/valueToColor
 *  (raw physical readings) — same shape, different meaning. */
function getterForSource(source: DataSourceId): (point: GridPoint) => number | null {
    return LAYER_MODE[source] === "value" ? (p) => valueForSource(p, source) : (p) => scoreForSource(p, source);
}

function colorFnForSource(source: DataSourceId): (value: number) => string {
    return LAYER_MODE[source] === "value" ? (v) => valueToColor(v, source) : scoreToColor;
}

export default function DataSourceLayers({ points, terrainDebug, active, gridStep, topSpotKeys }: Props) {
    const map = useMap();
    const { dataSources, heatmapOpacity } = useLayers();
    const canvasRefs = useRef(new Map<DataSourceId, CanvasHeatLayer>());
    const geoJsonRefs = useRef(new Map<DataSourceId, L.GeoJSON>());
    const gridRefs = useRef(new Map<DataSourceId, L.LayerGroup>());

    // Read via a ref rather than a useCallback dep of updateHeatmaps below —
    // heatmapOpacity changes on every tick of the opacity slider, and having
    // updateHeatmaps (and therefore `update`, and therefore the mount effect
    // that binds map events) depend on it directly meant every drag tore
    // down and rebuilt every canvas/GeoJSON/grid-marker layer on the map.
    // The dedicated effect further below repaints the existing layers at the
    // new opacity instead.
    const heatmapOpacityRef = useRef(heatmapOpacity);
    useEffect(() => {
        heatmapOpacityRef.current = heatmapOpacity;
    }, [heatmapOpacity]);

    const removeCanvasLayer = useCallback(
        (source: DataSourceId) => {
            const canvas = canvasRefs.current.get(source);
            if (canvas) {
                map.removeLayer(canvas);
                canvasRefs.current.delete(source);
            }
        },
        [map],
    );

    const removeGeoJsonLayer = useCallback(
        (source: DataSourceId) => {
            const geo = geoJsonRefs.current.get(source);
            if (geo) {
                map.removeLayer(geo);
                geoJsonRefs.current.delete(source);
            }
        },
        [map],
    );

    const clearHeatmap = useCallback(
        (source: DataSourceId) => {
            removeCanvasLayer(source);
            removeGeoJsonLayer(source);
        },
        [removeCanvasLayer, removeGeoJsonLayer],
    );

    const clearGrid = useCallback(
        (source: DataSourceId) => {
            const group = gridRefs.current.get(source);
            if (group) {
                map.removeLayer(group);
                gridRefs.current.delete(source);
            }
        },
        [map],
    );

    const clearAll = useCallback(() => {
        for (const source of DATA_SOURCES) {
            clearHeatmap(source);
            clearGrid(source);
        }
    }, [clearGrid, clearHeatmap]);

    const updateHeatmaps = useCallback(() => {
        if (!active || !points.length) {
            clearAll();
            return;
        }

        const mapZoom = map.getZoom();
        const useCanvas = mapZoom >= 14;

        // Each source keeps its own color gradient (score-mode vs value-mode
        // scales aren't unified) — but stacking several fully-opaque layers
        // on top of each other just buries everything under whichever pane
        // sits highest (see sourceZIndex). Splitting the opacity budget across
        // however many heatmaps are active keeps every layer's color visible
        // through the ones above it, so multiple layers actually blend into a
        // legible combined picture instead of one layer hiding the rest.
        const activeHeatmapCount = DATA_SOURCES.filter((s) => dataSources[s].heatmap).length;

        for (const source of DATA_SOURCES) {
            if (!dataSources[source].heatmap) {
                clearHeatmap(source);
                continue;
            }

            const surface = buildScoreCells(
                points,
                getterForSource(source),
                gridStep,
            );

            if (!surface.cells.length) {
                clearHeatmap(source);
                continue;
            }

            const colorFn = colorFnForSource(source);
            const opacity = heatmapOpacityRef.current / Math.max(1, activeHeatmapCount);
            const paneName = `heatmap-${source}`;
            const pane = map.getPane(paneName) ?? map.createPane(paneName);
            pane.style.zIndex = String(sourceZIndex(source));

            if (useCanvas || surface.cellCount >= CANVAS_CELL_THRESHOLD) {
                removeGeoJsonLayer(source);
                let layer = canvasRefs.current.get(source);
                if (!layer) {
                    layer = new CanvasHeatLayer(paneName);
                    layer.addTo(map);
                    canvasRefs.current.set(source, layer);
                }
                layer.setData(surface.cells, opacity, colorFn);
            } else {
                removeCanvasLayer(source);
                removeGeoJsonLayer(source);
                const geo = L.geoJSON(
                    { type: "FeatureCollection", features: surface.cells } as FeatureCollection<Polygon>,
                    {
                        interactive: false,
                        pane: paneName,
                        style: (feature) => {
                            const rawScore = feature?.properties?.score;
                            return {
                                fillColor: colorFn(typeof rawScore === "number" ? rawScore : 0),
                                fillOpacity: opacity,
                                stroke: false,
                            };
                        },
                    },
                ).addTo(map);
                geoJsonRefs.current.set(source, geo);
            }
        }
    }, [
        active,
        clearAll,
        clearHeatmap,
        dataSources,
        gridStep,
        map,
        points,
        removeCanvasLayer,
        removeGeoJsonLayer,
    ]);

    const updateGrids = useCallback(() => {
        if (!active) {
            for (const source of DATA_SOURCES) clearGrid(source);
            return;
        }

        const pane = map.getPane(GRID_PANE) ?? map.createPane(GRID_PANE);
        // Leaflet's built-in tooltipPane also defaults to zIndex 650, and
        // since this custom pane is created after that default one, ties go
        // to us — every grid dot was painting on top of every tooltip
        // (including its own), covering the popup the moment any dot
        // overlapped it. Staying below 650 (but above the 400s the heatmap
        // panes use) lets tooltips render above the dots that spawn them.
        pane.style.zIndex = "600";
        pane.style.pointerEvents = "none";

        for (const source of DATA_SOURCES) {
            if (!dataSources[source].grid) {
                clearGrid(source);
                continue;
            }

            clearGrid(source);
            const group = L.layerGroup();
            const color = SOURCE_COLORS[source];

            const getValue = getterForSource(source);
            for (const p of points) {
                const score = getValue(p);
                if (score === null) continue;

                const isTopSpot = topSpotKeys.has(coordKey(p.lat, p.lon));
                const baseRadius = source === "composite" ? 3 : 4;
                const tooltip = isTopSpot
                    ? `⭐ <strong>Top spot (by composite score)</strong><br>${gridTooltip(p, source)}`
                    : gridTooltip(p, source);

                L.circleMarker([p.lat, p.lon], {
                    pane: GRID_PANE,
                    radius: isTopSpot ? baseRadius + 3 : baseRadius,
                    fillColor: color,
                    fillOpacity: 0.85,
                    color: isTopSpot ? "#facc15" : "#fff",
                    weight: isTopSpot ? 3 : 1,
                    interactive: true,
                })
                    .bindTooltip(tooltip, { sticky: true })
                    .addTo(group);
            }

            if (source === "terrain") {
                const sampleKeys = new Set(terrainDebug.samples.map((s) => coordKey(s.lat, s.lon)));

                terrainDebug.targets.forEach((t) => {
                    if (sampleKeys.has(coordKey(t.lat, t.lon))) return;
                    L.circleMarker([t.lat, t.lon], {
                        pane: GRID_PANE,
                        radius: 6,
                        fillColor: "#f97316",
                        fillOpacity: 0.25,
                        color: "#ea580c",
                        weight: 2,
                        interactive: false,
                    })
                        .bindTooltip("terrain: no sample", { sticky: true })
                        .addTo(group);
                });

                terrainDebug.samples.forEach((s) => {
                    L.circleMarker([s.lat, s.lon], {
                        pane: GRID_PANE,
                        radius: 7,
                        fillColor: "#06b6d4",
                        fillOpacity: 0.95,
                        color: "#0e7490",
                        weight: 2,
                        interactive: true,
                    })
                        .bindTooltip(
                            `Mapbox sample · elev ${s.elevation.toFixed(0)}m · slope ${s.slope.toFixed(3)}`,
                            { sticky: true },
                        )
                        .addTo(group);
                });
            }

            group.addTo(map);
            gridRefs.current.set(source, group);
        }
    }, [active, clearGrid, dataSources, map, points, terrainDebug, topSpotKeys]);

    const update = useCallback(() => {
        updateHeatmaps();
        updateGrids();
    }, [updateGrids, updateHeatmaps]);

    useEffect(() => {
        update();
        return () => {
            clearAll();
        };
    }, [update, clearAll]);

    // Only the heatmap layer's canvas-vs-GeoJSON choice (`useCanvas` inside
    // updateHeatmaps) depends on the map's own state, and only on zoom —
    // grid markers reposition on their own via Leaflet's native pan/zoom
    // handling and don't need a manual rebuild on any map event, and
    // CanvasHeatLayer already redraws itself on move/resize internally (see
    // its own onAdd). Previously this whole layer set — heatmaps, GeoJSON,
    // and every grid marker — was torn down and rebuilt from scratch on
    // every single moveend/resize, not just a zoom-tier change.
    useEffect(() => {
        const onZoomEnd = () => updateHeatmaps();
        map.on("zoomend", onZoomEnd);
        return () => {
            map.off("zoomend", onZoomEnd);
        };
    }, [map, updateHeatmaps]);

    // Opacity alone shouldn't retrigger the effect above (it would tear down
    // and rebuild every layer via clearAll) — just repaint the heatmaps
    // already on the map at the new opacity. Deliberately depends on
    // heatmapOpacity only: updateHeatmaps already runs on every real data
    // change via the effect above, so including it here too would just
    // double that work.
    useEffect(() => {
        updateHeatmaps();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [heatmapOpacity]);

    return null;
}
