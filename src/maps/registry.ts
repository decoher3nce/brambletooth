// World + Map registry. Top-level container ("World") groups a set of
// individual playable levels ("Map"). Campaign mode walks each map in
// a world in sequence; Vs Computer lets the player pick any map the
// world has unlocked; Multiplayer lets the lobby vote on a map from
// the intersection of everyone's completed-maps set.
//
// Add a new map: append a MapDef to a world's `maps` list.
// Add a new world: append a WorldDef to WORLDS, with an `unlock` rule
// describing how a profile earns access (default = always available,
// after-world = needs N maps completed in a previous world, shop = a
// purchase token in inventory).
//
// Each map names its own arena builder. v1 ships exactly the forest
// arena for the one shipped map (Forest Map 1); future maps will
// register their own builders or per-map seeds / arena variations.

import type { ArenaConfig, World } from "../core/world";
import {
  FOREST_ARENA_CONFIG,
  buildForest,
  buildForest2,
  buildForest3,
  buildForest4,
  buildForest5,
} from "../arenas/forest";
import { FACTORY_ARENA_CONFIG, buildFactory, buildFactory2, buildFactory3, buildFactory4 } from "../arenas/factory";
import { CAVE_ARENA_CONFIG, buildCave1 } from "../arenas/cave";
import { VOLCANO_ARENA_CONFIG, buildVolcano1 } from "../arenas/volcano";

// How many maps must be completed in a world to unlock the next via
// the default "after-world" gate.
export const WORLDS_REQUIRED_MAPS = 5;

export interface MapDef {
  id: string;          // unique across all worlds — profiles store ids
  name: string;        // "The Glade", "Streams" — no "Map #" prefix
  worldId: string;     // parent world id (denormalized for cheap lookups)
  // Arena config + builder. The builder is called after `new World(config)`
  // to populate props/objectives; the engine spawns characters + the exit.
  arenaConfig: ArenaConfig;
  buildArena: (world: World, seed: number, objectiveCount: number) => void;
  // Iso-style preview drawn into the map-select tile. Receives the
  // canvas + the tile's content rect (already clipped by the caller).
  // If omitted, the renderer falls back to a generic forest scene.
  thumbnail?: (
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
  ) => void;
}

export type WorldUnlock =
  // Always playable — no campaign progress needed.
  | { kind: "default" }
  // Locked until the player has completed >= mapsNeeded maps in the
  // referenced earlier world.
  | { kind: "after-world"; previousWorldId: string; mapsNeeded: number }
  // Locked until the player owns this shop item (purchased token).
  | { kind: "shop"; shopItemId: string }
  // Either path unlocks: complete the previous world OR buy the
  // shop token. Useful for "skip the grind" content.
  | {
      kind: "after-world-or-shop";
      previousWorldId: string;
      mapsNeeded: number;
      shopItemId: string;
    };

export interface WorldDef {
  id: string;
  name: string;            // "Forest World"
  maps: MapDef[];          // ordered; index 0 is the first map
  unlock: WorldUnlock;
  // Optional palette accent for the campaign world card.
  accentColor?: string;
}

// ---- Forest World — only the first map exists today. ----

// ---- Per-map iso-style thumbnails ----
// All forest maps share a base tile (iso green ground + a few
// trees + the exit portal in the SE corner) painted by drawForestBase.
// Each map's thumbnail then layers its distinctive feature on top.
function drawForestBase(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  // Ground tile painted in two iso bands for a hint of depth.
  ctx.fillStyle = "#2a4626";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#34522e";
  ctx.beginPath();
  ctx.moveTo(x, y + h * 0.4);
  ctx.lineTo(x + w, y + h * 0.4);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fill();
  // Subtle iso grid in the foreground.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = -h; i < w + h; i += 18) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h * 2, y);
    ctx.stroke();
  }
  // Scatter four iso trees (cones with brown trunks).
  const treeSpots: [number, number][] = [
    [0.18, 0.45], [0.62, 0.35], [0.36, 0.62], [0.85, 0.55],
  ];
  for (const [fx, fy] of treeSpots) {
    drawIsoTree(ctx, x + w * fx, y + h * fy, w * 0.07);
  }
  // Exit portal — SE corner glow.
  const ex = x + w * 0.86;
  const ey = y + h * 0.82;
  const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, w * 0.12);
  eg.addColorStop(0, "rgba(170, 240, 180, 0.9)");
  eg.addColorStop(1, "rgba(170, 240, 180, 0)");
  ctx.fillStyle = eg;
  ctx.beginPath();
  ctx.ellipse(ex, ey, w * 0.13, w * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
}
function drawIsoTree(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, scale: number,
): void {
  // Trunk
  ctx.fillStyle = "#3d2814";
  ctx.fillRect(cx - scale * 0.4, cy, scale * 0.8, scale * 1.2);
  // Cone canopy (two layered triangles for depth)
  ctx.fillStyle = "#2a5a30";
  ctx.beginPath();
  ctx.moveTo(cx, cy - scale * 1.8);
  ctx.lineTo(cx - scale * 1.5, cy);
  ctx.lineTo(cx + scale * 1.5, cy);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#356e3a";
  ctx.beginPath();
  ctx.moveTo(cx, cy - scale * 1.4);
  ctx.lineTo(cx - scale * 1.1, cy - scale * 0.2);
  ctx.lineTo(cx + scale * 1.1, cy - scale * 0.2);
  ctx.closePath();
  ctx.fill();
}
function thumbForest1(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawForestBase(ctx, x, y, w, h);
}
function thumbForest2(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawForestBase(ctx, x, y, w, h);
  // Meandering river through the middle — built as a quadratic
  // curve through 4 control points so the thumbnail matches the
  // in-world serpentine shape.
  const sy = y + h * 0.58;
  const pts = [
    { x: x + w * 0.05, y: sy + h * 0.04 },
    { x: x + w * 0.32, y: sy - h * 0.06 },
    { x: x + w * 0.62, y: sy + h * 0.07 },
    { x: x + w * 0.95, y: sy - h * 0.03 },
  ];
  const drawCurve = (lineWidth: number, color: string) => {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
      const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawCurve(h * 0.20, "rgba(196, 168, 110, 0.7)");  // bank
  drawCurve(h * 0.13, "rgba(80, 150, 200, 0.88)");  // water
  drawCurve(h * 0.06, "rgba(180, 220, 240, 0.55)"); // shimmer
  ctx.restore();
}
function thumbForest3(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawForestBase(ctx, x, y, w, h);
  // Cliff edge — horizontal dark line + hatched shadow below.
  const cy = y + h * 0.5;
  ctx.fillStyle = "rgba(20, 14, 8, 0.55)";
  ctx.fillRect(x + 4, cy, w - 8, h * 0.13);
  ctx.strokeStyle = "#0a0806";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x + 4, cy);
  ctx.lineTo(x + w - 4, cy);
  ctx.stroke();
  ctx.strokeStyle = "rgba(40, 28, 18, 0.7)";
  ctx.lineWidth = 1;
  for (let s = 0; s < w; s += 8) {
    ctx.beginPath();
    ctx.moveTo(x + s, cy);
    ctx.lineTo(x + s + 4, cy + h * 0.13);
    ctx.stroke();
  }
}
function thumbForest4(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawForestBase(ctx, x, y, w, h);
  // Small bear (foreground) + small deer (mid-back).
  drawThumbBear(ctx, x + w * 0.42, y + h * 0.72, w * 0.09);
  drawThumbDeer(ctx, x + w * 0.7, y + h * 0.5, w * 0.07);
}
function thumbForest5(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawForestBase(ctx, x, y, w, h);
  // Cliff in the upper third
  const cy = y + h * 0.38;
  ctx.fillStyle = "rgba(20, 14, 8, 0.5)";
  ctx.fillRect(x + 4, cy, w - 8, h * 0.09);
  ctx.strokeStyle = "#0a0806";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x + 4, cy);
  ctx.lineTo(x + w - 4, cy);
  ctx.stroke();
  // Meandering stream in the lower third — same quadratic curve
  // shape as Map 2 but smaller / lower placement.
  const ssy = y + h * 0.75;
  const spts = [
    { x: x + w * 0.07, y: ssy + h * 0.03 },
    { x: x + w * 0.36, y: ssy - h * 0.04 },
    { x: x + w * 0.64, y: ssy + h * 0.05 },
    { x: x + w * 0.93, y: ssy - h * 0.02 },
  ];
  const drawSCurve = (lineWidth: number, color: string) => {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(spts[0]!.x, spts[0]!.y);
    for (let i = 1; i < spts.length - 1; i++) {
      const mx = (spts[i]!.x + spts[i + 1]!.x) / 2;
      const my = (spts[i]!.y + spts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(spts[i]!.x, spts[i]!.y, mx, my);
    }
    ctx.lineTo(spts[spts.length - 1]!.x, spts[spts.length - 1]!.y);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawSCurve(h * 0.13, "rgba(196, 168, 110, 0.65)");
  drawSCurve(h * 0.09, "rgba(80, 150, 200, 0.88)");
  ctx.restore();
  // Animal centerpiece
  drawThumbBear(ctx, x + w * 0.32, y + h * 0.62, w * 0.07);
}
function drawThumbBear(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, scale: number,
): void {
  ctx.fillStyle = "#3d2716";
  ctx.beginPath();
  ctx.ellipse(cx, cy, scale * 1.2, scale * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + scale * 0.7, cy - scale * 0.6, scale * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(cx + scale * 0.95, cy - scale * 0.65, scale * 0.1, 0, Math.PI * 2);
  ctx.fill();
}
function drawThumbDeer(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, scale: number,
): void {
  ctx.fillStyle = "#8a6033";
  ctx.beginPath();
  ctx.ellipse(cx, cy, scale * 1.3, scale * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + scale * 0.9, cy - scale * 0.7, scale * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#dccaa0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx + scale * 0.85, cy - scale * 1);
  ctx.lineTo(cx + scale * 0.8, cy - scale * 1.4);
  ctx.moveTo(cx + scale * 1, cy - scale * 1);
  ctx.lineTo(cx + scale * 1.05, cy - scale * 1.4);
  ctx.stroke();
}

// ---- Factory World thumbnails ----
// Shared cold-industrial base: concrete floor + faint yellow safety
// grid + steel-edge fence outline + SE-corner exit glow. Per-map
// overlays layer specific factory features (machinery, etc.).
function drawFactoryBase(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  // Concrete ground — gray with faint horizontal bands.
  ctx.fillStyle = "#3a3e44";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#43484f";
  ctx.fillRect(x, y + h * 0.42, w, h * 0.58);
  // Yellow safety stripe diagonals
  ctx.strokeStyle = "rgba(255, 200, 80, 0.18)";
  ctx.lineWidth = 1;
  for (let i = -h; i < w + h; i += 14) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h * 1.4, y);
    ctx.stroke();
  }
  // Iso crates scattered around
  const crates: [number, number, number][] = [
    [0.18, 0.40, 0.07], [0.55, 0.32, 0.08], [0.40, 0.66, 0.075], [0.78, 0.55, 0.065],
  ];
  for (const [fx, fy, fs] of crates) {
    drawThumbCrate(ctx, x + w * fx, y + h * fy, w * fs);
  }
  // Exit glow SE corner
  const ex = x + w * 0.86;
  const ey = y + h * 0.82;
  const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, w * 0.12);
  eg.addColorStop(0, "rgba(170, 240, 180, 0.85)");
  eg.addColorStop(1, "rgba(170, 240, 180, 0)");
  ctx.fillStyle = eg;
  ctx.beginPath();
  ctx.ellipse(ex, ey, w * 0.13, w * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
}
function drawThumbCrate(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, scale: number,
): void {
  // Tiny iso "cube" — same construction as the in-world crate
  // shrunk to thumb scale.
  ctx.fillStyle = "#6a4a2a";
  ctx.fillRect(cx - scale, cy - scale, scale * 2, scale * 1.6);
  ctx.fillStyle = "#a07e4d";
  ctx.beginPath();
  ctx.moveTo(cx - scale, cy - scale);
  ctx.lineTo(cx, cy - scale * 1.4);
  ctx.lineTo(cx + scale, cy - scale);
  ctx.lineTo(cx, cy - scale * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#3d2814";
  ctx.lineWidth = 0.8;
  ctx.strokeRect(cx - scale, cy - scale, scale * 2, scale * 1.6);
}
function thumbFactory1(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawFactoryBase(ctx, x, y, w, h);
}

// Helper: paint one conveyor belt strip on the thumbnail with
// hazard stripes + flow arrow pointing in `dir` (+1 right, -1 left).
function drawThumbBelt(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  yFrac: number, dir: 1 | -1,
): void {
  const beltY = y + h * yFrac;
  const beltH = h * 0.16;
  const beltX0 = x + w * 0.06;
  const beltX1 = x + w * 0.94;
  // Black belt surface
  ctx.fillStyle = "#1a1d20";
  ctx.fillRect(beltX0, beltY - beltH / 2, beltX1 - beltX0, beltH);
  // Hazard stripes on top + bottom edges
  ctx.fillStyle = "rgba(255, 200, 80, 0.85)";
  const stripeH = 2;
  ctx.fillRect(beltX0, beltY - beltH / 2 - stripeH, beltX1 - beltX0, stripeH);
  ctx.fillRect(beltX0, beltY + beltH / 2, beltX1 - beltX0, stripeH);
  // Belt hash marks
  ctx.strokeStyle = "rgba(180, 195, 210, 0.5)";
  ctx.lineWidth = 1.5;
  const stripeCount = 6;
  for (let i = 0; i < stripeCount; i++) {
    const sx = beltX0 + (beltX1 - beltX0) * (i + 0.5) / stripeCount;
    ctx.beginPath();
    ctx.moveTo(sx, beltY - beltH / 2 + 1);
    ctx.lineTo(sx, beltY + beltH / 2 - 1);
    ctx.stroke();
  }
  // Flow arrow in the center
  ctx.strokeStyle = "#ffd84a";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const midX = (beltX0 + beltX1) / 2;
  ctx.beginPath();
  ctx.moveTo(midX - w * 0.05 * dir, beltY);
  ctx.lineTo(midX + w * 0.05 * dir, beltY);
  ctx.moveTo(midX + w * 0.03 * dir, beltY - h * 0.025);
  ctx.lineTo(midX + w * 0.05 * dir, beltY);
  ctx.lineTo(midX + w * 0.03 * dir, beltY + h * 0.025);
  ctx.stroke();
  // Rollers at each end
  ctx.fillStyle = "#3a3e44";
  ctx.beginPath();
  ctx.arc(beltX0, beltY, beltH * 0.55, 0, Math.PI * 2);
  ctx.arc(beltX1, beltY, beltH * 0.55, 0, Math.PI * 2);
  ctx.fill();
}

function thumbFactory2(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawFactoryBase(ctx, x, y, w, h);
  drawThumbBelt(ctx, x, y, w, h, 0.36, 1);  // north belt — east
  drawThumbBelt(ctx, x, y, w, h, 0.70, -1); // south belt — west
}

// Half-width belt strip: x0Frac and x1Frac as 0..1 of the tile.
// Variant 'ground' draws a plain belt; 'catwalk' draws it darker
// with a faint drop shadow + a small gear icon at the inner end
// (to read as elevated machinery). 'showGears' draws a tiny gear
// at each end. Mirrors the runtime renderer style at thumb scale.
function drawThumbBeltSegment(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  yFrac: number, x0Frac: number, x1Frac: number,
  dir: 1 | -1,
  variant: "ground" | "catwalk",
): void {
  const beltY = y + h * yFrac;
  const beltH = h * 0.13;
  const beltX0 = x + w * x0Frac;
  const beltX1 = x + w * x1Frac;
  // Drop shadow under catwalks.
  if (variant === "catwalk") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(beltX0 + 2, beltY - beltH / 2 + 4, beltX1 - beltX0, beltH);
  }
  // Belt body.
  ctx.fillStyle = variant === "catwalk" ? "#15171a" : "#1a1d20";
  ctx.fillRect(beltX0, beltY - beltH / 2, beltX1 - beltX0, beltH);
  // Hazard stripes on top + bottom edges.
  ctx.fillStyle = "rgba(255, 200, 80, 0.85)";
  const stripeH = 2;
  ctx.fillRect(beltX0, beltY - beltH / 2 - stripeH, beltX1 - beltX0, stripeH);
  ctx.fillRect(beltX0, beltY + beltH / 2, beltX1 - beltX0, stripeH);
  // Belt hash marks (fewer than full-belt thumbnail).
  ctx.strokeStyle = "rgba(180, 195, 210, 0.5)";
  ctx.lineWidth = 1.2;
  const stripeCount = 4;
  for (let i = 0; i < stripeCount; i++) {
    const sx = beltX0 + (beltX1 - beltX0) * (i + 0.5) / stripeCount;
    ctx.beginPath();
    ctx.moveTo(sx, beltY - beltH / 2 + 1);
    ctx.lineTo(sx, beltY + beltH / 2 - 1);
    ctx.stroke();
  }
  // Tiny flow arrow.
  ctx.strokeStyle = "#ffd84a";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  const midX = (beltX0 + beltX1) / 2;
  ctx.beginPath();
  ctx.moveTo(midX - w * 0.025 * dir, beltY);
  ctx.lineTo(midX + w * 0.025 * dir, beltY);
  ctx.moveTo(midX + w * 0.015 * dir, beltY - h * 0.02);
  ctx.lineTo(midX + w * 0.025 * dir, beltY);
  ctx.lineTo(midX + w * 0.015 * dir, beltY + h * 0.02);
  ctx.stroke();
  // Toothed gear at each end (small, decorative).
  for (const ex of [beltX0, beltX1]) {
    drawThumbGear(ctx, ex, beltY, beltH * 0.55);
  }
}

// Small toothed gear glyph for thumbnail end caps.
function drawThumbGear(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
): void {
  const teeth = 8;
  const rO = r;
  const rI = r * 0.72;
  ctx.fillStyle = "#2a2e34";
  ctx.beginPath();
  const segCount = teeth * 2;
  for (let i = 0; i < segCount; i++) {
    const ang = (i / segCount) * Math.PI * 2;
    const rr = i % 2 === 0 ? rO : rI;
    const px = cx + Math.cos(ang) * rr;
    const py = cy + Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#7a8490";
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.fillStyle = "#5a6470";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

function thumbFactory3(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawFactoryBase(ctx, x, y, w, h);
  // Top chain — west half ground → east half catwalk, both east-flow.
  drawThumbBeltSegment(ctx, x, y, w, h, 0.32, 0.06, 0.50, 1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.32, 0.50, 0.94, 1, "catwalk");
  // Bottom chain — east half catwalk, west half ground, both west-flow.
  drawThumbBeltSegment(ctx, x, y, w, h, 0.74, 0.50, 0.94, -1, "catwalk");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.74, 0.06, 0.50, -1, "ground");
}

// Tiny silver dome + green LED — Factory Map 4's sweeper bot,
// shrunk to a thumbnail icon.
function drawThumbSweeperBot(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
): void {
  ctx.fillStyle = "#9aa5b0";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#222830";
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = "#5af0c4";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

// Thumb-scale welder bot: arm on a pillar.
function drawThumbWelderBot(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
): void {
  ctx.fillStyle = "#3a3e44";
  ctx.fillRect(cx - r * 0.4, cy - r * 0.2, r * 0.8, r * 1.0);
  ctx.fillStyle = "#9aa3ad";
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.2, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#6e7681";
  ctx.lineWidth = r * 0.35;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.2);
  ctx.lineTo(cx + r * 0.9, cy - r * 0.6);
  ctx.stroke();
}

function thumbFactory4(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawFactoryBase(ctx, x, y, w, h);
  // Several short belt segments in varied directions — quick
  // doodles that match the in-map layout vibe.
  drawThumbBeltSegment(ctx, x, y, w, h, 0.20, 0.08, 0.32, 1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.20, 0.38, 0.62, 1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.20, 0.70, 0.92, 1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.78, 0.08, 0.32, -1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.78, 0.38, 0.62, -1, "ground");
  drawThumbBeltSegment(ctx, x, y, w, h, 0.78, 0.70, 0.92, -1, "ground");
  // Two robot icons in the center.
  drawThumbSweeperBot(ctx, x + w * 0.32, y + h * 0.50, Math.min(w, h) * 0.05);
  drawThumbSweeperBot(ctx, x + w * 0.68, y + h * 0.55, Math.min(w, h) * 0.05);
  drawThumbWelderBot(ctx, x + w * 0.50, y + h * 0.48, Math.min(w, h) * 0.06);
}

const FOREST_MAPS: MapDef[] = [
  {
    id: "forest_1",
    name: "The Glade",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    // The current arena builder takes a (world, seed, objectiveCount).
    // HuntMode owns objective spawning so objectiveCount stays 0.
    buildArena: (w, seed) => buildForest(w, seed, 0),
    thumbnail: thumbForest1,
  },
  {
    id: "forest_2",
    name: "Streams",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest2(w, seed, 0),
    thumbnail: thumbForest2,
  },
  {
    id: "forest_3",
    name: "Cliffs",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest3(w, seed, 0),
    thumbnail: thumbForest3,
  },
  {
    id: "forest_4",
    name: "Wildlife",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest4(w, seed, 0),
    thumbnail: thumbForest4,
  },
  {
    id: "forest_5",
    name: "The Gauntlet",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest5(w, seed, 0),
    thumbnail: thumbForest5,
  },
];

const FACTORY_MAPS: MapDef[] = [
  {
    id: "factory_1",
    name: "Loading Dock",
    worldId: "factory",
    arenaConfig: FACTORY_ARENA_CONFIG,
    buildArena: (w, seed) => buildFactory(w, seed, 0),
    thumbnail: thumbFactory1,
  },
  {
    id: "factory_2",
    name: "The Belt",
    worldId: "factory",
    arenaConfig: FACTORY_ARENA_CONFIG,
    buildArena: (w, seed) => buildFactory2(w, seed, 0),
    thumbnail: thumbFactory2,
  },
  {
    id: "factory_3",
    name: "Catwalks",
    worldId: "factory",
    arenaConfig: FACTORY_ARENA_CONFIG,
    buildArena: (w, seed) => buildFactory3(w, seed, 0),
    thumbnail: thumbFactory3,
  },
  {
    id: "factory_4",
    name: "Assembly Floor",
    worldId: "factory",
    arenaConfig: FACTORY_ARENA_CONFIG,
    buildArena: (w, seed) => buildFactory4(w, seed, 0),
    thumbnail: thumbFactory4,
  },
];

// Cave Map base tile: black floor with a few stalagmites and one
// purple crystal cluster. Distinct silhouette so the map-select
// reads as "low vision biome" without needing an in-game preview.
function drawCaveBase(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = "#0a0a14";
  ctx.fillRect(x, y, w, h);
  // Subtle vignette toward the corners.
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(x, y, w, h);
  // Stalagmites (small jagged spikes).
  ctx.fillStyle = "#2e2e3a";
  for (const [px, py, ph] of [
    [0.2, 0.55, 0.18],
    [0.36, 0.7, 0.13],
    [0.66, 0.6, 0.16],
    [0.82, 0.78, 0.11],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x + w * px, y + h * py);
    ctx.lineTo(x + w * (px - 0.04), y + h * (py + ph));
    ctx.lineTo(x + w * (px + 0.04), y + h * (py + ph));
    ctx.closePath();
    ctx.fill();
  }
  // Glowing crystal cluster.
  const cx = x + w * 0.52;
  const cy = y + h * 0.68;
  ctx.fillStyle = "rgba(170, 120, 255, 0.45)";
  ctx.beginPath();
  ctx.ellipse(cx, cy + 4, w * 0.13, h * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy, dh, fill] of [
    [-0.06, 0, 0.14, "#a070ff"],
    [ 0.06, -0.02, 0.16, "#9e6cff"],
    [ 0.00, -0.06, 0.20, "#c69aff"],
  ] as const) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(cx + w * dx, cy + h * dy - h * dh);
    ctx.lineTo(cx + w * (dx + 0.025), cy + h * (dy - dh * 0.55));
    ctx.lineTo(cx + w * (dx + 0.025), cy + h * (dy - dh * 0.15));
    ctx.lineTo(cx + w * dx, cy + h * dy);
    ctx.lineTo(cx + w * (dx - 0.025), cy + h * (dy - dh * 0.15));
    ctx.lineTo(cx + w * (dx - 0.025), cy + h * (dy - dh * 0.55));
    ctx.closePath();
    ctx.fill();
  }
  // Exit pocket in SE corner (cool teal glow).
  ctx.fillStyle = "rgba(80, 200, 220, 0.4)";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.88, y + h * 0.88, w * 0.07, h * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();
}

function thumbCave1(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawCaveBase(ctx, x, y, w, h);
}

// ---- Volcano World thumbnails ----
// Dark volcanic ground + a small iso volcano cone in the center
// with a glowing crater + four lava arms radiating outward to the
// tile edges. Mirrors the in-world centerpiece + radial lava
// layout so the tile reads instantly as "the volcano map."
function drawVolcanoBase(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  // Charcoal / basalt ground with a faint warm-red horizon band.
  ctx.fillStyle = "#1a1110";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#28181a";
  ctx.fillRect(x, y + h * 0.42, w, h * 0.58);
  // Faint ash-smear iso lines.
  ctx.strokeStyle = "rgba(255, 140, 60, 0.06)";
  ctx.lineWidth = 1;
  for (let i = -h; i < w + h; i += 16) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h * 2, y);
    ctx.stroke();
  }
  // Volcano cone in the center.
  const cx = x + w * 0.5;
  const cy = y + h * 0.62;
  const peakY = y + h * 0.22;
  // Lit slope.
  ctx.fillStyle = "#4e3a30";
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.32, cy);
  ctx.lineTo(cx - w * 0.10, y + h * 0.34);
  ctx.lineTo(cx + w * 0.02, peakY);
  ctx.lineTo(cx + w * 0.10, y + h * 0.28);
  ctx.lineTo(cx + w * 0.10, cy);
  ctx.closePath();
  ctx.fill();
  // Shadow slope.
  ctx.fillStyle = "#2c1e18";
  ctx.beginPath();
  ctx.moveTo(cx + w * 0.10, cy);
  ctx.lineTo(cx + w * 0.10, y + h * 0.28);
  ctx.lineTo(cx + w * 0.20, y + h * 0.36);
  ctx.lineTo(cx + w * 0.32, cy);
  ctx.closePath();
  ctx.fill();
  // Outline so the cone reads from across the screen.
  ctx.strokeStyle = "#13090a";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.32, cy);
  ctx.lineTo(cx - w * 0.10, y + h * 0.34);
  ctx.lineTo(cx + w * 0.02, peakY);
  ctx.lineTo(cx + w * 0.10, y + h * 0.28);
  ctx.lineTo(cx + w * 0.20, y + h * 0.36);
  ctx.lineTo(cx + w * 0.32, cy);
  ctx.stroke();
  // Crater rim + molten glow.
  const craterX = cx + w * 0.04;
  const craterY = peakY + h * 0.03;
  ctx.fillStyle = "#1a0e0a";
  ctx.beginPath();
  ctx.ellipse(craterX, craterY, w * 0.06, w * 0.025, 0, 0, Math.PI * 2);
  ctx.fill();
  const craterGlow = ctx.createRadialGradient(craterX, craterY, 0, craterX, craterY, w * 0.12);
  craterGlow.addColorStop(0, "rgba(255, 240, 160, 0.9)");
  craterGlow.addColorStop(0.45, "rgba(255, 140, 40, 0.5)");
  craterGlow.addColorStop(1, "rgba(255, 80, 20, 0)");
  ctx.fillStyle = craterGlow;
  ctx.beginPath();
  ctx.arc(craterX, craterY, w * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Four lava arms radiating from the crater outward (NE, SE, SW, NW).
  const arms: [number, number][] = [
    [ 0.62,  0.10],
    [ 0.62,  0.45],
    [-0.62,  0.45],
    [-0.62,  0.10],
  ];
  for (const [ax, ay] of arms) {
    const ex = craterX + w * 0.5 * ax;
    const ey = craterY + h * 0.6 * ay;
    // Black crust outline.
    ctx.strokeStyle = "rgba(40, 18, 12, 0.85)";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(craterX, craterY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Molten body.
    ctx.strokeStyle = "#d83a14";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(craterX, craterY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.strokeStyle = "#ff7a2a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(craterX, craterY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  // Exit glow SE corner (cool teal so it stands out against the warm map).
  const exr = x + w * 0.88;
  const eyr = y + h * 0.90;
  const eg = ctx.createRadialGradient(exr, eyr, 0, exr, eyr, w * 0.10);
  eg.addColorStop(0, "rgba(170, 240, 180, 0.8)");
  eg.addColorStop(1, "rgba(170, 240, 180, 0)");
  ctx.fillStyle = eg;
  ctx.beginPath();
  ctx.ellipse(exr, eyr, w * 0.11, w * 0.06, 0, 0, Math.PI * 2);
  ctx.fill();
}

function thumbVolcano1(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): void {
  drawVolcanoBase(ctx, x, y, w, h);
}

const CAVE_MAPS: MapDef[] = [
  {
    id: "cave_1",
    name: "The Glow",
    worldId: "cave",
    arenaConfig: CAVE_ARENA_CONFIG,
    buildArena: (w, seed) => buildCave1(w, seed, 0),
    thumbnail: thumbCave1,
  },
];

const VOLCANO_MAPS: MapDef[] = [
  {
    id: "volcano_1",
    name: "Eruption",
    worldId: "volcano",
    arenaConfig: VOLCANO_ARENA_CONFIG,
    buildArena: (w, seed) => buildVolcano1(w, seed, 0),
    thumbnail: thumbVolcano1,
  },
];

export const WORLDS: WorldDef[] = [
  {
    id: "forest",
    name: "Forest World",
    maps: FOREST_MAPS,
    unlock: { kind: "default" },
    accentColor: "#3a7a3a",
  },
  {
    id: "factory",
    name: "Factory World",
    maps: FACTORY_MAPS,
    // Either path: beat 5 Forest maps OR buy the unlock token in
    // the Shop. Gives players a grind path and a sink-points path.
    unlock: {
      kind: "after-world-or-shop",
      previousWorldId: "forest",
      mapsNeeded: WORLDS_REQUIRED_MAPS,
      shopItemId: "factory_world_key",
    },
    accentColor: "#7a8a9a",
  },
  {
    id: "cave",
    name: "Cave World",
    maps: CAVE_MAPS,
    // Default-unlocked foundation: kids can play it immediately.
    // We can tighten to after-factory-or-shop in a follow-up when
    // more cave maps ship.
    unlock: { kind: "default" },
    accentColor: "#a070ff",
  },
  {
    id: "volcano",
    name: "Volcano World",
    maps: VOLCANO_MAPS,
    // Default-unlocked for now while only one map ships — Gravemarch
    // (1500-pt purchase) is the obvious owner here, so leaving it
    // playable by anyone lets every profile try it. Tighten to
    // after-cave-or-shop in a follow-up when more maps ship.
    unlock: { kind: "default" },
    accentColor: "#d83a14",
  },
];

// ---- Lookups ----

export function getWorld(worldId: string): WorldDef | undefined {
  return WORLDS.find((w) => w.id === worldId);
}

export function getMap(mapId: string): MapDef | undefined {
  for (const w of WORLDS) {
    for (const m of w.maps) {
      if (m.id === mapId) return m;
    }
  }
  return undefined;
}

// Default first map id — used when nothing else specifies (the title
// "play" button before any map select UI runs).
export function defaultMapId(): string {
  return WORLDS[0]!.maps[0]!.id;
}

// ---- Progress / unlock logic ----

// Profile state these functions operate on. completedMaps and
// purchasedItems live on the persisted profile; they're passed in so
// the registry stays pure and easy to test.
export interface ProfileProgress {
  completedMaps: string[];
  purchasedItems: string[];
}

function countCompletedInWorld(worldId: string, p: ProfileProgress): number {
  const w = getWorld(worldId);
  if (!w) return 0;
  let n = 0;
  for (const m of w.maps) if (p.completedMaps.includes(m.id)) n++;
  return n;
}

export function isWorldUnlocked(worldId: string, p: ProfileProgress): boolean {
  const w = getWorld(worldId);
  if (!w) return false;
  switch (w.unlock.kind) {
    case "default": return true;
    case "after-world":
      return countCompletedInWorld(w.unlock.previousWorldId, p) >= w.unlock.mapsNeeded;
    case "shop":
      return p.purchasedItems.includes(w.unlock.shopItemId);
    case "after-world-or-shop":
      return countCompletedInWorld(w.unlock.previousWorldId, p) >= w.unlock.mapsNeeded
        || p.purchasedItems.includes(w.unlock.shopItemId);
  }
}

// In Campaign mode, maps unlock sequentially within a world: map N
// requires map N-1 to be completed (or N=0 and the world itself
// unlocked). Already-completed maps are always playable.
export function isMapUnlockedCampaign(mapId: string, p: ProfileProgress): boolean {
  const m = getMap(mapId);
  if (!m) return false;
  if (!isWorldUnlocked(m.worldId, p)) return false;
  const w = getWorld(m.worldId)!;
  const idx = w.maps.findIndex((x) => x.id === mapId);
  if (idx <= 0) return true; // first map is always unlocked in an unlocked world
  // Previous map must be completed.
  return p.completedMaps.includes(w.maps[idx - 1]!.id);
}

// In Vs Computer mode, any map in an unlocked world that the profile
// has completed in Campaign (or is the FIRST map of an unlocked world)
// is playable. Already-played maps stay replayable.
export function isMapPlayableVsComputer(mapId: string, p: ProfileProgress): boolean {
  const m = getMap(mapId);
  if (!m) return false;
  if (!isWorldUnlocked(m.worldId, p)) return false;
  const w = getWorld(m.worldId)!;
  const idx = w.maps.findIndex((x) => x.id === mapId);
  if (idx === 0) return true;
  // Either already completed, or the previous map is completed (so this
  // one is the "next" available).
  if (p.completedMaps.includes(mapId)) return true;
  return p.completedMaps.includes(w.maps[idx - 1]!.id);
}

// Maps available to a multiplayer lobby = intersection of each player's
// vs-computer-playable maps. A non-logged-in player is treated as
// having only the first map of every default-unlocked world.
export function multiplayerCommonMaps(perPlayer: ProfileProgress[]): MapDef[] {
  if (perPlayer.length === 0) return [];
  const out: MapDef[] = [];
  for (const w of WORLDS) {
    for (const m of w.maps) {
      let ok = true;
      for (const p of perPlayer) {
        if (!isMapPlayableVsComputer(m.id, p)) { ok = false; break; }
      }
      if (ok) out.push(m);
    }
  }
  return out;
}
