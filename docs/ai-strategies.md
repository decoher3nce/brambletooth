# AI character strategies per difficulty

A design + implementation reference. Each character's AI is a small rule-
based FSM (see `src/ai/ai.ts`); difficulty changes WHICH rules fire, the
quality of execution (aim noise, reaction delay), and how much
unpredictability gets layered on top.

The five difficulty tiers (`src/core/leveling.ts`):

| Tier      | Level offset | Stat mult            | Behavior posture       |
|-----------|--------------|----------------------|------------------------|
| Noob      | −20          | 30% HP · 70% spd · 30% dmg | Dumb, predictable      |
| Easy      | −10          | 60% HP · 85% spd · 60% dmg | Mostly dumb            |
| Normal    | 0            | 100% (baseline)            | Balanced               |
| Difficult | +10          | 200% HP · 110% spd · 200% dmg | Tactical              |
| Legendary | +20          | 400% HP · 130% spd · 400% dmg | Clever, anticipatory   |

Stat scaling stays the same — these notes are about BEHAVIOR.

---

## Tier-wide behavior parameters

Every AI reads the same `BehaviorConfig` derived from its difficulty
(`src/ai/behavior.ts`). The values below scale linearly between Noob
and Legendary; Easy / Difficult interpolate.

| Parameter             | Noob | Easy | Normal | Difficult | Legendary |
|-----------------------|-----:|-----:|-------:|----------:|----------:|
| `aimJitter` (rad)     | 0.40 | 0.25 | 0.12   | 0.05      | 0.00      |
| `reactionDelay` (s)   | 0.50 | 0.30 | 0.15   | 0.05      | 0.00      |
| `leadFactor`          | 0.00 | 0.10 | 0.25   | 0.45      | 0.70      |
| `tacticDiversity`     | 0.05 | 0.15 | 0.30   | 0.45      | 0.65      |
| `useEnvironment`      | no   | no   | maybe  | yes       | yes       |
| `predictMovement`     | no   | no   | no     | yes       | yes       |
| `abilityHesitation`   | 0.45 | 0.30 | 0.15   | 0.05      | 0.00      |
| `randomActionChance`  | 0.20 | 0.12 | 0.05   | 0.02      | 0.00      |

- `aimJitter` — random rotation added to aim vector. Noob misses a lot.
- `reactionDelay` — seconds before the AI commits to a freshly-detected
  threat. Noob lets the player walk past for half a second; Legendary
  reacts on the same tick.
- `leadFactor` — multiplier on `target.vel` used when aiming projectiles.
  Noob shoots where the target was; Legendary shoots where they'll be.
- `tacticDiversity` — probability of selecting a "non-obvious" branch in
  the decision tree (e.g. ambush vs straight chase). Higher = harder to
  predict what the AI will do next.
- `useEnvironment` — gate on environment-aware code paths: use props for
  cover, lure into animals, push toward streams/lava.
- `predictMovement` — when true, the AI projects the player's next ~0.5 s
  of motion and aims/positions for the predicted arrival point, not the
  current one.
- `abilityHesitation` — random per-tick probability of *holding* an
  ability that's off cooldown. Noob frequently doesn't use its kit;
  Legendary uses every ability the moment it's optimal.
- `randomActionChance` — probability of firing a non-optimal random
  ability for chaos. Noob frequently throws away abilities; Legendary
  never wastes one.

---

## Slagy (Hunter — melee + zone)

Kit: `slash` (melee), `slime_shot` (projectile), `slime_trap` (zone +
slow), `relocate` (teleport to target's vicinity).

| Tier | Strategy |
|------|----------|
| Noob      | Walks straight at the nearest survivor. Slashes only when in range. Fires slime_shot when off-cd regardless of distance. Never lays traps (they pretend to forget). |
| Easy      | Same as Noob + occasionally lays a trap when survivor is mid-range. Aim is noisy. |
| Normal    | Closes distance, slashes in melee, fires slime_shot at 80–350px with light lead, drops a trap at the survivor's feet every ~6 s, relocates when > 320px away. (Current behavior.) |
| Difficult | Leads projectiles (`leadFactor = 0.45`). Places traps on the survivor's *projected* path, not the current spot. Relocates AHEAD of survivors fleeing toward objectives, not behind them. Uses props for cover when survivor is shooting back. |
| Legendary | Leads heavily. Predicts the survivor's next 0.5 s and traps the arrival point. Relocates onto exits / objective spots when survivors are about to score. Lures Match into bears/boars by positioning across the animal pack from the survivor. Conserves slime_shot for openings (won't fire if survivor is behind cover). |

---

## Gravemarch (Hunter — tank with wall/shield)

Kit: `gravemarch_slash` (heavy melee), `rock_wall` (block), `rock_shield`
(immunity + reveal), `stone_step` (gap close, damages on pass).

| Tier | Strategy |
|------|----------|
| Noob      | Chases straight, slashes when adjacent. Never uses Rock Wall. Pops Rock Shield reactively after taking heavy damage. |
| Easy      | Adds Stone Step for closing gaps. Reactive shield. Rock Wall fires randomly. |
| Normal    | Shields below 55% HP. Stone Step closes from > 360px. Rock Wall dropped at survivor mid-range to cut escape. (Current behavior.) |
| Difficult | Walls placed at the survivor's projected escape path, not current pos. Stone-Steps into clumps (multiple survivors), choosing landing points that deal pass-through damage to more than one. Holds Rock Shield for OBJECTIVE contests rather than always popping reactively. |
| Legendary | Walls cap survivors against arena fences (no escape angle). Stone-Steps into pre-walled chokepoints (wall first, then step into the trapped area for a multi-hit). Shields RIGHT before objective collect so survivors can't damage him during the dash. Pushes survivors toward lava arms (Volcano world) by walling on the safe side. Uses cliff edges (Forest 3) to drop survivors. |

---

## Match (Survivor — speed + escape)

Kit: `overdrive` (speed buff), `glitch` (hold-to-charge teleport).

| Tier | Strategy |
|------|----------|
| Noob      | Wanders, picks up visible objectives. Panics and glitches in a random direction when hunter close. Never charges glitch. |
| Easy      | Heads to nearest objective. Panic teleports + overdrive when hunter is close. |
| Normal    | Routes toward nearest objective, fleeing when hunter < 220px. Overdrive at < 160, short glitch at < 100. (Current behavior.) |
| Difficult | Charges glitch FULLY before releasing — gets max range. Glitches toward exits when objective count is high. Uses overdrive as preemptive cushion before threat closes. |
| Legendary | Predicts hunter's intercept point and glitches PAST it. Lures hunter into wildlife on Forest 4 / 6 by routing through bear territory. Holds glitch as a panic button while sprinting on Sprint Boots. On cave maps, hides in dark zones outside the hunter's flashlight cone. On Volcano, pulls hunter near lava arms then sidesteps. |

---

## Magnek (Survivor — placement-based escape)

Kit: `place_plate` (drop teleport anchor), `magnesis` (channel → teleport
to plate).

| Tier | Strategy |
|------|----------|
| Noob      | Drops plates in a tight cluster. Magnesis only when hunter is on top of him. |
| Easy      | Plates spread slightly. Magnesis at < 200px. |
| Normal    | Builds a 240px-spaced plate network. Channels Magnesis early (at 200px) so the 1.2 s windup completes before the hunter closes. (Current behavior.) |
| Difficult | Plates placed near OBJECTIVES so each pickup is also a Magnesis anchor. Channels start when hunter is at 280–300px so the channel completes the instant the hunter is at striking range. |
| Legendary | Lays a plate behind a Rock Wall / cave rocks / tree clusters so Magnesis dumps the hunter into cover. On Cave 2, places a plate ACROSS minecart tracks so the hunter chasing through gets hit. On Volcano, plates on the safe side of lava arms — hunter can't cross to follow. |

---

## Necro (Survivor — zombie minions)

Kit: `caw` (audio + vision pulse), `resurrect` (spawn zombie minion),
`command_attack` (send zombies after a target).

| Tier | Strategy |
|------|----------|
| Noob      | Spawns zombies one at a time. Commands them at the closest character when panicking — even if it's a friendly survivor. |
| Easy      | Commands properly at hunters only. Spawns slowly. |
| Normal    | Tops up to 3 zombies during safe windows, commands them on the nearest hunter when < 280px. (Current behavior.) |
| Difficult | Positions zombies BETWEEN self and the hunter as a living wall. Caws to expose hidden hunters in caves. Stacks zombies near choke points. |
| Legendary | Pre-commands zombies on the hunter's incoming path, creating an ambush. Uses zombies to TANK Rock Wall contact damage so Necro can walk through behind them. Caws strategically when hunter is in flashlight blind spot. Saves command for the hunter's Rock Shield expiry so the swarm hits the moment immunity drops. |

---

## Unpredictability dimension

The "predictable but dumb / clever but unpredictable" axis is the
combination of three things:

1. **Tactical diversity** (`tacticDiversity` parameter). At Noob, every
   decision picks the single most-obvious branch. At Legendary, the AI
   weighted-randomly picks from a *portfolio* of strong tactics so the
   player can't memorize what comes next.

2. **Random chaos** (`randomActionChance`). Noob occasionally fires the
   wrong ability or moves the wrong direction — looks dumb because it
   IS. Legendary never does this; its variance comes from genuine
   tactical choice.

3. **Aim noise + reaction delay**. Independent of strategy, Noob *executes*
   badly. Even when it picks the right move it shoots crooked and
   reacts late.

So Noob is "predictable in WHAT they try to do, bad at DOING it." Legendary
is "varied in tactics, executed flawlessly." The middle tiers blend.

---

## Implementation map

- `src/core/leveling.ts` — owns `AiDifficulty` (already shipping)
- `src/ai/behavior.ts` — NEW. `BehaviorConfig` + `behaviorFor(diff)`
  factory that returns the per-tier parameter values from the table
  above.
- `src/ai/ai.ts`:
  - `AIController` instances now accept a `BehaviorConfig` in their
    constructor (default = Normal-tier config for back-compat).
  - `createAIController(characterId, difficulty?)` builds the right
    controller with the right config.
  - Each per-character class reads parameters from `this.cfg` at
    decision points: `applyJitter(aim, this.cfg.aimJitter)`,
    `if (Math.random() < this.cfg.randomActionChance) ...`, etc.
- `src/main.ts` — `applyLevelsToWorld` already knows the difficulty;
  passes it to `createAIController` when constructing the controllers
  map.

Phase 1 ships the infrastructure and the parameter-driven adjustments
(aim jitter, lead, hesitation, random chaos). The richer per-character
tactical branches in the tables above (environmental awareness, NPC
luring, ambush positioning) land in follow-up commits — they're scoped
by the same `useEnvironment` / `predictMovement` flags so the
plumbing is already in place.
