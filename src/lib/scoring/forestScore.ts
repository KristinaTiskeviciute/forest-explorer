import type { AR5Class } from "../../api/nibioApi";
import type { ForagingTarget } from "./foragingTargets";

// Per-target forest-type scoring — there's no single "best forest" ranking
// independent of what's being foraged (cloudberries want bog and nothing
// else; lingonberries want dry pine/open ground; chanterelles and ceps both
// lean coniferous/mixed but differ from each other too). "general" preserves
// the original flat spread as the default. Every AR5Class key is populated
// for every target (including the dormant skog/myr/aapen/dyrka/bebygd) so
// this stays correct if the SR16 tree-species experiment is ever flipped
// back off in nibioApi.ts. Starting values — a hypothesis, easy to retune.
const scores: Record<ForagingTarget, Record<AR5Class, number>> = {
    general: {
        skog: 1.0,
        myr: 0.6,
        aapen: 0.3,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 1.0,
        furu: 0.95,
        lauv: 0.9,
        none: 0.4,
        unknown: 0.4,
    },
    chanterelle: {
        skog: 0.9,
        myr: 0.1,
        aapen: 0.2,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 1.0,
        furu: 0.8,
        lauv: 0.85,
        none: 0.3,
        unknown: 0.4,
    },
    cep: {
        skog: 0.9,
        myr: 0.05,
        aapen: 0.15,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 1.0,
        furu: 0.85,
        lauv: 0.9,
        none: 0.25,
        unknown: 0.4,
    },
    blueberry: {
        skog: 0.85,
        myr: 0.3,
        aapen: 0.5,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 0.9,
        furu: 1.0,
        lauv: 0.6,
        none: 0.35,
        unknown: 0.4,
    },
    lingonberry: {
        skog: 0.7,
        myr: 0.2,
        aapen: 0.8,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 0.6,
        furu: 1.0,
        lauv: 0.4,
        none: 0.4,
        unknown: 0.4,
    },
    cloudberry: {
        skog: 0.05,
        myr: 1.0,
        aapen: 0.2,
        dyrka: 0.0,
        bebygd: 0.0,
        gran: 0.05,
        furu: 0.05,
        lauv: 0.05,
        none: 0.1,
        unknown: 0.3,
    },
};

export function forestScore(c: AR5Class, target: ForagingTarget = "general"): number {
    return scores[target][c];
}
