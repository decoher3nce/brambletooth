// Isometric renderer. World coordinates (x, y) are on a 2D ground plane.
// We project to screen using a standard 2:1 isometric transform.
// Z is implicit (drawing order = sort by world y for fake depth).
//
// Visual language: flat polygons, no textures, single light direction
// from upper-left. Each prop is a tiny mesh of 2-4 polygons.

import type { World } from "../core/world";
import type { Entity } from "../core/entity";
import { isCharacter, isProjectile, isTrap, isObjective, isProp, isPlate, isExit, isStream, isLava, isCliff, isAnimal, isConveyor, isZombie } from "../core/entity";
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

  // Offscreen canvas used by drawFlashlightMask. The dark overlay +
  // carved light cutouts are rendered to this offscreen first, then
  // composited onto the main canvas with source-over so the carved
  // regions correctly reveal the entities below. Carving directly
  // on the main canvas with destination-out would punch holes
  // through the entities AND the canvas itself — the carved
  // regions would become transparent and show the page background.
  // Recreated when canvas dimensions change.
  private fovMask: HTMLCanvasElement | null = null;
  private fovMaskCtx: CanvasRenderingContext2D | null = null;

  // Lazily-generated rough-stone floor texture, used by the cave
  // (any arena with groundTexture === "rough-stone"). Built once
  // as a 512×512 tile of pixel noise + splotches, then served as
  // a CanvasPattern via fillStyle for cheap repeated rendering.
  private roughStonePattern: CanvasPattern | null = null;

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

    // Ground fill — flat color, then optional procedural texture
    // layered on top.
    ctx.fillStyle = world.arena.groundColor;
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath();
    ctx.fill();

    if (world.arena.groundTexture === "rough-stone") {
      // Cave: overlay the cached rough-stone noise pattern. The
      // pattern is anchored to world coords (not screen) so the
      // texture appears to scroll under the camera correctly.
      const pat = this.getRoughStonePattern();
      if (pat) {
        ctx.save();
        ctx.fillStyle = pat;
        // Translate so the pattern aligns with the world-space
        // origin under the camera. worldToScreen({0,0}) gives
        // us where (0,0) lands on screen; translate by that and
        // the pattern's tile origin tracks the camera.
        const origin = worldToScreen({ x: 0, y: 0 }, cam, this.cw, this.ch);
        ctx.translate(origin.x, origin.y);
        ctx.translate(-origin.x, -origin.y);
        ctx.beginPath();
        ctx.moveTo(c[0].x, c[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
        ctx.closePath();
        // Set the pattern's transform matrix so its origin
        // tracks the world (0,0). Without this the pattern is
        // anchored to the canvas, which makes it visibly slide
        // independent of the playfield when the camera moves
        // — wrong feel.
        try {
          (pat as unknown as { setTransform?: (m: DOMMatrix) => void }).setTransform?.(
            new DOMMatrix().translate(origin.x, origin.y),
          );
        } catch { /* DOMMatrix unavailable on very old browsers — fall through */ }
        ctx.fill();
        ctx.restore();
      }
    } else {
      // Default: subtle grid lines on the floor.
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
        e.kind === "stream" || e.kind === "lava" || e.kind === "cliff" ||
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
    const cw = this.cw;
    const ch = this.ch;

    // ---- Ensure an offscreen mask canvas sized to match the main
    // canvas backing store. We render the dark overlay + carve
    // light cutouts onto this offscreen first, then drawImage
    // onto the main canvas. Carving directly on the main canvas
    // with destination-out punches through the entities AND the
    // canvas pixels themselves — the cutout becomes transparent
    // and shows the page background, which is exactly the cave
    // bug the user reported (Slagy + crystals invisible inside
    // their own cone). The offscreen indirection fixes it.
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!this.fovMask || this.fovMask.width !== W || this.fovMask.height !== H) {
      this.fovMask = document.createElement("canvas");
      this.fovMask.width = W;
      this.fovMask.height = H;
      this.fovMaskCtx = this.fovMask.getContext("2d");
    }
    const mctx = this.fovMaskCtx;
    if (!mctx) return;

    // Match the main canvas's DPR transform so all lighting math
    // happens in CSS pixels (same coord system as worldToScreen).
    const sx = W / cw;
    const sy = H / ch;
    mctx.setTransform(sx, 0, 0, sy, 0, 0);

    // ---- Base darkness overlay on the offscreen ----
    // Near-opaque black: 95% alpha. The reference flashlight
    // game has true pitch-black outside the cone, with full
    // color inside. We leave the last 5% as a faint silhouette
    // hint so a player who pauses can pick out the closest
    // crystals + the arena fence even without their beam
    // pointing — keeps the cave navigable when standing still.
    mctx.globalCompositeOperation = "copy";
    mctx.fillStyle = "rgba(0, 0, 8, 0.95)";
    mctx.fillRect(0, 0, cw, ch);

    // ---- Carve light into the offscreen ----
    mctx.globalCompositeOperation = "destination-out";

    // Crystal ambient circles — wall-lamp style. Per-crystal
    // variation drives both visual halo AND this mask pocket
    // from the same hash, so a bright big crystal carves a
    // big bright hole in the darkness and a dim small one
    // carves a smaller one.
    for (const e of world.entities) {
      if (e.kind !== "prop" || e.shape !== "crystal") continue;
      const s = worldToScreen(e.pos, cam, cw, ch);
      const v = crystalVariation(e.id);
      const lightR = v.glowRadius;
      // Center peak alpha scales with the crystal's glow
      // brightness — a dim crystal carves a softer pocket.
      const peak = Math.min(1, v.glowBrightness);
      const grad = mctx.createRadialGradient(s.x, s.y, 12, s.x, s.y, lightR);
      grad.addColorStop(0,    `rgba(255, 255, 255, ${peak})`);
      grad.addColorStop(0.35, `rgba(255, 255, 255, ${peak * 0.85})`);
      grad.addColorStop(0.70, `rgba(255, 255, 255, ${peak * 0.45})`);
      grad.addColorStop(1,    `rgba(255, 255, 255, 0)`);
      mctx.fillStyle = grad;
      mctx.beginPath();
      mctx.arc(s.x, s.y, lightR, 0, Math.PI * 2);
      mctx.fill();
    }

    // Per-character flashlight cones.
    for (const c of world.entities) {
      if (c.kind !== "character" || c.dead || c.exited) continue;
      const s = worldToScreen(c.pos, cam, cw, ch);
      const isViewer = c.id === viewerId;
      if (isViewer) {
        // Viewer's beam. Four stacked cones with the inner core
        // at peak 1.00 — destination-out fully erases the dark
        // overlay there, so the lit area shows the underlying
        // entities in FULL COLOR (matches the reference
        // flashlight game where inside-cone is unmodified
        // gameplay color, outside-cone is pitch black).
        //
        // Layers, outer → inner:
        //   ±60° peak 0.18  (faint halo, softens the rim edge
        //                    against the near-opaque dark)
        //   ±45° peak 0.55  (rim)
        //   ±30° peak 0.85  (mid)
        //   ±15° peak 1.00  (full-color core)
        // Stacked with destination-out the alphas compound
        // multiplicatively, so the inner core compounds to
        // essentially full reveal while the rim still leaves
        // some dim.
        this.drawConeLight(mctx, s.x, s.y, c.facing, 340, (Math.PI / 180) * 60, 0.18);
        this.drawConeLight(mctx, s.x, s.y, c.facing, 340, Math.PI / 4,  0.55);
        this.drawConeLight(mctx, s.x, s.y, c.facing, 340, Math.PI / 6,  0.85);
        this.drawConeLight(mctx, s.x, s.y, c.facing, 340, Math.PI / 12, 1.00);
      } else {
        // Other characters: small full-circle halo so you can
        // spot them when they're close, even if your beam is
        // pointing the wrong way.
        this.drawConeLight(mctx, s.x, s.y, c.facing, 60, Math.PI, 0.55);
      }
    }

    // ---- Composite the mask onto the main canvas ----
    // The mask's transparent regions (carved by destination-out)
    // let the entities below show through; the still-opaque dark
    // regions tint the playfield. drawImage uses source-over by
    // default which is exactly what we want.
    //
    // We bypass the main canvas's DPR transform here because the
    // offscreen is sized to actual pixels and we want a 1:1
    // copy.
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.fovMask, 0, 0);
    ctx.restore();
  }

  // Stamp a single radial-gradient cone (or full circle when
  // halfAngle = π) onto an arbitrary context (the offscreen FOV
  // mask). `peak` is the alpha at the center of the gradient —
  // higher peak removes more darkness when this is rendered
  // with destination-out. Pulled out as a helper so both the
  // 3-stacked viewer beam and the simpler other-character halo
  // share one path.
  private drawConeLight(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number,
    facing: number, range: number, halfAngle: number,
    peak: number = 1.0,
  ): void {
    // Tighter distance falloff than v1 so the angular cone edge
    // in mid-range is dimmer (less visible "knife edge"). At
    // 50% range the alpha is already at 50% of peak, and by
    // 85% range it's down to 15%.
    const grad = ctx.createRadialGradient(cx, cy, 6, cx, cy, range);
    grad.addColorStop(0,    `rgba(255, 255, 255, ${peak})`);
    grad.addColorStop(0.5,  `rgba(255, 255, 255, ${peak * 0.5})`);
    grad.addColorStop(0.85, `rgba(255, 255, 255, ${peak * 0.15})`);
    grad.addColorStop(1,    `rgba(255, 255, 255, 0)`);
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

  // Build the cave's rough-stone tile pattern on first use, then
  // cache it. 512×512 tile of two layers:
  //   1. Per-pixel grey noise (±15 luminance) so the floor isn't
  //      a perfectly uniform color.
  //   2. ~80 splotches at varied sizes + low alpha — uneven
  //      patches of darker/lighter stone that read as worn
  //      cavern floor instead of a clean tile.
  // The tile is deterministically generated each session (no
  // seed across reloads — the player won't notice and it keeps
  // the code simple).
  private getRoughStonePattern(): CanvasPattern | null {
    if (this.roughStonePattern) return this.roughStonePattern;
    const SIZE = 512;
    const off = document.createElement("canvas");
    off.width = SIZE;
    off.height = SIZE;
    const tctx = off.getContext("2d");
    if (!tctx) return null;
    // Per-pixel noise — build directly via ImageData for speed.
    const img = tctx.createImageData(SIZE, SIZE);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      // Triangular noise (sum of two uniforms) gives a softer
      // distribution than uniform — fewer extreme outliers,
      // reads as gentle grain.
      const n = ((Math.random() + Math.random()) - 1) * 22;
      const v = Math.max(0, Math.min(255, 154 + n)); // base ~ #9aa0a8 brightness
      data[i]     = v;     // R
      data[i + 1] = v + 2; // G (cool shift)
      data[i + 2] = v + 6; // B (cool shift)
      data[i + 3] = 255;   // A
    }
    tctx.putImageData(img, 0, 0);
    // Splotches — soft darker/lighter blobs scattered across.
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * SIZE;
      const y = Math.random() * SIZE;
      const r = 8 + Math.random() * 38;
      const dark = Math.random() < 0.55;
      const grad = tctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      const tint = dark
        ? `rgba(40, 50, 60, ${0.18 + Math.random() * 0.22})`
        : `rgba(220, 225, 235, ${0.10 + Math.random() * 0.15})`;
      grad.addColorStop(0, tint);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      tctx.fillStyle = grad;
      tctx.beginPath();
      tctx.arc(x, y, r, 0, Math.PI * 2);
      tctx.fill();
    }
    this.roughStonePattern = this.ctx.createPattern(off, "repeat");
    return this.roughStonePattern;
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
    else if (isLava(e)) this.drawLava(e, cam);
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
      // Two flavors of rock:
      //   - Gravemarch's Rock Wall: ownerId is set. Jagged, sharp,
      //     varied per-rock — seeded by entity id so the same rock
      //     always looks the same. Palette spans greys + blues from
      //     Gravemarch's design so the wall reads as HIS work on
      //     any map background. Black outline keeps it readable
      //     against snow, dirt, conveyor steel, and cave gloom alike
      //   - Static cave / forest decoration: ownerId is undefined.
      //     Keep the original simple shape so existing maps look
      //     identical to v1
      if (e.ownerId !== undefined) {
        this.drawJaggedWallRock(s.x, s.y, e.radius, e.id);
      } else {
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
      }
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
      // Crystal cluster — varied per instance via crystalVariation(id).
      // Hue stays in the BLUE band (190-250), but size / brightness /
      // glow radius all jitter so each crystal is distinct: some are
      // dim little outcrops, others are big bright wall-lamps.
      // The FOV mask pass reads the SAME variation hash so the
      // light pool it carves matches what's painted here.
      const v = crystalVariation(e.id);
      const r = e.radius * v.scale;
      const t = (performance.now() / 800 + v.phaseOffset) % (Math.PI * 2);
      const pulse = 0.7 + 0.3 * Math.sin(t);
      // BIG soft additive glow. Radius and brightness driven by
      // the variation hash so the visual halo and the FOV mask
      // pocket agree.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const glowR = v.glowRadius;
      const hueDeg = v.hue;
      const glow = ctx.createRadialGradient(s.x, s.y, r * 0.5, s.x, s.y, glowR);
      glow.addColorStop(0,    `hsla(${hueDeg}, 90%, 68%, ${0.85 * pulse * v.glowBrightness})`);
      glow.addColorStop(0.25, `hsla(${hueDeg}, 85%, 60%, ${0.50 * pulse * v.glowBrightness})`);
      glow.addColorStop(0.55, `hsla(${hueDeg}, 80%, 48%, ${0.22 * pulse * v.glowBrightness})`);
      glow.addColorStop(1,    `hsla(${hueDeg}, 70%, 35%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Ground shadow.
      ctx.fillStyle = `hsla(${hueDeg}, 50%, 12%, ${0.40 * pulse})`;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 4, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
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
      // Three shards in the per-crystal hue, varying brightness.
      const shardLit = `hsl(${hueDeg}, 85%, 65%)`;
      const shardLitMid = `hsl(${hueDeg}, 82%, 60%)`;
      const shardLitBright = `hsl(${hueDeg}, 90%, 72%)`;
      const shardDark = `hsl(${hueDeg}, 60%, 35%)`;
      const shardDarkMid = `hsl(${hueDeg}, 58%, 30%)`;
      const shardDarkBright = `hsl(${hueDeg}, 65%, 42%)`;
      shard(s.x - r * 0.55, s.y, r * 1.1, r * 0.45, shardLit, shardDark);
      shard(s.x + r * 0.5, s.y, r * 1.3, r * 0.5, shardLitMid, shardDarkMid);
      shard(s.x, s.y, r * 1.9, r * 0.55, shardLitBright, shardDarkBright);
      // Bright inner highlight on center shard.
      ctx.fillStyle = `hsla(${hueDeg}, 100%, 92%, ${0.6 * pulse})`;
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.1, s.y - r * 1.6);
      ctx.lineTo(s.x + r * 0.05, s.y - r * 1.6);
      ctx.lineTo(s.x + r * 0.08, s.y - r * 0.6);
      ctx.lineTo(s.x - r * 0.08, s.y - r * 0.6);
      ctx.closePath();
      ctx.fill();
    } else if (e.shape === "volcano") {
      // Volcano cone — large impassable centerpiece for Volcano
      // World. Two-tone basalt slope, jagged silhouette, a
      // glowing molten crater on top, and a thin animated heat-
      // shimmer plume. radius drives overall size.
      const r = e.radius;
      // Ground footprint shadow.
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + r * 0.18, r * 1.10, r * 0.40, 0, 0, Math.PI * 2);
      ctx.fill();
      // Slope silhouette — 7-point jagged outline so the mountain
      // doesn't read as a smooth cone. Lit side (upper-left)
      // lighter, shadow side (right) darker.
      const peakY = s.y - r * 1.65;
      const baseY = s.y;
      const litPath = new Path2D();
      litPath.moveTo(s.x - r * 1.05, baseY);
      litPath.lineTo(s.x - r * 0.78, s.y - r * 0.50);
      litPath.lineTo(s.x - r * 0.45, s.y - r * 0.95);
      litPath.lineTo(s.x - r * 0.22, s.y - r * 1.35);
      litPath.lineTo(s.x - r * 0.06, peakY);
      litPath.lineTo(s.x + r * 0.30, peakY + r * 0.10);
      litPath.lineTo(s.x + r * 0.30, baseY);
      litPath.closePath();
      ctx.fillStyle = "#4e3a30";
      ctx.fill(litPath);
      const darkPath = new Path2D();
      darkPath.moveTo(s.x + r * 0.30, baseY);
      darkPath.lineTo(s.x + r * 0.30, peakY + r * 0.10);
      darkPath.lineTo(s.x + r * 0.55, s.y - r * 1.15);
      darkPath.lineTo(s.x + r * 0.80, s.y - r * 0.65);
      darkPath.lineTo(s.x + r * 1.05, s.y - r * 0.10);
      darkPath.lineTo(s.x + r * 1.10, baseY);
      darkPath.closePath();
      ctx.fillStyle = "#2c1e18";
      ctx.fill(darkPath);
      // Outline so the silhouette stays readable on any map.
      ctx.strokeStyle = "#13090a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x - r * 1.05, baseY);
      ctx.lineTo(s.x - r * 0.78, s.y - r * 0.50);
      ctx.lineTo(s.x - r * 0.45, s.y - r * 0.95);
      ctx.lineTo(s.x - r * 0.22, s.y - r * 1.35);
      ctx.lineTo(s.x - r * 0.06, peakY);
      ctx.lineTo(s.x + r * 0.30, peakY + r * 0.10);
      ctx.lineTo(s.x + r * 0.55, s.y - r * 1.15);
      ctx.lineTo(s.x + r * 0.80, s.y - r * 0.65);
      ctx.lineTo(s.x + r * 1.05, s.y - r * 0.10);
      ctx.lineTo(s.x + r * 1.10, baseY);
      ctx.stroke();
      // Lava streaks running down the lit face — bright orange.
      ctx.strokeStyle = "rgba(255, 110, 30, 0.85)";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.10, s.y - r * 1.5);
      ctx.lineTo(s.x - r * 0.30, s.y - r * 0.7);
      ctx.lineTo(s.x - r * 0.35, s.y - r * 0.1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x + r * 0.04, s.y - r * 1.5);
      ctx.lineTo(s.x + r * 0.18, s.y - r * 0.8);
      ctx.lineTo(s.x + r * 0.10, s.y - r * 0.15);
      ctx.stroke();
      // Crater rim + glowing molten pool.
      ctx.fillStyle = "#1a0e0a";
      ctx.beginPath();
      ctx.ellipse(s.x + r * 0.12, peakY + r * 0.05, r * 0.30, r * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const craterGlow = ctx.createRadialGradient(
        s.x + r * 0.12, peakY + r * 0.05, 0,
        s.x + r * 0.12, peakY + r * 0.05, r * 0.65,
      );
      craterGlow.addColorStop(0, "rgba(255, 240, 160, 0.95)");
      craterGlow.addColorStop(0.4, "rgba(255, 140, 40, 0.55)");
      craterGlow.addColorStop(1, "rgba(255, 80, 20, 0)");
      ctx.fillStyle = craterGlow;
      ctx.beginPath();
      ctx.arc(s.x + r * 0.12, peakY + r * 0.05, r * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Crater molten center.
      ctx.fillStyle = "#ffaa3a";
      ctx.beginPath();
      ctx.ellipse(s.x + r * 0.12, peakY + r * 0.05, r * 0.20, r * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();
      // Heat-shimmer plume — three faint translucent puff
      // ellipses rising and fading. Animated via performance.now.
      const tNow = performance.now() / 800;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 3; i++) {
        const ph = (tNow + i * 0.33) % 1;
        const dy = -ph * r * 0.7;
        const a = (1 - ph) * 0.30;
        const pr = r * (0.18 + ph * 0.10);
        ctx.fillStyle = `rgba(255, 200, 120, ${a})`;
        ctx.beginPath();
        ctx.ellipse(s.x + r * 0.12, peakY + dy - r * 0.15, pr, pr * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else if (e.shape === "obsidian") {
      // Obsidian shard — small sharp dark glass cluster. Faces
      // catch a faint blue-purple sheen so it doesn't read as a
      // plain rock. Two-tone (lit / shadow).
      const r = e.radius;
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2, r * 0.85, r * 0.30, 0, 0, Math.PI * 2);
      ctx.fill();
      // Main shard cluster — three jagged points.
      ctx.fillStyle = "#1a1320";
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.95, s.y);
      ctx.lineTo(s.x - r * 0.30, s.y - r * 1.10);
      ctx.lineTo(s.x + r * 0.20, s.y - r * 0.40);
      ctx.lineTo(s.x + r * 0.60, s.y - r * 1.30);
      ctx.lineTo(s.x + r * 0.95, s.y - r * 0.20);
      ctx.lineTo(s.x + r * 0.80, s.y);
      ctx.closePath();
      ctx.fill();
      // Lit highlight (upper-left facets).
      ctx.fillStyle = "#3a2a4a";
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.30, s.y - r * 1.10);
      ctx.lineTo(s.x - r * 0.05, s.y - r * 0.50);
      ctx.lineTo(s.x - r * 0.50, s.y - r * 0.30);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s.x + r * 0.60, s.y - r * 1.30);
      ctx.lineTo(s.x + r * 0.85, s.y - r * 0.70);
      ctx.lineTo(s.x + r * 0.40, s.y - r * 0.55);
      ctx.closePath();
      ctx.fill();
      // Outline.
      ctx.strokeStyle = "#0a060d";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.95, s.y);
      ctx.lineTo(s.x - r * 0.30, s.y - r * 1.10);
      ctx.lineTo(s.x + r * 0.20, s.y - r * 0.40);
      ctx.lineTo(s.x + r * 0.60, s.y - r * 1.30);
      ctx.lineTo(s.x + r * 0.95, s.y - r * 0.20);
      ctx.lineTo(s.x + r * 0.80, s.y);
      ctx.closePath();
      ctx.stroke();
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

    // Gem variant — rainbow faceted crystal that cycles through
    // the hue wheel. Used by the Cave world via
    // ArenaConfig.objectiveStyle. A small additive halo (~4×
    // the gem radius) in the current hue brightens the floor
    // around it — same wall-lamp pattern as crystals but
    // smaller, so a single gem doesn't outshine a crystal
    // cluster.
    if (this.activeWorld?.arena.objectiveStyle === "gem") {
      const r = 11;
      // Hue cycles through the full wheel every 4 seconds.
      // performance.now() is wall-clock so all clients see the
      // same rainbow phase, no protocol traffic required.
      const hue = (performance.now() / 11) % 360;
      // Additive rainbow halo on the floor.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const haloR = r * 4;
      const haloGrad = ctx.createRadialGradient(s.x, s.y, r * 0.5, s.x, s.y, haloR);
      haloGrad.addColorStop(0,    `hsla(${hue}, 95%, 70%, ${0.80 * glow})`);
      haloGrad.addColorStop(0.35, `hsla(${hue}, 90%, 60%, ${0.45 * glow})`);
      haloGrad.addColorStop(1,    `hsla(${hue}, 80%, 40%, 0)`);
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Faceted diamond.
      const gemPath = new Path2D();
      gemPath.moveTo(s.x, s.y - r);
      gemPath.lineTo(s.x + r * 0.75, s.y - r * 0.15);
      gemPath.lineTo(s.x, s.y + r * 0.95);
      gemPath.lineTo(s.x - r * 0.75, s.y - r * 0.15);
      gemPath.closePath();
      // Light face (upper-left) — bright rainbow hue.
      ctx.fillStyle = `hsl(${hue}, 95%, 75%)`;
      ctx.fill(gemPath);
      // Shadow face (right) — darker shade of same hue.
      ctx.save();
      ctx.clip(gemPath);
      ctx.fillStyle = `hsl(${hue}, 75%, 42%)`;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r * 0.75, s.y - r * 0.15);
      ctx.lineTo(s.x, s.y + r * 0.95);
      ctx.closePath();
      ctx.fill();
      // Center facet line.
      ctx.strokeStyle = "rgba(255, 255, 255, 0.70)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y + r * 0.95);
      ctx.stroke();
      ctx.restore();
      // Dark outline + bright sparkle.
      ctx.strokeStyle = `hsl(${hue}, 60%, 20%)`;
      ctx.lineWidth = 1.4;
      ctx.lineJoin = "round";
      ctx.stroke(gemPath);
      ctx.fillStyle = "rgba(255, 255, 255, 0.90)";
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

  // Flowing lava — same capsule-around-polyline construction as
  // a stream, but with a darker basalt crust, an orange-red
  // molten body, a bright additive yellow inner shimmer, and
  // animated bright cracks marching outward. Designed to read
  // as MOLTEN at a glance — no chance a player mistakes it for
  // a river. The bright inner glow uses globalCompositeOperation
  // "lighter" so it brightens whatever map ground sits beneath.
  private drawLava(
    e: Extract<Entity, { kind: "lava" }>,
    cam: Camera,
  ): void {
    const ctx = this.ctx;
    const pts = e.points.map((p) => worldToScreen(p, cam, this.cw, this.ch));
    if (pts.length < 2) return;
    const w = e.width;

    const buildPath = (target: CanvasRenderingContext2D) => {
      target.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
        const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
        target.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
      }
      target.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
    };

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Charred crust (basalt edge).
    ctx.lineWidth = (w + 8) * 2;
    ctx.strokeStyle = "rgba(40, 18, 12, 0.85)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    // Molten body — orange-red gradient lookalike via two passes.
    ctx.lineWidth = w * 2;
    ctx.strokeStyle = "#d83a14";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    ctx.lineWidth = w * 1.55;
    ctx.strokeStyle = "#ff7a2a";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    // Bright inner shimmer — additive so the lava feels luminous on
    // any background.
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = w * 1.0;
    ctx.strokeStyle = "rgba(255, 220, 90, 0.55)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    ctx.lineWidth = w * 0.45;
    ctx.strokeStyle = "rgba(255, 255, 200, 0.45)";
    ctx.beginPath();
    buildPath(ctx);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();

    // Cracked-crust segments — small dark lines crossing the body
    // perpendicular to the flow at regular arc-length intervals.
    // Phase shift moves them outward over time so the lava reads
    // as flowing rather than frozen.
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

    const t = (performance.now() / 1100) % 1;
    const spacing = 36;
    const crackW = Math.min(w * 0.85, 22);
    ctx.save();
    ctx.strokeStyle = "rgba(20, 8, 4, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    for (let s = -spacing + t * spacing; s < totalLen; s += spacing) {
      if (s < 0) continue;
      let seg = segs[0]!;
      for (const sg of segs) {
        if (s >= sg.cum && s <= sg.cum + sg.len) { seg = sg; break; }
      }
      const localT = (s - seg.cum) / (seg.len || 1);
      const cx = seg.p0.x + (seg.p1.x - seg.p0.x) * localT;
      const cy = seg.p0.y + (seg.p1.y - seg.p0.y) * localT;
      const ex = (seg.p1.x - seg.p0.x) / (seg.len || 1);
      const ey = (seg.p1.y - seg.p0.y) / (seg.len || 1);
      const px = -ey;
      const py = ex;
      ctx.beginPath();
      ctx.moveTo(cx + px * crackW, cy + py * crackW);
      ctx.lineTo(cx - px * crackW, cy - py * crackW);
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

    // Cargo riding the belt — purely cosmetic. Crates + gears
    // animated along the belt by performance.now(), with a
    // density tied to belt length. No entity state required.
    if (e.showCargo) {
      this.drawBeltCargo(a, b, w, e.flowSpeed, sign, e.id);
    }

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

  // Decorative cargo (small crates + tiny gears) sliding along a
  // conveyor belt in the flow direction. Renderer-only: no entity
  // state, position is derived from performance.now() so all
  // clients see the cargo at the same place at the same time
  // without any protocol traffic. Item type per slot derived from
  // a deterministic hash of the conveyor's id so a given belt
  // always has the same mix of crates vs gears.
  private drawBeltCargo(
    a: { x: number; y: number },
    b: { x: number; y: number },
    halfWidth: number,
    flowSpeed: number,
    flowSign: number,
    beltId: number,
  ): void {
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 30) return;
    const ex = dx / L;
    const ey = dy / L;
    // One cargo slot per ~80 screen pixels of belt.
    const slots = Math.max(2, Math.floor(L / 80));
    // Distance the cargo has moved this frame, in [0..L). The
    // sign matches the flow direction so cargo visibly slides
    // the right way.
    const traveled = ((performance.now() / 1000) * flowSpeed * flowSign) % L;
    for (let i = 0; i < slots; i++) {
      // Per-slot offset along the belt, with the global travel
      // distance added.
      const baseT = (i + 0.5) * (L / slots);
      let t = (baseT + traveled) % L;
      if (t < 0) t += L;
      // Slot type: hash of (beltId + i) → crate or gear.
      const hash = ((beltId * 73856093) ^ (i * 19349663)) >>> 0;
      const isGear = (hash & 3) === 0; // ~25% gears, 75% crates
      const cx = a.x + ex * t;
      const cy = a.y + ey * t;
      if (isGear) {
        // Spinning gear riding the belt. Smaller than the
        // end-roller gears so it reads as cargo, not the
        // belt's own mechanism.
        const gR = halfWidth * 0.5;
        const teeth = 8;
        const rO = gR;
        const rI = gR * 0.7;
        const rotation = (performance.now() / 1000) * 4 * flowSign;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rotation);
        ctx.fillStyle = "#3a3e44";
        ctx.beginPath();
        const segCount = teeth * 2;
        for (let s = 0; s < segCount; s++) {
          const ang = (s / segCount) * Math.PI * 2;
          const r2 = s % 2 === 0 ? rO : rI;
          const x = Math.cos(ang) * r2;
          const y = Math.sin(ang) * r2;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#9aa3ad";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#1a1d20";
        ctx.beginPath();
        ctx.arc(0, 0, gR * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // Small wooden crate riding the belt — flat top, two
        // visible side faces for a hint of 3D.
        const w = halfWidth * 0.85;
        const h = halfWidth * 0.85;
        ctx.fillStyle = "#8a6b3d";
        ctx.fillRect(cx - w * 0.5, cy - h * 0.55, w, h);
        ctx.strokeStyle = "#3d2814";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(cx - w * 0.5, cy - h * 0.55, w, h);
        ctx.strokeStyle = "#5a3f22";
        ctx.beginPath();
        ctx.moveTo(cx - w * 0.5, cy);
        ctx.lineTo(cx + w * 0.5, cy);
        ctx.moveTo(cx, cy - h * 0.55);
        ctx.lineTo(cx, cy + h * 0.45);
        ctx.stroke();
      }
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
    } else if (e.species === "bear") {
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
    } else if (e.species === "sweeper_bot") {
      // Small round trash-can shape on a wheeled base. Two LED
      // eyes face the direction of facing; eyes turn red when
      // angry. Antenna with a blinking light up top.
      const cx = s.x;
      const cy = s.y - r * 0.4 + bob;
      // Wheel base (dark cylinder)
      ctx.fillStyle = "#1a1d22";
      ctx.beginPath();
      ctx.ellipse(cx, s.y, r * 0.85, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      // Body — silver dome with a darker bottom band
      ctx.fillStyle = "#9aa5b0";
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.85, r * 0.72, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5a6470";
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * 0.35, r * 0.85, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#222830";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.85, r * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Highlight stripe
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.2, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      // Eyes — two glowing LEDs, color depends on mood. Always
      // point in facing direction.
      const facingY = Math.sin(e.facing);
      const eyeR = r * 0.13;
      const eyeOffset = r * 0.32;
      const eyeBaseX = cx + facingX * r * 0.25;
      const eyeBaseY = cy + facingY * r * 0.05;
      ctx.fillStyle = aggressive ? "#ff5a3a" : "#5af0c4";
      ctx.beginPath();
      ctx.arc(eyeBaseX - facingY * eyeOffset, eyeBaseY + facingX * eyeOffset, eyeR, 0, Math.PI * 2);
      ctx.arc(eyeBaseX + facingY * eyeOffset, eyeBaseY - facingX * eyeOffset, eyeR, 0, Math.PI * 2);
      ctx.fill();
      // Antenna with a blinking red light.
      ctx.strokeStyle = "#222830";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.65);
      ctx.lineTo(cx + r * 0.05, cy - r * 1.1);
      ctx.stroke();
      const blink = (Math.sin(performance.now() / 200) + 1) * 0.5;
      ctx.fillStyle = `rgba(255, 80, 60, ${0.55 + blink * 0.45})`;
      ctx.beginPath();
      ctx.arc(cx + r * 0.05, cy - r * 1.1, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.species === "welder_bot") {
      // Bigger stationary industrial arm: bolted base, joint,
      // arm extending in facing direction with a torch tip
      // that glows when angry.
      const cx = s.x;
      const cy = s.y - r * 0.2;
      // Bolted base
      ctx.fillStyle = "#3a3e44";
      ctx.beginPath();
      ctx.ellipse(cx, s.y, r * 0.95, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1d22";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, s.y, r * 0.95, r * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Pillar
      ctx.fillStyle = "#6e7681";
      ctx.fillRect(cx - r * 0.3, s.y - r * 0.9, r * 0.6, r * 0.8);
      ctx.strokeRect(cx - r * 0.3, s.y - r * 0.9, r * 0.6, r * 0.8);
      // Joint shoulder
      ctx.fillStyle = "#9aa3ad";
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.3, r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Arm extends in facing direction
      const facingY = Math.sin(e.facing);
      const armLen = r * 1.0;
      const tipX = cx + facingX * armLen;
      const tipY = cy - r * 0.3 + facingY * armLen;
      ctx.strokeStyle = "#6e7681";
      ctx.lineWidth = r * 0.32;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.3);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.strokeStyle = "#1a1d22";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.3);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      // Torch tip — small dark nozzle with glow when angry
      ctx.fillStyle = "#1a1d22";
      ctx.beginPath();
      ctx.arc(tipX, tipY, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      if (aggressive) {
        const sparkR = r * 0.4 + Math.sin(performance.now() / 60) * r * 0.15;
        const sg = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, sparkR);
        sg.addColorStop(0, "rgba(255, 220, 80, 0.95)");
        sg.addColorStop(0.5, "rgba(255, 120, 40, 0.55)");
        sg.addColorStop(1, "rgba(255, 80, 30, 0)");
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(tipX, tipY, sparkR, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Calm: tiny green status LED on the shoulder.
        ctx.fillStyle = "#5af070";
        ctx.beginPath();
        ctx.arc(cx + r * 0.18, cy - r * 0.45, r * 0.06, 0, Math.PI * 2);
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

    // Hold-to-cast windup (Glitch). Cyan/pink charge ring that
    // FILLS as the button is held — opposite visual semantic from
    // the channel ring (which empties). At full charge the ring
    // pulses white to telegraph "release now for max range."
    if (e.holdCharging) {
      const ability = ABILITIES[e.holdCharging.abilityId];
      const max = ability?.holdToCharge?.maxChargeTime ?? 1;
      const pct = Math.max(0, Math.min(1, e.holdCharging.elapsed / Math.max(0.001, max)));
      const isFull = pct >= 0.999;
      // Inner steady ring — always visible while held.
      ctx.strokeStyle = "rgba(120, 180, 255, 0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, centerY, e.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      // Progress arc — fills clockwise from the top.
      const arcColor = isFull
        ? `rgba(255, 255, 255, ${0.6 + 0.4 * Math.sin(performance.now() / 90)})`
        : "rgba(180, 220, 255, 0.95)";
      ctx.strokeStyle = arcColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        s.x,
        centerY,
        e.radius + 6,
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

    // Sprint Boots overlay — two small yellow boots at the
    // character's feet whenever they own the upgrade. Reads from
    // a distance so every player can tell who can sprint.
    if (e.hasSprintBoots) {
      this.drawSprintBootsOverlay(s.x, s.y, e.radius);
    }

    // HP bar + name tag.
    ctx.globalAlpha = 1;
    this.drawCharacterHud(e, s.x, topY, def);
  }

  // Gravemarch Rock Wall rock — 9-vertex jagged silhouette with
  // alternating spike + notch radii so the outline reads as SHARP
  // rather than pebbly. Per-rock seed derived from the entity id
  // picks the base color (mix of greys + Gravemarch's blue-stones
  // so it reads as his work) AND randomizes the per-vertex angle
  // jitter + radius noise so no two rocks in the same arc look
  // alike. A heavy black outline guarantees the wall is visible
  // on dirt, grass, snow, conveyor steel, or cave gloom alike.
  private drawJaggedWallRock(
    sx: number, sy: number, radius: number, entityId: number,
  ): void {
    const ctx = this.ctx;
    // Deterministic per-rock RNG.
    let seed = ((entityId * 9301 + 49297) % 233280) + 1;
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    // Color palette — Gravemarch grey-blues. Index by seed so
    // adjacent rocks pick different shades.
    const PALETTE: { lit: string; shadow: string }[] = [
      { lit: "#9aa3ad", shadow: "#586068" },  // light steel grey
      { lit: "#7a828d", shadow: "#454c54" },  // mid grey
      { lit: "#6e7681", shadow: "#3a4048" },  // dark grey
      { lit: "#7488a8", shadow: "#3d4a64" },  // blue-grey
      { lit: "#6a7e9e", shadow: "#34425a" },  // deeper blue-grey
      { lit: "#5a8ec0", shadow: "#2a4e70" },  // accent blue (rare-ish)
    ];
    const colorIdx = Math.floor(rand() * PALETTE.length);
    const { lit, shadow } = PALETTE[colorIdx]!;
    // Vertex count: 8-11, more = chunkier outline. Bigger rocks
    // get more vertices so the silhouette doesn't read as a low-
    // poly d20.
    const verts = 9 + Math.floor(rand() * 3);
    // Build the jagged outline. Alternate spike (radius * 1.05–
    // 1.18) and notch (radius * 0.55–0.78) vertices, with a
    // small per-vertex angle jitter so spikes don't sit on a
    // perfect polar grid. The aspect-y squash mimics the iso 2:1
    // ground projection — rocks look squat from above, not round.
    const points: { x: number; y: number }[] = [];
    const aspectY = 0.72;
    const angleOffset = rand() * Math.PI * 2;
    for (let i = 0; i < verts; i++) {
      const theta = angleOffset + (i / verts) * Math.PI * 2;
      const jitter = (rand() - 0.5) * 0.18;
      const a = theta + jitter;
      const isSpike = i % 2 === 0;
      const rMul = isSpike
        ? 1.05 + rand() * 0.13
        : 0.55 + rand() * 0.23;
      const rr = radius * rMul;
      points.push({
        x: sx + Math.cos(a) * rr,
        y: sy + Math.sin(a) * rr * aspectY,
      });
    }
    // Fill — lit color.
    ctx.fillStyle = lit;
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i]!.x, points[i]!.y);
    }
    ctx.closePath();
    ctx.fill();
    // Shadow side — fill a triangle fan over the lower-right half
    // of the rock to give it a clear lit/shadow split that matches
    // the upper-left light direction used elsewhere.
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.moveTo(sx, sy - radius * aspectY * 0.2);
    let shadowStarted = false;
    for (const p of points) {
      // Right-of-center AND below-of-center vertices form the
      // shadow region.
      if (p.x > sx - radius * 0.1 && p.y > sy - radius * aspectY * 0.4) {
        if (!shadowStarted) {
          ctx.moveTo(sx, sy - radius * aspectY * 0.2);
          ctx.lineTo(p.x, p.y);
          shadowStarted = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
    }
    if (shadowStarted) {
      ctx.closePath();
      ctx.fill();
    }
    // Heavy black outline — the readability guarantee.
    ctx.strokeStyle = "#15181d";
    ctx.lineWidth = Math.max(1.2, radius * 0.075);
    ctx.lineJoin = "miter";
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i]!.x, points[i]!.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.lineJoin = "miter";
    // Optional blue crack — show on ~half the rocks so the arc
    // glints with Gravemarch's signature blue. One straight line
    // from one spike vertex to a roughly-opposite one.
    if (rand() < 0.55) {
      const a = Math.floor(rand() * points.length);
      const b = (a + Math.floor(verts / 2) + Math.floor(rand() * 2)) % points.length;
      const pa = points[a]!;
      const pb = points[b]!;
      // Don't draw outside the silhouette — pull endpoints toward
      // the center so the crack is contained.
      const inset = 0.35;
      const ax = pa.x + (sx - pa.x) * inset;
      const ay = pa.y + (sy - pa.y) * inset;
      const bx = pb.x + (sx - pb.x) * inset;
      const by = pb.y + (sy - pb.y) * inset;
      ctx.strokeStyle = "rgba(74, 158, 230, 0.85)";
      ctx.lineWidth = Math.max(1, radius * 0.06);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      // One dog-leg waypoint so the crack reads as a fracture
      // rather than a ruler line.
      const midX = (ax + bx) / 2 + (rand() - 0.5) * radius * 0.18;
      const midY = (ay + by) / 2 + (rand() - 0.5) * radius * 0.18;
      ctx.lineTo(midX, midY);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  // Pair of small yellow boots sitting at the character's foot
  // level — one slightly forward, one slightly behind, both
  // straddling the iso shadow ellipse so they read as on the
  // ground regardless of body art. Each boot has a tiny black
  // lightning bolt on the shaft to match the shop icon. Size
  // scales with character radius so a small character (Match,
  // r=20) and a big one (Gravemarch, r=25) both get
  // proportionate boots.
  private drawSprintBootsOverlay(sx: number, sy: number, radius: number): void {
    const ctx = this.ctx;
    // Boot footprint width — scales with radius.
    const bw = radius * 0.58;
    const bh = bw * 0.58;
    // Two boots offset along the iso "feet axis" — left foot
    // slightly behind+left of center, right foot slightly
    // forward+right. The sy + ~0.3*radius nudge sits the boots
    // just below the body's apparent ground line so they peek out
    // from under the character without floating.
    const baseY = sy + radius * 0.28;
    const sideOff = radius * 0.42;
    this.drawSingleBoot(sx - sideOff, baseY - bh * 0.35, bw, bh);
    this.drawSingleBoot(sx + sideOff, baseY + bh * 0.15, bw, bh);
  }

  // One yellow boot in top-down iso view: a small rounded
  // rectangle with a darker sole strip + a 3-segment black
  // lightning bolt. Anchored at center.
  private drawSingleBoot(cx: number, cy: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    // Boot body — yellow rounded rectangle.
    ctx.fillStyle = "#ffd84a";
    ctx.strokeStyle = "#1a0e08";
    ctx.lineWidth = Math.max(1, w * 0.06);
    const r = Math.min(w, h) * 0.32;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Sole — dark strip across the bottom third.
    ctx.fillStyle = "#1a0e08";
    ctx.fillRect(x + r * 0.4, y + h * 0.62, w - r * 0.8, h * 0.22);
    // Black lightning bolt across the top.
    ctx.fillStyle = "#0a0a0a";
    const lx = cx;
    const ly = cy - h * 0.08;
    const u = w * 0.08;
    ctx.beginPath();
    ctx.moveTo(lx + 0.3 * u, ly - 3.0 * u);
    ctx.lineTo(lx - 1.7 * u, ly - 0.4 * u);
    ctx.lineTo(lx - 0.4 * u, ly - 0.4 * u);
    ctx.lineTo(lx - 1.2 * u, ly + 2.4 * u);
    ctx.lineTo(lx + 1.7 * u, ly - 0.8 * u);
    ctx.lineTo(lx + 0.4 * u, ly - 0.8 * u);
    ctx.lineTo(lx + 1.2 * u, ly - 3.0 * u);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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

// ---- Crystal per-instance variation ----
// Deterministic hash from a crystal's entity id into a bundle of
// visual variation knobs. Used by drawProp(crystal) AND by
// drawFlashlightMask so the visual halo and the FOV light pool
// agree (same crystal -> same glow size).
//
// Hue stays in the BLUE band (190-250°) for the cave biome — cyans
// through deep blues and violet-blue. Scale, glow radius, and glow
// brightness vary so each crystal looks distinct.
export interface CrystalVariation {
  scale: number;          // 0.75 .. 1.35 — body size multiplier
  hue: number;            // 190..250 degrees on the HSL wheel
  glowRadius: number;     // 100..240 px — the additive halo radius
  glowBrightness: number; // 0.55..1.10 — multiplier on glow alpha
  phaseOffset: number;    // 0..2π — desyncs the pulse between crystals
}
export function crystalVariation(id: number): CrystalVariation {
  // Simple multiplicative hash; slice the 32-bit output into
  // independent 0..1 values per knob. Same id always gives the
  // same numbers across reloads + clients.
  const seed = (id * 2654435761) >>> 0;
  const rand = (slice: number): number => {
    const x = ((seed >>> (slice * 5)) ^ (seed >>> (slice * 7 + 3))) >>> 0;
    return (x % 100000) / 100000;
  };
  const scale = 0.75 + rand(0) * 0.60;       // 0.75..1.35
  const hue = 190 + rand(1) * 60;            // 190..250 (cyan -> deep blue)
  const glowRadius = 100 + rand(2) * 140;    // 100..240
  const glowBrightness = 0.55 + rand(3) * 0.55; // 0.55..1.10
  const phaseOffset = rand(4) * Math.PI * 2;
  return { scale, hue, glowRadius, glowBrightness, phaseOffset };
}
