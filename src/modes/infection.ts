// Infection mode. Six characters spawn together; one is randomly
// designated Patient Zero at round start and morphs into the Zombie
// character (poison_slam + lunge). The other five start as their
// chosen characters but with a HARD-CAPPED survivor HP — 10 — so a
// clean zombie hit means death and infection.
//
// Death flow: every tick checkOutcome() scans for newly-dead non-
// zombies and converts them in place — they respawn at full Zombie
// stats at a remote spawn slot, joining the infection. The match is
// over when either:
//   - all characters are zombies      → "hunter_win" (infected won)
//   - the 2-minute timer expires with
//     at least one non-zombie alive   → "survivor_win"
//
// All participants share team = "survivor" internally (matches FFA's
// approach so the engine doesn't grow a new Team value). Zombie
// abilities filter targets by `characterId !== "zombie"` so friendly
// fire between survivors stays off and zombies can't damage each
// other.
//
// The mode emits a `newlyInfectedIds` list each tick so main.ts can
// swap AI controllers (survivor AI → ZombieAI) and the renderer can
// paint a flash on freshly-converted characters.

import type { World } from "../core/world";
import type {
  GameMode,
  RoundOutcome,
} from "./mode";
import type {
  CharacterEntity,
} from "../core/entity";
import { CHARACTERS } from "../characters/characters";
import {
  speedMultForLevel,
  damageMultForLevel,
} from "../core/leveling";

// Survivor HP cap for the whole round — the design brief sets it
// at 10 so a slam (5) + bite-range lunge (10) feels appropriately
// lethal. Applied to every non-zombie character at initialize() and
// to converts at respawn.
export const INFECTION_SURVIVOR_HP = 10;

// Round length. Survivors win if any non-zombie is still alive at
// the buzzer.
export const INFECTION_TIME_LIMIT = 120; // 2 minutes

// Six spawn slots around the arena perimeter. Patient Zero takes
// slot 0 conceptually, but the design is symmetric — the random
// initial-infected pick is independent of position.
const SPAWN_SLOTS = [
  { fx: 0.18, fy: 0.18 }, // NW corner — local human
  { fx: 0.82, fy: 0.18 }, // NE corner
  { fx: 0.82, fy: 0.82 }, // SE corner
  { fx: 0.18, fy: 0.82 }, // SW corner
  { fx: 0.50, fy: 0.12 }, // N edge
  { fx: 0.50, fy: 0.88 }, // S edge
];

export const INFECTION_MAX_PLAYERS = SPAWN_SLOTS.length; // 6

export interface InfectionConfig {
  // Character id chosen by the local human (for their initial
  // appearance). If they roll Patient Zero they're immediately
  // converted to Zombie before play starts.
  playerCharacterId: string;
  // Character ids for the rest of the lineup. Length 5 in a full
  // round; shorter rounds (debug / unlocked roster < 6) shrink the
  // lobby. AI-only or mixed human/AI — InfectionMode just sees the
  // character-id list.
  botCharacterIds: string[];
}

export class InfectionMode implements GameMode {
  id = "infection";
  name = "Infection";

  // Set at initialize() — the entity-id of the character that was
  // chosen as Patient Zero. Useful for UI ("Patient Zero: <name>")
  // and analytics; doesn't gate any mode logic.
  patientZeroId: number | null = null;

  // Entity-ids of characters that were converted to zombies on the
  // most recent checkOutcome tick. main.ts reads this each frame to
  // swap their AI controllers and trigger a render flash, then
  // clears the list once consumed.
  newlyInfectedIds: number[] = [];

  // Final outcome — populated when checkOutcome decides the round is
  // over. Used by the HUD to show the right end-of-round text.
  outcome: RoundOutcome = "ongoing";

  constructor(private cfg: InfectionConfig) {}

  initialize(world: World): void {
    // ffaMode opens engine damage paths between same-team chars so
    // a Zombie (also team "survivor" internally) can attack the
    // other survivors. The abilities still filter on characterId so
    // converted zombies don't damage each other.
    world.ffaMode = true;
    world.timeLimit = INFECTION_TIME_LIMIT;
    const b = world.arena.bounds;
    const ids = [this.cfg.playerCharacterId, ...this.cfg.botCharacterIds];
    const spawned: CharacterEntity[] = [];
    for (let i = 0; i < ids.length; i++) {
      const def = CHARACTERS[ids[i]!];
      if (!def) continue;
      const slot = SPAWN_SLOTS[i % SPAWN_SLOTS.length]!;
      const x = b.minX + (b.maxX - b.minX) * slot.fx;
      const y = b.minY + (b.maxY - b.minY) * slot.fy;
      const c: CharacterEntity = {
        kind: "character",
        team: "survivor",
        characterId: def.id,
        pos: { x, y },
        radius: def.radius,
        dead: false,
        hp: INFECTION_SURVIVOR_HP,
        maxHp: INFECTION_SURVIVOR_HP,
        speed: def.speed,
        facing: Math.atan2(0 - y, 0 - x),
        vel: { x: 0, y: 0 },
        cooldowns: {},
        statuses: {},
        isPlayer: i === 0,
        objectivesCollected: 0,
        exited: false,
        stamina: 1,
      } as CharacterEntity;
      world.spawn<CharacterEntity>(c);
      spawned.push(c);
    }

    // Random Patient Zero pick. Any of the spawned characters —
    // including the human — can be infected to start. Conversion
    // re-stats them in place to the Zombie loadout before the
    // first tick runs so play.controllers (built right after
    // initialize) can dispatch ZombieAI immediately.
    if (spawned.length > 0) {
      const pz = spawned[Math.floor(Math.random() * spawned.length)]!;
      this.morphToZombie(pz);
      this.patientZeroId = pz.id;
    }
  }

  checkOutcome(world: World): RoundOutcome {
    if (this.outcome !== "ongoing") return this.outcome;

    // Convert any newly-dead non-zombies in place.
    this.newlyInfectedIds = [];
    for (const c of world.allCharacters()) {
      if (!c.dead) continue;
      if (c.characterId === "zombie") continue;
      this.morphToZombie(c);
      // Respawn at a random spawn slot to give the surviving
      // humans room to react. Picks the slot farthest from any
      // living non-zombie so the convert doesn't immediately
      // re-clobber the same survivor.
      this.respawnRemote(c, world);
      this.newlyInfectedIds.push(c.id);
    }

    // Tally remaining survivors. "Alive non-zombie" = a character
    // still on the survivor side.
    let aliveSurvivors = 0;
    let totalChars = 0;
    for (const c of world.allCharacters()) {
      totalChars++;
      if (c.dead) continue;
      if (c.characterId === "zombie") continue;
      aliveSurvivors++;
    }
    if (totalChars === 0) {
      this.outcome = "draw";
      return this.outcome;
    }

    // All converted → infected win.
    if (aliveSurvivors === 0) {
      this.outcome = "hunter_win";
      return this.outcome;
    }

    // Timer expired with at least one survivor → survivors win.
    if (world.elapsed >= world.timeLimit) {
      this.outcome = "survivor_win";
      return this.outcome;
    }

    return "ongoing";
  }

  // Re-stat a character to Zombie. Preserves entity id, position
  // (caller can move them via respawnRemote), level, and team.
  // Resets HP (to the design-cap of 30), speed (level-scaled),
  // damageMult, abilities, cooldowns, transient state.
  // Idempotent — calling on an already-zombie is a no-op.
  private morphToZombie(c: CharacterEntity): void {
    if (c.characterId === "zombie") return;
    const zDef = CHARACTERS["zombie"]!;
    c.characterId = zDef.id;
    c.radius = zDef.radius;
    // HP stays at the mode's flat 30 cap — never level-scaled, to
    // match the survivor 10 HP cap. Speed + damage DO scale by
    // level so difficulty/leveling still mean something on respawn.
    const lvl = c.level ?? 0;
    c.maxHp = zDef.maxHp;
    c.hp = c.maxHp;
    c.speed = zDef.speed * speedMultForLevel(lvl);
    c.damageMult = damageMultForLevel(lvl);
    c.cooldowns = {};
    c.statuses = {};
    c.charging = undefined;
    c.holdCharging = undefined;
    c.transport = undefined;
    c.dead = false;
    c.lastDamagerId = undefined;
    c.exited = false;
  }

  // Pick a spawn slot maximally far from the nearest living non-
  // zombie so the convert doesn't drop on top of the survivor that
  // just killed them. Falls back to slot 0 if no survivors are
  // alive (the round is about to end anyway).
  private respawnRemote(c: CharacterEntity, world: World): void {
    const b = world.arena.bounds;
    const survivors = world.allCharacters().filter(
      (e) => !e.dead && e.characterId !== "zombie",
    );
    if (survivors.length === 0) {
      const slot = SPAWN_SLOTS[0]!;
      c.pos = {
        x: b.minX + (b.maxX - b.minX) * slot.fx,
        y: b.minY + (b.maxY - b.minY) * slot.fy,
      };
      return;
    }
    let bestSlot = SPAWN_SLOTS[0]!;
    let bestMinDist = -1;
    for (const slot of SPAWN_SLOTS) {
      const sx = b.minX + (b.maxX - b.minX) * slot.fx;
      const sy = b.minY + (b.maxY - b.minY) * slot.fy;
      // For each candidate slot, the distance to the NEAREST
      // survivor — we want to maximize that.
      let minDist = Infinity;
      for (const s of survivors) {
        const dx = sx - s.pos.x;
        const dy = sy - s.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDist) minDist = d2;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestSlot = slot;
      }
    }
    c.pos = {
      x: b.minX + (b.maxX - b.minX) * bestSlot.fx,
      y: b.minY + (b.maxY - b.minY) * bestSlot.fy,
    };
    c.vel = { x: 0, y: 0 };
  }
}
