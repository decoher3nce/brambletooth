// AI controller. One controller per AI character. The engine ticks the
// controller, which writes to a "desired action" struct that the engine
// then applies the same way it would for a player.

import type { CharacterEntity, PlateEntity, ZombieEntity } from "../core/entity";
import { isProp, isPlate, isObjective, isZombie } from "../core/entity";
import type { World } from "../core/world";
import type { Vec2 } from "../core/math";
import { dist, len, normalize, sub, add, scale } from "../core/math";
import { MAGNEK_PLATE_CAP } from "../abilities/abilities";

export interface AIIntent {
  moveDir: Vec2;         // unit-ish vector, magnitude clamped to 1
  aim: Vec2;             // world-space aim point
  abilitiesToFire: string[]; // ability ids to attempt this tick
  // Hold the sprint key. Engine applies the +10% speed boost
  // and drains stamina while this is true. AI never sets this
  // in v1; only HumanController does (gated on shop ownership
  // via the canSprint callback).
  sprintHeld?: boolean;
  // Ability ids whose button is currently HELD. Used by hold-to-
  // cast abilities (Glitch) so the engine can tick a charge timer
  // while held and fire on release. AI controllers don't populate
  // this — they use abilitiesToFire (one-shot press) for the
  // same abilities, just with a fixed charge fraction.
  abilitiesHeld?: Set<string>;
}

export interface AIController {
  update(self: CharacterEntity, world: World, dt: number): AIIntent;
}

// A Controller maps (self, world, dt) -> intent each tick. AIController and
// the input-driven HumanController both satisfy this shape, so the engine
// can drive any character — AI or human, local or networked — through one
// uniform map without branching on who's behind the wheel.
export interface Controller {
  update(self: CharacterEntity, world: World, dt: number): AIIntent;
}

// ---- Shared steering ----
//
// Take a desired goal direction (toward a target, away from a threat,
// toward an objective) and adjust it so the character doesn't grind into
// trees or wedge into corners. Two layers, both rule-based — no
// pathfinding, no memory, readable on purpose:
//   1. Obstacle dodge: find the blocking prop most directly ahead within
//      a look-ahead range and steer tangentially around it.
//   2. Wall peel-off: near an arena wall, slide along it toward the goal
//      instead of pressing into it (handles the corner-stuck case).
const LOOKAHEAD = 90;
const WALL_MARGIN = 90;

export function navigate(
  self: CharacterEntity,
  world: World,
  desired: Vec2,
): Vec2 {
  let dir = normalize(desired);
  if (dir.x === 0 && dir.y === 0) return dir;

  // --- 1. Obstacle dodge ---
  // Pick the blocking prop that's both close and most directly in our
  // path; steer perpendicular to it on whichever side stays nearer the
  // goal. Steering tangentially (rather than just repelling) avoids the
  // head-on local-minimum where repulsion cancels the goal and we stall.
  let worst: { toN: Vec2; score: number } | null = null;
  for (const e of world.entities) {
    if (!isProp(e) || !e.blocking) continue;
    const to = sub(e.pos, self.pos);
    const d = len(to);
    const reach = LOOKAHEAD + self.radius + e.radius;
    if (d > reach || d < 1e-3) continue;
    const toN = scale(to, 1 / d);
    const ahead = toN.x * dir.x + toN.y * dir.y; // cos(angle) to heading
    if (ahead <= 0.2) continue; // off to the side / behind — not blocking
    const score = ahead * (1 - d / reach); // closer + more head-on = worse
    if (!worst || score > worst.score) worst = { toN, score };
  }
  if (worst) {
    const t = worst.toN;
    const perpA = { x: -t.y, y: t.x };
    const perpB = { x: t.y, y: -t.x };
    const aDot = perpA.x * dir.x + perpA.y * dir.y;
    const bDot = perpB.x * dir.x + perpB.y * dir.y;
    const perp = aDot >= bDot ? perpA : perpB;
    // Mostly tangential, with a goal pull so we still make progress.
    dir = normalize({
      x: dir.x * 0.4 + perp.x,
      y: dir.y * 0.4 + perp.y,
    });
  }

  // --- 2. Wall peel-off ---
  const b = world.arena.bounds;
  const wall = { x: 0, y: 0 };
  const dl = self.pos.x - b.minX;
  const dr = b.maxX - self.pos.x;
  const dtp = self.pos.y - b.minY;
  const dbt = b.maxY - self.pos.y;
  if (dl < WALL_MARGIN) wall.x += (WALL_MARGIN - dl) / WALL_MARGIN;
  if (dr < WALL_MARGIN) wall.x -= (WALL_MARGIN - dr) / WALL_MARGIN;
  if (dtp < WALL_MARGIN) wall.y += (WALL_MARGIN - dtp) / WALL_MARGIN;
  if (dbt < WALL_MARGIN) wall.y -= (WALL_MARGIN - dbt) / WALL_MARGIN;
  if (wall.x !== 0 || wall.y !== 0) {
    const combined = { x: dir.x + wall.x * 1.2, y: dir.y + wall.y * 1.2 };
    if (len(combined) < 0.15) {
      // Goal points straight into the wall/corner and the push cancels it.
      // Slide along the wall toward whichever side advances the goal.
      const w = normalize(wall);
      const perpA = { x: -w.y, y: w.x };
      const perpB = { x: w.y, y: -w.x };
      const g = normalize(desired);
      dir =
        perpA.x * g.x + perpA.y * g.y >= perpB.x * g.x + perpB.y * g.y
          ? perpA
          : perpB;
    } else {
      dir = normalize(combined);
    }
  }

  return dir;
}

// List the plates owned by a given character, typed as PlateEntity[].
function platesOf(world: World, ownerId: number): PlateEntity[] {
  return world.entities.filter(
    (e): e is PlateEntity => isPlate(e) && e.ownerId === ownerId,
  );
}

// Slagy hunter AI: simple finite state machine.
//   IDLE -> sees survivor -> CHASE
//   CHASE -> in slash range -> ATTACK
//   CHASE -> in shot range, off cd -> SHOOT (mid-range)
//   CHASE -> can place trap on path -> TRAP
//   Lost LOS / far away -> RELOCATE to close gap (off cd)
//
// We deliberately keep it readable and rule-based, not nested behavior
// tree, so it's easy to audit and tweak.
export class SlagyAI implements AIController {
  private trapCooldownLocal = 0;

  update(self: CharacterEntity, world: World, dt: number): AIIntent {
    this.trapCooldownLocal -= dt;
    const survivors = world.charactersOnTeam("survivor");
    if (survivors.length === 0) {
      return { moveDir: { x: 0, y: 0 }, aim: self.pos, abilitiesToFire: [] };
    }
    // Target the closest survivor.
    let target = survivors[0];
    let bestDist = dist(self.pos, target.pos);
    for (const s of survivors) {
      const d = dist(self.pos, s.pos);
      if (d < bestDist) {
        bestDist = d;
        target = s;
      }
    }
    const toTarget = sub(target.pos, self.pos);
    const dir = normalize(toTarget);
    const d = bestDist;

    const intent: AIIntent = {
      // Steer around trees/walls instead of grinding straight at the target.
      moveDir: navigate(self, world, dir),
      aim: target.pos,
      abilitiesToFire: [],
    };

    // Slash range: very close
    if (d < 55 && (self.cooldowns["slash"] ?? 0) <= 0) {
      intent.abilitiesToFire.push("slash");
    }

    // Slime shot: medium range
    if (d > 80 && d < 350 && (self.cooldowns["slime_shot"] ?? 0) <= 0) {
      // Lead the target a bit
      const lead = scale(target.vel, 0.25);
      intent.aim = add(target.pos, lead);
      intent.abilitiesToFire.push("slime_shot");
    }

    // Drop a trap occasionally when close-ish but not in slash range
    if (
      d > 60 && d < 200 &&
      (self.cooldowns["slime_trap"] ?? 0) <= 0 &&
      this.trapCooldownLocal <= 0
    ) {
      intent.abilitiesToFire.push("slime_trap");
      this.trapCooldownLocal = 6.0; // don't keep dropping
    }

    // Relocate when far away to close the gap
    if (d > 320 && (self.cooldowns["relocate"] ?? 0) <= 0) {
      intent.aim = target.pos;
      intent.abilitiesToFire.push("relocate");
    }

    // If we're inside our own slash arc, stop walking forward — strafe slightly.
    if (d < 40) {
      // Strafe perpendicular to face the target
      intent.moveDir = { x: -dir.y * 0.5, y: dir.x * 0.5 };
    }

    return intent;
  }
}

// Generic "wander toward objectives, flee from hunter" survivor AI.
// We don't actually use this in v0.1 (the player IS the survivor) but
// having it ready means we can hot-swap roles for testing.
export class MatchAI implements AIController {
  update(self: CharacterEntity, world: World, _dt: number): AIIntent {
    const hunters = world.charactersOnTeam("hunter");
    const objectives = world.entities.filter(
      (e) => e.kind === "objective" && !(e as any).collected,
    );

    let moveDir: Vec2 = { x: 0, y: 0 };

    // Flee from nearest hunter if close
    let nearestHunter: CharacterEntity | undefined;
    let nearestD = Infinity;
    for (const h of hunters) {
      const d = dist(self.pos, h.pos);
      if (d < nearestD) {
        nearestD = d;
        nearestHunter = h;
      }
    }

    if (nearestHunter && nearestD < 220) {
      const away = normalize(sub(self.pos, nearestHunter.pos));
      moveDir = navigate(self, world, away);
      const intent: AIIntent = { moveDir, aim: self.pos, abilitiesToFire: [] };
      if ((self.cooldowns["overdrive"] ?? 0) <= 0 && nearestD < 160) {
        intent.abilitiesToFire.push("overdrive");
      }
      if ((self.cooldowns["glitch"] ?? 0) <= 0 && nearestD < 100) {
        intent.aim = add(self.pos, scale(away, 200));
        intent.abilitiesToFire.push("glitch");
      }
      return intent;
    }

    // Otherwise head to nearest objective
    if (objectives.length > 0) {
      let nearestObj = objectives[0];
      let nd = dist(self.pos, nearestObj.pos);
      for (const o of objectives) {
        const d = dist(self.pos, o.pos);
        if (d < nd) {
          nd = d;
          nearestObj = o;
        }
      }
      moveDir = navigate(self, world, normalize(sub(nearestObj.pos, self.pos)));
    }

    return { moveDir, aim: self.pos, abilitiesToFire: [] };
  }
}

// Magnek survivor AI. Same flee-or-collect spine as MatchAI, but built
// around his placement kit:
//   - While roaming safely, lay a spread-out network of plates (never
//     clustered) so a future Magnesis has somewhere useful to land.
//   - Under threat, flee AND trigger Magnesis early — the 1.2s channel
//     needs to finish before the hunter closes, so we cast at medium
//     range, not point-blank. Destination is random (the kit's nature);
//     a spread network makes a safe landing likely.
export class MagnekAI implements AIController {
  private placeTimer = 0;
  // Minimum spacing between plates so the network actually spreads out.
  private static SPACING = 240;

  update(self: CharacterEntity, world: World, dt: number): AIIntent {
    this.placeTimer -= dt;
    const hunters = world.charactersOnTeam("hunter");
    const objectives = world.entities.filter(isObjective).filter((o) => !o.collected);
    const myPlates = platesOf(world, self.id);
    const channeling = !!self.charging;

    let nearestHunter: CharacterEntity | undefined;
    let nearestD = Infinity;
    for (const h of hunters) {
      const d = dist(self.pos, h.pos);
      if (d < nearestD) {
        nearestD = d;
        nearestHunter = h;
      }
    }

    const intent: AIIntent = {
      moveDir: { x: 0, y: 0 },
      aim: self.pos,
      abilitiesToFire: [],
    };

    const canPlace =
      !channeling &&
      myPlates.length < MAGNEK_PLATE_CAP &&
      (self.cooldowns["place_plate"] ?? 0) <= 0 &&
      this.placeTimer <= 0;
    const farFromPlates = () =>
      !myPlates.some((p) => dist(self.pos, p.pos) < MagnekAI.SPACING);

    if (nearestHunter && nearestD < 240) {
      // DANGER: flee.
      const away = normalize(sub(self.pos, nearestHunter.pos));
      intent.moveDir = navigate(self, world, away);

      // Trigger Magnesis early enough that the channel completes before the
      // hunter is on top of us. Needs a plate and a ready cooldown.
      if (
        !channeling &&
        myPlates.length > 0 &&
        (self.cooldowns["magnesis"] ?? 0) <= 0 &&
        nearestD < 200
      ) {
        intent.abilitiesToFire.push("magnesis");
      } else if (canPlace && farFromPlates()) {
        // No escape available — drop a fresh plate to build one.
        intent.abilitiesToFire.push("place_plate");
        this.placeTimer = 3.0;
      }
      return intent;
    }

    // SAFE: head to nearest objective, seeding a spread plate network.
    if (objectives.length > 0) {
      let nearestObj = objectives[0];
      let nd = dist(self.pos, nearestObj.pos);
      for (const o of objectives) {
        const d = dist(self.pos, o.pos);
        if (d < nd) {
          nd = d;
          nearestObj = o;
        }
      }
      intent.moveDir = navigate(self, world, normalize(sub(nearestObj.pos, self.pos)));
    }

    if (canPlace && farFromPlates()) {
      intent.abilitiesToFire.push("place_plate");
      this.placeTimer = 2.5;
    }

    return intent;
  }
}

// Necro survivor AI. Flees hunters like Match/Magnek but spends safe
// time building the swarm via resurrect, and commands the swarm onto
// the nearest hunter when threatened.
export class NecroAI implements AIController {
  update(self: CharacterEntity, world: World, dt: number): AIIntent {
    void dt;
    const hunters = world.charactersOnTeam("hunter");
    const objectives = world.entities.filter(isObjective).filter((o) => !o.collected);
    const myZombies: ZombieEntity[] = [];
    for (const e of world.entities) {
      if (isZombie(e) && !e.dead && e.ownerId === self.id) myZombies.push(e);
    }
    const channeling = !!self.charging;

    let nearestHunter: CharacterEntity | undefined;
    let nearestD = Infinity;
    for (const h of hunters) {
      const d = dist(self.pos, h.pos);
      if (d < nearestD) {
        nearestD = d;
        nearestHunter = h;
      }
    }

    const intent: AIIntent = {
      moveDir: { x: 0, y: 0 },
      aim: self.pos,
      abilitiesToFire: [],
    };

    if (nearestHunter && nearestD < 280) {
      // DANGER: flee + command zombies onto the hunter (if any
      // alive and the cooldown is ready).
      const away = normalize(sub(self.pos, nearestHunter.pos));
      intent.moveDir = navigate(self, world, away);
      intent.aim = nearestHunter.pos;
      if (
        !channeling &&
        myZombies.length > 0 &&
        (self.cooldowns["command_attack"] ?? 0) <= 0
      ) {
        intent.abilitiesToFire.push("command_attack");
      }
      return intent;
    }

    // SAFE: head to nearest objective and top up the swarm.
    if (objectives.length > 0) {
      let nearestObj = objectives[0];
      let nd = dist(self.pos, nearestObj.pos);
      for (const o of objectives) {
        const d = dist(self.pos, o.pos);
        if (d < nd) {
          nd = d;
          nearestObj = o;
        }
      }
      intent.moveDir = navigate(self, world, normalize(sub(nearestObj.pos, self.pos)));
    }

    if (
      !channeling &&
      myZombies.length < 3 &&
      (self.cooldowns["resurrect"] ?? 0) <= 0
    ) {
      intent.abilitiesToFire.push("resurrect");
    }

    return intent;
  }
}

// Gravemarch hunter AI. Slow stone golem — closes distance toward the
// nearest survivor, slams them with the heavy slash in melee range,
// drops Rock Wall to cut off escape routes when they're fleeing
// faster than he can pursue, pops Rock Shield when wounded to
// reveal survivors and tank damage, and uses Stone Step to
// tunnel-close when the target is far. He's intentionally less
// twitchy than Slagy — high HP and Shield mean he doesn't need
// to scramble.
export class GravemarchAI implements AIController {
  update(self: CharacterEntity, world: World, _dt: number): AIIntent {
    const survivors = world.charactersOnTeam("survivor");
    if (survivors.length === 0) {
      return { moveDir: { x: 0, y: 0 }, aim: self.pos, abilitiesToFire: [] };
    }
    // Closest non-exited survivor.
    let target = survivors[0];
    let bestD = Infinity;
    for (const s of survivors) {
      if (s.exited) continue;
      const d = dist(self.pos, s.pos);
      if (d < bestD) { bestD = d; target = s; }
    }
    const toTarget = sub(target.pos, self.pos);
    const dir = normalize(toTarget);
    const d = bestD;

    const intent: AIIntent = {
      moveDir: navigate(self, world, dir),
      aim: target.pos,
      abilitiesToFire: [],
    };

    // Rock Shield when wounded — pop early so the reveal helps
    // hunt down the survivors who knocked HP off.
    if (
      self.hp < self.maxHp * 0.55 &&
      !(self.statuses["shielded"] > 0) &&
      (self.cooldowns["rock_shield"] ?? 0) <= 0
    ) {
      intent.abilitiesToFire.push("rock_shield");
    }

    // Heavy slash in melee.
    if (d < 60 && (self.cooldowns["gravemarch_slash"] ?? 0) <= 0) {
      intent.abilitiesToFire.push("gravemarch_slash");
    }

    // Stone Step to close from far away.
    if (d > 360 && (self.cooldowns["stone_step"] ?? 0) <= 0 && !self.charging) {
      intent.aim = target.pos;
      intent.abilitiesToFire.push("stone_step");
    }

    // Rock Wall at the survivor's position when they're at
    // mid-range — drops in front of them to cut the escape.
    if (
      d > 110 && d < 320 &&
      (self.cooldowns["rock_wall"] ?? 0) <= 0 &&
      !self.charging
    ) {
      intent.aim = target.pos;
      intent.abilitiesToFire.push("rock_wall");
    }

    return intent;
  }
}

// Factory: build the right controller for a character id. Returns null for
// characters without an AI (they'd stand still — callers should avoid
// putting them on the AI side). Centralizes the id→controller mapping so
// main.ts doesn't repeat the switch.
export function createAIController(characterId: string): AIController | null {
  switch (characterId) {
    case "slagy":
      return new SlagyAI();
    case "match":
      return new MatchAI();
    case "necro":
      return new NecroAI();
    case "magnek":
      return new MagnekAI();
    case "gravemarch":
      return new GravemarchAI();
    default:
      return null;
  }
}
