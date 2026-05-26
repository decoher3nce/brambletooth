// Centralized input state. The engine reads from this; the DOM writes to it.

import type { Vec2 } from "./math";

export interface InputState {
  keys: Set<string>; // lowercase key names
  mouseScreen: Vec2; // pixel coords in canvas
  mouseWorld: Vec2; // world coords (filled by renderer each frame)
  mouseDown: boolean;
  // Edge-triggered ability key presses (consumed by engine each tick)
  pressedAbilities: Set<string>;
}

export function createInput(): InputState {
  return {
    keys: new Set(),
    mouseScreen: { x: 0, y: 0 },
    mouseWorld: { x: 0, y: 0 },
    mouseDown: false,
    pressedAbilities: new Set(),
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
}
