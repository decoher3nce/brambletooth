// Volcano arena. A volcano cone sits in the middle of the map; lava
// rivers radiate out in several directions from the crater. The
// arena ground is dark volcanic basalt with subtle ash banding.
//
// Map 1 — "Eruption" — keeps the layout simple: the volcano + four
// lava arms + scattered obsidian shards + a handful of static dark
// rocks for cover. Survivors spawn north / hunters south as usual;
// neither spawn lands in lava (the spawn zones are reserved before
// any prop or lava is placed).
//
// Lava model: each arm is a LavaEntity polyline starting near the
// crater rim and meandering outward toward (but not all the way
// to) the arena edge. Width tapers slightly from base to tip via
// the polyline density — we use longer segments near the tip so
// the smooth-curve render naturally thins them visually. Damage
// per second is intentionally LIGHT (10 hp/s) per the design ask;
// Gravemarch takes a third of that (LAVA_DAMAGE_MULT_GRAVEMARCH in
// engine.ts). Push along the flow is a gentle drag, not a current.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, LavaEntity } from "../core/entity";
import type { Vec2 } from "../core/math";

export const VOLCANO_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -700, minY: -500, maxX: 700, maxY: 500 },
  fenceColor: "#3a1f18",
  groundColor: "#2a1f1d",
  gridColor: "rgba(255, 140, 60, 0.05)",
};

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a meandering polyline starting at `start` and walking
// outward at the average direction `dir`, with `segments` steps of
// length `stepLen`. Each step deviates from the running direction
// by a small seeded angle so the lava arm looks natural rather
// than ruler-straight. Endpoints clamped inside the arena bounds
// minus `margin` so arms can never poke out the fence.
function buildArmPoints(
  start: Vec2, dir: Vec2, stepLen: number, segments: number,
  rng: () => number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  margin: number,
): Vec2[] {
  // Normalize the initial direction.
  const il = Math.hypot(dir.x, dir.y) || 1;
  let dx = dir.x / il;
  let dy = dir.y / il;
  const pts: Vec2[] = [{ x: start.x, y: start.y }];
  let x = start.x;
  let y = start.y;
  for (let i = 0; i < segments; i++) {
    // Steer by ±~14° each step.
    const turn = (rng() - 0.5) * 0.50;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const ndx = dx * c - dy * s;
    const ndy = dx * s + dy * c;
    dx = ndx;
    dy = ndy;
    x += dx * stepLen;
    y += dy * stepLen;
    // Clamp inside bounds; if clamped, stop extending (we're at
    // the edge).
    const minX = bounds.minX + margin;
    const maxX = bounds.maxX - margin;
    const minY = bounds.minY + margin;
    const maxY = bounds.maxY - margin;
    let clamped = false;
    if (x < minX) { x = minX; clamped = true; }
    if (x > maxX) { x = maxX; clamped = true; }
    if (y < minY) { y = minY; clamped = true; }
    if (y > maxY) { y = maxY; clamped = true; }
    pts.push({ x, y });
    if (clamped) break;
  }
  return pts;
}

function polylineBounds(
  pts: Vec2[], width: number,
): { center: Vec2; radius: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfDiag = Math.hypot(maxX - minX, maxY - minY) / 2;
  return { center: { x: cx, y: cy }, radius: halfDiag + width };
}

// Volcano Map 1 — "Eruption". Volcano in the center; four lava
// arms branching N/E/S/W (with seeded angle jitter so arms aren't
// perfectly orthogonal). The volcano itself is a blocking prop —
// characters route around it. Survivor spawn is at north center
// (minY + 80), hunter at south center (maxY - 80); arm directions
// are biased to NOT point straight at either spawn, so the spawn
// areas are always lava-free.
export function buildVolcano1(world: World, seed: number, _objectiveCount: number): void {
  const rng = mulberry32(seed);
  const b = world.arena.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;

  // Reserved spots so nothing else spawns on top of spawn zones.
  const placed: { x: number; y: number; r: number }[] = [];
  placed.push({ x: cx, y: b.maxY - 80, r: 90 }); // hunter spawn
  placed.push({ x: cx, y: b.minY + 80, r: 90 }); // survivor spawn

  // Volcano cone — the centerpiece. Big (radius 130) so it's
  // visually dominant and blocks line-of-sight across the map
  // center. The collision uses CORE_FRAC × radius, so the
  // effective walkable boundary is about 39px from the volcano
  // center — characters can't path straight through the mountain
  // but can squeeze around the base.
  const volcanoRadius = 130;
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: cx, y: cy },
    radius: volcanoRadius,
    shape: "volcano",
    blocking: true,
    dead: false,
  });
  placed.push({ x: cx, y: cy, r: volcanoRadius + 40 });

  // Four lava arms. Base angles pointing roughly NE, SE, SW, NW
  // so none of them shoot straight at a spawn zone (which sit
  // due-N and due-S). Each arm gets a seeded ±~20° angle nudge.
  const armAngles = [
    -Math.PI / 4,          // NE
     Math.PI / 4,          // SE
     3 * Math.PI / 4,      // SW
    -3 * Math.PI / 4,      // NW
  ];
  // Crater rim — lava arms start just OUTSIDE the volcano's core
  // so they appear to flow out of the mountain. The crater glow
  // in the renderer sits at the cone's top-right, so we offset
  // the visual start a bit there.
  const craterStartR = volcanoRadius * 0.5;
  for (let i = 0; i < armAngles.length; i++) {
    const baseA = armAngles[i]!;
    const wobble = (rng() - 0.5) * 0.35;
    const a = baseA + wobble;
    const sx = cx + Math.cos(a) * craterStartR;
    const sy = cy + Math.sin(a) * craterStartR;
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    // 5-8 segments, step length 70-95. Variation per arm so
    // none of them look identical.
    const segments = 5 + Math.floor(rng() * 4);
    const stepLen = 70 + rng() * 25;
    const pts = buildArmPoints(
      { x: sx, y: sy }, dir, stepLen, segments,
      rng, b, 50,
    );
    if (pts.length < 2) continue;
    const width = 38 + rng() * 8;
    const bb = polylineBounds(pts, width);
    world.spawn<LavaEntity>({
      kind: "lava",
      pos: bb.center,
      radius: bb.radius,
      points: pts,
      width,
      // Gentle drag, not a current — players don't get yanked
      // out of position by stepping in.
      flowSpeed: 20,
      slowFactor: 0.70,
      // 10 HP/s base. Engine ticks at LAVA_DAMAGE_COOLDOWN
      // intervals (0.5s) so a survivor standing in lava loses
      // 5 HP every half-second. Gravemarch takes 30% of that
      // (LAVA_DAMAGE_MULT_GRAVEMARCH in engine.ts).
      damagePerSec: 10,
      dead: false,
    });
  }

  // Scatter some obsidian shards as cover / decoration. Avoid
  // spawn zones, volcano, and lava polylines.
  const placedLavaPoints: Vec2[] = [];
  for (const e of world.entities) {
    if (e.kind === "lava") {
      for (const p of e.points) placedLavaPoints.push(p);
    }
  }
  const tryPlace = (x: number, y: number, r: number): boolean => {
    for (const p of placed) {
      const dx = x - p.x;
      const dy = y - p.y;
      const rr = r + p.r + 6;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    // Keep at least 60px from any lava polyline point — lava arms
    // are already wide and we don't want a rock perched in lava.
    for (const lp of placedLavaPoints) {
      const dx = x - lp.x;
      const dy = y - lp.y;
      if (dx * dx + dy * dy < 90 * 90) return false;
    }
    placed.push({ x, y, r });
    return true;
  };

  // Obsidian (sharp, blocking).
  let attempts = 0;
  let count = 0;
  while (count < 12 && attempts < 250) {
    attempts++;
    const x = b.minX + 40 + rng() * (b.maxX - b.minX - 80);
    const y = b.minY + 40 + rng() * (b.maxY - b.minY - 80);
    if (tryPlace(x, y, 22)) {
      world.spawn<PropEntity>({
        kind: "prop",
        pos: { x, y },
        radius: 18,
        shape: "obsidian",
        blocking: true,
        dead: false,
      });
      count++;
    }
  }

  // A few static dark rocks for additional cover, reuse the
  // existing "rock" shape — it renders as the original simple
  // grey blob (Rock-Wall rocks are tagged with ownerId so this
  // doesn't collide with the Gravemarch wall look).
  attempts = 0;
  count = 0;
  while (count < 6 && attempts < 200) {
    attempts++;
    const x = b.minX + 40 + rng() * (b.maxX - b.minX - 80);
    const y = b.minY + 40 + rng() * (b.maxY - b.minY - 80);
    if (tryPlace(x, y, 20)) {
      world.spawn<PropEntity>({
        kind: "prop",
        pos: { x, y },
        radius: 17,
        shape: "rock",
        blocking: true,
        dead: false,
      });
      count++;
    }
  }
}
