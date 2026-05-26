// Main entry point. Creates the world, mode, engine, renderer, and runs
// the loop. Most of the interesting bits are in their own modules.

import "./abilities/abilities"; // ensure abilities are registered
import { World } from "./core/world";
import { createInput, bindInput } from "./core/input";
import { Engine } from "./core/engine";
import { Renderer, createCamera, screenToWorld } from "./render/renderer";
import { OneVOneMode } from "./modes/oneVOne";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { SlagyAI, MatchAI } from "./ai/ai";
import { drawHUD } from "./ui/hud";
import { TouchControls } from "./ui/touchControls";
import type { AIController } from "./ai/ai";

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
// After setTransform our "logical" canvas size for rendering math is css pixels.
// Renderer reads canvas.width/.height; override those for our purposes.
// Simpler: just use a getter on canvas via wrapper. We'll patch the renderer's
// cw/ch via the un-scaled dimensions below.
function logicalSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

// --- World ---
const TIME_LIMIT_SECONDS = 5 * 60;
const OBJECTIVES_REQUIRED = 4;
// Swap which characters spawn here. No select screen yet; change the const,
// reload. Player role is wired to "survivor" below, so the survivor is you
// and the hunter is AI.
const HUNTER_ID = "slagy";
const SURVIVOR_ID = "magnek";
const world = new World(FOREST_ARENA_CONFIG, TIME_LIMIT_SECONDS);
buildForest(world, 12345, 5);

// --- Mode ---
const mode = new OneVOneMode({
  hunterCharacterId: HUNTER_ID,
  survivorCharacterId: SURVIVOR_ID,
  playerRole: "survivor",
  objectivesRequired: OBJECTIVES_REQUIRED,
});
mode.initialize(world);

// --- Input ---
const input = createInput();
bindInput(canvas, input);

// --- AI ---
const aiControllers = new Map<number, AIController>();
for (const c of world.allCharacters()) {
  if (c.isPlayer) continue;
  if (c.characterId === "slagy") aiControllers.set(c.id, new SlagyAI());
  else if (c.characterId === "match") aiControllers.set(c.id, new MatchAI());
}

// --- Engine ---
const engine = new Engine({ world, mode, input, aiControllers });

// --- Touch controls ---
// Always bind: the overlay activates on the first touchstart and stays on.
// Keyboard/mouse users never see it.
const touchControls = new TouchControls();
touchControls.bind(canvas, logicalSize, {
  input,
  world,
  getOutcome: () => engine.outcome,
  isPaused: () => engine.paused,
  togglePause: () => {
    engine.paused = !engine.paused;
  },
  restart: () => restartRound(),
});

// --- Renderer & camera ---
const renderer = new Renderer(ctx, canvas);
// We DPR-scale via ctx.setTransform, so renderer should use CSS pixels.
renderer.setDimensionSource(() => logicalSize());

const player = world.playerCharacter();
const cam = createCamera(player ? { ...player.pos } : { x: 0, y: 0 });

// --- Pause and restart ---
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    engine.paused = !engine.paused;
  } else if (ev.key.toLowerCase() === "r" && engine.outcome !== "ongoing") {
    restartRound();
  }
});

function restartRound() {
  // Wipe and rebuild world in place
  world.entities = [];
  world.elapsed = 0;
  buildForest(world, Math.floor(Math.random() * 1e9), 5);
  mode.initialize(world);
  aiControllers.clear();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) continue;
    if (c.characterId === "slagy") aiControllers.set(c.id, new SlagyAI());
    else if (c.characterId === "match") aiControllers.set(c.id, new MatchAI());
  }
  // Update engine refs that pointed to old controllers
  engine.cfg.aiControllers = aiControllers;
  engine.outcome = "ongoing";
  engine.paused = false;
  // Recenter camera
  const p = world.playerCharacter();
  if (p) {
    cam.target.x = p.pos.x;
    cam.target.y = p.pos.y;
  }
}

// --- Loop ---
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); // clamp big jumps
  last = now;

  // Project mouse to world before engine tick so abilities aim correctly
  input.mouseWorld = screenToWorld(
    input.mouseScreen,
    cam,
    renderer.cw,
    renderer.ch,
  );

  engine.tick(dt);

  // Camera follows player smoothly
  const p = world.playerCharacter();
  if (p) {
    cam.target.x += (p.pos.x - cam.target.x) * Math.min(1, dt * 6);
    cam.target.y += (p.pos.y - cam.target.y) * Math.min(1, dt * 6);
  }

  renderer.clear("#1a2421");
  renderer.drawArena(world, cam);
  renderer.drawEntities(world, cam);
  const dims = logicalSize();
  drawHUD(
    ctx,
    canvas,
    world,
    engine.outcome,
    engine.paused,
    dims,
    input.isTouchMode,
  );
  if (input.isTouchMode) {
    touchControls.draw(ctx, dims, world, engine.outcome, engine.paused);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
