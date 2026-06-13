// One authoritative 1vN match. Wraps the headless sim (World + Engine +
// Mode + per-player controllers) and exposes what the server needs: feed
// each player's input, advance a tick, produce a snapshot, swap a dropped
// player's controller to AI, and restore them on rejoin.

import { World } from "../src/core/world";
import { Engine } from "../src/core/engine";
import { HuntMode } from "../src/modes/hunt";
import { getMap, defaultMapId } from "../src/maps/registry";
import { createInput } from "../src/core/input";
import type { InputState } from "../src/core/input";
import { HumanController } from "../src/core/humanController";
import { createAIController } from "../src/ai/ai";
import type { Controller } from "../src/ai/ai";
import { CHARACTERS } from "../src/characters/characters";
import type { PlayerSlot, InputMessage, SnapshotMessage } from "../src/net/protocol";

const TIME_LIMIT_SECONDS = 3 * 60 + 30;
const OBJECTIVES_REQUIRED = 5; // per-survivor target — first to this wins

export interface SessionPick {
  slot: PlayerSlot;
  characterId: string;
  // Set when the picking client owns Sprint Boots (mirrored from
  // their inventory at character-select time). Stamped onto the
  // spawned character so every other client renders the boot
  // overlay on this player.
  hasSprintBoots?: boolean;
}

interface SessionPlayer {
  slot: PlayerSlot;
  characterId: string;
  input: InputState;
  entityId: number;
}

// Valid for a 1vN round: exactly one hunter, one or more survivors, and
// every pick resolves to a known character. The lobby should prevent
// invalid combos; this is the backstop.
export function picksAreValid(picks: SessionPick[]): boolean {
  if (picks.length < 2) return false;
  let hunters = 0;
  let survivors = 0;
  for (const p of picks) {
    const def = CHARACTERS[p.characterId];
    if (!def) return false;
    if (def.role === "hunter") hunters++;
    else if (def.role === "survivor") survivors++;
    else return false;
  }
  return hunters === 1 && survivors >= 1;
}

export class GameSession {
  readonly world: World;
  readonly engine: Engine;
  readonly mode: HuntMode;
  private players: SessionPlayer[] = [];
  tickCount = 0;

  readonly mapId: string;

  constructor(picks: SessionPick[], mapId?: string) {
    if (!picksAreValid(picks)) {
      throw new Error("GameSession requires one hunter and at least one survivor pick");
    }
    const hunterPick = picks.find(
      (p) => CHARACTERS[p.characterId].role === "hunter",
    )!;
    // Preserve picks order among survivors so we can map each pick to its
    // spawned entity by index after mode.initialize.
    const survivorPicks = picks.filter(
      (p) => CHARACTERS[p.characterId].role === "survivor",
    );

    // Resolve the chosen map (falls back to the default first map if
    // the caller passed an unknown id — defensive).
    const mapDef = getMap(mapId ?? defaultMapId()) ?? getMap(defaultMapId())!;
    this.mapId = mapDef.id;
    this.world = new World(mapDef.arenaConfig, TIME_LIMIT_SECONDS);
    // HuntMode owns objective spawning (one-at-a-time, respawn on collect).
    mapDef.buildArena(this.world, Math.floor(Math.random() * 1e9), 0);

    this.mode = new HuntMode({
      hunterCharacterId: hunterPick.characterId,
      survivorCharacterIds: survivorPicks.map((p) => p.characterId),
      // isPlayer is irrelevant server-side — each client flags its own
      // character from yourEntityId. Any value here is fine.
      playerRole: "hunter",
      objectivesRequired: OBJECTIVES_REQUIRED,
    });
    this.mode.initialize(this.world);

    const hunterEntity = this.world.charactersOnTeam("hunter")[0];
    // Spawned in survivorCharacterIds order — same order as survivorPicks.
    const survivorEntities = this.world.charactersOnTeam("survivor");

    const controllers = new Map<number, Controller>();
    // Hunter slot -> hunter entity.
    {
      const input = createInput();
      controllers.set(hunterEntity.id, new HumanController(input));
      if (hunterPick.hasSprintBoots) hunterEntity.hasSprintBoots = true;
      this.players.push({
        slot: hunterPick.slot,
        characterId: hunterPick.characterId,
        input,
        entityId: hunterEntity.id,
      });
    }
    // Survivor slots -> survivor entities by spawn order.
    for (let i = 0; i < survivorPicks.length; i++) {
      const pick = survivorPicks[i];
      const entity = survivorEntities[i];
      const input = createInput();
      controllers.set(entity.id, new HumanController(input));
      if (pick.hasSprintBoots) entity.hasSprintBoots = true;
      this.players.push({
        slot: pick.slot,
        characterId: pick.characterId,
        input,
        entityId: entity.id,
      });
    }

    this.engine = new Engine({ world: this.world, mode: this.mode, controllers });
  }

  // The character entity a given player's camera should follow / control.
  entityIdForSlot(slot: PlayerSlot): number | null {
    return this.players.find((p) => p.slot === slot)?.entityId ?? null;
  }

  characterIdForSlot(slot: PlayerSlot): string | null {
    return this.players.find((p) => p.slot === slot)?.characterId ?? null;
  }

  // A player dropped mid-round — hand their character to an AI controller
  // so the round continues for whoever's left. Returns false if that
  // character has no AI (caller should end the round instead).
  aiTakeover(slot: PlayerSlot): boolean {
    const p = this.players.find((x) => x.slot === slot);
    if (!p) return false;
    const ai = createAIController(p.characterId);
    if (!ai) return false;
    this.engine.cfg.controllers.set(p.entityId, ai);
    return true;
  }

  // A previously-dropped player reconnected and matched their identity
  // token. Swap the AI back out for a fresh HumanController bound to a new
  // server-side input state. Returns the entityId the rejoined client now
  // drives (so the server can send them a fresh `start`).
  humanReturn(slot: PlayerSlot): number | null {
    const p = this.players.find((x) => x.slot === slot);
    if (!p) return null;
    // Replace input + controller so any stale held-keys can't leak through.
    p.input = createInput();
    this.engine.cfg.controllers.set(p.entityId, new HumanController(p.input));
    return p.entityId;
  }

  // Update a player's server-side input from a network message. keys are a
  // fresh held-set each frame; pressedAbilities accumulate (edge events)
  // until a sim tick's HumanController consumes and clears them.
  applyInput(slot: PlayerSlot, msg: InputMessage): void {
    const p = this.players.find((x) => x.slot === slot);
    if (!p) return;
    const inp = p.input;
    inp.keys = new Set(msg.keys);
    for (const k of msg.pressedAbilities) inp.pressedAbilities.add(k);
    inp.mouseWorld = { x: msg.mouseWorld.x, y: msg.mouseWorld.y };
    inp.mouseDown = msg.mouseDown;
    inp.isTouchMode = msg.isTouchMode;
    inp.moveVector = { x: msg.moveVector.x, y: msg.moveVector.y };
  }

  tick(dt: number): void {
    this.engine.tick(dt);
    this.tickCount++;
  }

  get outcome() {
    return this.engine.outcome;
  }

  snapshot(): SnapshotMessage {
    return {
      type: "snapshot",
      tick: this.tickCount,
      elapsed: this.world.elapsed,
      timeLimit: this.world.timeLimit,
      outcome: this.engine.outcome,
      entities: this.world.entities,
      // Pause is a server-level concept; caller (index.ts) stamps it in.
      paused: false,
    };
  }
}
