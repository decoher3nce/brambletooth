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
  // Optional shop-ownership gate. If supplied, the held-sprint
  // state is only forwarded to the engine when this returns true
  // — so a player who hasn't bought Sprint Boots presses Shift
  // with no effect. main.ts wires this to the local inventory.
  // Network-driven HumanControllers (for remote players) leave
  // it null since they shouldn't gate on the local profile's
  // inventory.
  constructor(
    private input: InputState,
    private canSprint: (() => boolean) | null = null,
  ) {}

  update(self: CharacterEntity, _world: World, _dt: number): AIIntent {
    const input = this.input;
    let moveDir: Vec2 = { x: 0, y: 0 };
    let aim: Vec2;

    if (input.isGamepadMode) {
      // Gamepad: twin-stick. Left stick = move, right stick =
      // aim direction projected GAMEPAD_AIM_RANGE units from the
      // character. Right stick at rest holds the previous facing
      // so abilities stay aimed where you last pointed.
      moveDir = { x: input.gamepadMove.x, y: input.gamepadMove.y };
      const aimMag = Math.hypot(input.gamepadAim.x, input.gamepadAim.y);
      if (aimMag > 0.05) {
        aim = {
          x: self.pos.x + (input.gamepadAim.x / aimMag) * 200,
          y: self.pos.y + (input.gamepadAim.y / aimMag) * 200,
        };
      } else {
        // No aim input → reuse facing so the engine's
        // facing-follows-aim logic keeps the character pointed
        // the same way.
        aim = {
          x: self.pos.x + Math.cos(self.facing) * 100,
          y: self.pos.y + Math.sin(self.facing) * 100,
        };
      }
    } else if (input.isTouchMode) {
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
    // Mouse click = first ability. Skipped in touch + gamepad
    // modes — those have their own dedicated buttons for slot 0
    // (touch row + face-south respectively).
    if (
      !input.isTouchMode &&
      !input.isGamepadMode &&
      input.mouseDown &&
      def.abilities[0]
    ) {
      fired.push(def.abilities[0]);
    }

    // Consume edge-triggered presses now that we've read them, so one tap
    // fires once. (The engine used to clear this centrally.)
    input.pressedAbilities.clear();

    // Sprint is gated on shop ownership. Without the canSprint
    // callback supplied, the gate is open (e.g. older code paths
    // / network-driven controllers). The engine separately
    // requires stamina > 0 to actually apply the boost.
    const sprintHeld = input.sprintHeld && (this.canSprint?.() ?? true);

    return { moveDir, aim, abilitiesToFire: fired, sprintHeld };
  }
}
