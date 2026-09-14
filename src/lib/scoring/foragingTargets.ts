export const FORAGING_TARGETS = [
    "general",
    "chanterelle",
    "cep",
    "blueberry",
    "lingonberry",
    "cloudberry",
] as const;

export type ForagingTarget = (typeof FORAGING_TARGETS)[number];

export const FORAGING_TARGET_LABELS: Record<ForagingTarget, string> = {
    general: "General (balanced)",
    chanterelle: "Chanterelle",
    cep: "Cep / porcini",
    blueberry: "Blueberry",
    lingonberry: "Lingonberry",
    cloudberry: "Cloudberry",
};
