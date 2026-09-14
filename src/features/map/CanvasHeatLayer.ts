import L from "leaflet";
import type { Feature, Polygon } from "geojson";
import { scoreToColor } from "../../lib/scoring/scoreColors";

export class CanvasHeatLayer extends L.Layer {
    private _canvas: HTMLCanvasElement | null = null;
    private _cells: Feature<Polygon>[] = [];
    private _fillOpacity = 0.55;
    private _paneName: string;
    private _colorFn: (value: number) => string = scoreToColor;
    private _settleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(paneName = "overlayPane") {
        super();
        this._paneName = paneName;
    }

    setData(cells: Feature<Polygon>[], fillOpacity = 0.55, colorFn: (value: number) => string = scoreToColor) {
        this._cells = cells;
        this._fillOpacity = fillOpacity;
        this._colorFn = colorFn;
        this._redraw();
    }

    onAdd(map: L.Map): this {
        this._canvas = L.DomUtil.create("canvas", "leaflet-heat-surface") as HTMLCanvasElement;
        const pane = map.getPane(this._paneName) ?? map.createPane(this._paneName);
        if (pane) {
            this._canvas.style.pointerEvents = "none";
            pane.appendChild(this._canvas);
        }
        // Deliberately NOT "move": the canvas's parent pane is already
        // carried along for free by Leaflet's own shared mapPane transform
        // during an ordinary drag (same mechanism that pans tiles/markers).
        // Re-applying our own compensating transform on every "move" event
        // was double-compensating — two equal-and-opposite shifts (the
        // pane's live transform + our own) canceled out, freezing the
        // canvas on screen while the map panned underneath it.
        //
        // "moveend" is bound directly here (not just relied on indirectly
        // via DataSourceLayers.tsx's own setData call), plus a short delayed
        // follow-up redraw in _redraw() itself — verified live with
        // Playwright that a single moveend-triggered redraw could still
        // land on stale cell positions for some panned area (real,
        // reproducible: same geography, wrong color, confirmed via
        // pixel-level comparison against a ground-truth-matched crop), most
        // likely because Leaflet's dragend/inertia settling isn't fully
        // done at the instant our own moveend handler runs. The extra
        // delayed redraw catches whatever the first one missed once the
        // map has genuinely settled.
        map.on("zoom resize viewreset moveend", this._redraw, this);
        this._redraw();
        return this;
    }

    onRemove(map: L.Map): this {
        map.off("zoom resize viewreset moveend", this._redraw, this);
        clearTimeout(this._settleTimer);
        if (this._canvas?.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }
        this._canvas = null;
        return this;
    }

    /** Repositions the canvas and re-fills every cell from current map state. */
    private _paint = () => {
        const map = this._map;
        const canvas = this._canvas;
        if (!map || !canvas) return;

        const size = map.getSize();
        canvas.width = size.x;
        canvas.height = size.y;
        canvas.style.width = `${size.x}px`;
        canvas.style.height = `${size.y}px`;

        // The canvas element is moved to `topLeft` (in layer-point space) so
        // its own (0,0) lines up with the viewport's top-left corner — the
        // same offset must then be subtracted from every drawn point below,
        // or the two shifts compound: the element moves to compensate for
        // the pan/zoom offset, but content drawn using raw layer points is
        // still positioned as if it hadn't. (This is the same origin-offset
        // idiom Leaflet's own built-in Canvas renderer uses internally.)
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(canvas, topLeft);

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, size.x, size.y);

        for (const cell of this._cells) {
            const rawScore = cell.properties?.score;
            const score = typeof rawScore === "number" ? rawScore : 0;
            ctx.fillStyle = this._colorFn(score);
            ctx.globalAlpha = this._fillOpacity;

            const ring = cell.geometry.coordinates[0];
            ctx.beginPath();
            for (let i = 0; i < ring.length; i++) {
                const [lon, lat] = ring[i];
                const pt = map.latLngToLayerPoint([lat, lon]);
                const x = pt.x - topLeft.x;
                const y = pt.y - topLeft.y;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();
        }

        ctx.globalAlpha = 1;
    };

    private _redraw = () => {
        this._paint();

        // Follow-up paint shortly after any trigger, catching drift from
        // inertia/settling that isn't finished at the moment the triggering
        // event fires. Cheap — just re-filling shapes from data already in
        // memory — and self-cancelling (a burst of events only pays for one
        // extra pass, since each call resets the timer).
        clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(this._paint, 150);
    };
}
