# Brambletooth

Asymmetric isometric arena game. v0.1 ships a single playable mode
(1v1 Hunter vs Survivor) so we can validate the engine before expanding
to 1vMany and Free-For-All.

## Getting started

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually <http://localhost:5173>).

## What's in v0.1

- 1v1 Hunter (Slagy, AI) vs Survivor (Match, you).
- Forest arena with fence boundary, trees, stumps, rocks, and 5 objectives.
- 5-minute round timer (configurable in `src/main.ts`).
- Survivor win conditions: collect 4 of 5 objectives, or outlast the timer.
- Hunter win condition: reduce survivor HP to 0 before timer expires.

### Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Aim |
| Left click | Use first ability |
| Q / E / R / F | Use ability slot 1 / 2 / 3 / 4 |
| Esc | Pause |
| R | Restart round (when round is over) |

Match starts with only the first two ability slots filled (Overdrive, Glitch);
the other two are locked. This is the "starts with 2 abilities" rule applied.

### Slagy's kit (AI)

- **Slash** — short melee swipe (0.6s cd)
- **Slime Shot** — ranged glob that slows on hit (1.2s cd)
- **Slime Trap** — sticky ground hazard, damages + slows (4s cd)
- **Relocate** — teleport toward aim (6s cd)

### Match's kit (player)

- **Overdrive** — 2.5s speed boost (5s cd)
- **Glitch** — short-range teleport with brief phasing (3.5s cd)
- Slots 3 & 4 — locked (unlock via progression later)

## Architecture

Designed so modes, characters, abilities, and arenas can be added without
modifying the engine.

```
src/
├── core/         Engine, world state, input, math, entity types
├── render/       Isometric renderer (Canvas 2D, flat-shaded low-poly)
├── ui/           HUD
├── abilities/    Ability registry + definitions (data + handlers)
├── characters/   Character defs (data only — stats, ability slots)
├── modes/        Mode interface + 1v1 implementation
├── ai/           AI controllers (Slagy hunter FSM, Match survivor)
├── arenas/       Arena scene configs and prop generators
└── main.ts       Wires it all together
```

### Adding things

- **A new ability**: add a `registerAbility({...})` call in
  `src/abilities/abilities.ts`. Reference it by id in a character def.
- **A new character**: add an entry to `CHARACTERS` in
  `src/characters/characters.ts`. List up to 4 ability ids.
- **A new mode**: implement `GameMode` in `src/modes/`. Adding 1vMany or FFA
  means a new file, not engine changes.
- **A new arena**: create a config + builder in `src/arenas/`, like the
  forest example.

## Roadmap

1. **v0.1 (this build)**: 1v1 engine validation.
2. **v0.2**: progression system (XP, points, ability upgrades, unlocks).
3. **v0.3**: 1vMany mode + multiple AI hunters or survivors.
4. **v0.4**: FFA mode.
5. **v0.5**: character selection screen, post-round flow, save/load.
6. **v0.6**: multiplayer networking (local first, then online).

## Design notes

- Match has no offense by design — pure evasion role makes the asymmetry
  meaningful. If 1v1 feels too one-sided in playtesting, consider giving
  him a panic-button interrupt (knockback, brief blind) for slot 3.
- Objective placement biases toward corners to force survivor exposure.
- AI is rule-based and deliberately readable (`src/ai/ai.ts`) rather than
  a behavior tree or learned policy, so behavior is auditable and tunable.
