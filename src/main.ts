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
import { createInput, bindInput, pollGamepad, setOnGamepadConnect } from "./core/input";
import { Engine, CORE_FRAC, WALL_BRUSH_BAND } from "./core/engine";
import type { BrushKind } from "./core/engine";
import { Renderer, createCamera, screenToWorld } from "./render/renderer";
import type { Entity, CharacterEntity } from "./core/entity";
import { isProp } from "./core/entity";
import { distToSegment } from "./core/math";
import { playSound, unlockAudio, setHeartbeat, setAudioPrefs } from "./audio/sound";
import type { SoundId, AudioPrefs } from "./audio/sound";
import { worldToScreen } from "./render/renderer";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_ORDER,
  drawAchievementTile,
  formatEarnedDate,
} from "./achievements/catalog";
import {
  SHOP_CATALOG,
  drawShopItemIcon,
  shopItemsByKind,
  shopKindLabel,
} from "./shop/catalog";
import type { ShopItem, ShopItemKind } from "./shop/catalog";
import {
  WORLDS,
  WORLDS_REQUIRED_MAPS,
  getMap,
  getWorld,
  defaultMapId,
  isWorldUnlocked,
  isMapUnlockedCampaign,
  isMapPlayableVsComputer,
} from "./maps/registry";
import type { MapDef, ProfileProgress, WorldDef } from "./maps/registry";
import type { Camera } from "./render/renderer";
import { HuntMode } from "./modes/hunt";
import { FFAMode, FFA_MAX_PLAYERS } from "./modes/ffa";
import {
  AI_DIFFICULTIES,
  AI_DIFFICULTY_STAT_MULTS,
  aiDifficultyLabel,
  applyDifficultyMult,
  applyLevelToCharacter,
  jitteredAiLevel,
  levelFromXp,
  xpForLevel,
  LEVEL_HP_PER_LEVEL,
  LEVEL_SPEED_PER_LEVEL,
  LEVEL_DAMAGE_PER_LEVEL,
  XP_ROUND_COMPLETE,
  XP_WIN_BONUS,
  XP_KILL,
  XP_OBJECTIVE,
} from "./core/leveling";
import type { AiDifficulty } from "./core/leveling";
import { FOREST_ARENA_CONFIG, buildForest } from "./arenas/forest";
import { createAIController } from "./ai/ai";
import { HumanController } from "./core/humanController";
import { drawHUD, survivorListHeight, SURVIVOR_LIST_TOP } from "./ui/hud";
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
const TIME_LIMIT_SECONDS = 3 * 60 + 30;
// First survivor to collect this many objectives wins for survivors.
// Objectives spawn one at a time and respawn on collect.
const OBJECTIVES_REQUIRED = 5;
const AI_HUNTERS_ALL = ["slagy", "gravemarch"];
const AI_SURVIVORS = ["match", "magnek", "necro"];
// AI hunter pool the engine actually rolls from. Filtered by
// ownership so a player who hasn't bought Gravemarch doesn't see
// him as the AI opponent in Vs Computer — that would spoil the
// purchase reveal.
function aiHunters(): string[] {
  return AI_HUNTERS_ALL.filter(isCharacterUnlocked);
}

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
  if (mode === "net" && !net) {
    net = new NetClient(resolveServerUrl(), getName());
    // Push our completed-maps list so the server can compute the
    // multiplayer map-vote intersection. Resent automatically on
    // reconnect (NetClient stashes it).
    net.sendCompletedMaps(getCompletedMaps());
  }
}

// ---- Persistent profile (localStorage; synced to server when logged in) ----
const NAME_KEY = "brambletooth.name";
const POINTS_KEY = "brambletooth.points";
const PIN_KEY = "brambletooth.pin";
const LOGGEDIN_KEY = "brambletooth.loggedIn";
const AUDIO_SETTINGS_KEY = "brambletooth.audio";

// ==== Invincible Mode (special test login) ====
// Logging in as this profile grants the local human invincible
// status: no damage taken + 1.5× ability cooldown rate. Currently
// applied in single-player only (startRound flips the player's
// character.invincible flag after mode.initialize). Hardcoded for
// now per design; remove this block to disable the feature.
const INVINCIBLE_NAME = "Bigfoot";
const INVINCIBLE_PIN = "1234";
function isInvincibleProfile(name: string, pin: string): boolean {
  return name === INVINCIBLE_NAME && pin === INVINCIBLE_PIN;
}

// ---- Audio prefs (settings page) ----
// Module-level so the UI handlers can mutate + persist + push to the
// audio module. Loaded on startup; default = everything on at full
// volume. Saved to localStorage on every change.
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
function defaultAudioSettings(): AudioPrefs {
  return {
    heartbeat: { enabled: true, volume: 1.0 },
    footsteps: { enabled: true, volume: 1.0 },
  };
}
function loadAudioSettings(): AudioPrefs {
  try {
    const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (!raw) return defaultAudioSettings();
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      heartbeat: {
        enabled: parsed?.heartbeat?.enabled ?? true,
        volume: clamp01(parsed?.heartbeat?.volume ?? 1.0),
      },
      footsteps: {
        enabled: parsed?.footsteps?.enabled ?? true,
        volume: clamp01(parsed?.footsteps?.volume ?? 1.0),
      },
    };
  } catch { return defaultAudioSettings(); }
}
function persistAudioSettings(): void {
  try { localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(audioSettings)); }
  catch { /* ignore */ }
  setAudioPrefs(audioSettings); // propagate immediately
}
const audioSettings: AudioPrefs = loadAudioSettings();
setAudioPrefs(audioSettings); // push to audio module on startup

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
  // Mirrors resolveServerUrl()'s three modes:
  //   1. ?server=... override → use that host:port for HTTP too.
  //   2. Behind the public reverse-proxy gateway (no explicit port
  //      in the URL) → use the proxy-relative base so /api/login
  //      becomes /brambletooth/api/login.
  //   3. Dev mode (explicit non-default port like :5173) → hit the
  //      WS server's port (8787) on the same host directly.
  // Scheme tracks the page so HTTPS pages don't fall into a
  // mixed-content trap. Hostname is read from `location` at
  // runtime — never hardcoded — so the build is host-agnostic.
  const params = new URLSearchParams(location.search);
  const override = params.get("server");
  if (override) {
    // override could be "host:port" or a full ws:// URL.
    const trimmed = override.replace(/^wss?:\/\//, "");
    return `http://${trimmed}`;
  }
  const httpScheme = location.protocol === "https:" ? "https" : "http";
  const port = location.port;
  const isProxied = port === "" || port === "80" || port === "443";
  if (isProxied) {
    return `${httpScheme}://${location.host}/brambletooth`;
  }
  return `${httpScheme}://${location.hostname}:8787`;
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
    inventory?: (string | { id: string; purchasedAt?: number })[];
    completedMaps?: string[];
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
    if (Array.isArray(body.profile.inventory)) {
      saveInventory(
        body.profile.inventory.map((p) =>
          typeof p === "string"
            ? { id: p, purchasedAt: 0 }
            : { id: p.id, purchasedAt: Number(p.purchasedAt) || 0 },
        ),
      );
    }
    if (Array.isArray(body.profile.completedMaps)) {
      saveCompletedMaps(body.profile.completedMaps);
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
          inventory: getInventory(),
          completedMaps: getCompletedMaps(),
        }),
      });
      const body = (await r.json()) as ProfileResponse;
      if (body.ok && body.profile) {
        // Echo back the server's normalized value (clamped to >= 0).
        // The client is the authoritative source for its own total;
        // cross-device sync happens at login, not on every sync.
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
        // Inventory — same union-by-id discipline.
        if (Array.isArray(body.profile.inventory)) {
          saveInventory(
            body.profile.inventory.map((p) =>
              typeof p === "string"
                ? { id: p, purchasedAt: 0 }
                : { id: p.id, purchasedAt: Number(p.purchasedAt) || 0 },
            ),
          );
        }
        // CompletedMaps — server already unions; just take what it sends.
        if (Array.isArray(body.profile.completedMaps)) {
          saveCompletedMaps(body.profile.completedMaps);
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
// Toast on first gamepad connect so the player knows the
// controller registered. Re-uses the achievement banner since
// it's already a top-screen "something just happened" cue.
setOnGamepadConnect((pad) => {
  // pad.id is a long manufacturer-prefixed string; trim to
  // something readable for the banner.
  const shortId = pad.id.split("(")[0]!.trim() || "Controller";
  fireAchievementBanner(`CONTROLLER CONNECTED · ${shortId}`);
});
const renderer = new Renderer(ctx, canvas);
renderer.setDimensionSource(() => logicalSize());

// --- Local scene state ---
type Scene = "select" | "playing";
let scene: Scene = "select";
interface PlayState {
  world: World;
  // GameMode is the common interface that HuntMode and FFAMode both
  // implement. Widening from the concrete HuntMode lets startFFARound
  // populate this without a cast and keeps the same handlers in the
  // playing scene happy.
  mode: import("./modes/mode").GameMode;
  engine: Engine;
  controllers: Map<number, Controller>;
  cam: Camera;
  chosenCharacterId: string;
  // Which map this round is being played on. Used to mark completion
  // when a campaign run wins, and to title the HUD's map name.
  mapId: string;
  // True when this round is part of campaign flow — winning will mark
  // the map completed AND advance progression. False for Vs Computer
  // (no progression effect; still playable).
  isCampaign: boolean;
  // Pre-round countdown (seconds remaining). > 0 = freeze the world,
  // show a big "3 / 2 / 1" overlay; engine doesn't tick yet so the
  // player has a beat to see the spawn before being thrown in.
  // null/undefined = countdown already finished (engine ticking).
  countdown: number | null;
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
// Wire shop-locked characters out of the select screen. Bigfoot
// god-mode also unlocks everything for testing.
selectScreen.isCharacterAllowed = isCharacterUnlocked;
selectScreen.getCharacterLevel = (id) => getCharacterLevel(id);
selectScreen.bind(canvas, logicalSize, {
  onStart: (chosenId) => {
    if (appMode === "net" && net) {
      // READY toggle: ready up with the current pick, or cancel if ready.
      const me = net.lobby.find((p) => p.slot === net!.slot);
      if (me?.ready) {
        net.ready(false);
      } else {
        net.select(chosenId, hasSprintBoots(), getCharacterLevel(chosenId));
        net.ready(true);
      }
    } else if (appMode === "local") {
      if (pendingFFA) {
        startFFARound(chosenId);
      } else {
        startRound(chosenId, pendingMapId, pendingIsCampaign);
      }
    }
  },
  onSelect: (id) => {
    // Live pick broadcast so the opponent sees it immediately.
    if (appMode === "net" && net && net.phase === "lobby") net.select(id, hasSprintBoots(), getCharacterLevel(id));
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
  hasSprint: () => hasSprintBoots(),
});

// --- Title screen + back-button input ---
// Title hit zones (only when !started). Back-button hit zone (only when
// started) is stored separately and computed each draw from logical size.
let titleButtons: { campaign: Rect; vs: Rect; two: Rect; shop: Rect; ffa: Rect } | null = null;
let titleLoginBtn: Rect | null = null;
let titleLogoutBtn: Rect | null = null;
let titleProfileBtn: Rect | null = null;
let titleProfileBackBtn: Rect | null = null;
let titleProfileSettingsBtn: Rect | null = null;
type TitleSubScene = "main" | "profile" | "shop" | "settings" | "campaign" | "vsMapSelect";
let titleSubScene: TitleSubScene = "main";

// ---- Shared top bar ----
// Drawn on every non-playing page. Top-LEFT: a single Back button
// whose action is computed from the current scene (back to title
// main from any subscene; leave server from net lobby; etc.).
// Top-RIGHT: small Profile / Settings / Logout pills (Profile + Logout
// only shown when logged in). The hit rects are rebuilt each draw
// because the top-right cluster anchors off the right edge.
let topBarBackBtn: Rect | null = null;
let topBarProfileBtn: Rect | null = null;
let topBarSettingsBtn: Rect | null = null;
let topBarLogoutBtn: Rect | null = null;

// Map select hit zones (campaign + vs-computer). Rebuilt each draw.
let mapSelectBackBtn: Rect | null = null;
let mapTileBtns: { mapId: string; rect: Rect; playable: boolean }[] = [];
// Vertical scroll offset for the campaign / vs-computer map list.
// Touch-dragged on mobile, wheel-scrolled on desktop. Clamped each
// draw against the world-list content height so it never scrolls
// past the last world. Reset to 0 when the scene re-opens.
let mapSelectScrollY = 0;
let mapSelectScrollMax = 0;     // computed each draw — content overflow
// AI difficulty selector pill rects on the character-select screen
// (vs-computer / campaign flows). Rebuilt each draw; click routed
// in handleTitleTap below.
let difficultyPillBtns: { d: AiDifficulty; rect: Rect }[] = [];
// Viewport edges for the scrollable list — recomputed each draw,
// read at hit-test time so tiles drawn outside the clip don't
// register taps even when their hit rect happens to overlap the
// header or bottom margin in screen space.
let mapSelectListTop = 0;
let mapSelectListBottom = 0;
// Touch-drag scrolling state. capturedY is the screen y at touchstart;
// scrolledPx accumulates the absolute scroll distance since touchstart.
// On touchend, if scrolledPx exceeds DRAG_THRESHOLD, the tap handler
// is suppressed so a flick doesn't accidentally launch a map.
const MAP_SCROLL_DRAG_THRESHOLD = 8;
let mapSelectTouchY: number | null = null;
let mapSelectTouchScrolled = 0;
// Last map a campaign/vs-computer flow committed to, threaded through
// character select to startRound. Defaults to the first map id so the
// title's quick play paths still work.
let pendingMapId: string = defaultMapId();
let pendingIsCampaign: boolean = false;
// True when the title screen routed via the FFA button. The select
// screen's onStart consults this; when set, we route to
// startFFARound(chosenId) instead of the standard HuntMode
// startRound. Reset to false at the end of every round + on title
// back-out so it can't leak between flows.
let pendingFFA: boolean = false;

// Settings sub-scene hit zones (re-built each draw).
let settingsBackBtn: Rect | null = null;
let settingsHeartbeatToggleBtn: Rect | null = null;
let settingsHeartbeatVolBar: Rect | null = null;
let settingsFootstepsToggleBtn: Rect | null = null;
let settingsFootstepsVolBar: Rect | null = null;

// Shop sub-scene hit zones (re-built each draw).
let shopBackBtn: Rect | null = null;
let shopTabBtns: { kind: ShopItemKind; rect: Rect }[] = [];
let shopBuyBtns: { id: string; rect: Rect }[] = [];
let shopActiveTab: ShopItemKind = "character";

function handleTitleTap(p: { x: number; y: number }): void {
  // Audio gesture unlock on any title tap — works even before chooseMode.
  unlockAudio();

  // Profile sub-scene: every navigational button (SETTINGS, BACK,
  // LOG OUT) lives on the shared top bar now; this branch only
  // exists for completeness in case future profile-page content
  // adds its own widgets.
  if (titleSubScene === "profile") {
    return;
  }
  // Campaign / Vs Computer map-select sub-scenes: per-tile
  // selection. BACK is on the top bar.
  if (titleSubScene === "campaign" || titleSubScene === "vsMapSelect") {
    // Reject taps that fell outside the scrollable list viewport —
    // a tile drawn off the top or bottom of the clip can still
    // have a stored hit rect at the corresponding screen Y, which
    // would otherwise misfire on header taps.
    if (p.y < mapSelectListTop || p.y > mapSelectListBottom) return;
    for (const tile of mapTileBtns) {
      if (!inRect(p, tile.rect)) continue;
      if (!tile.playable) {
        playSound("ui_denied");
        return;
      }
      playSound("ui_click");
      pendingMapId = tile.mapId;
      pendingIsCampaign = titleSubScene === "campaign";
      // Drop into the standard single-player flow: character select
      // (we re-use the SelectScreen). chooseMode("local") flips the
      // engine into local mode and the existing select-screen hand-off
      // routes onStart → startRound(chosenId, pendingMapId).
      chooseMode("local");
      return;
    }
    return;
  }
  // Settings sub-scene: per-sound toggles + volume bars. BACK and
  // navigation now live on the shared top bar.
  if (titleSubScene === "settings") {
    if (settingsHeartbeatToggleBtn && inRect(p, settingsHeartbeatToggleBtn)) {
      audioSettings.heartbeat.enabled = !audioSettings.heartbeat.enabled;
      persistAudioSettings();
      playSound("ui_click");
      return;
    }
    if (settingsFootstepsToggleBtn && inRect(p, settingsFootstepsToggleBtn)) {
      audioSettings.footsteps.enabled = !audioSettings.footsteps.enabled;
      persistAudioSettings();
      playSound("ui_click");
      // Preview so the user hears the change immediately on enable.
      if (audioSettings.footsteps.enabled) playSound("footsteps");
      return;
    }
    if (settingsHeartbeatVolBar && inRect(p, settingsHeartbeatVolBar)) {
      audioSettings.heartbeat.volume = clamp01(
        (p.x - settingsHeartbeatVolBar.x) / settingsHeartbeatVolBar.w,
      );
      persistAudioSettings();
      playSound("ui_pick");
      return;
    }
    if (settingsFootstepsVolBar && inRect(p, settingsFootstepsVolBar)) {
      audioSettings.footsteps.volume = clamp01(
        (p.x - settingsFootstepsVolBar.x) / settingsFootstepsVolBar.w,
      );
      persistAudioSettings();
      // Preview at the new volume.
      playSound("footsteps");
      return;
    }
    return;
  }
  // Shop sub-scene: tab buttons + per-item BUY buttons. BACK is
  // on the shared top bar.
  if (titleSubScene === "shop") {
    for (const tab of shopTabBtns) {
      if (inRect(p, tab.rect)) {
        if (shopActiveTab !== tab.kind) {
          playSound("ui_pick");
          shopActiveTab = tab.kind;
        }
        return;
      }
    }
    for (const buy of shopBuyBtns) {
      if (inRect(p, buy.rect)) {
        const result = purchaseItem(buy.id);
        if (result === "ok") {
          // purchaseItem already plays the achievement chime + banner.
        } else if (result === "owned") {
          playSound("ui_denied");
        } else if (result === "not_logged_in") {
          playSound("ui_denied");
        } else if (result === "broke") {
          playSound("ui_denied");
        }
        return;
      }
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
  if (inRect(p, titleButtons.campaign)) {
    playSound("ui_click");
    titleSubScene = "campaign";
    mapSelectScrollY = 0;
  } else if (inRect(p, titleButtons.vs)) {
    playSound("ui_click");
    titleSubScene = "vsMapSelect";
    mapSelectScrollY = 0;
  } else if (inRect(p, titleButtons.two)) {
    playSound("ui_click");
    chooseMode("net");
  } else if (inRect(p, titleButtons.shop)) {
    playSound("ui_click");
    titleSubScene = "shop";
  } else if (inRect(p, titleButtons.ffa)) {
    playSound("ui_click");
    // FFA jumps straight to character select with the FFA flag on.
    // The select screen's onStart routes to startFFARound instead
    // of startRound when this flag is set.
    pendingFFA = true;
    chooseMode("local");
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

// Single source of truth for every top-bar click. Returns true
// when the click was absorbed so the caller can short-circuit
// page-specific click handling.
function handleTopBarTap(p: { x: number; y: number }): boolean {
  // Back — context-aware destination.
  if (topBarBackBtn && inRect(p, topBarBackBtn)) {
    playSound("ui_back");
    if (!started) {
      // Inside a title subscene — back to title main.
      titleSubScene = "main";
    } else {
      // In gameplay scenes (select / lobby / etc) — full retreat
      // to title. Disconnects net if active.
      goToTitle();
    }
    return true;
  }
  // Profile / Settings / Logout. These short-circuit any scene-
  // local clicks so the icons behave identically everywhere.
  if (topBarProfileBtn && inRect(p, topBarProfileBtn)) {
    playSound("ui_click");
    // If we're mid-game-flow (select / lobby / etc), bail back to
    // title before entering the profile subscene so the user can
    // see the page from a clean state.
    if (started) goToTitle();
    titleSubScene = "profile";
    return true;
  }
  if (topBarSettingsBtn && inRect(p, topBarSettingsBtn)) {
    playSound("ui_click");
    if (started) goToTitle();
    titleSubScene = "settings";
    return true;
  }
  if (topBarLogoutBtn && inRect(p, topBarLogoutBtn)) {
    playSound("ui_back");
    tryLogout();
    // After logout, bring the user to the title main page (the
    // logged-out login form). If they were deep in a flow, this
    // is a clean exit.
    if (started) goToTitle();
    titleSubScene = "main";
    return true;
  }
  return false;
}

// Tap a map vote tile (multiplayer voting phase). Sends the vote to
// the server; the live tally re-renders from the next state message.
function handleMapVoteTap(p: { x: number; y: number }): boolean {
  if (!net || net.phase !== "voting") return false;
  for (const tile of mapVoteTiles) {
    if (!inRect(p, tile.rect)) continue;
    playSound("ui_click");
    net.voteMap(tile.mapId);
    return true;
  }
  return false;
}

// Difficulty-pill click handler — runs in the LOCAL select scene.
// Returns true when the click was absorbed so the caller can avoid
// further handling. Sibling listeners (the SelectScreen's own
// mousedown) still fire; SelectScreen ignores y-coordinates below
// the card grid so this doesn't collide.
function handleDifficultyTap(p: { x: number; y: number }): boolean {
  if (!started) return false;
  if (appMode !== "local" || scene !== "select") return false;
  if (pendingFFA) return false;
  for (const pill of difficultyPillBtns) {
    if (!inRect(p, pill.rect)) continue;
    if (pill.d === getAiDifficulty()) return true;
    playSound("ui_click");
    setAiDifficulty(pill.d);
    return true;
  }
  return false;
}

canvas.addEventListener("mousedown", (ev) => {
  const r = canvas.getBoundingClientRect();
  const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  // Top bar wins everywhere it's drawn — every non-playing page —
  // so the Back / Profile / Settings / Logout buttons behave
  // identically regardless of which scene is underneath.
  if (handleTopBarTap(p)) return;
  if (started) {
    if (handleMapVoteTap(p)) return;
    if (handleLeaveGameTap(p)) return;
    if (handleDifficultyTap(p)) return;
  } else {
    handleTitleTap(p);
  }
});

// Wheel scrolling on the campaign / vs-computer map list. The list
// is rendered on the canvas (not in a scrollable DOM element), so
// the wheel event has to drive mapSelectScrollY ourselves. preventDefault
// keeps the page from scrolling along with the canvas.
canvas.addEventListener(
  "wheel",
  (ev) => {
    if (started) return;
    if (titleSubScene !== "campaign" && titleSubScene !== "vsMapSelect") return;
    mapSelectScrollY += ev.deltaY;
    if (mapSelectScrollY < 0) mapSelectScrollY = 0;
    if (mapSelectScrollY > mapSelectScrollMax) mapSelectScrollY = mapSelectScrollMax;
    ev.preventDefault();
  },
  { passive: false },
);

canvas.addEventListener(
  "touchstart",
  (ev) => {
    const t = ev.changedTouches[0];
    if (!t) return;
    const r = canvas.getBoundingClientRect();
    const p = { x: t.clientX - r.left, y: t.clientY - r.top };
    if (handleTopBarTap(p)) { ev.preventDefault(); return; }
    if (started) {
      if (handleMapVoteTap(p)) { ev.preventDefault(); return; }
      if (handleLeaveGameTap(p)) { ev.preventDefault(); return; }
      if (handleDifficultyTap(p)) { ev.preventDefault(); return; }
    } else {
      ev.preventDefault();
      // On the campaign / vs-computer map list, remember the starting
      // Y so a vertical drag scrolls instead of firing the tap on
      // touchend. The tap fires from touchend only when no drag
      // happened — see canvas.addEventListener("touchend") below.
      if (titleSubScene === "campaign" || titleSubScene === "vsMapSelect") {
        mapSelectTouchY = p.y;
        mapSelectTouchScrolled = 0;
        return;
      }
      handleTitleTap(p);
    }
  },
  { passive: false },
);

canvas.addEventListener(
  "touchmove",
  (ev) => {
    if (started) return;
    if (titleSubScene !== "campaign" && titleSubScene !== "vsMapSelect") return;
    if (mapSelectTouchY === null) return;
    const t = ev.changedTouches[0];
    if (!t) return;
    const r = canvas.getBoundingClientRect();
    const y = t.clientY - r.top;
    const dy = mapSelectTouchY - y;
    mapSelectScrollY += dy;
    if (mapSelectScrollY < 0) mapSelectScrollY = 0;
    if (mapSelectScrollY > mapSelectScrollMax) mapSelectScrollY = mapSelectScrollMax;
    mapSelectTouchScrolled += Math.abs(dy);
    mapSelectTouchY = y;
    ev.preventDefault();
  },
  { passive: false },
);

canvas.addEventListener(
  "touchend",
  (ev) => {
    if (started) return;
    if (titleSubScene !== "campaign" && titleSubScene !== "vsMapSelect") return;
    if (mapSelectTouchY === null) {
      // We never saw the matching touchstart in this scene — bail
      // so we don't fire a stray tap.
      return;
    }
    const wasScrolling = mapSelectTouchScrolled > MAP_SCROLL_DRAG_THRESHOLD;
    const t = ev.changedTouches[0];
    mapSelectTouchY = null;
    mapSelectTouchScrolled = 0;
    if (wasScrolling) {
      ev.preventDefault();
      return; // suppress tap — it was a flick scroll
    }
    if (!t) return;
    const r = canvas.getBoundingClientRect();
    const p = { x: t.clientX - r.left, y: t.clientY - r.top };
    ev.preventDefault();
    handleTitleTap(p);
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
  lastFootstep.clear();
  prevDangerMode = false;
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

function startRound(
  chosenId: string,
  mapId: string = defaultMapId(),
  isCampaign: boolean = false,
): void {
  const def = CHARACTERS[chosenId];
  if (!def) return;
  const mapDef = getMap(mapId) ?? getMap(defaultMapId())!;

  let hunterId: string;
  let survivorId: string;
  let playerRole: "hunter" | "survivor";
  if (def.role === "hunter") {
    hunterId = chosenId;
    survivorId = pickRandom(AI_SURVIVORS);
    playerRole = "hunter";
  } else {
    // Pull from the OWNED hunter pool — Gravemarch only appears
    // as the AI opponent once the player has purchased him.
    const pool = aiHunters();
    hunterId = pool.length > 0 ? pickRandom(pool) : "slagy";
    survivorId = chosenId;
    playerRole = "survivor";
  }

  const world = new World(mapDef.arenaConfig, TIME_LIMIT_SECONDS);
  // HuntMode owns objective spawning (one at a time, respawn on collect),
  // so the arena builder places no objectives.
  mapDef.buildArena(world, Math.floor(Math.random() * 1e9), 0);

  const mode = new HuntMode({
    hunterCharacterId: hunterId,
    survivorCharacterIds: [survivorId],
    playerRole,
    objectivesRequired: OBJECTIVES_REQUIRED,
  });
  mode.initialize(world);

  // ==== Invincible Mode hook (Bigfoot / 1234) ====
  // When the local human is logged in as the special Bigfoot profile,
  // flip their character's invincible flag. The engine reads it and
  // skips damage + grants 1.5× cooldown rate. Single block — easy to
  // delete: remove this block + INVINCIBLE_* constants below + the
  // invincible field in entity.ts to drop the feature entirely.
  if (loggedIn && isInvincibleProfile(getName(), getPin())) {
    const player = world.playerCharacter();
    if (player) player.invincible = true;
  }

  // Mirror local inventory onto the player character so the
  // renderer can paint the Sprint Boots overlay at their feet.
  // AI characters never have boots in vs-computer mode — inventory
  // is per-profile, and only the local human has a profile here.
  {
    const player = world.playerCharacter();
    if (player && hasSprintBoots()) player.hasSprintBoots = true;
  }

  // Apply per-character level scaling. Player character uses the
  // local profile's XP for this character. AI characters get a
  // jittered level derived from the player's level + the chosen
  // AI difficulty offset (Noob -20 ... Legendary +20) so they
  // vary lineup-to-lineup instead of all being the same level.
  applyLevelsToWorld(world);

  const controllers = new Map<number, Controller>();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) {
      controllers.set(c.id, new HumanController(input, hasSprintBoots));
    } else {
      const ai = createAIController(c.characterId);
      if (ai) controllers.set(c.id, ai);
    }
  }

  const engine = new Engine({ world, mode, controllers });
  const player = world.playerCharacter();
  const cam = createCamera(player ? { ...player.pos } : { x: 0, y: 0 });

  play = {
    world, mode, engine, controllers, cam,
    chosenCharacterId: chosenId,
    mapId: mapDef.id,
    isCampaign,
    // 3-second pre-round countdown — matches the multiplayer cadence
    // (COUNTDOWN_INGAME_AT) so single-player doesn't feel jarring.
    countdown: 3,
  };
  scene = "playing";
}

function goToSelect(): void {
  const prior = play?.chosenCharacterId ?? null;
  play = null;
  scene = "select";
  if (prior) selectScreen.setSelected(prior);
}

// Pool of characters the player is allowed to use in FFA. Today
// every character in the CHARACTERS registry is unlocked for
// everyone (no character-locking shop items have shipped); when
// they do, this is the single place to filter by the inventory.
// Returned in CHARACTERS-declaration order so the AI roster
// composition stays deterministic per registry.
function availableFFACharacters(): string[] {
  return Object.keys(CHARACTERS).filter(isCharacterUnlocked);
}

// Spin up a single-player FFA round. Total fighters = min(8,
// number of unlocked characters); the human takes slot 0 and AI
// bots fill the remaining slots with random picks from the same
// pool (duplicates allowed — fighting your own mirror is fine
// and lets the swarm fill up even when only a few characters
// exist). Reuses Forest Map 1 as the v1 arena. Win condition is
// picked at random by FFAMode itself.
function startFFARound(chosenId: string): void {
  const def = CHARACTERS[chosenId];
  if (!def) return;
  const mapDef = getMap("forest_1") ?? getMap(defaultMapId())!;
  const pool = availableFFACharacters();
  // Total cap: 8, but never more than the pool itself (so a
  // 4-character roster ships 4 fighters, not 8 clones).
  const total = Math.min(FFA_MAX_PLAYERS, pool.length);
  const botCount = Math.max(0, total - 1);
  const botIds: string[] = [];
  for (let i = 0; i < botCount; i++) {
    botIds.push(pool[Math.floor(Math.random() * pool.length)]!);
  }
  const world = new World(mapDef.arenaConfig, TIME_LIMIT_SECONDS);
  mapDef.buildArena(world, Math.floor(Math.random() * 1e9), 0);

  const mode = new FFAMode({
    playerCharacterId: chosenId,
    botCharacterIds: botIds,
    objectivesRequired: OBJECTIVES_REQUIRED,
  });
  mode.initialize(world);

  if (loggedIn && isInvincibleProfile(getName(), getPin())) {
    const player = world.playerCharacter();
    if (player) player.invincible = true;
  }

  // Apply per-character level scaling — same path as Hunt.
  applyLevelsToWorld(world);

  // Sprint Boots overlay flag — mirrors the local inventory onto
  // the player character so the renderer can paint the boots at
  // their feet. AI characters in FFA don't get boots (no profile).
  {
    const player = world.playerCharacter();
    if (player && hasSprintBoots()) player.hasSprintBoots = true;
  }

  const controllers = new Map<number, Controller>();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) {
      controllers.set(c.id, new HumanController(input, hasSprintBoots));
    } else {
      // Reuse the per-character AI for FFA. The existing
      // controllers were tuned for HuntMode (Slagy hunts
      // survivors, Match flees hunters); in FFA they'll behave
      // by their own training even though the team labels are
      // unified. Good-enough v1; per-character FFA AI is a
      // follow-up.
      const ai = createAIController(c.characterId);
      if (ai) controllers.set(c.id, ai);
    }
  }

  const engine = new Engine({ world, mode, controllers });
  const player = world.playerCharacter();
  const cam = createCamera(player ? { ...player.pos } : { x: 0, y: 0 });

  play = {
    world, mode, engine, controllers, cam,
    chosenCharacterId: chosenId,
    mapId: mapDef.id,
    isCampaign: false,
    countdown: 3,
  };
  pendingFFA = false; // consume the flag so next round defaults to vs
  scene = "playing";
}

function frameLocal(dt: number, dims: { w: number; h: number }): void {
  if (scene === "select") {
    selectScreen.setLobbyView(null);
    selectScreen.draw(ctx, dims);
    // VS-Computer flow shows a 5-pill AI difficulty selector at the
    // bottom of the character-select screen. Other flows (campaign,
    // FFA, multiplayer lobby) skip it — campaign and FFA still respect
    // the stored difficulty, they just don't expose the picker here.
    // Hidden when in MP-driven select (no AI) and when pendingFFA
    // is true (FFA is its own AI mode for now).
    if (!pendingFFA) drawAiDifficultyBar(dims);
    return;
  }
  if (scene === "playing" && play) {
    const p = play;
    input.mouseWorld = screenToWorld(input.mouseScreen, p.cam, renderer.cw, renderer.ch);

    // Pre-round countdown: freeze the world (don't tick the engine)
    // while remaining > 0 so the player sees the spawn and reads
    // 3..2..1 before input takes effect. Camera still snaps to the
    // player so the framing is correct.
    if (p.countdown != null && p.countdown > 0) {
      p.countdown -= dt;
      if (p.countdown <= 0) p.countdown = null;
      // Drop any ability presses that landed during the freeze so the
      // first real tick doesn't auto-fire abilities the player
      // queued before the round actually started.
      input.pressedAbilities.clear();
    } else {
      p.engine.tick(dt);
    }

    const player = p.world.playerCharacter();
    if (player) {
      // Snap on first frame, ease afterward.
      const snap = p.countdown != null ? 1 : Math.min(1, dt * 6);
      p.cam.target.x += (player.pos.x - p.cam.target.x) * snap;
      p.cam.target.y += (player.pos.y - p.cam.target.y) * snap;
    }

    // Sound + visual events + heartbeat (local mode). Skip while the
    // countdown freeze is active so no spawn-frame sounds fire.
    const localMe = p.world.playerCharacter() ?? null;
    if (p.countdown == null) {
      detectSoundAndVisualEvents(p.world, localMe);
      detectFootsteps(p.world, localMe);
      detectBrushSounds(p.engine, p.world, localMe);
      checkDangerModeTransition(p.world);
      updateHeartbeatFor(p.world, localMe?.id ?? null);
    } else {
      setHeartbeat(null);
    }

    renderer.clear("#1a2421");
    renderer.drawArena(p.world, p.cam);
    const localVis = visibilityFilter(p.world, p.world.playerCharacter()?.id);
    renderer.drawEntities(p.world, p.cam, localVis);
    drawClientEffects(p.cam);
    // Cave-world low-vision mask (no-op when arena doesn't request
    // it). Paints darkness with cut-outs for the local player's
    // flashlight cone + crystal ambient circles + a small halo
    // around every other character.
    renderer.drawFlashlightMask(p.world, p.cam, p.world.playerCharacter()?.id ?? null);
    drawGravemarchSurvivorMarkers(p.world, p.cam);
    drawHUD(ctx, canvas, p.world, {
      outcome: p.engine.outcome,
      paused: p.engine.paused,
      dimensions: dims,
      isTouchMode: input.isTouchMode,
      points: getPoints(),
      objectivesRequired: OBJECTIVES_REQUIRED,
      // Single-player has only one survivor — the top-left card
      // already shows them, so the mini list would be redundant.
      showSurvivorList: false,
      dangerMode: computeDangerMode(p.world),
      showStaminaBar: hasSprintBoots(),
    });
    if (input.isTouchMode) {
      touchControls.draw(ctx, dims, p.world, p.engine.outcome, p.engine.paused);
    }
    // Countdown overlay on top of everything.
    if (p.countdown != null && p.countdown > 0) {
      drawCountdownOverlay(dims, p.countdown);
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
        if (sel) n.select(sel, hasSprintBoots(), getCharacterLevel(sel));
        netInitialPickSent = true;
      }
      selectScreen.setLobbyView(buildLobbyView());
      selectScreen.draw(ctx, dims);
      drawPlayerHoverTooltip(dims);
      drawNoticesToast(dims, n.notices);
      return;
    case "voting":
      netCamInit = false;
      drawMapVoteScreen(dims, n);
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
          if (sel) n.select(sel, hasSprintBoots(), getCharacterLevel(sel));
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
  detectFootsteps(netViewWorld, netMe);
  // Net mode has no local engine — pass null so the detector
  // computes the viewer's brush touches inline from the snapshot.
  detectBrushSounds(null, netViewWorld, netMe);
  checkDangerModeTransition(netViewWorld);
  updateHeartbeatFor(netViewWorld, n.yourEntityId);

  renderer.clear("#1a2421");
  renderer.drawArena(netViewWorld, netCam);
  const netVis = visibilityFilter(netViewWorld, n.yourEntityId);
  renderer.drawEntities(netViewWorld, netCam, netVis);
  drawClientEffects(netCam);
  renderer.drawFlashlightMask(netViewWorld, netCam, n.yourEntityId);
  drawGravemarchSurvivorMarkers(netViewWorld, netCam);
  drawHUD(ctx, canvas, netViewWorld, {
    outcome: n.outcome,
    paused: n.paused,
    dimensions: dims,
    isTouchMode: input.isTouchMode,
    points: getPoints(),
    objectivesRequired: OBJECTIVES_REQUIRED,
    // Multiplayer: show every survivor's HP so hunters and survivors
    // alike have visibility into team status.
    showSurvivorList: true,
    dangerMode: computeDangerMode(netViewWorld),
    showStaminaBar: hasSprintBoots(),
  });
  if (input.isTouchMode) {
    touchControls.draw(ctx, dims, netViewWorld, n.outcome, false);
  }
}

// Big-number countdown centered on screen. Used at 5,4 over the lobby and
// at 3,2,1 over the (frozen) game. ceil() so 4.7s reads "5", 0.1s reads "1".
// Gravemarch's Rock Shield reveals survivors — when the local
// viewer is Gravemarch and his shielded status is up, paint a
// pulsing blue downward arrow above every living survivor so
// they can't hide behind obstacles. Renderer-side only; the
// effect is purely cosmetic to the viewer.
function drawGravemarchSurvivorMarkers(
  world: World, cam: { target: { x: number; y: number }; zoom: number },
): void {
  const viewer = world.playerCharacter();
  if (!viewer) return;
  if (viewer.characterId !== "gravemarch") return;
  if (!(viewer.statuses["shielded"] > 0)) return;
  const cw = renderer.cw;
  const ch = renderer.ch;
  // Pulse alpha so the marker reads as an active effect.
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(performance.now() / 220));
  for (const s of world.charactersOnTeam("survivor")) {
    if (s.exited) continue;
    const p = worldToScreen(s.pos, cam, cw, ch);
    const baseY = p.y - 70;
    ctx.save();
    // Drop shadow.
    ctx.fillStyle = `rgba(0, 0, 0, ${0.45 * pulse})`;
    ctx.beginPath();
    ctx.moveTo(p.x, baseY + 12);
    ctx.lineTo(p.x - 11, baseY - 2);
    ctx.lineTo(p.x + 11, baseY - 2);
    ctx.closePath();
    ctx.fill();
    // Blue arrow.
    ctx.fillStyle = `rgba(58, 160, 255, ${0.92 * pulse})`;
    ctx.beginPath();
    ctx.moveTo(p.x, baseY + 10);
    ctx.lineTo(p.x - 10, baseY - 4);
    ctx.lineTo(p.x + 10, baseY - 4);
    ctx.closePath();
    ctx.fill();
    // White highlight stripe.
    ctx.fillStyle = `rgba(220, 240, 255, ${0.85 * pulse})`;
    ctx.beginPath();
    ctx.moveTo(p.x - 6, baseY - 4);
    ctx.lineTo(p.x + 6, baseY - 4);
    ctx.lineTo(p.x, baseY + 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

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
  if (titleSubScene === "shop") {
    frameShop(dims);
    return;
  }
  if (titleSubScene === "settings") {
    frameSettings(dims);
    return;
  }
  if (titleSubScene === "campaign") {
    frameCampaign(dims);
    return;
  }
  if (titleSubScene === "vsMapSelect") {
    frameVsMapSelect(dims);
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

  // ---- Two-column button layout ----
  // Left column (yellow): play modes — CAMPAIGN / VS COMPUTER /
  // MULTIPLAYER.
  // Right column (purple): non-play buttons — SHOP, with room for
  // future utility buttons (profile shortcuts, settings, etc.).
  const bh = 56;
  const gap = 12;
  const colGap = 24;
  // Responsive sizing — shrink columns on narrow viewports.
  const totalW = Math.min(584, cw - 80);
  const colW = (totalW - colGap) / 2;
  const leftX = cw / 2 - totalW / 2;
  const rightX = leftX + colW + colGap;
  const by = ch * 0.58;
  const campaign: Rect = { x: leftX, y: by, w: colW, h: bh };
  const vs: Rect = { x: leftX, y: by + bh + gap, w: colW, h: bh };
  const two: Rect = { x: leftX, y: by + 2 * (bh + gap), w: colW, h: bh };
  const shop: Rect = { x: rightX, y: by, w: colW, h: bh };
  // FFA sits below SHOP in the right column. Purple-styled because
  // it's a non-progression mode (no campaign unlock, no maps to
  // pick) — matches the SHOP tonality.
  const ffa: Rect = { x: rightX, y: by + bh + gap, w: colW, h: bh };
  titleButtons = { campaign, vs, two, shop, ffa };

  drawModeButton(campaign, "CAMPAIGN", "Story · unlock maps + worlds", true, "yellow");
  drawModeButton(vs, "VS COMPUTER", "Pick any unlocked map · vs AI", true, "yellow");
  drawModeButton(two, "MULTIPLAYER", "1 vs Many · vote on a map", true, "yellow");
  drawModeButton(shop, "SHOP", "Characters · Outfits · Upgrades", true, "purple");
  drawModeButton(ffa, "FREE FOR ALL", "Up to 8 fighters · random win condition · vs AI", true, "red");
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

  // PROFILE + LOG OUT buttons used to live here; they've moved to
  // the shared top bar (drawTopBar) so they're reachable from
  // every page, not just from the title's logged-in greeting.

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

  // The page-local SETTINGS + BACK buttons here used to live below
  // the achievements panel. They've moved to the shared top bar so
  // they're reachable identically from every page.
  titleProfileSettingsBtn = null;
  titleProfileBackBtn = null;
  ctx.textAlign = "left";
}

// ---- Settings sub-scene ----
// First settings page — per-sound on/off + volume bar. Designed to
// expand with more per-player customization rows over time. Reached
// from the profile page; back button returns to profile.
function frameSettings(dims: { w: number; h: number }): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);
  nameInput.style.display = "none";
  pinInput.style.display = "none";

  // Reset hit-test refs each draw.
  settingsHeartbeatToggleBtn = null;
  settingsHeartbeatVolBar = null;
  settingsFootstepsToggleBtn = null;
  settingsFootstepsVolBar = null;

  // Header
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("SETTINGS", cw / 2, ch * 0.1);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("Tune the sounds you hear in-game.", cw / 2, ch * 0.1 + 22);

  // Sound panel
  const panelW = Math.min(560, cw - 80);
  const panelX = (cw - panelW) / 2;
  const panelY = ch * 0.22;
  const rowH = 86;
  const sectionHeaderH = 30;
  const panelH = sectionHeaderH + rowH * 2 + 20;

  ctx.fillStyle = "rgba(20, 30, 28, 0.85)";
  roundRect({ x: panelX, y: panelY, w: panelW, h: panelH }, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  roundRect({ x: panelX, y: panelY, w: panelW, h: panelH }, 12);
  ctx.stroke();

  // Section header
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("SOUND", panelX + 16, panelY + 22);

  // Two sound rows.
  drawSettingsSoundRow(
    panelX, panelY + sectionHeaderH, panelW, rowH,
    "Heartbeat",
    "Pulses faster when a hunter is close.",
    "heartbeat",
  );
  drawSettingsSoundRow(
    panelX, panelY + sectionHeaderH + rowH, panelW, rowH,
    "Footsteps",
    "Hear any character moving nearby.",
    "footsteps",
  );

  // BACK lives on the shared top bar now.
  settingsBackBtn = null;
}

// Single sound-settings row: name + description on the left, ON/OFF
// toggle on the right, volume bar across the bottom. The toggle and
// the bar each register their own hit zone in the right module-level
// rects keyed by `kind`.
function drawSettingsSoundRow(
  rowX: number, rowY: number, rowW: number, rowH: number,
  label: string, description: string,
  kind: "heartbeat" | "footsteps",
): void {
  const cfg = audioSettings[kind];

  // Label + description
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(label, rowX + 16, rowY + 22);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(description, rowX + 16, rowY + 38);

  // ON/OFF toggle (top-right of the row).
  const togW = 64;
  const togH = 26;
  const togX = rowX + rowW - togW - 16;
  const togY = rowY + 12;
  const togRect: Rect = { x: togX, y: togY, w: togW, h: togH };
  if (kind === "heartbeat") settingsHeartbeatToggleBtn = togRect;
  else settingsFootstepsToggleBtn = togRect;
  ctx.fillStyle = cfg.enabled ? "#48d0a0" : "rgba(40, 52, 48, 0.95)";
  roundRect(togRect, 6);
  ctx.fill();
  if (!cfg.enabled) {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    roundRect(togRect, 6);
    ctx.stroke();
  }
  ctx.fillStyle = cfg.enabled ? "#1a2421" : "rgba(255,255,255,0.6)";
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(cfg.enabled ? "ON" : "OFF", togX + togW / 2, togY + togH / 2);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // Volume bar (bottom of the row). Click anywhere to set volume.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText("Volume", rowX + 16, rowY + 68);
  const barLeft = 80;
  const barRightPad = 60; // leave room for the percentage label
  const barX = rowX + barLeft;
  const barY = rowY + 58;
  const barW = rowW - barLeft - barRightPad - 16;
  const barH = 12;
  const barRect: Rect = { x: barX, y: barY, w: barW, h: barH };
  if (kind === "heartbeat") settingsHeartbeatVolBar = barRect;
  else settingsFootstepsVolBar = barRect;
  // Track
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(barRect, 6);
  ctx.fill();
  // Fill
  const fillW = barW * cfg.volume;
  if (fillW > 1) {
    ctx.fillStyle = cfg.enabled ? "#ffd84a" : "rgba(255,216,74,0.35)";
    roundRect({ x: barX, y: barY, w: fillW, h: barH }, 6);
    ctx.fill();
  }
  // Outline
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  roundRect(barRect, 6);
  ctx.stroke();
  // Percentage label
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(cfg.volume * 100)}%`, rowX + rowW - 16, rowY + 67);
  ctx.textAlign = "left";
}

// ---- Campaign + Vs Computer map-select sub-scenes ----
// Shared rendering helpers. Both screens show worlds as horizontal
// bands, each band a row of map tiles. Tiles are completed (yellow
// check), playable (white border), or locked (dimmed).

function frameCampaign(dims: { w: number; h: number }): void {
  drawMapSelectScreen(dims, "campaign");
}
function frameVsMapSelect(dims: { w: number; h: number }): void {
  drawMapSelectScreen(dims, "vs");
}

function drawMapSelectScreen(
  dims: { w: number; h: number },
  mode: "campaign" | "vs",
): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);
  nameInput.style.display = "none";
  pinInput.style.display = "none";

  // Reset hit zones each draw.
  mapTileBtns = [];

  // Header
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(mode === "campaign" ? "CAMPAIGN" : "VS COMPUTER", cw / 2, ch * 0.08);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText(
    mode === "campaign"
      ? "Beat each map to unlock the next. 5 completed in a world unlocks the next world."
      : "Pick any map you've unlocked — replay anytime against the AI.",
    cw / 2,
    ch * 0.08 + 22,
  );

  // World list — laid out inside a vertically-scrollable region so
  // the screen survives as more worlds ship beyond what fits in
  // the viewport (e.g. iPad portrait clipping Volcano World today).
  const progress = localProgress();
  const panelW = Math.min(720, cw - 80);
  const panelX = (cw - panelW) / 2;
  const listTop = ch * 0.18;
  const listBottom = ch - 24;   // leave bottom margin
  mapSelectListTop = listTop;
  mapSelectListBottom = listBottom;
  const worldH = 160;            // includes 16px breathing room below tiles
  const tileSize = 84;
  const tileGap = 12;
  const worldGap = 14;

  // Total content height — used to clamp mapSelectScrollY and to
  // decide whether the scrollbar renders.
  const contentH = WORLDS.length * worldH + (WORLDS.length - 1) * worldGap;
  const viewportH = listBottom - listTop;
  mapSelectScrollMax = Math.max(0, contentH - viewportH);
  if (mapSelectScrollY < 0) mapSelectScrollY = 0;
  if (mapSelectScrollY > mapSelectScrollMax) mapSelectScrollY = mapSelectScrollMax;

  // Clip drawing to the list viewport so scrolled-off bands don't
  // bleed under the header or below the bottom edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, cw, viewportH);
  ctx.clip();

  let y = listTop - mapSelectScrollY;
  for (const world of WORLDS) {
    const unlocked = isWorldUnlocked(world.id, progress);
    drawWorldBand(panelX, y, panelW, worldH, world, unlocked, tileSize, tileGap, mode, progress);
    y += worldH + worldGap;
  }

  ctx.restore();

  // Vertical scrollbar — only render when content actually overflows.
  // Track sits inside the right margin of the panel; thumb height
  // scales with the viewport / content ratio. Indicator-only;
  // dragging the thumb is supported via the same touch + wheel
  // handlers that scroll the body.
  if (mapSelectScrollMax > 0) {
    const trackX = panelX + panelW + 6;
    const trackW = 6;
    const trackH = viewportH;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(trackX, listTop, trackW, trackH);
    const thumbH = Math.max(28, trackH * (viewportH / contentH));
    const thumbY = listTop + (trackH - thumbH) * (mapSelectScrollY / mapSelectScrollMax);
    ctx.fillStyle = "rgba(255,255,255,0.30)";
    ctx.fillRect(trackX, thumbY, trackW, thumbH);
  }

  // BACK lives on the shared top bar now.
  mapSelectBackBtn = null;
}

function drawWorldBand(
  panelX: number, y: number, panelW: number, h: number,
  world: WorldDef, unlocked: boolean,
  tileSize: number, tileGap: number,
  mode: "campaign" | "vs",
  progress: ProfileProgress,
): void {
  // Band background.
  ctx.fillStyle = unlocked ? "rgba(20, 30, 28, 0.85)" : "rgba(15, 22, 20, 0.7)";
  roundRect({ x: panelX, y, w: panelW, h }, 12);
  ctx.fill();
  ctx.strokeStyle = unlocked
    ? (world.accentColor ?? "rgba(255,255,255,0.12)")
    : "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1.5;
  roundRect({ x: panelX, y, w: panelW, h }, 12);
  ctx.stroke();

  // World name + completion counter.
  const completedInWorld = world.maps.filter((m) => progress.completedMaps.includes(m.id)).length;
  ctx.fillStyle = unlocked ? "#fff" : "rgba(255,255,255,0.4)";
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(world.name, panelX + 16, y + 26);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(
    `${completedInWorld} / ${world.maps.length} maps · ${WORLDS_REQUIRED_MAPS} to unlock next`,
    panelX + 16,
    y + 42,
  );

  if (!unlocked) {
    // Show a locked label + unlock criterion.
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "italic 12px system-ui, sans-serif";
    ctx.textAlign = "right";
    let lockText = "🔒 Locked";
    if (world.unlock.kind === "after-world") {
      const prev = getWorld(world.unlock.previousWorldId);
      lockText = `🔒 Complete ${world.unlock.mapsNeeded} in ${prev?.name ?? "previous world"}`;
    } else if (world.unlock.kind === "shop") {
      lockText = "🔒 Available in the SHOP";
    }
    ctx.fillText(lockText, panelX + panelW - 16, y + 30);
    ctx.textAlign = "left";
    return;
  }

  // Map tile row.
  const tileTop = y + 56;
  let tx = panelX + 16;
  for (const map of world.maps) {
    const completed = progress.completedMaps.includes(map.id);
    const playable = mode === "campaign"
      ? isMapUnlockedCampaign(map.id, progress)
      : isMapPlayableVsComputer(map.id, progress);
    drawMapTile(tx, tileTop, tileSize, map, completed, playable, world.accentColor);
    mapTileBtns.push({
      mapId: map.id,
      rect: { x: tx, y: tileTop, w: tileSize, h: tileSize },
      playable,
    });
    tx += tileSize + tileGap;
    if (tx + tileSize > panelX + panelW - 16) break; // clip overflow
  }
}

function drawMapTile(
  x: number, y: number, size: number,
  map: MapDef, completed: boolean, playable: boolean,
  accent: string | undefined,
): void {
  // Tile background.
  ctx.fillStyle = playable ? "rgba(40, 52, 48, 0.9)" : "rgba(20, 26, 24, 0.7)";
  roundRect({ x, y, w: size, h: size }, 8);
  ctx.fill();
  // Outline color tracks the WORLD's accent regardless of completion
  // status so forest tiles read as green, factory as steel, cave as
  // purple, volcano as red — matching the world band that wraps
  // them. Completion is signalled by a thicker outline + the
  // checkmark badge in the corner; locked tiles fade to a dim grey.
  ctx.strokeStyle = playable
    ? (accent ?? "rgba(255,255,255,0.25)")
    : "rgba(255,255,255,0.08)";
  ctx.lineWidth = completed ? 2.5 : 1.5;
  roundRect({ x, y, w: size, h: size }, 8);
  ctx.stroke();

  // Map preview — call the map's own iso-style thumbnail if it
  // ships one. The content rect is the tile interior with a small
  // pad so the rounded corners read.
  ctx.save();
  ctx.beginPath();
  roundRect({ x: x + 4, y: y + 4, w: size - 8, h: size - 8 - 14 }, 6);
  ctx.clip();
  if (playable && map.thumbnail) {
    map.thumbnail(ctx, x + 4, y + 4, size - 8, size - 8 - 14);
  } else {
    // Locked or no-thumbnail fallback: muted ground swatch.
    ctx.fillStyle = playable ? "#2a3e2c" : "rgba(40,40,40,0.5)";
    ctx.fillRect(x + 4, y + 4, size - 8, size - 8 - 14);
  }
  ctx.restore();

  // Name label
  ctx.fillStyle = playable ? "#fff" : "rgba(255,255,255,0.45)";
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(map.name, x + size / 2, y + size - 8);

  // Completed checkmark
  if (completed) {
    ctx.fillStyle = "#ffd84a";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("✓", x + size - 6, y + 18);
  } else if (!playable) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🔒", x + size / 2, y + size / 2 - 6);
    ctx.textBaseline = "alphabetic";
  }
  ctx.textAlign = "left";
}

// ---- Multiplayer map-vote screen ----
// Shown during NetClient.phase === "voting" (5s between everyone-
// ready and round countdown). Tile grid of candidate maps, each
// showing the live vote tally + chip(s) of who voted for it. Tapping
// a tile sends NetClient.voteMap so the server can update its tally.
// Hit zones rebuild each frame in mapVoteTiles for the canvas
// click dispatcher.
interface MapVoteTile { mapId: string; rect: Rect; }
let mapVoteTiles: MapVoteTile[] = [];

function drawMapVoteScreen(dims: { w: number; h: number }, n: NetClient): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);

  mapVoteTiles = [];

  // Header
  ctx.fillStyle = "#fff";
  ctx.font = "bold 38px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("VOTE FOR A MAP", cw / 2, ch * 0.12);
  // Countdown number
  const remaining = Math.max(0, Math.ceil(n.voteRemaining));
  ctx.fillStyle = remaining <= 2 ? "#d04848" : "#ffd84a";
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.fillText(String(remaining), cw / 2, ch * 0.12 + 64);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText(
    "Tap a tile to vote. Change your vote anytime before the timer hits zero. Ties go to random.",
    cw / 2,
    ch * 0.12 + 92,
  );

  // Build tally per candidate from n.voteVotes.
  const tally = new Map<string, number>();
  for (const mid of n.voteCandidates) tally.set(mid, 0);
  for (const v of n.voteVotes) {
    if (v && tally.has(v)) tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  // Per-slot chip color (from selectScreen helper).
  const slotChip = (slot: number): string => slotColor(slot);

  // Tile grid — center horizontally; up to 4 per row.
  const tileW = 160;
  const tileH = 170;
  const gap = 16;
  const perRow = Math.max(1, Math.min(4, n.voteCandidates.length));
  const rowW = perRow * tileW + (perRow - 1) * gap;
  const startX = (cw - rowW) / 2;
  const startY = ch * 0.32;

  const mySlot = n.slot;
  const myVote = mySlot !== null ? (n.voteVotes[mySlot] ?? null) : null;

  for (let i = 0; i < n.voteCandidates.length; i++) {
    const mid = n.voteCandidates[i]!;
    const map = getMap(mid);
    if (!map) continue;
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const tx = startX + col * (tileW + gap);
    const ty = startY + row * (tileH + gap);
    const r: Rect = { x: tx, y: ty, w: tileW, h: tileH };
    mapVoteTiles.push({ mapId: mid, rect: r });
    const votes = tally.get(mid) ?? 0;
    const isMyVote = myVote === mid;
    drawMapVoteTile(r, map, votes, isMyVote, n.voteVotes, mid, slotChip);
  }
}

function drawMapVoteTile(
  r: Rect, map: MapDef, votes: number, mine: boolean,
  allVotes: (string | null)[], mid: string,
  slotChip: (slot: number) => string,
): void {
  // Card background
  ctx.fillStyle = mine ? "rgba(40, 70, 60, 0.95)" : "rgba(20, 30, 28, 0.85)";
  roundRect(r, 12);
  ctx.fill();
  ctx.strokeStyle = mine ? "#ffd84a" : "rgba(255,255,255,0.15)";
  ctx.lineWidth = mine ? 2.5 : 1.5;
  roundRect(r, 12);
  ctx.stroke();

  // Map preview — dispatch to the map's iso thumbnail.
  ctx.save();
  ctx.beginPath();
  roundRect({ x: r.x + 8, y: r.y + 8, w: r.w - 16, h: r.h - 70 }, 8);
  ctx.clip();
  if (map.thumbnail) {
    map.thumbnail(ctx, r.x + 8, r.y + 8, r.w - 16, r.h - 70);
  } else {
    ctx.fillStyle = "#2a3e2c";
    ctx.fillRect(r.x + 8, r.y + 8, r.w - 16, r.h - 70);
  }
  ctx.restore();

  // World + map name
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(map.name, r.x + r.w / 2, r.y + r.h - 50);
  const world = getWorld(map.worldId);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(world?.name ?? "", r.x + r.w / 2, r.y + r.h - 35);

  // Vote count + voter chips
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText(`${votes} vote${votes === 1 ? "" : "s"}`, r.x + r.w / 2, r.y + r.h - 18);

  // Chips: one small color dot per slot that voted for this map.
  const chipR = 5;
  const chipGap = 4;
  const voters: number[] = [];
  for (let s = 0; s < allVotes.length; s++) if (allVotes[s] === mid) voters.push(s);
  const chipsW = voters.length * (chipR * 2) + Math.max(0, voters.length - 1) * chipGap;
  let cx = r.x + r.w / 2 - chipsW / 2 + chipR;
  for (const s of voters) {
    ctx.fillStyle = slotChip(s);
    ctx.beginPath();
    ctx.arc(cx, r.y + 14, chipR, 0, Math.PI * 2);
    ctx.fill();
    cx += chipR * 2 + chipGap;
  }
  ctx.textAlign = "left";
}

// ---- Shop sub-scene ----
// Header (title + player's point balance), three tabs (Characters /
// Outfits / Upgrades), a card grid for the active tab, and a BACK
// button. Click handlers in handleTitleTap read the shopBackBtn /
// shopTabBtns / shopBuyBtns this function repopulates each frame.
function frameShop(dims: { w: number; h: number }): void {
  const cw = dims.w;
  const ch = dims.h;
  ctx.fillStyle = "#1a2421";
  ctx.fillRect(0, 0, cw, ch);
  nameInput.style.display = "none";
  pinInput.style.display = "none";

  // Reset hit-test arrays — repopulated below.
  shopTabBtns = [];
  shopBuyBtns = [];

  // ---- Header ----
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("SHOP", cw / 2, ch * 0.08);

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText(
    loggedIn
      ? "Spend your points on characters, outfits, and upgrades."
      : "Log in on the title screen to buy — you can still browse.",
    cw / 2,
    ch * 0.08 + 22,
  );

  // Point balance in the top-right.
  const points = getPoints();
  ctx.fillStyle = "#ffd84a";
  ctx.font = "bold 18px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(
    points === 1 ? "1 point" : `${points} points`,
    cw - 24,
    ch * 0.08,
  );

  // ---- Tabs ----
  const tabKinds: ShopItemKind[] = ["character", "outfit", "upgrade", "world"];
  const tabY = ch * 0.08 + 44;
  const tabH = 34;
  const tabGap = 8;
  const tabW = 130;
  const tabsTotalW = tabW * tabKinds.length + tabGap * (tabKinds.length - 1);
  let tx = (cw - tabsTotalW) / 2;
  for (const kind of tabKinds) {
    const r: Rect = { x: tx, y: tabY, w: tabW, h: tabH };
    const active = kind === shopActiveTab;
    ctx.fillStyle = active ? "#ffd84a" : "rgba(40, 52, 48, 0.95)";
    roundRect(r, 8);
    ctx.fill();
    if (!active) {
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      roundRect(r, 8);
      ctx.stroke();
    }
    ctx.fillStyle = active ? "#1a2421" : "#fff";
    ctx.font = "bold 13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(shopKindLabel(kind).toUpperCase(), tx + tabW / 2, tabY + tabH / 2);
    shopTabBtns.push({ kind, rect: r });
    tx += tabW + tabGap;
  }
  ctx.textBaseline = "alphabetic";

  // ---- Card grid for the active tab ----
  const items = shopItemsByKind(shopActiveTab);
  const gridTop = tabY + tabH + 20;
  const gridBottom = ch - 80; // leave room for BACK button
  const gridLeft = Math.max(40, (cw - 880) / 2);
  const gridRight = cw - gridLeft;
  const gridW = gridRight - gridLeft;

  if (items.length === 0) {
    // Empty state — shop chrome stays, body says "nothing here yet."
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "italic 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `No ${shopKindLabel(shopActiveTab).toLowerCase()} yet — check back soon.`,
      cw / 2,
      gridTop + 80,
    );
  } else {
    const cardW = 200;
    const cardH = 220;
    const cardGap = 16;
    const cols = Math.max(1, Math.min(items.length, Math.floor((gridW + cardGap) / (cardW + cardGap))));
    const rowW = cols * cardW + (cols - 1) * cardGap;
    const startX = (cw - rowW) / 2;
    for (let i = 0; i < items.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = startX + col * (cardW + cardGap);
      const cy = gridTop + row * (cardH + cardGap);
      if (cy + cardH > gridBottom) break; // clip overflow (paging later)
      drawShopCard(items[i]!, { x: cx, y: cy, w: cardW, h: cardH });
    }
  }

  // BACK lives on the shared top bar now.
  shopBackBtn = null;
}

// Single item card: icon, name, description, price, and BUY/OWNED
// state. Pushes the BUY rect into shopBuyBtns so handleTitleTap can
// route clicks back to purchaseItem.
function drawShopCard(item: ShopItem, r: Rect): void {
  const owned = isItemOwned(item.id);
  const affordable = getPoints() >= item.price;
  const canBuy = loggedIn && !owned && affordable;

  // Card body.
  ctx.fillStyle = "rgba(28, 40, 36, 0.92)";
  roundRect(r, 12);
  ctx.fill();
  ctx.strokeStyle = owned
    ? "rgba(72, 208, 160, 0.55)"
    : "rgba(255,255,255,0.08)";
  ctx.lineWidth = owned ? 2 : 1;
  roundRect(r, 12);
  ctx.stroke();

  // Icon centered near the top.
  const iconSize = 64;
  const iconX = r.x + r.w / 2 - iconSize / 2;
  const iconY = r.y + 16;
  drawShopItemIcon(ctx, item, iconX, iconY, iconSize, owned);

  // Name.
  ctx.fillStyle = "#fff";
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(item.name, r.x + r.w / 2, iconY + iconSize + 22);

  // Description — wrap to two lines if needed.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui, sans-serif";
  const desc = item.description;
  const lines = wrapText(desc, r.w - 24, "11px system-ui, sans-serif", 2);
  let dy = iconY + iconSize + 42;
  for (const line of lines) {
    ctx.fillText(line, r.x + r.w / 2, dy);
    dy += 14;
  }

  // For outfits, append the scope ("All characters" / "Slagy only").
  if (item.kind === "outfit") {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "italic 10px system-ui, sans-serif";
    const scope = item.characterId === "any"
      ? "All characters"
      : `${item.characterId ?? "?"} only`;
    ctx.fillText(scope, r.x + r.w / 2, dy + 2);
  }

  // Buy / Owned button at the bottom.
  const bw = r.w - 24;
  const bh = 34;
  const bx = r.x + 12;
  const by = r.y + r.h - bh - 12;
  const btn: Rect = { x: bx, y: by, w: bw, h: bh };

  if (owned) {
    ctx.fillStyle = "rgba(72, 208, 160, 0.18)";
    roundRect(btn, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(72, 208, 160, 0.6)";
    ctx.lineWidth = 1;
    roundRect(btn, 8);
    ctx.stroke();
    ctx.fillStyle = "#48d0a0";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("OWNED ✓", bx + bw / 2, by + bh / 2);
  } else {
    // Visual: bright yellow when actionable, dim slate when not.
    ctx.fillStyle = canBuy ? "#ffd84a" : "rgba(40, 52, 48, 0.7)";
    roundRect(btn, 8);
    ctx.fill();
    if (!canBuy) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      roundRect(btn, 8);
      ctx.stroke();
    }
    ctx.fillStyle = canBuy ? "#1a2421" : "rgba(255,255,255,0.5)";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label = !loggedIn
      ? `LOG IN TO BUY · ${item.price}`
      : !affordable
        ? `NEED ${item.price - getPoints()} MORE`
        : `BUY · ${item.price} PTS`;
    ctx.fillText(label, bx + bw / 2, by + bh / 2);
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  // Always register the rect — handler routes by purchaseItem result.
  shopBuyBtns.push({ id: item.id, rect: btn });
}

// Word-wrap helper used by the shop card description. Truncates after
// maxLines with an ellipsis. Saves/restores font state.
function wrapText(text: string, maxWidth: number, font: string, maxLines: number): string[] {
  ctx.save();
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let wordIndex = 0;
  while (wordIndex < words.length && lines.length < maxLines) {
    const w = words[wordIndex]!;
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
      wordIndex++;
    } else if (current) {
      lines.push(current);
      current = "";
    } else {
      // Single word too long — accept it anyway and advance.
      lines.push(w);
      wordIndex++;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  // Truncate with ellipsis if there are leftover words.
  if (wordIndex < words.length && lines.length > 0) {
    let last = lines[lines.length - 1]!;
    while (last.length > 0 && ctx.measureText(last + "…").width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + "…";
  }
  ctx.restore();
  return lines;
}

// Title button: two-line (title + subtitle), with an enabled/disabled
// look. Palette controls the fill family — "yellow" for game modes,
// "purple" for shop and other utility buttons. Disabled renders dim
// in the slate family regardless of palette.
type ButtonPalette = "yellow" | "purple" | "red";
const PALETTES: Record<ButtonPalette, { fill: string; title: string; sub: string }> = {
  yellow: { fill: "#ffd84a", title: "#1a2421", sub: "rgba(26,36,33,0.7)" },
  purple: { fill: "#7c4a8b", title: "#fff", sub: "rgba(255,255,255,0.72)" },
  // Crimson — used by combat-themed buttons (FFA). Distinguishes
  // visually from the purple shop button it sits next to.
  red: { fill: "#c43a3a", title: "#fff", sub: "rgba(255,235,235,0.78)" },
};
function drawModeButton(
  r: Rect,
  title: string,
  subtitle: string,
  enabled: boolean,
  palette: ButtonPalette,
): void {
  if (enabled) {
    const p = PALETTES[palette];
    ctx.fillStyle = p.fill;
    roundRect(r, 12);
    ctx.fill();
    ctx.fillStyle = p.title;
    ctx.font = "bold 19px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, r.x + r.w / 2, r.y + r.h / 2 - 2);
    ctx.fillStyle = p.sub;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(subtitle, r.x + r.w / 2, r.y + r.h / 2 + 16);
  } else {
    // Disabled: dim slate with a subtle outline. Palette-agnostic so
    // disabled buttons in either column look consistent.
    ctx.fillStyle = "rgba(40,52,48,0.5)";
    roundRect(r, 12);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    roundRect(r, 12);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "bold 19px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(title, r.x + r.w / 2, r.y + r.h / 2 - 2);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(subtitle, r.x + r.w / 2, r.y + r.h / 2 + 16);
  }
}

// ---- Shared top bar ----
// Drawn from every non-playing frame entry point. Top-LEFT is the
// Back button (only when there's somewhere to back to); top-RIGHT
// is Profile / Settings / Logout. The bar lives ABOVE the page
// content so per-page layouts don't have to leave room for it —
// they just stay clear of the top ~56px gutter.
//
// Single source of truth for every back path in the app, so the
// same pill in the same place behaves correctly whether you're on
// the title, in a subscene, in character select, or in a net
// lobby.
function drawTopBar(dims: { w: number; h: number }): void {
  const w = dims.w;
  const margin = 14;
  const btnH = 32;
  const pillRadius = 8;
  ctx.save();
  ctx.font = "bold 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ---- Top-left: Back ----
  if (canGoBack()) {
    const bw = 88;
    topBarBackBtn = { x: margin, y: margin, w: bw, h: btnH };
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    roundRect(topBarBackBtn, pillRadius);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    roundRect(topBarBackBtn, pillRadius);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText("← BACK", topBarBackBtn.x + bw / 2, topBarBackBtn.y + btnH / 2);
  } else {
    topBarBackBtn = null;
  }

  // ---- Top-right: Profile / Settings / Logout ----
  // Drawn left-to-right anchored to the right margin. Profile +
  // Logout only appear when logged in; Settings is universal so
  // audio prefs are reachable even from the login form.
  let xCursor = w - margin;
  const smallW = 86;
  const gap = 6;
  const drawPill = (label: string, fill: string, textColor: string): Rect => {
    xCursor -= smallW;
    const r: Rect = { x: xCursor, y: margin, w: smallW, h: btnH };
    ctx.fillStyle = fill;
    roundRect(r, pillRadius);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1;
    roundRect(r, pillRadius);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(label, r.x + smallW / 2, r.y + btnH / 2);
    xCursor -= gap;
    return r;
  };
  // Right-to-left placement so LOG OUT sits furthest right (the
  // "danger" position) and PROFILE is innermost (most-used).
  if (loggedIn) {
    topBarLogoutBtn = drawPill("LOG OUT", "rgba(60, 30, 30, 0.85)", "#ffd6d6");
  } else {
    topBarLogoutBtn = null;
  }
  topBarSettingsBtn = drawPill("SETTINGS", "rgba(0, 0, 0, 0.55)", "#fff");
  if (loggedIn) {
    topBarProfileBtn = drawPill("PROFILE", "rgba(0, 0, 0, 0.55)", "#fff");
  } else {
    topBarProfileBtn = null;
  }

  // ---- Gamepad status badge ----
  // Always drawn (visible on every non-playing page) so the
  // player can verify at a glance whether their controller has
  // registered. Three states:
  //   GREEN  CONTROLLER     — pad currently connected & registered
  //   AMBER  CONTROLLER     — was seen earlier but not connected now
  //                           (e.g. battery died or unpaired)
  //   GRAY   NO CONTROLLER  — nothing seen yet; hint asks the player
  //                           to press any button on a paired pad
  // The browser may not fire gamepadconnected until the first
  // button press on some controllers — the gray-state hint
  // tells the player to do that.
  {
    const badgeW = 124;
    xCursor -= badgeW;
    const r: Rect = { x: xCursor, y: margin, w: badgeW, h: btnH };
    let fill: string;
    let textColor: string;
    let label: string;
    if (input.gamepadConnected) {
      fill = "rgba(20, 90, 50, 0.85)"; // green
      textColor = "#c7f5c7";
      label = "🎮 CONNECTED";
    } else if (input.isGamepadMode) {
      fill = "rgba(110, 75, 30, 0.85)"; // amber
      textColor = "#ffe0b8";
      label = "🎮 OFFLINE";
    } else {
      fill = "rgba(40, 40, 48, 0.85)"; // dim gray
      textColor = "rgba(255,255,255,0.5)";
      label = "🎮 NO PAD";
    }
    ctx.fillStyle = fill;
    roundRect(r, pillRadius);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 1;
    roundRect(r, pillRadius);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(label, r.x + badgeW / 2, r.y + btnH / 2);
    xCursor -= gap;
  }

  ctx.restore();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // Hint under the badge when no gamepad has been seen this
  // session — most off-brand pads require the player to press a
  // button before the browser's gamepadconnected event fires.
  // Only shown on title main so it doesn't clutter every page.
  if (!input.isGamepadMode && !started && titleSubScene === "main") {
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(
      "Bluetooth pad? Press any button to register",
      w - margin,
      margin + btnH + 14,
    );
    ctx.restore();
  }
}

// Whether the current scene has a meaningful "back" destination.
// True for any title subscene other than main, for character
// select, and for any net-lobby phase. False on the title main
// page (the root) and during gameplay (drawTopBar isn't called
// during gameplay anyway).
function canGoBack(): boolean {
  if (!started) return titleSubScene !== "main";
  if (appMode === "local") return scene === "select";
  if (appMode === "net") {
    return (
      net?.phase === "lobby" ||
      net?.phase === "connecting" ||
      net?.phase === "full" ||
      net?.phase === "disconnected" ||
      net?.phase === "voting"
    );
  }
  return false;
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
  // True if the character was mid-transport (e.g. Magnesis) last
  // frame. Used to detect the undefined → set transition so we can
  // fire the "magnesis_travel" whoosh exactly once per transport.
  transporting: boolean;
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
    // Magnesis: rising charge sound at the moment the channel starts
    // (cooldown 0 -> >0). The transport-launch sound fires separately
    // when the transport state appears on the entity.
    case "magnesis": return "magnesis";
    // Necro: every ability cast is voiced by his "cah-cah" call.
    // Resurrect fires the caw at cast-start (cooldown 0 -> >0) so
    // it matches the 0.7s windup; command_attack fires it
    // instantly when zombies receive the order.
    case "resurrect": return "caw";
    case "command_attack": return "caw";
    default: return null;
  }
}

// Client-side visual effects (non-authoritative — purely cosmetic).
// The Magnesis trail used to live here as a "magnesis_trail" effect
// triggered by a detected position jump. Now that Magnesis is a real
// transport arc (entity.transport on the character), the renderer
// reads it directly and draws the trail itself — no client-side
// effect state needed. Kept as an empty scaffold so future cosmetic
// effects have an obvious home.
interface ClientEffect {
  kind: never;
}
const clientEffects: ClientEffect[] = [];

function updateClientEffects(_dt: number): void {
  // Reserved for future cosmetic effects.
}

function drawClientEffects(_cam: { target: { x: number; y: number }; zoom: number }): void {
  // Reserved for future cosmetic effects.
}

// Compute Danger Mode locally from the world: any survivor whose
// personal nugget count has crossed the exit threshold flips the
// hunter's escalation buffs on (the server engine reads the same
// condition through HuntMode.isDangerMode). Mirrored here so the
// HUD can render the badge without holding a mode reference.
function computeDangerMode(world: World): boolean {
  for (const e of world.entities) {
    if (e.kind !== "character") continue;
    if (e.team !== "survivor") continue;
    if (e.objectivesCollected >= OBJECTIVES_REQUIRED) return true;
  }
  return false;
}

// Module-level previous Danger Mode state so we can fire a one-shot
// banner exactly when it activates (not every frame). Reset on
// round transitions alongside the other detection caches.
let prevDangerMode = false;
function checkDangerModeTransition(world: World): void {
  const now = computeDangerMode(world);
  if (now && !prevDangerMode) {
    fireAchievementBanner("⚠ DANGER MODE — hunter is faster!");
  }
  prevDangerMode = now;
}

// Per-character timestamp of the last fired footstep, in seconds
// (performance.now() / 1000). Used so each moving character emits
// one footstep per FOOTSTEP_INTERVAL while they're walking; resets
// when the character stops so the first step after standing still
// fires immediately on the next move.
const lastFootstep = new Map<number, number>();
const FOOTSTEP_INTERVAL = 0.42;       // seconds between steps per character
const FOOTSTEP_MOVING_SPEED = 30;     // velocity magnitude above which we count as "walking"

// ---- Brush sound detector ----
// Per-tick, scan every obstacle the local viewer is currently
// brushing (in its outer 70% pixel ring around its core 30%) and
// retrigger the obstacle's dedicated sound at a cadence that
// makes a continuous loop on the ear. Volume scales with current
// depth so a barely-touching brush is quiet and a heavy lean
// against a tree is loud.
//
// Per-(viewer, obstacle) timestamp keys debounce the retrigger
// interval. The whole map clears when the viewer's id changes
// between rounds, which the next entry hash collision will catch
// (no explicit reset needed for v1).
const lastBrushFire = new Map<string, number>();
// Cadence between repeated brush samples for the same
// (viewer, obstacle) pair. 2 seconds reads as ambient
// "you're still in contact with this" rather than a buzzy loop —
// each sample lands as a discrete cue against the silence
// before it.
const BRUSH_RETRIGGER_INTERVAL = 2.0;

function detectBrushSounds(
  _engine: Engine | null,
  world: World,
  viewer: CharacterEntity | null,
): void {
  if (!viewer || viewer.dead || viewer.exited) return;
  const now = performance.now() / 1000;
  // Reuse the engine's already-computed brush info when we have it
  // (local single-player). Otherwise — net play or pre-engine —
  // compute the viewer's brush touches inline so the audio still
  // fires.
  const info = _engine?.lastBrushInfo.get(viewer.id) ?? null;
  let touches: { obstacleId: number; kind: BrushKind; depth: number }[];
  if (info) {
    touches = info.touched;
  } else {
    touches = [];
    // Inline mirror of Engine.computeBrushInfo for the viewer.
    // Kept terse; if either drifts the audio will lose a fire or
    // two but never crash.
    for (const e of world.entities) {
      let kind: BrushKind | null = null;
      if (e.kind === "prop" && e.blocking) kind = { tag: "prop", shape: e.shape };
      else if (e.kind === "animal" && !e.dead) kind = { tag: "animal", species: e.species };
      if (!kind) continue;
      const dx = viewer.pos.x - e.pos.x;
      const dy = viewer.pos.y - e.pos.y;
      const d = Math.hypot(dx, dy);
      const coreR = e.radius * CORE_FRAC;
      const outerR = e.radius + viewer.radius;
      const innerR = coreR + viewer.radius;
      if (d >= outerR) continue;
      const depth = d <= innerR ? 1 : (outerR - d) / (outerR - innerR);
      if (depth <= 0.05) continue;
      touches.push({ obstacleId: e.id, kind, depth });
    }
    // Arena walls.
    const b = world.arena.bounds;
    const walls: [number, number][] = [
      [-1, viewer.pos.x - viewer.radius - b.minX],
      [-2, b.maxX - (viewer.pos.x + viewer.radius)],
      [-3, viewer.pos.y - viewer.radius - b.minY],
      [-4, b.maxY - (viewer.pos.y + viewer.radius)],
    ];
    for (const [wid, gap] of walls) {
      if (gap < 0 || gap > WALL_BRUSH_BAND) continue;
      const depth = 1 - gap / WALL_BRUSH_BAND;
      if (depth <= 0.05) continue;
      touches.push({ obstacleId: wid, kind: { tag: "wall" }, depth });
    }
  }

  // Retrigger the dedicated sound for each touched obstacle.
  for (const t of touches) {
    const key = `${viewer.id}:${t.obstacleId}`;
    const last = lastBrushFire.get(key) ?? 0;
    if (now - last < BRUSH_RETRIGGER_INTERVAL) continue;
    lastBrushFire.set(key, now);
    const soundId = brushSoundFor(t.kind);
    if (!soundId) continue;
    // Volume scales from 0.12 (barely touching) to 0.55 (deep
    // brush at the core boundary). Multiplied by the per-sound
    // master in the audio module, so the resulting amplitude is
    // tame at light brush.
    const vol = 0.12 + t.depth * 0.43;
    playSound(soundId, { volumeMul: vol });
  }
  // Cull stale entries to keep the map bounded across long sessions.
  if (lastBrushFire.size > 256) {
    for (const [k, ts] of lastBrushFire) {
      if (now - ts > 3) lastBrushFire.delete(k);
    }
  }
}

function brushSoundFor(kind: BrushKind): SoundId | null {
  if (kind.tag === "wall") return "brush_wall";
  if (kind.tag === "animal") {
    switch (kind.species) {
      case "bear":         return "brush_growl";
      case "deer":         return "brush_bleat";
      case "boar":         return "brush_growl";  // reuse growl until a snort sample exists
      case "moose":        return "brush_growl";
      case "sweeper_bot":  return "brush_beep";
      case "welder_bot":   return "brush_buzz";
    }
    return null;
  }
  // prop
  switch (kind.shape) {
    case "tree":     return "brush_rustle";
    case "stump":    return "brush_rustle";
    case "rock":     return "brush_crunch";
    case "caverock": return "brush_crunch";
    case "crystal":  return "brush_chime";
    case "pipe":     return "brush_clang";
    case "crate":    return "brush_thud";
    case "pallet":   return "brush_thud";
    case "oildrum":  return "brush_boom";
    case "volcano":  return "brush_crunch";       // walking the basalt slope
    case "obsidian": return "brush_crunch";       // sharp glass
    default:         return null;
  }
}

function detectFootsteps(world: World, viewer: CharacterEntity | null): void {
  if (!audioPrefs_footsteps_enabled()) return; // cheap gate to skip the whole loop
  const now = performance.now() / 1000;
  const vp = viewer?.pos ?? null;
  const seenIds = new Set<number>();
  for (const e of world.entities) {
    if (e.kind !== "character") continue;
    if (e.dead) continue;
    seenIds.add(e.id);
    // Mid-transport (Magnesis arc) Magnek glides, not walks — no steps.
    if (e.transport) { lastFootstep.delete(e.id); continue; }
    // Necro is a crow on the wing — never plays footstep audio
    // regardless of how fast she's moving. The whole point of her
    // flight kit is silent traversal.
    if (e.characterId === "necro") { lastFootstep.delete(e.id); continue; }
    const speed = Math.hypot(e.vel.x, e.vel.y);
    if (speed < FOOTSTEP_MOVING_SPEED) {
      lastFootstep.delete(e.id);
      continue;
    }
    const last = lastFootstep.get(e.id);
    if (last == null) {
      // First step after a stop fires immediately; subsequent steps
      // wait the interval.
      lastFootstep.set(e.id, now);
      const distance = vp ? Math.hypot(e.pos.x - vp.x, e.pos.y - vp.y) : 0;
      playSound("footsteps", { distance });
      continue;
    }
    if (now - last >= FOOTSTEP_INTERVAL) {
      const distance = vp ? Math.hypot(e.pos.x - vp.x, e.pos.y - vp.y) : 0;
      playSound("footsteps", { distance });
      lastFootstep.set(e.id, now);
    }
  }
  // Garbage-collect entries for entities that left the world.
  for (const id of [...lastFootstep.keys()]) {
    if (!seenIds.has(id)) lastFootstep.delete(id);
  }
}

// Tiny accessor so detectFootsteps can avoid the per-entity loop when
// the user has turned footsteps off. The audio module is the source
// of truth; this just shadows the enabled flag through the settings
// object which is always in sync (persistAudioSettings updates both).
function audioPrefs_footsteps_enabled(): boolean {
  return audioSettings.footsteps.enabled;
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
        // Transport (e.g. Magnesis) just began: prev.transporting was
        // false and the entity now has a transport state. Fire the
        // subtle whoosh once, with doppler hint based on whether the
        // destination is closer to the viewer than the launch point.
        const transportingNow = e.transport != null;
        if (!prev.transporting && transportingNow && e.transport) {
          let dop = 0;
          if (vp) {
            const fromD = Math.hypot(e.transport.fromPos.x - vp.x, e.transport.fromPos.y - vp.y);
            const toD = Math.hypot(e.transport.toPos.x - vp.x, e.transport.toPos.y - vp.y);
            dop = fromD > toD ? 1 : -1; // approaching if destination is closer
          }
          playSound("magnesis_travel", { distance: dist(e.pos), doppler: dop });
        }
      }
      prevCharSnap.set(e.id, {
        pos: { x: e.pos.x, y: e.pos.y },
        cooldowns: { ...e.cooldowns },
        characterId: e.characterId,
        team: e.team,
        transporting: e.transport != null,
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

// ---- Shop inventory storage (localStorage; synced when logged in) ----
// Same shape as achievements: array of {id, ts}. Buying debits points
// locally and adds to this list; scheduleProfileSync ships to the
// server which merges using the earliest-known timestamp.
const INVENTORY_KEY = "brambletooth.inventory";
// Per-character cumulative XP map. localStorage key holds a
// JSON object of { characterId: xp }. Levels derive from XP via
// leveling.ts (xpForLevel). v1 keeps this client-only; cross-
// device sync can be added by extending the profile sync route.
const CHARACTER_XP_KEY = "brambletooth.characterXp";
// AI difficulty tier for VS-Computer rounds, persisted across
// sessions. Default = "normal" (AI mirrors the player's level).
const AI_DIFFICULTY_KEY = "brambletooth.aiDifficulty";
interface PurchasedItem { id: string; purchasedAt: number; }

// Sprint Boots shop item — gates the in-game sprint key. Bigfoot
// god-mode also gets it for free so test runs don't have to grind
// 700 points first.
function hasSprintBoots(): boolean {
  if (loggedIn && isInvincibleProfile(getName(), getPin())) return true;
  return isItemOwned("sprint_boots");
}

// Whether a character is available to the local player. Any
// character whose SHOP_CATALOG entry has kind "character" + a
// characterId field is locked until purchased. Characters that
// aren't gated by any shop entry are always available. Bigfoot
// god-mode unlocks everything for testing.
function isCharacterUnlocked(characterId: string): boolean {
  if (loggedIn && isInvincibleProfile(getName(), getPin())) return true;
  // Scan the catalog for a character-kind item whose characterId
  // matches; if found, the character is gated on that item.
  for (const id of Object.keys(SHOP_CATALOG)) {
    const item = SHOP_CATALOG[id];
    if (!item || item.kind !== "character") continue;
    if (item.characterId !== characterId) continue;
    return isItemOwned(id);
  }
  // No gate — always available.
  return true;
}

function getInventory(): PurchasedItem[] {
  try {
    const raw = localStorage.getItem(INVENTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PurchasedItem[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item === "string") {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push({ id: item, purchasedAt: 0 });
      } else if (
        item && typeof item === "object" &&
        typeof (item as { id?: unknown }).id === "string"
      ) {
        const obj = item as { id: string; purchasedAt?: number };
        if (seen.has(obj.id)) continue;
        seen.add(obj.id);
        out.push({ id: obj.id, purchasedAt: Number(obj.purchasedAt) || 0 });
      }
    }
    return out;
  } catch { return []; }
}
function saveInventory(list: PurchasedItem[]): void {
  try { localStorage.setItem(INVENTORY_KEY, JSON.stringify(list)); }
  catch { /* ignore */ }
}
function isItemOwned(id: string): boolean {
  return getInventory().some((p) => p.id === id);
}

// ---- Character XP storage (per-character leveling) ----
// All persisted as JSON in CHARACTER_XP_KEY: { [characterId]: xp }.
// Levels are derived on read via leveling.levelFromXp — we store
// only the cumulative XP so the curve can be retuned later without
// invalidating existing data.
function getAllCharacterXp(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CHARACTER_XP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
    }
    return out;
  } catch { return {}; }
}
function saveAllCharacterXp(map: Record<string, number>): void {
  try { localStorage.setItem(CHARACTER_XP_KEY, JSON.stringify(map)); }
  catch { /* ignore */ }
}
function getCharacterXp(characterId: string): number {
  return getAllCharacterXp()[characterId] ?? 0;
}
function getCharacterLevel(characterId: string): number {
  return levelFromXp(getCharacterXp(characterId));
}
function addCharacterXp(characterId: string, amount: number): void {
  if (amount <= 0) return;
  const all = getAllCharacterXp();
  all[characterId] = (all[characterId] ?? 0) + Math.floor(amount);
  saveAllCharacterXp(all);
}

// Draw the 5-pill AI difficulty selector at the bottom-center of the
// character-select screen. One pill per tier — the active pill gets
// a brighter fill + a yellow outline; the rest are muted. Each pill
// pushes its rect into difficultyPillBtns so handleTitleTap can
// route clicks back to setAiDifficulty.
function drawAiDifficultyBar(dims: { w: number; h: number }): void {
  difficultyPillBtns = [];
  const cw = dims.w;
  const ch = dims.h;
  const current = getAiDifficulty();
  const labels: AiDifficulty[] = AI_DIFFICULTIES;
  // Pill geometry — sized to fit five pills inside ~640px.
  const pillW = 96;
  const pillH = 32;
  const gap = 8;
  const totalW = labels.length * pillW + (labels.length - 1) * gap;
  // Center the row on the SelectScreen's grid column, NOT the
  // viewport center. On wide screens (iPad, large desktops) the
  // detail card sits to the right of the grid, and a screen-
  // centered pill row would bleed under it. The grid column is
  // where the START button lives, so the pills sit directly
  // above START.
  const gridCenterX = selectScreen.getGridCenterX(cw);
  const startX = gridCenterX - totalW / 2;
  // Position the row clearly ABOVE the SelectScreen's START button.
  // SelectScreen places the start button near `ch - 100` and it's
  // 56px tall, so the pill row goes well above that top edge with
  // breathing room for the AI DIFFICULTY label.
  const y = ch - 180;
  // Header label.
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("AI DIFFICULTY", gridCenterX, y - 8);
  for (let i = 0; i < labels.length; i++) {
    const d = labels[i]!;
    const isActive = d === current;
    const x = startX + i * (pillW + gap);
    const rect: Rect = { x, y, w: pillW, h: pillH };
    // Body.
    ctx.fillStyle = isActive ? "rgba(80, 60, 18, 0.85)" : "rgba(28, 32, 30, 0.85)";
    roundRect(rect, 8);
    ctx.fill();
    ctx.strokeStyle = isActive ? "#ffd84a" : "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = isActive ? 2 : 1;
    roundRect(rect, 8);
    ctx.stroke();
    // Label.
    ctx.fillStyle = isActive ? "#fff" : "rgba(255, 255, 255, 0.6)";
    ctx.font = isActive
      ? "bold 12px system-ui, sans-serif"
      : "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(aiDifficultyLabel(d), x + pillW / 2, y + pillH / 2 + 1);
    ctx.textBaseline = "alphabetic";
    difficultyPillBtns.push({ d, rect });
  }
}

// Stamp levels onto every freshly-spawned character in a local-play
// world. The player character (isPlayer) uses the local profile's
// XP for that character; every AI character gets a jittered level
// based on the player's level + the current AI difficulty offset.
// Called once right after mode.initialize() in startRound + startFFARound.
function applyLevelsToWorld(world: World): void {
  let playerLevel = 0;
  for (const c of world.allCharacters()) {
    if (c.isPlayer) {
      playerLevel = getCharacterLevel(c.characterId);
      applyLevelToCharacter(c, playerLevel);
    }
  }
  const diff = getAiDifficulty();
  for (const c of world.allCharacters()) {
    if (c.isPlayer) continue;
    const aiLevel = jitteredAiLevel(playerLevel, diff);
    applyLevelToCharacter(c, aiLevel);
    // Layer the AI difficulty tier multiplier ON TOP of leveling so
    // the spread between Noob and Legendary is felt instantly even
    // at level 0 — Noob AI sits at 30% stats (a baby could win),
    // Legendary at 400% (almost impossible).
    applyDifficultyMult(c, diff);
  }
}

// ---- AI difficulty (VS Computer) ----
function getAiDifficulty(): AiDifficulty {
  try {
    const raw = localStorage.getItem(AI_DIFFICULTY_KEY);
    if (raw && AI_DIFFICULTIES.includes(raw as AiDifficulty)) return raw as AiDifficulty;
  } catch { /* ignore */ }
  return "normal";
}
function setAiDifficulty(d: AiDifficulty): void {
  try { localStorage.setItem(AI_DIFFICULTY_KEY, d); } catch { /* ignore */ }
}

// ---- Difficulty sweep tracking (Difficult/Legendary achievements) ----
// localStorage key holds a JSON object of { difficulty: characterId[] }.
// "Defeating a character" = winning a round at that difficulty with
// that AI character in the world. When the recorded set contains
// every CHARACTERS id at a given tier, the corresponding sweep
// achievement fires + a one-time point bonus is awarded.
const DEFEATED_KEY = "brambletooth.defeatedAt";
const POINTS_DIFFICULT_SWEEP = 50;
const POINTS_LEGENDARY_SWEEP = 100;
function getAllDefeats(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(DEFEATED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((s): s is string => typeof s === "string");
    }
    return out;
  } catch { return {}; }
}
function getDefeatsAt(diff: AiDifficulty): Set<string> {
  return new Set(getAllDefeats()[diff] ?? []);
}
function addDefeatedAt(diff: AiDifficulty, charIds: string[]): void {
  if (charIds.length === 0) return;
  const all = getAllDefeats();
  const set = new Set(all[diff] ?? []);
  for (const id of charIds) set.add(id);
  all[diff] = [...set];
  try { localStorage.setItem(DEFEATED_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}
// True when every CHARACTERS id is in the recorded defeat set for
// the given tier. Used to gate the sweep achievement + bonus.
function isSweepComplete(diff: AiDifficulty): boolean {
  const defeated = getDefeatsAt(diff);
  for (const id of Object.keys(CHARACTERS)) {
    if (!defeated.has(id)) return false;
  }
  return true;
}

// ---- Completed-maps storage (campaign progress) ----
const COMPLETED_MAPS_KEY = "brambletooth.completedMaps";
function getCompletedMaps(): string[] {
  try {
    const raw = localStorage.getItem(COMPLETED_MAPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => typeof s === "string");
  } catch { return []; }
}
function saveCompletedMaps(list: string[]): void {
  try { localStorage.setItem(COMPLETED_MAPS_KEY, JSON.stringify(list)); }
  catch { /* ignore */ }
}
function isMapCompleted(id: string): boolean {
  return getCompletedMaps().includes(id);
}
function markMapCompleted(id: string): void {
  const list = getCompletedMaps();
  if (list.includes(id)) return;
  list.push(id);
  saveCompletedMaps(list);
  scheduleProfileSync();
  // Also push to the connected multiplayer server (if any) so future
  // lobbies include this map in the vote intersection.
  if (net) net.sendCompletedMaps(list);
  // Visible confirmation — if the player doesn't see this banner
  // after a win, the credit path didn't fire and something else is
  // wrong. Names the map + next-up so the unlock chain is legible.
  const map = getMap(id);
  if (map) {
    const world = getWorld(map.worldId);
    const idx = world ? world.maps.findIndex((m) => m.id === id) : -1;
    const next = world && idx >= 0 && idx + 1 < world.maps.length
      ? world.maps[idx + 1]
      : null;
    const tail = next ? ` · ${next.name} unlocked` : "";
    fireAchievementBanner(`${map.name.toUpperCase()} COMPLETED${tail}`);
  }
}

// Achievements that prove a specific map was beaten. If an
// achievement is earned but the map id isn't in completedMaps,
// localProgress() backfills it on the fly — the UI treats the
// achievement as authoritative truth that you've beaten the map.
// Catches any drift where the credit path missed for an old build,
// a sync race, or anything else stale.
//
// Every map gets an entry pointing to a `<world>_world_<n>`
// achievement id. The catalog only ships forest_world_1 today, so
// the other entries are inert until those achievements are added —
// but having them mapped here means the day they go in the catalog
// they instantly become a self-healing backfill source for any
// drift the sync clobber bug (now fixed) may have caused.
const ACHIEVEMENT_IMPLIES_MAP: Record<string, string> = {
  forest_world_1: "forest_1",
  forest_world_2: "forest_2",
  forest_world_3: "forest_3",
  forest_world_4: "forest_4",
  forest_world_5: "forest_5",
  factory_world_1: "factory_1",
  factory_world_2: "factory_2",
  factory_world_3: "factory_3",
};

// Map id → the achievement id that says "you've beaten this map".
// Inverse of ACHIEVEMENT_IMPLIES_MAP, computed once at module load.
// processAwards reads this on a survivor exit so the achievement
// granted matches the map the player actually finished.
const MAP_TO_ACHIEVEMENT: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [ach, map] of Object.entries(ACHIEVEMENT_IMPLIES_MAP)) {
    out[map] = ach;
  }
  return out;
})();

// Snapshot of the local profile's progress, used by the registry's
// pure unlock-check helpers (isWorldUnlocked, isMapPlayable*, etc.).
function localProgress(): ProfileProgress {
  const set = new Set(getCompletedMaps());
  // Backfill from earned achievements — the achievement is granted on
  // a real exit, so if you earned it, the map was beaten regardless
  // of whether the completedMaps write landed.
  for (const a of getEarnedAchievements()) {
    const mapId = ACHIEVEMENT_IMPLIES_MAP[a.id];
    if (mapId) set.add(mapId);
  }
  const purchased = getInventory().map((p) => p.id);
  // Bigfoot god mode (testing): treat every map as completed AND
  // every world-unlock shop token as owned, so Campaign / Vs Computer
  // can play any map and every world is reachable. NOT written to
  // localStorage — non-Bigfoot logins on the same device stay honest.
  if (loggedIn && isInvincibleProfile(getName(), getPin())) {
    for (const w of WORLDS) for (const m of w.maps) set.add(m.id);
    for (const id of Object.keys(SHOP_CATALOG)) {
      if (SHOP_CATALOG[id]?.kind === "world") purchased.push(id);
    }
  }
  return {
    completedMaps: [...set],
    purchasedItems: purchased,
  };
}

// Try to purchase the given item. Returns:
//   "ok"           — purchased, points debited, sync scheduled
//   "owned"        — already owned (no-op)
//   "not_logged_in"— login required to buy (browse is allowed)
//   "broke"        — not enough points
//   "unknown"      — item id not in catalog
type PurchaseResult = "ok" | "owned" | "not_logged_in" | "broke" | "unknown";
function purchaseItem(id: string): PurchaseResult {
  const item = SHOP_CATALOG[id];
  if (!item) return "unknown";
  if (isItemOwned(id)) return "owned";
  if (!loggedIn) return "not_logged_in";
  if (getPoints() < item.price) return "broke";
  addPoints(-item.price);
  const inv = getInventory();
  inv.push({ id, purchasedAt: Date.now() });
  saveInventory(inv);
  scheduleProfileSync();
  playSound("achievement"); // re-use the triumphant arpeggio for buys
  fireAchievementBanner(`Purchased ${item.name}!`);
  return "ok";
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

// Top-right banner that pops for ~3.5s when an achievement is earned or
// a shop item is purchased. Small (320x56), single-line, anchored below
// the multiplayer survivor list when one is visible.
function drawAchievementBanner(dims: { w: number; h: number }): void {
  if (!activeBanner) return;
  const age = performance.now() - activeBanner.bornAt;
  if (age > 3500) { activeBanner = null; return; }
  const alpha = age < 250 ? age / 250 : age > 3000 ? (3500 - age) / 500 : 1;
  const pulse = 0.85 + 0.15 * Math.sin(age / 90);
  const cw = dims.w;
  const bw = Math.min(320, cw - 32);
  const bh = 56;
  const bx = cw - 16 - bw;
  // Position below the survivor list when it's on-screen, else at the
  // standard top margin. Survivor list is gameplay-only and we know it
  // sits at SURVIVOR_LIST_TOP with survivorListHeight().
  const activeWorld = play?.world ?? netViewWorld;
  const survivorCount = appMode === "net" && activeWorld
    ? activeWorld.charactersOnTeam("survivor").length
    : 0;
  const listH = survivorListHeight(survivorCount);
  const by = listH > 0 ? SURVIVOR_LIST_TOP + listH + 8 : 14;
  ctx.save();
  ctx.fillStyle = `rgba(20, 30, 28, ${0.92 * alpha})`;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = `rgba(255, 216, 74, ${alpha * pulse})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(255, 216, 74, ${alpha * pulse})`;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.fillText("★ ACHIEVEMENT UNLOCKED ★", bx + bw / 2, by + 14);
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.font = "bold 14px system-ui, sans-serif";
  ctx.fillText(activeBanner.text, bx + bw / 2, by + 36);
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
// Exit-tier bonuses (Forest World Map 1). Stack on top of the base
// POINTS_WIN + POINTS_SURVIVE when a survivor escapes via the exit.
const POINTS_TEAM_EXIT = 10;       // all surviving survivors escaped together
const POINTS_LONE_EXIT = 15;       // only this survivor escaped
const POINTS_PERFECT_LONE = 25;    // lone exit + this survivor collected every nugget
export const POINTS_LEAVE_PENALTY = 15;

interface RoundAwardState {
  prevSurvivorIds: Set<number>;
  // Hunter ids alive last frame — used to detect a hunter falling
  // (Hunter Slayer achievement). Survivors who are alive when a
  // hunter dies are credited.
  prevHunterIds: Set<number>;
  collectedIds: Set<number>;
  endAwarded: boolean;
  lastSeenTeam: "hunter" | "survivor" | null;
  // Lowest hp/maxHp ratio observed for "me" this round — used to detect
  // Untouchable (never dropped below half HP and survived to round end).
  lowestHpRatio: number;
  // Last-frame cooldowns map for the local character. Per-key
  // 0 -> >0 transitions count as an ability cast (Pacifist
  // achievement requires this to stay empty for the whole round).
  myPrevCooldowns: Record<string, number>;
  // Number of abilities the local character has cast this round.
  // Pacifist awards iff this is 0 at round end AND the local team
  // won.
  myAbilityCasts: number;
}
function newAwardState(): RoundAwardState {
  return {
    prevSurvivorIds: new Set(),
    prevHunterIds: new Set(),
    collectedIds: new Set(),
    endAwarded: false,
    lastSeenTeam: null,
    lowestHpRatio: 1,
    myPrevCooldowns: {},
    myAbilityCasts: 0,
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
    state.prevHunterIds = new Set();
    state.collectedIds = new Set();
    state.endAwarded = false;
    state.lowestHpRatio = 1;
    state.myPrevCooldowns = {};
    state.myAbilityCasts = 0;
  }

  // Find / refresh my own entity + team. Cast retains exit + collect
  // fields used by the Forest World Map 1 award block below.
  let me: CharacterEntity | null = null;
  for (const e of world.entities) {
    if (e.kind === "character" && e.id === viewerEntityId) {
      me = e;
      state.lastSeenTeam = e.team;
      const ratio = e.hp / e.maxHp;
      if (ratio < state.lowestHpRatio) state.lowestHpRatio = ratio;
      // Pacifist tracking: an ability is "cast" when its cooldown
      // transitions from 0 (or absent) to > 0 on the local
      // character. Mirrors the snapshot-diff pattern the audio
      // module uses for ability sounds.
      const cdNow = e.cooldowns;
      for (const k of Object.keys(cdNow)) {
        const before = state.myPrevCooldowns[k] ?? 0;
        const after = cdNow[k] ?? 0;
        if (before <= 0 && after > 0) state.myAbilityCasts += 1;
      }
      state.myPrevCooldowns = { ...cdNow };
      break;
    }
  }

  // Hunter Slayer detection: if a hunter was alive last frame and
  // is gone this frame (engine cleanupDead removes corpses), grant
  // the achievement to the local player IFF they're currently on
  // the survivor team. Awarded immediately on first hunter death;
  // doesn't require the round to end.
  const currentHunterIds = new Set<number>();
  for (const e of world.entities) {
    if (e.kind === "character" && e.team === "hunter") currentHunterIds.add(e.id);
  }
  for (const hid of state.prevHunterIds) {
    if (!currentHunterIds.has(hid) && state.lastSeenTeam === "survivor") {
      earnAchievement("hunter_slayer");
      break;
    }
  }
  state.prevHunterIds = currentHunterIds;

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
    const localTeamWon =
      state.lastSeenTeam !== null && (
        (outcome === "hunter_win" && state.lastSeenTeam === "hunter") ||
        (outcome === "survivor_win" && state.lastSeenTeam === "survivor")
      );
    // ---- Character XP award (leveling system) ----
    // The character the local player drove this round earns:
    //   - XP_ROUND_COMPLETE (base, any outcome) so even losses
    //     advance the level
    //   - XP_WIN_BONUS if the local team won
    //   - XP_OBJECTIVE per objective the local survivor collected
    //   - XP_KILL per catch (hunter side) — survivors get no kill
    //     XP since they don't kill anyone
    // Persisted to localStorage so progress sticks between sessions.
    if (me) {
      let xp = XP_ROUND_COMPLETE;
      if (localTeamWon) xp += XP_WIN_BONUS;
      if (me.team === "survivor") {
        xp += me.objectivesCollected * XP_OBJECTIVE;
      } else if (me.team === "hunter") {
        // The catch detection block above tracks catches per round
        // in state.prevSurvivorIds → currentSurvivorIds delta and
        // already pays points. Use the same shape: every survivor
        // that was in prevSurvivorIds and is gone now counts as a
        // kill credited to this hunter.
        let kills = 0;
        for (const id of state.prevSurvivorIds) {
          if (!currentSurvivorIds.has(id)) kills++;
        }
        xp += kills * XP_KILL;
      }
      addCharacterXp(me.characterId, xp);
    }
    if (localTeamWon) addPoints(POINTS_WIN);
    // ---- Difficulty sweep tracking ----
    // Local single-player only (not MP, not FFA). On a win at
    // Difficult or Legendary, record every AI character that was in
    // the world this round as "defeated at this difficulty." Once
    // the recorded set covers every CHARACTERS id at that tier, fire
    // the sweep achievement + a one-time point bonus.
    if (localTeamWon && appMode === "local" && play) {
      const diff = getAiDifficulty();
      if (diff === "difficult" || diff === "legendary") {
        const aiIds: string[] = [];
        for (const e of world.entities) {
          if (e.kind === "character" && !e.isPlayer) aiIds.push(e.characterId);
        }
        if (aiIds.length > 0) {
          addDefeatedAt(diff, aiIds);
          if (isSweepComplete(diff)) {
            const achId = diff === "difficult" ? "difficult_sweep" : "legendary_sweep";
            const bonus = diff === "difficult"
              ? POINTS_DIFFICULT_SWEEP
              : POINTS_LEGENDARY_SWEEP;
            // earnAchievement is idempotent — the bonus addPoints only
            // fires the FIRST time the achievement is granted because we
            // check the achievement-earned set before paying out.
            if (!isAchievementEarned(achId)) {
              earnAchievement(achId);
              addPoints(bonus);
              fireAchievementBanner(
                `${diff === "difficult" ? "DIFFICULT" : "LEGENDARY"} SWEEP · +${bonus}`,
              );
            }
          }
        }
      }
    }
    if (state.lastSeenTeam === "survivor" && me && me.hp > 0) {
      addPoints(POINTS_SURVIVE);
      // Untouchable: survivor finished alive AND never dropped below half
      // HP during the round.
      if (state.lowestHpRatio >= 0.5) earnAchievement("untouchable");
    }
    // Pacifist: win the round without casting a single ability.
    // Counter is reset to 0 on round re-arm and incremented on
    // every 0->>0 cooldown transition seen on the local
    // character. Granted regardless of team (a no-cast hunter
    // win counts too) — the badge rewards the discipline.
    if (localTeamWon && state.myAbilityCasts === 0) {
      earnAchievement("pacifist");
    }
    // ---- Survivor-exit achievements + bonus tiers ----
    // Run this BEFORE the map-completion block so the
    // completion banner ('THE GLADE COMPLETED · Streams unlocked')
    // is the final one shown — otherwise the LONE EXIT / PERFECT
    // LONE banner here overwrites it within the same tick and the
    // player never sees the unlock callout.
    if (me && me.team === "survivor" && me.exited) {
      // Map-specific completion achievement. Falls back to nothing
      // if the current map has no achievement assigned (earnAchievement
      // no-ops on unknown ids, so it's safe even with a stale catalog).
      const currentMapId = appMode === "local" && play
        ? play.mapId
        : net?.chosenMapId ?? null;
      if (currentMapId) {
        const ach = MAP_TO_ACHIEVEMENT[currentMapId];
        if (ach) earnAchievement(ach);
      }
      const allSurvivors: CharacterEntity[] = [];
      for (const e of world.entities) {
        if (e.kind === "character" && e.team === "survivor") allSurvivors.push(e);
      }
      const exitedCount = allSurvivors.filter((s) => s.exited).length;
      const isLone = exitedCount === 1;
      const allExited =
        allSurvivors.length > 1 && exitedCount === allSurvivors.length;
      const myCount = me.objectivesCollected;
      const teamCount = allSurvivors.reduce((s, c) => s + c.objectivesCollected, 0);
      const perfectLone = isLone && myCount >= 5 && teamCount === myCount;
      if (perfectLone) {
        addPoints(POINTS_PERFECT_LONE);
        fireAchievementBanner(`PERFECT LONE EXIT · +${POINTS_PERFECT_LONE}`);
      } else if (isLone) {
        addPoints(POINTS_LONE_EXIT);
        fireAchievementBanner(`LONE EXIT · +${POINTS_LONE_EXIT}`);
      } else if (allExited) {
        addPoints(POINTS_TEAM_EXIT);
        fireAchievementBanner(`TEAM EXIT · +${POINTS_TEAM_EXIT}`);
      }
    }
    // ---- Map completion (campaign progress) ----
    // Fires LAST so its banner ('THE GLADE COMPLETED · Streams
    // unlocked') is the active one when the player looks. Credits
    // on either signal so any path of victory unlocks the next map.
    const localSurvivorExited =
      me != null && me.team === "survivor" && me.exited;
    if (localTeamWon || localSurvivorExited) {
      const mapId = appMode === "local" && play
        ? play.mapId
        : net?.chosenMapId ?? null;
      if (mapId) markMapCompleted(mapId);
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
  // Poll the gamepad ONCE at the top of the frame so every
  // downstream reader (HumanController, Start->pause below, the
  // touch-mode latch checks) sees the same per-frame snapshot.
  pollGamepad(input);
  // Start button on a controller toggles pause when we're in
  // active local gameplay. Multiplayer pause goes through its
  // own server-side path so we leave that alone for v1.
  if (input.gamepadStartPressed) {
    input.gamepadStartPressed = false;
    if (appMode === "local" && play && scene === "playing") {
      play.engine.paused = !play.engine.paused;
    }
  }
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

  // Shared top bar — Back top-left + Profile/Settings/Logout
  // top-right — drawn on every non-playing page. Skipped during
  // active gameplay so it doesn't sit on top of the HUD; the
  // pause overlay's Leave Game button is the only mid-round exit.
  const inGameplayNow =
    (appMode === "local" && scene === "playing" && !!play) ||
    (appMode === "net" && (net?.phase === "playing" || net?.phase === "ended"));
  if (!inGameplayNow) drawTopBar(dims);
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
