// Authoritative Brambletooth game server.
//
// Hosts a single 1v1 match. Two players connect over WebSocket (typically
// over Tailscale), pick characters in a lobby, ready up, and the server runs
// the authoritative simulation — broadcasting world snapshots ~30x/sec while
// each client streams its input up. Clients are thin: render snapshots, send
// input. No client-side prediction (LAN latency is negligible).
//
// Run with:  npm run server
// Clients dial:  ws://<host-tailnet-ip>:8787

import { WebSocketServer, WebSocket } from "ws";
import { GameSession, picksAreValid } from "./gameSession";
import type { SessionPick } from "./gameSession";
import {
  PROTOCOL_VERSION,
  DEFAULT_PORT,
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
  name: string;
  characterId: string | null;
  ready: boolean;
}

// Two fixed slots. A third connection is rejected as "full".
const slots: (ClientConn | null)[] = [null, null];
let session: GameSession | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;
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
// two current picks are ready and form one hunter + one survivor.
function startBlockReason(): string | null {
  const conns = slots.filter((c): c is ClientConn => c !== null);
  if (conns.length < 2) return "Waiting for a second player";
  if (conns.some((c) => !c.characterId)) return "Both players must pick a character";
  if (conns.some((c) => !c.ready)) return "Both players must ready up";
  const picks = conns.map((c) => ({ slot: c.slot, characterId: c.characterId! }));
  if (!picksAreValid(picks)) return "Pick one hunter and one survivor";
  return null;
}

function broadcastLobby(): void {
  broadcast({ type: "lobby", players: lobbyViews(), blockedReason: startBlockReason() });
}

function tryStartRound(): void {
  if (session) return; // already in a round
  if (startBlockReason() !== null) return;
  const conns = slots.filter((c): c is ClientConn => c !== null);
  const picks: SessionPick[] = conns.map((c) => ({
    slot: c.slot,
    characterId: c.characterId!,
  }));
  session = new GameSession(picks);

  // Tell each client which entity it drives.
  for (const c of conns) {
    const eid = session.entityIdForSlot(c.slot);
    if (eid != null) {
      send(c.ws, { type: "start", yourEntityId: eid, yourSlot: c.slot });
    }
  }

  lastTickAt = Date.now();
  tickTimer = setInterval(stepRound, 1000 / TICK_HZ);
  console.log(
    `[round] started: ${picks.map((p) => p.characterId).join(" vs ")}`,
  );
}

function stepRound(): void {
  if (!session) return;
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTickAt) / 1000);
  lastTickAt = now;

  session.tick(dt);
  broadcast(session.snapshot());

  if (session.outcome !== "ongoing") {
    broadcast({ type: "outcome", outcome: session.outcome });
    console.log(`[round] ended: ${session.outcome}`);
    stopRoundLoop(); // sim is idle now; wait for restart
  }
}

function stopRoundLoop(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// End the current round entirely and drop everyone back to the lobby
// (clears ready flags so players re-confirm before the next round).
function endRoundToLobby(): void {
  stopRoundLoop();
  session = null;
  for (const c of slots) if (c) c.ready = false;
  broadcast({ type: "toLobby" });
  broadcastLobby();
}

function handleMessage(conn: ClientConn, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return; // ignore malformed
  }

  switch (msg.type) {
    case "join":
      if (msg.name) conn.name = msg.name.slice(0, 24);
      broadcastLobby();
      break;

    case "select":
      // Only valid in the lobby (not mid-round).
      if (session) break;
      if (CHARACTERS[msg.characterId]) {
        conn.characterId = msg.characterId;
        conn.ready = false; // changing pick un-readies
        broadcastLobby();
      }
      break;

    case "ready":
      if (session) break;
      conn.ready = msg.ready && conn.characterId !== null;
      broadcastLobby();
      tryStartRound();
      break;

    case "input":
      if (session) session.applyInput(conn.slot, msg);
      break;

    case "restart":
      // Either player can request a return to the lobby after a round.
      endRoundToLobby();
      break;
  }
}

function onConnection(ws: WebSocket): void {
  // Reject joins while a round is in progress — joining only happens in the
  // lobby. (A dropped player's slot is taken over by AI for the round.)
  if (session) {
    send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, slot: null, playerId: "" });
    ws.close();
    return;
  }

  const slot: PlayerSlot | null = slots[0] === null ? 0 : slots[1] === null ? 1 : null;

  if (slot === null) {
    send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, slot: null, playerId: "" });
    ws.close();
    return;
  }

  const conn: ClientConn = {
    ws,
    slot,
    playerId: `p${nextPlayerId++}`,
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
  });
  broadcastLobby();

  ws.on("message", (data) => handleMessage(conn, data.toString()));

  ws.on("close", () => {
    slots[slot] = null;
    console.log(`[conn] ${conn.playerId} (slot ${slot}) left`);
    if (session) {
      // Round in progress: hand the dropped player's character to AI and
      // keep going for whoever's left. Only fall back to the lobby if no
      // human remains or that character has no AI controller.
      const took = session.aiTakeover(slot);
      const humansLeft = slots.filter((c) => c !== null).length;
      if (!took || humansLeft === 0) {
        endRoundToLobby();
      } else {
        console.log(`[round] slot ${slot} dropped -> AI took over`);
      }
    } else {
      broadcastLobby();
    }
  });

  ws.on("error", () => {
    /* close handler does the cleanup */
  });
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", onConnection);
wss.on("listening", () => {
  console.log(`Brambletooth server listening on ws://0.0.0.0:${PORT}`);
  console.log(`Clients on your Tailnet connect via the host's Tailscale address.`);
});
