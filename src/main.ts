// Main entry point. Two top-level app modes, fixed at boot:
//   - "local":  single-player vs AI. select -> playing with a local engine.
//   - "net":    two-device play via the authoritative server. lobby ->
//               playing, rendering server snapshots and streaming input.
// Enter networked mode with ?net=1 (a proper menu lands in P4). The local
// path below is untouched by the networked path.

import "./abilities/abilities"; // ensure abilities are registered
import { World } from "./core/world";
import { createInput, bindInput } from "./core/input";
import { Engine } from "./core/engine";
import { Renderer, createCamera, screenToWorld } from "./render/renderer";
import type { Camera } from "./render/renderer";
import { OneVOneMode } from "./modes/oneVOne";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { createAIController } from "./ai/ai";
import { HumanController } from "./core/humanController";
import { drawHUD } from "./ui/hud";
import { TouchControls } from "./ui/touchControls";
import { SelectScreen } from "./ui/selectScreen";
import { CHARACTERS } from "./characters/characters";
import type { Controller } from "./ai/ai";
import { NetClient, resolveServerUrl } from "./net/netClient";

// --- Setup canvas ---
const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;

function resizeCanvas() {
  // Match device pixel ratio for crisp lines but cap to keep perf sane.
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
// How many objectives spawn in the arena, and how many the survivor must
// collect to win. Kept as one source of truth so they can't drift — set
// OBJECTIVES_REQUIRED < OBJECTIVE_COUNT only if you intend "collect N of M".
const OBJECTIVE_COUNT = 5;
const OBJECTIVES_REQUIRED = 5;
// Characters with working AI controllers, by role (local mode only).
const AI_HUNTERS = ["slagy"];
const AI_SURVIVORS = ["match", "magnek"];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- App mode (fixed at boot) ---
type AppMode = "local" | "net";
const appMode: AppMode = new URLSearchParams(location.search).has("net")
  ? "net"
  : "local";

// --- Persistent singletons (alive across scene transitions) ---
const input = createInput();
bindInput(canvas, input);

const renderer = new Renderer(ctx, canvas);
renderer.setDimensionSource(() => logicalSize());

// --- Local scene state ---
type Scene = "select" | "playing";
let scene: Scene = "select";

interface PlayState {
  world: World;
  mode: OneVOneMode;
  engine: Engine;
  controllers: Map<number, Controller>;
  cam: Camera;
  chosenCharacterId: string; // for restoring select-screen highlight
}
let play: PlayState | null = null;

// --- Networked state ---
const net: NetClient | null =
  appMode === "net" ? new NetClient(resolveServerUrl()) : null;
// View world: a throwaway World we stuff each snapshot's entities into, so
// the existing renderer/HUD (which take a World) work unchanged on remote
// state. The client's own character is flagged isPlayer for camera + HUD.
let netViewWorld: World | null = null;
const netCam: Camera = createCamera({ x: 0, y: 0 });
let netCamInit = false;

// --- Select screen (shared by local select and net lobby) ---
const selectScreen = new SelectScreen();
selectScreen.bind(canvas, logicalSize, {
  onStart: (chosenId) => {
    if (appMode === "net" && net) {
      net.select(chosenId);
      net.ready(true);
    } else {
      startRound(chosenId);
    }
  },
  isTouchMode: () => input.isTouchMode,
  isActive: () =>
    appMode === "net" ? net?.phase === "lobby" : scene === "select",
});

// --- Touch controls (bound once; net-aware hooks) ---
const touchControls = new TouchControls();
touchControls.bind(canvas, logicalSize, {
  input,
  getWorld: () => (appMode === "net" ? netViewWorld : (play?.world ?? null)),
  getOutcome: () =>
    appMode === "net" ? (net?.outcome ?? "ongoing") : (play?.engine.outcome ?? "ongoing"),
  isPaused: () => (appMode === "net" ? false : (play?.engine.paused ?? false)),
  togglePause: () => {
    if (appMode !== "net" && play) play.engine.paused = !play.engine.paused;
  },
  restart: () => {
    if (appMode === "net") net?.restart();
    else goToSelect();
  },
  isPlaying: () =>
    appMode === "net"
      ? net?.phase === "playing" || net?.phase === "ended"
      : scene === "playing",
});

// --- Keyboard ---
window.addEventListener("keydown", (ev) => {
  if (appMode === "net") {
    // No pause in networked play (server keeps running). R restarts after a round.
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

  const mode = new OneVOneMode({
    hunterCharacterId: hunterId,
    survivorCharacterId: survivorId,
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

function frameNet(dt: number, dims: { w: number; h: number }): void {
  if (!net) return;

  switch (net.phase) {
    case "connecting":
      netCamInit = false;
      drawCenter(dims, "Connecting to server…", net ? resolveServerUrl() : "");
      return;
    case "full":
      netCamInit = false;
      drawCenter(dims, "Game is full", "Two players are already connected.");
      return;
    case "disconnected":
      netCamInit = false;
      drawCenter(dims, "Disconnected", "Lost connection to the server. Reload to retry.");
      return;
    case "lobby": {
      netCamInit = false;
      selectScreen.draw(ctx, dims);
      // Banner: either "waiting" guidance or the start-block reason.
      if (net.blockedReason) drawBanner(dims, net.blockedReason);
      return;
    }
    case "playing":
    case "ended": {
      const snap = net.snapshot;
      if (!snap) {
        drawCenter(dims, "Starting round…", "");
        return;
      }
      if (!netViewWorld) netViewWorld = new World(FOREST_ARENA_CONFIG, snap.timeLimit);
      netViewWorld.entities = snap.entities;
      netViewWorld.elapsed = snap.elapsed;
      netViewWorld.timeLimit = snap.timeLimit;
      // Flag our own character so playerCharacter()/camera/HUD track it.
      for (const e of snap.entities) {
        if (e.kind === "character") e.isPlayer = e.id === net.yourEntityId;
      }

      const me = netViewWorld.playerCharacter();
      if (me && !netCamInit) {
        netCam.target.x = me.pos.x;
        netCam.target.y = me.pos.y;
        netCamInit = true;
      } else if (me) {
        netCam.target.x += (me.pos.x - netCam.target.x) * Math.min(1, dt * 6);
        netCam.target.y += (me.pos.y - netCam.target.y) * Math.min(1, dt * 6);
      }

      // Project aim and stream input up. pressedAbilities are edge events —
      // clear them after sending so each press transmits once.
      input.mouseWorld = screenToWorld(input.mouseScreen, netCam, renderer.cw, renderer.ch);
      if (net.phase === "playing") net.sendInput(input);
      input.pressedAbilities.clear();

      renderer.clear("#1a2421");
      renderer.drawArena(netViewWorld, netCam);
      renderer.drawEntities(netViewWorld, netCam);
      drawHUD(ctx, canvas, netViewWorld, net.outcome, false, dims, input.isTouchMode);
      if (input.isTouchMode) {
        touchControls.draw(ctx, dims, netViewWorld, net.outcome, false);
      }
      return;
    }
  }
}

// Centered title + subtitle over a dimmed background (connecting/full/etc).
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

// Small status banner near the top (used in the net lobby while waiting).
function drawBanner(dims: { w: number; h: number }, text: string): void {
  ctx.font = "bold 14px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 32;
  const x = (dims.w - w) / 2;
  const y = dims.h - 130;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x, y, w, 32);
  ctx.fillStyle = "#ffd84a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, dims.w / 2, y + 16);
}

// --- Loop ---
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); // clamp big jumps
  last = now;
  const dims = logicalSize();

  if (appMode === "net") frameNet(dt, dims);
  else frameLocal(dt, dims);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
