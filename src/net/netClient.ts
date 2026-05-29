// Browser-side networking. Wraps a WebSocket to the authoritative server,
// tracks the latest server-pushed state (phase, lobby, snapshot, outcome),
// and exposes typed send helpers. The render loop polls this object each
// frame — no event wiring needed in main.ts beyond construction.

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
  | "connecting" // socket opening / pre-welcome
  | "lobby" // connected, picking + readying
  | "playing" // round in progress, snapshots flowing
  | "ended" // round over, awaiting restart
  | "full" // server rejected us (2 players already)
  | "disconnected"; // socket closed/errored

// Resolve the server URL. Defaults to the same host the client was served
// from, on the game-server port — so over Tailscale the client served from
// polymath.tail…:5173 dials ws://polymath.tail…:8787 with zero config.
// Override with ?server=host:port (or a full ws:// URL) for flexibility.
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

  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data as string) as ServerMessage);
      } catch {
        /* ignore malformed */
      }
    };
    this.ws.onclose = () => {
      if (this.phase !== "full") this.phase = "disconnected";
    };
    this.ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "welcome":
        this.playerId = m.playerId;
        if (m.slot === null) {
          this.phase = "full";
        } else {
          this.slot = m.slot;
          this.phase = "lobby";
        }
        break;
      case "lobby":
        this.lobby = m.players;
        this.blockedReason = m.blockedReason;
        break;
      case "start":
        this.yourEntityId = m.yourEntityId;
        this.snapshot = null;
        this.outcome = "ongoing";
        this.phase = "playing";
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
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ---- Lobby actions ----
  join(name?: string): void {
    this.send({ type: "join", name });
  }
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
  // Stream the local input as a reduced InputMessage. Caller clears
  // edge-triggered pressedAbilities after this returns.
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

  // Whom this client controls in the current snapshot.
  isMine(entityId: number): boolean {
    return this.yourEntityId === entityId;
  }
}
