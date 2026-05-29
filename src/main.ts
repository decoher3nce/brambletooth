// Main entry point.
//
// Flow: a title screen offers Single Player (local vs AI) or Two Players
// (networked via the authoritative server). The chosen mode is fixed for
// the session. URL shortcuts skip the title: ?solo -> local, ?net=1 -> net.
//
//   local: select -> playing, local engine.
//   net:   connecting -> lobby -> playing, rendering server snapshots and
//          streaming input. Each device follows its own player.

import "./abilities/abilities"; // ensure abilities are registered
import { World } from "./core/world";
import { createInput, bindInput } from "./core/input";
import { Engine } from "./core/engine";
import { Renderer, createCamera, screenToWorld } from "./render/renderer";
import type { Camera } from "./render/renderer";
import { HuntMode } from "./modes/hunt";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { createAIController } from "./ai/ai";
import { HumanController } from "./core/humanController";
import { drawHUD } from "./ui/hud";
import { TouchControls } from "./ui/touchControls";
import { SelectScreen } from "./ui/selectScreen";
import type { LobbyView } from "./ui/selectScreen";
import { CHARACTERS } from "./characters/characters";
import type { Controller } from "./ai/ai";
import { NetClient, resolveServerUrl } from "./net/netClient";
import type { NoticeEntry } from "./net/netClient";
import { MAX_PLAYERS, COUNTDOWN_INGAME_AT } from "./net/protocol";

// --- Setup canvas ---
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
function logicalSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

// --- Round constants ---
const TIME_LIMIT_SECONDS = 5 * 60;
const OBJECTIVE_COUNT = 5;
const OBJECTIVES_REQUIRED = 5;
const AI_HUNTERS = ["slagy"];
const AI_SURVIVORS = ["match", "magnek"];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type Rect = { x: number; y: number; w: number; h: number };
function inRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

// --- App mode (chosen at the title, or via URL shortcut) ---
type AppMode = "local" | "net";
let appMode: AppMode | null = null;
let started = false;
let net: NetClient | null = null;

function chooseMode(mode: AppMode): void {
  appMode = mode;
  started = true;
  if (mode === "net" && !net) net = new NetClient(resolveServerUrl());
}

// --- Persistent singletons ---
const input = createInput();
bindInput(canvas, input);
const renderer = new Renderer(ctx, canvas);
renderer.setDimensionSource(() => logicalSize());

// --- Local scene state ---
type Scene = "select" | "playing";
let scene: Scene = "select";
interface PlayState {
  world: World;
  mode: HuntMode;
  engine: Engine;
  controllers: Map<number, Controller>;
  cam: Camera;
  chosenCharacterId: string;
}
let play: PlayState | null = null;

// --- Networked render state ---
let netViewWorld: World | null = null;
const netCam: Camera = createCamera({ x: 0, y: 0 });
let netCamInit = false;
// One-shot: broadcast our default highlight when we (re)enter the lobby so
// the opponent sees our pick without us tapping. Reset when we leave lobby.
let netInitialPickSent = false;
// Client-side smoothing: rendered character positions ease toward the
// authoritative snapshot position, turning 30 Hz steps into fluid motion.
// Keyed by entity id; pruned/cleared when entities vanish or the round ends.
const netSmoothed = new Map<number, { x: number; y: number }>();

// --- Select screen (local picker + networked lobby) ---
const selectScreen = new SelectScreen();
selectScreen.bind(canvas, logicalSize, {
  onStart: (chosenId) => {
    if (appMode === "net" && net) {
      // READY toggle: ready up with the current pick, or cancel if ready.
      const me = net.lobby.find((p) => p.slot === net!.slot);
      if (me?.ready) {
        net.ready(false);
      } else {
        net.select(chosenId);
        net.ready(true);
      }
    } else if (appMode === "local") {
      startRound(chosenId);
    }
  },
  onSelect: (id) => {
    // Live pick broadcast so the opponent sees it immediately.
    if (appMode === "net" && net && net.phase === "lobby") net.select(id);
  },
  isTouchMode: () => input.isTouchMode,
  isActive: () =>
    !started
      ? false
      : appMode === "net"
        ? net?.phase === "lobby"
        : scene === "select",
});

// --- Touch controls (mode-aware hooks) ---
const touchControls = new TouchControls();
touchControls.bind(canvas, logicalSize, {
  input,
  getWorld: () => (appMode === "net" ? netViewWorld : (play?.world ?? null)),
  getOutcome: () =>
    appMode === "net" ? (net?.outcome ?? "ongoing") : (play?.engine.outcome ?? "ongoing"),
  isPaused: () => (appMode === "net" ? false : (play?.engine.paused ?? false)),
  togglePause: () => {
    if (appMode === "local" && play) play.engine.paused = !play.engine.paused;
  },
  restart: () => {
    if (appMode === "net") net?.restart();
    else if (appMode === "local") goToSelect();
  },
  isPlaying: () =>
    appMode === "net"
      ? net?.phase === "playing" || net?.phase === "ended"
      : appMode === "local"
        ? scene === "playing"
        : false,
});

// --- Title screen input (gated to !started) ---
let titleButtons: { single: Rect; two: Rect } | null = null;
function handleTitleTap(p: { x: number; y: number }): void {
  if (started || !titleButtons) return;
  if (inRect(p, titleButtons.single)) chooseMode("local");
  else if (inRect(p, titleButtons.two)) chooseMode("net");
}
canvas.addEventListener("mousedown", (ev) => {
  if (started) return;
  const r = canvas.getBoundingClientRect();
  handleTitleTap({ x: ev.clientX - r.left, y: ev.clientY - r.top });
});
canvas.addEventListener(
  "touchstart",
  (ev) => {
    if (started) return;
    const t = ev.changedTouches[0];
    if (!t) return;
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    handleTitleTap({ x: t.clientX - r.left, y: t.clientY - r.top });
  },
  { passive: false },
);

// --- Keyboard ---
window.addEventListener("keydown", (ev) => {
  if (!started) return;
  if (appMode === "net") {
    if (net && net.phase === "ended" && ev.key.toLowerCase() === "r") net.restart();
    return;
  }
  if (scene !== "playing" || !play) return;
  if (ev.key === "Escape") {
    play.engine.paused = !play.engine.paused;
  } else if (ev.key.toLowerCase() === "r" && play.engine.outcome !== "ongoing") {
    goToSelect();
  }
});

// ===== Local mode =====

function startRound(chosenId: string): void {
  const def = CHARACTERS[chosenId];
  if (!def) return;

  let hunterId: string;
  let survivorId: string;
  let playerRole: "hunter" | "survivor";
  if (def.role === "hunter") {
    hunterId = chosenId;
    survivorId = pickRandom(AI_SURVIVORS);
    playerRole = "hunter";
  } else {
    hunterId = pickRandom(AI_HUNTERS);
    survivorId = chosenId;
    playerRole = "survivor";
  }

  const world = new World(FOREST_ARENA_CONFIG, TIME_LIMIT_SECONDS);
  buildForest(world, Math.floor(Math.random() * 1e9), OBJECTIVE_COUNT);

  const mode = new HuntMode({
    hunterCharacterId: hunterId,
    survivorCharacterIds: [survivorId],
    playerRole,
    objectivesRequired: OBJECTIVES_REQUIRED,
  });
  mode.initialize(world);

  const controllers = new Map<number, Controller>();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) {
      controllers.set(c.id, new HumanController(input));
    } else {
      const ai = createAIController(c.characterId);
      if (ai) controllers.set(c.id, ai);
    }
  }

  const engine = new Engine({ world, mode, controllers });
  const player = world.playerCharacter();
  const cam = createCamera(player ? { ...player.pos } : { x: 0, y: 0 });

  play = { world, mode, engine, controllers, cam, chosenCharacterId: chosenId };
  scene = "playing";
}

function goToSelect(): void {
  const prior = play?.chosenCharacterId ?? null;
  play = null;
  scene = "select";
  if (prior) selectScreen.setSelected(prior);
}

function frameLocal(dt: number, dims: { w: number; h: number }): void {
  if (scene === "select") {
    selectScreen.setLobbyView(null);
    selectScreen.draw(ctx, dims);
    return;
  }
  if (scene === "playing" && play) {
    const p = play;
    input.mouseWorld = screenToWorld(input.mouseScreen, p.cam, renderer.cw, renderer.ch);
    p.engine.tick(dt);

    const player = p.world.playerCharacter();
    if (player) {
      p.cam.target.x += (player.pos.x - p.cam.target.x) * Math.min(1, dt * 6);
      p.cam.target.y += (player.pos.y - p.cam.target.y) * Math.min(1, dt * 6);
    }

    renderer.clear("#1a2421");
    renderer.drawArena(p.world, p.cam);
    renderer.drawEntities(p.world, p.cam);
    drawHUD(ctx, canvas, p.world, p.engine.outcome, p.engine.paused, dims, input.isTouchMode);
    if (input.isTouchMode) {
      touchControls.draw(ctx, dims, p.world, p.engine.outcome, p.engine.paused);
    }
  }
}

// ===== Networked mode =====

// Build the lobby overlay for the select screen from the latest server
// lobby broadcast. Slots with no connected player render as "waiting".
function buildLobbyView(): LobbyView {
  const n = net!;
  // One row per connected player. If there's room for more, append a
  // single "Open slot" placeholder so the lobby telegraphs that more
  // players can join — without exploding into MAX_PLAYERS rows.
  const players = n.lobby.map((p) => {
    const you = p.slot === n.slot;
    return {
      label: `Player ${p.slot + 1}${you ? " (you)" : ""}`,
      characterName: p.characterId
        ? (CHARACTERS[p.characterId]?.name ?? p.characterId)
        : null,
      ready: p.ready,
      present: true,
    };
  });
  if (n.lobby.length < MAX_PLAYERS) {
    players.push({
      label: "Open slot",
      characterName: null,
      ready: false,
      present: false,
    });
  }
  const me = n.lobby.find((p) => p.slot === n.slot);
  const amReady = me?.ready ?? false;
  return {
    title: "MULTIPLAYER LOBBY",
    players,
    status: n.blockedReason,
    buttonLabel: amReady ? "READY ✓ — TAP TO CANCEL" : "READY UP",
    buttonEnabled: true,
  };
}

function frameNet(dt: number, dims: { w: number; h: number }): void {
  if (!net) return;
  const n = net;

  // Smoothing state only applies during a round/countdown.
  if (n.phase !== "playing" && n.phase !== "ended" && n.phase !== "countdown") {
    netSmoothed.clear();
  }

  // Notice toasts age out automatically.
  n.pruneNotices();

  switch (n.phase) {
    case "connecting":
      netCamInit = false;
      netInitialPickSent = false;
      drawCenter(dims, "Connecting to server…", resolveServerUrl());
      return;
    case "full":
      netCamInit = false;
      drawCenter(dims, "Game is full", "Maximum players are already connected.");
      return;
    case "disconnected":
      netCamInit = false;
      drawCenter(dims, "Disconnected", "Trying to reconnect…");
      return;
    case "lobby":
      netCamInit = false;
      if (!netInitialPickSent && n.slot !== null) {
        const sel = selectScreen.getSelected();
        if (sel) n.select(sel);
        netInitialPickSent = true;
      }
      selectScreen.setLobbyView(buildLobbyView());
      selectScreen.draw(ctx, dims);
      drawNoticesToast(dims, n.notices);
      return;
    case "countdown": {
      const remaining = n.countdownRemaining;
      const showInGame = remaining <= COUNTDOWN_INGAME_AT;
      if (!showInGame) {
        // 5, 4 — lobby with countdown overlay so players see the round
        // start sequence rooted where they were waiting.
        if (!netInitialPickSent && n.slot !== null) {
          const sel = selectScreen.getSelected();
          if (sel) n.select(sel);
          netInitialPickSent = true;
        }
        selectScreen.setLobbyView(buildLobbyView());
        selectScreen.draw(ctx, dims);
        drawCountdownOverlay(dims, remaining);
      } else {
        // 3, 2, 1 — switch to the game scene (frozen world) with the
        // countdown number overlayed so players see who they spawn next to.
        drawNetGameScene(dt, dims, n);
        drawCountdownOverlay(dims, remaining);
      }
      drawNoticesToast(dims, n.notices);
      return;
    }
    case "playing":
    case "ended":
      drawNetGameScene(dt, dims, n);
      drawNoticesToast(dims, n.notices);
      return;
  }
}

// Render the networked game: snapshot -> view world -> renderer + HUD +
// touch overlay. Shared between the playing phase and the in-game tail of
// the countdown (3, 2, 1). Input is streamed only while truly playing.
function drawNetGameScene(dt: number, dims: { w: number; h: number }, n: NetClient): void {
  const snap = n.snapshot;
  if (!snap) {
    drawCenter(dims, "Starting round…", "");
    return;
  }
  // Build the render entity list. Characters are smoothed toward their
  // authoritative position and flagged isPlayer for our own; fast,
  // short-lived entities (projectiles) render at the exact server pos.
  const k = Math.min(1, dt * 18);
  const liveIds = new Set<number>();
  const renderEntities = snap.entities.map((e) => {
    liveIds.add(e.id);
    if (e.kind !== "character") return e;
    let s = netSmoothed.get(e.id);
    if (!s) {
      s = { x: e.pos.x, y: e.pos.y };
      netSmoothed.set(e.id, s);
    } else {
      s.x += (e.pos.x - s.x) * k;
      s.y += (e.pos.y - s.y) * k;
    }
    return { ...e, pos: { x: s.x, y: s.y }, isPlayer: e.id === n.yourEntityId };
  });
  for (const id of netSmoothed.keys()) {
    if (!liveIds.has(id)) netSmoothed.delete(id);
  }

  if (!netViewWorld) netViewWorld = new World(FOREST_ARENA_CONFIG, snap.timeLimit);
  netViewWorld.entities = renderEntities;
  netViewWorld.elapsed = snap.elapsed;
  netViewWorld.timeLimit = snap.timeLimit;

  const me = netViewWorld.playerCharacter();
  if (me && !netCamInit) {
    netCam.target.x = me.pos.x;
    netCam.target.y = me.pos.y;
    netCamInit = true;
  } else if (me) {
    netCam.target.x += (me.pos.x - netCam.target.x) * Math.min(1, dt * 6);
    netCam.target.y += (me.pos.y - netCam.target.y) * Math.min(1, dt * 6);
  }

  input.mouseWorld = screenToWorld(input.mouseScreen, netCam, renderer.cw, renderer.ch);
  // Stream input only while genuinely playing (not during countdown, not
  // after the round ended) so abilities don't queue up across boundaries.
  if (n.phase === "playing") n.sendInput(input);
  input.pressedAbilities.clear();

  renderer.clear("#1a2421");
  renderer.drawArena(netViewWorld, netCam);
  renderer.drawEntities(netViewWorld, netCam);
  drawHUD(ctx, canvas, netViewWorld, n.outcome, false, dims, input.isTouchMode);
  if (input.isTouchMode) {
    touchControls.draw(ctx, dims, netViewWorld, n.outcome, false);
  }
}

// Big-number countdown centered on screen. Used at 5,4 over the lobby and
// at 3,2,1 over the (frozen) game. ceil() so 4.7s reads "5", 0.1s reads "1".
function drawCountdownOverlay(dims: { w: number; h: number }, remaining: number): void {
  const n = Math.max(1, Math.ceil(remaining));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, dims.w, dims.h);
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 180px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), dims.w / 2, dims.h / 2);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText("GAME BEGINS IN…", dims.w / 2, dims.h / 2 + 130);
  ctx.restore();
  ctx.textBaseline = "alphabetic";
}

// Stack of fading toasts at the top of the screen — drop / rejoin events.
function drawNoticesToast(dims: { w: number; h: number }, notices: NoticeEntry[]): void {
  if (notices.length === 0) return;
  const maxAge = 3500;
  const now = performance.now();
  const visible = notices.slice(-5);
  let y = 96;
  ctx.save();
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (const note of visible) {
    const age = now - note.bornAt;
    if (age > maxAge) continue;
    // Fade in fast, hold, fade out over the last 500ms.
    const alpha = age < 200 ? age / 200 : age > maxAge - 500 ? (maxAge - age) / 500 : 1;
    const tw = ctx.measureText(note.text).width;
    const pad = 16;
    const bw = tw + pad * 2;
    const bh = 32;
    const bx = (dims.w - bw) / 2;
    const tint =
      note.kind === "drop"
        ? `rgba(208, 72, 72, ${0.85 * alpha})`
        : note.kind === "rejoin"
          ? `rgba(72, 208, 160, ${0.85 * alpha})`
          : `rgba(255, 216, 74, ${0.85 * alpha})`;
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.moveTo(bx + 6, y);
    ctx.lineTo(bx + bw - 6, y);
    ctx.arcTo(bx + bw, y, bx + bw, y + 6, 6);
    ctx.lineTo(bx + bw, y + bh - 6);
    ctx.arcTo(bx + bw, y + bh, bx + bw - 6, y + bh, 6);
    ctx.lineTo(bx + 6, y + bh);
    ctx.arcTo(bx, y + bh, bx, y + bh - 6, 6);
    ctx.lineTo(bx, y + 6);
    ctx.arcTo(bx, y, bx + 6, y, 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(20, 30, 28, ${alpha})`;
    ctx.fillText(note.text, dims.w / 2, y + bh / 2);
    y += bh + 6;
  }
  ctx.restore();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
}

// ===== Title screen =====

function frameTitle(dims: { w: number; h: number }): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.fillText("BRAMBLETOOTH", cw / 2, ch * 0.3);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText("Asymmetric isometric arena — 1v1 hunter vs survivor", cw / 2, ch * 0.3 + 30);

  const bw = 300;
  const bh = 64;
  const gap = 20;
  const bx = cw / 2 - bw / 2;
  const by = ch * 0.5;
  const single: Rect = { x: bx, y: by, w: bw, h: bh };
  const two: Rect = { x: bx, y: by + bh + gap, w: bw, h: bh };
  titleButtons = { single, two };

  drawButton(single, "SINGLE PLAYER", true);
  drawButton(two, "MULTIPLAYER", true);

  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(
    "Multiplayer connects to the game server over your network.",
    cw / 2,
    by + 2 * bh + gap + 34,
  );
}

function drawButton(r: Rect, label: string, primary: boolean): void {
  ctx.fillStyle = primary ? "#ffd84a" : "rgba(40,52,48,0.9)";
  roundRect(r, 12);
  ctx.fill();
  ctx.fillStyle = primary ? "#1a2421" : "#fff";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
  ctx.textBaseline = "alphabetic";
}

function roundRect(r: Rect, rad: number): void {
  const { x, y, w, h } = r;
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// Shared full-screen status text (net connecting/full/disconnected/start).
function drawCenter(dims: { w: number; h: number }, title: string, subtitle: string): void {
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, dims.w, dims.h);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText(title, dims.w / 2, dims.h / 2 - 6);
  if (subtitle) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "14px system-ui, sans-serif";
    ctx.fillText(subtitle, dims.w / 2, dims.h / 2 + 24);
  }
}

// --- URL shortcuts (skip the title) ---
const params = new URLSearchParams(location.search);
if (params.has("net")) chooseMode("net");
else if (params.has("solo")) chooseMode("local");

// --- Loop ---
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const dims = logicalSize();

  if (!started) frameTitle(dims);
  else if (appMode === "net") frameNet(dt, dims);
  else frameLocal(dt, dims);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
