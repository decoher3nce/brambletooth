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
import { CHARACTER_ART, drawGumdropBody } from "../render/characterArt";
import { playSound } from "../audio/sound";

export interface SelectHooks {
  // Fired when the primary button is pressed (START locally; READY toggle
  // in a networked lobby). Receives the current selection.
  onStart: (characterId: string) => void;
  // Fired whenever the selection changes (tap / arrow). Networked lobby
  // uses it to broadcast the pick live so the opponent sees it.
  onSelect?: (characterId: string) => void;
  isTouchMode: () => boolean;
  // Returns true when the select scene is the active scene. When false,
  // all input handlers short-circuit — but the listeners stay bound to
  // avoid leaking/reattaching across scene transitions.
  isActive: () => boolean;
}

// Optional overlay that turns the picker into a two-player networked lobby:
// a status line, a panel showing both players' picks + ready state, and a
// relabeled primary button. When null, the screen renders as the local
// single-player picker.
export interface LobbyPlayerLine {
  label: string; // e.g. "Player 1 (you)" or "<player-name> (you)"
  characterName: string | null; // resolved name, or null while picking
  ready: boolean;
  present: boolean; // false = slot empty / waiting to connect
  // New: lets tiles + panel rows color-code by player.
  slot?: number;
  characterId?: string | null;
  color?: string;
  you?: boolean;
}
export interface LobbyView {
  title: string;
  players: LobbyPlayerLine[];
  status: string | null; // block reason / "Starting…" — null when hidden
  buttonLabel: string;
  buttonEnabled: boolean;
}

// Per-slot colors used across the lobby — each player gets one consistent
// color in the panel row, tile pick tag, and selection box. Order is
// deliberately distinct (no two adjacent colors confuse each other).
export const SLOT_COLORS = [
  "#ff6b6b", // red
  "#4dabf7", // blue
  "#69db7c", // green
  "#ffd43b", // yellow
  "#cc5de8", // purple
  "#22b8cf", // cyan
  "#ff922b", // orange
  "#a9e34b", // lime
];
export function slotColor(slot: number | null | undefined): string {
  if (slot == null) return "#888";
  return SLOT_COLORS[slot % SLOT_COLORS.length];
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
const DETAIL_W = 380;
const DETAIL_H = 580;
const DETAIL_GAP = 32;
// Height reserved for the detail-card portrait. Sized to fit a
// 2× character (radius 56, ~2.6× tall = ~145px) with margin.
const DETAIL_PORTRAIT_H = 180;
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
  // Set in bind(); lets non-handler methods (moveSelection) fire onSelect.
  private hooks: SelectHooks | null = null;
  // Non-null in networked lobby mode (set each frame by main before draw).
  private lobbyView: LobbyView | null = null;
  // Hover/pin state for player rows so main can draw a profile tooltip.
  private playerRows: Array<{ rect: ButtonRect; name: string }> = [];
  private pinnedPlayer: string | null = null;

  // Toggle networked-lobby chrome. Pass null to render the local picker.
  setLobbyView(view: LobbyView | null): void {
    this.lobbyView = view;
  }

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

  // Current selection — networked lobby broadcasts this on entry so the
  // default highlight shows on the opponent's screen without a manual tap.
  getSelected(): string | null {
    return this.selectedId;
  }

  // Whichever player row the user is hovering (desktop) OR has tap-pinned
  // (touch). main reads this each frame to fetch their public profile and
  // draw the tooltip. Skips the local user — no point inspecting yourself.
  getHoveredPlayer(): { name: string; rect: ButtonRect } | null {
    if (this.pinnedPlayer) {
      const pinned = this.playerRows.find((r) => r.name === this.pinnedPlayer);
      if (pinned) return { name: pinned.name, rect: pinned.rect };
    }
    if (!this.mouse) return null;
    for (const row of this.playerRows) {
      const r = row.rect;
      if (
        this.mouse.x >= r.x && this.mouse.x <= r.x + r.w &&
        this.mouse.y >= r.y && this.mouse.y <= r.y + r.h
      ) {
        return { name: row.name, rect: r };
      }
    }
    return null;
  }

  bind(
    canvas: HTMLCanvasElement,
    getDims: () => { w: number; h: number },
    hooks: SelectHooks,
  ): void {
    this.hooks = hooks;
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
          if (this.selectedId) {
            playSound("ui_click");
            hooks.onStart(this.selectedId);
          }
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
    if (target && target.id !== this.selectedId) {
      this.selectedId = target.id;
      this.hoverId = null;
      playSound("ui_pick");
      this.hooks?.onSelect?.(target.id);
    }
  }

  // Hit-test against current tile/button rects (which are recomputed each
  // draw). If the user taps before the first draw, hit zones are empty and
  // taps no-op until the first frame paints — fine for our use case.
  private handleTap(p: { x: number; y: number }, hooks: SelectHooks): void {
    // Player rows first: tap-to-pin a profile tooltip; tap the same row
    // again (or anywhere else) clears it.
    for (const row of this.playerRows) {
      const r = row.rect;
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        playSound("ui_pick");
        this.pinnedPlayer = this.pinnedPlayer === row.name ? null : row.name;
        return;
      }
    }
    // Tap outside any pinned row clears the pin (silently — no sound).
    if (this.pinnedPlayer) this.pinnedPlayer = null;

    for (const tile of this.tiles) {
      if (
        tile.characterId &&
        p.x >= tile.x && p.x <= tile.x + tile.w &&
        p.y >= tile.y && p.y <= tile.y + tile.h
      ) {
        const changed = tile.characterId !== this.selectedId;
        this.selectedId = tile.characterId;
        // On touch, we also want the detail panel to show the just-tapped
        // character — clear hover so the displayed character == selected.
        this.hoverId = null;
        playSound("ui_pick");
        if (changed) hooks.onSelect?.(tile.characterId);
        return;
      }
    }
    if (this.startBtn && this.selectedId) {
      const b = this.startBtn;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        playSound("ui_click");
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

    // Title (lobby title in networked mode).
    ctx.fillStyle = TEXT;
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(this.lobbyView?.title ?? "CHOOSE YOUR CHARACTER", cw / 2, 56);

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

    // Networked lobby panel (both players' picks + ready) below the grid.
    if (this.lobbyView) {
      this.drawLobbyPanel(ctx, gridX, gridBottom + 28, ROW_WIDTH, this.lobbyView);
    }

    // Primary button: under the grid, centered on grid column. Label and
    // enabled state come from the lobby view when networked. Width is
    // measured against the label so long copy ("READY ✓ — TAP TO CANCEL")
    // fits comfortably without clipping or hugging the edge.
    const label = this.lobbyView ? this.lobbyView.buttonLabel : "START";
    const enabled = this.lobbyView
      ? this.lobbyView.buttonEnabled
      : this.selectedId !== null;
    ctx.save();
    ctx.font = "bold 18px system-ui, sans-serif";
    const measured = ctx.measureText(label).width;
    ctx.restore();
    const startW = Math.max(240, Math.ceil(measured) + 56);
    const startH = 56;
    const startX = gridX + (ROW_WIDTH - startW) / 2;
    const startY = Math.max(gridBottom + 36, ch - 100);
    this.startBtn = { x: startX, y: startY, w: startW, h: startH };
    this.drawStartButton(ctx, this.startBtn, enabled, label);
  }

  // Two-row panel: Player 1 / Player 2 with pick + ready state, plus a
  // status line beneath. Only drawn in networked lobby mode.
  private drawLobbyPanel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    view: LobbyView,
  ): void {
    const rowH = 30;
    const panelH = rowH * view.players.length + 14;
    ctx.fillStyle = PANEL_BG;
    this.roundedRect(ctx, x, y, w, panelH, 8);
    ctx.fill();
    ctx.strokeStyle = PANEL_STROKE;
    ctx.lineWidth = 1;
    this.roundedRect(ctx, x, y, w, panelH, 8);
    ctx.stroke();

    // Reset hover targets for this frame; other players' rows become
    // hover-able (skip yourself — no point inspecting your own profile).
    this.playerRows = [];
    view.players.forEach((p, i) => {
      const ry = y + 10 + i * rowH;
      // Register this row as a hover target if it's a real, non-you player.
      if (p.present && !p.you) {
        // Use the raw player name (strip " (you)" if present, though
        // we already filtered above).
        const name = p.label.replace(/\s*\(you\)\s*$/i, "");
        this.playerRows.push({
          rect: { x, y: ry, w, h: rowH },
          name,
        });
      }
      ctx.textBaseline = "middle";
      // Colored slot dot.
      if (p.present && p.color) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(x + 14, ry + rowH / 2 - 2, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Player label, in slot color when present.
      ctx.fillStyle = p.present ? (p.color ?? TEXT) : TEXT_DIM;
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(p.label, x + 26, ry + rowH / 2 - 2);
      // Pick.
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillStyle = p.present ? TEXT_DIM : TEXT_LOCKED;
      const pick = !p.present
        ? "waiting to join…"
        : (p.characterName ?? "picking…");
      ctx.textAlign = "center";
      ctx.fillText(pick, x + w / 2, ry + rowH / 2 - 2);
      // Ready badge.
      ctx.textAlign = "right";
      if (p.present) {
        ctx.fillStyle = p.ready ? "#48d0a0" : TEXT_DIM;
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.fillText(p.ready ? "READY ✓" : "not ready", x + w - 14, ry + rowH / 2 - 2);
      }
    });

    if (view.status) {
      ctx.fillStyle = ACCENT;
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(view.status, x + w / 2, y + panelH + 22);
    }
    ctx.textBaseline = "alphabetic";
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

    // Players (in the networked lobby) who picked this character. Includes
    // YOU if you picked it. Used for the colored border + name tags.
    const picks =
      def !== null && this.lobbyView
        ? this.lobbyView.players.filter(
            (p) => p.present && p.characterId === def!.id,
          )
        : [];
    const youPicked = picks.some((p) => p.you);
    const othersPicks = picks.filter((p) => !p.you);

    ctx.fillStyle = locked ? TILE_BG_LOCKED : TILE_BG;
    this.roundedRect(ctx, tile.x, tile.y, tile.w, tile.h, 8);
    ctx.fill();

    // Border picks the strongest signal: your selection > another player's
    // selection > hover > neutral.
    if (selected || youPicked) {
      // Use your slot color if available (lobby mode), else the canonical
      // yellow "selected" border.
      const me = picks.find((p) => p.you);
      ctx.strokeStyle = me?.color ?? TILE_BORDER_SELECTED;
      ctx.lineWidth = 3;
    } else if (othersPicks.length > 0) {
      // Border in the first other-picker's color (rest shown as tags below).
      ctx.strokeStyle = othersPicks[0].color ?? TILE_BORDER_HOVER;
      ctx.lineWidth = 2;
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

    // Filled tile: mini portrait + name. Anchor the portrait so its
    // FEET (= cy) sit near the bottom of the tile — characters draw
    // upward from cy, so this puts the body in the visible area and
    // leaves room for the name label below.
    const cx = tile.x + tile.w / 2;
    const feetFromBottom = picks.length > 0 ? 26 : 18;
    const cy = tile.y + tile.h - feetFromBottom;
    this.drawPortrait(ctx, def!, cx, cy, picks.length > 0 ? 0.7 : 0.8);

    ctx.fillStyle = TEXT;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(
      def!.name,
      tile.x + tile.w / 2,
      tile.y + tile.h - (picks.length > 0 ? 22 : 8),
    );

    // Player pick tags at the bottom of the tile — colored dot + short
    // name. Stack up to 2; show "+N" if more.
    if (picks.length > 0) {
      const maxRows = 2;
      const visible = picks.slice(0, maxRows);
      const extra = picks.length - visible.length;
      ctx.font = "bold 9px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      let ty = tile.y + tile.h - 12;
      for (const p of visible) {
        // Dot
        ctx.fillStyle = p.color ?? "#888";
        ctx.beginPath();
        ctx.arc(tile.x + 8, ty, 3, 0, Math.PI * 2);
        ctx.fill();
        // Name (truncated)
        const name = this.shortName(p.label);
        ctx.fillStyle = p.color ?? TEXT;
        ctx.fillText(name, tile.x + 15, ty);
        ty += 11;
      }
      if (extra > 0) {
        ctx.fillStyle = TEXT_DIM;
        ctx.fillText(`+${extra}`, tile.x + 15, ty);
      }
    }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  // Compact "<name> (you)" → "<name>" for the tile tag, capped to keep
  // the tile readable. Drops the "(you)" suffix and any role tag.
  private shortName(label: string): string {
    let s = label.replace(/\s*\(you\)\s*$/i, "");
    const max = 9;
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
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

    // Portrait (large). Anchor feet near the bottom of the reserved
    // portrait area so the body draws upward into the available space.
    // 16px gap below the feet leaves room for the shadow.
    const portraitY = cy + DETAIL_PORTRAIT_H - 16;
    this.drawPortrait(ctx, def, x + w / 2, portraitY, 2.0);
    cy = cy + DETAIL_PORTRAIT_H;

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

  // Draw a character body for display only — no facing, no statuses,
  // no HP bar. Dispatches through CHARACTER_ART so characters with
  // bespoke designs (Magnek's magnet head, etc.) appear consistently
  // here and in-world. Characters without a registered art function
  // fall back to the original gumdrop body.
  private drawPortrait(
    ctx: CanvasRenderingContext2D,
    def: CharacterDef,
    cx: number,
    cy: number,
    scale: number,
  ): void {
    const r = Math.round(28 * scale);

    // Shadow (universal).
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Per-character art or gumdrop fallback. Portraits are static
    // and forward-facing, so facing = 0 for the gumdrop path.
    const art = CHARACTER_ART[def.id];
    if (art) {
      // Static portrait — forward-facing (facing = 0 = right). The
      // in-world renderer passes e.facing here for cursor tracking.
      art(ctx, cx, cy, r, 0);
    } else {
      drawGumdropBody(ctx, cx, cy, r, def.color, def.colorDark, 0);
    }
  }

  private drawStartButton(
    ctx: CanvasRenderingContext2D,
    b: ButtonRect,
    enabled: boolean,
    label: string,
  ): void {
    ctx.fillStyle = enabled ? ACCENT : "rgba(255, 216, 74, 0.25)";
    this.roundedRect(ctx, b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.fillStyle = enabled ? "#1a2421" : "rgba(26, 36, 33, 0.5)";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
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
