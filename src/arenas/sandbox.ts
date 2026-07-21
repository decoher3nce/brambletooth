// Sandbox arena. An open, sand-colored test ground with a scattering
// of every prop family so the player can try every ability on every
// kind of obstacle (tree → axe, rock → blocking only, crystal → cave
// glow, etc.). Bigger than the regular arenas so there's room to
// experiment. Used by SandboxMode.

import type { World, ArenaConfig } from "../core/world";
import type { PropEntity } from "../core/entity";

export const SANDBOX_ARENA_CONFIG: ArenaConfig = {
  bounds: { minX: -900, minY: -650, maxX: 900, maxY: 650 },
  // Warm sand color — distinct from the forest/cave/factory palette
  // so the sandbox reads as its own place at a glance.
  fenceColor: "#9a7a45",
  groundColor: "#c4a06a",
  gridColor: "rgba(0, 0, 0, 0.06)",
};

// Place one cluster per family around the edges of the arena,
// leaving the center clear for the player + dummies. Each cluster
// is a small ring of the same prop kind so the player can practice
// brushing, blocking, and chopping against each kind individually.
export function buildSandbox(world: World, _seed: number, _objectiveCount: number): void {
  const placeRing = (
    cx: number, cy: number,
    count: number, radius: number,
    shape: PropEntity["shape"],
    propRadius: number,
    blocking: boolean,
  ): void => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      world.spawn<PropEntity>({
        kind: "prop",
        pos: { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius },
        radius: propRadius,
        shape,
        blocking,
        dead: false,
      });
    }
  };

  // Forest cluster (NW) — trees + stumps. Trees take the axe.
  placeRing(-600, -380, 6, 90, "tree", 28, true);
  placeRing(-600, -380, 3, 30, "stump", 14, true);
  // Forest rocks (NE) — pure blocking, can't be chopped.
  placeRing(600, -380, 7, 100, "rock", 22, true);
  // Factory cluster (SW) — crates + pallets + a pipe.
  placeRing(-600, 380, 6, 110, "crate", 24, true);
  placeRing(-600, 380, 4, 50, "pallet", 18, true);
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: -750, y: 380 },
    radius: 22, shape: "pipe", blocking: true, dead: false,
  });
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: -450, y: 380 },
    radius: 26, shape: "oildrum", blocking: true, dead: false,
  });
  // Cave cluster (SE) — caverocks + crystals.
  placeRing(600, 380, 6, 100, "caverock", 26, true);
  placeRing(600, 380, 4, 40, "crystal", 18, true);
  // Center clearing — a couple of practice trees for axe testing
  // without forcing the player to walk to the NW cluster.
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: -180, y: -120 },
    radius: 28, shape: "tree", blocking: true, dead: false,
  });
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: 180, y: -120 },
    radius: 28, shape: "tree", blocking: true, dead: false,
  });
  world.spawn<PropEntity>({
    kind: "prop",
    pos: { x: 0, y: 220 },
    radius: 22, shape: "rock", blocking: true, dead: false,
  });
}
