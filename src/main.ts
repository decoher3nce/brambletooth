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
import { playSound, unlockAudio, setHeartbeat } from "./audio/sound";
import type { SoundId } from "./audio/sound";
import { worldToScreen } from "./render/renderer";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_ORDER,
  drawAchievementTile,
  formatEarnedDate,
} from "./achievements/catalog";
import type { Camera } from "./render/renderer";
import { HuntMode } from "./modes/hunt";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { createAIController } from "./ai/ai";
import { HumanController } from "./core/humanController";
import { drawHUD } from "./ui/hud";
import { TouchControls } from "./ui/touchControls";
import { SelectScreen, slotColor } from "./ui/selectScreen";
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
  // First user gesture — Safari requires this to start audio.
  unlockAudio();
  if (mode === "net" && !net) net = new NetClient(resolveServerUrl(), getName());
}

// ---- Persistent profile (localStorage; synced to server when logged in) ----
const NAME_KEY = "brambletooth.name";
const POINTS_KEY = "brambletooth.points";
const PIN_KEY = "brambletooth.pin";
const LOGGEDIN_KEY = "brambletooth.loggedIn";

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
function setPointsLocal(n: number): void {
  try { localStorage.setItem(POINTS_KEY, String(Math.max(0, Math.floor(n)))); } catch { /* ignore */ }
}
function addPoints(n: number): void {
  const before = getPoints();
  const after = before + n;
  setPointsLocal(after);
  scheduleProfileSync();
  // Noob: very first positive point. Earnable only once per profile.
  if (n > 0 && before === 0) earnAchievement("noob");
  // Veteran: reach 100 lifetime points. Idempotent inside earnAchievement.
  if (before < 100 && after >= 100) earnAchievement("veteran");
}

// ---- Server-backed profile (login + sync) ----
const PROFILE_API_LOGIN = () => `${profileApiBase()}/api/login`;
const PROFILE_API_SYNC = () => `${profileApiBase()}/api/profile/sync`;
function profileApiBase(): string {
  // Same host as the WS server (8787). Vite (5173) on the same hostname.
  const params = new URLSearchParams(location.search);
  const override = params.get("server");
  if (override) {
    // override could be "host:port" or a full ws:// URL.
    const trimmed = override.replace(/^wss?:\/\//, "");
    return `http://${trimmed}`;
  }
  return `http://${location.hostname}:8787`;
}

let loggedIn = false;
let loginError: string | null = null;
let loginPending = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function getPin(): string {
  try { return localStorage.getItem(PIN_KEY) ?? ""; }
  catch { return ""; }
}
function setPin(p: string): void {
  try { localStorage.setItem(PIN_KEY, p); } catch { /* ignore */ }
}

interface ProfileResponse {
  ok: boolean;
  profile?: {
    name: string;
    points: number;
    achievements?: (string | { id: string; earnedAt?: number })[];
  };
  error?: string;
}

async function tryLogin(name: string, pin: string): Promise<boolean> {
  loginPending = true;
  loginError = null;
  try {
    const r = await fetch(PROFILE_API_LOGIN(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pin }),
    });
    const body = (await r.json()) as ProfileResponse;
    if (!body.ok || !body.profile) {
      loginError = body.error ?? "Login failed";
      return false;
    }
    setName(body.profile.name);
    setPin(pin);
    setPointsLocal(body.profile.points);
    if (Array.isArray(body.profile.achievements)) {
      saveEarnedAchievements(
        body.profile.achievements.map((a) =>
          typeof a === "string"
            ? { id: a, earnedAt: 0 }
            : { id: a.id, earnedAt: Number(a.earnedAt) || 0 },
        ),
      );
    }
    loggedIn = true;
    try { localStorage.setItem(LOGGEDIN_KEY, "1"); } catch { /* ignore */ }
    nameInput.value = body.profile.name;
    pinInput.value = pin;
    return true;
  } catch (err) {
    loginError = `Can't reach the server (${(err as Error).message ?? "network"})`;
    return false;
  } finally {
    loginPending = false;
  }
}

function tryLogout(): void {
  loggedIn = false;
  loginError = null;
  try { localStorage.removeItem(LOGGEDIN_KEY); localStorage.removeItem(PIN_KEY); } catch { /* ignore */ }
  pinInput.value = "";
  // Keep the local name + points — they're already shown without login.
}

// Debounce profile sync — avoid spamming the server on rapid point events.
function scheduleProfileSync(): void {
  if (!loggedIn) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const name = getName();
    const pin = getPin();
    if (!name || !pin) return;
    try {
      const r = await fetch(PROFILE_API_SYNC(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          pin,
          points: getPoints(),
          achievements: getEarnedAchievements(),
        }),
      });
      const body = (await r.json()) as ProfileResponse;
      if (body.ok && body.profile) {
        // Server may report a higher number (synced from another device).
        setPointsLocal(body.profile.points);
        // And achievements (with timestamps) — merge wins on server.
        if (Array.isArray(body.profile.achievements)) {
          saveEarnedAchievements(
            body.profile.achievements.map((a) =>
              typeof a === "string"
                ? { id: a, earnedAt: 0 }
                : { id: a.id, earnedAt: Number(a.earnedAt) || 0 },
            ),
          );
        }
      }
    } catch { /* swallow — local is the source of truth until next sync */ }
  }, 800);
}

// ---- Public-profile lookup cache (for lobby hover tooltips) ----
interface PublicProfile {
  name: string;
  points: number;
  achievements: string[];
}
interface CachedLookup {
  profile: PublicProfile | null; // null = looked up, no profile exists
  fetchedAt: number;
}
const PUBLIC_PROFILE_TTL_MS = 30_000;
const publicProfileCache = new Map<string, CachedLookup>();
const publicProfileInFlight = new Set<string>();

function publicProfileFor(name: string): CachedLookup | "loading" | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  const cached = publicProfileCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_PROFILE_TTL_MS) {
    return cached;
  }
  // Stale or missing — kick off a fetch (deduplicated).
  if (!publicProfileInFlight.has(key)) {
    publicProfileInFlight.add(key);
    void fetch(`${profileApiBase()}/api/profile/public?name=${encodeURIComponent(name)}`)
      .then(async (r) => {
        const body = (await r.json()) as { ok: boolean; profile?: PublicProfile };
        publicProfileCache.set(key, {
          profile: body.ok && body.profile ? body.profile : null,
          fetchedAt: Date.now(),
        });
      })
      .catch(() => {
        // Network failure — cache the miss briefly so we don't hammer.
        publicProfileCache.set(key, { profile: null, fetchedAt: Date.now() });
      })
      .finally(() => publicProfileInFlight.delete(key));
  }
  return cached ?? "loading";
}

// On page load: if the user was previously logged in, try silently with
// stored credentials. Falls through to the inputs if it fails.
async function autoLoginIfPossible(): Promise<void> {
  try {
    if (localStorage.getItem(LOGGEDIN_KEY) !== "1") return;
  } catch { return; }
  const name = getName();
  const pin = getPin();
  if (!name || !pin) return;
  await tryLogin(name, pin);
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
    playSound("ui_click");
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
let titleButtons: { single: Rect; two: Rect; ffa: Rect } | null = null;
let titleLoginBtn: Rect | null = null;
let titleLogoutBtn: Rect | null = null;
let titleProfileBtn: Rect | null = null;
let titleProfileBackBtn: Rect | null = null;
type TitleSubScene = "main" | "profile";
let titleSubScene: TitleSubScene = "main";
const backBtnRect: Rect = { x: 20, y: 20, w: 96, h: 36 };

function handleTitleTap(p: { x: number; y: number }): void {
  // Audio gesture unlock on any title tap — works even before chooseMode.
  unlockAudio();

  // Profile sub-scene: only one button to handle (BACK).
  if (titleSubScene === "profile") {
    if (titleProfileBackBtn && inRect(p, titleProfileBackBtn)) {
      playSound("ui_back");
      titleSubScene = "main";
    }
    return;
  }
  // Login button (when not logged in).
  if (titleLoginBtn && inRect(p, titleLoginBtn)) {
    playSound("ui_click");
    const name = nameInput.value.trim();
    const pin = pinInput.value.trim();
    void tryLogin(name, pin);
    return;
  }
  // Logged-in actions.
  if (titleLogoutBtn && inRect(p, titleLogoutBtn)) {
    playSound("ui_back");
    tryLogout();
    return;
  }
  if (titleProfileBtn && inRect(p, titleProfileBtn)) {
    playSound("ui_click");
    titleSubScene = "profile";
    return;
  }
  if (!titleButtons) return;
  if (inRect(p, titleButtons.single)) {
    playSound("ui_click");
    chooseMode("local");
  } else if (inRect(p, titleButtons.two)) {
    playSound("ui_click");
    chooseMode("net");
  } else if (inRect(p, titleButtons.ffa)) {
    // Grayed out — give audible feedback that the click registered but
    // nothing's behind it yet.
    playSound("ui_denied");
  }
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
  playSound("ui_back");
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
  playSound("ui_back");
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
  titleSubScene = "main";
  // Reset per-round point-award trackers so a fresh round starts clean.
  localAwards = newAwardState();
  netAwards = newAwardState();
  // Reset sound/visual event detection state.
  prevCharSnap.clear();
  prevObjectivePicked.clear();
  clientEffects.length = 0;
  setHeartbeat(null);
  // Reset name input visibility — frameTitle will re-show it next frame.
}

// --- Keyboard ---
window.addEventListener("keydown", (ev) => {
  if (!started) return;
  if (appMode === "net") {
    if (!net) return;
    if (ev.key === "Escape" && (net.phase === "playing" || net.phase === "ended")) {
      playSound("ui_click");
      net.setPaused(!net.paused);
    } else if (ev.key.toLowerCase() === "r" && net.phase === "ended") {
      playSound("ui_click");
      net.restart();
    }
    return;
  }
  if (scene !== "playing" || !play) return;
  if (ev.key === "Escape") {
    playSound("ui_click");
    play.engine.paused = !play.engine.paused;
  } else if (ev.key.toLowerCase() === "r" && play.engine.outcome !== "ongoing") {
    playSound("ui_click");
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

    // Sound + visual events + heartbeat (local mode).
    const localMe = p.world.playerCharacter() ?? null;
    detectSoundAndVisualEvents(p.world, localMe);
    updateHeartbeatFor(p.world, localMe?.id ?? null);

    renderer.clear("#1a2421");
    renderer.drawArena(p.world, p.cam);
    const localVis = visibilityFilter(p.world, p.world.playerCharacter()?.id);
    renderer.drawEntities(p.world, p.cam, localVis);
    drawClientEffects(p.cam);
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
    return {
      label: `${p.name}${you ? " (you)" : ""}`,
      characterName: p.characterId
        ? (CHARACTERS[p.characterId]?.name ?? p.characterId)
        : null,
      ready: p.ready,
      present: true,
      slot: p.slot,
      characterId: p.characterId,
      color: slotColor(p.slot),
      you,
    };
  });
  if (n.lobby.length < MAX_PLAYERS) {
    // Cast: TS infers a stricter shape from the map above; the placeholder
    // intentionally omits slot / color (no assigned player).
    players.push({
      label: "Open slot",
      characterName: null,
      ready: false,
      present: false,
      characterId: null,
      you: false,
    } as (typeof players)[number]);
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
      drawPlayerHoverTooltip(dims);
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

  // Sound + visual events + heartbeat (net mode). Use the smoothed view
  // world's "me" so sounds anchor to the same character the camera sees.
  const netMe = netViewWorld.playerCharacter() ?? null;
  detectSoundAndVisualEvents(netViewWorld, netMe);
  updateHeartbeatFor(netViewWorld, n.yourEntityId);

  renderer.clear("#1a2421");
  renderer.drawArena(netViewWorld, netCam);
  const netVis = visibilityFilter(netViewWorld, n.yourEntityId);
  renderer.drawEntities(netViewWorld, netCam, netVis);
  drawClientEffects(netCam);
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
// Floating profile card anchored to the row the user is hovering / has
// pinned. Shows points and any unlocked achievements; says "Not logged
// in" if the player has no server profile.
function drawPlayerHoverTooltip(dims: { w: number; h: number }): void {
  const hover = selectScreen.getHoveredPlayer();
  if (!hover) return;
  const lookup = publicProfileFor(hover.name);

  const padX = 14;
  const padY = 12;
  const lineH = 17;
  const titleH = 22;
  const profile = lookup === "loading" ? null : lookup?.profile ?? null;
  const status =
    lookup === "loading"
      ? "Loading…"
      : profile
        ? null
        : "Not logged in — points not tracked";
  const achievements = profile?.achievements ?? [];

  // Compute card width by measuring the widest line.
  ctx.save();
  ctx.font = "bold 14px system-ui, sans-serif";
  const nameWidth = ctx.measureText(hover.name).width;
  ctx.font = "13px system-ui, sans-serif";
  const lines: string[] = [];
  if (status) {
    lines.push(status);
  } else if (profile) {
    lines.push(profile.points === 1 ? "★ 1 point" : `★ ${profile.points} points`);
    if (achievements.length === 0) lines.push("No achievements yet");
    else for (const a of achievements) lines.push(`✓ ${a}`);
  }
  let maxW = nameWidth;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  const cardW = Math.min(280, Math.max(180, maxW + padX * 2));
  const cardH = titleH + padY + lines.length * lineH + padY;

  // Anchor to the right of the row, clamped to screen.
  let cx = hover.rect.x + hover.rect.w + 12;
  let cy = hover.rect.y;
  if (cx + cardW > dims.w - 12) cx = hover.rect.x - cardW - 12;
  if (cx < 12) cx = 12;
  if (cy + cardH > dims.h - 12) cy = dims.h - cardH - 12;
  if (cy < 12) cy = 12;

  // Card background.
  ctx.fillStyle = "rgba(20, 30, 28, 0.95)";
  ctx.beginPath();
  ctx.moveTo(cx + 8, cy);
  ctx.arcTo(cx + cardW, cy, cx + cardW, cy + 8, 8);
  ctx.lineTo(cx + cardW, cy + cardH - 8);
  ctx.arcTo(cx + cardW, cy + cardH, cx + cardW - 8, cy + cardH, 8);
  ctx.lineTo(cx + 8, cy + cardH);
  ctx.arcTo(cx, cy + cardH, cx, cy + cardH - 8, 8);
  ctx.lineTo(cx, cy + 8);
  ctx.arcTo(cx, cy, cx + 8, cy, 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 216, 74, 0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Title (name).
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(hover.name, cx + padX, cy + padY + 12);

  // Body lines.
  ctx.font = "13px system-ui, sans-serif";
  let ty = cy + padY + titleH + lineH - 4;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (i === 0 && profile) {
      ctx.fillStyle = "#ffd84a";
      ctx.font = "bold 13px system-ui, sans-serif";
    } else if (ln.startsWith("✓")) {
      ctx.fillStyle = "#48d0a0";
      ctx.font = "13px system-ui, sans-serif";
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.font = "13px system-ui, sans-serif";
    }
    ctx.fillText(ln, cx + padX, ty);
    ty += lineH;
  }
  ctx.restore();
}

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

// ---- DOM inputs (real keyboard on iPad) ----
// Live over the canvas; shown only on the title screen, only when the
// player isn't logged in.
const inputBaseStyle = [
  "position: fixed",
  "left: 50%",
  "transform: translateX(-50%)",
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

const nameInput = document.createElement("input");
nameInput.type = "text";
nameInput.maxLength = 24;
nameInput.placeholder = "Enter your name";
nameInput.setAttribute("autocomplete", "off");
nameInput.setAttribute("autocapitalize", "words");
nameInput.style.cssText = inputBaseStyle + "; width: 320px";
nameInput.value = getName();
nameInput.addEventListener("input", () => setName(nameInput.value));
nameInput.addEventListener("focus", () => { nameInput.style.borderColor = "#ffd84a"; });
nameInput.addEventListener("blur", () => { nameInput.style.borderColor = "rgba(255, 255, 255, 0.15)"; });
document.body.appendChild(nameInput);

const pinInput = document.createElement("input");
pinInput.type = "tel";
pinInput.maxLength = 8;
pinInput.placeholder = "PIN (3-8 digits)";
pinInput.setAttribute("inputmode", "numeric");
pinInput.setAttribute("pattern", "\\d*");
pinInput.setAttribute("autocomplete", "off");
pinInput.style.cssText = inputBaseStyle + "; width: 200px; text-align: center; letter-spacing: 4px";
pinInput.addEventListener("focus", () => { pinInput.style.borderColor = "#ffd84a"; });
pinInput.addEventListener("blur", () => { pinInput.style.borderColor = "rgba(255, 255, 255, 0.15)"; });
document.body.appendChild(pinInput);

function frameTitle(dims: { w: number; h: number }): void {
  if (titleSubScene === "profile") {
    frameProfile(dims);
    return;
  }

  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);

  // ---- Title + dramatic blurb ----
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.fillText("BRAMBLETOOTH", cw / 2, ch * 0.14);

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText(
    "Hunters vs Survivors in an asymmetric isometric arena.",
    cw / 2,
    ch * 0.14 + 28,
  );
  ctx.fillStyle = "rgba(208, 72, 72, 0.9)";
  ctx.font = "italic 13px system-ui, sans-serif";
  ctx.fillText(
    "Hunters strike from the shadows — invisible behind every obstacle.",
    cw / 2,
    ch * 0.14 + 50,
  );
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText("Sneak. Hunt. Survive.", cw / 2, ch * 0.14 + 70);

  // ---- Profile area: login form OR logged-in greeting ----
  const profileTop = ch * 0.3;
  if (loggedIn) {
    // Hide DOM inputs; render welcome + points + LOGOUT/PROFILE buttons.
    nameInput.style.display = "none";
    pinInput.style.display = "none";
    drawLoggedInProfilePanel(dims, profileTop);
  } else {
    drawLoginForm(dims, profileTop);
  }

  // ---- Mode buttons (three; FFA grayed) ----
  const bw = 320;
  const bh = 60;
  const gap = 14;
  const bx = cw / 2 - bw / 2;
  const by = ch * 0.58;
  const single: Rect = { x: bx, y: by, w: bw, h: bh };
  const two: Rect = { x: bx, y: by + bh + gap, w: bw, h: bh };
  const ffa: Rect = { x: bx, y: by + 2 * (bh + gap), w: bw, h: bh };
  titleButtons = { single, two, ffa };

  drawModeButton(single, "SINGLE PLAYER", "1 vs Computer", true, true);
  drawModeButton(two, "MULTIPLAYER", "1 vs Many (over your network)", true, true);
  drawModeButton(ffa, "FREE FOR ALL", "N vs N · with players + computers · COMING SOON", false, false);
}

function drawLoginForm(dims: { w: number; h: number }, top: number): void {
  const cw = dims.w;
  nameInput.style.display = "block";
  nameInput.style.top = `${top}px`;
  pinInput.style.display = "block";
  pinInput.style.top = `${top + 54}px`;

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("LOG IN to keep your points across devices", cw / 2, top - 10);

  // LOGIN button just below the PIN input.
  const bw = 200;
  const bh = 40;
  const bx = (cw - bw) / 2;
  const by = top + 54 + 54;
  titleLoginBtn = { x: bx, y: by, w: bw, h: bh };
  ctx.fillStyle = loginPending ? "rgba(255,216,74,0.5)" : "#ffd84a";
  roundRect(titleLoginBtn, 8);
  ctx.fill();
  ctx.fillStyle = "#1a2421";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(loginPending ? "LOGGING IN…" : "LOG IN", bx + bw / 2, by + bh / 2);
  ctx.textBaseline = "alphabetic";

  if (loginError) {
    ctx.fillStyle = "#d04848";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(loginError, cw / 2, by + bh + 18);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(
      "Or just pick a mode below to play without saving points.",
      cw / 2,
      by + bh + 18,
    );
  }

  // Old local-only points still visible (so the user sees what they have).
  const points = getPoints();
  if (points > 0) {
    ctx.fillStyle = "rgba(255,216,74,0.7)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(`Local points: ★ ${points}`, cw / 2, by + bh + 36);
  }

  // Clear other button refs.
  titleLogoutBtn = null;
  titleProfileBtn = null;
}

function drawLoggedInProfilePanel(dims: { w: number; h: number }, top: number): void {
  const cw = dims.w;
  const name = getName() || "Player";
  const points = getPoints();

  // Atmospheric label (was "LOGGED IN" / "Welcome back").
  ctx.fillStyle = "rgba(208, 72, 72, 0.75)";
  ctx.font = "italic bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("THE BRAMBLES REMEMBER", cw / 2, top - 4);

  // Player name (the dramatic identifier).
  ctx.fillStyle = "#fff";
  ctx.font = "bold 24px system-ui, sans-serif";
  ctx.fillText(name, cw / 2, top + 22);

  // Points — no decorative star anymore.
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 15px system-ui, sans-serif";
  ctx.fillText(
    points === 1 ? "1 point" : `${points} points`,
    cw / 2,
    top + 44,
  );

  // Recent achievements row — up to 3 most recent. Always reserves the
  // space so the panel layout doesn't jump when you earn one.
  const recent = getRecentAchievements(3);
  const iconSize = 36;
  const iconGap = 14;
  const recentY = top + 64;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.fillText("RECENT", cw / 2, recentY);
  if (recent.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "italic 11px system-ui, sans-serif";
    ctx.fillText("No achievements yet — play to earn them.", cw / 2, recentY + 26);
  } else {
    const rowW = recent.length * iconSize + (recent.length - 1) * iconGap;
    let rx = (cw - rowW) / 2;
    for (const earn of recent) {
      const def = ACHIEVEMENT_CATALOG[earn.id];
      if (!def) { rx += iconSize + iconGap; continue; }
      drawAchievementTile(ctx, rx, recentY + 6, iconSize, false);
      def.draw(ctx, rx, recentY + 6, iconSize, false);
      // Tiny name under the icon.
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(def.name, rx + iconSize / 2, recentY + iconSize + 18);
      rx += iconSize + iconGap;
    }
  }

  // Profile + Logout buttons side-by-side.
  const bw = 140;
  const bh = 36;
  const gap = 12;
  const groupW = 2 * bw + gap;
  const startX = (cw - groupW) / 2;
  const by = recentY + 78;
  titleProfileBtn = { x: startX, y: by, w: bw, h: bh };
  titleLogoutBtn = { x: startX + bw + gap, y: by, w: bw, h: bh };

  ctx.fillStyle = "rgba(40, 52, 48, 0.95)";
  roundRect(titleProfileBtn, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  roundRect(titleProfileBtn, 8);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText("PROFILE", titleProfileBtn.x + bw / 2, by + bh / 2);

  ctx.fillStyle = "rgba(40, 52, 48, 0.95)";
  roundRect(titleLogoutBtn, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  roundRect(titleLogoutBtn, 8);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("LOG OUT", titleLogoutBtn.x + bw / 2, by + bh / 2);
  ctx.textBaseline = "alphabetic";

  titleLoginBtn = null;
}

// ---- Profile sub-scene ----
function frameProfile(dims: { w: number; h: number }): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);
  nameInput.style.display = "none";
  pinInput.style.display = "none";

  // Header
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("PROFILE", cw / 2, ch * 0.1);

  const name = getName() || "Player";
  const points = getPoints();
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(name, cw / 2, ch * 0.1 + 26);
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText(
    points === 1 ? "1 point" : `${points} points`,
    cw / 2,
    ch * 0.1 + 50,
  );

  // Achievements panel — render the whole catalog with earned dates,
  // locked entries dimmed so the player sees what's left to chase.
  const earned = new Map<string, number>();
  for (const a of getEarnedAchievements()) earned.set(a.id, a.earnedAt);

  const rowH = 56;
  const panelW = Math.min(560, cw - 80);
  const panelX = (cw - panelW) / 2;
  const panelY = ch * 0.22;
  const panelH = ACHIEVEMENT_ORDER.length * rowH + 50;

  ctx.fillStyle = "rgba(20, 30, 28, 0.85)";
  roundRect({ x: panelX, y: panelY, w: panelW, h: panelH }, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  roundRect({ x: panelX, y: panelY, w: panelW, h: panelH }, 12);
  ctx.stroke();

  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(
    `ACHIEVEMENTS  ${earned.size} / ${ACHIEVEMENT_ORDER.length}`,
    panelX + 16,
    panelY + 22,
  );

  const iconSize = 38;
  let ry = panelY + 38;
  for (const id of ACHIEVEMENT_ORDER) {
    const def = ACHIEVEMENT_CATALOG[id];
    if (!def) continue;
    const earnedAt = earned.get(id);
    const locked = earnedAt === undefined;
    const ix = panelX + 16;
    const iy = ry + 6;
    drawAchievementTile(ctx, ix, iy, iconSize, locked);
    def.draw(ctx, ix, iy, iconSize, locked);
    // Title
    ctx.fillStyle = locked ? "rgba(255,255,255,0.4)" : "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(def.name, ix + iconSize + 14, ry + 18);
    // Description
    ctx.fillStyle = locked ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.62)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(def.description, ix + iconSize + 14, ry + 34);
    // Right-aligned status
    ctx.textAlign = "right";
    if (locked) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "italic 11px system-ui, sans-serif";
      ctx.fillText("Locked", panelX + panelW - 16, ry + 26);
    } else {
      ctx.fillStyle = "#48d0a0";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.fillText("Earned ✓", panelX + panelW - 16, ry + 18);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(
        formatEarnedDate(earnedAt ?? 0).replace(/^Earned\s*/, ""),
        panelX + panelW - 16,
        ry + 34,
      );
    }
    ry += rowH;
  }

  // BACK button below the panel.
  const bw = 160;
  const bh = 40;
  const bx = (cw - bw) / 2;
  const by = panelY + panelH + 20;
  titleProfileBackBtn = { x: bx, y: by, w: bw, h: bh };
  ctx.fillStyle = "rgba(40, 52, 48, 0.95)";
  roundRect(titleProfileBackBtn, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  roundRect(titleProfileBackBtn, 8);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("← BACK", bx + bw / 2, by + bh / 2);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
}

// Mode button: bigger, two-line (title + subtitle), with an enabled/disabled
// look. Disabled is rendered dim and non-interactive.
function drawModeButton(
  r: Rect,
  title: string,
  subtitle: string,
  primary: boolean,
  enabled: boolean,
): void {
  const fill = enabled
    ? primary
      ? "#ffd84a"
      : "rgba(40,52,48,0.9)"
    : "rgba(40,52,48,0.5)";
  const titleColor = enabled ? (primary ? "#1a2421" : "#fff") : "rgba(255,255,255,0.35)";
  const subColor = enabled
    ? primary
      ? "rgba(26,36,33,0.7)"
      : "rgba(255,255,255,0.55)"
    : "rgba(255,255,255,0.25)";

  ctx.fillStyle = fill;
  roundRect(r, 12);
  ctx.fill();
  if (!enabled) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    roundRect(r, 12);
    ctx.stroke();
  }

  ctx.fillStyle = titleColor;
  ctx.font = "bold 19px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, r.x + r.w / 2, r.y + r.h / 2 - 2);

  ctx.fillStyle = subColor;
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(subtitle, r.x + r.w / 2, r.y + r.h / 2 + 16);
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

// ---- Sound event detection (cooldown transitions, position jumps, picks) ----
// Each frame we diff the current snapshot against last frame's per-entity
// state. Newly-set cooldowns mean an ability just fired; large Magnek pos
// jumps are Magnesis teleports (visual trail + Doppler-aware sound);
// objective transitions trigger a chime.

interface PrevCharSnap {
  pos: { x: number; y: number };
  cooldowns: Record<string, number>;
  characterId: string;
  team: "hunter" | "survivor";
}
const prevCharSnap = new Map<number, PrevCharSnap>();
const prevObjectivePicked = new Set<number>();

function abilitySoundFor(abilityId: string): SoundId | null {
  switch (abilityId) {
    case "place_plate": return "place_plate";
    case "overdrive": return "overdrive";
    case "glitch": return "glitch";
    case "slash": return "slash";
    case "slime_shot": return "slime_shot";
    case "slime_trap": return "slime_trap";
    case "relocate": return "relocate";
    // magnesis is channeled — the cooldown sets at cast START, not at
    // teleport. We trigger its sound off the position-jump detection
    // below so it plays exactly when Magnek vanishes.
    default: return null;
  }
}

// Client-side visual effects (non-authoritative — purely cosmetic). The
// magnesis trail is the only one for now.
interface ClientEffect {
  kind: "magnesis_trail";
  from: { x: number; y: number };
  to: { x: number; y: number };
  ttl: number;
  age: number;
}
const clientEffects: ClientEffect[] = [];

function updateClientEffects(dt: number): void {
  for (let i = clientEffects.length - 1; i >= 0; i--) {
    clientEffects[i].age += dt;
    if (clientEffects[i].age >= clientEffects[i].ttl) clientEffects.splice(i, 1);
  }
}

function drawClientEffects(cam: { target: { x: number; y: number }; zoom: number }): void {
  for (const e of clientEffects) {
    if (e.kind === "magnesis_trail") {
      const t = 1 - e.age / e.ttl;
      const a = worldToScreen(e.from, cam, renderer.cw, renderer.ch);
      const b = worldToScreen(e.to, cam, renderer.cw, renderer.ch);
      ctx.save();
      ctx.strokeStyle = `rgba(160, 200, 255, ${0.85 * t})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

function detectSoundAndVisualEvents(world: World, viewer: CharacterEntity | null): void {
  const vp = viewer?.pos ?? null;
  const dist = (p: { x: number; y: number }): number =>
    vp ? Math.hypot(p.x - vp.x, p.y - vp.y) : 0;

  const seenIds = new Set<number>();
  for (const e of world.entities) {
    if (e.kind === "character") {
      seenIds.add(e.id);
      const prev = prevCharSnap.get(e.id);
      if (prev) {
        // Cooldown 0 -> >0 means the ability fired this frame.
        for (const ab of Object.keys(e.cooldowns)) {
          const before = prev.cooldowns[ab] ?? 0;
          const after = e.cooldowns[ab] ?? 0;
          if (before <= 0 && after > 0) {
            const sId = abilitySoundFor(ab);
            if (sId) playSound(sId, { distance: dist(e.pos) });
          }
        }
        // Large position delta on Magnek = Magnesis teleport completed.
        const dx = e.pos.x - prev.pos.x;
        const dy = e.pos.y - prev.pos.y;
        const moved = Math.hypot(dx, dy);
        if (moved > 100 && e.characterId === "magnek") {
          clientEffects.push({
            kind: "magnesis_trail",
            from: { x: prev.pos.x, y: prev.pos.y },
            to: { x: e.pos.x, y: e.pos.y },
            ttl: 1.2,
            age: 0,
          });
          let dop = 0;
          if (vp) {
            const before = Math.hypot(prev.pos.x - vp.x, prev.pos.y - vp.y);
            const after = Math.hypot(e.pos.x - vp.x, e.pos.y - vp.y);
            dop = before > after ? 1 : -1; // approaching vs receding
          }
          playSound("magnesis", { distance: dist(e.pos), doppler: dop });
        }
      }
      prevCharSnap.set(e.id, {
        pos: { x: e.pos.x, y: e.pos.y },
        cooldowns: { ...e.cooldowns },
        characterId: e.characterId,
        team: e.team,
      });
    } else if (e.kind === "objective") {
      if (e.collected && !prevObjectivePicked.has(e.id)) {
        prevObjectivePicked.add(e.id);
        playSound("objective_pickup", { distance: dist(e.pos) });
      }
    }
  }
  for (const id of prevCharSnap.keys()) if (!seenIds.has(id)) prevCharSnap.delete(id);
}

function updateHeartbeatFor(world: World, viewerEntityId: number | null): void {
  if (viewerEntityId == null) { setHeartbeat(null); return; }
  let me: CharacterEntity | null = null;
  for (const e of world.entities) {
    if (e.kind === "character" && e.id === viewerEntityId) { me = e; break; }
  }
  if (!me || me.team !== "survivor") { setHeartbeat(null); return; }
  let nearest = Infinity;
  for (const e of world.entities) {
    if (e.kind === "character" && e.team === "hunter") {
      const d = Math.hypot(e.pos.x - me.pos.x, e.pos.y - me.pos.y);
      if (d < nearest) nearest = d;
    }
  }
  setHeartbeat(nearest === Infinity ? null : nearest);
}

// ---- Achievement banner + earn logic ----
const ACHIEVEMENTS_KEY = "brambletooth.achievements";

interface EarnedAchievement {
  id: string;
  earnedAt: number; // unix ms; 0 = legacy / unknown
}

function getEarnedAchievements(): EarnedAchievement[] {
  try {
    const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: EarnedAchievement[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item === "string") {
        // Legacy format from before timestamps existed.
        if (seen.has(item)) continue;
        seen.add(item);
        out.push({ id: item, earnedAt: 0 });
      } else if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        const obj = item as { id: string; earnedAt?: number };
        if (seen.has(obj.id)) continue;
        seen.add(obj.id);
        out.push({ id: obj.id, earnedAt: Number(obj.earnedAt) || 0 });
      }
    }
    return out;
  } catch { return []; }
}

function saveEarnedAchievements(list: EarnedAchievement[]): void {
  try { localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(list)); }
  catch { /* ignore */ }
}

function isAchievementEarned(id: string): boolean {
  return getEarnedAchievements().some((a) => a.id === id);
}

// Sorted by earnedAt descending — most recent first.
function getRecentAchievements(limit: number): EarnedAchievement[] {
  return [...getEarnedAchievements()]
    .sort((a, b) => b.earnedAt - a.earnedAt)
    .slice(0, limit);
}

interface ActiveBanner { text: string; bornAt: number; }
let activeBanner: ActiveBanner | null = null;
let lastNoticeIdSeen = 0;

function fireAchievementBanner(text: string): void {
  activeBanner = { text, bornAt: performance.now() };
  playSound("achievement");
}

function earnAchievement(id: string): void {
  const def = ACHIEVEMENT_CATALOG[id];
  if (!def) return;
  const earned = getEarnedAchievements();
  if (earned.some((a) => a.id === id)) return;
  earned.push({ id, earnedAt: Date.now() });
  saveEarnedAchievements(earned);
  scheduleProfileSync();
  const who = getName() || "Player";
  const text = `${who} earned ${def.name}!`;
  if (appMode === "net" && net) {
    // Server fans out to everyone — we'll render the banner when the
    // notice round-trips back via net.notices.
    net.sendAchievement(text);
  } else {
    fireAchievementBanner(text);
  }
}

// Watches net.notices for new kind="achievement" entries and fires the
// banner exactly once per notice.
function checkAchievementNotices(): void {
  if (!net) return;
  for (const n of net.notices) {
    if (n.id > lastNoticeIdSeen) {
      lastNoticeIdSeen = n.id;
      if (n.kind === "achievement") fireAchievementBanner(n.text);
    }
  }
}

function drawAchievementBanner(dims: { w: number; h: number }): void {
  if (!activeBanner) return;
  const age = performance.now() - activeBanner.bornAt;
  if (age > 3500) { activeBanner = null; return; }
  const alpha = age < 250 ? age / 250 : age > 3000 ? (3500 - age) / 500 : 1;
  const pulse = 0.85 + 0.15 * Math.sin(age / 90);
  const cw = dims.w;
  const ch = dims.h;
  const bw = Math.min(640, cw - 80);
  const bh = 96;
  const bx = (cw - bw) / 2;
  const by = ch * 0.28;
  ctx.save();
  ctx.fillStyle = `rgba(20, 30, 28, ${0.92 * alpha})`;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = `rgba(255, 216, 74, ${alpha * pulse})`;
  ctx.lineWidth = 3;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(255, 216, 74, ${alpha * pulse})`;
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.fillText("★ ACHIEVEMENT UNLOCKED ★", cw / 2, by + 28);
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.font = "bold 22px system-ui, sans-serif";
  ctx.fillText(activeBanner.text, cw / 2, by + 64);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
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
  // Lowest hp/maxHp ratio observed for "me" this round — used to detect
  // Untouchable (never dropped below half HP and survived to round end).
  lowestHpRatio: number;
}
function newAwardState(): RoundAwardState {
  return {
    prevSurvivorIds: new Set(),
    collectedIds: new Set(),
    endAwarded: false,
    lastSeenTeam: null,
    lowestHpRatio: 1,
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
    state.lowestHpRatio = 1;
  }

  // Find / refresh my own entity + team.
  let me: { team: "hunter" | "survivor"; hp: number; maxHp: number } | null = null;
  for (const e of world.entities) {
    if (e.kind === "character" && e.id === viewerEntityId) {
      me = e;
      state.lastSeenTeam = e.team;
      const ratio = e.hp / e.maxHp;
      if (ratio < state.lowestHpRatio) state.lowestHpRatio = ratio;
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
      if (!currentSurvivorIds.has(id)) {
        addPoints(POINTS_CATCH);
        // First Blood: any successful catch unlocks it (one-time).
        earnAchievement("first_blood");
      }
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
        // Collector: collect 5 in a single round.
        if (state.collectedIds.size >= 5) earnAchievement("collector");
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
      // Untouchable: survivor finished alive AND never dropped below half
      // HP during the round.
      if (state.lowestHpRatio >= 0.5) earnAchievement("untouchable");
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

// Attempt silent login from stored credentials before the first render.
void autoLoginIfPossible();

// --- Loop ---
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Hide DOM inputs whenever we're not on the main title sub-scene. The
  // frame draws re-show them when needed.
  const inputsShouldHide = started || titleSubScene !== "main" || loggedIn;
  if (inputsShouldHide) {
    if (nameInput.style.display !== "none") {
      nameInput.style.display = "none";
      if (document.activeElement === nameInput) nameInput.blur();
    }
    if (pinInput.style.display !== "none") {
      pinInput.style.display = "none";
      if (document.activeElement === pinInput) pinInput.blur();
    }
  }
  const dims = logicalSize();

  updateClientEffects(dt);
  // Stop the heartbeat whenever we're not actively rendering a round —
  // the in-frame draws below will turn it back on with the right BPM.
  const inGameplay =
    started &&
    ((appMode === "local" && scene === "playing" && !!play) ||
      (appMode === "net" &&
        (net?.phase === "playing" || net?.phase === "ended")));
  if (!inGameplay) setHeartbeat(null);

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

  // Achievement banner system: poll net notices for incoming achievement
  // broadcasts, then draw the banner.
  checkAchievementNotices();
  drawAchievementBanner(dims);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
