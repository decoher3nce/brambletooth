// Touch controls overlay: virtual joystick (left half of screen) +
// ability buttons (bottom-right) + pause button (top-right) +
// tap-anywhere-to-restart when a round has ended.
//
// Design notes for v0.1:
// - Aim direction in touch mode = movement direction. This is a deliberate
//   simplification; works fine for Match (Glitch teleports in the move
//   direction, Overdrive doesn't need aim). When we let touch users play
//   Slagy (or any aim-distinct character), add a right-thumb drag-to-aim.
// - Touch mode is latched on the first touchstart and stays on. We do not
//   try to support hybrid touch+mouse switching in a single session — too
//   easy to get wrong, no current user need.
// - The joystick spawns where the finger first touches (anywhere on the
//   left half) so the player doesn't have to look at the screen to find it.

import type { InputState } from "../core/input";
import type { World } from "../core/world";
import type { CharacterEntity } from "../core/entity";
import type { RoundOutcome } from "../modes/mode";
import { CHARACTERS } from "../characters/characters";
import { ABILITIES } from "../abilities/abilities";

export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "ontouchstart" in window ||
    (typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0)
  );
}

const ABILITY_KEY_BY_SLOT = ["q", "e", "r", "f"];

interface Point {
  x: number;
  y: number;
}

interface JoystickState {
  active: boolean;
  touchId: number | null;
  origin: Point; // where finger first touched down
  current: Point; // current finger position
}

interface AbilityButton {
  abilityId: string | undefined; // undefined = locked
  slotIndex: number;
  x: number;
  y: number;
  r: number;
}

interface CircleHit {
  x: number;
  y: number;
  r: number;
}

export interface TouchControlsHooks {
  input: InputState;
  // World accessor — null when not in a round. Lazy so the hooks survive
  // across multiple round lifecycles without re-binding listeners.
  getWorld: () => World | null;
  getOutcome: () => RoundOutcome;
  isPaused: () => boolean;
  togglePause: () => void;
  restart: () => void;
  // True only when the playing scene is active. Touch handlers latch
  // isTouchMode unconditionally (so the playing UI knows touch is in
  // use), but all gameplay-affecting logic gates on this.
  isPlaying: () => boolean;
  // True when the local player owns Sprint Boots — gates whether the
  // sprint button is rendered + hit-testable. Stays false on touch
  // devices that haven't bought the item, so nothing changes for
  // them. Optional for back-compat with callers that pre-date the
  // sprint feature.
  hasSprint?: () => boolean;
}

export class TouchControls {
  private joystick: JoystickState = {
    active: false,
    touchId: null,
    origin: { x: 0, y: 0 },
    current: { x: 0, y: 0 },
  };
  // touchId -> slotIndex this touch is holding (for hit-test cleanup on end)
  private buttonTouches = new Map<number, number>();
  private pauseTouchId: number | null = null;
  private restartTouchId: number | null = null;
  // Touch id holding the sprint button (null when no finger is holding it).
  // sprintHeld in InputState is set to true while this is non-null and
  // cleared the moment the finger releases.
  private sprintTouchId: number | null = null;

  private readonly JOY_RADIUS = 80;
  private readonly JOY_DEADZONE = 0.15;
  private readonly BTN_R = 40;
  private readonly PAUSE_R = 22;
  // Sprint button — bottom-left corner, smaller than ability buttons
  // so it doesn't dominate the playspace.
  private readonly SPRINT_R = 36;

  private abilityButtons: AbilityButton[] = [];
  private pauseButton: CircleHit = { x: 0, y: 0, r: this.PAUSE_R };
  private sprintButton: CircleHit = { x: 0, y: 0, r: this.SPRINT_R };
  // Stashed from bind() so draw() can ask whether to render the
  // sprint button without taking a new arg (draw() is called from
  // both local and net code paths and we don't want to thread a
  // new param through both).
  private hasSprintFn: (() => boolean) | null = null;

  bind(
    canvas: HTMLCanvasElement,
    getDims: () => { w: number; h: number },
    hooks: TouchControlsHooks,
  ): void {
    this.hasSprintFn = hooks.hasSprint ?? null;
    const pointFromTouch = (t: Touch): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };

    const handleStart = (ev: TouchEvent) => {
      ev.preventDefault();
      // Latch touch mode on the very first touch event — even before any
      // round starts. Lets the select scene know we're on touch.
      hooks.input.isTouchMode = true;
      if (!hooks.isPlaying()) return;
      const world = hooks.getWorld();
      if (!world) return;

      const dims = getDims();
      this.recomputeHitZones(dims, world);

      for (const t of Array.from(ev.changedTouches)) {
        const p = pointFromTouch(t);
        const outcome = hooks.getOutcome();

        // Round over: any tap = restart on release.
        if (outcome !== "ongoing") {
          this.restartTouchId = t.identifier;
          continue;
        }

        // Pause button hit-test first so it always wins.
        if (this.hitCircle(p, this.pauseButton)) {
          this.pauseTouchId = t.identifier;
          continue;
        }

        // If currently paused, tap anywhere unpauses on release.
        // (Don't fire abilities or engage joystick while paused.)
        if (hooks.isPaused()) {
          this.pauseTouchId = t.identifier;
          continue;
        }

        // Sprint button — only live when the player owns Sprint Boots.
        // Hit-tested before the joystick spawn so a finger on the
        // bottom-left button doesn't accidentally engage movement.
        // Hold = sprint, release = stop (matches Shift on PC and RT
        // on gamepad).
        if (this.sprintAvailable(hooks) && this.hitCircle(p, this.sprintButton)) {
          this.sprintTouchId = t.identifier;
          hooks.input.sprintHeld = true;
          continue;
        }

        // Ability button hit-test.
        let consumed = false;
        for (const btn of this.abilityButtons) {
          if (!btn.abilityId) continue;
          if (this.hitCircle(p, btn)) {
            this.buttonTouches.set(t.identifier, btn.slotIndex);
            const key = ABILITY_KEY_BY_SLOT[btn.slotIndex];
            if (key) hooks.input.pressedAbilities.add(key);
            // Mirror as held — hold-to-cast abilities (Glitch)
            // need to know the finger is still on the button.
            // Cleared in touchend when the finger releases.
            if (btn.slotIndex >= 0 && btn.slotIndex < 4) {
              hooks.input.touchAbilityHeld[btn.slotIndex] = true;
            }
            consumed = true;
            break;
          }
        }
        if (consumed) continue;

        // Joystick: spawn at finger position if we don't already have one
        // and the touch landed in the left half.
        if (!this.joystick.active && p.x < dims.w * 0.5) {
          this.joystick.active = true;
          this.joystick.touchId = t.identifier;
          this.joystick.origin = { ...p };
          this.joystick.current = { ...p };
        }
      }

      this.writeJoystickToInput(hooks);
    };

    const handleMove = (ev: TouchEvent) => {
      ev.preventDefault();
      if (!hooks.isPlaying()) return;
      for (const t of Array.from(ev.changedTouches)) {
        if (this.joystick.active && t.identifier === this.joystick.touchId) {
          this.joystick.current = pointFromTouch(t);
        }
      }
      this.writeJoystickToInput(hooks);
    };

    const handleEnd = (ev: TouchEvent) => {
      ev.preventDefault();
      if (!hooks.isPlaying()) return;
      for (const t of Array.from(ev.changedTouches)) {
        if (this.joystick.active && t.identifier === this.joystick.touchId) {
          this.joystick.active = false;
          this.joystick.touchId = null;
        }
        if (this.buttonTouches.has(t.identifier)) {
          const slot = this.buttonTouches.get(t.identifier)!;
          this.buttonTouches.delete(t.identifier);
          // Clear the slot's held mirror only if no OTHER touch is
          // still on the same button (rare on iPad but cheap to
          // check).
          let stillHeld = false;
          for (const slotIdx of this.buttonTouches.values()) {
            if (slotIdx === slot) { stillHeld = true; break; }
          }
          if (!stillHeld && slot >= 0 && slot < 4) {
            hooks.input.touchAbilityHeld[slot] = false;
          }
        }
        if (this.pauseTouchId === t.identifier) {
          this.pauseTouchId = null;
          // Toggle pause only while round is ongoing — if it ended between
          // touchstart and touchend, the restart branch will handle it.
          if (hooks.getOutcome() === "ongoing") {
            hooks.togglePause();
          }
        }
        if (this.restartTouchId === t.identifier) {
          this.restartTouchId = null;
          if (hooks.getOutcome() !== "ongoing") {
            hooks.restart();
          }
        }
        if (this.sprintTouchId === t.identifier) {
          this.sprintTouchId = null;
          hooks.input.sprintHeld = false;
        }
      }
      this.writeJoystickToInput(hooks);
    };

    canvas.addEventListener("touchstart", handleStart, { passive: false });
    canvas.addEventListener("touchmove", handleMove, { passive: false });
    canvas.addEventListener("touchend", handleEnd, { passive: false });
    canvas.addEventListener("touchcancel", handleEnd, { passive: false });
  }

  private hitCircle(p: Point, c: CircleHit): boolean {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    return dx * dx + dy * dy <= c.r * c.r;
  }

  private writeJoystickToInput(hooks: TouchControlsHooks): void {
    if (!this.joystick.active) {
      hooks.input.moveVector = { x: 0, y: 0 };
      return;
    }
    let dx = this.joystick.current.x - this.joystick.origin.x;
    let dy = this.joystick.current.y - this.joystick.origin.y;
    const mag = Math.hypot(dx, dy);
    const clamp = Math.min(mag, this.JOY_RADIUS);
    if (mag > 0) {
      dx = (dx / mag) * clamp;
      dy = (dy / mag) * clamp;
    }
    const fx = dx / this.JOY_RADIUS;
    const fy = dy / this.JOY_RADIUS;
    const m = Math.hypot(fx, fy);
    if (m < this.JOY_DEADZONE) {
      hooks.input.moveVector = { x: 0, y: 0 };
    } else {
      hooks.input.moveVector = { x: fx, y: fy };
    }
  }

  private recomputeHitZones(dims: { w: number; h: number }, world: World): void {
    this.pauseButton = { x: dims.w - 36, y: 36, r: this.PAUSE_R };

    const player = world.playerCharacter();
    const abilityIds: (string | undefined)[] = player
      ? (CHARACTERS[player.characterId].abilities.slice(0, 4) as (string | undefined)[])
      : [undefined, undefined, undefined, undefined];

    const r = this.BTN_R;
    const gap = 16;
    const x = dims.w - r - 24;
    const bottomY = dims.h - r - 24;
    const out: AbilityButton[] = [];
    for (let i = 0; i < 4; i++) {
      out.push({
        abilityId: abilityIds[i],
        slotIndex: i,
        x,
        y: bottomY - i * (r * 2 + gap),
        r,
      });
    }
    this.abilityButtons = out;

    // Sprint button — sits IMMEDIATELY LEFT of the ability column
    // at the bottom slot's height. Right-thumb holds sprint while
    // the same thumb taps abilities just to the right; left thumb
    // stays free for the joystick. Original bottom-left position
    // (v1) blocked the left thumb from moving + sprinting at the
    // same time on iPad.
    const sprintX = x - r - 16 - this.SPRINT_R;
    this.sprintButton = {
      x: sprintX,
      y: bottomY,
      r: this.SPRINT_R,
    };
  }

  private sprintAvailable(hooks: TouchControlsHooks): boolean {
    return hooks.hasSprint ? hooks.hasSprint() : false;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    dims: { w: number; h: number },
    world: World,
    outcome: RoundOutcome,
    paused: boolean,
  ): void {
    this.recomputeHitZones(dims, world);

    // Pause button (always visible while in touch mode).
    this.drawPauseButton(ctx, this.pauseButton, paused);

    // Joystick: only render the visible ring + knob while a touch is active.
    if (this.joystick.active) {
      this.drawJoystick(ctx);
    }

    // Ability buttons: only meaningful while the round is ongoing and a
    // player exists. We still render them when paused so the player can
    // see what's available, but with reduced contrast.
    const player = world.playerCharacter();
    if (player && outcome === "ongoing") {
      for (const btn of this.abilityButtons) {
        this.drawAbilityButton(ctx, btn, player, paused);
      }
      // Sprint button — only rendered when the player owns Sprint
      // Boots. Stamina ring around the rim drains and refills.
      if (this.hasSprintFn && this.hasSprintFn()) {
        this.drawSprintButton(ctx, this.sprintButton, player, paused);
      }
    }

    if (outcome !== "ongoing") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = "16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Tap anywhere to restart", dims.w / 2, dims.h / 2 + 60);
    }
  }

  private drawPauseButton(
    ctx: CanvasRenderingContext2D,
    btn: CircleHit,
    paused: boolean,
  ): void {
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#fff";
    if (paused) {
      // Play triangle
      ctx.beginPath();
      ctx.moveTo(btn.x - 6, btn.y - 9);
      ctx.lineTo(btn.x + 9, btn.y);
      ctx.lineTo(btn.x - 6, btn.y + 9);
      ctx.closePath();
      ctx.fill();
    } else {
      // Pause bars
      ctx.fillRect(btn.x - 7, btn.y - 8, 5, 16);
      ctx.fillRect(btn.x + 2, btn.y - 8, 5, 16);
    }
  }

  private drawJoystick(ctx: CanvasRenderingContext2D): void {
    const o = this.joystick.origin;
    const c = this.joystick.current;
    let dx = c.x - o.x;
    let dy = c.y - o.y;
    const mag = Math.hypot(dx, dy);
    if (mag > this.JOY_RADIUS) {
      dx = (dx / mag) * this.JOY_RADIUS;
      dy = (dy / mag) * this.JOY_RADIUS;
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(o.x, o.y, this.JOY_RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.beginPath();
    ctx.arc(o.x + dx, o.y + dy, 26, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sprint button: filled circle in the corner with a footprint /
  // running-shoe glyph. Outer rim doubles as a stamina ring —
  // depleted region grays out. Pressed state lights the rim yellow.
  private drawSprintButton(
    ctx: CanvasRenderingContext2D,
    btn: CircleHit,
    player: CharacterEntity,
    paused: boolean,
  ): void {
    const stamina = Math.max(0, Math.min(1, player.stamina ?? 1));
    const held = this.sprintTouchId !== null;
    const baseAlpha = paused ? 0.4 : 0.75;

    // Body fill.
    ctx.fillStyle = held && stamina > 0
      ? `rgba(80, 60, 18, ${baseAlpha})`
      : `rgba(28, 28, 28, ${baseAlpha})`;
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);
    ctx.fill();

    // Stamina ring — depleted arc rendered dark, remaining arc bright.
    const ringR = btn.r - 4;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    if (stamina > 0) {
      ctx.strokeStyle = held ? "#ffd84a" : "#7ec8ff";
      ctx.beginPath();
      ctx.arc(
        btn.x, btn.y, ringR,
        -Math.PI / 2,
        -Math.PI / 2 + stamina * Math.PI * 2,
      );
      ctx.stroke();
    }

    // Lightning bolt glyph — same visual language as the shop icon.
    const u = btn.r * 0.05;
    ctx.fillStyle = stamina > 0 ? "#fff45e" : "rgba(255, 255, 255, 0.25)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
    ctx.lineWidth = Math.max(1, u);
    ctx.beginPath();
    ctx.moveTo(btn.x - 2 * u, btn.y - 10 * u);
    ctx.lineTo(btn.x - 8 * u, btn.y +  0 * u);
    ctx.lineTo(btn.x - 2 * u, btn.y +  0 * u);
    ctx.lineTo(btn.x - 6 * u, btn.y + 10 * u);
    ctx.lineTo(btn.x + 6 * u, btn.y -  2 * u);
    ctx.lineTo(btn.x +  0 * u, btn.y -  2 * u);
    ctx.lineTo(btn.x + 4 * u, btn.y - 10 * u);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawAbilityButton(
    ctx: CanvasRenderingContext2D,
    btn: AbilityButton,
    player: CharacterEntity,
    paused: boolean,
  ): void {
    ctx.beginPath();
    ctx.arc(btn.x, btn.y, btn.r, 0, Math.PI * 2);

    if (!btn.abilityId) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("LOCKED", btn.x, btn.y + 4);
      return;
    }

    const ability = ABILITIES[btn.abilityId];
    const cd = player.cooldowns[btn.abilityId] ?? 0;
    const ready = cd <= 0;

    const baseAlpha = paused ? 0.4 : 0.7;
    ctx.fillStyle = ready
      ? `rgba(40, 40, 40, ${baseAlpha})`
      : `rgba(20, 20, 20, ${baseAlpha})`;
    ctx.fill();
    ctx.strokeStyle = ready ? "#ffd84a" : "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = ready ? 3 : 1;
    ctx.stroke();

    if (!ready) {
      const pct = Math.min(1, cd / ability.cooldown);
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.beginPath();
      ctx.moveTo(btn.x, btn.y);
      ctx.arc(
        btn.x,
        btn.y,
        btn.r,
        -Math.PI / 2,
        -Math.PI / 2 + pct * Math.PI * 2,
      );
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = ready ? "#fff" : "rgba(255, 255, 255, 0.6)";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    const lines = ability.name.split(" ");
    const lineH = 13;
    let ty = btn.y - ((lines.length - 1) * lineH) / 2 + 4;
    for (const line of lines) {
      ctx.fillText(line, btn.x, ty);
      ty += lineH;
    }

    if (!ready) {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.fillText(cd.toFixed(1), btn.x, btn.y + btn.r - 10);
    }
  }
}
