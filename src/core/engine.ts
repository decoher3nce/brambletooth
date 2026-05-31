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
import { isCharacter, isProjectile, isTrap, isObjective, isProp, isExit } from "../core/entity";
import type { Vec2 } from "../core/math";
import { add, scale, normalize, sub, len, dist, clamp, circlesOverlap } from "../core/math";
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
      let speedMult = 1;
      if (c.statuses["overdrive"] > 0) speedMult *= 1.35;
      if (c.statuses["slowed"] > 0) speedMult *= 0.5;

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

      // Apply movement with prop collision (simple slide-on-block)
      const newPos = add(c.pos, scale(c.vel, dt));
      const resolved = this.resolveCharacterMove(c, newPos);
      c.pos = resolved;
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
        const cdMult = c.invincible ? 1 / 1.5 : 1;
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
      // Hit characters on target team
      for (const c of world.charactersOnTeam(e.targetTeam)) {
        if (c.id === e.ownerId) continue;
        if (c.exited) continue;            // escaped survivors aren't hittable
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          if (!c.invincible) c.hp -= e.damage; // Bigfoot takes no damage
          if (e.slowOnHit && !c.invincible) c.statuses["slowed"] = e.slowOnHit;
          e.dead = true;
          break;
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
      for (const c of world.charactersOnTeam(e.targetTeam)) {
        if (c.exited) continue;
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          if (!c.invincible) c.hp -= e.damage;
          if (!c.invincible) c.statuses["slowed"] = e.slowDuration;
          e.triggered = true;
          // Trap consumed on trigger
          e.dead = true;
          break;
        }
      }
    }

    // 6) Objective pickup (survivor only) — attribute to the collector,
    // increment their per-survivor count, and notify the mode so it can
    // spawn a replacement if it wants to (HuntMode keeps exactly one).
    for (const o of world.entities) {
      if (!isObjective(o)) continue;
      if (o.collected) continue;
      for (const c of world.charactersOnTeam("survivor")) {
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

    // 7) Death check
    for (const c of world.allCharacters()) {
      if (c.hp <= 0 && !c.dead) {
        c.dead = true;
      }
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
    // Prop pushout (resolve up to a few iterations)
    for (let iter = 0; iter < 3; iter++) {
      let resolved = true;
      for (const e of world.entities) {
        if (!isProp(e)) continue;
        if (!e.blocking) continue;
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
}
