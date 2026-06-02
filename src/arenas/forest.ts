// Forest arena. Generates trees, stumps, rocks scattered inside the bounds
// with collision-aware spacing. Also places objectives.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, ObjectiveEntity, StreamEntity, CliffEntity } from "../core/entity";

export const FOREST_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -700, minY: -500, maxX: 700, maxY: 500 },
  fenceColor: "#8a6b3d",
  groundColor: "#3a5a32",
  gridColor: "rgba(255, 255, 255, 0.04)",
};

// Seeded RNG so prop layout is repeatable. Mulberry32.
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildForest(world: World, seed: number, objectiveCount: number): void {
  const rng = mulberry32(seed);
  const b = world.arena.bounds;

  // Place props without overlapping each other or sitting near spawn points.
  const placed: { x: number; y: number; r: number }[] = [];
  // Reserve spawn zones (north/south centers) so characters don't spawn in a tree.
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.maxY - 80, r: 70 });
  placed.push({ x: (b.minX + b.maxX) / 2, y: b.minY + 80, r: 70 });

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

  const spawnPropAt = (x: number, y: number, shape: "tree" | "stump" | "rock", r: number, blocking: boolean) => {
    world.spawn<PropEntity>({
      kind: "prop",
      pos: { x, y },
      radius: r,
      shape,
      blocking,
      dead: false,
    });
  };

  // Trees: ~32
  let attempts = 0;
  let count = 0;
  while (count < 32 && attempts < 400) {
    attempts++;
    const x = b.minX + 30 + rng() * (b.maxX - b.minX - 60);
    const y = b.minY + 30 + rng() * (b.maxY - b.minY - 60);
    if (tryPlace(x, y, 22)) {
      spawnPropAt(x, y, "tree", 18, true);
      count++;
    }
  }

  // Stumps: ~8 (smaller, walkable around)
  attempts = 0;
  count = 0;
  while (count < 8 && attempts < 200) {
    attempts++;
    const x = b.minX + 30 + rng() * (b.maxX - b.minX - 60);
    const y = b.minY + 30 + rng() * (b.maxY - b.minY - 60);
    if (tryPlace(x, y, 16)) {
      spawnPropAt(x, y, "stump", 14, true);
      count++;
    }
  }

  // Rocks: ~10
  attempts = 0;
  count = 0;
  while (count < 10 && attempts < 200) {
    attempts++;
    const x = b.minX + 30 + rng() * (b.maxX - b.minX - 60);
    const y = b.minY + 30 + rng() * (b.maxY - b.minY - 60);
    if (tryPlace(x, y, 18)) {
      spawnPropAt(x, y, "rock", 16, true);
      count++;
    }
  }

  // Objectives: spread them out, prefer corners/edges to force exposure
  // for the survivor (risk vs reward).
  const obj_regions = [
    { x: b.minX + 150, y: b.minY + 150 },
    { x: b.maxX - 150, y: b.minY + 150 },
    { x: b.minX + 150, y: b.maxY - 150 },
    { x: b.maxX - 150, y: b.maxY - 150 },
    { x: 0, y: 0 }, // center
  ];
  for (let i = 0; i < Math.min(objectiveCount, obj_regions.length); i++) {
    const region = obj_regions[i];
    // Jitter
    let ox = region.x + (rng() - 0.5) * 80;
    let oy = region.y + (rng() - 0.5) * 80;
    // Try a few times to avoid sitting inside a prop
    for (let t = 0; t < 10; t++) {
      let ok = true;
      for (const p of placed) {
        const dx = ox - p.x;
        const dy = oy - p.y;
        if (dx * dx + dy * dy < (p.r + 30) * (p.r + 30)) {
          ok = false;
          break;
        }
      }
      if (ok) break;
      ox = region.x + (rng() - 0.5) * 120;
      oy = region.y + (rng() - 0.5) * 120;
    }
    world.spawn<ObjectiveEntity>({
      kind: "objective",
      pos: { x: ox, y: oy },
      radius: 22,
      collected: false,
      dead: false,
    });
    placed.push({ x: ox, y: oy, r: 30 });
  }
}

// Forest Map 2 — adds a chain of streams running east across the
// middle band of the map. Characters that wade in get slowed and
// pushed downstream; Magnesis won't fire while standing in one.
export function buildForest2(world: World, seed: number, objectiveCount: number): void {
  buildForest(world, seed, objectiveCount);
  // Four overlapping stream circles forming a "river" mid-map.
  // East-flowing (toward +x), moderate speed, half-speed slow.
  const radius = 95;
  const flow = { x: 1, y: 0 };
  const flowSpeed = 90;
  const slowFactor = 0.55;
  const xs = [-450, -200, 60, 320, 560];
  for (const x of xs) {
    world.spawn<StreamEntity>({
      kind: "stream",
      pos: { x, y: -40 },
      radius,
      flow,
      flowSpeed,
      slowFactor,
      dead: false,
    });
  }
}

// Forest Map 3 — adds a cliff edge running east-west across the
// upper third of the map. Survivors spawn north (high ground) and
// must drop south to access objectives and the exit, taking damage
// on the fall. Hunters spawn south and CAN'T climb the cliff.
export function buildForest3(world: World, seed: number, objectiveCount: number): void {
  buildForest(world, seed, objectiveCount);
  // One long horizontal cliff at y=-180. High side = north (-y in
  // screen-down, but here "north" is -y in world-y per arena bounds
  // minY < maxY). highNormal points toward decreasing y (north).
  const b = world.arena.bounds;
  world.spawn<CliffEntity>({
    kind: "cliff",
    pos: { x: 0, y: -180 },
    radius: Math.max(b.maxX - b.minX, 100), // bounding-r for snapshot ordering
    a: { x: b.minX + 40, y: -180 },
    b: { x: b.maxX - 40, y: -180 },
    highNormal: { x: 0, y: -1 },
    fallDamage: 25,
    dead: false,
  });
}
