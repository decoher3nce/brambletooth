// Wire protocol shared between the browser client and the authoritative
// Node server. Type-only imports from the sim keep this file runtime-free
// except for the constants, so the client bundle pays nothing to share it
// and the server has a single source of truth for message shapes.

import type { Entity } from "../core/entity";
import type { RoundOutcome } from "../modes/mode";

export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 8787;
// Hard cap on connected players per session (1 hunter + up to 7 survivors).
export const MAX_PLAYERS = 8;
// Countdown length in seconds, broadcast from the server when the lobby
// transitions to "round starting." The client switches from lobby view to
// the in-game overlay when the count crosses this threshold.
export const COUNTDOWN_SECONDS = 5;
export const COUNTDOWN_INGAME_AT = 3;

export type PlayerSlot = number; // 0..MAX_PLAYERS-1

// ---- Client → Server ----

// Per-frame input. Mirrors the fields HumanController reads off InputState.
// keys/pressedAbilities travel as arrays (Sets aren't JSON-serializable);
// the server rehydrates them.
export interface InputMessage {
  type: "input";
  keys: string[];
  pressedAbilities: string[];
  mouseWorld: { x: number; y: number };
  mouseDown: boolean;
  isTouchMode: boolean;
  moveVector: { x: number; y: number };
}

// Initial connection handshake. rejoinToken (when present) asks the server
// to restore this client to the slot it previously held — if the round is
// still in progress and the token matches a ghost.
export interface JoinMessage {
  type: "join";
  name?: string;
  rejoinToken?: string;
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

// Sent once on connect. slot=null means the server rejected us (round in
// progress and no matching rejoin token, or the player cap is reached).
// sessionToken is a stable identifier the client stores in localStorage and
// sends back as rejoinToken on the next connection attempt.
export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
  slot: PlayerSlot | null;
  playerId: string;
  sessionToken: string;
  rejoined: boolean; // true if this was a successful rejoin into a round
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
  blockedReason: string | null;
}

// Sent individually to each client when a round begins, AND when a
// rejoined client returns mid-round. yourEntityId is the character entity
// this client drives and its camera follows.
export interface StartMessage {
  type: "start";
  yourEntityId: number;
  yourSlot: PlayerSlot;
}

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

// Server dropped to lobby (round ended + restart, or no humans left mid-
// round). Tells clients to leave the playing scene.
export interface ToLobbyMessage {
  type: "toLobby";
}

// Pre-round countdown, broadcast every server tick while running. remaining
// is in seconds (fractional). When it crosses the COUNTDOWN_INGAME_AT
// threshold, the client switches from the lobby panel to the in-game
// world view (still frozen) with the countdown number overlayed; at 0 the
// engine starts ticking and snapshots flow.
export interface CountdownMessage {
  type: "countdown";
  remaining: number;
}

// Transient on-screen notice (drop / rejoin / future system messages). The
// client renders a toast that fades after a few seconds. kind lets the
// client style by event type.
export interface NoticeMessage {
  type: "notice";
  kind: "drop" | "rejoin" | "info";
  text: string;
  slot?: PlayerSlot;
}

export type ServerMessage =
  | WelcomeMessage
  | LobbyMessage
  | StartMessage
  | SnapshotMessage
  | OutcomeMessage
  | ToLobbyMessage
  | CountdownMessage
  | NoticeMessage;
