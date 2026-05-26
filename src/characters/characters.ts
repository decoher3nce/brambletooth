// Each character is a data record. Adding new characters = adding entries
// here (and any new abilities they need in abilities.ts).

export type CharacterRole = "hunter" | "survivor" | "flex";

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
  },
};
