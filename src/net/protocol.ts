// Wire protocol shared between the browser client and the authoritative
// Node server. Type-only imports from the sim keep this file runtime-free
// except for the constants, so the client bundle pays nothing to share it
// and the server has a single source of truth for message shapes.

import type { Entity } from "../core/entity";
import type { RoundOutcome } from "../modes/mode";

export const PROTOCOL_VERSION = 3;
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
  // Optional flag — set when the client owns the Sprint Boots
  // shop item. Server stores it on the slot and stamps it onto
  // the spawned character so OTHER clients (who don't know this
  // player's inventory) can render the boots overlay in
  // snapshots. Absent / false → no boots.
  hasSprintBoots?: boolean;
  // Local player's level for the chosen character (derived from
  // their per-character XP via leveling.ts). Server stamps this
  // onto the spawned entity in GameSession so HP / speed / damage
  // are scaled at round start. Defaults to 0 if absent (legacy
  // clients without the leveling system get baseline stats).
  level?: number;
}

export interface ReadyMessage {
  type: "ready";
  ready: boolean;
}

export interface RestartMessage {
  type: "restart";
}

// Toggle the server-side pause (multiplayer). Any player can pause OR
// resume — same button for everyone. While paused the server's engine
// doesn't tick; snapshots keep flowing with paused=true.
export interface PauseMessage {
  type: "pause";
  paused: boolean;
}

// Map vote — client casts (or changes) its vote during the map-vote
// phase. The server tallies on its tick and broadcasts MapVoteState
// each second; the client UI re-paints from those snapshots.
export interface MapVoteMessage {
  type: "mapVote";
  mapId: string;
}

// Client tells server which maps it has completed (in campaign mode)
// so the server can compute the multiplayer intersection. Sent on
// join (and again if completedMaps changes mid-lobby).
export interface CompletedMapsMessage {
  type: "completedMaps";
  ids: string[];
}

export type ClientMessage =
  | JoinMessage
  | SelectMessage
  | ReadyMessage
  | InputMessage
  | RestartMessage
  | PauseMessage
  | AchievementMessage
  | MapVoteMessage
  | CompletedMapsMessage;

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
  // Server is paused when true — the engine isn't ticking. Clients render
  // the same pause overlay; any player can resume.
  paused: boolean;
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
  kind: "drop" | "rejoin" | "info" | "achievement";
  text: string;
  slot?: PlayerSlot;
}

// Client tells the server it earned an achievement; server fans it out to
// everyone as a Notice (kind="achievement") so the table all flashes the
// same banner. Server doesn't validate — kids' game on a private network.
export interface AchievementMessage {
  type: "achievement";
  // Display text the server echoes back via the notice (e.g. "Bob earned
  // First Blood!"). Pre-formatted on the client so the server stays dumb.
  text: string;
}

// Map-vote phase broadcast. Server sends this every tick during the
// vote window so the client UI can show live tallies. `remaining` is
// seconds left in the vote window; when it hits 0 the server picks a
// winner and starts the countdown / round.
export interface MapVoteStateMessage {
  type: "mapVoteState";
  remaining: number;       // seconds left in the 5s vote window
  candidates: string[];    // map ids the lobby is voting on (intersection)
  // Per-slot vote: slot index → mapId (or null if not voted yet). Length
  // matches the lobby player count.
  votes: (string | null)[];
}

// Sent when the vote ends: server announces the chosen map id and
// transitions to the standard countdown phase. Client can render a
// brief "winner" frame before the countdown overlay takes over.
export interface MapChosenMessage {
  type: "mapChosen";
  mapId: string;
}

export type ServerMessage =
  | WelcomeMessage
  | LobbyMessage
  | StartMessage
  | SnapshotMessage
  | OutcomeMessage
  | ToLobbyMessage
  | CountdownMessage
  | NoticeMessage
  | MapVoteStateMessage
  | MapChosenMessage;
