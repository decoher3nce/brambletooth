// World + Map registry. Top-level container ("World") groups a set of
// individual playable levels ("Map"). Campaign mode walks each map in
// a world in sequence; Vs Computer lets the player pick any map the
// world has unlocked; Multiplayer lets the lobby vote on a map from
// the intersection of everyone's completed-maps set.
//
// Add a new map: append a MapDef to a world's `maps` list.
// Add a new world: append a WorldDef to WORLDS, with an `unlock` rule
// describing how a profile earns access (default = always available,
// after-world = needs N maps completed in a previous world, shop = a
// purchase token in inventory).
//
// Each map names its own arena builder. v1 ships exactly the forest
// arena for the one shipped map (Forest Map 1); future maps will
// register their own builders or per-map seeds / arena variations.

import type { ArenaConfig, World } from "../core/world";
import { FOREST_ARENA_CONFIG, buildForest, buildForest2, buildForest3 } from "../arenas/forest";

// How many maps must be completed in a world to unlock the next via
// the default "after-world" gate.
export const WORLDS_REQUIRED_MAPS = 5;

export interface MapDef {
  id: string;          // unique across all worlds — profiles store ids
  name: string;        // "Map 1", "The Glade", etc.
  worldId: string;     // parent world id (denormalized for cheap lookups)
  // Arena config + builder. The builder is called after `new World(config)`
  // to populate props/objectives; the engine spawns characters + the exit.
  arenaConfig: ArenaConfig;
  buildArena: (world: World, seed: number, objectiveCount: number) => void;
}

export type WorldUnlock =
  // Always playable — no campaign progress needed.
  | { kind: "default" }
  // Locked until the player has completed >= mapsNeeded maps in the
  // referenced earlier world.
  | { kind: "after-world"; previousWorldId: string; mapsNeeded: number }
  // Locked until the player owns this shop item (purchased token).
  | { kind: "shop"; shopItemId: string };

export interface WorldDef {
  id: string;
  name: string;            // "Forest World"
  maps: MapDef[];          // ordered; index 0 is the first map
  unlock: WorldUnlock;
  // Optional palette accent for the campaign world card.
  accentColor?: string;
}

// ---- Forest World — only the first map exists today. ----

const FOREST_MAPS: MapDef[] = [
  {
    id: "forest_1",
    name: "Map 1",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    // The current arena builder takes a (world, seed, objectiveCount).
    // HuntMode owns objective spawning so objectiveCount stays 0.
    buildArena: (w, seed) => buildForest(w, seed, 0),
  },
  {
    id: "forest_2",
    name: "Map 2 · Streams",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest2(w, seed, 0),
  },
  {
    id: "forest_3",
    name: "Map 3 · Cliffs",
    worldId: "forest",
    arenaConfig: FOREST_ARENA_CONFIG,
    buildArena: (w, seed) => buildForest3(w, seed, 0),
  },
];

export const WORLDS: WorldDef[] = [
  {
    id: "forest",
    name: "Forest World",
    maps: FOREST_MAPS,
    unlock: { kind: "default" },
    accentColor: "#3a7a3a",
  },
];

// ---- Lookups ----

export function getWorld(worldId: string): WorldDef | undefined {
  return WORLDS.find((w) => w.id === worldId);
}

export function getMap(mapId: string): MapDef | undefined {
  for (const w of WORLDS) {
    for (const m of w.maps) {
      if (m.id === mapId) return m;
    }
  }
  return undefined;
}

// Default first map id — used when nothing else specifies (the title
// "play" button before any map select UI runs).
export function defaultMapId(): string {
  return WORLDS[0]!.maps[0]!.id;
}

// ---- Progress / unlock logic ----

// Profile state these functions operate on. completedMaps and
// purchasedItems live on the persisted profile; they're passed in so
// the registry stays pure and easy to test.
export interface ProfileProgress {
  completedMaps: string[];
  purchasedItems: string[];
}

function countCompletedInWorld(worldId: string, p: ProfileProgress): number {
  const w = getWorld(worldId);
  if (!w) return 0;
  let n = 0;
  for (const m of w.maps) if (p.completedMaps.includes(m.id)) n++;
  return n;
}

export function isWorldUnlocked(worldId: string, p: ProfileProgress): boolean {
  const w = getWorld(worldId);
  if (!w) return false;
  switch (w.unlock.kind) {
    case "default": return true;
    case "after-world":
      return countCompletedInWorld(w.unlock.previousWorldId, p) >= w.unlock.mapsNeeded;
    case "shop":
      return p.purchasedItems.includes(w.unlock.shopItemId);
  }
}

// In Campaign mode, maps unlock sequentially within a world: map N
// requires map N-1 to be completed (or N=0 and the world itself
// unlocked). Already-completed maps are always playable.
export function isMapUnlockedCampaign(mapId: string, p: ProfileProgress): boolean {
  const m = getMap(mapId);
  if (!m) return false;
  if (!isWorldUnlocked(m.worldId, p)) return false;
  const w = getWorld(m.worldId)!;
  const idx = w.maps.findIndex((x) => x.id === mapId);
  if (idx <= 0) return true; // first map is always unlocked in an unlocked world
  // Previous map must be completed.
  return p.completedMaps.includes(w.maps[idx - 1]!.id);
}

// In Vs Computer mode, any map in an unlocked world that the profile
// has completed in Campaign (or is the FIRST map of an unlocked world)
// is playable. Already-played maps stay replayable.
export function isMapPlayableVsComputer(mapId: string, p: ProfileProgress): boolean {
  const m = getMap(mapId);
  if (!m) return false;
  if (!isWorldUnlocked(m.worldId, p)) return false;
  const w = getWorld(m.worldId)!;
  const idx = w.maps.findIndex((x) => x.id === mapId);
  if (idx === 0) return true;
  // Either already completed, or the previous map is completed (so this
  // one is the "next" available).
  if (p.completedMaps.includes(mapId)) return true;
  return p.completedMaps.includes(w.maps[idx - 1]!.id);
}

// Maps available to a multiplayer lobby = intersection of each player's
// vs-computer-playable maps. A non-logged-in player is treated as
// having only the first map of every default-unlocked world.
export function multiplayerCommonMaps(perPlayer: ProfileProgress[]): MapDef[] {
  if (perPlayer.length === 0) return [];
  const out: MapDef[] = [];
  for (const w of WORLDS) {
    for (const m of w.maps) {
      let ok = true;
      for (const p of perPlayer) {
        if (!isMapPlayableVsComputer(m.id, p)) { ok = false; break; }
      }
      if (ok) out.push(m);
    }
  }
  return out;
}
