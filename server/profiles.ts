// Tiny file-backed profile store keyed by player name. Players log in with
// {name, pin}; the server returns their points (or creates a new profile
// the first time). Lets points follow a player across devices and
// sessions over the local Tailnet.
//
// Security note: this is a kid's game on a private Tailscale network. The
// PIN is stored in plaintext in a JSON file next to the server. That's
// intentional — bcrypt-style hashing is overkill for the threat model.
// If we ever expose this beyond the tailnet, switch to hashed PINs and
// add rate limiting.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EarnedAchievement {
  id: string;
  earnedAt: number; // unix ms; 0 = unknown (migrated from legacy string[])
}

export interface PurchasedItem {
  id: string;
  purchasedAt: number; // unix ms; 0 = unknown (migrated from legacy string[])
}

export interface ProfileRecord {
  name: string;                       // canonical (player-typed) form
  pin: string;                        // plaintext (see security note)
  points: number;
  achievements: EarnedAchievement[];  // earned with timestamps
  inventory: PurchasedItem[];         // shop purchases with timestamps
  completedMaps: string[];            // map ids beaten in campaign
  // Per-character cumulative XP. Keys are CHARACTERS ids; values are
  // raw XP totals (level derived via src/core/leveling.levelFromXp).
  // Client + server merge by max-per-key so progress never goes
  // backward on sync.
  characterXp: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

// Lower-cased name -> profile
type ProfileMap = Record<string, ProfileRecord>;

const PROFILE_FILE = join(process.cwd(), "data", "profiles.json");

let store: ProfileMap = {};
let loaded = false;

function migrateAchievements(input: unknown): EarnedAchievement[] {
  if (!Array.isArray(input)) return [];
  const out: EarnedAchievement[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item === "string") {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push({ id: item, earnedAt: 0 });
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      const obj = item as { id: string; earnedAt?: number };
      if (seen.has(obj.id)) continue;
      seen.add(obj.id);
      out.push({ id: obj.id, earnedAt: Number(obj.earnedAt) || 0 });
    }
  }
  return out;
}

// Same shape as migrateAchievements (string[] -> {id, ts}[]) but for the
// shop inventory. Legacy profiles without an inventory field get an
// empty array.
function migrateInventory(input: unknown): PurchasedItem[] {
  if (!Array.isArray(input)) return [];
  const out: PurchasedItem[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item === "string") {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push({ id: item, purchasedAt: 0 });
    } else if (
      item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string"
    ) {
      const obj = item as { id: string; purchasedAt?: number };
      if (seen.has(obj.id)) continue;
      seen.add(obj.id);
      out.push({ id: obj.id, purchasedAt: Number(obj.purchasedAt) || 0 });
    }
  }
  return out;
}

// Normalize a characterXp payload (or stored field) into a clean
// { [characterId]: number } map. Drops keys whose value isn't a
// finite non-negative number; floors the rest. Used both at load
// time and inside the sync route's max-per-key merge.
function migrateCharacterXp(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n);
  }
  return out;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(PROFILE_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as Record<string, unknown>;
      // Migrate legacy string[] achievements to {id, earnedAt}[],
      // and backfill inventory (added later) on existing records.
      for (const key of Object.keys(raw)) {
        const p = raw[key] as ProfileRecord & {
          achievements?: unknown;
          inventory?: unknown;
          characterXp?: unknown;
        };
        if (p) {
          p.achievements = migrateAchievements(p.achievements);
          p.inventory = migrateInventory(p.inventory);
          // Backfill completedMaps on records written before maps existed.
          if (!Array.isArray(p.completedMaps)) p.completedMaps = [];
          // Backfill characterXp (added later).
          p.characterXp = migrateCharacterXp(p.characterXp);
        }
      }
      store = raw as ProfileMap;
    } catch (err) {
      console.warn(`[profiles] failed to read ${PROFILE_FILE}:`, err);
      store = {};
    }
  } else {
    store = {};
  }
}

function save(): void {
  try {
    mkdirSync(dirname(PROFILE_FILE), { recursive: true });
    writeFileSync(PROFILE_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error(`[profiles] failed to write ${PROFILE_FILE}:`, err);
  }
}

function keyOf(name: string): string {
  return name.trim().toLowerCase();
}

function isValidName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 24;
}
function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{3,8}$/.test(pin);
}

export interface LoginResult {
  ok: boolean;
  profile?: ProfileRecord;
  error?: string;
}

// Look up a profile by name; verify PIN if it exists; create a new profile
// (claiming the name with the supplied PIN) if it doesn't.
export function login(name: unknown, pin: unknown): LoginResult {
  ensureLoaded();
  if (!isValidName(name)) return { ok: false, error: "Name must be 1-24 characters" };
  if (!isValidPin(pin)) return { ok: false, error: "PIN must be 3-8 digits" };
  const key = keyOf(name);
  const existing = store[key];
  if (existing) {
    if (existing.pin !== pin) return { ok: false, error: "Wrong PIN for that name" };
    existing.updatedAt = Date.now();
    save();
    return { ok: true, profile: existing };
  }
  const profile: ProfileRecord = {
    name: name.trim(),
    pin,
    points: 0,
    achievements: [],
    inventory: [],
    completedMaps: [],
    characterXp: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store[key] = profile;
  save();
  return { ok: true, profile };
}

// Public lookup by name — returns only the safe fields (name, points,
// achievements). No PIN, no timestamps. Used by the lobby to render
// hover tooltips for other players.
export interface PublicProfile {
  name: string;
  points: number;
  achievements: EarnedAchievement[];
  inventory: PurchasedItem[];
  completedMaps: string[];
  characterXp: Record<string, number>;
}
export function lookupPublic(name: unknown): { ok: boolean; profile?: PublicProfile; error?: string } {
  ensureLoaded();
  if (!isValidName(name)) return { ok: false, error: "Invalid name" };
  const key = keyOf(name);
  const existing = store[key];
  if (!existing) return { ok: false, error: "Not found" };
  return {
    ok: true,
    profile: {
      name: existing.name,
      points: existing.points,
      achievements: existing.achievements ?? [],
      inventory: existing.inventory ?? [],
      completedMaps: existing.completedMaps ?? [],
      characterXp: existing.characterXp ?? {},
    },
  };
}

// Update points (and any future profile fields). The client is the
// authoritative source for its current points total — it pulls the
// canonical value from the server at login, then we trust whatever
// it sends back. This is required so intentional decrements (e.g.,
// the leave-game penalty) actually stick; an earlier Math.max guard
// here silently reverted those.
// Accepts achievements in either the legacy string[] or new
// {id, earnedAt}[] form — migrateAchievements normalizes.
export function syncProfile(
  name: unknown,
  pin: unknown,
  payload: { points?: number; achievements?: unknown; inventory?: unknown; completedMaps?: unknown; characterXp?: unknown },
): LoginResult {
  ensureLoaded();
  if (!isValidName(name)) return { ok: false, error: "Name must be 1-24 characters" };
  if (!isValidPin(pin)) return { ok: false, error: "PIN must be 3-8 digits" };
  const key = keyOf(name);
  const existing = store[key];
  if (!existing) return { ok: false, error: "Profile not found" };
  if (existing.pin !== pin) return { ok: false, error: "Wrong PIN" };
  if (typeof payload.points === "number" && Number.isFinite(payload.points)) {
    existing.points = Math.max(0, Math.floor(payload.points));
  }
  if (Array.isArray(payload.achievements)) {
    // Union of server + client achievements (client can't remove). Merge
    // by id, preserving the EARLIEST known earnedAt (server is canonical
    // first-earn-time).
    const incoming = migrateAchievements(payload.achievements);
    const byId = new Map<string, EarnedAchievement>();
    for (const a of existing.achievements ?? []) byId.set(a.id, a);
    for (const a of incoming) {
      const prev = byId.get(a.id);
      if (!prev) {
        byId.set(a.id, a);
      } else {
        const earliest =
          prev.earnedAt === 0
            ? a.earnedAt
            : a.earnedAt === 0
              ? prev.earnedAt
              : Math.min(prev.earnedAt, a.earnedAt);
        byId.set(a.id, { id: a.id, earnedAt: earliest });
      }
    }
    existing.achievements = [...byId.values()];
  }
  if (Array.isArray(payload.inventory)) {
    // Same union-by-id-with-earliest-timestamp pattern as achievements.
    // The shop debits points on the client and posts the new totals
    // here; the server doesn't re-charge — it just records ownership.
    const incoming = migrateInventory(payload.inventory);
    const byId = new Map<string, PurchasedItem>();
    for (const a of existing.inventory ?? []) byId.set(a.id, a);
    for (const a of incoming) {
      const prev = byId.get(a.id);
      if (!prev) {
        byId.set(a.id, a);
      } else {
        const earliest =
          prev.purchasedAt === 0
            ? a.purchasedAt
            : a.purchasedAt === 0
              ? prev.purchasedAt
              : Math.min(prev.purchasedAt, a.purchasedAt);
        byId.set(a.id, { id: a.id, purchasedAt: earliest });
      }
    }
    existing.inventory = [...byId.values()];
  }
  if (Array.isArray(payload.completedMaps)) {
    // Union of server + client completedMaps (client can't un-complete).
    const set = new Set<string>(existing.completedMaps ?? []);
    for (const id of payload.completedMaps) {
      if (typeof id === "string") set.add(id);
    }
    existing.completedMaps = [...set];
  }
  if (payload.characterXp && typeof payload.characterXp === "object") {
    // Per-character XP: max-per-key merge. The client can't lower a
    // total — it can only contribute new XP earned in rounds it
    // played since the last sync. Same discipline as achievements
    // (server keeps the strictly-better record).
    const incoming = migrateCharacterXp(payload.characterXp);
    const merged: Record<string, number> = { ...(existing.characterXp ?? {}) };
    for (const [k, v] of Object.entries(incoming)) {
      merged[k] = Math.max(merged[k] ?? 0, v);
    }
    existing.characterXp = merged;
  }
  existing.updatedAt = Date.now();
  save();
  return { ok: true, profile: existing };
}
