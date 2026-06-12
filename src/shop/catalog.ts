// Shop catalog: characters, outfits, and skill upgrades players can
// purchase with their points. Add items to SHOP_CATALOG + name them in
// SHOP_ITEM_ORDER; the shop UI auto-renders them.
//
// Pattern mirrors src/achievements/catalog.ts on purpose — same ordered
// id list + dict-of-defs shape, so the storage/sync code can reuse the
// same approach.
//
// Three "Sample ..." stubs are included so the buy flow is testable
// end-to-end out of the box. Delete them by removing their entries
// from SHOP_CATALOG and SHOP_ITEM_ORDER once real items exist.

export type ShopItemKind = "character" | "outfit" | "upgrade" | "world";

export interface ShopItem {
  id: string;
  kind: ShopItemKind;
  name: string;
  description: string;
  price: number; // in points
  // For outfit: "any" makes it apply to every character; a specific
  //   character id restricts it to just that one.
  // For upgrade: the character whose ability is being upgraded.
  // For character: ignored.
  characterId?: string;
  // For upgrade: which ability id is being upgraded. Free-form tag —
  // the abilities system will look this up when the upgrade goes live.
  abilityId?: string;
  // v0 placeholder icon color (per-item draw functions can come later).
  iconColor?: string;
}

// Render order. Items not listed here are hidden from the shop even
// if they exist in the catalog dict (useful for hiding WIP items).
export const SHOP_ITEM_ORDER: string[] = [
  "sample_character",
  "sample_outfit",
  "sample_upgrade",
  "factory_world_key",
];

export const SHOP_CATALOG: Record<string, ShopItem> = {
  sample_character: {
    id: "sample_character",
    kind: "character",
    name: "Sample Character",
    description: "Placeholder — replace when a real character ships.",
    price: 25,
    iconColor: "#6b8e3b",
  },
  sample_outfit: {
    id: "sample_outfit",
    kind: "outfit",
    name: "Sample Outfit",
    description: "Universal skin — works on any character.",
    price: 10,
    characterId: "any",
    iconColor: "#a06a3e",
  },
  sample_upgrade: {
    id: "sample_upgrade",
    kind: "upgrade",
    name: "Sample Upgrade",
    description: "Buff a Slagy ability. No mechanical effect yet.",
    price: 15,
    characterId: "slagy",
    abilityId: "slime_shot",
    iconColor: "#7c4a8b",
  },
  factory_world_key: {
    id: "factory_world_key",
    kind: "world",
    name: "Factory World Key",
    description: "Skip the grind — unlocks Factory World immediately.",
    price: 60,
    iconColor: "#4a4f55",
  },
  sprint_boots: {
    id: "sprint_boots",
    kind: "upgrade",
    name: "Sprint Boots",
    description: "Hold Shift to sprint. +10% speed for 2s · 10s recharge (5s standing still).",
    price: 700,
    iconColor: "#ffd84a",
  },
  gravemarch: {
    id: "gravemarch",
    kind: "character",
    name: "Gravemarch",
    description: "Stone hunter — slow but unstoppable. Slash, Rock Wall, Rock Shield, Stone Step.",
    price: 1500,
    characterId: "gravemarch",
    iconColor: "#3a3e44",
  },
};

export function getShopItem(id: string): ShopItem | undefined {
  return SHOP_CATALOG[id];
}

export function shopItemsByKind(kind: ShopItemKind): ShopItem[] {
  return SHOP_ITEM_ORDER
    .map((id) => SHOP_CATALOG[id])
    .filter((item): item is ShopItem => !!item && item.kind === kind);
}

// True when the outfit applies to the given character (specific match
// or universal). Returns false for non-outfit kinds.
export function outfitAppliesTo(item: ShopItem, characterId: string): boolean {
  if (item.kind !== "outfit") return false;
  return item.characterId === "any" || item.characterId === characterId;
}

export function shopKindLabel(kind: ShopItemKind): string {
  switch (kind) {
    case "character": return "Characters";
    case "outfit":    return "Outfits";
    case "upgrade":   return "Upgrades";
    case "world":     return "Worlds";
  }
}

// v0 placeholder icon: rounded square in the item's color with the
// first letter of its name. Replace with per-item draw functions as
// real art comes in (same pattern as src/achievements/catalog.ts).
export function drawShopItemIcon(
  ctx: CanvasRenderingContext2D,
  item: ShopItem,
  x: number,   // top-left
  y: number,   // top-left
  size: number,
  owned: boolean,
): void {
  ctx.save();
  const color = item.iconColor ?? defaultColor(item.kind);
  ctx.globalAlpha = owned ? 1 : 0.95;
  ctx.fillStyle = color;
  const r = Math.max(4, size * 0.18);
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  // Soft inner highlight from upper-left to match the iso lighting
  // language used elsewhere in the renderer.
  const grad = ctx.createLinearGradient(x, y, x + size, y + size);
  grad.addColorStop(0, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = grad;
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  // Letter
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `bold ${Math.floor(size * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(item.name.charAt(0).toUpperCase(), x + size / 2, y + size / 2 + 1);
  ctx.restore();
}

function defaultColor(kind: ShopItemKind): string {
  switch (kind) {
    case "character": return "#6b8e3b"; // mossy green
    case "outfit":    return "#a06a3e"; // bronze
    case "upgrade":   return "#7c4a8b"; // royal purple
    case "world":     return "#4a4f55"; // steel-blue
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
