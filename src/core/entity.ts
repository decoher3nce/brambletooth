// Entity-component-ish design. Lightweight: each entity is a typed object.
// We don't use a full ECS because the entity count is small and the
// component overhead would obscure more than it would help.

import type { Vec2 } from "./math";

export type EntityId = number;

export type Team = "hunter" | "survivor";

export type EntityKind =
  | "character"
  | "projectile"
  | "trap"
  | "objective"
  | "prop"
  | "plate"
  | "exit"
  | "stream"
  | "cliff"
  | "animal"
  | "conveyor";

export interface BaseEntity {
  id: EntityId;
  kind: EntityKind;
  pos: Vec2;
  radius: number; // for circle collision
  dead: boolean;
}

// One in-flight channel per character. When `remaining` ticks to <= 0, the
// engine calls the ability's onChargeComplete handler (if any) and clears
// the field. Only one channel at a time per character — recasting cancels
// the previous one.
export interface ChannelState {
  abilityId: string;
  remaining: number; // seconds until completion
  total: number; // original chargeTime, kept for UI progress bars
  aim: Vec2; // aim at cast-start (some channels read this on completion)
}

// An in-flight ability-driven travel arc. While present, the engine
// drives the character's position along the path from fromPos -> toPos
// over `duration` seconds using a cubic ease (accelerate + decelerate),
// ignoring normal movement input and obstacle collision. Damage still
// applies — the character is vulnerable in transit. Cleared when
// elapsed >= duration. Used by Magnek's Magnesis.
export interface TransportState {
  fromPos: Vec2;
  toPos: Vec2;
  elapsed: number;  // seconds since transport began
  duration: number; // total travel time
  source: string;   // ability id that started the transport (for fx)
}

export interface CharacterEntity extends BaseEntity {
  kind: "character";
  team: Team;
  characterId: string; // "slagy" | "match" | "magnek"
  hp: number;
  maxHp: number;
  speed: number; // units per second
  facing: number; // radians
  vel: Vec2;
  // Ability cooldowns: ability key -> seconds remaining
  cooldowns: Record<string, number>;
  // Generic timed status effects (e.g. overdrive active, slow active)
  statuses: Record<string, number>;
  isPlayer: boolean;
  // Active channeled-ability state (undefined when not channeling).
  charging?: ChannelState;
  // Active ability-driven transport (e.g. Magnesis). When set, the
  // engine steers this character along an eased arc, ignoring move
  // input + obstacle collision; damage still applies.
  transport?: TransportState;
  // Survivor-only counter: how many objectives this survivor has collected
  // this round. Win condition = any survivor's count reaching the target.
  // Always 0 for hunters; kept on every character for protocol simplicity.
  objectivesCollected: number;
  // Survivor escaped the map alive via the exit. When true the engine
  // skips this character's movement / damage / abilities; the renderer
  // ghosts them out. Stays in the world for end-of-round accounting.
  // Always false for hunters.
  exited: boolean;
  // Invincible mode (special login). When true the engine ignores
  // damage to this character and applies a cooldown-rate multiplier
  // to ability cooldowns when they're set. Kept on every character
  // for protocol simplicity; only set when the local human is the
  // Bigfoot special profile (see main.ts).
  invincible?: boolean;
}

export interface ProjectileEntity extends BaseEntity {
  kind: "projectile";
  ownerId: EntityId;
  vel: Vec2;
  ttl: number; // seconds until despawn
  damage: number;
  targetTeam: Team; // team it can hit
  slowOnHit?: number; // optional slow duration applied on hit
}

export interface TrapEntity extends BaseEntity {
  kind: "trap";
  ownerId: EntityId;
  ttl: number;
  damage: number;
  slowDuration: number;
  targetTeam: Team;
  armDelay: number; // seconds before it can trigger
  triggered: boolean;
}

export interface ObjectiveEntity extends BaseEntity {
  kind: "objective";
  collected: boolean;
  // The character entity that collected this objective (when collected).
  // Lets clients award objective-collect points to the right player.
  collectedBy?: EntityId;
}

export type PropShape =
  // Forest props
  | "tree" | "stump" | "rock"
  // Factory props
  | "crate" | "pipe" | "oildrum" | "pallet";

export interface PropEntity extends BaseEntity {
  kind: "prop";
  shape: PropShape;
  blocking: boolean;
}

// Iron plate placed by Magnek. Persistent (no ttl), non-blocking, navigable
// over by anyone. Magnek's Magnesis ability teleports him to a random plate
// among those owned by him.
export interface PlateEntity extends BaseEntity {
  kind: "plate";
  ownerId: EntityId;
  // Monotonic placement counter used to evict the oldest when the owner's
  // plate cap is exceeded (FIFO).
  placedAt: number;
}

// Exit zone — survivors who have collected the required nugget count
// can step onto it to escape the map. Stepping on it flips the
// character's `exited` flag; the engine then ignores the character.
// The exit is non-blocking and visible to everyone.
export interface ExitEntity extends BaseEntity {
  kind: "exit";
}

// Flowing water (Forest Map 2 + Map 5). A meandering polyline that
// inflates by `width` on each side to form a stream. Each consecutive
// pair of points forms a segment; the stream's shape is the union of
// all those capsules. A character is "in stream" when their distance
// to the NEAREST segment is ≤ width + character radius.
//
// While in the stream:
//   - velocity is multiplied by `slowFactor` (e.g. 0.55)
//   - velocity gains a push along the LOCAL segment direction at
//     `flowSpeed` units/sec. The push naturally follows the meander
//     since each segment's direction is its own (b-a) vector.
//
// Magnek's Magnesis cast is refused while standing in a stream.
//
// `pos` is the polyline's bounding-box center; `radius` is the
// bounding circle for the whole curve. Both kept on BaseEntity for
// cheap broad-phase culling, snapshot ordering, and the floor-decal
// depth sort.
export interface StreamEntity extends BaseEntity {
  kind: "stream";
  // Ordered control points along the stream centerline. Length ≥ 2.
  // Consecutive pairs form straight segments; visual is a smoothed
  // curve through them (quadratic interpolation in the renderer).
  points: Vec2[];
  width: number; // half-thickness in world units
  // Push velocity magnitude (units/sec) along the local segment
  // direction. The local direction is computed from the nearest
  // segment at evaluation time, so flow follows the meander.
  flowSpeed: number;
  // 0..1 multiplier applied to the character's intent velocity.
  slowFactor: number;
}

// Industrial conveyor belt (Factory Map 2+). Capsule defined by line
// segment a→b inflated by `width` on each side. Characters standing
// on the belt move at FULL intent velocity AND get the belt push
// added on top (so going with the belt is faster, going against
// effectively halves your travel rate). No slow factor — mechanical
// belts don't drag your feet the way streams do.
export interface ConveyorEntity extends BaseEntity {
  kind: "conveyor";
  a: Vec2;
  b: Vec2;
  width: number;
  // Flow direction unit vector (along the segment). Engine
  // normalizes defensively.
  flow: Vec2;
  // Push velocity magnitude (units/sec) added each tick.
  flowSpeed: number;
}

// Forest NPC (Forest Map 4+). Wanders around its spawn point; pushes
// characters back on contact (blocking collision). When hp drops it
// rolls a one-time reaction — sometimes flees from the attacker,
// sometimes chases and bites them. Returns to wander after the
// reaction window expires.
export type AnimalSpecies = "deer" | "bear";
export type AnimalMood = "wander" | "flee" | "chase";
export interface AnimalEntity extends BaseEntity {
  kind: "animal";
  species: AnimalSpecies;
  hp: number;
  maxHp: number;
  speed: number;             // base wander speed (units/sec)
  facing: number;            // radians
  vel: Vec2;
  // AI state
  mood: AnimalMood;
  moodTimer: number;         // seconds remaining in current non-wander mood
  // Current wander target (idle when within reach of it).
  wanderTarget: Vec2;
  // Anchor point — wander stays within wanderRadius of this.
  home: Vec2;
  wanderRadius: number;
  // Entity id of the character the animal is reacting to (flee or
  // chase). Cleared when the mood resets.
  targetId: EntityId | null;
  // Set true once we've rolled the flee-vs-chase reaction for the
  // current "wounded" episode. Reset when mood returns to wander.
  reactionDecided: boolean;
  // Per-tick cooldown so chase-bites don't deal damage every frame.
  biteCooldown: number;
}

// One-way drop edge (Forest Map 3). Movement that CROSSES the edge
// in the direction OPPOSING `highNormal` is allowed but deals
// `fallDamage` once on cross. Movement WITH `highNormal` (low side
// → high side) is blocked, treated as a wall.
//
// The edge itself is the line segment a→b. `highNormal` is a unit
// vector pointing from the edge toward the "high" (cliff-top) side.
export interface CliffEntity extends BaseEntity {
  kind: "cliff";
  a: Vec2;
  b: Vec2;
  highNormal: Vec2;
  fallDamage: number;
}

export type Entity =
  | CharacterEntity
  | ProjectileEntity
  | TrapEntity
  | ObjectiveEntity
  | PropEntity
  | PlateEntity
  | ExitEntity
  | StreamEntity
  | CliffEntity
  | AnimalEntity
  | ConveyorEntity;

// Type guards
export function isCharacter(e: Entity): e is CharacterEntity {
  return e.kind === "character";
}
export function isProjectile(e: Entity): e is ProjectileEntity {
  return e.kind === "projectile";
}
export function isTrap(e: Entity): e is TrapEntity {
  return e.kind === "trap";
}
export function isObjective(e: Entity): e is ObjectiveEntity {
  return e.kind === "objective";
}
export function isProp(e: Entity): e is PropEntity {
  return e.kind === "prop";
}
export function isPlate(e: Entity): e is PlateEntity {
  return e.kind === "plate";
}
export function isExit(e: Entity): e is ExitEntity {
  return e.kind === "exit";
}
export function isStream(e: Entity): e is StreamEntity {
  return e.kind === "stream";
}
export function isCliff(e: Entity): e is CliffEntity {
  return e.kind === "cliff";
}
export function isAnimal(e: Entity): e is AnimalEntity {
  return e.kind === "animal";
}
export function isConveyor(e: Entity): e is ConveyorEntity {
  return e.kind === "conveyor";
}
