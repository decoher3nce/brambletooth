// Character select screen. Drawn entirely on the game canvas to keep the
// visual language consistent with the round itself.
//
// Layout (landscape, ~1024×700+):
//   - Title at top.
//   - HUNTERS section: label + horizontal grid of 6 tiles.
//   - SURVIVORS section: label + horizontal grid of 6 tiles.
//   - Locked future characters render as "?" tiles (non-interactive).
//   - Detail card on the right of the grid: portrait, name + role,
//     narrative, displayStats, ability list with cooldown / charge.
//   - START button below, enabled once any character is selected.
//
// Interaction model: click/tap any filled tile selects it (highlight +
// detail). Hover (desktop) gives a temporary preview without committing.
// START commits and transitions main.ts to the "playing" scene.

import { CHARACTERS } from "../characters/characters";
import type { CharacterDef, CharacterRole } from "../characters/characters";
import { ABILITIES } from "../abilities/abilities";

export interface SelectHooks {
  onStart: (characterId: string) => void;
  isTouchMode: () => boolean;
  // Returns true when the select scene is the active scene. When false,
  // all input handlers short-circuit — but the listeners stay bound to
  // avoid leaking/reattaching across scene transitions.
  isActive: () => boolean;
}

interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
  characterId: string | null; // null = locked "?" slot
  role: CharacterRole;
}

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Roster ambition. Adjust as the actual roster grows. Each section reserves
// SLOTS_PER_ROLE tiles; filled ones come first (in CHARACTERS insertion
// order), the rest render as locked "?".
const SLOTS_PER_ROLE = 6;

const TILE_W = 96;
const TILE_H = 96;
const TILE_GAP = 10;
const ROW_WIDTH = SLOTS_PER_ROLE * TILE_W + (SLOTS_PER_ROLE - 1) * TILE_GAP;
const DETAIL_W = 340;
const DETAIL_H = 540;
const DETAIL_GAP = 32;
const SECTION_GAP = 28;

const BG_COLOR = "#1a2421";
const PANEL_BG = "rgba(20, 30, 28, 0.85)";
const PANEL_STROKE = "rgba(255, 255, 255, 0.08)";
const TILE_BG = "rgba(40, 52, 48, 0.85)";
const TILE_BG_LOCKED = "rgba(20, 26, 24, 0.7)";
const TILE_BORDER = "rgba(255, 255, 255, 0.12)";
const TILE_BORDER_HOVER = "rgba(255, 216, 74, 0.55)";
const TILE_BORDER_SELECTED = "#ffd84a";
const TEXT = "#fff";
const TEXT_DIM = "rgba(255, 255, 255, 0.55)";
const TEXT_LOCKED = "rgba(255, 255, 255, 0.25)";
const ACCENT = "#ffd84a";

export class SelectScreen {
  private selectedId: string | null = null;
  private hoverId: string | null = null;
  // Hit zones recomputed each frame from current dims.
  private tiles: TileRect[] = [];
  private startBtn: ButtonRect | null = null;
  // Mouse position in CSS pixels — used to derive hover on desktop.
  private mouse: { x: number; y: number } | null = null;

  constructor() {
    // Default selection: first survivor in CHARACTERS so START is
    // immediately useful. Falls back to first hunter if no survivor.
    const survivors = this.charactersByRole("survivor");
    const hunters = this.charactersByRole("hunter");
    this.selectedId = survivors[0]?.id ?? hunters[0]?.id ?? null;
  }

  // Allow main.ts to set the previous selection when returning from a
  // round (round-end → restart → back to select).
  setSelected(characterId: string | null): void {
    if (characterId && CHARACTERS[characterId]) {
      this.selectedId = characterId;
    }
  }

  bind(
    canvas: HTMLCanvasElement,
    getDims: () => { w: number; h: number },
    hooks: SelectHooks,
  ): void {
    const pointFromMouse = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const pointFromTouch = (t: Touch) => {
      const rect = canvas.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    };

    canvas.addEventListener("mousemove", (ev) => {
      if (!hooks.isActive()) return;
      if (hooks.isTouchMode()) return; // ignore mouse on touch devices
      this.mouse = pointFromMouse(ev);
      this.refreshHover();
    });

    canvas.addEventListener("mouseleave", () => {
      this.mouse = null;
      this.hoverId = null;
    });

    canvas.addEventListener("mousedown", (ev) => {
      if (!hooks.isActive()) return;
      if (hooks.isTouchMode()) return;
      const p = pointFromMouse(ev);
      this.handleTap(p, hooks);
    });

    canvas.addEventListener(
      "touchstart",
      (ev) => {
        if (!hooks.isActive()) return;
        ev.preventDefault();
        const t = ev.changedTouches[0];
        if (!t) return;
        const p = pointFromTouch(t);
        this.handleTap(p, hooks);
      },
      { passive: false },
    );

    // Keyboard navigation. Left/Right moves within a role row; Up/Down
    // switches between the hunter and survivor rows (keeping column);
    // Enter/Space starts the round with the current selection.
    window.addEventListener("keydown", (ev) => {
      if (!hooks.isActive()) return;
      switch (ev.key) {
        case "ArrowLeft":
          ev.preventDefault();
          this.moveSelection(-1, 0);
          break;
        case "ArrowRight":
          ev.preventDefault();
          this.moveSelection(1, 0);
          break;
        case "ArrowUp":
          ev.preventDefault();
          this.moveSelection(0, -1);
          break;
        case "ArrowDown":
          ev.preventDefault();
          this.moveSelection(0, 1);
          break;
        case "Enter":
        case " ":
          ev.preventDefault();
          if (this.selectedId) hooks.onStart(this.selectedId);
          break;
      }
    });
  }

  // Move the keyboard selection. dx steps within the current role's filled
  // list; dy switches role rows (negative = hunters, positive = survivors),
  // preserving the column index where possible. Keyboard nav overrides any
  // mouse-hover preview so the detail panel tracks the selection.
  private moveSelection(dx: number, dy: number): void {
    const hunters = this.charactersByRole("hunter");
    const survivors = this.charactersByRole("survivor");

    let role: CharacterRole = "survivor";
    let idx = 0;
    const hIdx = hunters.findIndex((c) => c.id === this.selectedId);
    const sIdx = survivors.findIndex((c) => c.id === this.selectedId);
    if (hIdx >= 0) {
      role = "hunter";
      idx = hIdx;
    } else if (sIdx >= 0) {
      role = "survivor";
      idx = sIdx;
    }

    if (dy !== 0) {
      role = dy < 0 ? "hunter" : "survivor";
    } else if (dx !== 0) {
      idx += dx;
    }

    const list = role === "hunter" ? hunters : survivors;
    if (list.length === 0) return;
    idx = Math.max(0, Math.min(list.length - 1, idx));
    const target = list[idx];
    if (target) {
      this.selectedId = target.id;
      this.hoverId = null;
    }
  }

  // Hit-test against current tile/button rects (which are recomputed each
  // draw). If the user taps before the first draw, hit zones are empty and
  // taps no-op until the first frame paints — fine for our use case.
  private handleTap(p: { x: number; y: number }, hooks: SelectHooks): void {
    for (const tile of this.tiles) {
      if (
        tile.characterId &&
        p.x >= tile.x && p.x <= tile.x + tile.w &&
        p.y >= tile.y && p.y <= tile.y + tile.h
      ) {
        this.selectedId = tile.characterId;
        // On touch, we also want the detail panel to show the just-tapped
        // character — clear hover so the displayed character == selected.
        this.hoverId = null;
        return;
      }
    }
    if (this.startBtn && this.selectedId) {
      const b = this.startBtn;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        hooks.onStart(this.selectedId);
        return;
      }
    }
  }

  private refreshHover(): void {
    if (!this.mouse) {
      this.hoverId = null;
      return;
    }
    const p = this.mouse;
    for (const tile of this.tiles) {
      if (
        tile.characterId &&
        p.x >= tile.x && p.x <= tile.x + tile.w &&
        p.y >= tile.y && p.y <= tile.y + tile.h
      ) {
        this.hoverId = tile.characterId;
        return;
      }
    }
    this.hoverId = null;
  }

  private charactersByRole(role: CharacterRole): CharacterDef[] {
    return Object.values(CHARACTERS).filter((c) => c.role === role);
  }

  // The character shown in the detail panel = hover if any, else selected.
  // Lets desktop users preview before committing without losing the
  // current selection.
  private displayedId(): string | null {
    return this.hoverId ?? this.selectedId;
  }

  draw(ctx: CanvasRenderingContext2D, dims: { w: number; h: number }): void {
    const cw = dims.w;
    const ch = dims.h;

    // Background fill so we don't see stale game frame underneath.
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, cw, ch);

    // Title.
    ctx.fillStyle = TEXT;
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("CHOOSE YOUR CHARACTER", cw / 2, 56);

    // Layout block: grid on left, detail card on right, centered as a unit.
    const layoutW = ROW_WIDTH + DETAIL_GAP + DETAIL_W;
    const layoutX = Math.max(20, (cw - layoutW) / 2);
    const gridX = layoutX;
    const detailX = layoutX + ROW_WIDTH + DETAIL_GAP;

    // Vertical anchor: try to start sections below the title, leave room
    // for the START button at the bottom.
    const gridTop = 96;
    const sectionLabelGap = 6;
    const rowH = TILE_H;
    const huntersLabelY = gridTop;
    const huntersRowY = huntersLabelY + 12 + sectionLabelGap;
    const survivorsLabelY = huntersRowY + rowH + SECTION_GAP;
    const survivorsRowY = survivorsLabelY + 12 + sectionLabelGap;
    const gridBottom = survivorsRowY + rowH;

    // Recompute hit zones for the grid.
    this.tiles = [];
    this.drawRoleSection(
      ctx,
      "HUNTERS",
      "hunter",
      gridX,
      huntersLabelY,
      huntersRowY,
    );
    this.drawRoleSection(
      ctx,
      "SURVIVORS",
      "survivor",
      gridX,
      survivorsLabelY,
      survivorsRowY,
    );

    // Detail card.
    this.drawDetailCard(ctx, detailX, gridTop, DETAIL_W, DETAIL_H);

    // START button: under the grid, centered on grid column.
    const startW = 220;
    const startH = 56;
    const startX = gridX + (ROW_WIDTH - startW) / 2;
    const startY = Math.max(gridBottom + 36, ch - 100);
    this.startBtn = { x: startX, y: startY, w: startW, h: startH };
    this.drawStartButton(ctx, this.startBtn, this.selectedId !== null);
  }

  private drawRoleSection(
    ctx: CanvasRenderingContext2D,
    label: string,
    role: CharacterRole,
    x: number,
    labelY: number,
    rowY: number,
  ): void {
    ctx.fillStyle = TEXT_DIM;
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x, labelY + 12);

    const filled = this.charactersByRole(role);
    for (let i = 0; i < SLOTS_PER_ROLE; i++) {
      const tileX = x + i * (TILE_W + TILE_GAP);
      const def = filled[i] ?? null;
      const tile: TileRect = {
        x: tileX,
        y: rowY,
        w: TILE_W,
        h: TILE_H,
        characterId: def?.id ?? null,
        role,
      };
      this.tiles.push(tile);
      this.drawTile(ctx, tile, def);
    }
  }

  private drawTile(
    ctx: CanvasRenderingContext2D,
    tile: TileRect,
    def: CharacterDef | null,
  ): void {
    const locked = def === null;
    const selected = def !== null && def.id === this.selectedId;
    const hovered = def !== null && def.id === this.hoverId;

    ctx.fillStyle = locked ? TILE_BG_LOCKED : TILE_BG;
    this.roundedRect(ctx, tile.x, tile.y, tile.w, tile.h, 8);
    ctx.fill();

    if (selected) {
      ctx.strokeStyle = TILE_BORDER_SELECTED;
      ctx.lineWidth = 3;
    } else if (hovered) {
      ctx.strokeStyle = TILE_BORDER_HOVER;
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = TILE_BORDER;
      ctx.lineWidth = 1;
    }
    this.roundedRect(ctx, tile.x, tile.y, tile.w, tile.h, 8);
    ctx.stroke();

    if (locked) {
      ctx.fillStyle = TEXT_LOCKED;
      ctx.font = "bold 32px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", tile.x + tile.w / 2, tile.y + tile.h / 2 - 2);
      return;
    }

    // Filled tile: mini portrait + name.
    const cx = tile.x + tile.w / 2;
    const cy = tile.y + tile.h / 2 - 6;
    this.drawPortrait(ctx, def!, cx, cy, 0.9);

    ctx.fillStyle = TEXT;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(def!.name, tile.x + tile.w / 2, tile.y + tile.h - 8);
  }

  private drawDetailCard(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    ctx.fillStyle = PANEL_BG;
    this.roundedRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.strokeStyle = PANEL_STROKE;
    ctx.lineWidth = 1;
    this.roundedRect(ctx, x, y, w, h, 12);
    ctx.stroke();

    const id = this.displayedId();
    if (!id) {
      ctx.fillStyle = TEXT_DIM;
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Select a character", x + w / 2, y + h / 2);
      return;
    }
    const def = CHARACTERS[id];
    if (!def) return;

    const pad = 18;
    let cy = y + pad;

    // Portrait (large).
    const portraitY = cy + 70;
    this.drawPortrait(ctx, def, x + w / 2, portraitY, 2.0);
    cy = cy + 150;

    // Name + role.
    ctx.fillStyle = TEXT;
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(def.name, x + w / 2, cy);
    cy += 6;
    ctx.fillStyle = ACCENT;
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(def.role.toUpperCase(), x + w / 2, cy + 14);
    cy += 30;

    // Narrative (wrapped).
    ctx.fillStyle = TEXT_DIM;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    const narrativeLines = wrapText(ctx, def.narrative, w - pad * 2);
    for (const line of narrativeLines) {
      ctx.fillText(line, x + pad, cy);
      cy += 16;
    }
    cy += 6;

    // Divider.
    ctx.strokeStyle = PANEL_STROKE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + pad, cy);
    ctx.lineTo(x + w - pad, cy);
    ctx.stroke();
    cy += 12;

    // Stats list (label : value).
    ctx.font = "12px system-ui, sans-serif";
    for (const stat of def.displayStats()) {
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = "left";
      ctx.fillText(stat.label, x + pad, cy);
      ctx.fillStyle = TEXT;
      ctx.textAlign = "right";
      ctx.fillText(stat.value, x + w - pad, cy);
      cy += 16;
    }
    cy += 8;

    // Abilities (name + cooldown / charge hint).
    ctx.fillStyle = ACCENT;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("ABILITIES", x + pad, cy);
    cy += 14;
    ctx.font = "12px system-ui, sans-serif";
    for (const slot of def.abilities) {
      if (!slot) continue;
      const ab = ABILITIES[slot];
      if (!ab) continue;
      ctx.fillStyle = TEXT;
      ctx.textAlign = "left";
      ctx.fillText(`• ${ab.name}`, x + pad, cy);
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = "right";
      const tag = ab.chargeTime
        ? `${ab.chargeTime}s charge / ${ab.cooldown}s cd`
        : `${ab.cooldown}s cd`;
      ctx.fillText(tag, x + w - pad, cy);
      cy += 15;
    }
  }

  // Draw a character body for display only — simplified version of
  // renderer.drawCharacter (no facing, no statuses, no HP bar). Reuses the
  // same flat-shaded dome language so portraits feel native.
  private drawPortrait(
    ctx: CanvasRenderingContext2D,
    def: CharacterDef,
    cx: number,
    cy: number,
    scale: number,
  ): void {
    const r = Math.round(28 * scale);
    const h = r * 1.6;

    // Shadow.
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Dark base.
    ctx.fillStyle = def.colorDark;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body dome.
    ctx.fillStyle = def.color;
    ctx.beginPath();
    ctx.arc(cx, cy - h * 0.4, r, Math.PI, 0);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();

    // Highlight blob.
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.beginPath();
    ctx.arc(cx - r * 0.4, cy - h * 0.5, r * 0.35, 0, Math.PI * 2);
    ctx.fill();

    // Eyes (forward-facing).
    const eyeR = Math.max(2, Math.round(r * 0.13));
    const eyeOff = r * 0.28;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(cx - eyeOff, cy - h * 0.55, eyeR, 0, Math.PI * 2);
    ctx.arc(cx + eyeOff, cy - h * 0.55, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    const pupilR = Math.max(1, Math.round(eyeR * 0.5));
    ctx.beginPath();
    ctx.arc(cx - eyeOff, cy - h * 0.55, pupilR, 0, Math.PI * 2);
    ctx.arc(cx + eyeOff, cy - h * 0.55, pupilR, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawStartButton(
    ctx: CanvasRenderingContext2D,
    b: ButtonRect,
    enabled: boolean,
  ): void {
    ctx.fillStyle = enabled ? ACCENT : "rgba(255, 216, 74, 0.25)";
    this.roundedRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.fillStyle = enabled ? "#1a2421" : "rgba(26, 36, 33, 0.5)";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("START", b.x + b.w / 2, b.y + b.h / 2);
  }

  private roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}

// Word-wrap helper. Splits text into lines no wider than maxWidth in the
// current ctx font. Naive (splits on spaces only) but enough for the
// narrative copy we ship.
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const trial = current ? current + " " + w : w;
    if (ctx.measureText(trial).width <= maxWidth) {
      current = trial;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}
