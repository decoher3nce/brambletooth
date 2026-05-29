// One authoritative 1v1 match. Wraps the headless sim (World + Engine +
// Mode + per-player controllers) and exposes the three things the server
// needs: feed a player's input, advance a tick, and produce a snapshot.
//
// Both characters are human-driven here (each by a HumanController reading
// a server-side InputState that the network layer updates). The sim code is
// the exact same code the client runs single-player — only the input source
// and the absence of rendering differ.

import { World } from "../src/core/world";
import { Engine } from "../src/core/engine";
import { OneVOneMode } from "../src/modes/oneVOne";
import { FOREST_ARENA_CONFIG, buildForest } from "../src/arenas/forest";
import { createInput } from "../src/core/input";
import type { InputState } from "../src/core/input";
import { HumanController } from "../src/core/humanController";
import { createAIController } from "../src/ai/ai";
import type { Controller } from "../src/ai/ai";
import { CHARACTERS } from "../src/characters/characters";
import type { PlayerSlot, InputMessage, SnapshotMessage } from "../src/net/protocol";

const TIME_LIMIT_SECONDS = 5 * 60;
const OBJECTIVE_COUNT = 5;
const OBJECTIVES_REQUIRED = 5;

export interface SessionPick {
  slot: PlayerSlot;
  characterId: string;
}

interface SessionPlayer {
  slot: PlayerSlot;
  characterId: string;
  input: InputState;
  entityId: number;
}

// True only if the two picks form exactly one hunter and one survivor — the
// server refuses to start an invalid pairing (the lobby should prevent it,
// this is the backstop).
export function picksAreValid(picks: SessionPick[]): boolean {
  if (picks.length !== 2) return false;
  const roles = picks.map((p) => CHARACTERS[p.characterId]?.role);
  return roles.includes("hunter") && roles.includes("survivor");
}

export class GameSession {
  readonly world: World;
  readonly engine: Engine;
  readonly mode: OneVOneMode;
  private players: SessionPlayer[] = [];
  tickCount = 0;

  constructor(picks: SessionPick[]) {
    if (!picksAreValid(picks)) {
      throw new Error("GameSession requires one hunter and one survivor pick");
    }
    const hunterPick = picks.find(
      (p) => CHARACTERS[p.characterId].role === "hunter",
    )!;
    const survivorPick = picks.find(
      (p) => CHARACTERS[p.characterId].role === "survivor",
    )!;

    this.world = new World(FOREST_ARENA_CONFIG, TIME_LIMIT_SECONDS);
    buildForest(this.world, Math.floor(Math.random() * 1e9), OBJECTIVE_COUNT);

    this.mode = new OneVOneMode({
      hunterCharacterId: hunterPick.characterId,
      survivorCharacterId: survivorPick.characterId,
      // isPlayer is irrelevant server-side — we assign controllers
      // explicitly below. Pick a value; the server never reads it.
      playerRole: "survivor",
      objectivesRequired: OBJECTIVES_REQUIRED,
    });
    this.mode.initialize(this.world);

    const hunterEntity = this.world.charactersOnTeam("hunter")[0];
    const survivorEntity = this.world.charactersOnTeam("survivor")[0];

    const controllers = new Map<number, Controller>();
    for (const pick of picks) {
      const isHunter = CHARACTERS[pick.characterId].role === "hunter";
      const entity = isHunter ? hunterEntity : survivorEntity;
      const input = createInput();
      controllers.set(entity.id, new HumanController(input));
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
    };
  }
}
