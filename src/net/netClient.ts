// Browser-side networking. Wraps a WebSocket to the authoritative server,
// tracks the latest server-pushed state, and exposes typed send helpers.
//
// Resilience layer:
//   - sessionToken persists across page reloads in localStorage. On
//     reconnect we send it as rejoinToken; if the server still has a
//     matching ghost (a player who dropped during an active round) it
//     restores us into the same slot and character.
//   - on ws close (other than a server "full" rejection) we auto-reconnect
//     with exponential backoff. Combined with the token, a brief network
//     blip leaves the round unaffected.

import type { InputState } from "../core/input";
import type {
  ClientMessage,
  ServerMessage,
  SnapshotMessage,
  LobbyPlayerView,
  PlayerSlot,
} from "./protocol";
import { DEFAULT_PORT } from "./protocol";
import type { RoundOutcome } from "../modes/mode";

export type NetPhase =
  | "connecting"
  | "lobby"
  | "countdown" // pre-round timer
  | "playing"
  | "ended"
  | "full"
  | "disconnected";

const TOKEN_KEY = "brambletooth.sessionToken";
const RETRY_DELAYS_MS = [400, 800, 1600, 3200, 6400]; // give up after the last

export interface NoticeEntry {
  id: number;
  kind: "drop" | "rejoin" | "info";
  text: string;
  slot?: PlayerSlot;
  bornAt: number;
}

export function resolveServerUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get("server");
  if (override) {
    if (override.startsWith("ws://") || override.startsWith("wss://")) return override;
    return `ws://${override}`;
  }
  return `ws://${location.hostname}:${DEFAULT_PORT}`;
}

export class NetClient {
  phase: NetPhase = "connecting";
  slot: PlayerSlot | null = null;
  playerId = "";
  lobby: LobbyPlayerView[] = [];
  blockedReason: string | null = null;
  yourEntityId: number | null = null;
  snapshot: SnapshotMessage | null = null;
  outcome: RoundOutcome = "ongoing";
  countdownRemaining = 0;
  notices: NoticeEntry[] = [];

  private url: string;
  private name: string;
  private ws: WebSocket | null = null;
  private sessionToken: string | null = null;
  private retryIndex = 0;
  private noticeSeq = 1;
  // Set by disconnect() — onclose then refuses to schedule a reconnect.
  private intentionalClose = false;

  constructor(url: string, name = "") {
    this.url = url;
    this.name = name;
    try {
      this.sessionToken = localStorage.getItem(TOKEN_KEY);
    } catch {
      this.sessionToken = null;
    }
    this.connect();
  }

  // Caller (the back button) is leaving the multiplayer session. Close the
  // WebSocket cleanly and suppress the auto-reconnect that would normally
  // try to keep us alive across blips. The instance is single-shot — after
  // disconnect(), callers should drop the reference and build a new one.
  disconnect(): void {
    this.intentionalClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
    }
  }

  private connect(): void {
    this.phase = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      // Auto-send join. Include name (so the lobby shows it) and rejoinToken
      // (so the server can restore us into a ghost slot if a round is going).
      const join: ClientMessage = { type: "join" };
      if (this.name) join.name = this.name;
      if (this.sessionToken) join.rejoinToken = this.sessionToken;
      ws.send(JSON.stringify(join));
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (this.intentionalClose) return; // caller closed us; don't retry
      if (this.phase === "full") return; // server rejected; don't retry
      this.phase = "disconnected";
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose handles cleanup */
    };
  }

  private scheduleReconnect(): void {
    if (this.retryIndex >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[this.retryIndex++];
    setTimeout(() => this.connect(), delay);
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "welcome":
        if (m.slot === null) {
          this.phase = "full";
          break;
        }
        this.slot = m.slot;
        this.playerId = m.playerId;
        if (m.sessionToken) {
          this.sessionToken = m.sessionToken;
          try {
            localStorage.setItem(TOKEN_KEY, m.sessionToken);
          } catch {
            /* private mode etc.; in-memory token still works for this tab */
          }
        }
        this.retryIndex = 0; // success — reset backoff
        // rejoined: the server is restoring us mid-round; a `start` and
        // snapshots will follow. Otherwise we're in the lobby.
        this.phase = m.rejoined ? "playing" : "lobby";
        // Clear any stale playing-state from the previous connection.
        if (!m.rejoined) {
          this.yourEntityId = null;
          this.snapshot = null;
          this.countdownRemaining = 0;
          this.outcome = "ongoing";
        }
        break;

      case "lobby":
        this.lobby = m.players;
        this.blockedReason = m.blockedReason;
        break;

      case "countdown":
        this.countdownRemaining = m.remaining;
        this.phase = m.remaining > 0 ? "countdown" : "playing";
        break;

      case "start":
        this.yourEntityId = m.yourEntityId;
        // Don't override countdown; the engine starts ticking later. For
        // rejoins (no countdown in progress) ensure we're in playing.
        if (this.phase !== "countdown" && this.phase !== "ended") {
          this.phase = "playing";
        }
        break;

      case "snapshot":
        this.snapshot = m;
        this.outcome = m.outcome;
        break;

      case "outcome":
        this.outcome = m.outcome;
        this.phase = "ended";
        break;

      case "toLobby":
        this.phase = "lobby";
        this.snapshot = null;
        this.yourEntityId = null;
        this.outcome = "ongoing";
        this.countdownRemaining = 0;
        break;

      case "notice":
        this.notices.push({
          id: this.noticeSeq++,
          kind: m.kind,
          text: m.text,
          slot: m.slot,
          bornAt: performance.now(),
        });
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ---- Lobby actions ----
  select(characterId: string): void {
    this.send({ type: "select", characterId });
  }
  ready(ready: boolean): void {
    this.send({ type: "ready", ready });
  }
  restart(): void {
    this.send({ type: "restart" });
  }

  // ---- In-round ----
  sendInput(input: InputState): void {
    this.send({
      type: "input",
      keys: [...input.keys],
      pressedAbilities: [...input.pressedAbilities],
      mouseWorld: { x: input.mouseWorld.x, y: input.mouseWorld.y },
      mouseDown: input.mouseDown,
      isTouchMode: input.isTouchMode,
      moveVector: { x: input.moveVector.x, y: input.moveVector.y },
    });
  }

  isMine(entityId: number): boolean {
    return this.yourEntityId === entityId;
  }

  // Drop notices older than maxAgeMs. Called by main each frame so toasts
  // fade out without manual upkeep elsewhere.
  pruneNotices(maxAgeMs = 3500): void {
    const now = performance.now();
    this.notices = this.notices.filter((n) => now - n.bornAt < maxAgeMs);
  }
}
