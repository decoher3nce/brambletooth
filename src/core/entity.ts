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
  | "prop";

export interface BaseEntity {
  id: EntityId;
  kind: EntityKind;
  pos: Vec2;
  radius: number; // for circle collision
  dead: boolean;
}

export interface CharacterEntity extends BaseEntity {
  kind: "character";
  team: Team;
  characterId: string; // "slagy" | "match"
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
}

export type PropShape = "tree" | "stump" | "rock";

export interface PropEntity extends BaseEntity {
  kind: "prop";
  shape: PropShape;
  blocking: boolean;
}

export type Entity =
  | CharacterEntity
  | ProjectileEntity
  | TrapEntity
  | ObjectiveEntity
  | PropEntity;

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
