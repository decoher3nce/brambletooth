// AI controller. One controller per AI character. The engine ticks the
// controller, which writes to a "desired action" struct that the engine
// then applies the same way it would for a player.

import type { CharacterEntity } from "../core/entity";
import type { World } from "../core/world";
import type { Vec2 } from "../core/math";
import { dist, normalize, sub, add, scale } from "../core/math";
import { CHARACTERS } from "../characters/characters";

export interface AIIntent {
  moveDir: Vec2;         // unit-ish vector, magnitude clamped to 1
  aim: Vec2;             // world-space aim point
  abilitiesToFire: string[]; // ability ids to attempt this tick
}

export interface AIController {
  update(self: CharacterEntity, world: World, dt: number): AIIntent;
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
      moveDir: dir,
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
      moveDir = away;
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
      moveDir = normalize(sub(nearestObj.pos, self.pos));
    }

    return { moveDir, aim: self.pos, abilitiesToFire: [] };
  }
}
