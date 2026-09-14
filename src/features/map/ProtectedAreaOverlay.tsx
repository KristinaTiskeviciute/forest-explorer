import { GeoJSON } from "react-leaflet";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { Layer, PathOptions } from "leaflet";

type Props = {
    areas: FeatureCollection<Polygon | MultiPolygon>;
};

const STYLE: PathOptions = {
    color: "#b91c1c",
    weight: 2,
    dashArray: "6 4",
    fillColor: "#dc2626",
    fillOpacity: 0.15,
};

function protectedAreaTooltip(feature?: Feature<Polygon | MultiPolygon>): string {
    const props = feature?.properties ?? {};
    const name = (props.offisieltNavn as string | undefined) ?? (props.navn as string | undefined) ?? "Protected area";
    const kind = props.verneform as string | undefined;
    return (
        `<strong>${name}</strong>${kind ? ` (${kind})` : ""}` +
        `<br>Protected area — excluded from foraging suggestions`
    );
}

/** Renders the protected-area polygons a grid load already excluded points
 *  from (see loadGridData.ts/protectedAreasApi.ts) — without this, a gap in
 *  the heatmap over ordinary-looking forest has no visible explanation. */
export function ProtectedAreaOverlay({ areas }: Props) {
    if (areas.features.length === 0) return null;

    return (
        <GeoJSON
            data={areas}
            style={STYLE}
            onEachFeature={(feature: Feature<Polygon | MultiPolygon>, layer: Layer) => {
                layer.bindTooltip(protectedAreaTooltip(feature), { sticky: true });
            }}
        />
    );
}
