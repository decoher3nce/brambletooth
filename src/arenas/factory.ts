// Factory arena — cold industrial environment. Concrete floor with a
// faint yellow safety grid, steel-gray perimeter fence. Replaces the
// forest's organic prop set (trees / stumps / rocks) with industrial
// props (crates / pipes / oil drums / pallets). Same arena bounds as
// the forest so existing modes (HuntMode + objectives + exit) drop
// in without changes.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, ConveyorEntity } from "../core/entity";
import { distToSegment } from "../core/math";

export const FACTORY_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -700, minY: -500, maxX: 700, maxY: 500 },
  // Steel-gray chain-link perimeter — reads as warehouse fencing.
  fenceColor: "#4a4f55",
  // Concrete floor — cool desaturated gray.
  groundColor: "#3a3e44",
  // Faint amber safety-stripe grid so the floor doesn't feel dead.
  gridColor: "rgba(255, 200, 80, 0.06)",
};

// Seeded RNG — same mulberry32 the forest uses, repeated here so the
// arena file stays self-contained.
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Layout convention — same spawn-zone reservations as the forest so
// HuntMode (which spawns characters at fixed positions and places
// the exit in the SE corner) just works.
export function buildFactory(world: World, seed: number, _objectiveCount: number): void {
  const rng = mulberry32(seed);
  const b = world.arena.bounds;
  const placed: { x: number; y: number; r: number }[] = [];
  // Reserve spawn zones (north + south centers).
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

  // Crates — chunky wooden boxes scattered like a warehouse floor.
  let attempts = 0, count = 0;
  while (count < 22 && attempts < 300) {
    attempts++;
    const x = b.minX + 40 + rng() * (b.maxX - b.minX - 80);
    const y = b.minY + 40 + rng() * (b.maxY - b.minY - 80);
    if (tryPlace(x, y, 22)) {
      spawnPropAt(x, y, "crate", 18, true);
      count++;
    }
  }

  // Pipes — steel cylinders, tighter footprint, used as cover.
  attempts = 0; count = 0;
  while (count < 10 && attempts < 200) {
    attempts++;
    const x = b.minX + 40 + rng() * (b.maxX - b.minX - 80);
    const y = b.minY + 40 + rng() * (b.maxY - b.minY - 80);
    if (tryPlace(x, y, 18)) {
      spawnPropAt(x, y, "pipe", 14, true);
      count++;
    }
  }

  // Oil drums — fat cylinders.
  attempts = 0; count = 0;
  while (count < 8 && attempts < 200) {
    attempts++;
    const x = b.minX + 40 + rng() * (b.maxX - b.minX - 80);
    const y = b.minY + 40 + rng() * (b.maxY - b.minY - 80);
    if (tryPlace(x, y, 20)) {
      spawnPropAt(x, y, "oildrum", 16, true);
      count++;
    }
  }

  // Pallets — non-blocking floor decoration so the place doesn't
  // feel empty between blocking obstacles.
  attempts = 0; count = 0;
  while (count < 6 && attempts < 100) {
    attempts++;
    const x = b.minX + 60 + rng() * (b.maxX - b.minX - 120);
    const y = b.minY + 60 + rng() * (b.maxY - b.minY - 120);
    if (tryPlace(x, y, 22)) {
      spawnPropAt(x, y, "pallet", 18, false);
      count++;
    }
  }
}

// Remove blocking props (crates, pipes, drums) that overlap the
// conveyor footprint. Pallets are decoration only and stay. Called
// after buildFactory + conveyor spawn so the belts aren't running
// through stacked crates.
function clearPropsFromConveyor(
  world: World,
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
): void {
  const pad = 8;
  world.entities = world.entities.filter((e) => {
    if (e.kind !== "prop") return true;
    if (!e.blocking) return true; // pallets stay
    const d = distToSegment(e.pos, a, b);
    return d >= width + e.radius + pad;
  });
}

// Forest Map 2 analogue for Factory: TWO parallel conveyor belts
// cutting across the middle of the map. The NORTH belt flows EAST
// (toward the SE-corner exit) — survivor express lane. The SOUTH
// belt flows WEST — hunter express lane, or a survivor trap if
// they step on it accidentally. Both create positional drama:
// jumping on a belt is a commit, and the wrong belt costs you
// time.
export function buildFactory2(world: World, seed: number, objectiveCount: number): void {
  buildFactory(world, seed, objectiveCount);
  const b = world.arena.bounds;
  const beltWidth = 50;
  const xMargin = 80;
  // North belt — east flow, sits above center.
  const nA = { x: b.minX + xMargin, y: -150 };
  const nB = { x: b.maxX - xMargin, y: -150 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (nA.x + nB.x) / 2, y: nA.y },
    radius: Math.hypot(nB.x - nA.x, 0) / 2 + beltWidth,
    a: nA,
    b: nB,
    width: beltWidth,
    flow: { x: 1, y: 0 }, // east, toward exit
    flowSpeed: 110,
    dead: false,
  });
  clearPropsFromConveyor(world, nA, nB, beltWidth);
  // South belt — west flow, sits below center.
  const sA = { x: b.minX + xMargin, y: 150 };
  const sB = { x: b.maxX - xMargin, y: 150 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (sA.x + sB.x) / 2, y: sA.y },
    radius: Math.hypot(sB.x - sA.x, 0) / 2 + beltWidth,
    a: sA,
    b: sB,
    width: beltWidth,
    flow: { x: -1, y: 0 }, // west, away from exit
    flowSpeed: 110,
    dead: false,
  });
  clearPropsFromConveyor(world, sA, sB, beltWidth);
}

