// HumanController turns one InputState into per-tick intents for the
// character it drives. This is the logic that used to live inside
// Engine.playerIntent — lifted out so the engine drives every character
// through the uniform Controller interface (AI or human, no branching).
//
// Crucially, this also unlocks networked play: a remote player's input
// arrives over the wire into its own InputState, and a HumanController
// wrapping that InputState drives a character identically to a local one.

import type { CharacterEntity } from "./entity";
import type { World } from "./world";
import type { Vec2 } from "./math";
import type { InputState } from "./input";
import type { AIIntent, Controller } from "../ai/ai";
import { CHARACTERS } from "../characters/characters";

// Ability slot key bindings: q/e/r/f map to ability slots 0..3.
const ABILITY_KEYS = ["q", "e", "r", "f"];

export class HumanController implements Controller {
  constructor(private input: InputState) {}

  update(self: CharacterEntity, _world: World, _dt: number): AIIntent {
    const input = this.input;
    let moveDir: Vec2 = { x: 0, y: 0 };
    let aim: Vec2;

    if (input.isTouchMode) {
      // Touch: joystick supplies an analog move vector. No separate aim
      // input in v0.1, so aim is derived from the move direction; standing
      // still falls back to current facing.
      moveDir = { x: input.moveVector.x, y: input.moveVector.y };
      const m = Math.hypot(moveDir.x, moveDir.y);
      if (m > 0.05) {
        aim = {
          x: self.pos.x + (moveDir.x / m) * 1000,
          y: self.pos.y + (moveDir.y / m) * 1000,
        };
      } else {
        aim = {
          x: self.pos.x + Math.cos(self.facing) * 100,
          y: self.pos.y + Math.sin(self.facing) * 100,
        };
      }
    } else {
      // Keyboard + mouse. WASD is in world axes (W=-y north, S=+y south,
      // A=-x west, D=+x east); the iso transform makes world-up read as
      // screen-up, so it feels intuitive.
      if (input.keys.has("w")) moveDir.y -= 1;
      if (input.keys.has("s")) moveDir.y += 1;
      if (input.keys.has("a")) moveDir.x -= 1;
      if (input.keys.has("d")) moveDir.x += 1;
      aim = { ...input.mouseWorld };
    }

    const fired: string[] = [];
    const def = CHARACTERS[self.characterId];
    for (let i = 0; i < ABILITY_KEYS.length; i++) {
      const k = ABILITY_KEYS[i];
      if (input.pressedAbilities.has(k)) {
        const aId = def.abilities[i];
        if (aId) fired.push(aId);
      }
    }
    // Mouse click = first ability. Skipped in touch mode — the slot-0
    // touch button already covers it via the pressedAbilities path.
    if (!input.isTouchMode && input.mouseDown && def.abilities[0]) {
      fired.push(def.abilities[0]);
    }

    // Consume edge-triggered presses now that we've read them, so one tap
    // fires once. (The engine used to clear this centrally.)
    input.pressedAbilities.clear();

    return { moveDir, aim, abilitiesToFire: fired };
  }
}
