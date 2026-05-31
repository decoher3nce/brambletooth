// Modes plug into the engine. Each mode defines:
//  - how the world is initialized (teams, spawns, objectives)
//  - how to check win/loss each tick
// Adding 1vMany or FFA later means adding a new mode file.

import type { World } from "../core/world";
import type { CharacterEntity, Team } from "../core/entity";

export type RoundOutcome = "ongoing" | "hunter_win" | "survivor_win" | "draw";

export interface GameMode {
  id: string;
  name: string;
  // Called once at round start.
  initialize(world: World): void;
  // Called each tick after physics. Returns current outcome.
  checkOutcome(world: World): RoundOutcome;
  // Optional hook fired immediately after a survivor picks up an objective.
  // Lets modes spawn replacements (HuntMode keeps exactly one on the field).
  onObjectiveCollected?(world: World, collectorId: number): void;
  // True when this survivor has met the requirements to escape via
  // the exit (e.g. enough nuggets collected). Engine checks this on
  // overlap and flips the survivor's `exited` flag. Modes without an
  // exit zone can omit this hook.
  canSurvivorExit?(survivor: CharacterEntity): boolean;
  // True when the hunter's "Danger Mode" buffs should apply. Hunt
  // mode flips this on once any survivor has reached the exit
  // threshold — survivors are now scrambling for the exit and the
  // hunter gets +10% speed / -10% cooldowns to close the gap.
  // Modes without a danger phase can omit this hook.
  isDangerMode?(world: World): boolean;
}
