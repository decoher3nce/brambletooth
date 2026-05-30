// Isometric renderer. World coordinates (x, y) are on a 2D ground plane.
// We project to screen using a standard 2:1 isometric transform.
// Z is implicit (drawing order = sort by world y for fake depth).
//
// Visual language: flat polygons, no textures, single light direction
// from upper-left. Each prop is a tiny mesh of 2-4 polygons.

import type { World } from "../core/world";
import type { Entity } from "../core/entity";
import { isCharacter, isProjectile, isTrap, isObjective, isProp, isPlate } from "../core/entity";
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
  drawEntities(world: World, cam: Camera, visible?: (e: Entity) => boolean): void {
    const sorted = [...world.entities].sort((a, b) => {
      const ay = a.pos.y;
      const by = b.pos.y;
      if (ay !== by) return ay - by;
      return a.pos.x - b.pos.x;
    });
    for (const e of sorted) {
      if (visible && !visible(e)) continue;
      this.drawEntity(e, cam);
    }
  }

  drawEntity(e: Entity, cam: Camera): void {
    if (isProp(e)) this.drawProp(e, cam);
    else if (isObjective(e)) this.drawObjective(e, cam);
    else if (isTrap(e)) this.drawTrap(e, cam);
    else if (isPlate(e)) this.drawPlate(e, cam);
    else if (isProjectile(e)) this.drawProjectile(e, cam);
    else if (isCharacter(e)) this.drawCharacter(e, cam);
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
    }
  }

  private drawObjective(
    e: Extract<Entity, { kind: "objective" }>,
    cam: Camera,
  ): void {
    if (e.collected) return;
    const s = worldToScreen(e.pos, cam, this.cw, this.ch);
    const ctx = this.ctx;
    // Pulsing glow
    const t = (performance.now() / 400) % (Math.PI * 2);
    const glow = 0.7 + 0.3 * Math.sin(t);
    ctx.fillStyle = `rgba(255, 220, 80, ${0.2 * glow})`;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, 26, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // Diamond crystal
    ctx.fillStyle = "#ffd84a";
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 18);
    ctx.lineTo(s.x + 10, s.y - 6);
    ctx.lineTo(s.x, s.y + 6);
    ctx.lineTo(s.x - 10, s.y - 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#b8941e";
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - 18);
    ctx.lineTo(s.x + 10, s.y - 6);
    ctx.lineTo(s.x, s.y + 6);
    ctx.closePath();
    ctx.fill();
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
