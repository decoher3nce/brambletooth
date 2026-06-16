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

import { CHARACTER_ART } from "../render/characterArt";

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
// Real items come first within each kind so they sit at the top of
// their tab; the sample stubs remain for buy-flow testing.
export const SHOP_ITEM_ORDER: string[] = [
  // Characters
  "gravemarch",
  "sample_character",
  // Outfits
  "sample_outfit",
  // Upgrades
  "sprint_boots",
  "axe",
  "sample_upgrade",
  // Worlds
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
  axe: {
    id: "axe",
    kind: "upgrade",
    name: "Axe",
    description: "Press C near a tree to chop it. The stump still blocks — useful for re-routing other players.",
    price: 300,
    iconColor: "#a0764a",
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

// Per-item icon. Routes by id to a bespoke drawer when one exists
// (character portraits, item silhouettes), otherwise falls back to
// the rounded-letter placeholder. Owned items render at full alpha;
// unowned at 0.95 to read as "purchasable, not yet yours."
export function drawShopItemIcon(
  ctx: CanvasRenderingContext2D,
  item: ShopItem,
  x: number,   // top-left
  y: number,   // top-left
  size: number,
  owned: boolean,
): void {
  ctx.save();
  ctx.globalAlpha = owned ? 1 : 0.95;
  const drawer = ICON_DRAWERS[item.id];
  if (drawer) {
    drawer(ctx, x, y, size, item);
  } else {
    drawLetterIcon(ctx, item, x, y, size);
  }
  ctx.restore();
}

type IconDrawer = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
  item: ShopItem,
) => void;

const ICON_DRAWERS: Record<string, IconDrawer> = {
  gravemarch: drawGravemarchIcon,
  sprint_boots: drawSprintBootsIcon,
  factory_world_key: drawFactoryKeyIcon,
  axe: drawAxeIcon,
};

// Frames a square iso card with a vertical color gradient, a thin
// inset highlight, and a soft top-left sheen. Shared chrome for the
// bespoke icons so they all read as part of the same shop UI.
function drawIconFrame(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
  topColor: string, botColor: string,
): void {
  const r = Math.max(4, size * 0.18);
  // Body gradient.
  const grad = ctx.createLinearGradient(x, y, x, y + size);
  grad.addColorStop(0, topColor);
  grad.addColorStop(1, botColor);
  ctx.fillStyle = grad;
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  // Top-left sheen.
  const sheen = ctx.createLinearGradient(x, y, x + size, y + size);
  sheen.addColorStop(0, "rgba(255,255,255,0.18)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0)");
  sheen.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.fillStyle = sheen;
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  // Inner stroke to give it edge definition.
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  roundRectPath(ctx, x + 0.5, y + 0.5, size - 1, size - 1, r - 0.5);
  ctx.stroke();
}

// Gravemarch portrait — stone-grey/blue gradient frame with the
// actual character art (head, neck, body, mace) rendered at portrait
// scale inside it. Clipped to the rounded frame so the mace can't
// stick out of the card.
function drawGravemarchIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
): void {
  drawIconFrame(ctx, x, y, size, "#3e4754", "#1c2128");
  // Subtle scratchy stone texture: a couple of darker bands.
  ctx.save();
  const r = Math.max(4, size * 0.18);
  roundRectPath(ctx, x, y, size, size, r);
  ctx.clip();
  ctx.fillStyle = "rgba(0,0,0,0.08)";
  ctx.fillRect(x, y + size * 0.62, size, size * 0.05);
  ctx.fillRect(x, y + size * 0.78, size, size * 0.04);
  // Render the character — full figure standing centered, scaled
  // to fit. Character art extends ~3r above cy and ~0.5r below,
  // so we anchor cy near the lower-third of the icon.
  const cx = x + size / 2;
  const cy = y + size * 0.78;
  const radius = size * 0.22;
  CHARACTER_ART.gravemarch!(
    ctx, cx, cy, radius, 0,
    { walkSpeed: 0, phase: 0 },
  );
  ctx.restore();
}

// Sprint Boots — warm amber frame with a BRIGHT YELLOW side-profile
// boot and a BLACK lightning bolt across the shaft. Reads at a
// glance even when shrunk into the small shop card; pairs visually
// with the in-world character overlay so a player who sees boots
// on someone's feet immediately recognizes the shop item.
function drawSprintBootsIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
): void {
  drawIconFrame(ctx, x, y, size, "#f0b94a", "#8a5a16");
  ctx.save();
  // Boot silhouette.
  const cx = x + size * 0.50;
  const cy = y + size * 0.55;
  const u = size * 0.012; // unit
  // Shaft + cuff (the leg part) — bright yellow.
  ctx.fillStyle = "#ffd84a";
  ctx.beginPath();
  // Top-left of cuff
  ctx.moveTo(cx - 16 * u, cy - 22 * u);
  ctx.lineTo(cx +  6 * u, cy - 22 * u);
  ctx.lineTo(cx +  8 * u, cy -  6 * u);
  // toe forward
  ctx.lineTo(cx + 24 * u, cy +  2 * u);
  ctx.lineTo(cx + 26 * u, cy + 10 * u);
  ctx.lineTo(cx + 22 * u, cy + 14 * u);
  ctx.lineTo(cx - 18 * u, cy + 14 * u);
  ctx.lineTo(cx - 20 * u, cy +  8 * u);
  ctx.lineTo(cx - 14 * u, cy -  6 * u);
  ctx.closePath();
  ctx.fill();
  // Outline for definition against the yellow frame.
  ctx.strokeStyle = "#1a0e08";
  ctx.lineWidth = Math.max(1, u * 1.4);
  ctx.stroke();
  // Sole — dark.
  ctx.fillStyle = "#1a0e08";
  ctx.beginPath();
  ctx.moveTo(cx - 20 * u, cy + 12 * u);
  ctx.lineTo(cx + 24 * u, cy + 12 * u);
  ctx.lineTo(cx + 22 * u, cy + 16 * u);
  ctx.lineTo(cx - 18 * u, cy + 16 * u);
  ctx.closePath();
  ctx.fill();
  // Heel notch.
  ctx.fillRect(cx - 18 * u, cy + 14 * u, 6 * u, 6 * u);
  // Cuff fold band — slightly darker yellow so it reads as a separate panel.
  ctx.fillStyle = "#caa030";
  ctx.fillRect(cx - 16 * u, cy - 22 * u, 22 * u, 4 * u);
  // Lightning bolt across the shaft — BLACK now, painted over the yellow.
  ctx.fillStyle = "#0a0a0a";
  ctx.strokeStyle = "#0a0a0a";
  ctx.lineWidth = Math.max(1, u * 1.0);
  ctx.beginPath();
  ctx.moveTo(cx - 4 * u, cy - 18 * u);
  ctx.lineTo(cx - 12 * u, cy - 2 * u);
  ctx.lineTo(cx - 4 * u, cy - 2 * u);
  ctx.lineTo(cx - 10 * u, cy + 12 * u);
  ctx.lineTo(cx + 4 * u, cy - 6 * u);
  ctx.lineTo(cx - 2 * u, cy - 6 * u);
  ctx.lineTo(cx + 6 * u, cy - 18 * u);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Factory World Key — steel frame with a brass skeleton key. The
// bow (handle ring) reads as "world" since this item unlocks an
// entire world.
function drawFactoryKeyIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
): void {
  drawIconFrame(ctx, x, y, size, "#5a6168", "#2a2e34");
  ctx.save();
  const u = size * 0.012;
  const cx = x + size * 0.5;
  const cy = y + size * 0.5;
  // Rotate the key 25° clockwise so it has some swagger.
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 7);
  ctx.translate(-cx, -cy);
  // Bow (handle).
  const bowCx = cx - 18 * u;
  const bowR = 11 * u;
  ctx.fillStyle = "#e8b04a";
  ctx.beginPath();
  ctx.arc(bowCx, cy, bowR, 0, Math.PI * 2);
  ctx.fill();
  // Bow inner hole.
  ctx.fillStyle = "#2a2e34";
  ctx.beginPath();
  ctx.arc(bowCx, cy, bowR * 0.55, 0, Math.PI * 2);
  ctx.fill();
  // Bow rim highlight.
  ctx.strokeStyle = "#fde29a";
  ctx.lineWidth = Math.max(1, u * 0.8);
  ctx.beginPath();
  ctx.arc(bowCx, cy, bowR - u * 0.6, Math.PI * 1.05, Math.PI * 1.75);
  ctx.stroke();
  // Shaft.
  ctx.fillStyle = "#e8b04a";
  ctx.fillRect(bowCx + bowR - u, cy - 3 * u, 28 * u, 6 * u);
  // Shaft shadow line.
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(bowCx + bowR - u, cy + u, 28 * u, 2 * u);
  // Two teeth.
  const tipX = bowCx + bowR - u + 28 * u;
  ctx.fillStyle = "#e8b04a";
  ctx.fillRect(tipX - 12 * u, cy + 3 * u, 4 * u, 6 * u);
  ctx.fillRect(tipX -  4 * u, cy + 3 * u, 4 * u, 4 * u);
  // Subtle outline on the whole key for definition.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(1, u * 0.7);
  ctx.beginPath();
  ctx.arc(bowCx, cy, bowR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeRect(bowCx + bowR - u, cy - 3 * u, 28 * u, 6 * u);
  ctx.restore();
}

// Axe — warm-wood frame with an angled wooden haft and a polished
// steel head. The blade catches a thin highlight so the icon reads
// as a tool (not a static block) at small sizes.
function drawAxeIcon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
): void {
  drawIconFrame(ctx, x, y, size, "#a0764a", "#3d2716");
  ctx.save();
  const u = size * 0.012;
  const cx = x + size * 0.5;
  const cy = y + size * 0.5;
  // Rotate the whole tool so it sits diagonal across the icon —
  // gives it the same swagger as the key.
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4.5);
  ctx.translate(-cx, -cy);
  // Haft (wood handle).
  ctx.fillStyle = "#6b4528";
  ctx.fillRect(cx - 22 * u, cy - 3 * u, 44 * u, 6 * u);
  // Haft grain — two thin lines along the length.
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(cx - 22 * u, cy - 2 * u, 44 * u, u * 0.8);
  ctx.fillStyle = "rgba(0,0,0,0.20)";
  ctx.fillRect(cx - 22 * u, cy + u * 1.2, 44 * u, u * 0.8);
  // Pommel cap at the butt end.
  ctx.fillStyle = "#3d2716";
  ctx.fillRect(cx - 24 * u, cy - 4 * u, 4 * u, 8 * u);
  // Axe head — steel blade swept forward + outward. Drawn as a
  // pentagon: rear seat against the haft, two top points, sharp
  // tip, and bottom curve back to the seat.
  ctx.fillStyle = "#c8ccd2";
  ctx.beginPath();
  ctx.moveTo(cx + 14 * u, cy - 4 * u);  // rear top
  ctx.lineTo(cx + 24 * u, cy - 14 * u); // upper outer point
  ctx.lineTo(cx + 30 * u, cy - 2 * u);  // sharp leading tip
  ctx.lineTo(cx + 22 * u, cy + 12 * u); // lower outer point
  ctx.lineTo(cx + 14 * u, cy + 4 * u);  // rear bottom
  ctx.closePath();
  ctx.fill();
  // Blade edge highlight — bright line along the sharpened curve.
  ctx.strokeStyle = "#f4f6fa";
  ctx.lineWidth = Math.max(1, u * 1.2);
  ctx.beginPath();
  ctx.moveTo(cx + 24 * u, cy - 14 * u);
  ctx.lineTo(cx + 30 * u, cy - 2 * u);
  ctx.lineTo(cx + 22 * u, cy + 12 * u);
  ctx.stroke();
  // Shadow band along the back of the head where it seats on the haft.
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.fillRect(cx + 12 * u, cy - 4 * u, 4 * u, 8 * u);
  // Outline.
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = Math.max(1, u * 0.8);
  ctx.beginPath();
  ctx.moveTo(cx + 14 * u, cy - 4 * u);
  ctx.lineTo(cx + 24 * u, cy - 14 * u);
  ctx.lineTo(cx + 30 * u, cy - 2 * u);
  ctx.lineTo(cx + 22 * u, cy + 12 * u);
  ctx.lineTo(cx + 14 * u, cy + 4 * u);
  ctx.closePath();
  ctx.stroke();
  ctx.strokeRect(cx - 22 * u, cy - 3 * u, 44 * u, 6 * u);
  ctx.restore();
}

// Fallback: rounded square in the item's color with the first
// letter of its name. Used for items without a bespoke drawer.
function drawLetterIcon(
  ctx: CanvasRenderingContext2D,
  item: ShopItem,
  x: number, y: number, size: number,
): void {
  const color = item.iconColor ?? defaultColor(item.kind);
  ctx.fillStyle = color;
  const r = Math.max(4, size * 0.18);
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  const grad = ctx.createLinearGradient(x, y, x + size, y + size);
  grad.addColorStop(0, "rgba(255,255,255,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = grad;
  roundRectPath(ctx, x, y, size, size, r);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `bold ${Math.floor(size * 0.5)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(item.name.charAt(0).toUpperCase(), x + size / 2, y + size / 2 + 1);
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
