// 1v1 Hunter vs Survivor mode.
// - One hunter (AI), one survivor (player). Roles can be swapped via config.
// - Hunter wins by reducing survivor HP to zero before timer.
// - Survivor wins by surviving timer OR collecting all required objectives.

import type { World } from "../core/world";
import type { GameMode, RoundOutcome } from "./mode";
import type { CharacterEntity } from "../core/entity";
import { CHARACTERS } from "../characters/characters";

export interface OneVOneConfig {
  hunterCharacterId: string;  // e.g. "slagy"
  survivorCharacterId: string; // e.g. "match"
  playerRole: "hunter" | "survivor";
  objectivesRequired: number;
}

export class OneVOneMode implements GameMode {
  id = "1v1";
  name = "1v1 Hunter vs Survivor";

  constructor(private cfg: OneVOneConfig) {}

  initialize(world: World): void {
    const b = world.arena.bounds;
    const hunterDef = CHARACTERS[this.cfg.hunterCharacterId];
    const survivorDef = CHARACTERS[this.cfg.survivorCharacterId];

    // Spawn hunter on the south side, survivor on the north side.
    const hunter = world.spawn<CharacterEntity>({
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

    const survivor = world.spawn<CharacterEntity>({
      kind: "character",
      team: "survivor",
      characterId: survivorDef.id,
      pos: { x: (b.minX + b.maxX) / 2, y: b.minY + 80 },
      radius: survivorDef.radius,
      dead: false,
      hp: survivorDef.maxHp,
      maxHp: survivorDef.maxHp,
      speed: survivorDef.speed,
      facing: Math.PI / 2,
      vel: { x: 0, y: 0 },
      cooldowns: {},
      statuses: {},
      isPlayer: this.cfg.playerRole === "survivor",
    });
  }

  checkOutcome(world: World): RoundOutcome {
    const hunters = world.charactersOnTeam("hunter");
    const survivors = world.charactersOnTeam("survivor");

    // Survivor eliminated -> hunter wins
    if (survivors.length === 0) return "hunter_win";
    // Hunter eliminated (not possible in v0.1 since Match has no offense, but safe-guard)
    if (hunters.length === 0) return "survivor_win";

    // Objective early-win check
    const objectives = world.entities.filter((e) => e.kind === "objective") as Array<{ collected: boolean }>;
    const collected = objectives.filter((o) => o.collected).length;
    if (collected >= this.cfg.objectivesRequired) return "survivor_win";

    // Timer
    if (world.elapsed >= world.timeLimit) return "survivor_win";

    return "ongoing";
  }
}
