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
import type { Entity, CharacterEntity } from "./core/entity";
import { isProp } from "./core/entity";
import { distToSegment } from "./core/math";
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
// First survivor to collect this many objectives wins for survivors.
// Objectives spawn one at a time and respawn on collect.
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

// --- App mode (chosen at title; the back button can return us here) ---
type AppMode = "local" | "net";
let appMode: AppMode | null = null;
let started = false;
let net: NetClient | null = null;

function chooseMode(mode: AppMode): void {
  appMode = mode;
  started = true;
  if (mode === "net" && !net) net = new NetClient(resolveServerUrl(), getName());
}

// ---- Persistent profile (localStorage) ----
const NAME_KEY = "brambletooth.name";
const POINTS_KEY = "brambletooth.points";

function getName(): string {
  try { return (localStorage.getItem(NAME_KEY) ?? "").slice(0, 24); }
  catch { return ""; }
}
function setName(name: string): void {
  try { localStorage.setItem(NAME_KEY, name.slice(0, 24)); } catch { /* private mode */ }
}
function getPoints(): number {
  try { return Number(localStorage.getItem(POINTS_KEY) ?? "0") || 0; }
  catch { return 0; }
}
function addPoints(n: number): void {
  try { localStorage.setItem(POINTS_KEY, String(getPoints() + n)); } catch { /* ignore */ }
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
  isPaused: () =>
    appMode === "net" ? (net?.paused ?? false) : (play?.engine.paused ?? false),
  togglePause: () => {
    if (appMode === "net" && net) net.setPaused(!net.paused);
    else if (appMode === "local" && play) play.engine.paused = !play.engine.paused;
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

// --- Title screen + back-button input ---
// Title hit zones (only when !started). Back-button hit zone (only when
// started) is stored separately and computed each draw from logical size.
let titleButtons: { single: Rect; two: Rect } | null = null;
const backBtnRect: Rect = { x: 20, y: 20, w: 96, h: 36 };

function handleTitleTap(p: { x: number; y: number }): void {
  if (!titleButtons) return;
  if (inRect(p, titleButtons.single)) chooseMode("local");
  else if (inRect(p, titleButtons.two)) chooseMode("net");
}

// ---- Pause / Leave Game ----
// The pause overlay (drawn by drawHUD) gains a Leave Game button. We layer
// it on top in main so we can own the hit-test and the points penalty.
let pauseLeaveBtn: Rect | null = null;

function isPausedNow(): boolean {
  if (appMode === "local" && play) return play.engine.paused;
  if (appMode === "net" && net) return net.paused;
  return false;
}
function currentOutcome(): string {
  if (appMode === "local" && play) return play.engine.outcome;
  if (appMode === "net" && net) return net.outcome;
  return "ongoing";
}

function drawLeaveGameButton(dims: { w: number; h: number }): void {
  // Only on the pause overlay (not on the post-round outcome screen).
  if (!isPausedNow() || currentOutcome() !== "ongoing") {
    pauseLeaveBtn = null;
    return;
  }
  const bw = 300;
  const bh = 52;
  const bx = (dims.w - bw) / 2;
  const by = dims.h / 2 + 80;
  pauseLeaveBtn = { x: bx, y: by, w: bw, h: bh };
  ctx.save();
  ctx.fillStyle = "rgba(208, 72, 72, 0.9)";
  roundRect(pauseLeaveBtn, 10);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 1;
  roundRect(pauseLeaveBtn, 10);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`LEAVE GAME  (−${POINTS_LEAVE_PENALTY} points)`, bx + bw / 2, by + bh / 2);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function handleLeaveGameTap(p: { x: number; y: number }): boolean {
  if (!pauseLeaveBtn) return false;
  if (!inRect(p, pauseLeaveBtn)) return false;
  // Apply the penalty against lifetime points (clamped at 0 to keep the
  // display sane — leaving repeatedly shouldn't drive it negative).
  addPoints(-POINTS_LEAVE_PENALTY);
  if (getPoints() < 0) {
    try { localStorage.setItem("brambletooth.points", "0"); } catch { /* ignore */ }
  }
  goToTitle();
  return true;
}

// Back is allowed during non-gameplay phases only. Mid-round exit goes
// through the pause overlay's Leave Game (with a point penalty).
function backAllowed(): boolean {
  if (!started) return false;
  if (appMode === "local") return scene === "select";
  if (appMode === "net") {
    return (
      net?.phase === "lobby" ||
      net?.phase === "connecting" ||
      net?.phase === "full" ||
      net?.phase === "disconnected"
    );
  }
  return false;
}

function handleBackTap(p: { x: number; y: number }): boolean {
  if (!backAllowed()) return false;
  if (!inRect(p, backBtnRect)) return false;
  goToTitle();
  return true;
}

canvas.addEventListener("mousedown", (ev) => {
  const r = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  if (started) {
    if (handleLeaveGameTap(p)) return;
    handleBackTap(p);
  } else {
    handleTitleTap(p);
  }
});
canvas.addEventListener(
  "touchstart",
  (ev) => {
    const t = ev.changedTouches[0];
    if (!t) return;
    const r = canvas.getBoundingClientRect();
    const p = { x: t.clientX - r.left, y: t.clientY - r.top };
    if (started) {
      if (handleLeaveGameTap(p)) { ev.preventDefault(); return; }
      if (handleBackTap(p)) ev.preventDefault();
    } else {
      ev.preventDefault();
      handleTitleTap(p);
    }
  },
  { passive: false },
);

// Tear down whichever mode we're in and return to the title. Clean shutdown
// of the networking layer (disconnect, no auto-reconnect) so the server's
// slot frees immediately rather than waiting for a ghost timeout.
function goToTitle(): void {
  if (appMode === "net" && net) {
    net.disconnect();
    net = null;
  }
  play = null;
  scene = "select";
  netViewWorld = null;
  netCamInit = false;
  netInitialPickSent = false;
  netSmoothed.clear();
  appMode = null;
  started = false;
  // Reset per-round point-award trackers so a fresh round starts clean.
  localAwards = newAwardState();
  netAwards = newAwardState();
  // Reset name input visibility — frameTitle will re-show it next frame.
}

// --- Keyboard ---
window.addEventListener("keydown", (ev) => {
  if (!started) return;
  if (appMode === "net") {
    if (!net) return;
    if (ev.key === "Escape" && (net.phase === "playing" || net.phase === "ended")) {
      // Multiplayer pause is server-mediated — toggling here pauses everyone.
      net.setPaused(!net.paused);
    } else if (ev.key.toLowerCase() === "r" && net.phase === "ended") {
      net.restart();
    }
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
  // HuntMode owns objective spawning (one at a time, respawn on collect),
  // so the arena builder places no objectives.
  buildForest(world, Math.floor(Math.random() * 1e9), 0);

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
    const localVis = visibilityFilter(p.world, p.world.playerCharacter()?.id);
    renderer.drawEntities(p.world, p.cam, localVis);
    drawHUD(ctx, canvas, p.world, {
      outcome: p.engine.outcome,
      paused: p.engine.paused,
      dimensions: dims,
      isTouchMode: input.isTouchMode,
      points: getPoints(),
      objectivesRequired: OBJECTIVES_REQUIRED,
    });
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
    // Server defaults p.name to "Player N" when no join.name was sent, so
    // this just works whether the player set a name or not.
    return {
      label: `${p.name}${you ? " (you)" : ""}`,
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
  const netVis = visibilityFilter(netViewWorld, n.yourEntityId);
  renderer.drawEntities(netViewWorld, netCam, netVis);
  drawHUD(ctx, canvas, netViewWorld, {
    outcome: n.outcome,
    paused: n.paused,
    dimensions: dims,
    isTouchMode: input.isTouchMode,
    points: getPoints(),
    objectivesRequired: OBJECTIVES_REQUIRED,
  });
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

// ---- DOM name input (real keyboard on iPad) ----
// Lives over the canvas; shown only on the title screen.
const nameInput = document.createElement("input");
nameInput.type = "text";
nameInput.maxLength = 24;
nameInput.placeholder = "Enter your name";
nameInput.setAttribute("autocomplete", "off");
nameInput.setAttribute("autocapitalize", "words");
nameInput.style.cssText = [
  "position: fixed",
  "left: 50%",
  "transform: translateX(-50%)",
  "width: 320px",
  "height: 44px",
  "padding: 0 14px",
  "font: 600 16px system-ui, sans-serif",
  "background: rgba(40, 52, 48, 0.9)",
  "border: 2px solid rgba(255, 255, 255, 0.15)",
  "border-radius: 10px",
  "color: #fff",
  "outline: none",
  "box-sizing: border-box",
  "display: none",
  "z-index: 10",
].join("; ");
nameInput.value = getName();
nameInput.addEventListener("input", () => setName(nameInput.value));
nameInput.addEventListener("focus", () => {
  nameInput.style.borderColor = "#ffd84a";
});
nameInput.addEventListener("blur", () => {
  nameInput.style.borderColor = "rgba(255, 255, 255, 0.15)";
});
document.body.appendChild(nameInput);

function frameTitle(dims: { w: number; h: number }): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.fillText("BRAMBLETOOTH", cw / 2, ch * 0.22);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText("Asymmetric isometric arena — hunter vs survivors", cw / 2, ch * 0.22 + 30);

  // Profile area: name input (DOM, positioned just below) + points.
  const inputTop = ch * 0.36;
  nameInput.style.display = "block";
  nameInput.style.top = `${inputTop}px`;
  // Centered label above the input.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("YOUR NAME", cw / 2, inputTop - 10);

  // Points line just below the input.
  const points = getPoints();
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText(
    points === 1 ? "★ 1 point" : `★ ${points} points`,
    cw / 2,
    inputTop + 76,
  );

  const bw = 300;
  const bh = 64;
  const gap = 20;
  const bx = cw / 2 - bw / 2;
  const by = ch * 0.58;
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

// Small "← BACK" pill in the top-left, drawn over every non-title scene.
function drawBackButton(): void {
  const b = backBtnRect;
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  roundRect(b, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1;
  roundRect(b, 8);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("← BACK", b.x + b.w / 2, b.y + b.h / 2);
  ctx.restore();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
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

// ---- Line of sight ----
// Survivors only see hunters they have a clear line to. Cheap line-segment
// vs. blocking-prop circle test against every prop. ~50 ops/frame in the
// forest arena — negligible. Hunters see everything (standard).
const LOS_FUDGE = 4; // forgiving corners

function hasLineOfSight(a: { x: number; y: number }, b: { x: number; y: number }, entities: Entity[]): boolean {
  for (const e of entities) {
    if (!isProp(e) || !e.blocking) continue;
    if (distToSegment(e.pos, a, b) <= e.radius + LOS_FUDGE) return false;
  }
  return true;
}

// Returns a predicate for renderer.drawEntities. When the viewer is a
// survivor, hunters out of LOS are filtered out (sneaky hunter feel).
function visibilityFilter(world: World, viewerEntityId: number | null | undefined): ((e: Entity) => boolean) | undefined {
  if (viewerEntityId == null) return undefined;
  const viewer = world.entities.find(
    (e): e is CharacterEntity => e.kind === "character" && e.id === viewerEntityId,
  );
  if (!viewer || viewer.team !== "survivor") return undefined;
  const entities = world.entities;
  return (e: Entity): boolean => {
    if (e.kind !== "character") return true;
    if (e.team !== "hunter") return true;
    if (e.id === viewer.id) return true;
    return hasLineOfSight(viewer.pos, e.pos, entities);
  };
}

// ---- Multi-event scoring ----
// Awards across each round, idempotent within the round:
//   Hunter: +5 per catch (survivor disappears from the world), +20 round win.
//   Survivor: +5 per objective YOU personally collected, +10 if you survive
//             to round end alive, +20 round win.
// Penalty (separate): -15 leave-game (applied directly by the pause overlay).
//
// State persists across rounds; the natural "outcome -> ongoing" transition
// (engine on local startRound, NetClient on toLobby) re-arms via endAwarded.
const POINTS_CATCH = 5;
const POINTS_OBJECTIVE = 5;
const POINTS_SURVIVE = 10;
const POINTS_WIN = 20;
export const POINTS_LEAVE_PENALTY = 15;

interface RoundAwardState {
  prevSurvivorIds: Set<number>;
  collectedIds: Set<number>;
  endAwarded: boolean;
  lastSeenTeam: "hunter" | "survivor" | null;
}
function newAwardState(): RoundAwardState {
  return {
    prevSurvivorIds: new Set(),
    collectedIds: new Set(),
    endAwarded: false,
    lastSeenTeam: null,
  };
}
let localAwards = newAwardState();
let netAwards = newAwardState();

function processAwards(
  world: World,
  outcome: string,
  viewerEntityId: number | null,
  state: RoundAwardState,
): void {
  if (viewerEntityId == null) return;

  // Re-arm on round start. End-of-previous-round set endAwarded; the next
  // "ongoing" frame is the new round's first opportunity.
  if (outcome === "ongoing" && state.endAwarded) {
    state.prevSurvivorIds = new Set();
    state.collectedIds = new Set();
    state.endAwarded = false;
  }

  // Find / refresh my own entity + team.
  let me: { team: "hunter" | "survivor"; hp: number } | null = null;
  for (const e of world.entities) {
    if (e.kind === "character" && e.id === viewerEntityId) {
      me = e;
      state.lastSeenTeam = e.team;
      break;
    }
  }

  // Catch detection (hunter only): entities that vanished since last frame
  // got killed. (Engine cleanupDead removes corpses; AI takeover keeps a
  // disconnected survivor alive in the world, so a drop doesn't false-fire.)
  const currentSurvivorIds = new Set<number>();
  for (const e of world.entities) {
    if (e.kind === "character" && e.team === "survivor") currentSurvivorIds.add(e.id);
  }
  if (state.lastSeenTeam === "hunter") {
    for (const id of state.prevSurvivorIds) {
      if (!currentSurvivorIds.has(id)) addPoints(POINTS_CATCH);
    }
  }
  state.prevSurvivorIds = currentSurvivorIds;

  // Objective collect (survivor only): server flags collectedBy on the
  // entity at pickup time; clients each detect their own credit.
  if (state.lastSeenTeam === "survivor") {
    for (const e of world.entities) {
      if (
        e.kind === "objective" &&
        e.collected &&
        e.collectedBy === viewerEntityId &&
        !state.collectedIds.has(e.id)
      ) {
        state.collectedIds.add(e.id);
        addPoints(POINTS_OBJECTIVE);
      }
    }
  }

  // End-of-round: win + survive (one-shot).
  if (outcome !== "ongoing" && !state.endAwarded) {
    state.endAwarded = true;
    if (state.lastSeenTeam) {
      if (
        (outcome === "hunter_win" && state.lastSeenTeam === "hunter") ||
        (outcome === "survivor_win" && state.lastSeenTeam === "survivor")
      ) {
        addPoints(POINTS_WIN);
      }
    }
    if (state.lastSeenTeam === "survivor" && me && me.hp > 0) {
      addPoints(POINTS_SURVIVE);
    }
  }
}

function awardPointsIfWon(): void {
  if (appMode === "local" && play) {
    processAwards(
      play.world,
      play.engine.outcome,
      play.world.playerCharacter()?.id ?? null,
      localAwards,
    );
  } else if (appMode === "net" && net && netViewWorld) {
    processAwards(netViewWorld, net.outcome, net.yourEntityId, netAwards);
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
  // Hide the name input whenever we're not on the title. frameTitle re-
  // shows it on the next title frame.
  if (started && nameInput.style.display !== "none") {
    nameInput.style.display = "none";
    if (document.activeElement === nameInput) nameInput.blur();
  }
  const dims = logicalSize();

  if (!started) frameTitle(dims);
  else if (appMode === "net") frameNet(dt, dims);
  else frameLocal(dt, dims);

  // Back button only in non-gameplay phases — leaving a live game cheats
  // the other players. Pause -> Leave Game (with penalty) is the only
  // mid-round exit.
  if (started && backAllowed()) drawBackButton();
  if (started) drawLeaveGameButton(dims);

  // Win → points (one-shot per round). Read each frame; transitions to a
  // terminal outcome trigger exactly one increment.
  awardPointsIfWon();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
