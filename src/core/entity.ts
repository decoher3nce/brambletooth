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
  | "lava"
  | "cliff"
  | "animal"
  | "conveyor"
  | "zombie";

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
  // Per-character one-shot ids — engine adds to this set each time
  // the transport's caster damages another character mid-arc, so
  // the same target can't be re-hit within one transport instance.
  // Currently used by Gravemarch's Stone Step; undefined for
  // transports that don't deal damage (e.g. Magnek's Magnesis).
  hitIds?: Set<EntityId>;
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
  // Multi-height conveyor system (Factory Map 3+). True = the
  // character is on the catwalk layer; they get pushed by elevated
  // conveyors and ignored by ground conveyors, and the renderer
  // sorts them above the ground layer. Engine flips this flag at
  // elevated-belt endpoints (step up onto belt → true; walk past
  // last belt end → false). Defaults to falsy on every character
  // spawn; the field is optional so older snapshots without it
  // still parse.
  elevated?: boolean;
  // Last character / projectile-owner that dealt damage to this
  // entity. Set by every damage-application path (projectiles,
  // traps, melee abilities, zombie bites). On death the engine
  // credits a kill to this id via world.killCounts. Used by FFA
  // most-kills win condition. Optional so existing modes that
  // don't read it stay unaffected.
  lastDamagerId?: EntityId;
  // Whether this character is wearing Sprint Boots — the shop item.
  // Renderer reads this to overlay a yellow boot at the feet so
  // other players can identify a sprint-capable character at a
  // glance. Source-of-truth at spawn time: set by the local play
  // path from hasSprintBoots(), and by the multiplayer server from
  // the slot's inventory snapshot sent in the select message.
  hasSprintBoots?: boolean;
  // Sprint stamina, 0..1. Drains while the player holds sprint;
  // regenerates when not sprinting (faster when standing still).
  // Always present on every character so the engine math is
  // uniform — but the UI / sprint-trigger gate only fires when
  // the local player owns the Sprint Boots shop item.
  stamina: number;
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
  | "crate" | "pipe" | "oildrum" | "pallet"
  // Cave props — caverock is a chunky stalagmite / boulder pile
  // (blocking, no light). crystal is a glowing geode cluster
  // (blocking, emits ambient light in cave FOV mode).
  | "caverock" | "crystal"
  // Volcano props — the volcano cone itself (huge blocking
  // centerpiece with a glowing crater) and scattered chunks
  // of cooled obsidian (sharp, dark, blocking).
  | "volcano" | "obsidian";

export interface PropEntity extends BaseEntity {
  kind: "prop";
  shape: PropShape;
  blocking: boolean;
  // Optional auto-despawn. Set by temporary props (Gravemarch's
  // Rock Wall) so they vanish after their window. Static props
  // (trees, crates, crystals) leave it undefined and live for
  // the whole round.
  ttl?: number;
  // Optional caster id — when set, this prop ignores hard collision
  // AND brush slow for the entity with that id. Used by Gravemarch's
  // Rock Wall so the caster can walk through their own arc while
  // every other character is blocked + brush-slowed by it.
  ownerId?: EntityId;
  // Optional contact damage — when set, the engine applies this
  // damage to any non-owner character that overlaps the prop's
  // CORE radius. Repeats gated by a per-character cooldown stored
  // in c.cooldowns["rock_wall_hit"] so brushing the wall doesn't
  // stack a damage tick every frame.
  contactDamage?: number;
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

// Flowing lava (Volcano World). Same polyline-of-capsules shape as
// StreamEntity, but with two key differences:
//   - Touching it BURNS — the engine deals `damagePerSec` HP per
//     second, gated by a per-character cooldown so the damage
//     applies in clean ticks instead of every frame. Gravemarch
//     takes a reduced fraction (he's a rock) — see engine's
//     applyLavaDamage path
//   - Push along the local segment direction is slow and sticky
//     rather than fast — the molten flow drags rather than rushes,
//     so survivors who step into it can't be flung free by the
//     current
// `pos` and `radius` are the bounding-box center + bounding-circle
// radius for the whole curve (cheap broad-phase).
export interface LavaEntity extends BaseEntity {
  kind: "lava";
  points: Vec2[];
  width: number;
  flowSpeed: number;
  slowFactor: number;
  // HP per second applied to a character standing in the lava.
  // Engine ticks damage in `lavaDamageCooldown`-second pulses so
  // it's not invisibly applied every frame.
  damagePerSec: number;
}

// Industrial conveyor belt (Factory Map 2+). Capsule defined by line
// segment a→b inflated by `width` on each side. Characters standing
// on the belt move at FULL intent velocity AND get the belt push
// added on top (so going with the belt is faster, going against
// effectively halves your travel rate). No slow factor — mechanical
// belts don't drag your feet the way streams do.
//
// Factory Map 3 introduces ELEVATED belts (catwalks). An elevated
// belt only pushes characters whose `elevated` flag matches. Ground
// characters under an elevated belt are unaffected (they pass
// under). To get on an elevated belt a character must step onto one
// of its endpoints (the "ramp" zone — see engine height-transition
// block). They stay elevated as long as they overlap the body of
// SOME elevated belt; walking off the end + onto open ground drops
// them.
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
  // True = the belt sits on a catwalk above the floor. Ground
  // characters can walk underneath without being pushed; only
  // characters whose own `elevated` flag is also true get the
  // push. Renderer draws elevated belts above characters and
  // paints a drop shadow on the ground beneath. Optional for
  // protocol compat with old Map-2 snapshots — `undefined`
  // means ground level.
  elevated?: boolean;
  // True = render detailed spinning gear teeth at the end rollers
  // instead of the plain metallic-ring rollers used on Map 2.
  // Cosmetic only; spin rate is driven by flowSpeed in the
  // renderer.
  showGears?: boolean;
  // True = render decorative cargo (crates + gears) sliding
  // along the belt in the flow direction. Purely cosmetic
  // (the cargo doesn't collide with anything) — purpose is to
  // make the belt visibly *running*, used by Factory Map 4's
  // assembly-floor look.
  showCargo?: boolean;
}

// Wandering NPC — the kind label is "animal" for legacy reasons but
// it now covers both wildlife (deer, bear — Forest Map 4+) and the
// Factory Map 4 robots (sweeper_bot, welder_bot). All share the
// same AI scaffolding (wander/flee/chase mood machine + brushMeter
// for the "I've been bumped too much" aggression trigger); per-
// species branching in tickAnimal handles their behavioral
// differences (deer flee, bears charge, sweeper bots spin angrily,
// welder bots zap nearby characters).
export type AnimalSpecies = "deer" | "bear" | "sweeper_bot" | "welder_bot";
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
  // Cumulative brush meter. Each tick a character is brushing this
  // animal's brush zone, the meter accumulates by depth*dt*BUILD,
  // and decays at DECAY per second when no one is brushing. When
  // it crosses BRUSH_ANGER_THRESHOLD the bear locks the most-
  // recent brusher as its target and snaps into chase mode. The
  // meter is reset when chase begins so the bear has to be
  // re-angered after the chase fades.
  brushMeter: number;
  // Entity id of the most recent character to brush this animal.
  // Bears use this as the chase target when brushMeter hits the
  // anger threshold. Cleared on chase start.
  lastBrusherId: EntityId | null;
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

// Necro's summoned minion. Spawned by the `resurrect` ability,
// follows its owner (Necro) by default, and chases + bites a
// commanded target when `command_attack` is cast. Despawns when
// its owner dies or exits the round. Zombies are NOT blocking —
// they phase through allies and the owner — so they don't impede
// Necro's escape. They CAN be damaged by hunter projectiles and
// die at 0 HP, which gives the hunter a way to thin the swarm.
export interface ZombieEntity extends BaseEntity {
  kind: "zombie";
  ownerId: EntityId;          // the Necro character that summoned it
  hp: number;
  maxHp: number;
  speed: number;
  facing: number;
  vel: Vec2;
  // AI mode:
  //   "follow" — head toward owner, idle within a small radius
  //   "chase"  — head toward targetId character, bite on contact
  mode: "follow" | "chase";
  // Seconds remaining in chase mode (10s per command_attack cast).
  // Counts down each tick; at <= 0 the zombie reverts to "follow".
  modeTimer: number;
  // The character the zombie is hunting in "chase" mode. Set by
  // the command_attack ability; cleared when modeTimer expires or
  // the target dies/exits.
  targetId: EntityId | null;
  // Per-bite cooldown so contact damage doesn't fire every frame.
  biteCooldown: number;
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
  | LavaEntity
  | CliffEntity
  | AnimalEntity
  | ConveyorEntity
  | ZombieEntity;

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
export function isLava(e: Entity): e is LavaEntity {
  return e.kind === "lava";
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
export function isZombie(e: Entity): e is ZombieEntity {
  return e.kind === "zombie";
}
