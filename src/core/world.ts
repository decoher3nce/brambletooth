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
}

export class World {
  entities: Entity[] = [];
  arena: ArenaConfig;
  private nextId: EntityId = 1;
  // Round time elapsed (seconds)
  elapsed: number = 0;
  // Round time limit (seconds)
  timeLimit: number;

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
