// The world holds all entity state and the active arena.
// It does NOT know about modes or win conditions; that's a mode's job.

import type { Entity, EntityId, CharacterEntity, Team } from "./entity";
import { isCharacter } from "./entity";
import type { Vec2 } from "./math";

export interface ArenaConfig {
  // The playable area is a rectangle (could become polygon later).
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  // Fence is rendered around the bounds.
  fenceColor: string;
  groundColor: string;
  // Optional grid line color for ground texture.
  gridColor: string;
  // Visual variant for objective entities. "nugget" is the default
  // (golden lump used by Forest + Factory); "gem" paints a faceted
  // crystal cluster used by the Cave world. Both pick up + count
  // the same way at the engine layer; this only switches the art.
  objectiveStyle?: "nugget" | "gem";
  // When true, the renderer paints a heavy darkness overlay over
  // the playfield with cut-outs for each character's forward
  // flashlight cone and any crystal-prop ambient light circles.
  // Used by the Cave world to deliver the "low vision" gameplay.
  useFlashlightFOV?: boolean;
  // Optional procedural floor texture. "rough-stone" overlays a
  // pre-baked noise + splotch pattern on top of groundColor and
  // suppresses the regular grid lines, giving the cave a rough
  // cavern-floor read instead of straight grid tiles.
  groundTexture?: "rough-stone";
}

export class World {
  entities: Entity[] = [];
  arena: ArenaConfig;
  private nextId: EntityId = 1;
  // Round time elapsed (seconds)
  elapsed: number = 0;
  // Round time limit (seconds)
  timeLimit: number;
  // FFA mode flag — when true, damage paths in the engine and
  // abilities iterate ALL characters instead of one team and skip
  // the team-equality check entirely (still respecting "don't
  // damage yourself"). Set by FFAMode at construction.
  ffaMode: boolean = false;
  // Per-character kill counter (entity id → kills). Maintained by
  // the engine — on character death, killCounts[lastDamagerId] is
  // incremented. FFAMode's most-kills win condition reads this
  // directly. Other modes don't query it but it's harmless to have.
  killCounts: Map<EntityId, number> = new Map();

  constructor(arena: ArenaConfig, timeLimit: number) {
    this.arena = arena;
    this.timeLimit = timeLimit;
  }

  spawn<E extends Entity>(entity: Omit<E, "id">): E {
    const e = { ...entity, id: this.nextId++ } as E;
    this.entities.push(e);
    return e;
  }

  remove(id: EntityId): void {
    const idx = this.entities.findIndex((e) => e.id === id);
    if (idx >= 0) this.entities.splice(idx, 1);
  }

  getById(id: EntityId): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  charactersOnTeam(team: Team): CharacterEntity[] {
    return this.entities.filter(
      (e): e is CharacterEntity => isCharacter(e) && e.team === team && !e.dead,
    );
  }

  allCharacters(): CharacterEntity[] {
    return this.entities.filter(isCharacter);
  }

  // Pointer to the player-controlled character (for camera, HUD).
  playerCharacter(): CharacterEntity | undefined {
    return this.allCharacters().find((c) => c.isPlayer);
  }

  // Returns true if the position is inside the playable bounds.
  inBounds(p: Vec2, radius: number = 0): boolean {
    const b = this.arena.bounds;
    return (
      p.x - radius >= b.minX &&
      p.x + radius <= b.maxX &&
      p.y - radius >= b.minY &&
      p.y + radius <= b.maxY
    );
  }

  // Cull dead entities from the array.
  cleanupDead(): void {
    this.entities = this.entities.filter((e) => !e.dead);
  }
}
