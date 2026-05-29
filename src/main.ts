// Main entry point. Owns the scene state machine:
//   - "select": SelectScreen draws the character picker, engine is dormant.
//   - "playing": Engine ticks a round; HUD + touch overlay render on top.
// A round transitions back to "select" when the player taps restart, so
// the select screen doubles as a post-round lobby with the prior pick
// still highlighted.

import "./abilities/abilities"; // ensure abilities are registered
import { World } from "./core/world";
import { createInput, bindInput } from "./core/input";
import { Engine } from "./core/engine";
import { Renderer, createCamera, screenToWorld } from "./render/renderer";
import type { Camera } from "./render/renderer";
import { OneVOneMode } from "./modes/oneVOne";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { createAIController } from "./ai/ai";
import { drawHUD } from "./ui/hud";
import { TouchControls } from "./ui/touchControls";
import { SelectScreen } from "./ui/selectScreen";
import { CHARACTERS } from "./characters/characters";
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
// Characters with working AI controllers, by role. When the player picks a
// side, the opposite side's character is drawn at random from the matching
// pool — so playing as a hunter sometimes faces Match, sometimes Magnek.
// Extend these as new AI controllers land in ai.ts (createAIController).
const AI_HUNTERS = ["slagy"];
const AI_SURVIVORS = ["match", "magnek"];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Persistent singletons (alive across scene transitions) ---
const input = createInput();
bindInput(canvas, input);

const renderer = new Renderer(ctx, canvas);
renderer.setDimensionSource(() => logicalSize());

// --- Scene state ---
type Scene = "select" | "playing";
let scene: Scene = "select";

// PlayState bundles everything that's per-round and gets discarded when
// the player returns to the select screen. The singletons above persist.
interface PlayState {
  world: World;
  mode: OneVOneMode;
  engine: Engine;
  aiControllers: Map<number, AIController>;
  cam: Camera;
  chosenCharacterId: string; // for restoring select-screen highlight
}
let play: PlayState | null = null;

// --- Select screen ---
const selectScreen = new SelectScreen();
selectScreen.bind(canvas, logicalSize, {
  onStart: (chosenId) => startRound(chosenId),
  isTouchMode: () => input.isTouchMode,
  isActive: () => scene === "select",
});

// --- Touch controls (bound once; gated by scene inside) ---
const touchControls = new TouchControls();
touchControls.bind(canvas, logicalSize, {
  input,
  getWorld: () => play?.world ?? null,
  getOutcome: () => play?.engine.outcome ?? "ongoing",
  isPaused: () => play?.engine.paused ?? false,
  togglePause: () => {
    if (play) play.engine.paused = !play.engine.paused;
  },
  restart: () => goToSelect(),
  isPlaying: () => scene === "playing",
});

// --- Keyboard: Esc pause / R restart (scene-aware) ---
window.addEventListener("keydown", (ev) => {
  if (scene !== "playing" || !play) return;
  if (ev.key === "Escape") {
    play.engine.paused = !play.engine.paused;
  } else if (ev.key.toLowerCase() === "r" && play.engine.outcome !== "ongoing") {
    goToSelect();
  }
});

// Build a fresh round around the player's chosen character. The opposite
// role gets filled with the default AI opponent. Player role is derived
// from the chosen character's role.
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

  const aiControllers = new Map<number, AIController>();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) continue;
    const ai = createAIController(c.characterId);
    if (ai) aiControllers.set(c.id, ai);
  }

  const engine = new Engine({ world, mode, input, aiControllers });
  const player = world.playerCharacter();
  const cam = createCamera(player ? { ...player.pos } : { x: 0, y: 0 });

  play = { world, mode, engine, aiControllers, cam, chosenCharacterId: chosenId };
  scene = "playing";
}

// Tear down the active round and return to the select screen, preserving
// the player's prior pick as the default highlight.
function goToSelect(): void {
  const prior = play?.chosenCharacterId ?? null;
  play = null;
  scene = "select";
  if (prior) selectScreen.setSelected(prior);
}

// --- Loop ---
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); // clamp big jumps
  last = now;
  const dims = logicalSize();

  if (scene === "select") {
    selectScreen.draw(ctx, dims);
  } else if (scene === "playing" && play) {
    const p = play;
    // Project mouse to world before engine tick so abilities aim correctly.
    input.mouseWorld = screenToWorld(
      input.mouseScreen,
      p.cam,
      renderer.cw,
      renderer.ch,
    );

    p.engine.tick(dt);

    // Camera follows player smoothly.
    const player = p.world.playerCharacter();
    if (player) {
      p.cam.target.x += (player.pos.x - p.cam.target.x) * Math.min(1, dt * 6);
      p.cam.target.y += (player.pos.y - p.cam.target.y) * Math.min(1, dt * 6);
    }

    renderer.clear("#1a2421");
    renderer.drawArena(p.world, p.cam);
    renderer.drawEntities(p.world, p.cam);
    drawHUD(
      ctx,
      canvas,
      p.world,
      p.engine.outcome,
      p.engine.paused,
      dims,
      input.isTouchMode,
    );
    if (input.isTouchMode) {
      touchControls.draw(ctx, dims, p.world, p.engine.outcome, p.engine.paused);
    }
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
