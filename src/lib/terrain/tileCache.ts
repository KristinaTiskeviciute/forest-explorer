export const tileCache = new Map<string, ImageData>();

export function tileKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}