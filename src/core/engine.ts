// Game engine. Owns the tick loop, applies player input and AI intents,
// runs physics, resolves collisions, ticks abilities, and asks the mode
// whether the round is over.

import { World } from "../core/world";
import type {
  CharacterEntity,
  ProjectileEntity,
  TrapEntity,
  ObjectiveEntity,
  Entity,
  PropEntity,
} from "../core/entity";
import { isCharacter, isProjectile, isTrap, isObjective, isProp, isExit, isStream, isCliff, isAnimal, isConveyor, isZombie } from "../core/entity";
import type { AnimalEntity, ZombieEntity } from "../core/entity";
import type { Vec2 } from "../core/math";
import { add, scale, normalize, sub, len, dist, clamp, circlesOverlap, segmentsIntersect, distToSegment } from "../core/math";
import { ABILITIES } from "../abilities/abilities";
import { CHARACTERS } from "../characters/characters";
import type { GameMode, RoundOutcome } from "../modes/mode";
import type { Controller, AIIntent } from "../ai/ai";

export interface EngineConfig {
  world: World;
  mode: GameMode;
  // Per-character controller (AI or human). Characters without an entry
  // simply produce no intent that tick (e.g. a dropped network player
  // before AI takeover).
  controllers: Map<number, Controller>;
}

// Cubic ease-in-out (smoothstep-like) — accelerates, cruises near the
// middle, decelerates to 0 derivative at t=1. Used to drive Magnesis
// transport for that "feel the snap, then ease in" motion.
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class Engine {
  outcome: RoundOutcome = "ongoing";
  paused: boolean = false;

  constructor(public cfg: EngineConfig) {}

  tick(dt: number): void {
    if (this.paused) return;
    if (this.outcome !== "ongoing") return;

    const world = this.cfg.world;
    world.elapsed += dt;

    // 1) Gather intents — every character is driven by its controller
    // (AI or human). Controllers consume their own edge-triggered input
    // (e.g. HumanController clears pressedAbilities after reading).
    const intents = new Map<number, AIIntent>();
    for (const c of world.allCharacters()) {
      if (c.dead) continue;
      const ctrl = this.cfg.controllers.get(c.id);
      if (ctrl) intents.set(c.id, ctrl.update(c, world, dt));
    }

    // Danger Mode (mode-defined). Queried once per tick and used in
    // the movement loop and the cooldown-set block below.
    const dangerMode = this.cfg.mode.isDangerMode?.(world) ?? false;

    // 2) Apply movement
    for (const c of world.allCharacters()) {
      if (c.dead) continue;
      if (c.exited) continue; // escaped survivors are inert
      const intent = intents.get(c.id);
      if (!intent) continue;

      // Status timers tick down
      for (const k of Object.keys(c.statuses)) {
        c.statuses[k] -= dt;
        if (c.statuses[k] <= 0) delete c.statuses[k];
      }
      // Cooldown timers tick down
      for (const k of Object.keys(c.cooldowns)) {
        c.cooldowns[k] -= dt;
        if (c.cooldowns[k] <= 0) delete c.cooldowns[k];
      }

      // ---- Transport (e.g. Magnesis) ----
      // While transporting, the character is on a scripted arc: input
      // is ignored, obstacle collision is skipped, but damage still
      // applies. Position eases from fromPos to toPos via a cubic
      // accel/cruise/decel curve.
      if (c.transport) {
        c.transport.elapsed += dt;
        const t = Math.min(1, c.transport.elapsed / c.transport.duration);
        const eased = easeInOutCubic(t);
        const fx = c.transport.fromPos.x;
        const fy = c.transport.fromPos.y;
        const tx = c.transport.toPos.x;
        const ty = c.transport.toPos.y;
        const newX = fx + (tx - fx) * eased;
        const newY = fy + (ty - fy) * eased;
        // Velocity is the derivative of position (eased) so the renderer
        // can read len(vel) and tell the character is moving fast.
        c.vel = { x: (newX - c.pos.x) / Math.max(dt, 1e-6), y: (newY - c.pos.y) / Math.max(dt, 1e-6) };
        c.pos = { x: newX, y: newY };
        // Face the destination throughout the arc.
        c.facing = Math.atan2(ty - fy, tx - fx);
        if (c.transport.elapsed >= c.transport.duration) {
          // Snap to exact destination then clear.
          c.pos = { x: tx, y: ty };
          c.transport = undefined;
          c.vel = { x: 0, y: 0 };
        }
        continue; // skip normal movement + collision below
      }

      // Effective speed: base, plus overdrive, minus slow.
      // Overdrive at 1.35× lets Match (base 165) outpace Slagy (145)
      // by ~78 units — meaningful escape window but catchable. v0
      // had 1.6× which landed Match at 264 (uncatchable, dominant).
      // Danger Mode (any survivor at exit threshold) buffs hunters
      // by +10% to compress the closing window.
      let speedMult = 1;
      if (c.statuses["overdrive"] > 0) speedMult *= 1.35;
      if (c.statuses["slowed"] > 0) speedMult *= 0.5;
      if (dangerMode && c.team === "hunter") speedMult *= 1.1;

      const desired = intent.moveDir;
      const dmag = len(desired);
      const moveDir = dmag > 1 ? normalize(desired) : desired;
      c.vel = scale(moveDir, c.speed * speedMult);

      // Face the aim direction if aiming, else facing follows movement
      const aimDir = sub(intent.aim, c.pos);
      if (len(aimDir) > 1) {
        c.facing = Math.atan2(aimDir.y, aimDir.x);
      } else if (len(c.vel) > 1) {
        c.facing = Math.atan2(c.vel.y, c.vel.x);
      }

      // Stream: walk each stream's polyline segments, find the
      // closest one to the character, and if within (width + char
      // radius), slow + push along THAT segment's direction. So a
      // meandering river curves the current along with it. Cheap
      // broad-phase via the bounding `radius` first.
      for (const s of world.entities) {
        if (!isStream(s)) continue;
        if (!circlesOverlap(c.pos, c.radius, s.pos, s.radius)) continue;
        let bestD = Infinity;
        let bestDirX = 0;
        let bestDirY = 0;
        for (let i = 0; i < s.points.length - 1; i++) {
          const a = s.points[i]!;
          const b = s.points[i + 1]!;
          const d = distToSegment(c.pos, a, b);
          if (d < bestD) {
            bestD = d;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const sl = Math.hypot(dx, dy) || 1;
            bestDirX = dx / sl;
            bestDirY = dy / sl;
          }
        }
        if (bestD > s.width + c.radius) continue;
        c.vel.x *= s.slowFactor;
        c.vel.y *= s.slowFactor;
        c.vel.x += bestDirX * s.flowSpeed;
        c.vel.y += bestDirY * s.flowSpeed;
      }
      // Conveyor: same shape (segment + width) but no slow factor —
      // mechanical belts don't drag your feet. Just adds the belt's
      // push velocity to whatever the character is already doing.
      // Heights must MATCH — ground characters are unaffected by
      // catwalk belts (they walk under), elevated characters are
      // unaffected by ground belts (they're above them).
      const cElev = !!c.elevated;
      for (const cv of world.entities) {
        if (!isConveyor(cv)) continue;
        if (!!cv.elevated !== cElev) continue;
        if (!circlesOverlap(c.pos, c.radius, cv.pos, cv.radius)) continue;
        const d = distToSegment(c.pos, cv.a, cv.b);
        if (d > cv.width + c.radius) continue;
        const fl = Math.hypot(cv.flow.x, cv.flow.y) || 1;
        c.vel.x += (cv.flow.x / fl) * cv.flowSpeed;
        c.vel.y += (cv.flow.y / fl) * cv.flowSpeed;
      }

      // Apply movement with prop collision (simple slide-on-block)
      const newPos = add(c.pos, scale(c.vel, dt));
      const resolved = this.resolveCharacterMove(c, newPos);
      // Cliff one-way collision: if the move crosses a cliff edge in
      // the "uphill" direction it's blocked; in the "downhill"
      // direction it's allowed and deals fall damage on cross.
      const cliffResolved = this.resolveCliffCross(c, resolved, world);
      c.pos = cliffResolved;

      // ---- Multi-height conveyor transitions (Factory Map 3+) ----
      // After the character's new position is finalized, look at
      // every elevated conveyor:
      //   - onElevatedBelt = char's center is within (width + radius)
      //     of any elevated belt's body
      //   - nearElevatedEntry = char's center is within (radius + 25)
      //     of any elevated belt's endpoint
      // Then:
      //   if already elevated and NOT on a belt body → drop to ground
      //     (walked past the end / off the side)
      //   if not elevated and near an endpoint → step up
      //     (climbing onto the belt from the ramp zone)
      // Walking the body of an elevated belt without entering at an
      // endpoint is impossible — the belt is overhead. The endpoint
      // is the ONLY transition point in either direction.
      const ENTRY_PAD = 25;
      let onElevatedBelt = false;
      let nearElevatedEntry = false;
      for (const cv of world.entities) {
        if (!isConveyor(cv)) continue;
        if (!cv.elevated) continue;
        // Cheap broad-phase.
        if (!circlesOverlap(c.pos, c.radius + ENTRY_PAD, cv.pos, cv.radius)) continue;
        const dBody = distToSegment(c.pos, cv.a, cv.b);
        if (dBody <= cv.width + c.radius) onElevatedBelt = true;
        const dA = dist(c.pos, cv.a);
        const dB = dist(c.pos, cv.b);
        if (dA <= c.radius + ENTRY_PAD || dB <= c.radius + ENTRY_PAD) {
          nearElevatedEntry = true;
        }
      }
      if (c.elevated) {
        if (!onElevatedBelt) c.elevated = false;
      } else {
        if (nearElevatedEntry) c.elevated = true;
      }
    }

    // 3) Fire abilities (after movement so aim is fresh)
    for (const c of world.allCharacters()) {
      if (c.dead) continue;
      if (c.exited) continue; // escaped survivors don't cast
      const intent = intents.get(c.id);
      if (!intent) continue;
      const def = CHARACTERS[c.characterId];
      for (const abilityId of intent.abilitiesToFire) {
        // Only fire abilities the character actually has
        if (!def.abilities.includes(abilityId)) continue;
        const ability = ABILITIES[abilityId];
        if (!ability) continue;
        // Cooldown check
        if ((c.cooldowns[abilityId] ?? 0) > 0) continue;
        // Don't start a new cast while already channeling something or
        // mid-transport (Magnesis arc, etc.).
        if (c.charging || c.transport) continue;
        const ctx = { world, caster: c, aim: intent.aim };
        // Optional pre-condition gate. If it refuses, no cd, no channel.
        if (ability.canCast && !ability.canCast(ctx)) continue;
        ability.cast(ctx);
        // Invincible Mode (Bigfoot login): 1.5× cooldown rate, i.e.
        // cooldowns end ~33% sooner than usual.
        // Danger Mode: hunter's cooldowns shrink by 10% so they keep
        // pace with scrambling survivors.
        let cdMult = c.invincible ? 1 / 1.5 : 1;
        if (dangerMode && c.team === "hunter") cdMult *= 0.9;
        c.cooldowns[abilityId] = ability.cooldown * cdMult;
        // Channeled abilities: start the channel timer; engine will fire
        // onChargeComplete when remaining hits 0 (see channel-tick block).
        if (ability.chargeTime && ability.chargeTime > 0) {
          c.charging = {
            abilityId,
            remaining: ability.chargeTime,
            total: ability.chargeTime,
            aim: { ...intent.aim },
          };
        }
      }
    }

    // 3b) Tick active channels. When a channel completes, fire the
    // ability's onChargeComplete. If the caster died mid-channel, drop
    // it silently — death-cleanup runs later in this tick.
    for (const c of world.allCharacters()) {
      if (c.dead || !c.charging) continue;
      c.charging.remaining -= dt;
      if (c.charging.remaining <= 0) {
        const { abilityId, aim } = c.charging;
        c.charging = undefined;
        const ability = ABILITIES[abilityId];
        if (ability?.onChargeComplete) {
          ability.onChargeComplete({ world, caster: c, aim });
        }
      }
    }

    // 4) Tick projectiles
    for (const e of world.entities) {
      if (!isProjectile(e)) continue;
      e.ttl -= dt;
      if (e.ttl <= 0) {
        e.dead = true;
        continue;
      }
      // Pure-effect projectiles (damage 0) don't move
      if (e.damage === 0) continue;
      const newPos = add(e.pos, scale(e.vel, dt));
      e.pos = newPos;
      // Out of bounds -> die
      if (!world.inBounds(e.pos, e.radius)) {
        e.dead = true;
        continue;
      }
      // Hit characters on target team. In FFA mode, the team
      // restriction is dropped — projectiles can damage anyone
      // except their own owner. Damage attribution is set on the
      // victim's lastDamagerId so the death credit lands on the
      // shooter when the victim dies (FFA most-kills win cond).
      const projCandidates = world.ffaMode
        ? world.allCharacters()
        : world.charactersOnTeam(e.targetTeam);
      for (const c of projCandidates) {
        if (c.dead) continue;
        if (c.id === e.ownerId) continue;
        if (c.exited) continue;            // escaped survivors aren't hittable
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          if (!c.invincible) {
            c.hp -= e.damage;
            c.lastDamagerId = e.ownerId;
          }
          if (e.slowOnHit && !c.invincible) c.statuses["slowed"] = e.slowOnHit;
          e.dead = true;
          break;
        }
      }
      // Hit animals (neutral, any team's projectiles hurt them). On hit
      // the animal records the shooter as its target and (if this is
      // the first wound of the episode) rolls a flee-vs-chase reaction.
      if (!e.dead) {
        for (const a of world.entities) {
          if (!isAnimal(a)) continue;
          if (a.dead) continue;
          if (circlesOverlap(e.pos, e.radius, a.pos, a.radius)) {
            a.hp -= e.damage;
            this.reactAnimalToAttack(a, e.ownerId, world);
            e.dead = true;
            break;
          }
        }
      }
      // Hit zombies — any team's projectile can damage them. Gives
      // hunters a way to thin the swarm before reaching Necro and
      // gives other survivors a way to interrupt friendly fire if
      // Necro's command_attack targets them.
      if (!e.dead) {
        for (const z of world.entities) {
          if (!isZombie(z)) continue;
          if (z.dead) continue;
          if (circlesOverlap(e.pos, e.radius, z.pos, z.radius)) {
            z.hp -= e.damage;
            e.dead = true;
            break;
          }
        }
      }
      // Hit props (block projectile)
      if (!e.dead) {
        for (const p of world.entities) {
          if (!isProp(p)) continue;
          if (!p.blocking) continue;
          if (circlesOverlap(e.pos, e.radius, p.pos, p.radius)) {
            e.dead = true;
            break;
          }
        }
      }
    }

    // 5) Tick traps
    for (const e of world.entities) {
      if (!isTrap(e)) continue;
      e.armDelay -= dt;
      e.ttl -= dt;
      if (e.ttl <= 0) {
        e.dead = true;
        continue;
      }
      if (e.armDelay > 0) continue;
      if (e.triggered) continue;
      // Trap candidates mirror the FFA gate used above for
      // projectiles.
      const trapCandidates = world.ffaMode
        ? world.allCharacters()
        : world.charactersOnTeam(e.targetTeam);
      for (const c of trapCandidates) {
        if (c.dead) continue;
        if (c.id === e.ownerId) continue;
        if (c.exited) continue;
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          if (!c.invincible) {
            c.hp -= e.damage;
            c.statuses["slowed"] = e.slowDuration;
            c.lastDamagerId = e.ownerId;
          }
          e.triggered = true;
          // Trap consumed on trigger
          e.dead = true;
          break;
        }
      }
    }

    // 6) Objective pickup. HuntMode restricts to the survivor team;
    // FFA opens it to anyone (everybody is a player who can collect
    // nuggets to fuel the nugget-hybrid win condition).
    for (const o of world.entities) {
      if (!isObjective(o)) continue;
      if (o.collected) continue;
      const collectors = world.ffaMode
        ? world.allCharacters().filter((c) => !c.dead)
        : world.charactersOnTeam("survivor");
      for (const c of collectors) {
        if (c.exited) continue;
        if (circlesOverlap(o.pos, o.radius, c.pos, c.radius)) {
          o.collected = true;
          o.collectedBy = c.id;
          c.objectivesCollected += 1;
          this.cfg.mode.onObjectiveCollected?.(world, c.id);
          break;
        }
      }
    }

    // 6b) Exit interaction — a survivor who has met the mode's exit
    // requirements (e.g. enough nuggets) and overlaps an exit zone
    // flips their `exited` flag. They become inert: no movement,
    // no damage, no abilities. The mode's checkOutcome reads exited
    // alongside dead to decide when the round ends.
    const canExit = this.cfg.mode.canSurvivorExit?.bind(this.cfg.mode);
    if (canExit) {
      for (const ex of world.entities) {
        if (!isExit(ex)) continue;
        for (const c of world.charactersOnTeam("survivor")) {
          if (c.exited) continue;
          if (!canExit(c)) continue;
          if (circlesOverlap(ex.pos, ex.radius, c.pos, c.radius)) {
            c.exited = true;
          }
        }
      }
    }

    // 6c) Animal AI — wander / flee / chase + contact bite.
    for (const a of world.entities) {
      if (!isAnimal(a)) continue;
      if (a.dead) continue;
      this.tickAnimal(a, dt, world);
    }

    // 6d) Zombie AI — follow Necro by default, charge a commanded
    // target during the 10s command_attack window. Zombies despawn
    // automatically when their owner dies or escapes.
    for (const z of world.entities) {
      if (!isZombie(z)) continue;
      if (z.dead) continue;
      this.tickZombie(z, dt, world);
    }

    // 7) Death check + kill credit. A character that just died
    // credits its kill to lastDamagerId — populated by every
    // damage path above. FFA most-kills win condition reads
    // world.killCounts.
    for (const c of world.allCharacters()) {
      if (c.hp <= 0 && !c.dead) {
        c.dead = true;
        const killer = c.lastDamagerId;
        if (killer != null && killer !== c.id) {
          world.killCounts.set(killer, (world.killCounts.get(killer) ?? 0) + 1);
        }
      }
    }
    for (const a of world.entities) {
      if (!isAnimal(a)) continue;
      if (a.hp <= 0 && !a.dead) a.dead = true;
    }
    for (const z of world.entities) {
      if (!isZombie(z)) continue;
      if (z.hp <= 0 && !z.dead) z.dead = true;
    }

    world.cleanupDead();

    // 8) Outcome check
    this.outcome = this.cfg.mode.checkOutcome(world);
  }

  // Resolve character movement against blocking props using simple
  // axis-separated push-out. Cheap and good enough for round-on-round.
  private resolveCharacterMove(c: CharacterEntity, target: Vec2): Vec2 {
    const world = this.cfg.world;
    let p = { ...target };
    // Arena bounds clamp
    const b = world.arena.bounds;
    p.x = clamp(p.x, b.minX + c.radius, b.maxX - c.radius);
    p.y = clamp(p.y, b.minY + c.radius, b.maxY - c.radius);
    // Prop + animal pushout (resolve up to a few iterations). Animals
    // act as moving blocking obstacles — characters can't walk
    // through them, so bumping into a deer/bear pushes you back.
    for (let iter = 0; iter < 3; iter++) {
      let resolved = true;
      for (const e of world.entities) {
        const isBlocker =
          (isProp(e) && e.blocking) || (isAnimal(e) && !e.dead);
        if (!isBlocker) continue;
        const dx = p.x - e.pos.x;
        const dy = p.y - e.pos.y;
        const minDist = c.radius + e.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 < minDist * minDist) {
          const d = Math.sqrt(d2) || 0.0001;
          const push = minDist - d;
          p.x += (dx / d) * push;
          p.y += (dy / d) * push;
          resolved = false;
        }
      }
      if (resolved) break;
    }
    // Re-clamp after pushout
    p.x = clamp(p.x, b.minX + c.radius, b.maxX - c.radius);
    p.y = clamp(p.y, b.minY + c.radius, b.maxY - c.radius);
    return p;
  }

  // Roll the animal's reaction to taking damage from a character.
  // Once per "wounded episode": 60% flee, 40% chase. Subsequent hits
  // during the same episode keep the existing mood. The episode
  // resets when the mood timer expires and the animal returns to
  // wander.
  private reactAnimalToAttack(a: AnimalEntity, attackerId: number, world: World): void {
    a.targetId = attackerId;
    if (a.reactionDecided) return;
    a.reactionDecided = true;
    // Bears chase more readily than deer (50/50 vs 30/70).
    const chaseChance = a.species === "bear" ? 0.5 : 0.3;
    if (Math.random() < chaseChance) {
      a.mood = "chase";
      a.moodTimer = 6;
    } else {
      a.mood = "flee";
      a.moodTimer = 5;
    }
  }

  // Per-frame animal AI + movement. Modes:
  //   wander — head toward wanderTarget; on arrival, pick a new one
  //            within wanderRadius of home. Slow stroll.
  //   flee   — move away from targetId character until moodTimer 0.
  //   chase  — move toward targetId character; on contact, bite.
  // The mood timer counts down each tick; at 0 the animal returns to
  // wander and clears reactionDecided.
  private tickAnimal(a: AnimalEntity, dt: number, world: World): void {
    // Cooldown on chase-bites so contact damage doesn't fire every
    // frame.
    if (a.biteCooldown > 0) a.biteCooldown = Math.max(0, a.biteCooldown - dt);
    // Tick mood timer (chase / flee only — wander is open-ended).
    if (a.mood !== "wander") {
      a.moodTimer -= dt;
      if (a.moodTimer <= 0) {
        a.mood = "wander";
        a.moodTimer = 0;
        a.targetId = null;
        a.reactionDecided = false;
      }
    }

    // Resolve target character (for flee/chase).
    let targetChar: { pos: Vec2; id: number; exited?: boolean } | null = null;
    if (a.targetId != null) {
      for (const c of world.allCharacters()) {
        if (c.id === a.targetId && !c.dead && !c.exited) {
          targetChar = c;
          break;
        }
      }
      // Target lost (dead / exited) — drop back to wander.
      if (!targetChar) {
        a.mood = "wander";
        a.moodTimer = 0;
        a.targetId = null;
        a.reactionDecided = false;
      }
    }

    // Compute desired velocity per mood.
    let desiredX = 0;
    let desiredY = 0;
    let desiredSpeed = a.speed;
    if (a.mood === "flee" && targetChar) {
      const dx = a.pos.x - targetChar.pos.x;
      const dy = a.pos.y - targetChar.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      desiredX = dx / d;
      desiredY = dy / d;
      desiredSpeed = a.speed * 1.6;
    } else if (a.mood === "chase" && targetChar) {
      const dx = targetChar.pos.x - a.pos.x;
      const dy = targetChar.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      desiredX = dx / d;
      desiredY = dy / d;
      desiredSpeed = a.speed * 1.3;
      // Contact bite — short cooldown so big bears can't shred
      // through invincibility status.
      if (d < a.radius + 18 && a.biteCooldown <= 0) {
        const targetEntity = world.allCharacters().find((c) => c.id === a.targetId) ?? null;
        if (targetEntity && !targetEntity.invincible) {
          targetEntity.hp -= a.species === "bear" ? 18 : 8;
        }
        a.biteCooldown = 0.7;
      }
    } else {
      // Wander — head toward the current wanderTarget.
      const dx = a.wanderTarget.x - a.pos.x;
      const dy = a.wanderTarget.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 16) {
        // Reached it — pick a new target near home.
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * a.wanderRadius;
        a.wanderTarget = {
          x: a.home.x + Math.cos(ang) * r,
          y: a.home.y + Math.sin(ang) * r,
        };
        desiredSpeed = 0; // brief pause
      } else {
        desiredX = dx / (d || 1);
        desiredY = dy / (d || 1);
        desiredSpeed = a.speed;
      }
    }

    a.vel = { x: desiredX * desiredSpeed, y: desiredY * desiredSpeed };
    if (Math.abs(a.vel.x) + Math.abs(a.vel.y) > 0.5) {
      a.facing = Math.atan2(a.vel.y, a.vel.x);
    }

    // Apply movement + clamp to arena bounds. Animals don't push
    // through props (treated like characters for prop collision).
    const newPos = { x: a.pos.x + a.vel.x * dt, y: a.pos.y + a.vel.y * dt };
    const b = world.arena.bounds;
    newPos.x = Math.max(b.minX + a.radius, Math.min(b.maxX - a.radius, newPos.x));
    newPos.y = Math.max(b.minY + a.radius, Math.min(b.maxY - a.radius, newPos.y));
    // Prop pushout (single pass — animals don't squeeze through).
    for (const p of world.entities) {
      if (!isProp(p) || !p.blocking) continue;
      const dx = newPos.x - p.pos.x;
      const dy = newPos.y - p.pos.y;
      const minDist = a.radius + p.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < minDist * minDist) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = minDist - d;
        newPos.x += (dx / d) * push;
        newPos.y += (dy / d) * push;
      }
    }
    a.pos = newPos;
  }

  // Per-frame zombie AI + movement. Two modes:
  //   follow — head toward the owner Necro, idle when within a
  //            small radius (so the swarm clusters around her
  //            without pile-driving on top of her).
  //   chase  — head toward targetId; on contact, bite (small
  //            damage with a per-zombie bite cooldown). modeTimer
  //            counts down; at 0 the zombie reverts to follow.
  // If the owner is dead/exited, the zombie dies (the necromantic
  // tether snaps). If the chase target is dead/exited the zombie
  // also reverts to follow.
  private tickZombie(z: ZombieEntity, dt: number, world: World): void {
    if (z.biteCooldown > 0) z.biteCooldown = Math.max(0, z.biteCooldown - dt);

    // Resolve owner. A dead or exited owner means the summon ends.
    let owner: CharacterEntity | null = null;
    for (const c of world.allCharacters()) {
      if (c.id === z.ownerId) {
        if (!c.dead && !c.exited) owner = c;
        break;
      }
    }
    if (!owner) {
      z.dead = true;
      return;
    }

    // Tick mode timer.
    if (z.mode === "chase") {
      z.modeTimer -= dt;
      if (z.modeTimer <= 0) {
        z.mode = "follow";
        z.modeTimer = 0;
        z.targetId = null;
      }
    }

    // Resolve target character (for chase). Lost target → follow.
    let target: CharacterEntity | null = null;
    if (z.mode === "chase" && z.targetId != null) {
      for (const c of world.allCharacters()) {
        if (c.id === z.targetId && !c.dead && !c.exited) {
          target = c;
          break;
        }
      }
      if (!target) {
        z.mode = "follow";
        z.modeTimer = 0;
        z.targetId = null;
      }
    }

    // Compute desired velocity per mode.
    let desiredX = 0;
    let desiredY = 0;
    let desiredSpeed = z.speed;
    if (z.mode === "chase" && target) {
      const dx = target.pos.x - z.pos.x;
      const dy = target.pos.y - z.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      desiredX = dx / d;
      desiredY = dy / d;
      desiredSpeed = z.speed * 1.15; // slight boost while charging
      // Contact bite — 4 damage per swipe, 0.7s cooldown so 3
      // zombies can stack chip damage on one target without
      // shredding them in a single tick. Bite ignores invincible
      // (Bigfoot test mode) for consistency with other contact dmg.
      if (d < z.radius + target.radius + 4 && z.biteCooldown <= 0) {
        // Necromantic pact: a zombie never bites its own summoner.
        // pickCommandTarget already excludes the caster, so this
        // can't trigger via a normal cast — kept as defense in
        // depth against any future AI path or bug that points
        // targetId at the owner.
        if (target.id !== z.ownerId && !target.invincible) {
          target.hp -= 4;
          // Attribute the kill to Necro, not the zombie itself —
          // the swarm is the summoner's weapon.
          target.lastDamagerId = z.ownerId;
        }
        z.biteCooldown = 0.7;
      }
    } else {
      // Follow — head toward owner, idle when close. Cluster radius
      // is set just outside the owner's radius so zombies don't
      // overlap her sprite.
      const dx = owner.pos.x - z.pos.x;
      const dy = owner.pos.y - z.pos.y;
      const d = Math.hypot(dx, dy);
      const CLUSTER_R = owner.radius + 26;
      if (d < CLUSTER_R) {
        desiredSpeed = 0;
      } else {
        desiredX = dx / (d || 1);
        desiredY = dy / (d || 1);
      }
    }

    z.vel = { x: desiredX * desiredSpeed, y: desiredY * desiredSpeed };
    if (Math.abs(z.vel.x) + Math.abs(z.vel.y) > 0.5) {
      z.facing = Math.atan2(z.vel.y, z.vel.x);
    }

    // Apply movement + clamp to arena bounds. Zombies are NOT
    // blocking (they phase through allies and the owner) but they
    // do respect arena bounds + blocking props so they don't walk
    // off the map or stand inside a crate.
    const newPos = { x: z.pos.x + z.vel.x * dt, y: z.pos.y + z.vel.y * dt };
    const b = world.arena.bounds;
    newPos.x = Math.max(b.minX + z.radius, Math.min(b.maxX - z.radius, newPos.x));
    newPos.y = Math.max(b.minY + z.radius, Math.min(b.maxY - z.radius, newPos.y));
    for (const p of world.entities) {
      if (!isProp(p) || !p.blocking) continue;
      const dx = newPos.x - p.pos.x;
      const dy = newPos.y - p.pos.y;
      const minDist = z.radius + p.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 < minDist * minDist) {
        const d = Math.sqrt(d2) || 0.0001;
        const push = minDist - d;
        newPos.x += (dx / d) * push;
        newPos.y += (dy / d) * push;
      }
    }
    z.pos = newPos;
  }

  // Cliff cross check (Forest Map 3). For each cliff, see if the
  // segment (from → to) crosses the edge. If it does:
  //   - high-side → low-side  : allow, deal fallDamage once
  //   - low-side  → high-side  : block, return `from` unchanged
  // Returns the final position after all cliffs resolve.
  private resolveCliffCross(c: CharacterEntity, target: Vec2, world: World): Vec2 {
    if (c.exited || c.transport) return target; // ignore mid-transport / escaped
    let p = { ...target };
    for (const cl of world.entities) {
      if (!isCliff(cl)) continue;
      if (!segmentsIntersect(c.pos, p, cl.a, cl.b)) continue;
      // Direction of the character's move.
      const mx = p.x - c.pos.x;
      const my = p.y - c.pos.y;
      // dot < 0 means moving AGAINST the high normal (falling DOWN).
      const dot = mx * cl.highNormal.x + my * cl.highNormal.y;
      if (dot > 0) {
        // Uphill — wall. Revert to current pos.
        p = { ...c.pos };
      } else if (dot < 0) {
        // Downhill — fall damage, but only if the character isn't
        // already mid-air (no double-dipping on the same tick) and
        // isn't invincible. Status "falling" briefly blocks repeat
        // damage from hovering on the edge.
        if (!c.invincible && !c.statuses["falling"]) {
          c.hp -= cl.fallDamage;
          c.statuses["falling"] = 0.4;
        }
      }
    }
    return p;
  }
}
