// Cave arena — pitch-black playfield with chunky stalagmite rocks and
// glowing crystal geodes. Renderer paints a heavy darkness overlay
// with cut-outs for each character's forward flashlight cone and
// each crystal's ambient light circle, so play is genuinely
// low-vision: you only see what's in your cone or near a crystal.
//
// Objective art is the faceted GEM variant (see ArenaConfig.objectiveStyle
// + renderer drawObjective), so a survivor running for the exit
// reads visually as "collecting gems from a glowing cave."

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, TrackEntity } from "../core/entity";
import type { Vec2 } from "../core/math";

export const CAVE_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -700, minY: -500, maxX: 700, maxY: 500 },
  // Charcoal cave wall around the perimeter.
  fenceColor: "#3a3a44",
  // Light stone grey base. The "rough-stone" groundTexture
  // layered on top adds per-pixel noise and larger splotches
  // so the floor reads as natural cavern stone instead of a
  // flat tile.
  groundColor: "#9aa0a8",
  // Unused when groundTexture is set (renderer suppresses the
  // grid lines). Kept for ArenaConfig completeness.
  gridColor: "rgba(70, 80, 95, 0)",
  objectiveStyle: "gem",
  useFlashlightFOV: true,
  groundTexture: "rough-stone",
};

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cave Map 1 — "The Glow". Sparse stalagmite field with crystal
// clusters spread out enough that the lit corridors form a rough
// path network. Survivors traverse from north spawn to SE exit
// using crystal light + their own flashlight.
export function buildCave1(world: World, seed: number, _objectiveCount: number): void {
  const rng = mulberry32(seed);
  const b = world.arena.bounds;
  const placed: { x: number; y: number; r: number }[] = [];
  // Reserve spawn zones (same convention as forest + factory).
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.maxY - 80, r: 70 });
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.minY + 80, r: 70 });
  // Reserve the SE-corner exit zone.
  placed.push({ x: b.maxX - 110, y: b.maxY - 110, r: 60 });

  const tryPlace = (x: number, y: number, r: number): boolean => {
    for (const p of placed) {
      const dx = x - p.x;
      const dy = y - p.y;
      const rr = r + p.r + 6;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    placed.push({ x, y, r });
    return true;
  };

  const spawnPropAt = (
    x: number, y: number,
    shape: PropEntity["shape"], r: number, blocking: boolean,
  ): void => {
    world.spawn<PropEntity>({
      kind: "prop",
      pos: { x, y },
      radius: r,
      shape,
      blocking,
      dead: false,
    });
  };

  // Cave rocks (stalagmites / boulder piles). Blocking. Spread
  // through the playfield as cover.
  let attempts = 0, count = 0;
  while (count < 26 && attempts < 400) {
    attempts++;
    const x = b.minX + 60 + rng() * (b.maxX - b.minX - 120);
    const y = b.minY + 60 + rng() * (b.maxY - b.minY - 120);
    if (tryPlace(x, y, 24)) {
      spawnPropAt(x, y, "caverock", 20, true);
      count++;
    }
  }

  // Crystal clusters. Blocking AND ambient light sources (the
  // renderer's FOV pass reads every crystal-prop position to cut
  // out a wide bright circle of light). Place them with generous
  // spacing so each crystal lights its own pocket — every lit
  // pocket becomes a navigation landmark. With the brighter v2
  // crystal radius (170 in renderer) and the lower base darkness
  // overlay, 16 crystals knit a path network through the whole
  // playfield.
  attempts = 0; count = 0;
  while (count < 16 && attempts < 400) {
    attempts++;
    const x = b.minX + 100 + rng() * (b.maxX - b.minX - 200);
    const y = b.minY + 100 + rng() * (b.maxY - b.minY - 200);
    // Spacing slightly tighter than v1 to fit more crystals
    // while still keeping each lit pocket visually distinct.
    if (tryPlace(x, y, 75)) {
      spawnPropAt(x, y, "crystal", 18, true);
      count++;
    }
  }
}

// Cave Map 2 — "The Tracks". Four straight rail lines criss-cross
// the playfield; each spawns minecarts at irregular intervals at
// independently-randomized speeds. The tracks themselves are
// rendered bright (faint yellow safety glow + steel rails + brass-
// trimmed sleepers) so the player can see where to NOT stand;
// timing the crossings between cart waves is the encounter.
//
// Geometry: two horizontal tracks (a third + two-thirds height,
// running E↔W) and two vertical tracks (a third + two-thirds width,
// running N↔S). They intersect in a rough grid so a survivor
// crossing the cave can almost always find a clear lane within a
// few seconds, but never trivially.
//
// Per-track tuning is staggered so the carts don't synchronize:
//   track A — slow, frequent     (90-200 px/s · every 2.0-3.5s)
//   track B — fast, less frequent (160-280 px/s · every 3.5-5.5s)
//   track C — medium             (120-220 px/s · every 2.5-4.5s)
//   track D — fastest, rarest    (200-340 px/s · every 4.0-6.5s)
//
// Damage per hit is 30. Carts apply one hit per character per cart
// (engine's per-cart hitIds), so getting clipped costs a chunk of
// HP but doesn't insta-kill — the player can still escape if they
// move out fast.
export function buildCave2(world: World, seed: number, _objectiveCount: number): void {
  const rng = mulberry32(seed);
  const b = world.arena.bounds;
  const placed: { x: number; y: number; r: number }[] = [];
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.maxY - 80, r: 70 });
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.minY + 80, r: 70 });
  placed.push({ x: b.maxX - 110, y: b.maxY - 110, r: 60 });

  const tryPlace = (x: number, y: number, r: number): boolean => {
    for (const p of placed) {
      const dx = x - p.x;
      const dy = y - p.y;
      const rr = r + p.r + 6;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    placed.push({ x, y, r });
    return true;
  };

  // ---- Tracks ----
  // Pad endpoints slightly inside the arena so carts spawn just off-
  // screen and roll into view.
  const PAD = 40;
  const yHi = b.minY + (b.maxY - b.minY) * 0.33;
  const yLo = b.minY + (b.maxY - b.minY) * 0.67;
  const xHi = b.minX + (b.maxX - b.minX) * 0.33;
  const xLo = b.minX + (b.maxX - b.minX) * 0.67;
  const trackDefs: {
    a: Vec2; b: Vec2;
    minInt: number; maxInt: number;
    minSpd: number; maxSpd: number;
    initial: number;
  }[] = [
    // Horizontal, north — slow + frequent.
    {
      a: { x: b.minX + PAD, y: yHi }, b: { x: b.maxX - PAD, y: yHi },
      minInt: 2.0, maxInt: 3.5, minSpd: 90, maxSpd: 200, initial: 1.2,
    },
    // Horizontal, south — fast + rare.
    {
      a: { x: b.maxX - PAD, y: yLo }, b: { x: b.minX + PAD, y: yLo },
      minInt: 3.5, maxInt: 5.5, minSpd: 160, maxSpd: 280, initial: 2.8,
    },
    // Vertical, west — medium.
    {
      a: { x: xHi, y: b.minY + PAD }, b: { x: xHi, y: b.maxY - PAD },
      minInt: 2.5, maxInt: 4.5, minSpd: 120, maxSpd: 220, initial: 0.6,
    },
    // Vertical, east — fastest + rarest.
    {
      a: { x: xLo, y: b.maxY - PAD }, b: { x: xLo, y: b.minY + PAD },
      minInt: 4.0, maxInt: 6.5, minSpd: 200, maxSpd: 340, initial: 3.4,
    },
  ];
  for (const t of trackDefs) {
    world.spawn<TrackEntity>({
      kind: "track",
      pos: { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 },
      radius: Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) / 2,
      a: t.a,
      b: t.b,
      spawnTimer: t.initial,
      minInterval: t.minInt,
      maxInterval: t.maxInt,
      minSpeed: t.minSpd,
      maxSpeed: t.maxSpd,
      damage: 30,
      dead: false,
    });
  }

  // Reserve track corridors so cave rocks + crystals don't spawn
  // ON the rails. A 30-unit half-width on each side of each track
  // segment is enough breathing room.
  const TRACK_PAD = 30;
  const onTrack = (x: number, y: number, r: number): boolean => {
    for (const t of trackDefs) {
      const dx = t.b.x - t.a.x;
      const dy = t.b.y - t.a.y;
      const len2 = dx * dx + dy * dy || 1;
      const tParam = Math.max(0, Math.min(1, ((x - t.a.x) * dx + (y - t.a.y) * dy) / len2));
      const cx = t.a.x + dx * tParam;
      const cy = t.a.y + dy * tParam;
      if (Math.hypot(x - cx, y - cy) < r + TRACK_PAD) return true;
    }
    return false;
  };

  const spawnPropAt = (
    x: number, y: number,
    shape: PropEntity["shape"], r: number, blocking: boolean,
  ): void => {
    world.spawn<PropEntity>({
      kind: "prop",
      pos: { x, y },
      radius: r,
      shape,
      blocking,
      dead: false,
    });
  };

  // Cave rocks — fewer than Map 1 because the tracks already break
  // up the playfield. Skip placements on top of any track.
  let attempts = 0, count = 0;
  while (count < 18 && attempts < 400) {
    attempts++;
    const x = b.minX + 60 + rng() * (b.maxX - b.minX - 120);
    const y = b.minY + 60 + rng() * (b.maxY - b.minY - 120);
    if (onTrack(x, y, 20)) continue;
    if (tryPlace(x, y, 24)) {
      spawnPropAt(x, y, "caverock", 20, true);
      count++;
    }
  }

  // Crystals — same density as Map 1 but slightly fewer (the rails
  // themselves light up via their safety glow, doing some of the
  // navigation work).
  attempts = 0; count = 0;
  while (count < 12 && attempts < 400) {
    attempts++;
    const x = b.minX + 100 + rng() * (b.maxX - b.minX - 200);
    const y = b.minY + 100 + rng() * (b.maxY - b.minY - 200);
    if (onTrack(x, y, 18)) continue;
    if (tryPlace(x, y, 75)) {
      spawnPropAt(x, y, "crystal", 18, true);
      count++;
    }
  }
}
