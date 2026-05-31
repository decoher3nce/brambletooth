// 1vN Hunter vs Survivors mode. One hunter, one or more survivors.
// - Hunter wins by reducing all survivors' HP to zero before the timer.
// - Survivors win by surviving the timer OR by any single survivor
//   collecting `objectivesRequired` objectives. Objectives respawn one at
//   a time as each is taken, so the field always has exactly one target.
// - With N=1 this reduces to 1v1 (local single-player still uses it).

import type { World } from "../core/world";
import type { GameMode, RoundOutcome } from "./mode";
import type { CharacterEntity, ObjectiveEntity } from "../core/entity";
import { isProp } from "../core/entity";
import { CHARACTERS } from "../characters/characters";
import { dist } from "../core/math";

export interface HuntConfig {
  hunterCharacterId: string;
  // One or more survivor character ids. Duplicates allowed (two players
  // may pick the same character).
  survivorCharacterIds: string[];
  // Local single-player flag: which side the local human plays. Server-
  // authoritative play ignores this — each client flags its own isPlayer
  // from the yourEntityId it receives in `start`.
  playerRole: "hunter" | "survivor";
  // Per-survivor target. The first survivor to collect this many objectives
  // wins for the survivor team.
  objectivesRequired: number;
}

const OBJECTIVE_RADIUS = 22;
const SPAWN_MARGIN = 100;
const MIN_OBJECTIVE_CLEARANCE = 60; // away from any character / prop / plate

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
      objectivesCollected: 0,
      exited: false,
    });

    // Survivors spawn distributed across the north edge.
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
        isPlayer: this.cfg.playerRole === "survivor" && i === 0,
        objectivesCollected: 0,
        exited: false,
      });
    }

    // Spawn the exit zone in the south-east corner of the arena.
    // Survivors who have collected `objectivesRequired` nuggets can
    // step on it to escape.
    world.spawn<import("../core/entity").ExitEntity>({
      kind: "exit",
      pos: { x: b.maxX - 110, y: b.maxY - 110 },
      radius: 36,
      dead: false,
    });

    // One objective at a time — spawn the first.
    this.spawnObjective(world);
  }

  // Called by the engine whenever an objective is picked up. We just
  // spawn the next so the field never has zero (until the round ends).
  onObjectiveCollected(world: World, _collectorId: number): void {
    this.spawnObjective(world);
  }

  // A survivor may escape via the exit once they've collected the
  // required number of nuggets.
  canSurvivorExit(s: CharacterEntity): boolean {
    return s.objectivesCollected >= this.cfg.objectivesRequired;
  }

  private spawnObjective(world: World): void {
    const b = world.arena.bounds;
    // Try several random placements; keep the first one that doesn't
    // overlap a blocking prop or sit on top of a character / plate. If
    // we can't find a spot in a reasonable number of tries, fall back to
    // whatever the last candidate was — better to have an objective than
    // skip the spawn.
    let chosen: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = b.minX + SPAWN_MARGIN + Math.random() * (b.maxX - b.minX - 2 * SPAWN_MARGIN);
      const y = b.minY + SPAWN_MARGIN + Math.random() * (b.maxY - b.minY - 2 * SPAWN_MARGIN);
      let ok = true;
      for (const e of world.entities) {
        if (isProp(e) && e.blocking) {
          if (dist({ x, y }, e.pos) < e.radius + MIN_OBJECTIVE_CLEARANCE) {
            ok = false;
            break;
          }
        } else if (e.kind === "character") {
          if (dist({ x, y }, e.pos) < e.radius + MIN_OBJECTIVE_CLEARANCE) {
            ok = false;
            break;
          }
        } else if (e.kind === "plate") {
          if (dist({ x, y }, e.pos) < e.radius + 30) {
            ok = false;
            break;
          }
        } else if (e.kind === "objective" && !e.collected) {
          // Don't spawn a second live objective on top of an existing one
          // (defensive — initialize shouldn't produce this case).
          if (dist({ x, y }, e.pos) < e.radius + 60) {
            ok = false;
            break;
          }
        }
      }
      if (ok) { chosen = { x, y }; break; }
      if (attempt === 39) chosen = { x, y }; // give up; use last candidate
    }
    if (!chosen) return;
    world.spawn<ObjectiveEntity>({
      kind: "objective",
      pos: chosen,
      radius: OBJECTIVE_RADIUS,
      collected: false,
      dead: false,
    });
  }

  checkOutcome(world: World): RoundOutcome {
    // The set of "all survivors" includes both those still alive on
    // the field and any who have escaped via the exit (exited=true).
    // charactersOnTeam returns living characters only — exited
    // survivors are still alive, just no longer interactive.
    const survivors = world.charactersOnTeam("survivor");
    const hunters = world.charactersOnTeam("hunter");
    const exited = survivors.filter((s) => s.exited);
    const stillFighting = survivors.filter((s) => !s.exited);

    if (hunters.length === 0) return "survivor_win";

    // Everyone's done — either escaped or died. If anyone escaped,
    // the survivor team wins; otherwise the hunter wins clean.
    if (stillFighting.length === 0) {
      return exited.length > 0 ? "survivor_win" : "hunter_win";
    }
    // Timeout: hunter wins. Win condition is to complete the
    // objective (collect + exit), not just to survive the clock.
    if (world.elapsed >= world.timeLimit) return "hunter_win";
    return "ongoing";
  }
}
