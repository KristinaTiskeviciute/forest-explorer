declare module "*.geojson" {
    import type { FeatureCollection, Feature, Geometry } from "geojson";
    const value: FeatureCollection | Feature<Geometry>;
    export default value;
}

declare module "*.json" {
    import type { FeatureCollection, Feature, Geometry } from "geojson";
    const value: FeatureCollection | Feature<Geometry> | Record<string, unknown>;
    export default value;
}

interface ImportMetaEnv {
    readonly VITE_MAPBOX_TOKEN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
