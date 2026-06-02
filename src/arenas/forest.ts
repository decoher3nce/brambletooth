// Forest arena. Generates trees, stumps, rocks scattered inside the bounds
// with collision-aware spacing. Also places objectives.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, ObjectiveEntity, StreamEntity, CliffEntity, AnimalEntity, AnimalSpecies } from "../core/entity";

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

// Forest Map 2 — one long horizontal stream cutting across the
// middle of the map. Flow heads WEST (away from the SE-corner
// exit), so survivors pushing east to escape have to fight the
// current. Magnesis won't fire while standing in it.
export function buildForest2(world: World, seed: number, objectiveCount: number): void {
  buildForest(world, seed, objectiveCount);
  const b = world.arena.bounds;
  const cy = 0;
  const aPt = { x: b.minX + 60, y: cy };
  const bPt = { x: b.maxX - 60, y: cy };
  world.spawn<StreamEntity>({
    kind: "stream",
    // Bounding circle for cheap broad-phase: midpoint + (length/2 + width).
    pos: { x: (aPt.x + bPt.x) / 2, y: (aPt.y + bPt.y) / 2 },
    radius: Math.hypot(bPt.x - aPt.x, bPt.y - aPt.y) / 2 + 70,
    a: aPt,
    b: bPt,
    width: 65,
    flow: { x: -1, y: 0 }, // west — opposite the SE exit
    flowSpeed: 100,
    slowFactor: 0.55,
    dead: false,
  });
}

// Spawn an animal NPC at a given world position. Wander radius
// defines how far it strays from spawn. Bears are tankier + slower;
// deer are nimbler.
function spawnAnimal(
  world: World,
  pos: { x: number; y: number },
  species: AnimalSpecies,
  wanderRadius: number,
): void {
  const isBear = species === "bear";
  world.spawn<AnimalEntity>({
    kind: "animal",
    species,
    pos: { ...pos },
    radius: isBear ? 22 : 16,
    dead: false,
    hp: isBear ? 60 : 25,
    maxHp: isBear ? 60 : 25,
    speed: isBear ? 60 : 80,
    facing: Math.random() * Math.PI * 2,
    vel: { x: 0, y: 0 },
    mood: "wander",
    moodTimer: 0,
    wanderTarget: { ...pos },
    home: { ...pos },
    wanderRadius,
    targetId: null,
    reactionDecided: false,
    biteCooldown: 0,
  });
}

// Pick a non-overlapping spot for an animal — avoids props and
// spawn zones. Uses mulberry32 for determinism per-seed.
function tryPlaceAnimal(
  world: World,
  rng: () => number,
  bounds: World["arena"]["bounds"],
  species: AnimalSpecies,
  wanderRadius: number,
  margin: number,
): boolean {
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = bounds.minX + margin + rng() * (bounds.maxX - bounds.minX - margin * 2);
    const y = bounds.minY + margin + rng() * (bounds.maxY - bounds.minY - margin * 2);
    let ok = true;
    // Avoid sitting on top of a tree / rock / objective / plate /
    // existing animal.
    for (const e of world.entities) {
      if (e.kind === "prop" && e.blocking) {
        if (Math.hypot(x - e.pos.x, y - e.pos.y) < e.radius + 40) { ok = false; break; }
      } else if (e.kind === "objective") {
        if (Math.hypot(x - e.pos.x, y - e.pos.y) < 60) { ok = false; break; }
      } else if (e.kind === "animal") {
        if (Math.hypot(x - e.pos.x, y - e.pos.y) < 80) { ok = false; break; }
      }
    }
    // Also avoid spawn zones (hardcoded from buildForest).
    if (ok) {
      const cx = (bounds.minX + bounds.maxX) / 2;
      if (Math.hypot(x - cx, y - (bounds.maxY - 80)) < 130) ok = false;
      if (Math.hypot(x - cx, y - (bounds.minY + 80)) < 130) ok = false;
    }
    if (ok) {
      spawnAnimal(world, { x, y }, species, wanderRadius);
      return true;
    }
  }
  return false;
}

// Forest Map 4 — scattered wildlife. Three deer (skittish) plus two
// bears (more aggressive on hit). Animals wander within ~200 units
// of their spawn point and block movement on contact.
export function buildForest4(world: World, seed: number, objectiveCount: number): void {
  buildForest(world, seed, objectiveCount);
  const rng = mulberry32(seed + 999);
  for (let i = 0; i < 3; i++) tryPlaceAnimal(world, rng, world.arena.bounds, "deer", 220, 40);
  for (let i = 0; i < 2; i++) tryPlaceAnimal(world, rng, world.arena.bounds, "bear", 180, 40);
}

// Forest Map 5 — the gauntlet. Combines the stream band from Map 2,
// the cliff line from Map 3, and animals from Map 4 into one arena.
// Stream/cliff placements are shifted so they don't bisect the
// cliff line awkwardly.
export function buildForest5(world: World, seed: number, objectiveCount: number): void {
  buildForest(world, seed, objectiveCount);
  const b = world.arena.bounds;
  // One long horizontal stream south of the cliff line. Flows west
  // (away from SE exit) just like Map 2.
  const sy = 180;
  const sa = { x: b.minX + 60, y: sy };
  const sb = { x: b.maxX - 60, y: sy };
  world.spawn<StreamEntity>({
    kind: "stream",
    pos: { x: (sa.x + sb.x) / 2, y: sy },
    radius: Math.hypot(sb.x - sa.x, 0) / 2 + 70,
    a: sa,
    b: sb,
    width: 60,
    flow: { x: -1, y: 0 },
    flowSpeed: 90,
    slowFactor: 0.55,
    dead: false,
  });
  // Cliff — same north-of-middle position as Map 3.
  world.spawn<CliffEntity>({
    kind: "cliff",
    pos: { x: 0, y: -180 },
    radius: Math.max(b.maxX - b.minX, 100),
    a: { x: b.minX + 40, y: -180 },
    b: { x: b.maxX - 40, y: -180 },
    highNormal: { x: 0, y: -1 },
    fallDamage: 25,
    dead: false,
  });
  // Animals — two deer + one bear, fewer than Map 4 since the
  // arena's already crowded with terrain.
  const rng = mulberry32(seed + 7777);
  for (let i = 0; i < 2; i++) tryPlaceAnimal(world, rng, b, "deer", 200, 60);
  tryPlaceAnimal(world, rng, b, "bear", 160, 60);
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
