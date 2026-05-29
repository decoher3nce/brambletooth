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

export interface ProfileRecord {
  name: string;           // canonical (player-typed) form for display
  pin: string;            // 4-digit, plaintext (see security note above)
  points: number;
  achievements: string[]; // earned achievement ids (empty for now)
  createdAt: number;
  updatedAt: number;
}

// Lower-cased name -> profile
type ProfileMap = Record<string, ProfileRecord>;

const PROFILE_FILE = join(process.cwd(), "data", "profiles.json");

let store: ProfileMap = {};
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(PROFILE_FILE)) {
    try {
      store = JSON.parse(readFileSync(PROFILE_FILE, "utf8")) as ProfileMap;
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
  achievements: string[];
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
    },
  };
}

// Update points (and any future profile fields). Defensive: we take the
// max of client and server points so a stale client can't roll us back.
export function syncProfile(
  name: unknown,
  pin: unknown,
  payload: { points?: number; achievements?: string[] },
): LoginResult {
  ensureLoaded();
  if (!isValidName(name)) return { ok: false, error: "Name must be 1-24 characters" };
  if (!isValidPin(pin)) return { ok: false, error: "PIN must be 3-8 digits" };
  const key = keyOf(name);
  const existing = store[key];
  if (!existing) return { ok: false, error: "Profile not found" };
  if (existing.pin !== pin) return { ok: false, error: "Wrong PIN" };
  if (typeof payload.points === "number" && Number.isFinite(payload.points)) {
    existing.points = Math.max(existing.points, Math.floor(payload.points));
  }
  if (Array.isArray(payload.achievements)) {
    // Union of server + client achievements (client can't remove).
    const set = new Set([...(existing.achievements ?? []), ...payload.achievements]);
    existing.achievements = [...set];
  }
  existing.updatedAt = Date.now();
  save();
  return { ok: true, profile: existing };
}
