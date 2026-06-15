// Per-tier behavior configuration for AI characters. The AiDifficulty
// tier (Noob → Legendary) sets a bundle of parameters — aim noise,
// reaction delay, projectile lead, ability hesitation, environment-
// awareness gates — that the per-character AI controllers read at
// their decision points.
//
// See docs/ai-strategies.md for the design table this code mirrors.
//
// Noob produces a "predictable but dumb" opponent: monotone tactic
// choice + bad aim + lots of wasted abilities. Legendary produces a
// "clever and unpredictable" opponent: varied tactical branches,
// perfect aim, projectile leading, environment usage.

import type { AiDifficulty } from "../core/leveling";
import type { Vec2 } from "../core/math";
import { add, scale } from "../core/math";

export interface BehaviorConfig {
  // Random rotation (radians) added to every aim vector. Noob shoots
  // crooked; Legendary shoots straight.
  aimJitter: number;
  // Seconds the AI hesitates before reacting to a freshly-detected
  // threat. Noob gives the player a half-second head start; Legendary
  // reacts the same tick.
  reactionDelay: number;
  // Multiplier on target velocity used when aiming projectiles.
  // 0 = shoots where target was, 1 = full velocity projection. Lower
  // tiers under-lead.
  leadFactor: number;
  // Probability of picking a non-obvious branch in the decision tree.
  // Higher = harder for the player to predict which tactic comes next.
  tacticDiversity: number;
  // Per-tick probability of HOLDING (not firing) an ability that's
  // off-cooldown. Noob frequently forgets to use its kit.
  abilityHesitation: number;
  // Per-tick probability of firing an irrelevant random ability for
  // chaos. Noob occasionally throws abilities away; Legendary never.
  randomActionChance: number;
  // Gate on environment-aware code paths — use props for cover, lure
  // toward animals, push toward streams/lava. Off at low tiers.
  useEnvironment: boolean;
  // When true, the AI projects the target's next ~0.5 s of motion and
  // aims/positions for the predicted arrival point.
  predictMovement: boolean;
}

const NOOB: BehaviorConfig = {
  aimJitter: 0.40,
  reactionDelay: 0.50,
  leadFactor: 0.00,
  tacticDiversity: 0.05,
  abilityHesitation: 0.45,
  randomActionChance: 0.20,
  useEnvironment: false,
  predictMovement: false,
};
const EASY: BehaviorConfig = {
  aimJitter: 0.25,
  reactionDelay: 0.30,
  leadFactor: 0.10,
  tacticDiversity: 0.15,
  abilityHesitation: 0.30,
  randomActionChance: 0.12,
  useEnvironment: false,
  predictMovement: false,
};
const NORMAL: BehaviorConfig = {
  aimJitter: 0.12,
  reactionDelay: 0.15,
  leadFactor: 0.25,
  tacticDiversity: 0.30,
  abilityHesitation: 0.15,
  randomActionChance: 0.05,
  useEnvironment: true,
  predictMovement: false,
};
const DIFFICULT: BehaviorConfig = {
  aimJitter: 0.05,
  reactionDelay: 0.05,
  leadFactor: 0.45,
  tacticDiversity: 0.45,
  abilityHesitation: 0.05,
  randomActionChance: 0.02,
  useEnvironment: true,
  predictMovement: true,
};
const LEGENDARY: BehaviorConfig = {
  aimJitter: 0.00,
  reactionDelay: 0.00,
  leadFactor: 0.70,
  tacticDiversity: 0.65,
  abilityHesitation: 0.00,
  randomActionChance: 0.00,
  useEnvironment: true,
  predictMovement: true,
};

const BY_TIER: Record<AiDifficulty, BehaviorConfig> = {
  noob: NOOB,
  easy: EASY,
  normal: NORMAL,
  difficult: DIFFICULT,
  legendary: LEGENDARY,
};

export function behaviorFor(diff: AiDifficulty): BehaviorConfig {
  return BY_TIER[diff];
}

// Helpers used by per-character AIs to apply the config.

// Apply a uniform-angle jitter (radians) to an aim point, rotating
// the offset around the AI's own position. Noop when jitter is 0.
export function jitterAim(self: Vec2, aim: Vec2, jitter: number): Vec2 {
  if (jitter <= 0) return aim;
  const dx = aim.x - self.x;
  const dy = aim.y - self.y;
  const angle = (Math.random() * 2 - 1) * jitter;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: self.x + dx * c - dy * s,
    y: self.y + dx * s + dy * c,
  };
}

// Compute a predictive aim point that accounts for target velocity.
// At leadFactor = 0, returns target.pos unchanged. At 0.7, returns
// target.pos + target.vel * 0.7. The renderer's lead-shot effect
// already uses something like this for slime_shot.
export function leadAim(targetPos: Vec2, targetVel: Vec2, leadFactor: number): Vec2 {
  if (leadFactor <= 0) return targetPos;
  return add(targetPos, scale(targetVel, leadFactor));
}

// Per-tick "should I HOLD this ability that's off-cd?" gate. Returns
// true when the AI should refuse to fire (chaos/hesitation simulating
// dumber decision making at low tiers).
export function shouldHesitate(cfg: BehaviorConfig): boolean {
  return cfg.abilityHesitation > 0 && Math.random() < cfg.abilityHesitation;
}

// Per-tick "fire a random ability for chaos?" gate. Caller is
// responsible for picking which ability to fire if this returns true.
export function shouldFireRandomly(cfg: BehaviorConfig): boolean {
  return cfg.randomActionChance > 0 && Math.random() < cfg.randomActionChance;
}

// Per-tick "pick the non-obvious tactical branch?" gate. Higher
// tactic diversity = more varied behavior over time.
export function pickAltTactic(cfg: BehaviorConfig): boolean {
  return cfg.tacticDiversity > 0 && Math.random() < cfg.tacticDiversity;
}
