// 1vN Hunter vs Survivors mode. One hunter, one or more survivors.
// - Hunter wins by reducing all survivors' HP to zero before the timer.
// - Survivors win by surviving the timer OR by collectively collecting the
//   required number of objectives.
// - With N=1 this is the original 1v1 (local single-player still uses it).

import type { World } from "../core/world";
import type { GameMode, RoundOutcome } from "./mode";
import type { CharacterEntity } from "../core/entity";
import { CHARACTERS } from "../characters/characters";

export interface HuntConfig {
  hunterCharacterId: string;
  // One or more survivor character ids. Duplicates allowed (two players
  // may pick the same character).
  survivorCharacterIds: string[];
  // Local single-player flag: which side the local human plays. Server-
  // authoritative play ignores this — each client flags its own isPlayer
  // from the yourEntityId it receives in `start`.
  playerRole: "hunter" | "survivor";
  objectivesRequired: number;
}

export class HuntMode implements GameMode {
  id = "hunt";
  name = "Hunter vs Survivors";

  constructor(private cfg: HuntConfig) {}

  initialize(world: World): void {
    const b = world.arena.bounds;
    const hunterDef = CHARACTERS[this.cfg.hunterCharacterId];

    // Hunter spawns centered on the south edge.
    world.spawn<CharacterEntity>({
      kind: "character",
      team: "hunter",
      characterId: hunterDef.id,
      pos: { x: (b.minX + b.maxX) / 2, y: b.maxY - 80 },
      radius: hunterDef.radius,
      dead: false,
      hp: hunterDef.maxHp,
      maxHp: hunterDef.maxHp,
      speed: hunterDef.speed,
      facing: -Math.PI / 2,
      vel: { x: 0, y: 0 },
      cooldowns: {},
      statuses: {},
      isPlayer: this.cfg.playerRole === "hunter",
    });

    // Survivors spawn distributed across the north edge. N=1 centers them;
    // N>1 spreads them evenly with arena padding so they don't clip the
    // fence. Spawn order matches the array — callers can map back to picks
    // by index via world.charactersOnTeam("survivor").
    const ids = this.cfg.survivorCharacterIds;
    const n = ids.length;
    const padding = 120;
    const usableW = b.maxX - b.minX - padding * 2;
    for (let i = 0; i < n; i++) {
      const sDef = CHARACTERS[ids[i]];
      const x =
        n === 1
          ? (b.minX + b.maxX) / 2
          : b.minX + padding + (i * usableW) / (n - 1);
      world.spawn<CharacterEntity>({
        kind: "character",
        team: "survivor",
        characterId: sDef.id,
        pos: { x, y: b.minY + 80 },
        radius: sDef.radius,
        dead: false,
        hp: sDef.maxHp,
        maxHp: sDef.maxHp,
        speed: sDef.speed,
        facing: Math.PI / 2,
        vel: { x: 0, y: 0 },
        cooldowns: {},
        statuses: {},
        // Local single-player only ever has one survivor; flag the first.
        isPlayer: this.cfg.playerRole === "survivor" && i === 0,
      });
    }
  }

  checkOutcome(world: World): RoundOutcome {
    const survivors = world.charactersOnTeam("survivor");
    const hunters = world.charactersOnTeam("hunter");

    if (survivors.length === 0) return "hunter_win";
    if (hunters.length === 0) return "survivor_win";

    const objectives = world.entities.filter(
      (e) => e.kind === "objective",
    ) as Array<{ collected: boolean }>;
    const collected = objectives.filter((o) => o.collected).length;
    if (collected >= this.cfg.objectivesRequired) return "survivor_win";

    if (world.elapsed >= world.timeLimit) return "survivor_win";

    return "ongoing";
  }
}
