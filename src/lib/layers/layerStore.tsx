import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchLog } from "../debug/fetchLog";
import type { ForagingTarget } from "../scoring/foragingTargets";
import {
    DATA_SOURCES,
    defaultDataSourceLayers,
    defaultDebugLayers,
    defaultReferenceOverlays,
    type DataSourceId,
    type DataSourceLayers,
    type DebugLayers,
    type ReferenceOverlays,
    type SourceLayerToggles,
} from "./types";

type LayerContextValue = {
    dataSources: DataSourceLayers;
    setSourceLayer: (source: DataSourceId, key: keyof SourceLayerToggles, value: boolean) => void;
    debugLayers: DebugLayers;
    setDebugLayer: (key: keyof DebugLayers, value: boolean) => void;
    referenceOverlays: ReferenceOverlays;
    setReferenceOverlay: (key: keyof ReferenceOverlays, value: boolean) => void;
    debugMode: boolean;
    setDebugMode: (v: boolean) => void;
    dryRun: boolean;
    setDryRun: (v: boolean) => void;
    tileBudget: number;
    setTileBudget: (n: number) => void;
    foragingTarget: ForagingTarget;
    setForagingTarget: (t: ForagingTarget) => void;
    heatmapOpacity: number;
    setHeatmapOpacity: (v: number) => void;
};

const LayerContext = createContext<LayerContextValue | null>(null);

export function LayerProvider({ children }: { children: ReactNode }) {
    const [debugMode, setDebugModeState] = useState(
        () => sessionStorage.getItem("debugMode") === "1",
    );
    const [dataSources, setDataSources] = useState<DataSourceLayers>(defaultDataSourceLayers);
    const [debugLayers, setDebugLayers] = useState<DebugLayers>(defaultDebugLayers);
    const [referenceOverlays, setReferenceOverlays] = useState<ReferenceOverlays>(defaultReferenceOverlays);
    const [dryRun, setDryRunState] = useState(false);
    const [tileBudget, setTileBudgetState] = useState(100);
    const [foragingTarget, setForagingTarget] = useState<ForagingTarget>("general");
    const [heatmapOpacity, setHeatmapOpacity] = useState(0.5);

    // Wrapped in useCallback (and the context value below in useMemo) so
    // that changing one piece of state — e.g. dragging the heatmap opacity
    // slider — doesn't hand every consumer of this context a new function
    // identity for every setter, forcing a re-render of unrelated UI (map
    // layers, debug panel, layer controls) on every unrelated state change.
    const setDebugMode = useCallback((v: boolean) => {
        setDebugModeState(v);
        sessionStorage.setItem("debugMode", v ? "1" : "0");
    }, []);

    const setSourceLayer = useCallback((
        source: DataSourceId,
        key: keyof SourceLayerToggles,
        value: boolean,
    ) => {
        setDataSources((prev) => ({
            ...prev,
            [source]: { ...prev[source], [key]: value },
        }));
    }, []);

    const setDebugLayer = useCallback((key: keyof DebugLayers, value: boolean) => {
        setDebugLayers((prev) => ({ ...prev, [key]: value }));
    }, []);

    // Mutually exclusive by construction — all three are trying to answer
    // "is this stand disturbed" in different ways, and showing more than one
    // tint layered on the map at once would just be confusing.
    const setReferenceOverlay = useCallback((key: keyof ReferenceOverlays, value: boolean) => {
        setReferenceOverlays(() => {
            const next: ReferenceOverlays = { hogstklasser: false, crownCover: false, recentCutSatellite: false };
            next[key] = value;
            return next;
        });
    }, []);

    const setDryRun = useCallback((v: boolean) => {
        setDryRunState(v);
        fetchLog.setDryRun(v);
    }, []);

    const setTileBudget = useCallback((n: number) => {
        setTileBudgetState(n);
        fetchLog.setTileBudget(n);
    }, []);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement ||
                e.target instanceof HTMLSelectElement
            )
                return;
            if (e.key === "d" || e.key === "D") setDebugModeState((prev) => !prev);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        fetchLog.setTileBudget(tileBudget);
    }, [tileBudget]);

    useEffect(() => {
        sessionStorage.setItem("debugMode", debugMode ? "1" : "0");
    }, [debugMode]);

    const value = useMemo<LayerContextValue>(
        () => ({
            dataSources,
            setSourceLayer,
            debugLayers,
            setDebugLayer,
            referenceOverlays,
            setReferenceOverlay,
            debugMode,
            setDebugMode,
            dryRun,
            setDryRun,
            tileBudget,
            setTileBudget,
            foragingTarget,
            setForagingTarget,
            heatmapOpacity,
            setHeatmapOpacity,
        }),
        [
            dataSources,
            setSourceLayer,
            debugLayers,
            setDebugLayer,
            referenceOverlays,
            setReferenceOverlay,
            debugMode,
            setDebugMode,
            dryRun,
            setDryRun,
            tileBudget,
            setTileBudget,
            foragingTarget,
            heatmapOpacity,
        ],
    );

    return <LayerContext.Provider value={value}>{children}</LayerContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- context hook, standard provider+hook pattern
export function useLayers() {
    const ctx = useContext(LayerContext);
    if (!ctx) throw new Error("useLayers must be used within LayerProvider");
    return ctx;
}

export { DATA_SOURCES };
