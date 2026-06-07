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
import type { PropEntity } from "../core/entity";

export const CAVE_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -700, minY: -500, maxX: 700, maxY: 500 },
  // Charcoal cave wall around the perimeter.
  fenceColor: "#3a3a44",
  // LIGHT grey cave floor. The flashlight needs something visible
  // to land on — a near-black floor swallows the cone entirely.
  // This stone tone is light enough that the lit cone reads as
  // "here's the cave floor I'm walking on" rather than a vague
  // brighter patch over darkness.
  groundColor: "#9aa0a8",
  // Visible cool-grey grid for stone-tile texture. Stronger than
  // the other arenas because the cave needs SOMETHING in the lit
  // area for the eye to read as floor.
  gridColor: "rgba(70, 80, 95, 0.45)",
  // Gem variant for objective rendering.
  objectiveStyle: "gem",
  // Heavy darkness overlay + flashlight cone + crystal lighting.
  useFlashlightFOV: true,
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
