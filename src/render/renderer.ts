// Isometric renderer. World coordinates (x, y) are on a 2D ground plane.
// We project to screen using a standard 2:1 isometric transform.
// Z is implicit (drawing order = sort by world y for fake depth).
//
// Visual language: flat polygons, no textures, single light direction
// from upper-left. Each prop is a tiny mesh of 2-4 polygons.

import type { World } from "../core/world";
import type { Entity } from "../core/entity";
import { isCharacter, isProjectile, isTrap, isObjective, isProp, isPlate, isExit, isStream, isCliff, isAnimal, isConveyor, isZombie } from "../core/entity";
import type { Vec2 } from "../core/math";
import { CHARACTERS } from "../characters/characters";
import { ABILITIES } from "../abilities/abilities";
import { CHARACTER_ART, drawGumdropBody } from "./characterArt";
import type { CharacterAnim } from "./characterArt";

// Isometric tile scale. Each world unit = 1px at the ground, then projected.
const ISO_W = 1.0; // x-axis world->screen scaling factor base
const ISO_H = 0.5; // y-axis world->screen scaling factor base (2:1 iso)

export interface Camera {
  // Center of view in world coordinates.
  target: Vec2;
  // Pixel scaling on top of the iso transform.
  zoom: number;
}

export function createCamera(target: Vec2): Camera {
  return { target, zoom: 1.0 };
}

// World (x, y) -> screen (x, y) given canvas center and camera.
export function worldToScreen(
  p: Vec2,
  cam: Camera,
  cw: number,
  ch: number,
): Vec2 {
  const dx = p.x - cam.target.x;
  const dy = p.y - cam.target.y;
  const sx = (dx - dy) * ISO_W * cam.zoom;
  const sy = (dx + dy) * ISO_H * cam.zoom;
  return { x: cw / 2 + sx, y: ch / 2 + sy };
}

// Screen -> world (inverse of above). Used to project the mouse onto the
// ground plane each frame so abilities can aim correctly.
export function screenToWorld(
  s: Vec2,
  cam: Camera,
  cw: number,
  ch: number,
): Vec2 {
  const sx = (s.x - cw / 2) / cam.zoom;
  const sy = (s.y - ch / 2) / cam.zoom;
  // Invert: sx = (dx - dy) * ISO_W, sy = (dx + dy) * ISO_H
  // => dx - dy = sx / ISO_W, dx + dy = sy / ISO_H
  const a = sx / ISO_W;
  const b = sy / ISO_H;
  const dx = (a + b) / 2;
  const dy = (b - a) / 2;
  return { x: cam.target.x + dx, y: cam.target.y + dy };
}

export class Renderer {
  // Override dimension source for cases where the canvas backing store is
  // DPR-scaled but we want to draw using CSS pixels.
  private dimSource: (() => { w: number; h: number }) | null = null;

  // Active world cached during drawEntities so per-entity draw methods
  // (e.g. drawObjective) can read ArenaConfig.objectiveStyle without
  // a wider signature change. Cleared after the draw pass.
  private activeWorld: World | null = null;

  constructor(
    public ctx: CanvasRenderingContext2D,
    public canvas: HTMLCanvasElement,
  ) {}

  setDimensionSource(fn: () => { w: number; h: number }): void {
    this.dimSource = fn;
  }

  get cw(): number {
    return this.dimSource ? this.dimSource().w : this.canvas.width;
  }
  get ch(): number {
    return this.dimSource ? this.dimSource().h : this.canvas.height;
  }

  clear(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.cw, this.ch);
  }

  // Draw the arena ground as a filled iso-diamond plus grid lines and fence.
  drawArena(world: World, cam: Camera): void {
    const b = world.arena.bounds;
    const c = [
      worldToScreen({ x: b.minX, y: b.minY }, cam, this.cw, this.ch),
      worldToScreen({ x: b.maxX, y: b.minY }, cam, this.cw, this.ch),
      worldToScreen({ x: b.maxX, y: b.maxY }, cam, this.cw, this.ch),
      worldToScreen({ x: b.minX, y: b.maxY }, cam, this.cw, this.ch),
    ];
    const ctx = this.ctx;

    // Ground fill
    ctx.fillStyle = world.arena.groundColor;
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.fill();

    // Grid lines (subtle)
    ctx.strokeStyle = world.arena.gridColor;
    ctx.lineWidth = 1;
    const step = 100;
    for (let x = b.minX; x <= b.maxX; x += step) {
      const a = worldToScreen({ x, y: b.minY }, cam, this.cw, this.ch);
      const z = worldToScreen({ x, y: b.maxY }, cam, this.cw, this.ch);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(z.x, z.y);
      ctx.stroke();
    }
    for (let y = b.minY; y <= b.maxY; y += step) {
      const a = worldToScreen({ x: b.minX, y }, cam, this.cw, this.ch);
      const z = worldToScreen({ x: b.maxX, y }, cam, this.cw, this.ch);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(z.x, z.y);
      ctx.stroke();
    }

    // Fence — drawn as a thick stroked diamond, with vertical posts on top
    // to suggest depth. Posts are at fixed intervals along each edge.
    ctx.strokeStyle = world.arena.fenceColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.stroke();

    // Fence posts (little verticals)
    ctx.fillStyle = world.arena.fenceColor;
    const postCount = 12;
    for (let edge = 0; edge < 4; edge++) {
      const a = c[edge];
      const z = c[(edge + 1) % 4];
      for (let i = 0; i <= postCount; i++) {
        const t = i / postCount;
        const px = a.x + (z.x - a.x) * t;
        const py = a.y + (z.y - a.y) * t;
        ctx.fillRect(px - 1.5, py - 10, 3, 10);
      }
    }
  }

  // Draw all entities, depth-sorted by world y (then world x). An optional
  // visibility predicate lets the caller hide individual entities — used by
  // main.ts for line-of-sight: survivors don't render hunters whose sight
  // line is blocked by a prop.
  //
  // Three depth bands handle the multi-height layout introduced by Factory
  // Map 3's catwalks:
  //   band 0  floor decals (plates, exit, streams, cliffs, GROUND belts)
  //   band 1  ground-layer entities (characters, props, projectiles, ...)
  //   band 2  elevated layer (catwalk conveyors + elevated characters)
  // Within each band the standard y → x tiebreak applies; elevated
  // characters tie-break slightly AFTER elevated belts so a character
  // riding the catwalk renders on top of it.
  drawEntities(world: World, cam: Camera, visible?: (e: Entity) => boolean): void {
    this.activeWorld = world;
    const bandOf = (e: Entity): number => {
      if (
        e.kind === "plate" || e.kind === "exit" ||
        e.kind === "stream" || e.kind === "cliff" ||
        (e.kind === "conveyor" && !e.elevated)
      ) {
        return 0;
      }
      if (
        (e.kind === "conveyor" && e.elevated) ||
        (e.kind === "character" && e.elevated)
      ) {
        return 2;
      }
      return 1;
    };
    const sortYOf = (e: Entity): number => {
      // Band 0 wants a touch lower than the band-1 entity at the same y
      // so characters standing on floor decals draw on top.
      if (bandOf(e) === 0) return e.pos.y - 0.5;
      // Band-2 character beats a band-2 belt at the same y (riding it).
      if (e.kind === "character" && e.elevated) return e.pos.y + 0.5;
      return e.pos.y;
    };
    const sorted = [...world.entities].sort((a, b) => {
      const ba = bandOf(a);
      const bb = bandOf(b);
      if (ba !== bb) return ba - bb;
      const ay = sortYOf(a);
      const by = sortYOf(b);
      if (ay !== by) return ay - by;
      return a.pos.x - b.pos.x;
    });
    // Pre-pass: paint the drop shadow of every ELEVATED conveyor onto
    // the floor before the main sorted pass runs. The shadow is a
    // capsule offset down-screen by a few pixels, drawn at ground
    // level so it sits UNDER characters (band 1) walking beneath the
    // catwalk. Cheap and gives the catwalk a convincing "above"
    // feel.
    for (const e of world.entities) {
      if (e.kind !== "conveyor" || !e.elevated) continue;
      this.drawElevatedConveyorShadow(e, cam);
    }
    for (const e of sorted) {
      if (visible && !visible(e)) continue;
      this.drawEntity(e, cam);
    }
    this.activeWorld = null;
  }

  // Cave-world flashlight FOV mask. Paints a heavy darkness overlay
  // over the playfield with cut-outs for:
  //   - viewer's forward flashlight cone (long wedge in facing dir)
  //   - every other character's short flashlight cone (so you can
  //     spot them by their own light when they're nearby)
  //   - every crystal-prop's soft ambient circle
  // The whole pass is a single composite-out stamp on top of an
  // overlay, so it's cheap regardless of entity count.
  //
  // Called from main.ts AFTER drawEntities + client effects, BEFORE
  // drawHUD, so the HUD remains fully bright over the darkness.
  drawFlashlightMask(
    world: World,
    cam: Camera,
    viewerId: number | null,
  ): void {
    if (!world.arena.useFlashlightFOV) return;
    const ctx = this.ctx;
    const cw = this.cw;
    const ch = this.ch;
    ctx.save();
    // Base darkness overlay. Lower alpha (0.72) gives a "low
    // ambient glow" — the playfield is dim but not pitch-black,
    // so a player can squint and pick out prop silhouettes even
    // outside a beam. Crystal lamps + flashlight cones then cut
    // brighter pockets out of this.
    ctx.fillStyle = "rgba(0, 0, 8, 0.72)";
    ctx.fillRect(0, 0, cw, ch);
    // Cut light out of the overlay.
    ctx.globalCompositeOperation = "destination-out";

    // Crystal ambient circles — bigger, brighter than v1. Each
    // crystal acts as a wall lamp lighting a wide pocket so
    // players have stable landmarks to navigate by even when
    // their own beam is pointing away.
    for (const e of world.entities) {
      if (e.kind !== "prop" || e.shape !== "crystal") continue;
      const s = worldToScreen(e.pos, cam, cw, ch);
      const lightR = 170;
      const grad = ctx.createRadialGradient(s.x, s.y, 12, s.x, s.y, lightR);
      grad.addColorStop(0, "rgba(255, 255, 255, 1)");
      grad.addColorStop(0.35, "rgba(255, 255, 255, 0.85)");
      grad.addColorStop(0.7, "rgba(255, 255, 255, 0.45)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, lightR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Per-character flashlight cones.
    for (const c of world.entities) {
      if (c.kind !== "character" || c.dead || c.exited) continue;
      const s = worldToScreen(c.pos, cam, cw, ch);
      const isViewer = c.id === viewerId;
      if (isViewer) {
        // Viewer's beam: total 90° wide (±45°). 85% brightness
        // in the inner 30° (±15°); falls off linearly to 0% at
        // ±45°. Implemented as three stacked cones — wide rim,
        // mid band, bright core — using destination-out so the
        // brighter inner stamps remove more darkness than the
        // outer rim. Approximates the angular gradient cleanly
        // enough for Canvas 2D.
        this.drawConeLight(s.x, s.y, c.facing, 320, Math.PI / 4,  0.20); // ±45° rim
        this.drawConeLight(s.x, s.y, c.facing, 320, Math.PI / 6,  0.55); // ±30° mid
        this.drawConeLight(s.x, s.y, c.facing, 320, Math.PI / 12, 0.85); // ±15° core
      } else {
        // Other characters: small full-circle halo so you can
        // spot them when they're close, even if your beam is
        // pointing the wrong way.
        this.drawConeLight(s.x, s.y, c.facing, 60, Math.PI, 0.55);
      }
    }

    ctx.restore();
  }

  // Stamp a single radial-gradient cone (or full circle when
  // halfAngle = π) into the active destination-out compositor.
  // `peak` is the alpha at the center of the gradient — controls
  // how much darkness gets removed. 1.0 = fully bright, 0.0 = no
  // change.
  private drawConeLight(
    cx: number, cy: number,
    facing: number, range: number, halfAngle: number,
    peak: number = 1.0,
  ): void {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(cx, cy, 6, cx, cy, range);
    grad.addColorStop(0,   `rgba(255, 255, 255, ${peak})`);
    grad.addColorStop(0.6, `rgba(255, 255, 255, ${peak * 0.55})`);
    grad.addColorStop(1,   `rgba(255, 255, 255, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (halfAngle >= Math.PI - 0.01) {
      // Full circle — used for non-viewer characters.
      ctx.arc(cx, cy, range, 0, Math.PI * 2);
    } else {
      // Wedge path: from the character outward to the cone arc.
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, range, facing - halfAngle, facing + halfAngle);
      ctx.closePath();
    }
    ctx.fill();
  }

  // Paint the soft drop shadow of an elevated conveyor onto the
  // floor. Offset slightly down-and-right in screen space so the
  // catwalk reads as airborne above the ground.
  private drawElevatedConveyorShadow(
    e: Extract<Entity, { kind: "conveyor" }>,
    cam: Camera,
  ): void {
    const ctx = this.ctx;
    const a = worldToScreen(e.a, cam, this.cw, this.ch);
    const b = worldToScreen(e.b, cam, this.cw, this.ch);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1) return;
    const offX = 6;
    const offY = 14;
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#000";
    ctx.lineWidth = e.width * 2 + 6;
    ctx.beginPath();
    ctx.moveTo(a.x + offX, a.y + offY);
    ctx.lineTo(b.x + offX, b.y + offY);
    ctx.stroke();
    ctx.restore();
  }

  drawEntity(e: Entity, cam: Camera): void {
    if (isProp(e)) this.drawProp(e, cam);
    else if (isObjective(e)) this.drawObjective(e, cam);
    else if (isTrap(e)) this.drawTrap(e, cam);
    else if (isPlate(e)) this.drawPlate(e, cam);
    else if (isExit(e)) this.drawExit(e, cam);
    else if (isStream(e)) this.drawStream(e, cam);
    else if (isCliff(e)) this.drawCliff(e, cam);
    else if (isConveyor(e)) this.drawConveyor(e, cam);
    else if (isAnimal(e)) this.drawAnimal(e, cam);
    else if (isZombie(e)) this.drawZombie(e, cam);
    else if (isProjectile(e)) this.drawProjectile(e, cam);
    else if (isCharacter(e)) this.drawCharacter(e, cam);
  }

  // Necro's summoned minion. Small hunched shambler with a sickly
  // green tint and a violet necromantic glow underneath. In chase
  // mode the eyes flare red to signal aggression.
  private drawZombie(
    e: Extract<Entity, { kind: "zombie" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    const r = e.radius;
    const t = performance.now() / 1000;
    const bob = Math.sin(t * 5 + e.id * 0.5) * 1.2;
    // Ground shadow.
    ctx.fillStyle = "rgba(0,0,0,0.40)";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y - 1, r * 0.85, r * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    // Necromantic glow.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = e.mode === "chase"
      ? "rgba(190, 60, 60, 0.30)"
      : "rgba(140, 80, 200, 0.22)";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y - 2, r * 1.2, r * 0.48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Body (hunched, slightly tilted forward).
    const bodyY = s.y - r * 1.0 + bob;
    ctx.fillStyle = "#3a5a3a"; // sickly green
    ctx.beginPath();
    ctx.ellipse(s.x, bodyY, r * 0.7, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#243a24";
    ctx.beginPath();
    ctx.ellipse(s.x + r * 0.18, bodyY + r * 0.2, r * 0.3, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Stiff arms hanging forward.
    ctx.strokeStyle = "#243a24";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    const armSwing = Math.sin(t * 6 + e.id) * 2;
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s.x + sgn * r * 0.45, bodyY + r * 0.1);
      ctx.lineTo(s.x + sgn * r * 0.55, bodyY + r * 0.7 + armSwing * sgn);
      ctx.stroke();
    }
    // Legs (short stumps).
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s.x + sgn * r * 0.25, bodyY + r * 0.85);
      ctx.lineTo(s.x + sgn * r * 0.3, s.y - 2);
      ctx.stroke();
    }
    // Head.
    const headY = bodyY - r * 0.7;
    ctx.fillStyle = "#4d6a4d";
    ctx.beginPath();
    ctx.arc(s.x, headY, r * 0.46, 0, Math.PI * 2);
    ctx.fill();
    // Sunken eye sockets.
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(s.x - r * 0.16, headY - r * 0.06, r * 0.11, 0, Math.PI * 2);
    ctx.arc(s.x + r * 0.16, headY - r * 0.06, r * 0.11, 0, Math.PI * 2);
    ctx.fill();
    // Eye glow — violet idle, red while chasing.
    ctx.fillStyle = e.mode === "chase" ? "#ff5c4a" : "#c690ff";
    ctx.beginPath();
    ctx.arc(s.x - r * 0.16, headY - r * 0.06, r * 0.05, 0, Math.PI * 2);
    ctx.arc(s.x + r * 0.16, headY - r * 0.06, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // Mouth — small dark gash.
    ctx.fillStyle = "#1a1a14";
    ctx.beginPath();
    ctx.ellipse(s.x, headY + r * 0.18, r * 0.18, r * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    // HP bar — only visible when wounded, so the screen stays clean
    // when the swarm is healthy.
    if (e.hp < e.maxHp) {
      const barW = r * 1.4;
      const barH = 3;
      const bx = s.x - barW / 2;
      const by = headY - r * 0.85;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(bx, by, barW, barH);
      ctx.fillStyle = "#7fcc7f";
      ctx.fillRect(bx, by, barW * (e.hp / e.maxHp), barH);
    }
  }

  private drawPlate(
    e: Extract<Entity, { kind: "plate" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    // Magnetic shimmer: faint pulsing halo.
    const t = (performance.now() / 500) % (Math.PI * 2);
    const pulse = 0.5 + 0.5 * Math.sin(t);
    ctx.fillStyle = `rgba(120, 160, 220, ${0.12 + 0.08 * pulse})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, e.radius * 1.6, e.radius * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Steel disc (flat iso oval).
    ctx.fillStyle = "#9aa6b4";
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, e.radius, e.radius * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    // Darker rim on the shadow side.
    ctx.strokeStyle = "#3c4858";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, e.radius, e.radius * 0.45, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Cross-hatch detail to mark it as iron.
    ctx.strokeStyle = "rgba(60, 72, 88, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - e.radius * 0.5, s.y);
    ctx.lineTo(s.x + e.radius * 0.5, s.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - e.radius * 0.2);
    ctx.lineTo(s.x, s.y + e.radius * 0.2);
    ctx.stroke();
  }

  private drawProp(e: Extract<Entity, { kind: "prop" }>, cam: Camera): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    if (e.shape === "tree") {
      // Trunk
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(s.x - 4, s.y - 14, 8, 14);
      // Foliage: triangle stack, flat shaded
      ctx.fillStyle = "#2f6b3a";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 56);
      ctx.lineTo(s.x - 22, s.y - 18);
      ctx.lineTo(s.x + 22, s.y - 18);
      ctx.closePath();
      ctx.fill();
      // Shadow side
      ctx.fillStyle = "#1f4a28";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 56);
      ctx.lineTo(s.x + 22, s.y - 18);
      ctx.lineTo(s.x + 4, s.y - 18);
      ctx.closePath();
      ctx.fill();
    } else if (e.shape === "stump") {
      ctx.fillStyle = "#6b4528";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 4, 14, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3d2716";
      ctx.fillRect(s.x - 14, s.y - 4, 28, 8);
      ctx.fillStyle = "#8b5a35";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 4, 14, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      // rings
      ctx.strokeStyle = "#5a3a22";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 4, 8, 4, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.shape === "rock") {
      ctx.fillStyle = "#8a8a92";
      ctx.beginPath();
      ctx.moveTo(s.x - 16, s.y);
      ctx.lineTo(s.x - 6, s.y - 18);
      ctx.lineTo(s.x + 10, s.y - 16);
      ctx.lineTo(s.x + 18, s.y - 2);
      ctx.lineTo(s.x + 6, s.y + 4);
      ctx.closePath();
      ctx.fill();
      // shadow side
      ctx.fillStyle = "#5e5e66";
      ctx.beginPath();
      ctx.moveTo(s.x + 10, s.y - 16);
      ctx.lineTo(s.x + 18, s.y - 2);
      ctx.lineTo(s.x + 6, s.y + 4);
      ctx.closePath();
      ctx.fill();
    } else if (e.shape === "crate") {
      // Wooden warehouse crate — iso "cube" with darker right face
      // and slat lines so it reads as planking.
      const r = e.radius;
      const topY = s.y - r * 1.5;
      // Right face (shadow)
      ctx.fillStyle = "#6a4a2a";
      ctx.beginPath();
      ctx.moveTo(s.x + r, s.y);
      ctx.lineTo(s.x + r, topY + r * 0.5);
      ctx.lineTo(s.x, topY);
      ctx.lineTo(s.x, s.y - r * 0.5);
      ctx.closePath();
      ctx.fill();
      // Left face (lit)
      ctx.fillStyle = "#8a6b3d";
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x - r, topY + r * 0.5);
      ctx.lineTo(s.x, topY);
      ctx.lineTo(s.x, s.y - r * 0.5);
      ctx.closePath();
      ctx.fill();
      // Top face
      ctx.fillStyle = "#a07e4d";
      ctx.beginPath();
      ctx.moveTo(s.x - r, topY + r * 0.5);
      ctx.lineTo(s.x, topY);
      ctx.lineTo(s.x + r, topY + r * 0.5);
      ctx.lineTo(s.x, topY + r);
      ctx.closePath();
      ctx.fill();
      // Outline
      ctx.strokeStyle = "#3d2814";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x, topY);
      ctx.lineTo(s.x - r, topY + r * 0.5);
      ctx.lineTo(s.x - r, s.y);
      ctx.lineTo(s.x, s.y + r * 0.3);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x + r, topY + r * 0.5);
      ctx.closePath();
      ctx.stroke();
      // Plank lines on the left face
      ctx.strokeStyle = "#5a3f22";
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r * 0.25);
      ctx.lineTo(s.x, s.y - r * 0.75);
      ctx.stroke();
    } else if (e.shape === "pipe") {
      // Vertical steel pipe — a cylinder. Round cap on top, darker
      // body, a single flange band near the base.
      const r = e.radius;
      const topY = s.y - r * 2.4;
      // Body (rectangle)
      ctx.fillStyle = "#6e7681";
      ctx.fillRect(s.x - r * 0.6, topY, r * 1.2, r * 2.4);
      // Highlight stripe
      ctx.fillStyle = "#9aa3ad";
      ctx.fillRect(s.x - r * 0.5, topY, r * 0.3, r * 2.4);
      // Top ellipse cap
      ctx.fillStyle = "#8a929c";
      ctx.beginPath();
      ctx.ellipse(s.x, topY, r * 0.6, r * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3a3e44";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(s.x, topY, r * 0.6, r * 0.18, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Flange near the base
      ctx.fillStyle = "#3a3e44";
      ctx.fillRect(s.x - r * 0.72, s.y - r * 0.4, r * 1.44, r * 0.18);
      // Outline of body
      ctx.strokeStyle = "#2a2e34";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.6, topY);
      ctx.lineTo(s.x - r * 0.6, s.y);
      ctx.moveTo(s.x + r * 0.6, topY);
      ctx.lineTo(s.x + r * 0.6, s.y);
      ctx.stroke();
    } else if (e.shape === "oildrum") {
      // 55-gallon-style oil drum — wider cylinder with two band
      // rings around its midsection and a yellow-stripe accent.
      const r = e.radius;
      const topY = s.y - r * 1.7;
      // Body
      ctx.fillStyle = "#2f3338";
      ctx.fillRect(s.x - r, topY, r * 2, r * 1.7);
      // Highlight stripe
      ctx.fillStyle = "#4a4f55";
      ctx.fillRect(s.x - r * 0.85, topY, r * 0.5, r * 1.7);
      // Top ellipse
      ctx.fillStyle = "#3a3e44";
      ctx.beginPath();
      ctx.ellipse(s.x, topY, r, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1d20";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(s.x, topY, r, r * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Two ring bands
      ctx.strokeStyle = "#1a1d20";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r * 1.1);
      ctx.lineTo(s.x + r, s.y - r * 1.1);
      ctx.moveTo(s.x - r, s.y - r * 0.5);
      ctx.lineTo(s.x + r, s.y - r * 0.5);
      ctx.stroke();
      // Yellow stripe accent
      ctx.fillStyle = "rgba(255, 200, 80, 0.85)";
      ctx.fillRect(s.x - r, s.y - r * 0.8, r * 2, 3);
      // Side outlines
      ctx.strokeStyle = "#1a1d20";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(s.x - r, topY);
      ctx.lineTo(s.x - r, s.y);
      ctx.moveTo(s.x + r, topY);
      ctx.lineTo(s.x + r, s.y);
      ctx.stroke();
    } else if (e.shape === "pallet") {
      // Floor pallet — flat slatted wood. Non-blocking decoration.
      const r = e.radius;
      ctx.save();
      ctx.fillStyle = "rgba(140, 100, 60, 0.55)";
      ctx.fillRect(s.x - r, s.y - r * 0.3, r * 2, r * 0.6);
      ctx.fillStyle = "rgba(110, 75, 40, 0.6)";
      for (let i = -r; i < r; i += r * 0.4) {
        ctx.fillRect(s.x + i, s.y - r * 0.3, 2, r * 0.6);
      }
      ctx.strokeStyle = "rgba(60, 40, 20, 0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x - r, s.y - r * 0.3, r * 2, r * 0.6);
      ctx.restore();
    } else if (e.shape === "caverock") {
      // Stalagmite cluster — three jagged dark spikes rising from
      // a stone base. Flat-shaded with a darker right side.
      const r = e.radius;
      // Base shadow
      ctx.fillStyle = "#1a1a22";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      // Tall middle spike
      ctx.fillStyle = "#3a3a48";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r * 1.8);
      ctx.lineTo(s.x - r * 0.55, s.y);
      ctx.lineTo(s.x + r * 0.55, s.y);
      ctx.closePath();
      ctx.fill();
      // Shadow side on middle spike
      ctx.fillStyle = "#1f1f28";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r * 1.8);
      ctx.lineTo(s.x + r * 0.55, s.y);
      ctx.lineTo(s.x + r * 0.1, s.y);
      ctx.closePath();
      ctx.fill();
      // Short left spike
      ctx.fillStyle = "#2e2e3a";
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.7, s.y - r * 0.95);
      ctx.lineTo(s.x - r * 1.0, s.y);
      ctx.lineTo(s.x - r * 0.4, s.y);
      ctx.closePath();
      ctx.fill();
      // Short right spike
      ctx.fillStyle = "#252530";
      ctx.beginPath();
      ctx.moveTo(s.x + r * 0.7, s.y - r * 1.0);
      ctx.lineTo(s.x + r * 0.4, s.y);
      ctx.lineTo(s.x + r * 1.0, s.y);
      ctx.closePath();
      ctx.fill();
    } else if (e.shape === "crystal") {
      // Crystal cluster — three hexagonal shards in a glowing
      // violet/cyan palette. Pulses softly. The FOV mask pass
      // separately cuts ambient light around this entity.
      const r = e.radius;
      const t = (performance.now() / 800) % (Math.PI * 2);
      const pulse = 0.6 + 0.4 * Math.sin(t);
      // Halo on the ground.
      ctx.fillStyle = `rgba(170, 120, 255, ${0.28 * pulse})`;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2, r * 1.4, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // Rock base.
      ctx.fillStyle = "#22222a";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, r * 0.7, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      // Center shard (tall).
      const shard = (cx: number, cy: number, h: number, w: number, fill: string, dark: string) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h);
        ctx.lineTo(cx + w * 0.55, cy - h * 0.55);
        ctx.lineTo(cx + w * 0.55, cy - h * 0.15);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - w * 0.55, cy - h * 0.15);
        ctx.lineTo(cx - w * 0.55, cy - h * 0.55);
        ctx.closePath();
        ctx.fill();
        // Shadow side (right).
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.moveTo(cx, cy - h);
        ctx.lineTo(cx + w * 0.55, cy - h * 0.55);
        ctx.lineTo(cx + w * 0.55, cy - h * 0.15);
        ctx.lineTo(cx, cy);
        ctx.closePath();
        ctx.fill();
      };
      // Three shards — left short, center tall, right medium.
      shard(s.x - r * 0.55, s.y, r * 1.1, r * 0.45, "#a070ff", "#5a3da8");
      shard(s.x + r * 0.5, s.y, r * 1.3, r * 0.5, "#9e6cff", "#52379d");
      shard(s.x, s.y, r * 1.9, r * 0.55, "#c69aff", "#7152bf");
      // Bright inner highlight on center shard.
      ctx.fillStyle = `rgba(255, 240, 255, ${0.6 * pulse})`;
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.1, s.y - r * 1.6);
      ctx.lineTo(s.x + r * 0.05, s.y - r * 1.6);
      ctx.lineTo(s.x + r * 0.08, s.y - r * 0.6);
      ctx.lineTo(s.x - r * 0.08, s.y - r * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Gold nugget — irregular lumpy blob in warm gold with a darker
  // shaded lower-right half and a small white speculary highlight.
  // Pulses a soft halo so it reads as "pick me up" against the dark
  // ground without looking like a faceted gem.
  private drawObjective(
    e: Extract<Entity, { kind: "objective" }>,
    cam: Camera,
  ): void {
    if (e.collected) return;
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    // Pulsing ground glow.
    const t = (performance.now() / 400) % (Math.PI * 2);
    const glow = 0.7 + 0.3 * Math.sin(t);

    // Gem variant — faceted cyan crystal cluster. Used by the
    // Cave world via ArenaConfig.objectiveStyle. Same pickup
    // mechanics; just a different visual to match the biome.
    if (this.activeWorld?.arena.objectiveStyle === "gem") {
      // Cool-toned halo on the ground.
      ctx.fillStyle = `rgba(120, 220, 255, ${0.30 * glow})`;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 3, 20, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      // Faceted diamond — top point, two side points, bottom point.
      const r = 11;
      const gemPath = new Path2D();
      gemPath.moveTo(s.x, s.y - r);
      gemPath.lineTo(s.x + r * 0.75, s.y - r * 0.15);
      gemPath.lineTo(s.x, s.y + r * 0.95);
      gemPath.lineTo(s.x - r * 0.75, s.y - r * 0.15);
      gemPath.closePath();
      // Light face (upper-left).
      ctx.fillStyle = "#a8e6ff";
      ctx.fill(gemPath);
      // Shadow face (right) clipped to the gem.
      ctx.save();
      ctx.clip(gemPath);
      ctx.fillStyle = "#3a8db8";
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r * 0.75, s.y - r * 0.15);
      ctx.lineTo(s.x, s.y + r * 0.95);
      ctx.closePath();
      ctx.fill();
      // Center facet line (top to bottom).
      ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y + r * 0.95);
      ctx.stroke();
      ctx.restore();
      // Outline + sparkle highlight.
      ctx.strokeStyle = "#0d3a5a";
      ctx.lineWidth = 1.4;
      ctx.lineJoin = "round";
      ctx.stroke(gemPath);
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.beginPath();
      ctx.ellipse(s.x - r * 0.3, s.y - r * 0.55, 2.5, 1.2, -0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Default nugget variant.
    ctx.fillStyle = `rgba(255, 200, 80, ${0.22 * glow})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y + 3, 22, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nugget body — irregular polygon with rounded corners. Built
    // once with stable vertices around the nugget center so the
    // shape doesn't shimmer between frames.
    const nuggetPath = new Path2D();
    const vertices: [number, number][] = [
      [-9, -7], [-2, -10], [6, -8], [10, -2], [8, 4], [3, 6], [-5, 5], [-10, 0],
    ];
    nuggetPath.moveTo(s.x + vertices[0]![0], s.y + vertices[0]![1]);
    for (let i = 1; i < vertices.length; i++) {
      nuggetPath.lineTo(s.x + vertices[i]![0], s.y + vertices[i]![1]);
    }
    nuggetPath.closePath();
    // Fill (warm gold).
    ctx.fillStyle = "#f1c241";
    ctx.fill(nuggetPath);
    // Outline.
    ctx.strokeStyle = "#5a3a08";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.stroke(nuggetPath);
    // Darker shaded lower-right (clipped to the nugget).
    ctx.save();
    ctx.clip(nuggetPath);
    ctx.fillStyle = "#b88720";
    ctx.beginPath();
    ctx.moveTo(s.x - 12, s.y + 8);
    ctx.lineTo(s.x + 12, s.y + 8);
    ctx.lineTo(s.x + 12, s.y - 2);
    ctx.lineTo(s.x - 1, s.y + 6);
    ctx.closePath();
    ctx.fill();
    // Small specular highlight in the upper-left.
    ctx.fillStyle = "rgba(255, 250, 200, 0.85)";
    ctx.beginPath();
    ctx.ellipse(s.x - 4, s.y - 5, 3, 1.6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Exit zone — an open archway / portal of grass-edged stone tiles
  // on the ground. Survivors who've met the exit requirements step
  // here to escape (engine sets exited=true). Pulses subtly so it
  // reads as a goal.
  private drawExit(
    e: Extract<Entity, { kind: "exit" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    const r = e.radius;
    const t = (performance.now() / 500) % (Math.PI * 2);
    const pulse = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t));
    ctx.save();
    // Outer iso-elliptical pad (ground footprint).
    ctx.translate(s.x, s.y);
    ctx.scale(1, 0.5);
    // Glow ring.
    const grad = ctx.createRadialGradient(0, 0, r * 0.25, 0, 0, r * 1.15);
    grad.addColorStop(0, `rgba(120, 220, 160, ${0.35 * pulse})`);
    grad.addColorStop(0.65, `rgba(120, 220, 160, ${0.12 * pulse})`);
    grad.addColorStop(1, "rgba(120, 220, 160, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.15, 0, Math.PI * 2);
    ctx.fill();
    // Inner stone pad.
    ctx.fillStyle = "#2d3a32";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3f5246";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
    ctx.fill();
    // Bright green portal core.
    ctx.fillStyle = `rgba(170, 240, 180, ${0.55 + 0.35 * pulse})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // "EXIT" label above the pad (screen-space).
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(s.x - 22, s.y - r * 0.7 - 14, 44, 14);
    ctx.fillStyle = "#aaf0b4";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("EXIT", s.x, s.y - r * 0.7 - 4);
    ctx.textAlign = "left";
  }

  // Stream — meandering polyline of flowing water on the ground.
  // Painted as a layered stroke (sandy bank → water → inner shimmer)
  // through smoothed quadratic curves between the control points,
  // with chevrons that march along the local segment direction so
  // the current visibly follows the meander.
  private drawStream(
    e: Extract<Entity, { kind: "stream" }>,
    cam: Camera,
  ): void {
    const ctx = this.ctx;
    const pts = e.points.map((p) => worldToScreen(p, cam, this.cw, this.ch));
    if (pts.length < 2) return;
    const w = e.width;

    // Smoothed path through the control points: for each interior
    // point, draw a quadratic curve from the previous midpoint to
    // the next midpoint, using the point itself as the control.
    // Endpoints connect with straight segments. Visually this gives
    // soft river bends without overshooting the centerline.
    const buildPath = (target: CanvasRenderingContext2D | Path2D) => {
      if (target instanceof Path2D) {
        target.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
          const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
          target.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
        }
        target.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
      } else {
        target.moveTo(pts[0]!.x, pts[0]!.y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
          const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
          target.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
        }
        target.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
      }
    };

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Sandy bank — widest, brownish.
    ctx.lineWidth = (w + 10) * 2;
    ctx.strokeStyle = "rgba(196, 168, 110, 0.55)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    // Water body.
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = "rgba(80, 150, 200, 0.78)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    // Inner shimmer — narrower, brighter.
    ctx.lineWidth = w * 1.3;
    ctx.strokeStyle = "rgba(180, 220, 240, 0.35)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    ctx.restore();

    // Animated flow chevrons walking along the polyline. We march
    // by arc length, switching segments as we cross boundaries —
    // so chevrons turn with the river bend.
    const segs: { p0: { x: number; y: number }; p1: { x: number; y: number }; len: number; cum: number }[] = [];
    let totalLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      const l = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      segs.push({ p0, p1, len: l, cum: totalLen });
      totalLen += l;
    }
    if (totalLen < 1) return;

    const t = (performance.now() / 700) % 1;
    const chevW = Math.min(18, w * 0.4);
    const chevH = Math.min(10, w * 0.3);
    const spacing = 50;

    ctx.save();
    ctx.strokeStyle = "rgba(220, 240, 255, 0.7)";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let off = 0; off <= totalLen; off += spacing) {
      const s = off + t * spacing;
      if (s < 0 || s > totalLen) continue;
      // Find segment containing s.
      let seg = segs[0]!;
      for (const sg of segs) {
        if (s >= sg.cum && s <= sg.cum + sg.len) { seg = sg; break; }
      }
      const localT = (s - seg.cum) / (seg.len || 1);
      const cx = seg.p0.x + (seg.p1.x - seg.p0.x) * localT;
      const cy = seg.p0.y + (seg.p1.y - seg.p0.y) * localT;
      const ex = (seg.p1.x - seg.p0.x) / (seg.len || 1);
      const ey = (seg.p1.y - seg.p0.y) / (seg.len || 1);
      // Perpendicular (chevron arms).
      const px = -ey;
      const py = ex;
      // Chevron points forward along the segment.
      const tipX = cx + ex * (chevW * 0.5);
      const tipY = cy + ey * (chevW * 0.5);
      const backX = cx - ex * (chevW * 0.5);
      const backY = cy - ey * (chevW * 0.5);
      ctx.beginPath();
      ctx.moveTo(backX + px * chevH, backY + py * chevH);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(backX - px * chevH, backY - py * chevH);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Conveyor belt — long rectangular strip on the factory floor.
  // Hazard-striped frame, dark gray belt surface, perpendicular
  // belt stripes that animate in the flow direction, and roller
  // wheels at each end. Square-capped (no rounded ends) so it
  // reads as a built mechanical thing rather than a river.
  private drawConveyor(
    e: Extract<Entity, { kind: "conveyor" }>,
    cam: Camera,
  ): void {
    const ctx = this.ctx;
    const a = worldToScreen(e.a, cam, this.cw, this.ch);
    const b = worldToScreen(e.b, cam, this.cw, this.ch);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ex = dx / len;
    const ey = dy / len;
    const px = -ey;
    const py = ex;
    const w = e.width;

    ctx.save();
    ctx.lineCap = "butt";
    ctx.lineJoin = "miter";

    // Hazard frame — yellow + black stripes along both edges.
    const frameW = 4;
    for (const sign of [-1, 1]) {
      const ax = a.x + px * (w + frameW * 0.5) * sign;
      const ay = a.y + py * (w + frameW * 0.5) * sign;
      const bx = b.x + px * (w + frameW * 0.5) * sign;
      const by = b.y + py * (w + frameW * 0.5) * sign;
      // Solid black underlay.
      ctx.strokeStyle = "#1a1d20";
      ctx.lineWidth = frameW;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      // Yellow dashed overlay.
      ctx.setLineDash([10, 10]);
      ctx.strokeStyle = "rgba(255, 200, 80, 0.95)";
      ctx.lineWidth = frameW - 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Belt body — dark gray rubber surface.
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = "#2a2e34";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Subtle center stripe (the seam of the belt).
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Animated belt segments — perpendicular hash marks that march
    // in the flow direction. Direction comes from the sign of
    // flow's projection onto the segment.
    const flowDotSeg = e.flow.x * ex + e.flow.y * ey;
    const sign = flowDotSeg >= 0 ? 1 : -1;
    const t = (performance.now() / 600) % 1;
    const spacing = 28;
    ctx.strokeStyle = "rgba(180, 195, 210, 0.55)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let off = 0; off <= len; off += spacing) {
      const s = off + sign * t * spacing;
      // Wrap into [0, len].
      const sm = ((s % len) + len) % len;
      const cx = a.x + ex * sm;
      const cy = a.y + ey * sm;
      ctx.beginPath();
      ctx.moveTo(cx + px * (w - 4), cy + py * (w - 4));
      ctx.lineTo(cx - px * (w - 4), cy - py * (w - 4));
      ctx.stroke();
    }
    ctx.restore();

    // End caps. Two modes:
    //   showGears = true  → animated mechanical gears (teeth + hub
    //                       + rotation driven by flowSpeed)
    //   showGears = false → plain rollers (the Map-2 look)
    if (e.showGears) {
      this.drawConveyorGears(a, b, w, e.flowSpeed, sign);
    } else {
      for (const end of [a, b]) {
        ctx.save();
        ctx.fillStyle = "#1a1d20";
        ctx.beginPath();
        ctx.arc(end.x, end.y, w * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#5a6470";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(end.x, end.y, w * 0.55, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "#3a3e44";
        ctx.beginPath();
        ctx.arc(end.x, end.y, w * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // Elevated belts: add support pillars along the length to read as
    // a catwalk. Small dark verticals on the floor, drawn after the
    // shadow pass but before the belt body would be nice — but the
    // belt itself is drawn in band-2 (above characters), so we paint
    // the pillars HERE behind the belt body. They'll be over-painted
    // by the belt body and rollers, leaving just the visible bases
    // around the edges. That's actually the look we want (legs
    // peeking out from under the deck).
    if (e.elevated) {
      ctx.save();
      ctx.strokeStyle = "#1a1d20";
      ctx.lineWidth = 2;
      const pillarSpacing = 90;
      for (let off = pillarSpacing; off < len - 10; off += pillarSpacing) {
        const cx = a.x + ex * off;
        const cy = a.y + ey * off;
        ctx.beginPath();
        ctx.moveTo(cx + px * w * 0.85, cy + py * w * 0.85);
        ctx.lineTo(cx + px * w * 0.85 + 1, cy + py * w * 0.85 + 12);
        ctx.moveTo(cx - px * w * 0.85, cy - py * w * 0.85);
        ctx.lineTo(cx - px * w * 0.85 + 1, cy - py * w * 0.85 + 12);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Spinning toothed gear at each conveyor endpoint. `flowSign` is
  // the same direction sign the belt-hash march uses, so the gear
  // rotates the way the belt visually moves. Speed scales with
  // `flowSpeed` so faster belts spin faster.
  private drawConveyorGears(
    a: { x: number; y: number },
    b: { x: number; y: number },
    w: number,
    flowSpeed: number,
    flowSign: number,
  ): void {
    const ctx = this.ctx;
    // Radians per second of gear rotation. 110 units/sec belt → ~2
    // rad/sec gear (roughly one turn every 3s) feels about right.
    const omega = (flowSpeed / 110) * 2.0 * flowSign;
    const baseAngle = (performance.now() / 1000) * omega;
    const teeth = 10;
    const rOuter = w * 0.62;
    const rInner = w * 0.46;
    const rHub = w * 0.18;
    for (const end of [a, b]) {
      ctx.save();
      ctx.translate(end.x, end.y);
      // Toothed gear body — alternating outer-radius / inner-radius
      // vertices around the circle forms a star-gear silhouette.
      ctx.rotate(baseAngle);
      ctx.fillStyle = "#2a2e34";
      ctx.beginPath();
      const segCount = teeth * 2;
      for (let i = 0; i < segCount; i++) {
        const ang = (i / segCount) * Math.PI * 2;
        const r = i % 2 === 0 ? rOuter : rInner;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      // Metallic rim highlight.
      ctx.strokeStyle = "#7a8490";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Inner darker ring around the hub for a milled look.
      ctx.fillStyle = "#1a1d20";
      ctx.beginPath();
      ctx.arc(0, 0, rInner * 0.72, 0, Math.PI * 2);
      ctx.fill();
      // Central hub bolt — fixed (no rotation, looks like an axle).
      ctx.rotate(-baseAngle);
      ctx.fillStyle = "#5a6470";
      ctx.beginPath();
      ctx.arc(0, 0, rHub, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1a1d20";
      ctx.beginPath();
      ctx.arc(0, 0, rHub * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Cliff — a one-way drop edge. Renders the cliff top as a bold
  // dark line with a hatched "fall here" shadow band trailing in the
  // anti-normal direction (low side).
  private drawCliff(
    e: Extract<Entity, { kind: "cliff" }>,
    cam: Camera,
  ): void {
    const ctx = this.ctx;
    const a = worldToScreen(e.a, cam, this.cw, this.ch);
    const b = worldToScreen(e.b, cam, this.cw, this.ch);
    // Compute screen-space perpendicular AWAY from the high side
    // (i.e. toward the low / fall side). Use the world-space
    // highNormal projected to screen-space via the same iso scale
    // factor (~0.5 vertical). Cheap approximation.
    const lowX = -e.highNormal.x;
    const lowY = -e.highNormal.y * 0.5;
    const lowLen = Math.hypot(lowX, lowY) || 1;
    const lnx = lowX / lowLen;
    const lny = lowY / lowLen;
    const bandDepth = 24;
    // Hatched fall band — semi-transparent dark trapezoid.
    ctx.save();
    ctx.fillStyle = "rgba(20, 14, 8, 0.45)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x + lnx * bandDepth, b.y + lny * bandDepth);
    ctx.lineTo(a.x + lnx * bandDepth, a.y + lny * bandDepth);
    ctx.closePath();
    ctx.fill();
    // Diagonal hatch lines across the band.
    ctx.strokeStyle = "rgba(40, 28, 18, 0.75)";
    ctx.lineWidth = 1.5;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const edgeLen = Math.hypot(dx, dy) || 1;
    const ex = dx / edgeLen;
    const ey = dy / edgeLen;
    const hatchSpacing = 12;
    for (let s = 0; s < edgeLen; s += hatchSpacing) {
      const x0 = a.x + ex * s;
      const y0 = a.y + ey * s;
      const x1 = x0 + lnx * bandDepth + ex * 4;
      const y1 = y0 + lny * bandDepth + ey * 4;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
    // Cliff top edge line — bold dark.
    ctx.save();
    ctx.strokeStyle = "#0a0806";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // Highlight along the very top — slim warm line on the high side.
    const hiX = -lnx;
    const hiY = -lny;
    ctx.strokeStyle = "rgba(160, 130, 90, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x + hiX * 2, a.y + hiY * 2);
    ctx.lineTo(b.x + hiX * 2, b.y + hiY * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Forest animal — wandering NPC drawn as a stylized iso silhouette
  // (deer or bear). Body bobs slightly while moving; the head turns
  // toward facing direction. Tinted red while in chase mood so the
  // player can read "this one wants to bite me" from a glance.
  private drawAnimal(
    e: Extract<Entity, { kind: "animal" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    const r = e.radius;
    const moving = Math.hypot(e.vel.x, e.vel.y) > 5;
    const t = performance.now() / 200;
    const bob = moving ? Math.sin(t) * 1.2 : 0;
    const facingX = Math.cos(e.facing);
    const aggressive = e.mood === "chase";

    // Shadow
    ctx.save();
    ctx.translate(s.x, s.y + 4);
    ctx.scale(1, 0.4);
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    sg.addColorStop(0, "rgba(0,0,0,0.45)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Mood-aware tint applied on top of the species base color.
    const tint = (base: string): string => aggressive
      ? "rgba(208, 72, 72, 0.4)"
      : base;

    if (e.species === "deer") {
      // Body — slender brown oval, slightly bigger horizontally.
      ctx.fillStyle = "#8a6033";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - r * 0.4 + bob, r * 1.1, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3d2914";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // White underbelly highlight
      ctx.fillStyle = "rgba(245, 230, 200, 0.55)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - r * 0.25 + bob, r * 0.8, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      // Head — small oval facing the direction of travel.
      const headOffsetX = facingX * r * 0.7;
      const headX = s.x + headOffsetX;
      const headY = s.y - r * 0.9 + bob;
      ctx.fillStyle = "#7d5527";
      ctx.beginPath();
      ctx.ellipse(headX, headY, r * 0.32, r * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3d2914";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // Antlers — two short branching strokes.
      ctx.strokeStyle = "#dccaa0";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(headX - r * 0.1, headY - r * 0.15);
      ctx.lineTo(headX - r * 0.18, headY - r * 0.5);
      ctx.moveTo(headX - r * 0.18, headY - r * 0.5);
      ctx.lineTo(headX - r * 0.32, headY - r * 0.55);
      ctx.moveTo(headX - r * 0.18, headY - r * 0.5);
      ctx.lineTo(headX - r * 0.08, headY - r * 0.62);
      ctx.moveTo(headX + r * 0.1, headY - r * 0.15);
      ctx.lineTo(headX + r * 0.18, headY - r * 0.5);
      ctx.moveTo(headX + r * 0.18, headY - r * 0.5);
      ctx.lineTo(headX + r * 0.08, headY - r * 0.62);
      ctx.stroke();
      // Eye (single dot toward facing).
      ctx.fillStyle = "#1a1a1a";
      ctx.beginPath();
      ctx.arc(headX + facingX * r * 0.15, headY - r * 0.05, 1.5, 0, Math.PI * 2);
      ctx.fill();
      // Aggression tint on top of body
      if (aggressive) {
        ctx.fillStyle = tint("");
        ctx.beginPath();
        ctx.ellipse(s.x, s.y - r * 0.4 + bob, r * 1.1, r * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Bear — chunky dark-brown blob.
      ctx.fillStyle = "#4a2f1c";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - r * 0.5 + bob, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1f1108";
      ctx.lineWidth = 2;
      ctx.stroke();
      // Head — rounder, slightly forward toward facing.
      const headX = s.x + facingX * r * 0.55;
      const headY = s.y - r * 0.9 + bob;
      ctx.fillStyle = "#3d2716";
      ctx.beginPath();
      ctx.arc(headX, headY, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1f1108";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Snout
      ctx.fillStyle = "#5e3c22";
      ctx.beginPath();
      ctx.arc(headX + facingX * r * 0.28, headY + r * 0.08, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      // Two round ears
      ctx.fillStyle = "#3d2716";
      ctx.beginPath();
      ctx.arc(headX - r * 0.22, headY - r * 0.3, r * 0.12, 0, Math.PI * 2);
      ctx.arc(headX + r * 0.22, headY - r * 0.3, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
      // Eyes
      ctx.fillStyle = aggressive ? "#ffd84a" : "#1a1a1a";
      ctx.beginPath();
      ctx.arc(headX - r * 0.12, headY - r * 0.05, 2, 0, Math.PI * 2);
      ctx.arc(headX + r * 0.12, headY - r * 0.05, 2, 0, Math.PI * 2);
      ctx.fill();
      if (aggressive) {
        ctx.fillStyle = tint("");
        ctx.beginPath();
        ctx.ellipse(s.x, s.y - r * 0.5 + bob, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Thin HP bar (only when wounded, to keep the world quiet).
    if (e.hp < e.maxHp) {
      const bw = r * 1.4;
      const bh = 3;
      const bx = s.x - bw / 2;
      const by = s.y - r * 1.55;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = "#333";
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = aggressive ? "#d04848" : "#a07a3a";
      ctx.fillRect(bx, by, bw * Math.max(0, e.hp / e.maxHp), bh);
    }
  }

  private drawTrap(e: Extract<Entity, { kind: "trap" }>, cam: Camera): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    const armed = e.armDelay <= 0;
    const alpha = armed ? 0.7 : 0.35;
    ctx.fillStyle = `rgba(95, 185, 107, ${alpha})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, e.radius * 1.0, e.radius * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(47, 122, 58, ${alpha + 0.1})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Bubbles
    if (armed) {
      const t = performance.now() / 200;
      for (let i = 0; i < 3; i++) {
        const ang = t + i * 2;
        const bx = s.x + Math.cos(ang) * 8;
        const by = s.y + Math.sin(ang) * 4;
        ctx.fillStyle = "rgba(155, 220, 165, 0.7)";
        ctx.beginPath();
        ctx.arc(bx, by, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawProjectile(
    e: Extract<Entity, { kind: "projectile" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    if (e.damage === 0) {
      // Slash flash effect
      const alpha = Math.max(0, e.ttl / 0.12);
      ctx.strokeStyle = `rgba(255, 240, 200, ${alpha})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, e.radius, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Slime glob
      ctx.fillStyle = "#7ed889";
      ctx.beginPath();
      ctx.arc(s.x, s.y, e.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#3f8a4a";
      ctx.beginPath();
      ctx.arc(s.x + 2, s.y + 2, e.radius * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCharacter(
    e: Extract<Entity, { kind: "character" }>,
    cam: Camera,
  ): void {
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const def = CHARACTERS[e.characterId];
    const ctx = this.ctx;

    // Survivor has escaped via the exit — render a faint translucent
    // shimmer at their last position instead of the full body, and
    // skip every other character-draw step. Their HP bar / name
    // still draw so the round summary feels coherent.
    if (e.exited) {
      ctx.save();
      ctx.fillStyle = "rgba(170, 240, 180, 0.25)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - e.radius * 0.6, e.radius * 1.1, e.radius * 1.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Tiny "ESCAPED" label so the audience knows.
      ctx.fillStyle = "rgba(170, 240, 180, 0.75)";
      ctx.font = "bold 9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("ESCAPED", s.x, s.y - e.radius * 2.4);
      ctx.textAlign = "left";
      return;
    }

    // Ability-driven transport trail (e.g. Magnesis). Draw before the
    // shadow so the dots sit on the ground but under everything else.
    if (e.transport) {
      this.drawTransportTrail(e, cam);
    }

    // Shadow (universal). Radial gradient — darkest directly under the
    // character, fading to transparent at the edge. Drawn via a
    // scaled circle so the radial falloff is also elliptical and
    // matches the 2:1 iso ground footprint.
    ctx.save();
    ctx.translate(s.x, s.y + 2);
    ctx.scale(1, 0.35);
    const shadowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, e.radius * 0.95);
    shadowGrad.addColorStop(0, "rgba(0, 0, 0, 0.55)");
    shadowGrad.addColorStop(0.55, "rgba(0, 0, 0, 0.3)");
    shadowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, e.radius * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // While transporting, render a head-only "ghost" — bright white
    // glow with the character's silhouette inside, no arms/legs. The
    // body returns when transport completes.
    if (e.transport) {
      const tt = Math.min(1, e.transport.elapsed / e.transport.duration);
      // Glow brightest at the midpoint of the arc, easing in/out.
      const glow = 1 - Math.abs(0.5 - tt) * 2; // 0 at ends, 1 at midpoint
      this.drawTransportGhost(s.x, s.y, e.radius, glow);
      // Skip body art + overlays this frame; HP bar still drawn below
      // so other players can see if Magnek's being chipped in flight.
      const topY = s.y - e.radius * 2.8 - 4;
      this.drawCharacterHud(e, s.x, topY, def);
      return;
    }

    // Compute per-frame animation state from the entity. Walk speed
    // is normalized against the character's base speed so the cadence
    // looks the same whether the character is fast or slow. Charge
    // glow only fires for Magnesis (red→yellow→white). Kneel pose
    // fires briefly after place_plate (cooldown just set).
    const speed = Math.hypot(e.vel.x, e.vel.y);
    const walkSpeed = Math.max(0, Math.min(1, speed / Math.max(1, e.speed)));
    const phase = performance.now() / 1000;
    let chargeGlow: number | undefined;
    if (e.charging?.abilityId === "magnesis") {
      chargeGlow = 1 - e.charging.remaining / e.charging.total;
    }
    let pose: "kneel" | undefined;
    // place_plate has a 2.0s cooldown; show kneel for the first 0.25s
    // after the cast (i.e. while cooldown is between 1.75 and 2.0).
    const ppCd = e.cooldowns["place_plate"];
    if (ppCd != null && ppCd > 1.75) pose = "kneel";
    const anim: CharacterAnim = { walkSpeed, phase, chargeGlow, pose };

    // Body + face: dispatched per character. The art function returns
    // top/center Y values so overlays (charging ring, status, HP bar)
    // position correctly regardless of head size.
    const art = CHARACTER_ART[e.characterId];
    const { topY, centerY } = art
      ? art(ctx, s.x, s.y, e.radius, e.facing, anim)
      : drawGumdropBody(ctx, s.x, s.y, e.radius, def.color, def.colorDark, e.facing);

    // Channel windup: pulsing ring that shrinks toward completion.
    // Anchored at the body center returned by the art function.
    if (e.charging) {
      const pct = 1 - e.charging.remaining / e.charging.total;
      const ringR = e.radius + 10 + (1 - pct) * 18;
      ctx.strokeStyle = `rgba(180, 220, 255, ${0.5 + 0.4 * pct})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, centerY, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        s.x,
        centerY,
        e.radius + 5,
        -Math.PI / 2,
        -Math.PI / 2 + pct * Math.PI * 2,
      );
      ctx.stroke();
    }

    // Status effect indicators.
    if (e.statuses["overdrive"] > 0) {
      ctx.strokeStyle = "rgba(255, 200, 80, 0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, centerY, e.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (e.statuses["slowed"] > 0) {
      ctx.strokeStyle = "rgba(95, 185, 107, 0.7)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(s.x, centerY, e.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (e.statuses["phased"] > 0) {
      ctx.globalAlpha = 0.5;
    }

    // HP bar + name tag.
    ctx.globalAlpha = 1;
    this.drawCharacterHud(e, s.x, topY, def);
  }

  // HP bar + name tag drawn above the character's top edge. Extracted
  // so the transport-ghost code path can reuse it.
  private drawCharacterHud(
    e: Extract<Entity, { kind: "character" }>,
    sx: number,
    topY: number,
    def: { name: string },
  ): void {
    const ctx = this.ctx;
    const barW = e.radius * 2.2;
    const barH = 4;
    const barX = sx - barW / 2;
    const barY = topY - 8;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
    ctx.fillStyle = "#333";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = e.team === "hunter" ? "#d04848" : "#48d0a0";
    ctx.fillRect(barX, barY, barW * (e.hp / e.maxHp), barH);
    ctx.fillStyle = "#fff";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(def.name, sx, barY - 4);
  }

  // Dotted-line trail showing the character's transport arc. Behind
  // the character it fades out (showing where they were); ahead it
  // fades in (showing where they're headed). Drawn in screen space
  // along the projected from/to line, dot by dot, with per-dot alpha.
  private drawTransportTrail(
    e: Extract<Entity, { kind: "character" }>,
    cam: Camera,
  ): void {
    if (!e.transport) return;
    const t = e.transport.elapsed / e.transport.duration;
    const a = worldToScreen(e.transport.fromPos, cam, this.cw, this.ch);
    const b = worldToScreen(e.transport.toPos, cam, this.cw, this.ch);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const totalLen = Math.hypot(dx, dy);
    if (totalLen < 1) return;
    const ux = dx / totalLen;
    const uy = dy / totalLen;
    const dotSpacing = 9;
    const dotLen = 4;
    const fadeAhead = 1.6;  // softer fade — destination stays previewed
    const fadeBehind = 2.8; // sharper fade — trail wipes away after pass

    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5;
    for (let p = 0; p <= totalLen; p += dotSpacing) {
      const frac = p / totalLen;
      const d = frac - t;
      let alpha: number;
      if (d >= 0) {
        // Ahead of character — visible, fading at the far end.
        alpha = Math.max(0, 1 - d * fadeAhead) * 0.85;
      } else {
        // Behind — fades faster so the trail dissipates.
        alpha = Math.max(0, 1 - (-d) * fadeBehind) * 0.7;
      }
      if (alpha < 0.02) continue;
      ctx.strokeStyle = `rgba(200, 230, 255, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x + ux * p, a.y + uy * p);
      ctx.lineTo(a.x + ux * (p + dotLen), a.y + uy * (p + dotLen));
      ctx.stroke();
    }
    ctx.restore();
  }

  // While in transport, render a white-glowing "ghost" of the
  // character's head — no body, no arms, no legs. `intensity` is 0..1
  // (brightest at the midpoint of the arc).
  private drawTransportGhost(
    sx: number,
    sy: number,
    radius: number,
    intensity: number,
  ): void {
    const ctx = this.ctx;
    // Head sits where Magnek's head sits — roughly r*2 above the feet.
    const headY = sy - radius * 2;
    const glowR = radius * 2.2;
    // Outer halo (radial gradient, white to transparent).
    ctx.save();
    const halo = ctx.createRadialGradient(sx, headY, 0, sx, headY, glowR);
    halo.addColorStop(0, `rgba(255, 255, 255, ${0.6 * intensity + 0.25})`);
    halo.addColorStop(0.5, `rgba(220, 235, 255, ${0.3 * intensity})`);
    halo.addColorStop(1, "rgba(220, 235, 255, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(sx, headY, glowR, 0, Math.PI * 2);
    ctx.fill();
    // Bright core — small circle of near-white at the head position.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.8 + 0.2 * intensity})`;
    ctx.beginPath();
    ctx.arc(sx, headY, radius * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
