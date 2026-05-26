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
  world: World;
  getOutcome: () => RoundOutcome;
  isPaused: () => boolean;
  togglePause: () => void;
  restart: () => void;
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

  private readonly JOY_RADIUS = 80;
  private readonly JOY_DEADZONE = 0.15;
  private readonly BTN_R = 40;
  private readonly PAUSE_R = 22;

  private abilityButtons: AbilityButton[] = [];
  private pauseButton: CircleHit = { x: 0, y: 0, r: this.PAUSE_R };

  bind(
    canvas: HTMLCanvasElement,
    getDims: () => { w: number; h: number },
    hooks: TouchControlsHooks,
  ): void {
    const pointFromTouch = (t: Touch): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };

    const handleStart = (ev: TouchEvent) => {
      ev.preventDefault();
      // Latch touch mode on the very first touch event.
      hooks.input.isTouchMode = true;

      const dims = getDims();
      this.recomputeHitZones(dims, hooks.world);

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

        // Ability button hit-test.
        let consumed = false;
        for (const btn of this.abilityButtons) {
          if (!btn.abilityId) continue;
          if (this.hitCircle(p, btn)) {
            this.buttonTouches.set(t.identifier, btn.slotIndex);
            const key = ABILITY_KEY_BY_SLOT[btn.slotIndex];
            if (key) hooks.input.pressedAbilities.add(key);
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
      for (const t of Array.from(ev.changedTouches)) {
        if (this.joystick.active && t.identifier === this.joystick.touchId) {
          this.joystick.current = pointFromTouch(t);
        }
      }
      this.writeJoystickToInput(hooks);
    };

    const handleEnd = (ev: TouchEvent) => {
      ev.preventDefault();
      for (const t of Array.from(ev.changedTouches)) {
        if (this.joystick.active && t.identifier === this.joystick.touchId) {
          this.joystick.active = false;
          this.joystick.touchId = null;
        }
        if (this.buttonTouches.has(t.identifier)) {
          this.buttonTouches.delete(t.identifier);
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
