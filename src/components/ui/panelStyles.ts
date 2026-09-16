import type { CSSProperties } from "react";

/** Shared look for the top-level cards stacked in the right-hand sidebar
 *  (intro, selected location, data layers) so spacing and title sizing
 *  stay consistent as sections are added or reordered. */
export const PANEL_CARD_STYLE: CSSProperties = {
    background: "var(--fe-card-bg)",
    border: "1px solid var(--fe-border)",
    borderRadius: 10,
    padding: "12px 14px",
    marginBottom: 16,
    boxShadow: "var(--fe-shadow-sm)",
};

export const PANEL_CARD_TITLE_STYLE: CSSProperties = {
    margin: "0 0 10px",
    fontSize: 15,
    fontWeight: 600,
    paddingBottom: 8,
    borderBottom: "1px solid var(--fe-border)",
};
