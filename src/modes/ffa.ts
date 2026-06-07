// Free-for-all mode. Every character is a player, every player can
// damage every other (engine + abilities check world.ffaMode to skip
// the team-equality gate), and the win condition is picked at random
// at round start from a small menu:
//
//   last_standing  — first to be the only living character wins.
//                    No time limit (long timer fallback). Pure combat.
//
//   most_kills     — 90 second timer. Each kill increments
//                    world.killCounts[killerId]. Highest count at
//                    timeout wins.
//
//   nugget_hybrid  — collect 5 nuggets AND reach the SE exit zone
//                    to win, while everyone else is free to PvP you
//                    on the way. First to exit wins.
//
// All three end the round with outcome 'survivor_win' because every
// FFA combatant is on team 'survivor' internally — the engine's
// existing outcome enum doesn't need to grow a new value for v1.
// The winner's identity is exposed via FFAMode.lastWinnerId for the
// HUD to read.

import type { World } from "../core/world";
import type {
  GameMode,
  RoundOutcome,
} from "./mode";
import type {
  CharacterEntity,
  ObjectiveEntity,
  ExitEntity,
} from "../core/entity";
import { isProp } from "../core/entity";
import { CHARACTERS } from "../characters/characters";
import { dist } from "../core/math";

export type FFAWinKind = "last_standing" | "most_kills" | "nugget_hybrid";

export interface FFAConfig {
  // Character id chosen by the local human.
  playerCharacterId: string;
  // Character ids for AI bots — one entry per opponent.
  botCharacterIds: string[];
  // For nugget_hybrid: how many objectives one player must collect
  // before they can use the exit. Ignored for the other two modes.
  objectivesRequired: number;
  // Optional fixed win condition for testing; if omitted FFAMode
  // picks one uniformly at random at construction.
  forceWinKind?: FFAWinKind;
}

const OBJECTIVE_RADIUS = 22;
const SPAWN_MARGIN = 100;
const MIN_OBJECTIVE_CLEARANCE = 60;
// Eight spawn slots around the arena perimeter — corners + edge
// midpoints. The human always lands at slot 0 (NW corner) so the
// camera target is predictable; bots fill the remainder in order.
// With more participants than slots we wrap, but FFAMode is capped
// at FFA_MAX_PLAYERS = 8 so wrapping shouldn't happen in practice.
const CORNERS = [
  { fx: 0.18, fy: 0.18 }, // NW corner (human)
  { fx: 0.82, fy: 0.82 }, // SE corner — opposite the human, the natural rival slot
  { fx: 0.82, fy: 0.18 }, // NE corner
  { fx: 0.18, fy: 0.82 }, // SW corner
  { fx: 0.50, fy: 0.12 }, // N edge
  { fx: 0.50, fy: 0.88 }, // S edge
  { fx: 0.12, fy: 0.50 }, // W edge
  { fx: 0.88, fy: 0.50 }, // E edge
];
// Hard cap on FFA participants. The launcher in main.ts further
// clamps this to the number of characters currently available to
// the player (see availableFFACharacters / startFFARound), so
// rosters with fewer than 8 unlocked characters fill all the way
// up — they just stop short of 8.
export const FFA_MAX_PLAYERS = 8;

export class FFAMode implements GameMode {
  id = "ffa";
  name = "Free For All";
  winKind: FFAWinKind;
  lastWinnerId: number | null = null;

  constructor(private cfg: FFAConfig) {
    if (cfg.forceWinKind) {
      this.winKind = cfg.forceWinKind;
    } else {
      // Picked once at construction — same kind for the whole round.
      const opts: FFAWinKind[] = ["last_standing", "most_kills", "nugget_hybrid"];
      this.winKind = opts[Math.floor(Math.random() * opts.length)]!;
    }
  }

  initialize(world: World): void {
    world.ffaMode = true;
    const b = world.arena.bounds;
    const ids = [this.cfg.playerCharacterId, ...this.cfg.botCharacterIds];
    for (let i = 0; i < ids.length; i++) {
      const def = CHARACTERS[ids[i]!];
      const corner = CORNERS[i % CORNERS.length]!;
      const x = b.minX + (b.maxX - b.minX) * corner.fx;
      const y = b.minY + (b.maxY - b.minY) * corner.fy;
      world.spawn<CharacterEntity>({
        kind: "character",
        // Internal team — every FFA combatant is technically the
        // same team; the world.ffaMode flag opens damage paths so
        // they fight anyway. Keeping the type as "survivor" means
        // the existing HUD / heartbeat / exit code reuses without
        // a new team value being added to the protocol.
        team: "survivor",
        characterId: def.id,
        pos: { x, y },
        radius: def.radius,
        dead: false,
        hp: def.maxHp,
        maxHp: def.maxHp,
        speed: def.speed,
        // Face arena center so the first frame's flashlight cone
        // (cave) etc reads sensibly.
        facing: Math.atan2(0 - y, 0 - x),
        vel: { x: 0, y: 0 },
        cooldowns: {},
        statuses: {},
        isPlayer: i === 0,
        objectivesCollected: 0,
        exited: false,
      });
    }

    // nugget_hybrid needs the exit zone + a first objective. The
    // other two modes don't use the exit; we still spawn one
    // objective for visual interest in last_standing / most_kills
    // (collecting it just bumps the count but doesn't win).
    world.spawn<ExitEntity>({
      kind: "exit",
      pos: { x: b.maxX - 110, y: b.maxY - 110 },
      radius: 36,
      dead: false,
    });
    this.spawnObjective(world);
  }

  onObjectiveCollected(world: World, _collectorId: number): void {
    this.spawnObjective(world);
  }

  canSurvivorExit(c: CharacterEntity): boolean {
    if (this.winKind !== "nugget_hybrid") return false;
    return c.objectivesCollected >= this.cfg.objectivesRequired;
  }

  checkOutcome(world: World): RoundOutcome {
    const alive = world.allCharacters().filter((c) => !c.dead && !c.exited);

    if (this.winKind === "nugget_hybrid") {
      // First to exit wins. Engine flips `exited` when a character
      // who can-exit overlaps the exit zone; we just watch for it.
      for (const c of world.allCharacters()) {
        if (c.exited) {
          this.lastWinnerId = c.id;
          return "survivor_win";
        }
      }
      // Everyone dead = draw.
      if (alive.length === 0) return "draw";
      // Long fallback time cap so the round can't deadlock.
      if (world.elapsed >= world.timeLimit) return "draw";
      return "ongoing";
    }

    if (this.winKind === "last_standing") {
      if (alive.length === 1) {
        this.lastWinnerId = alive[0]!.id;
        return "survivor_win";
      }
      if (alive.length === 0) return "draw";
      // Time fallback to avoid eternal stalemates — pick the
      // character with the most kills at timeout.
      if (world.elapsed >= world.timeLimit) {
        this.lastWinnerId = this.pickKillsLeader(world);
        return "survivor_win";
      }
      return "ongoing";
    }

    // most_kills
    if (alive.length <= 1 || world.elapsed >= world.timeLimit) {
      this.lastWinnerId = this.pickKillsLeader(world);
      return "survivor_win";
    }
    return "ongoing";
  }

  // Returns the character id with the most kills, breaking ties by
  // entity id (stable). Returns null if there are no kills at all.
  private pickKillsLeader(world: World): number | null {
    let bestId: number | null = null;
    let bestCount = -1;
    for (const c of world.allCharacters()) {
      const count = world.killCounts.get(c.id) ?? 0;
      if (count > bestCount || (count === bestCount && bestId == null)) {
        bestCount = count;
        bestId = c.id;
      }
    }
    return bestId;
  }

  private spawnObjective(world: World): void {
    const b = world.arena.bounds;
    let chosen: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = b.minX + SPAWN_MARGIN + Math.random() * (b.maxX - b.minX - 2 * SPAWN_MARGIN);
      const y = b.minY + SPAWN_MARGIN + Math.random() * (b.maxY - b.minY - 2 * SPAWN_MARGIN);
      let ok = true;
      for (const e of world.entities) {
        if (isProp(e) && e.blocking) {
          if (dist({ x, y }, e.pos) < e.radius + MIN_OBJECTIVE_CLEARANCE) { ok = false; break; }
        } else if (e.kind === "character") {
          if (dist({ x, y }, e.pos) < e.radius + MIN_OBJECTIVE_CLEARANCE) { ok = false; break; }
        } else if (e.kind === "objective" && !e.collected) {
          if (dist({ x, y }, e.pos) < e.radius + 60) { ok = false; break; }
        }
      }
      if (ok) { chosen = { x, y }; break; }
      if (attempt === 39) chosen = { x, y };
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
}
