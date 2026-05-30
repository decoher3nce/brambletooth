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
  | "plate";

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

export type PropShape = "tree" | "stump" | "rock";

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

export type Entity =
  | CharacterEntity
  | ProjectileEntity
  | TrapEntity
  | ObjectiveEntity
  | PropEntity
  | PlateEntity;

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
