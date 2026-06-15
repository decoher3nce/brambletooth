import type { CharacterEntity } from "./entity";

// Character leveling system. Every character starts at level 0 with
// their CHARACTERS-def stats as the baseline; each level above 0
// applies a TINY multiplier to HP, speed, and outgoing damage so a
// higher-level character is meaningfully but not crushingly better.
// Levels below 0 (used for AI difficulty tiers Noob = -20 and
// Easy = -10) apply the inverse — weaker than baseline.
//
// XP is per-character per-profile. It's earned for playing rounds
// (small flat reward), with bonuses for winning, kills (FFA/hunter),
// and objectives (survivor). The curve is tuned so reaching a level
// takes a handful of rounds at the chosen character.

// Per-level multipliers. Kept INTENTIONALLY tiny so a level 20
// veteran can't roll a level 0 newbie:
//   HP:     +1.0% per level → +20% at lvl 20, +200% at lvl 100
//   Speed:  +0.3% per level → +6%  at lvl 20
//   Damage: +1.0% per level → +20% at lvl 20
// These are linear in level, not multiplicative-per-level, so the
// scaling stays bounded as players grind.
export const LEVEL_HP_PER_LEVEL = 0.010;
export const LEVEL_SPEED_PER_LEVEL = 0.003;
export const LEVEL_DAMAGE_PER_LEVEL = 0.010;

// HP / speed / damage multiplier for the given level. Level 0 → 1.0.
// Lower-bounded at 0.10 so a Noob (-20) doesn't end up with negative
// HP or damage from extreme stacking.
export function hpMultForLevel(level: number): number {
  return Math.max(0.10, 1 + level * LEVEL_HP_PER_LEVEL);
}
export function speedMultForLevel(level: number): number {
  return Math.max(0.30, 1 + level * LEVEL_SPEED_PER_LEVEL);
}
export function damageMultForLevel(level: number): number {
  return Math.max(0.10, 1 + level * LEVEL_DAMAGE_PER_LEVEL);
}

// XP curve. Level N requires `xpForLevel(N)` cumulative XP from 0.
// Tuned to (roughly) — each level costs slightly more than the last
// so the early levels feel quick and the high levels feel earned.
//   Lvl 1 → 10 XP
//   Lvl 5 → 60 XP
//   Lvl 10 → 145 XP
//   Lvl 20 → 390 XP
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  // Sum of arithmetic progression: each level costs 10 + 2*(L-1) XP.
  return level * 10 + level * (level - 1);
}

// Inverse: derive level from cumulative XP. Bounded at MAX_LEVEL so a
// runaway grind doesn't push past the design envelope.
export const MAX_LEVEL = 100;
export function levelFromXp(xp: number): number {
  if (xp <= 0) return 0;
  let lvl = 0;
  // Walk upward until the next-level cost exceeds the XP pool. Cheap
  // for any realistic XP value (≤ MAX_LEVEL iterations).
  while (lvl < MAX_LEVEL && xpForLevel(lvl + 1) <= xp) lvl++;
  return lvl;
}

// Per-round XP awards. Sum of base + bonuses, applied to the
// character the local player drove this round.
export const XP_ROUND_COMPLETE = 1;   // any round end
export const XP_WIN_BONUS = 3;        // local team won
export const XP_KILL = 2;             // per kill credited to the player
export const XP_OBJECTIVE = 1;        // per objective the local survivor collected

// AI difficulty tiers — VS Computer character-select tier selector.
// Each tier maps to a per-AI-character level offset added on top of
// the local player's character level. With the player at lvl L:
//   Noob       → AI char ~ lvl L - 20 (notably weaker)
//   Easy       → AI char ~ lvl L - 10
//   Normal     → AI char ~ lvl L      (mirror match)
//   Difficult  → AI char ~ lvl L + 10
//   Legendary  → AI char ~ lvl L + 20
// Spawn-time jitter (see jitteredAiLevel) varies per character so a
// 5-AI lineup doesn't end up homogeneous.
export type AiDifficulty = "noob" | "easy" | "normal" | "difficult" | "legendary";
export const AI_DIFFICULTIES: AiDifficulty[] = ["noob", "easy", "normal", "difficult", "legendary"];

export function aiLevelOffset(diff: AiDifficulty): number {
  switch (diff) {
    case "noob":      return -20;
    case "easy":      return -10;
    case "normal":    return 0;
    case "difficult": return 10;
    case "legendary": return 20;
  }
}
export function aiDifficultyLabel(diff: AiDifficulty): string {
  switch (diff) {
    case "noob":      return "Noob";
    case "easy":      return "Easy";
    case "normal":    return "Normal";
    case "difficult": return "Difficult";
    case "legendary": return "Legendary";
  }
}

// Pick a level for one AI character given the player's level and the
// chosen difficulty tier. Adds uniform jitter ±AI_LEVEL_JITTER so
// a multi-AI lineup at "Normal" varies (e.g. one bot lvl 18, one lvl
// 22 instead of all at exactly lvl 20). The base offset is preserved
// in expectation — jitter is zero-mean. Clamped at 0 minimum (no
// negative-level AI characters even at Noob with a low player level)
// since negative levels would feel unfair to fight.
export const AI_LEVEL_JITTER = 6;
export function jitteredAiLevel(
  playerLevel: number,
  diff: AiDifficulty,
  rng: () => number = Math.random,
): number {
  const target = playerLevel + aiLevelOffset(diff);
  const noise = (rng() * 2 - 1) * AI_LEVEL_JITTER; // [-J, +J]
  return Math.max(0, Math.round(target + noise));
}

// ---- AI difficulty stat multipliers ----
// These STACK ON TOP of the per-level scaling (applyLevelToCharacter)
// to give the difficulty tier a dramatic gameplay knob without
// bloating the underlying level curve. Per-level scaling stays tiny
// (1% HP / 0.3% speed / 1% damage); the difficulty tier sits on top
// as a separate multiplier so the spread between Noob and Legendary
// is felt instantly even at level 0:
//
//   Noob       — 30% HP / 70% speed / 30% damage  (a baby can win)
//   Easy       — 60% HP / 85% speed / 60% damage
//   Normal     — 100% / 100% / 100%               (baseline mirror)
//   Difficult  — 200% HP / 110% speed / 200% damage
//   Legendary  — 400% HP / 130% speed / 400% damage (almost impossible)
//
// Applied to AI characters ONLY. Player characters get only the level
// multiplier so their progression curve isn't drowned out by tier
// scaling.
export const AI_DIFFICULTY_STAT_MULTS: Record<AiDifficulty, {
  hp: number; speed: number; damage: number;
}> = {
  noob:      { hp: 0.30, speed: 0.70, damage: 0.30 },
  easy:      { hp: 0.60, speed: 0.85, damage: 0.60 },
  normal:    { hp: 1.00, speed: 1.00, damage: 1.00 },
  difficult: { hp: 2.00, speed: 1.10, damage: 2.00 },
  legendary: { hp: 4.00, speed: 1.30, damage: 4.00 },
};

// Apply the AI difficulty tier's stat multiplier on top of whatever
// level scaling was already applied. Multiplies the entity's hp /
// maxHp / speed / damageMult in place. Idempotent in the sense that
// calling it twice would compound — call once per spawn.
export function applyDifficultyMult(c: CharacterEntity, diff: AiDifficulty): void {
  const m = AI_DIFFICULTY_STAT_MULTS[diff];
  c.maxHp = Math.max(1, Math.round(c.maxHp * m.hp));
  c.hp = c.maxHp;
  c.speed = c.speed * m.speed;
  c.damageMult = (c.damageMult ?? 1) * m.damage;
}

// Stamp a level onto a freshly-spawned CharacterEntity. The mode
// initializer spawns characters with their baseline (level-0) stats
// from CHARACTERS; this then rescales hp / maxHp / speed by the
// per-level multipliers and pre-bakes damageMult so ability /
// engine damage paths can read it without doing the lookup again.
// Called from BOTH the local play setup in main.ts AND the
// server-side GameSession after `mode.initialize`.
export function applyLevelToCharacter(c: CharacterEntity, level: number): void {
  c.level = level;
  const hpMult = hpMultForLevel(level);
  c.maxHp = Math.round(c.maxHp * hpMult);
  c.hp = c.maxHp;
  c.speed = c.speed * speedMultForLevel(level);
  c.damageMult = damageMultForLevel(level);
}
