// Authoritative Brambletooth game server.
//
// Hosts a single 1vN match (1 hunter + up to 7 survivors). Players connect
// over WebSocket (typically over Tailscale), pick characters in the lobby,
// ready up, watch the 5-second countdown, then play. Each client streams
// its input up; the server runs the authoritative sim and broadcasts
// snapshots ~30 Hz. AI takes over for players who drop mid-round, and
// reconnects with a matching session token are restored to their slot.
//
// Run with:  npm run server
// Clients dial:  ws://<host-tailnet-ip>:8787

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { GameSession, picksAreValid } from "./gameSession";
import type { SessionPick } from "./gameSession";
import {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  MAX_PLAYERS,
  COUNTDOWN_SECONDS,
  type PlayerSlot,
  type ClientMessage,
  type ServerMessage,
  type LobbyPlayerView,
} from "../src/net/protocol";
import { CHARACTERS } from "../src/characters/characters";

const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const TICK_HZ = 30;

interface ClientConn {
  ws: WebSocket;
  slot: PlayerSlot;
  playerId: string;
  sessionToken: string;
  name: string;
  characterId: string | null;
  ready: boolean;
}

// A player who dropped mid-round. Their slot stays reserved (slots[slot] is
// null = freeable for fresh joins, but the ghost lets us recognize a
// returning client by token and restore them to the same slot/character).
interface Ghost {
  slot: PlayerSlot;
  characterId: string;
  name: string;
}

const slots: (ClientConn | null)[] = Array(MAX_PLAYERS).fill(null);
const ghosts: Map<string, Ghost> = new Map(); // sessionToken -> ghost
let session: GameSession | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
let countdownRemaining = 0; // seconds; >0 means a round is starting
let serverPaused = false;
let nextPlayerId = 1;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  for (const c of slots) if (c) send(c.ws, msg);
}

function lobbyViews(): LobbyPlayerView[] {
  const out: LobbyPlayerView[] = [];
  for (const c of slots) {
    if (!c) continue;
    out.push({
      slot: c.slot,
      name: c.name,
      characterId: c.characterId,
      ready: c.ready,
      connected: true,
    });
  }
  return out;
}

// Why a round can't start yet — also the start gate. Returns null when the
// current picks form one hunter + ≥1 survivor and everyone is ready.
function startBlockReason(): string | null {
  const conns = slots.filter((c): c is ClientConn => c !== null);
  if (conns.length < 2) return "Waiting for at least 2 players";
  if (conns.some((c) => !c.characterId)) return "Everyone must pick a character";
  if (conns.some((c) => !c.ready)) return "Everyone must ready up";
  const picks = conns.map((c) => ({ slot: c.slot, characterId: c.characterId! }));
  if (!picksAreValid(picks)) return "Need exactly one hunter and at least one survivor";
  return null;
}

function broadcastLobby(): void {
  if (session || countdownRemaining > 0) return; // not in lobby
  broadcast({ type: "lobby", players: lobbyViews(), blockedReason: startBlockReason() });
}

// ---- Round lifecycle ----

function tryStartCountdown(): void {
  if (session || countdownRemaining > 0) return;
  if (startBlockReason() !== null) return;

  // Build the session immediately so the world exists for in-game countdown
  // rendering. The engine ticks only after countdown reaches 0.
  const conns = slots.filter((c): c is ClientConn => c !== null);
  const picks: SessionPick[] = conns.map((c) => ({
    slot: c.slot,
    characterId: c.characterId!,
  }));
  session = new GameSession(picks);
  countdownRemaining = COUNTDOWN_SECONDS;

  // Tell each client which entity it drives — they need this before
  // snapshots flow so the camera + HUD bind to the right character.
  for (const c of conns) {
    const eid = session.entityIdForSlot(c.slot);
    if (eid != null) {
      send(c.ws, { type: "start", yourEntityId: eid, yourSlot: c.slot });
    }
  }
  console.log(
    `[round] countdown started: ${picks.length} players (${picks.map((p) => p.characterId).join(", ")})`,
  );

  lastTickAt = Date.now();
  tickTimer = setInterval(stepRound, 1000 / TICK_HZ);
}

function stepRound(): void {
  if (!session) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTickAt) / 1000);
  lastTickAt = now;

  if (countdownRemaining > 0) {
    countdownRemaining = Math.max(0, countdownRemaining - dt);
    broadcast({ type: "countdown", remaining: countdownRemaining });
    broadcast(stampedSnapshot());
    return;
  }

  // Paused: keep broadcasting snapshots (so latecomer rendering stays in
  // sync) but don't advance the sim. Clients show the pause overlay.
  if (serverPaused) {
    broadcast(stampedSnapshot());
    return;
  }

  session.tick(dt);
  broadcast(stampedSnapshot());

  if (session.outcome !== "ongoing") {
    broadcast({ type: "outcome", outcome: session.outcome });
    console.log(`[round] ended: ${session.outcome}`);
    stopRoundLoop();
  }
}

// Wrap session.snapshot() to attach the current paused flag without
// having GameSession know about server-level state.
function stampedSnapshot() {
  const s = session!.snapshot();
  s.paused = serverPaused;
  return s;
}

function stopRoundLoop(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// End the current round entirely and drop everyone back to the lobby.
function endRoundToLobby(): void {
  stopRoundLoop();
  session = null;
  countdownRemaining = 0;
  serverPaused = false;
  ghosts.clear(); // ghosts only matter mid-round
  for (const c of slots) if (c) c.ready = false;
  broadcast({ type: "toLobby" });
  broadcastLobby();
}

// ---- Connection / message handling ----

function firstFreeSlot(): PlayerSlot | null {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === null) return i;
  }
  return null;
}

function humansConnected(): number {
  return slots.reduce((n, c) => n + (c ? 1 : 0), 0);
}

function noticeText(kind: "drop" | "rejoin", slot: PlayerSlot, name: string): string {
  if (kind === "drop") return `${name} dropped — computer took control`;
  return `${name} rejoined`;
}

function handleMessage(conn: ClientConn, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.type) {
    case "join":
      if (msg.name) conn.name = msg.name.slice(0, 24);
      broadcastLobby();
      break;

    case "select":
      // Only in lobby (not during countdown / round).
      if (session || countdownRemaining > 0) break;
      if (CHARACTERS[msg.characterId]) {
        conn.characterId = msg.characterId;
        conn.ready = false; // changing pick un-readies
        broadcastLobby();
      }
      break;

    case "ready":
      if (session || countdownRemaining > 0) break;
      conn.ready = msg.ready && conn.characterId !== null;
      broadcastLobby();
      tryStartCountdown();
      break;

    case "input":
      if (session) session.applyInput(conn.slot, msg);
      break;

    case "restart":
      endRoundToLobby();
      break;

    case "pause":
      // Only meaningful during an active round (after countdown).
      if (!session || countdownRemaining > 0) break;
      if (serverPaused !== msg.paused) {
        serverPaused = msg.paused;
        console.log(`[round] ${serverPaused ? "paused" : "resumed"} by slot ${conn.slot}`);
      }
      break;
  }
}

function tryRejoin(ws: WebSocket, token: string): ClientConn | null {
  const ghost = ghosts.get(token);
  if (!ghost || !session) return null;
  if (slots[ghost.slot] !== null) return null; // their slot was re-taken
  // Restore controller to a fresh HumanController on the engine side.
  const entityId = session.humanReturn(ghost.slot);
  if (entityId == null) return null;

  const conn: ClientConn = {
    ws,
    slot: ghost.slot,
    playerId: `p${nextPlayerId++}`,
    sessionToken: token, // keep the same token so subsequent reconnects work
    name: ghost.name,
    characterId: ghost.characterId,
    ready: true,
  };
  slots[ghost.slot] = conn;
  ghosts.delete(token);

  send(ws, {
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    slot: ghost.slot,
    playerId: conn.playerId,
    sessionToken: token,
    rejoined: true,
  });
  send(ws, { type: "start", yourEntityId: entityId, yourSlot: ghost.slot });
  broadcast({
    type: "notice",
    kind: "rejoin",
    text: noticeText("rejoin", ghost.slot, ghost.name),
    slot: ghost.slot,
  });
  console.log(`[conn] ${conn.playerId} rejoined as slot ${ghost.slot} (${ghost.name})`);
  return conn;
}

function onConnection(ws: WebSocket): void {
  // We can't read the rejoin token until the client's first message — but
  // welcome must be sent first to negotiate state. Pattern: hold the
  // connection in a pending state, wait briefly for `join` with token, then
  // try to rejoin; if no token or no match, fall through to fresh join.
  let resolved = false;
  const settleAsFresh = () => {
    if (resolved) return;
    resolved = true;
    // Mid-round, no rejoin token / no match -> reject.
    if (session || countdownRemaining > 0) {
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        slot: null,
        playerId: "",
        sessionToken: "",
        rejoined: false,
      });
      ws.close();
      return;
    }
    const slot = firstFreeSlot();
    if (slot === null) {
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        slot: null,
        playerId: "",
        sessionToken: "",
        rejoined: false,
      });
      ws.close();
      return;
    }
    const sessionToken = randomUUID();
    const conn: ClientConn = {
      ws,
      slot,
      playerId: `p${nextPlayerId++}`,
      sessionToken,
      name: `Player ${slot + 1}`,
      characterId: null,
      ready: false,
    };
    slots[slot] = conn;
    console.log(`[conn] ${conn.playerId} joined as slot ${slot}`);
    send(ws, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      slot,
      playerId: conn.playerId,
      sessionToken,
      rejoined: false,
    });
    wireConn(conn);
    broadcastLobby();
  };

  // Brief window to receive `join` with a rejoin token before we settle.
  // If the client doesn't send anything in 250 ms we treat it as a fresh
  // join (no token = no rejoin intent).
  const settleTimer = setTimeout(settleAsFresh, 250);
  ws.once("message", (data) => {
    if (resolved) return;
    clearTimeout(settleTimer);

    let parsed: ClientMessage | null = null;
    try {
      parsed = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      /* malformed; treat as no message */
    }

    // Try a rejoin first if the client provided a token.
    if (parsed?.type === "join" && parsed.rejoinToken) {
      const conn = tryRejoin(ws, parsed.rejoinToken);
      if (conn) {
        resolved = true;
        if (parsed.name) conn.name = parsed.name.slice(0, 24);
        wireConn(conn);
        return;
      }
      // Token didn't match — fall through to a fresh join.
    }

    settleAsFresh();
    // Replay the first message through the regular handler so any name /
    // select / ready intent it carried still applies.
    if (parsed) {
      const c = slots.find((c) => c?.ws === ws);
      if (c) handleMessage(c, data.toString());
    }
  });
}

function wireConn(conn: ClientConn): void {
  conn.ws.on("message", (data) => {
    // Skip the first message — onConnection's once-handler already ran it
    // (or routed it). Subsequent messages flow through handleMessage.
    handleMessage(conn, data.toString());
  });

  conn.ws.on("close", () => {
    const wasInSlot = slots[conn.slot] === conn;
    if (wasInSlot) slots[conn.slot] = null;
    console.log(`[conn] ${conn.playerId} (slot ${conn.slot}) left`);
    if (session) {
      // AI takes over the dropped character; round continues. Ghost record
      // lets them rejoin via token while the round is still active.
      const took = session.aiTakeover(conn.slot);
      ghosts.set(conn.sessionToken, {
        slot: conn.slot,
        characterId: conn.characterId ?? "",
        name: conn.name,
      });
      const humansLeft = humansConnected();
      if (!took || humansLeft === 0) {
        endRoundToLobby();
      } else {
        broadcast({
          type: "notice",
          kind: "drop",
          text: noticeText("drop", conn.slot, conn.name),
          slot: conn.slot,
        });
        console.log(`[round] slot ${conn.slot} dropped -> AI took over`);
      }
    } else {
      broadcastLobby();
    }
  });

  conn.ws.on("error", () => {
    /* close handler does the cleanup */
  });
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", onConnection);
wss.on("listening", () => {
  console.log(`Brambletooth server listening on ws://0.0.0.0:${PORT}`);
  console.log(`Clients on your Tailnet connect via the host's Tailscale address.`);
});
