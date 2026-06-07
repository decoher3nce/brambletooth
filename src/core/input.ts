// Centralized input state. The engine reads from this; the DOM writes to it.

import type { Vec2 } from "./math";

export interface InputState {
  keys: Set<string>; // lowercase key names
  mouseScreen: Vec2; // pixel coords in canvas
  mouseWorld: Vec2; // world coords (filled by renderer each frame)
  mouseDown: boolean;
  // Edge-triggered ability key presses (consumed by engine each tick)
  pressedAbilities: Set<string>;
  // Touch input: set true on first touchstart and latched for the session.
  // Engine switches to the touch input path (moveVector + aim-from-move) when on.
  isTouchMode: boolean;
  // Analog movement vector from the virtual joystick. Magnitude 0..1.
  // Zero when no joystick touch is active.
  moveVector: Vec2;
  // ---- Gamepad ----
  // True once any gamepad has been seen since page load. Latched —
  // we don't unlatch on disconnect so the HumanController keeps
  // routing through the gamepad path even if a battery dies
  // mid-round and the player reconnects.
  isGamepadMode: boolean;
  // True while a gamepad is currently present (cleared on disconnect).
  // Used to short-circuit polling when nothing's connected.
  gamepadConnected: boolean;
  // Left stick — deadzone-applied, magnitude 0..1 in world axes
  // (x = east+, y = south+). Drives movement.
  gamepadMove: Vec2;
  // Right stick — deadzone-applied. HumanController projects this
  // out from the player's position to compute the aim point;
  // magnitude is informational only.
  gamepadAim: Vec2;
  // Edge-triggered: true for one frame when Start is pressed.
  // Consumed by main.ts to toggle pause.
  gamepadStartPressed: boolean;
}

export function createInput(): InputState {
  return {
    keys: new Set(),
    mouseScreen: { x: 0, y: 0 },
    mouseWorld: { x: 0, y: 0 },
    mouseDown: false,
    pressedAbilities: new Set(),
    isTouchMode: false,
    moveVector: { x: 0, y: 0 },
    isGamepadMode: false,
    gamepadConnected: false,
    gamepadMove: { x: 0, y: 0 },
    gamepadAim: { x: 0, y: 0 },
    gamepadStartPressed: false,
  };
}

export function bindInput(canvas: HTMLCanvasElement, input: InputState): void {
  const abilityKeys = new Set(["q", "e", "r", "f", "1", "2", "3", "4"]);

  window.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    if (!input.keys.has(k) && abilityKeys.has(k)) {
      input.pressedAbilities.add(k);
    }
    input.keys.add(k);
  });

  window.addEventListener("keyup", (ev) => {
    input.keys.delete(ev.key.toLowerCase());
  });

  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseScreen.x = ev.clientX - rect.left;
    input.mouseScreen.y = ev.clientY - rect.top;
  });

  canvas.addEventListener("mousedown", () => {
    input.mouseDown = true;
  });

  canvas.addEventListener("mouseup", () => {
    input.mouseDown = false;
  });

  // Prevent stuck keys when window loses focus
  window.addEventListener("blur", () => {
    input.keys.clear();
    input.mouseDown = false;
  });

  // ---- Gamepad lifecycle ----
  // Gamepad API is poll-based (no per-frame events) but it DOES
  // fire connect/disconnect events on the window. Connect flips
  // the flag and one-shots an optional toast callback; the actual
  // button/axis read happens in pollGamepad called each frame
  // from main.
  window.addEventListener("gamepadconnected", (ev) => {
    input.gamepadConnected = true;
    input.isGamepadMode = true;
    if (onGamepadConnect) onGamepadConnect((ev as GamepadEvent).gamepad);
  });
  window.addEventListener("gamepaddisconnected", () => {
    // We don't clear isGamepadMode here — the player may have a
    // battery die mid-round; leaving the mode latched means a
    // quick reconnect picks up where they left off.
    input.gamepadConnected = false;
    input.gamepadMove = { x: 0, y: 0 };
    input.gamepadAim = { x: 0, y: 0 };
  });
}

// Optional listener — main.ts hooks this to fire a "Controller
// connected" toast on first connect.
let onGamepadConnect: ((pad: Gamepad) => void) | null = null;
export function setOnGamepadConnect(fn: (pad: Gamepad) => void): void {
  onGamepadConnect = fn;
}

// ---- Gamepad polling ----
// Called from main.ts at the top of every frame. Reads the first
// connected pad via navigator.getGamepads(), applies deadzone +
// edge-trigger button detection, writes results into InputState.
//
// Off-brand pads: when the browser reports mapping !== "standard",
// the index-to-action contract isn't guaranteed. We fall back to
// the most common layout (axes 0..3 for the two sticks, buttons
// 0..3 for the south/east/west/north face cluster) which is
// correct for almost every gamepad we've actually seen. If your
// off-brand pad's face buttons are reversed or the right stick
// uses different axes, the fix is a per-controller remap UI
// (out of v1 scope).
const STICK_DEADZONE = 0.18;
// Per-frame snapshot of the pressed state of each button slot we
// care about, used so a held button only counts as a press on
// the first frame it transitions from up -> down.
const prevButtonPressed: boolean[] = [];
// Ability key strings that line up with the keyboard's q/e/r/f
// slot order so abilities fire through the existing pressedAbilities
// path without any HumanController changes.
const GAMEPAD_ABILITY_KEYS = ["q", "e", "r", "f"];
// Standard-layout button indices for the face cluster + Start.
const BTN_SOUTH = 0;
const BTN_EAST = 1;
const BTN_WEST = 2;
const BTN_NORTH = 3;
const BTN_START = 9;

export function pollGamepad(input: InputState): void {
  if (!input.gamepadConnected) return;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let pad: Gamepad | null = null;
  for (const p of pads) {
    if (p && p.connected) { pad = p; break; }
  }
  if (!pad) return;

  // ---- Sticks ----
  const lx = applyDeadzone(pad.axes[0] ?? 0);
  const ly = applyDeadzone(pad.axes[1] ?? 0);
  input.gamepadMove = { x: lx, y: ly };
  const rx = applyDeadzone(pad.axes[2] ?? 0);
  const ry = applyDeadzone(pad.axes[3] ?? 0);
  input.gamepadAim = { x: rx, y: ry };

  // Any stick activity latches gamepad mode on (covers the case
  // where the connect event fired before the page's gamepad hooks
  // were installed — e.g. controller paired during initial load).
  if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0) {
    input.isGamepadMode = true;
  }

  // ---- Buttons ----
  // Face cluster -> ability slots in the same order as q/e/r/f
  // (south=Q, east=E, west=R, north=F). Edge-triggered.
  fireOnEdge(pad, BTN_SOUTH, 0, input);
  fireOnEdge(pad, BTN_EAST, 1, input);
  fireOnEdge(pad, BTN_WEST, 2, input);
  fireOnEdge(pad, BTN_NORTH, 3, input);

  // Start button: edge-trigger a pause toggle. main.ts reads +
  // clears gamepadStartPressed.
  const startNow = !!pad.buttons[BTN_START]?.pressed;
  const startWas = prevButtonPressed[BTN_START] ?? false;
  if (startNow && !startWas) input.gamepadStartPressed = true;
  prevButtonPressed[BTN_START] = startNow;
}

function applyDeadzone(v: number): number {
  if (Math.abs(v) < STICK_DEADZONE) return 0;
  // Rescale [deadzone..1] -> [0..1] so the stick feels responsive
  // right at the edge of the deadzone, not snapped to a discrete
  // jump.
  const sign = v < 0 ? -1 : 1;
  return sign * ((Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}

function fireOnEdge(
  pad: Gamepad, btnIdx: number, abilitySlot: number, input: InputState,
): void {
  const now = !!pad.buttons[btnIdx]?.pressed;
  const was = prevButtonPressed[btnIdx] ?? false;
  if (now && !was) {
    input.pressedAbilities.add(GAMEPAD_ABILITY_KEYS[abilitySlot]!);
    input.isGamepadMode = true;
  }
  prevButtonPressed[btnIdx] = now;
}
