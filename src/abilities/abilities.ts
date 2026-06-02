// Abilities are data: each one is a definition with a cooldown and a
// handler function that mutates the world. The character data references
// abilities by id. Adding a new ability = adding one entry to this file.

import type {
  CharacterEntity,
  ProjectileEntity,
  TrapEntity,
  PlateEntity,
} from "../core/entity";
import { isPlate } from "../core/entity";
import type { World } from "../core/world";
import type { Vec2 } from "../core/math";
import { normalize, sub, scale, add, dist, distToSegment } from "../core/math";

// Hard cap on plates per Magnek. Placing a (cap+1)th plate evicts the oldest.
// Exported so the character select screen can display it as a stat.
export const MAGNEK_PLATE_CAP = 3;

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
  // Instant abilities run their effect at cast time. Channeled abilities
  // begin a charge timer on cast and run `onChargeComplete` when the
  // timer expires. Engine ticks the channel on the caster.
  cast: (ctx: AbilityContext) => void;
  // If set, casting begins a channel of this duration on the caster.
  // While charging, the cast() callback runs at cast-start (use it to
  // play a windup effect, refuse the cast, etc); onChargeComplete runs
  // when the timer expires.
  chargeTime?: number; // seconds
  onChargeComplete?: (ctx: AbilityContext) => void;
  // Optional gate run at cast-time before any channel begins. Return
  // false to refuse the cast — engine treats it as if no press happened
  // (no cooldown applied, no channel started). Used by abilities like
  // Magnesis that need pre-conditions (e.g., at least one plate placed).
  canCast?: (ctx: AbilityContext) => boolean;
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
    // Also damage animals in the arc — slashing wildlife triggers
    // their flee/chase reaction (the engine's projectile hit path
    // calls reactAnimalToAttack; here we replicate it inline for
    // melee, since slash applies damage directly rather than via a
    // moving projectile).
    for (const e of world.entities) {
      if (e.kind !== "animal" || e.dead) continue;
      if (dist(e.pos, hitCenter) <= arcRadius + e.radius) {
        e.hp -= 18;
        e.targetId = caster.id;
        if (!e.reactionDecided) {
          e.reactionDecided = true;
          const chaseChance = e.species === "bear" ? 0.5 : 0.3;
          if (Math.random() < chaseChance) {
            e.mood = "chase";
            e.moodTimer = 6;
          } else {
            e.mood = "flee";
            e.moodTimer = 5;
          }
        }
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

// ---- Magnek's abilities (placement-based escape survivor) ----

// Helper: list a Magnek's currently placed plates, oldest first.
function platesOwnedBy(world: World, ownerId: number): PlateEntity[] {
  const out: PlateEntity[] = [];
  for (const e of world.entities) {
    if (isPlate(e) && e.ownerId === ownerId) out.push(e);
  }
  out.sort((a, b) => a.placedAt - b.placedAt);
  return out;
}

registerAbility({
  id: "place_plate",
  name: "Place Plate",
  description: "Drop an iron plate. Up to 3 plates; placing a 4th evicts the oldest.",
  cooldown: 2.0,
  cast: ({ world, caster }) => {
    const owned = platesOwnedBy(world, caster.id);
    while (owned.length >= MAGNEK_PLATE_CAP) {
      const oldest = owned.shift();
      if (oldest) oldest.dead = true;
    }
    world.spawn<PlateEntity>({
      kind: "plate",
      pos: { ...caster.pos },
      radius: 18,
      ownerId: caster.id,
      placedAt: world.elapsed,
      dead: false,
    });
  },
});

// Total time of the Magnesis transport arc, in seconds. Used by both
// the engine (drives the position lerp) and the renderer (controls the
// dotted-line trail fade). Long enough to be a tactical commitment;
// short enough to feel snappy.
export const MAGNESIS_TRANSPORT_DURATION = 1.4;

registerAbility({
  id: "magnesis",
  name: "Magnesis",
  description:
    "Channel 1.2s to lock onto a random plate, then hurtle there on a 1.4s eased arc. Vulnerable in flight.",
  cooldown: 5.0,
  chargeTime: 1.2,
  // Refuse the cast if Magnek has no plates placed, OR he's standing
  // in a stream — the water shorts out the magnetic pull. No cd
  // applied either way; feels like the button "didn't take."
  canCast: ({ world, caster }) => {
    if (platesOwnedBy(world, caster.id).length === 0) return false;
    for (const e of world.entities) {
      if (e.kind !== "stream") continue;
      const d = distToSegment(caster.pos, e.a, e.b);
      if (d <= e.width + caster.radius) return false;
    }
    return true;
  },
  cast: () => {
    // No instant effect — the channel windup is the cast. Visual feedback
    // happens via the renderer reading caster.charging.
  },
  onChargeComplete: ({ world, caster }) => {
    const plates = platesOwnedBy(world, caster.id);
    if (plates.length === 0) return; // all plates somehow evicted mid-channel
    const target = plates[Math.floor(Math.random() * plates.length)];
    // Start a transport arc instead of teleporting. The engine
    // drives the lerp + clears caster.transport when it completes.
    // No i-frame: per design, Magnek is vulnerable in flight.
    caster.transport = {
      fromPos: { ...caster.pos },
      toPos: { ...target.pos },
      elapsed: 0,
      duration: MAGNESIS_TRANSPORT_DURATION,
      source: "magnesis",
    };
  },
});
