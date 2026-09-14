import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { useLayers } from "../../lib/layers/layerStore";
import { getNorwayLandFeature } from "../../lib/water/waterExclusion";
import { tileBounds } from "../../lib/terrain/tileMath";
import { tileCache } from "../../lib/terrain/tileCache";

export function DebugOverlays() {
    const map = useMap();
    const { debugLayers } = useLayers();
    const landLayerRef = useRef<L.GeoJSON | null>(null);
    const tileLayerRef = useRef<L.LayerGroup | null>(null);

    useEffect(() => {
        if (landLayerRef.current) {
            map.removeLayer(landLayerRef.current);
            landLayerRef.current = null;
        }
        if (!debugLayers.landMask) return;

        landLayerRef.current = L.geoJSON(getNorwayLandFeature(), {
            style: { color: "#3388ff", weight: 1, fillOpacity: 0.05 },
        }).addTo(map);

        return () => {
            if (landLayerRef.current) map.removeLayer(landLayerRef.current);
        };
    }, [map, debugLayers.landMask]);

    useEffect(() => {
        if (tileLayerRef.current) {
            map.removeLayer(tileLayerRef.current);
            tileLayerRef.current = null;
        }
        if (!debugLayers.tileGrid) return;

        const group = L.layerGroup();
        for (const key of tileCache.keys()) {
            const [z, x, y] = key.split("/").map(Number);
            const b = tileBounds(z, x, y);
            L.rectangle(
                [
                    [b.south, b.west],
                    [b.north, b.east],
                ],
                { color: "#ff0000", weight: 1, fill: false },
            ).addTo(group);
        }
        group.addTo(map);
        tileLayerRef.current = group;

        return () => {
            if (tileLayerRef.current) map.removeLayer(tileLayerRef.current);
        };
    }, [map, debugLayers.tileGrid]);

    return null;
}
