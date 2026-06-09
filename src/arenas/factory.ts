// Factory arena — cold industrial environment. Concrete floor with a
// faint yellow safety grid, steel-gray perimeter fence. Replaces the
// forest's organic prop set (trees / stumps / rocks) with industrial
// props (crates / pipes / oil drums / pallets). Same arena bounds as
// the forest so existing modes (HuntMode + objectives + exit) drop
// in without changes.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity, ConveyorEntity, AnimalEntity, AnimalSpecies } from "../core/entity";
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

// Factory Map 3 — "The Catwalks". Two BELT CHAINS cut across the map,
// each one a slow GROUND segment that hands off to a fast ELEVATED
// segment at the midpoint. Every belt has spinning gear rollers for
// the factory-machinery vibe.
//
// Layout:
//   y = -200  (top half)
//     G1: ground belt, west half, flows EAST   (slow, 80)
//     E1: catwalk belt, east half, flows EAST  (fast, 165)
//     ↳ G1's east endpoint and E1's west endpoint coincide at x=0,
//       so a survivor riding G1 east hits the entry zone of E1 and
//       gets lifted onto the catwalk without losing momentum.
//
//   y = 200   (bottom half)
//     E2: catwalk belt, east half, flows WEST  (fast, 165)
//     G2: ground belt, west half, flows WEST   (slow, 80)
//     ↳ Mirror — entry at x=0, west-bound express lane for whoever
//       can use it (hunter chasing back to the spawn pen, or a
//       confused survivor losing all their distance).
//
// Walking UNDER an elevated belt: just walk through the belt's
// footprint at ground level — the height-match check in the
// engine ignores the push. You'll see the shadow over your head.
//
// Walking ON the elevated belt from another belt: step onto the
// shared endpoint at x=0 to get lifted; ride the fast lane; walk
// off the far end to drop back to the floor.
export function buildFactory3(world: World, seed: number, objectiveCount: number): void {
  buildFactory(world, seed, objectiveCount);
  const b = world.arena.bounds;
  const beltWidth = 50;
  const xMargin = 80;

  // Top chain — both segments flow east. G1 hands to E1 at x=0.
  const g1A = { x: b.minX + xMargin, y: -200 };
  const g1B = { x: 0, y: -200 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (g1A.x + g1B.x) / 2, y: g1A.y },
    radius: Math.hypot(g1B.x - g1A.x, 0) / 2 + beltWidth,
    a: g1A,
    b: g1B,
    width: beltWidth,
    flow: { x: 1, y: 0 },
    flowSpeed: 80,
    elevated: false,
    showGears: true,
    dead: false,
  });
  clearPropsFromConveyor(world, g1A, g1B, beltWidth);
  const e1A = { x: 0, y: -200 };
  const e1B = { x: b.maxX - xMargin, y: -200 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (e1A.x + e1B.x) / 2, y: e1A.y },
    radius: Math.hypot(e1B.x - e1A.x, 0) / 2 + beltWidth,
    a: e1A,
    b: e1B,
    width: beltWidth,
    flow: { x: 1, y: 0 },
    flowSpeed: 165,
    elevated: true,
    showGears: true,
    dead: false,
  });
  // No clearProps on the catwalk — it's overhead, props on the
  // floor below are fine. Floor stays cluttered for cover.

  // Bottom chain — both segments flow west. E2 hands to G2 at x=0.
  const e2A = { x: b.maxX - xMargin, y: 200 };
  const e2B = { x: 0, y: 200 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (e2A.x + e2B.x) / 2, y: e2A.y },
    radius: Math.hypot(e2B.x - e2A.x, 0) / 2 + beltWidth,
    a: e2A,
    b: e2B,
    width: beltWidth,
    flow: { x: -1, y: 0 },
    flowSpeed: 165,
    elevated: true,
    showGears: true,
    dead: false,
  });
  const g2A = { x: 0, y: 200 };
  const g2B = { x: b.minX + xMargin, y: 200 };
  world.spawn<ConveyorEntity>({
    kind: "conveyor",
    pos: { x: (g2A.x + g2B.x) / 2, y: g2A.y },
    radius: Math.hypot(g2B.x - g2A.x, 0) / 2 + beltWidth,
    a: g2A,
    b: g2B,
    width: beltWidth,
    flow: { x: -1, y: 0 },
    flowSpeed: 80,
    elevated: false,
    showGears: true,
    dead: false,
  });
  clearPropsFromConveyor(world, g2A, g2B, beltWidth);
}

// Helper: spawn one wandering NPC (used for robots in Factory
// Map 4). Same shape as the forest's buildAnimal but lives here
// to keep arena spawn data co-located with the maps that need it.
function spawnRobot(
  world: World,
  pos: { x: number; y: number },
  species: AnimalSpecies,
): void {
  const isWelder = species === "welder_bot";
  world.spawn<AnimalEntity>({
    kind: "animal",
    species,
    pos: { ...pos },
    // Sweepers are smaller and more mobile; welders are big and bolted.
    radius: isWelder ? 26 : 18,
    dead: false,
    // High HP per spec.
    hp: isWelder ? 150 : 110,
    maxHp: isWelder ? 150 : 110,
    speed: isWelder ? 0 : 55,
    facing: Math.random() * Math.PI * 2,
    vel: { x: 0, y: 0 },
    mood: "wander",
    moodTimer: 0,
    wanderTarget: { ...pos },
    home: { ...pos },
    // Welders don't wander at all (radius 0 → stays on home).
    wanderRadius: isWelder ? 0 : 110,
    targetId: null,
    reactionDecided: false,
    biteCooldown: 0,
    brushMeter: 0,
    lastBrusherId: null,
  });
}

// Factory Map 4 — "Assembly Floor". A crowded production line:
//   - Many SHORT conveyor belts running in varied directions
//     (horizontal, vertical, diagonal), each with cargo + gears
//     visibly riding along.
//   - Two sweeper bots wander between the belts, beeping when
//     brushed and spinning grumpily when bumped too much.
//   - Two welder bots bolted near the center, beeping a low buzz
//     when brushed and zapping a small contact zone when angered.
//   - Standard prop clutter (crates / pipes / drums / pallets)
//     for cover, plus the same north/south spawn + SE exit
//     layout as the other Factory maps so HuntMode just works.
export function buildFactory4(world: World, seed: number, objectiveCount: number): void {
  buildFactory(world, seed, objectiveCount);
  const beltWidth = 38; // narrower than Map 2 — these are short belts

  // Belt template: place a short belt between two world-space
  // points with the given flow vector and a per-belt
  // showCargo + showGears.
  const placeBelt = (
    ax: number, ay: number, bx: number, by: number,
    flowX: number, flowY: number, speed: number,
  ): void => {
    const a = { x: ax, y: ay };
    const b = { x: bx, y: by };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    world.spawn<ConveyorEntity>({
      kind: "conveyor",
      pos: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      radius: len / 2 + beltWidth,
      a, b,
      width: beltWidth,
      flow: { x: flowX, y: flowY },
      flowSpeed: speed,
      elevated: false,
      showGears: true,
      showCargo: true,
      dead: false,
    });
    clearPropsFromConveyor(world, a, b, beltWidth);
  };

  // Ten short conveyors in varied directions. Each is ~180-260
  // world units long (much shorter than Map 2's 1200+) and the
  // mix of horizontal / vertical / diagonal gives the floor an
  // "assembly line" feel rather than a single super-highway.
  // Speeds vary so the cargo on different belts moves at
  // different rates.
  placeBelt(-560, -300, -260, -300,  1,  0, 90);   // top-W horizontal east
  placeBelt(-200, -300,   60, -300,  1,  0, 110);  // top-mid horizontal east
  placeBelt( 100, -260,  280, -100,  0.66, 0.75, 95); // top-E diagonal SE
  placeBelt( 350, -260,  580, -260,  1,  0, 100);  // top-E horizontal east
  placeBelt(-450,  -50, -450,  150,  0,  1, 95);   // W vertical south
  placeBelt(-200,    0,   80,    0,  1,  0, 105);  // mid horizontal east
  placeBelt( 140,    0,  140,  200,  0,  1, 90);   // mid-E vertical south
  placeBelt( 450,    0,  450,  220,  0,  1, 100);  // E vertical south
  placeBelt(-560,  280, -300,  280,  1,  0, 95);   // bottom-W horizontal east
  placeBelt(  60,  300,  280,  280,  1, -0.1, 100); // bottom-mid horizontal east
  placeBelt( 350,  280,  580,  280,  1,  0, 90);   // bottom-E horizontal east
  placeBelt(-260, -300, -260, -100,  0,  1, 85);   // W-vertical south

  // Robots. Two sweepers wandering between belt clusters, two
  // welders bolted at chokepoints near the center.
  spawnRobot(world, { x: -380, y: -90 },  "sweeper_bot");
  spawnRobot(world, { x:  240, y:  80 },  "sweeper_bot");
  spawnRobot(world, { x: -120, y: -120 }, "welder_bot");
  spawnRobot(world, { x:  300, y:  120 }, "welder_bot");
}

