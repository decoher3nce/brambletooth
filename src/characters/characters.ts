// Each character is a data record. Adding new characters = adding entries
// here (and any new abilities they need in abilities.ts).

import { MAGNEK_PLATE_CAP, NECRO_ZOMBIE_CAP, NECRO_COMMAND_DURATION } from "../abilities/abilities";

export type CharacterRole = "hunter" | "survivor" | "flex";

export interface DisplayStat {
  label: string;
  value: string;
}

export interface CharacterDef {
  id: string;
  name: string;
  role: CharacterRole;
  maxHp: number;
  speed: number;
  radius: number;
  color: string;       // body fill
  colorDark: string;   // shading
  // Ability slot ordering. Up to 4. First two are "starting" abilities.
  abilities: [string, string?, string?, string?];
  // Short flavor paragraph shown on the select screen detail card.
  narrative: string;
  // Stats list for the select screen. A function (not a data array) so it
  // can read live ability cooldowns / charge times / tuning constants
  // without depending on module-load ordering — single source of truth.
  displayStats: () => DisplayStat[];
}

export const CHARACTERS: Record<string, CharacterDef> = {
  slagy: {
    id: "slagy",
    name: "Slagy",
    role: "hunter",
    maxHp: 140,
    speed: 145,
    radius: 22,
    color: "#5fb96b",
    colorDark: "#2f7a3a",
    abilities: ["slash", "slime_shot", "slime_trap", "relocate"],
    narrative:
      "Hulking forest hunter, slime-spitter and trap-setter. Closes gaps with brutal teleports. The first thing other survivors warn each other about.",
    displayStats: () => [
      { label: "HP", value: "140" },
      { label: "Speed", value: "145" },
    ],
  },
  match: {
    id: "match",
    name: "Match",
    role: "survivor",
    maxHp: 80,
    speed: 165,
    radius: 16,
    color: "#ff8a3d",
    colorDark: "#b8501a",
    abilities: ["overdrive", "glitch"],
    narrative:
      "Fast, light, no offense — just runs. Built for evasion. The flame that won't sit still.",
    displayStats: () => [
      { label: "HP", value: "80" },
      { label: "Speed", value: "165" },
      { label: "Overdrive boost", value: "1.35× for 2.5s" },
      { label: "Glitch range", value: "140 units" },
    ],
  },
  magnek: {
    id: "magnek",
    name: "Magnek",
    role: "survivor",
    maxHp: 100,
    speed: 145,
    radius: 17,
    color: "#5a8fc8",
    colorDark: "#274c75",
    abilities: ["place_plate", "magnesis"],
    narrative:
      "Magnetic. Places iron plates and yanks himself between them. Pre-positions for safety; vanishes when cornered.",
    displayStats: () => [
      { label: "HP", value: "100" },
      { label: "Speed", value: "145" },
      { label: "Plate cap", value: String(MAGNEK_PLATE_CAP) },
    ],
  },
  necro: {
    id: "necro",
    name: "Necro",
    role: "survivor",
    maxHp: 90,
    speed: 150,
    radius: 15,
    color: "#1a1a22",       // raven black
    colorDark: "#08080c",   // shadow black
    abilities: ["resurrect", "command_attack"],
    narrative:
      "A crow that walks the line between worlds. Raises zombie minions and commands them onto chosen prey. No footsteps — wings carry her over the ground.",
    displayStats: () => [
      { label: "HP", value: "90" },
      { label: "Speed", value: "150" },
      { label: "Zombie cap", value: String(NECRO_ZOMBIE_CAP) },
      { label: "Command duration", value: `${NECRO_COMMAND_DURATION}s` },
    ],
  },
  gravemarch: {
    id: "gravemarch",
    name: "Gravemarch",
    role: "hunter",
    maxHp: 200,
    speed: 115,
    radius: 25,
    color: "#6e7681",     // weathered stone grey
    colorDark: "#3a3e44", // shadow grey
    abilities: ["gravemarch_slash", "rock_wall", "rock_shield", "stone_step"],
    narrative:
      "Hewn from cave stone, slow but unstoppable. Blue veins run hot under the granite skin — the old kind of magic that calls walls up from the floor and tunnels through solid rock.",
    displayStats: () => [
      { label: "HP", value: "200" },
      { label: "Speed", value: "115" },
      { label: "Slash damage", value: "23" },
      { label: "Shield duration", value: "10s" },
    ],
  },
};
