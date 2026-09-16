/**
 * Best-effort check for whether the current browser's emoji font can render
 * a multi-codepoint ZWJ sequence (e.g. "🍄‍🟫") as a single merged glyph,
 * rather than falling back to the separate component glyphs (or a missing-
 * glyph "tofu" box) side by side.
 *
 * Not exact — a font could render an unsupported sequence as a single tofu
 * box that happens to measure the same as a real glyph, which this can't
 * distinguish from actual support. But it catches the common case (the
 * sequence falling apart into two visible glyphs) and is the standard
 * canvas-measurement heuristic for this problem, so it's a reasonable
 * default for "no emoji" over "obviously broken emoji".
 */
export function supportsEmojiSequence(sequence: string, reference = "❓" /* ❓, always single-glyph */): boolean {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;

        ctx.font = "32px sans-serif";
        ctx.textBaseline = "top";
        const sequenceWidth = ctx.measureText(sequence).width;
        const referenceWidth = ctx.measureText(reference).width;
        if (sequenceWidth === 0 || referenceWidth === 0) return false;

        // A merged single glyph should measure close to any other single
        // emoji glyph; a fallen-apart sequence measures roughly as wide as
        // its component parts combined, which is noticeably wider.
        return sequenceWidth < referenceWidth * 1.5;
    } catch {
        return false;
    }
}
