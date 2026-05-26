// Abilities are data: each one is a definition with a cooldown and a
// handler function that mutates the world. The character data references
// abilities by id. Adding a new ability = adding one entry to this file.

import type { CharacterEntity, ProjectileEntity, TrapEntity } from "../core/entity";
import type { World } from "../core/world";
import type { Vec2 } from "../core/math";
import { normalize, sub, scale, add, dist } from "../core/math";

export interface AbilityContext {
  world: World;
  caster: CharacterEntity;
  // World-space aim point (mouse position projected to ground).
  aim: Vec2;
}

export interface AbilityDef {
  id: string;
  name: string;
  description: string;
  cooldown: number; // seconds
  // Key binding hint for HUD. The actual key mapping is per-slot.
  // 'active' abilities run on key press. We could add 'passive' or 'channeled'
  // later without changing the engine surface.
  cast: (ctx: AbilityContext) => void;
}

// Registry — populated by character files at import time.
export const ABILITIES: Record<string, AbilityDef> = {};

export function registerAbility(def: AbilityDef): void {
  if (ABILITIES[def.id]) {
    console.warn(`Ability ${def.id} already registered, overwriting`);
  }
  ABILITIES[def.id] = def;
}

// ---- Slagy's abilities ----

registerAbility({
  id: "slash",
  name: "Slash",
  description: "Short melee swipe in front of you.",
  cooldown: 0.6,
  cast: ({ world, caster, aim }) => {
    const dir = normalize(sub(aim, caster.pos));
    const reach = 60;
    const arcRadius = 45;
    // Hit point is in front of caster.
    const hitCenter = add(caster.pos, scale(dir, reach * 0.6));
    // Damage any survivor within the swing arc.
    for (const e of world.charactersOnTeam("survivor")) {
      if (dist(e.pos, hitCenter) <= arcRadius + e.radius) {
        e.hp -= 18;
      }
    }
    // Visual: spawn a short-lived projectile-style marker (no collision)
    // for feedback. We use ttl<0.1 to render as a slash flash.
    world.spawn<ProjectileEntity>({
      kind: "projectile",
      pos: hitCenter,
      radius: arcRadius,
      vel: { x: 0, y: 0 },
      ownerId: caster.id,
      ttl: 0.12,
      damage: 0, // already applied
      targetTeam: "survivor",
      dead: false,
    });
  },
});

registerAbility({
  id: "slime_shot",
  name: "Slime Shot",
  description: "Ranged glob that slows on hit.",
  cooldown: 1.2,
  cast: ({ world, caster, aim }) => {
    const dir = normalize(sub(aim, caster.pos));
    const speed = 320;
    world.spawn<ProjectileEntity>({
      kind: "projectile",
      pos: { ...caster.pos },
      radius: 10,
      vel: scale(dir, speed),
      ownerId: caster.id,
      ttl: 1.5,
      damage: 12,
      targetTeam: "survivor",
      slowOnHit: 1.0,
      dead: false,
    });
  },
});

registerAbility({
  id: "slime_trap",
  name: "Slime Trap",
  description: "Place a sticky trap that damages and slows.",
  cooldown: 4.0,
  cast: ({ world, caster }) => {
    // Drop at caster feet
    world.spawn<TrapEntity>({
      kind: "trap",
      pos: { ...caster.pos },
      radius: 28,
      ownerId: caster.id,
      ttl: 12.0,
      damage: 15,
      slowDuration: 1.5,
      targetTeam: "survivor",
      armDelay: 0.4,
      triggered: false,
      dead: false,
    });
  },
});

registerAbility({
  id: "relocate",
  name: "Relocate",
  description: "Teleport a short distance toward your aim.",
  cooldown: 6.0,
  cast: ({ world, caster, aim }) => {
    const dir = normalize(sub(aim, caster.pos));
    const distance = 180;
    const target = add(caster.pos, scale(dir, distance));
    // Clamp inside arena.
    const b = world.arena.bounds;
    target.x = Math.max(b.minX + caster.radius, Math.min(b.maxX - caster.radius, target.x));
    target.y = Math.max(b.minY + caster.radius, Math.min(b.maxY - caster.radius, target.y));
    caster.pos = target;
  },
});

// ---- Match's abilities ----

registerAbility({
  id: "overdrive",
  name: "Overdrive",
  description: "Temporary speed boost.",
  cooldown: 5.0,
  cast: ({ caster }) => {
    caster.statuses["overdrive"] = 2.5; // seconds
  },
});

registerAbility({
  id: "glitch",
  name: "Glitch",
  description: "Short-range teleport.",
  cooldown: 3.5,
  cast: ({ world, caster, aim }) => {
    const dir = normalize(sub(aim, caster.pos));
    const distance = 140;
    const target = add(caster.pos, scale(dir, distance));
    const b = world.arena.bounds;
    target.x = Math.max(b.minX + caster.radius, Math.min(b.maxX - caster.radius, target.x));
    target.y = Math.max(b.minY + caster.radius, Math.min(b.maxY - caster.radius, target.y));
    caster.pos = target;
    // Small i-frame: grant brief "phased" status (1.0s of damage immunity could go here)
    caster.statuses["phased"] = 0.25;
  },
});
