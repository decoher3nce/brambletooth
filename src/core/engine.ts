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
import { isCharacter, isProjectile, isTrap, isObjective, isProp } from "../core/entity";
import type { Vec2 } from "../core/math";
import { add, scale, normalize, sub, len, dist, clamp, circlesOverlap } from "../core/math";
import type { InputState } from "../core/input";
import { ABILITIES } from "../abilities/abilities";
import { CHARACTERS } from "../characters/characters";
import type { GameMode, RoundOutcome } from "../modes/mode";
import type { AIController, AIIntent } from "../ai/ai";

export interface EngineConfig {
  world: World;
  mode: GameMode;
  input: InputState;
  // Map of character entity id -> AI controller (player is omitted)
  aiControllers: Map<number, AIController>;
}

export class Engine {
  outcome: RoundOutcome = "ongoing";
  paused: boolean = false;
  // Track per-character "intent" each frame so renderer/HUD can use it.
  lastPlayerIntent: { moveDir: Vec2; aim: Vec2 } = {
    moveDir: { x: 0, y: 0 },
    aim: { x: 0, y: 0 },
  };

  constructor(public cfg: EngineConfig) {}

  // Player ability key bindings: q/e/r/f map to ability slots 0..3.
  private static ABILITY_KEYS = ["q", "e", "r", "f"];

  tick(dt: number): void {
    if (this.paused) return;
    if (this.outcome !== "ongoing") return;

    const world = this.cfg.world;
    world.elapsed += dt;

    // 1) Gather intents for each character
    const intents = new Map<number, AIIntent>();
    for (const c of world.allCharacters()) {
      if (c.dead) continue;
      if (c.isPlayer) {
        intents.set(c.id, this.playerIntent(c));
      } else {
        const ai = this.cfg.aiControllers.get(c.id);
        if (ai) intents.set(c.id, ai.update(c, world, dt));
      }
    }

    // Consume edge-triggered ability keys after we've read them.
    this.cfg.input.pressedAbilities.clear();

    // 2) Apply movement
    for (const c of world.allCharacters()) {
      if (c.dead) continue;
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

      // Effective speed: base, plus overdrive, minus slow.
      let speedMult = 1;
      if (c.statuses["overdrive"] > 0) speedMult *= 1.6;
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
        ability.cast({ world, caster: c, aim: intent.aim });
        c.cooldowns[abilityId] = ability.cooldown;
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
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          c.hp -= e.damage;
          if (e.slowOnHit) c.statuses["slowed"] = e.slowOnHit;
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
        if (c.statuses["phased"] > 0) continue;
        if (circlesOverlap(e.pos, e.radius, c.pos, c.radius)) {
          c.hp -= e.damage;
          c.statuses["slowed"] = e.slowDuration;
          e.triggered = true;
          // Trap consumed on trigger
          e.dead = true;
          break;
        }
      }
    }

    // 6) Objective pickup (survivor only)
    for (const o of world.entities) {
      if (!isObjective(o)) continue;
      if (o.collected) continue;
      for (const c of world.charactersOnTeam("survivor")) {
        if (circlesOverlap(o.pos, o.radius, c.pos, c.radius)) {
          o.collected = true;
          break;
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

  private playerIntent(c: CharacterEntity): AIIntent {
    const input = this.cfg.input;
    const moveDir: Vec2 = { x: 0, y: 0 };
    // WASD relative to isometric: we want pressing W to move "up-left" in
    // world space so it feels intuitive on the screen. The iso projection
    // rotates world x/y by 45deg.
    // Define world axes such that:
    //   W = -y (north)   S = +y (south)
    //   A = -x (west)    D = +x (east)
    // The visual rotation is handled by the renderer; from the player's
    // POV "up" on screen IS world-up because we picked our iso transform
    // to make that the case. (See worldToScreen — north y is up.)
    if (input.keys.has("w")) moveDir.y -= 1;
    if (input.keys.has("s")) moveDir.y += 1;
    if (input.keys.has("a")) moveDir.x -= 1;
    if (input.keys.has("d")) moveDir.x += 1;

    const aim = { ...input.mouseWorld };
    this.lastPlayerIntent = { moveDir, aim };

    const fired: string[] = [];
    const def = CHARACTERS[c.characterId];
    for (let i = 0; i < Engine.ABILITY_KEYS.length; i++) {
      const k = Engine.ABILITY_KEYS[i];
      if (input.pressedAbilities.has(k)) {
        const aId = def.abilities[i];
        if (aId) fired.push(aId);
      }
    }
    // Mouse click = first ability (slash / overdrive)
    if (input.mouseDown && def.abilities[0]) {
      // Use cooldown-aware spam: just request; cooldown check rejects.
      fired.push(def.abilities[0]);
    }
    return { moveDir, aim, abilitiesToFire: fired };
  }
}
