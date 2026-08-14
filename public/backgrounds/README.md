# Arena background images

Bespoke top-down PNGs used by `ArenaConfig.backgroundImage` in
`src/arenas/*.ts`. Vite serves this directory under the base URL
(`/brambletooth/backgrounds/*`) at both dev and prod.

## Format

- **PNG**, sRGB, 8-bit.
- **Top-down** (as if looking straight down). The renderer applies
  the 2:1 iso projection at draw time via `ctx.transform`.
- **Dimensions**: 1 world unit = 1 image pixel. So for the
  standard 1400×1000 arena rectangle, deliver a 1400×1000 image.
  For Retina crispness, deliver 2× (2800×2000) and I'll size the
  render accordingly if you want — say the word.

## Sizes per world

| World | Image size |
| --- | --- |
| Forest, Cave, Factory, Volcano | 1400×1000 |
| Sandbox | 1800×1300 |

## What to include

- The **ground plane** — grass, dirt, worn paths, soft variation.
- Full-rectangle coverage — no transparent gaps inside the arena.

## What NOT to include

- **Props** (trees, rocks, crates) — those are separate entities.
- **The fence border** — drawn on top with the arena's `fenceColor`.
- **Spawn markers, exits, objectives, characters, shadows** — all
  dynamic entities.

## Style notes

- Keep contrast moderate. Characters are 15–28 world-unit circles
  with saturated body colors; a busy background fights them.
- Warm, muted mid-tones read best (existing forest uses `#3a5a32`).
- The renderer's default grid is **suppressed** whenever a
  background image is set, so the artwork carries its own detail.

## Filenames

Each arena's config points at a specific file. Current wiring:

- Forest — `forest.png`
