import { useEffect, useRef, useCallback } from "react";
import type { ForagingTarget } from "../../lib/scoring/foragingTargets";
import { useMap, useMapEvents } from "react-leaflet";
import { emptyGrid, type LoadGridResult, type LoadStage } from "../../lib/grid/types";
import { loadGridData } from "../../lib/grid/loadGridData";
import { boundsFromCenterRadius } from "../../lib/terrain/types";
import { useLayers } from "../../lib/layers/layerStore";

type Props = {
    /** False until the user clicks the map */
    active: boolean;
    /** The clicked point the heatmap is anchored to, or null before the first click */
    anchor: { lat: number; lon: number } | null;
    /** Radius in km around anchor to sample — set on the side panel before clicking */
    radiusKm: number;
    /** Bumped on each click to reload for the new anchor */
    loadVersion: number;
    onLoaded: (result: LoadGridResult) => void;
    onLoadingChange: (loading: boolean) => void;
    /** A fully-scored but less-refined result, available well before the
     *  final one — see loadGridData.ts's onPartialResult. Optional: a caller
     *  that doesn't pass this just gets the final result as before. */
    onPartialResult?: (result: LoadGridResult) => void;
    /** Pipeline stage transitions, for a progress indicator. */
    onProgress?: (stage: LoadStage) => void;
};

export function GridPointLoader({
    active,
    anchor,
    radiusKm,
    loadVersion,
    onLoaded,
    onLoadingChange,
    onPartialResult,
    onProgress,
}: Props) {
    const map = useMap();
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const abortRef = useRef<AbortController | null>(null);
    const { debugMode, foragingTarget } = useLayers();
    // Read via a ref rather than a useCallback dep — a target change should
    // only affect the *next* click's initial load, not retrigger this whole
    // load (MapContents handles re-scoring already-loaded points locally
    // when the target changes, no reload needed for that).
    const foragingTargetRef = useRef<ForagingTarget>(foragingTarget);
    useEffect(() => {
        foragingTargetRef.current = foragingTarget;
    }, [foragingTarget]);

    const load = useCallback(async () => {
        if (!active || !anchor) return;

        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;

        const mapZoom = map.getZoom();
        onLoadingChange(true);

        try {
            const result = await loadGridData({
                bounds: boundsFromCenterRadius(anchor.lat, anchor.lon, radiusKm),
                mapZoom,
                center: anchor,
                radiusKm,
                foragingTarget: foragingTargetRef.current,
                ignoreTerrainBudget: debugMode,
                signal: abort.signal,
                onPartialResult,
                onProgress,
            });

            if (abort.signal.aborted) return;
            onLoaded(result);
        } catch (err) {
            console.error("[GridPointLoader]", err);
            if (!abort.signal.aborted) {
                onLoaded(emptyGrid);
            }
        } finally {
            if (!abort.signal.aborted) onLoadingChange(false);
        }
    }, [active, anchor, radiusKm, map, onLoaded, onLoadingChange, onPartialResult, onProgress, debugMode]);

    // Read the latest `load` via a ref rather than as a dep below — `load`'s
    // identity changes whenever radiusKm (or debugMode, etc.) changes, and a
    // reload should only actually fire on the next click (loadVersion bump),
    // matching the "Applies on next click" copy on the radius slider.
    const loadRef = useRef(load);
    useEffect(() => {
        loadRef.current = load;
    }, [load]);

    useEffect(() => {
        if (!active) return;
        loadRef.current();
    }, [active, loadVersion]);

    // Without this, a pending debounced reload (or the fetch it kicked off)
    // could still fire and call onLoaded/onLoadingChange after this
    // component has already unmounted.
    useEffect(() => {
        return () => {
            clearTimeout(timerRef.current);
            abortRef.current?.abort();
        };
    }, []);

    useMapEvents({
        zoomend: () => {
            if (!active) return;
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(load, 200);
        },
    });

    return null;
}
