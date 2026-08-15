# Prop sprites

Bespoke per-prop-shape image variants that the renderer prefers over
the procedural draw functions. Variant slots are declared in
`src/render/propArt.ts` (`PROP_SPRITE_VARIANTS`); each prop entity
picks its slot deterministically from its id (`id % variants.length`),
so a specific tree always looks the same across frames but the forest
reads as varied.

Any missing image cleanly falls back to the procedural draw in
`renderer.ts`. Ship 1 variant or all 4 — no wiring changes needed.

## Format

- **PNG**, sRGB, 8-bit, **with transparency** — critical, since the
  sprite sits on top of the ground.
- **Billboard** — painted straight-on. The renderer does NOT apply
  the iso projection to props; trees always face the camera.
- **Anchor** — bottom-center of the image = the prop's world ground
  point (trunk base for a tree, contact point for a rock).
- Feather transparent edges cleanly (2–4 px inner margin) so
  anti-aliased alpha doesn't halo against the ground.
- Light from the **upper-left** to match the rest of the game.

## Sizes

Sprite is drawn at native pixel size, 1:1, in screen space.

| Shape | Suggested sprite size | World radius (collision) |
| --- | --- | --- |
| Tree | ~64–96 wide × ~96–140 tall | 28 |
| Stump | ~28 wide × ~20 tall | 14 |
| Rock | ~44 wide × ~40 tall | 22 |
| Crate | ~48 wide × ~48 tall | 24 |
| Oildrum | ~52 wide × ~64 tall | 26 |
| Caverock | ~52 wide × ~52 tall | 26 |
| Crystal | ~36 wide × ~48 tall | 18 |
| Pallet | ~36 wide × ~14 tall | 18 |
| Pipe | ~44 wide × ~44 tall | 22 |

You can go larger or smaller — the number just governs how much the
prop dominates the screen relative to characters. Characters are
15–25 world-unit radii; a tree ~2× that in canopy reads as "forest".

## What to include / avoid

- **Include**: the object itself, with shading (upper-left light).
- **Avoid**: ground shadow (renderer paints its own or handles depth
  sorting), snow/effects, drop-shadows outside the sprite.

## Slot filenames

Only trees are wired today. As new shapes get bespoke art, add them
to `PROP_SPRITE_VARIANTS` in `src/render/propArt.ts` and drop files
here to match.

- Tree — `tree_1.png`, `tree_2.png`, `tree_3.png`, `tree_4.png`
