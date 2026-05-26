# CLAUDE.md — Brambletooth

Project guidance for Claude Code. Keep this file load-bearing and current.

## Project summary

Brambletooth is an asymmetric isometric arena game. v0.1 ships a single
playable mode — 1v1 Hunter (AI-controlled Slagy) vs Survivor (player as
Match) — running on Canvas 2D with a hand-rolled flat-shaded low-poly
isometric renderer, no game engine. The 1v1 build exists to validate
the engine: data-driven characters, abilities, modes, and arenas slot
in without engine changes, so the roadmap (1vMany, FFA, progression,
multiplayer) can extend the same core. TypeScript strict, Vite for
dev/build.

## Architecture map

```
src/
├── core/        Engine loop, world state, input, entity types, math
├── render/      Iso renderer (Canvas 2D)
├── ui/          HUD overlay
├── abilities/   Ability registry + definitions (data + cast handler)
├── characters/  Character data records (stats, ability slot ids)
├── modes/       GameMode interface + mode implementations
├── ai/          AI controllers (rule-based, per character)
├── arenas/      Arena config + procedural prop/objective placement
└── main.ts      Wires world + mode + input + AI + engine + renderer
```

- [src/core/engine.ts](src/core/engine.ts) — fixed-order tick: gather
  intents → movement + statuses + cooldowns → fire abilities →
  projectiles → traps → objectives → death → outcome check. Player
  and AI feed the same `AIIntent` shape so the engine doesn't branch
  on player-vs-AI for movement/abilities.
- [src/core/world.ts](src/core/world.ts) — owns entity array, arena
  config, round elapsed/time-limit. No knowledge of modes or win
  conditions.
- [src/core/entity.ts](src/core/entity.ts) — discriminated-union
  entity types (`character | projectile | trap | objective | prop`)
  with `isX` type guards. Lightweight, not full ECS.
- [src/core/input.ts](src/core/input.ts) — single `InputState`
  struct; DOM listeners write, engine reads. `pressedAbilities` is
  edge-triggered and cleared by the engine after consumption.
- [src/render/renderer.ts](src/render/renderer.ts) — 2:1 iso
  projection (`worldToScreen` / `screenToWorld`), depth sort by
  world `y`, per-entity flat-shaded draw functions. DPR scaling is
  done in [src/main.ts](src/main.ts) via `setTransform`; the
  renderer uses CSS-pixel dimensions via `setDimensionSource`.
- [src/abilities/abilities.ts](src/abilities/abilities.ts) —
  `registerAbility({...})` populates the `ABILITIES` registry at
  import time. Each ability is `{ id, name, description, cooldown,
  cast(ctx) }`. `cast` mutates the world directly (spawn
  projectile/trap, apply status, etc.).
- [src/characters/characters.ts](src/characters/characters.ts) —
  pure data. `abilities` is a tuple of up to 4 ability ids; the HUD
  treats `undefined` slots as LOCKED.
- [src/modes/mode.ts](src/modes/mode.ts) — minimal `GameMode`
  interface: `initialize(world)` and `checkOutcome(world)`. Adding a
  new mode = new file implementing this.
- [src/ai/ai.ts](src/ai/ai.ts) — per-character `AIController`
  classes that emit `AIIntent`. Slagy is an explicit rule-based FSM
  (distance bands → which ability); Match is a flee-or-collect
  controller used when the survivor is AI-driven.
- [src/arenas/forest.ts](src/arenas/forest.ts) — `ArenaConfig`
  constant + `buildForest(world, seed, objCount)` placer using a
  seeded mulberry32 RNG. Reserves spawn zones to avoid embedding
  characters in props.

## Extension recipes

### Add a new ability

1. In [src/abilities/abilities.ts](src/abilities/abilities.ts), call
   `registerAbility({ id, name, description, cooldown, cast })`.
2. `cast({ world, caster, aim })` mutates world — spawn projectiles
   via `world.spawn<ProjectileEntity>({...})`, apply statuses via
   `caster.statuses["foo"] = seconds`.
3. Reference the new id from a character's `abilities` tuple in
   [src/characters/characters.ts](src/characters/characters.ts).
4. If the ability needs a new status effect (e.g. `stunned`), wire
   it into the movement loop in
   [src/core/engine.ts](src/core/engine.ts) (`speedMult` block) and
   the renderer status overlay in
   [src/render/renderer.ts](src/render/renderer.ts).
5. No engine API change required for: damage, slow, teleport,
   self-buff, ground-trap, projectile-with-status.

### Add a new character

1. Add an entry to `CHARACTERS` in
   [src/characters/characters.ts](src/characters/characters.ts) —
   `{ id, name, role, maxHp, speed, radius, color, colorDark,
   abilities }`. Up to 4 ability ids; trailing slots `undefined` =
   locked.
2. Register any new abilities first (see above).
3. If AI-controlled, add a controller class in
   [src/ai/ai.ts](src/ai/ai.ts) and wire it in
   [src/main.ts:60-65](src/main.ts) (the `characterId` switch in the
   AI setup block; also mirrored in `restartRound`).
4. To use in a round, set `hunterCharacterId` / `survivorCharacterId`
   in the mode config in [src/main.ts:47-52](src/main.ts).

### Add a new mode

1. New file in [src/modes/](src/modes/) implementing `GameMode` from
   [src/modes/mode.ts](src/modes/mode.ts) — `initialize(world)`
   spawns characters/objectives; `checkOutcome(world)` returns
   `"ongoing" | "hunter_win" | "survivor_win" | "draw"`.
2. For 1vMany: spawn N hunters (or survivors) in `initialize`, then
   in [src/main.ts](src/main.ts) attach an `AIController` per AI
   character. The engine already loops over all characters — no
   change required.
3. For FFA: introduce a third team value in
   [src/core/entity.ts](src/core/entity.ts) (`type Team`) and adjust
   targeting in [src/abilities/abilities.ts](src/abilities/abilities.ts)
   (the `targetTeam` field on projectiles/traps) and in the engine
   damage paths.
4. Swap the active mode by constructing your new class in
   [src/main.ts:47](src/main.ts) instead of `OneVOneMode`.

### Add a new arena

1. New file in [src/arenas/](src/arenas/) exporting `<NAME>_ARENA_CONFIG`
   (an `ArenaConfig`) and `build<Name>(world, seed, objCount)` that
   spawns props + objectives, reserving spawn zones the way
   [src/arenas/forest.ts](src/arenas/forest.ts) does.
2. New prop shapes: add to `PropShape` in
   [src/core/entity.ts](src/core/entity.ts) and add a draw branch in
   `drawProp` in [src/render/renderer.ts](src/render/renderer.ts).
3. Swap the active arena in [src/main.ts:43-44](src/main.ts) (the
   `new World(...)` arg + the `buildForest(...)` call).

## Design constraints to preserve

- **Data-driven content.** Adding a character, ability, mode, or
  arena must not require changes in [src/core/engine.ts](src/core/engine.ts).
  If a new feature wants engine surgery, first ask whether it can
  be expressed as new status / new entity kind / new mode method.
- **Rule-based readable AI.** Keep [src/ai/ai.ts](src/ai/ai.ts) as
  explicit distance-band / cooldown-check rules with comments. No
  behavior trees, no learned policies. Auditability is the point.
- **Canvas 2D, flat-shaded low-poly iso, no engine.** No three.js,
  no PixiJS, no WebGL. Visual language is solid polygons with one
  light direction from upper-left.
- **TypeScript strict stays clean.** `npm run typecheck` must pass
  with zero errors before any commit. `noUnusedLocals` /
  `noUnusedParameters` are off intentionally — don't enable them.
- **One render pass, depth sort by world y.** No z-buffer, no
  layers. If you add a new entity kind, give it a sensible `pos.y`
  for the sort.

## Roadmap

From [README.md](README.md):

1. **v0.1 (current)** — 1v1 engine validation.
2. **v0.2** — progression system (XP, points, ability upgrades, unlocks).
3. **v0.3** — 1vMany mode + multiple AI hunters or survivors.
4. **v0.4** — FFA mode.
5. **v0.5** — character selection screen, post-round flow, save/load.
6. **v0.6** — multiplayer networking (local first, then online).

Open design question: Match has no offense by design. If 1v1 feels
one-sided in playtesting, add a panic-button interrupt to slot 3
(knockback or brief blind) — but only if data shows it's needed.

## Conventions

- **Commits**: conventional-commit prefixes — `feat:`, `fix:`,
  `refactor:`, `docs:`, `chore:`, `style:`, `test:`. One concern
  per commit; describe the *why* in the body when non-obvious.
- **Branches**: feature work on `dev`; merge to `main` only via PR
  once a slice is playable end-to-end.
- **File names**: lowerCamel for `.ts` (`oneVOne.ts`), single-word
  lowercase for folders. Match the existing layout — don't
  introduce `src/lib/` or `src/utils/`; if a helper doesn't fit
  `core/`, that's a signal to think about it.
- **Tests**: none yet. When added, colocate as `*.test.ts` next to
  the source, run via Vite + Vitest (not yet wired). Pure functions
  in [src/core/math.ts](src/core/math.ts) and ability `cast`
  handlers are the obvious first targets.
- **PII rule (global)**: never commit real-name or non-noreply
  email. Author identity must be `decoher3nce
  <250739335+decoher3nce@users.noreply.github.com>`. Verify with
  `git config user.email` before any clone-fresh first commit.
