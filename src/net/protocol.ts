// Wire protocol shared between the browser client and the authoritative
// Node server. Type-only imports from the sim keep this file runtime-free
// except for the two constants, so the client bundle pays nothing to share
// it and the server has a single source of truth for message shapes.

import type { Entity } from "../core/entity";
import type { RoundOutcome } from "../modes/mode";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 8787;

export type PlayerSlot = 0 | 1;

// ---- Client → Server ----

// Per-frame input. Mirrors the fields HumanController reads off InputState.
// keys/pressedAbilities travel as arrays (Sets aren't JSON-serializable);
// the server rehydrates them. pressedAbilities are edge events — the server
// accumulates them until a sim tick consumes them.
export interface InputMessage {
  type: "input";
  keys: string[];
  pressedAbilities: string[];
  mouseWorld: { x: number; y: number };
  mouseDown: boolean;
  isTouchMode: boolean;
  moveVector: { x: number; y: number };
}

export interface JoinMessage {
  type: "join";
  name?: string;
}

export interface SelectMessage {
  type: "select";
  characterId: string;
}

export interface ReadyMessage {
  type: "ready";
  ready: boolean;
}

export interface RestartMessage {
  type: "restart";
}

export type ClientMessage =
  | JoinMessage
  | SelectMessage
  | ReadyMessage
  | InputMessage
  | RestartMessage;

// ---- Server → Client ----

// Sent once on connect. If the server is full, `slot` is null and the
// client should show "game full".
export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  slot: PlayerSlot | null;
  playerId: string;
}

export interface LobbyPlayerView {
  slot: PlayerSlot;
  name: string;
  characterId: string | null;
  ready: boolean;
  connected: boolean;
}

export interface LobbyMessage {
  type: "lobby";
  players: LobbyPlayerView[];
  // Why the round can't start yet (null when it can / has). UI hint.
  blockedReason: string | null;
}

// Sent individually to each client when a round begins — yourEntityId is
// the character entity this client drives and its camera follows.
export interface StartMessage {
  type: "start";
  yourEntityId: number;
  yourSlot: PlayerSlot;
}

// Broadcast every server tick. The full entity list is authoritative; the
// client renders it directly. (Static props are resent each tick for now —
// a P5 optimization can split static/dynamic.)
export interface SnapshotMessage {
  type: "snapshot";
  tick: number;
  elapsed: number;
  timeLimit: number;
  outcome: RoundOutcome;
  entities: Entity[];
}

export interface OutcomeMessage {
  type: "outcome";
  outcome: RoundOutcome;
}

// Sent when the server drops back to the lobby (round ended + restart, or a
// player left mid-round). Tells clients to leave the playing scene.
export interface ToLobbyMessage {
  type: "toLobby";
}

export type ServerMessage =
  | WelcomeMessage
  | LobbyMessage
  | StartMessage
  | SnapshotMessage
  | OutcomeMessage
  | ToLobbyMessage;
