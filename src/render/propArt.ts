// Bespoke prop sprites. Optional per-shape image variants that the
// renderer prefers over the procedural draw functions in
// renderer.ts. Missing images fall back cleanly to the procedural
// path, so shipping N variants for a shape is fine even if the
// artist has only drawn 1 so far.
//
// Design:
//   - Each shape declares a list of variant paths (relative to
//     Vite's BASE_URL, files served out of public/).
//   - Sprites are drawn as BILLBOARDS (no iso projection applied)
//     anchored at bottom-center = the prop's world ground point.
//     Trees and rocks sit "on" the ground, not painted onto it.
//   - Variant selection is deterministic by entity id (index =
//     id % variants.length), so a specific prop always looks the
//     same across frames but the field reads as varied.
//   - Images load lazily on first request. Before an image is
//     ready, the renderer falls back to the procedural draw for
//     that prop.

import type { PropShape } from "../core/entity";

// Per-shape variant paths, in slot order. Position matters — a
// prop with entity.id % N picks slot (id % N), so re-ordering
// changes which specific trees are which variant.
export const PROP_SPRITE_VARIANTS: Partial<Record<PropShape, string[]>> = {
  tree: [
    "props/tree_1.png",
    "props/tree_2.png",
    "props/tree_3.png",
    "props/tree_4.png",
  ],
};

// Shared image cache. Same pattern as the arena background loader
// in renderer.ts — one HTMLImageElement per URL, ready check is
// img.complete && img.naturalWidth > 0. Errors leave the img
// forever "not ready" so the fallback path stays engaged.
const spriteCache: Map<string, HTMLImageElement> = new Map();

// Fetch (and lazily start loading) the sprite for a given prop.
// Returns the loaded HTMLImageElement, or null if no variant has
// been declared for this shape OR the picked variant hasn't loaded
// yet. Callers should paint the procedural fallback when null.
export function getPropSprite(
  shape: PropShape,
  entityId: number,
): HTMLImageElement | null {
  const variants = PROP_SPRITE_VARIANTS[shape];
  if (!variants || variants.length === 0) return null;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } })
    .env?.BASE_URL ?? "/";
  // Deterministic slot pick so a specific prop always renders the
  // same variant. Guarding against negative ids just in case.
  const idx = Math.abs(entityId) % variants.length;
  const url = base + variants[idx]!.replace(/^\/+/, "");
  let img = spriteCache.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    spriteCache.set(url, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  return null;
}
