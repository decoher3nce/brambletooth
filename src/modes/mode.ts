// Modes plug into the engine. Each mode defines:
//  - how the world is initialized (teams, spawns, objectives)
//  - how to check win/loss each tick
// Adding 1vMany or FFA later means adding a new mode file.

import type { World } from "../core/world";
import type { Team } from "../core/entity";

export type RoundOutcome = "ongoing" | "hunter_win" | "survivor_win" | "draw";

export interface GameMode {
  id: string;
  name: string;
  // Called once at round start.
  initialize(world: World): void;
  // Called each tick after physics. Returns current outcome.
  checkOutcome(world: World): RoundOutcome;
}
