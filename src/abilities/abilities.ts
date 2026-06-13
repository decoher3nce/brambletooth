// Abilities are data: each one is a definition with a cooldown and a
// handler function that mutates the world. The character data references
// abilities by id. Adding a new ability = adding one entry to this file.

import type {
  CharacterEntity,
  ProjectileEntity,
  TrapEntity,
  PlateEntity,
  PropEntity,
  ZombieEntity,
} from "../core/entity";
import { isPlate, isZombie } from "../core/entity";
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
    // Damage anyone (except the caster) within the swing arc.
    // FFA opens the slash to all teams; HuntMode keeps the
    // survivor-only restriction.
    const slashTargets = world.ffaMode
      ? world.allCharacters()
      : world.charactersOnTeam("survivor");
    for (const e of slashTargets) {
      if (e.dead) continue;
      if (e.id === caster.id) continue;
      if (e.statuses["shielded"] > 0) continue;
      if (dist(e.pos, hitCenter) <= arcRadius + e.radius) {
        e.hp -= 18;
        e.lastDamagerId = caster.id;
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
      // Closest segment in the polyline — refuse if it's within reach.
      for (let i = 0; i < e.points.length - 1; i++) {
        const a = e.points[i]!;
        const b = e.points[i + 1]!;
        if (distToSegment(caster.pos, a, b) <= e.width + caster.radius) return false;
      }
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

// ---- Necro's abilities ----

// Hard cap on living zombies per Necro. Resurrect refuses to spawn
// a 4th. Exported so the select screen + AI can read it.
export const NECRO_ZOMBIE_CAP = 3;
// Seconds a commanded zombie stays in chase mode before reverting
// to follow. Tuned for "small swarm window, not a death sentence."
export const NECRO_COMMAND_DURATION = 10;

function livingZombiesOwnedBy(world: World, ownerId: number): ZombieEntity[] {
  const out: ZombieEntity[] = [];
  for (const e of world.entities) {
    if (!isZombie(e) || e.dead) continue;
    if (e.ownerId === ownerId) out.push(e);
  }
  return out;
}

// Pick the character closest to `aim` (any team), within
// PICK_RANGE world units of it. Returns null if no character is
// near the aim point — the command_attack ability uses this to
// refuse a cast aimed at empty ground. The caster is EXCLUDED:
// Necro can never command her own swarm onto herself, even if her
// aim happens to land near her own body during a panicked cast.
const COMMAND_PICK_RANGE = 220;
function pickCommandTarget(world: World, aim: Vec2, casterId: number): CharacterEntity | null {
  let best: CharacterEntity | null = null;
  let bestD = Infinity;
  for (const c of world.allCharacters()) {
    if (c.dead || c.exited) continue;
    if (c.id === casterId) continue;
    const d = dist(c.pos, aim);
    if (d < bestD && d <= COMMAND_PICK_RANGE) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

registerAbility({
  id: "resurrect",
  name: "Resurrect",
  description: `Summon a zombie to follow you. Max ${NECRO_ZOMBIE_CAP}.`,
  cooldown: 8,
  chargeTime: 0.7, // brief windup so the player can read the cast
  canCast: ({ world, caster }) => {
    return livingZombiesOwnedBy(world, caster.id).length < NECRO_ZOMBIE_CAP;
  },
  cast: () => {
    // No instant effect — the spawn happens at the end of the
    // channel so the windup matters.
  },
  onChargeComplete: ({ world, caster }) => {
    // Late-check the cap in case the player burned a kill of a
    // hunter projectile right before completion — we don't want
    // to overshoot.
    if (livingZombiesOwnedBy(world, caster.id).length >= NECRO_ZOMBIE_CAP) return;
    // Spawn at a small offset behind the caster so the zombie
    // doesn't pop on top of Necro's sprite. Direction is opposite
    // of facing.
    const offX = -Math.cos(caster.facing) * 26;
    const offY = -Math.sin(caster.facing) * 26;
    world.spawn<ZombieEntity>({
      kind: "zombie",
      pos: { x: caster.pos.x + offX, y: caster.pos.y + offY },
      radius: 14,
      ownerId: caster.id,
      // Glass minions — one Slagy slash or trap kills cleanly, a
      // slime shot takes two. Keeps the swarm a threat that has to
      // be re-summoned, not a damage-sponge that survives an entire
      // engagement.
      hp: 15,
      maxHp: 15,
      speed: 130,
      facing: caster.facing,
      vel: { x: 0, y: 0 },
      mode: "follow",
      modeTimer: 0,
      targetId: null,
      biteCooldown: 0,
      dead: false,
    });
  },
});

registerAbility({
  id: "command_attack",
  name: "Command",
  description: `Send your zombies to attack the character nearest your aim for ${NECRO_COMMAND_DURATION}s.`,
  cooldown: 5,
  canCast: ({ world, caster, aim }) => {
    if (livingZombiesOwnedBy(world, caster.id).length === 0) return false;
    return pickCommandTarget(world, aim, caster.id) != null;
  },
  cast: ({ world, caster, aim }) => {
    const target = pickCommandTarget(world, aim, caster.id);
    if (!target) return;
    for (const z of livingZombiesOwnedBy(world, caster.id)) {
      z.mode = "chase";
      z.modeTimer = NECRO_COMMAND_DURATION;
      z.targetId = target.id;
    }
  },
});

// ---- Gravemarch's abilities ----

export const GRAVEMARCH_SLASH_DAMAGE = 23;
export const ROCK_WALL_TTL = 10;          // seconds the rocks persist
export const ROCK_WALL_ROCK_COUNT = 7;    // rocks per arc
export const ROCK_WALL_START_OFFSET = 90; // pixels ahead of Gravemarch before the arc starts
export const ROCK_WALL_HALF_WIDTH = 150;  // perpendicular half-span of the arc (pixels)
export const ROCK_WALL_CURVE_DEPTH = 70;  // how far the arc's midpoint bows toward the survivor
// Radii pattern across the 7 rocks (centered, symmetric, biggest in
// the middle). Each entry is a rock's pixel radius.
export const ROCK_WALL_RADII = [20, 26, 18, 30, 18, 26, 20] as const;
export const ROCK_SHIELD_DURATION = 10;   // seconds of damage immunity
export const STONE_STEP_DURATION = 0.55;  // seconds the tunnel arc takes
export const STONE_STEP_DISTANCE = 320;   // pixels Gravemarch surfaces ahead of his start point

// Heavy stone swipe — 23 dmg variant of Slagy's slash, slightly
// longer reach to reflect Gravemarch's size + mace.
registerAbility({
  id: "gravemarch_slash",
  name: "Slash",
  description: `Heavy stone swipe in front of you. ${GRAVEMARCH_SLASH_DAMAGE} damage.`,
  cooldown: 0.7,
  cast: ({ world, caster, aim }) => {
    const dir = normalize(sub(aim, caster.pos));
    const reach = 72;
    const arcRadius = 52;
    const hitCenter = add(caster.pos, scale(dir, reach * 0.6));
    const targets = world.ffaMode
      ? world.allCharacters()
      : world.charactersOnTeam("survivor");
    for (const e of targets) {
      if (e.dead) continue;
      if (e.id === caster.id) continue;
      if (e.statuses["shielded"] > 0) continue;
      if (dist(e.pos, hitCenter) <= arcRadius + e.radius) {
        e.hp -= GRAVEMARCH_SLASH_DAMAGE;
        e.lastDamagerId = caster.id;
      }
    }
    // Visual slash flash (same pattern as Slagy slash).
    world.spawn<ProjectileEntity>({
      kind: "projectile",
      pos: hitCenter,
      radius: arcRadius,
      vel: { x: 0, y: 0 },
      ownerId: caster.id,
      ttl: 0.12,
      damage: 0,
      targetTeam: "survivor",
      dead: false,
    });
  },
});

// Rock Wall — slam the ground; rocks of varying size erupt in an
// arc that starts a little ahead of Gravemarch and bows TOWARD the
// nearest survivor. The convex side of the arc faces the survivor,
// so the wall's edges pinch in around their escape angles.
//
// Each rock is owner-tagged with caster.id; the engine's brush
// + collision paths skip props whose ownerId matches the entity
// they're testing, so Gravemarch walks through cleanly while every
// other character is hard-blocked at the core and brush-slowed
// at the edges. The arc auto-despawns after ROCK_WALL_TTL.
registerAbility({
  id: "rock_wall",
  name: "Rock Wall",
  description: `${ROCK_WALL_ROCK_COUNT} rocks erupt in an arc curving toward the nearest survivor. You walk through; they don't. Lasts ${ROCK_WALL_TTL}s.`,
  cooldown: 14,
  chargeTime: 0.7,
  cast: () => { /* windup, no-op until charge completes */ },
  onChargeComplete: ({ world, caster, aim }) => {
    // Forward direction: prefer the nearest living survivor (the
    // intuitive "the wall arcs to cut THEM off" behavior). Fall
    // back to the caster's aim vector when no survivor exists
    // (e.g. FFA with no survivor team, or all already exited).
    const survivors = world.ffaMode
      ? world.allCharacters().filter((c) => c.id !== caster.id && !c.dead)
      : world.charactersOnTeam("survivor").filter((c) => !c.dead);
    let target: Vec2 = aim;
    if (survivors.length > 0) {
      let best = survivors[0]!;
      let bestD = dist(caster.pos, best.pos);
      for (let i = 1; i < survivors.length; i++) {
        const s = survivors[i]!;
        const d = dist(caster.pos, s.pos);
        if (d < bestD) { best = s; bestD = d; }
      }
      target = best.pos;
    }
    let dir = sub(target, caster.pos);
    if (dir.x * dir.x + dir.y * dir.y < 1) {
      // Degenerate (target on top of caster) — face east as a fallback
      // so we never spawn the arc on top of Gravemarch.
      dir = { x: 1, y: 0 };
    } else {
      dir = normalize(dir);
    }
    const perp: Vec2 = { x: -dir.y, y: dir.x };
    // Arc anchor: a fixed distance ahead of Gravemarch so the wall
    // doesn't spawn ON him.
    const anchor: Vec2 = add(caster.pos, scale(dir, ROCK_WALL_START_OFFSET));
    // Place each rock parametrized by t in [-1, +1] across the
    // perpendicular span, bowed forward by curve_depth * (1 - t^2)
    // so the midpoint (t=0) reaches farthest toward the survivor.
    const b = world.arena.bounds;
    const n: number = ROCK_WALL_ROCK_COUNT;
    for (let i = 0; i < n; i++) {
      const t = n <= 1 ? 0 : (i - (n - 1) / 2) / ((n - 1) / 2); // -1..+1
      const bow = (1 - t * t) * ROCK_WALL_CURVE_DEPTH;
      const px = anchor.x + perp.x * t * ROCK_WALL_HALF_WIDTH + dir.x * bow;
      const py = anchor.y + perp.y * t * ROCK_WALL_HALF_WIDTH + dir.y * bow;
      const radius = ROCK_WALL_RADII[i] ?? 22;
      // Clamp inside arena so a wall slammed near the edge doesn't
      // spawn rocks outside the playable area.
      const cx = Math.max(b.minX + radius, Math.min(b.maxX - radius, px));
      const cy = Math.max(b.minY + radius, Math.min(b.maxY - radius, py));
      world.spawn<PropEntity>({
        kind: "prop",
        pos: { x: cx, y: cy },
        radius,
        shape: "rock",
        blocking: true,
        ttl: ROCK_WALL_TTL,
        ownerId: caster.id,
        dead: false,
      });
    }
  },
});

// Rock Shield — total damage immunity for 10s. Engine projectile,
// trap, slash, and zombie-bite paths all check the "shielded"
// status and skip damage. The "show arrows to all survivors"
// effect is rendered client-side in the renderer: when the local
// viewer is Gravemarch and shielded > 0, arrows are drawn above
// each survivor's head.
registerAbility({
  id: "rock_shield",
  name: "Rock Shield",
  description: `Encase yourself in stone — block all damage for ${ROCK_SHIELD_DURATION}s. Survivors marked.`,
  cooldown: 26,
  cast: ({ caster }) => {
    caster.statuses["shielded"] = ROCK_SHIELD_DURATION;
  },
});

// Stone Step — tunnel underground and surface a FIXED distance
// ahead in the aim direction. Previously surfaced at the raw aim
// point, which produced two problems: on iPad the aim could land
// arbitrarily close (tiny hop) or arbitrarily far (off-map surface
// that the clamp would then snap to a wall); on PC the player
// could fling Gravemarch into a wall by aiming near the bounds.
// Fixed-distance semantics are identical on both input modes and
// always produce a predictable arrival point that's clamped to
// arena bounds.
//
// Uses the existing TransportState arc so the character is non-
// interactive during the move (no input, no damage applied). The
// "stone_step" source string lets the renderer hide the body and
// draw a dust trail instead.
registerAbility({
  id: "stone_step",
  name: "Stone Step",
  description: "Tunnel a fixed distance forward and surface. Aim sets the direction.",
  cooldown: 11,
  chargeTime: 0.3,
  cast: () => { /* windup */ },
  onChargeComplete: ({ world, caster, aim }) => {
    // Direction from caster toward aim. If aim is degenerate
    // (touch with no movement, or cursor on top of caster), fall
    // back to the caster's last velocity, then east.
    let dir = sub(aim, caster.pos);
    let lenSq = dir.x * dir.x + dir.y * dir.y;
    if (lenSq < 1) {
      dir = { x: caster.vel.x, y: caster.vel.y };
      lenSq = dir.x * dir.x + dir.y * dir.y;
    }
    if (lenSq < 0.0001) {
      dir = { x: 1, y: 0 };
    } else {
      dir = normalize(dir);
    }
    const raw = add(caster.pos, scale(dir, STONE_STEP_DISTANCE));
    // Clamp to arena bounds so the surface point is always on
    // the map, even when Gravemarch is near an edge.
    const b = world.arena.bounds;
    const r = caster.radius;
    const toPos: Vec2 = {
      x: Math.max(b.minX + r, Math.min(b.maxX - r, raw.x)),
      y: Math.max(b.minY + r, Math.min(b.maxY - r, raw.y)),
    };
    caster.transport = {
      fromPos: { ...caster.pos },
      toPos,
      elapsed: 0,
      duration: STONE_STEP_DURATION,
      source: "stone_step",
    };
  },
});
