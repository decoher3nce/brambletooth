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
  // Predicate: returns true if a character id is unlocked for the
  // local player. main.ts sets it from inventory + Bigfoot
  // god-mode. When false, the character is filtered out of the
  // roster entirely — surfaces as an empty "?" tile that
  // collapses into the same shape as not-yet-shipped characters.
  isCharacterAllowed: (id: string) => boolean = () => true;

  // Per-character XP level for the local profile. main.ts sets this
  // from getCharacterLevel(id). Renderer paints a small "Lv N" badge
  // on each card AND shows the level + bonus modifiers in the detail
  // panel. Defaults to 0 (the baseline) when no hook is supplied —
  // legacy code paths get sensible behavior.
  getCharacterLevel: (id: string) => number = () => 0;
  // Per-character cumulative XP — drives the "XP: X / Y" line and
  // progress bar in the detail panel. Companion to
  // getCharacterLevel; main.ts wires both from the local profile.
  getCharacterXp: (id: string) => number = () => 0;
  // XP needed to reach a level — same function as leveling.xpForLevel.
  // Threaded as a hook so SelectScreen doesn't import from
  // ../core/leveling directly.
  xpForLevel: (level: number) => number = () => 0;
  maxLevel = 100;

  // Dual-pick mode (VS Computer hunt rounds). When true, two detail
  // cards render side-by-side — YOU on the left, VS COMPUTER on the
  // right — and the tap handler routes opposing-role tile taps to the
  // AI pick instead of swapping the player's role. A small SWAP button
  // between the two cards toggles which character is yours. Off in
  // network lobby + FFA flows.
  isDualPickMode: () => boolean = () => false;
  // The AI's currently-selected character in dual-pick mode. main.ts
  // reads this via getAiSelected() when starting a VS Computer round.
  // Auto-defaulted to a sensible opposing-role character when the
  // player's pick changes.
  private aiSelectedId: string | null = null;
  // Hit rects for the three between-card buttons (rebuilt each
  // draw, dual-mode only).
  private swapBtn: { x: number; y: number; w: number; h: number } | null = null;
  private randomizeBtn: { x: number; y: number; w: number; h: number } | null = null;
  private surpriseBtn: { x: number; y: number; w: number; h: number } | null = null;
  // Active RANDOMIZE roulette animation. When set, draw() cycles
  // the VS COMPUTER card's displayed character at a tick rate that
  // eases out over `duration` seconds, then snaps to `targetId`.
  private rouletteAnim: { startTime: number; duration: number; targetId: string } | null = null;
  // Previous roulette tick index — tickRoulette plays a tick sound
  // each time the integer index advances (i.e., each time the
  // VISIBLE character cycles to a new one), not every frame. Reset
  // to -1 between spins so the first tick fires reliably.
  private lastRouletteTickIdx: number = -1;
  // SURPRISE mode: the AI's pick is committed but hidden in the UI
  // (the VS COMPUTER card renders a "?" placeholder and the tile
  // grid suppresses the ai-pick red border) until the round starts.
  // Cleared the moment the player manually picks an AI character or
  // taps SWAP — any deliberate action reveals.
  private aiSurprise: boolean = false;

  // Toggle networked-lobby chrome. Pass null to render the local picker.
  setLobbyView(view: LobbyView | null): void {
    this.lobbyView = view;
  }

  // Screen-space center X of the grid column (where the START button
  // is also centered). main.ts uses this to position the AI
  // difficulty pill row so it doesn't bleed under the detail card
  // on wide viewports (iPad, large desktops). Mirrors the same
  // layout math used in draw() — including the dual-pick widening
  // when two detail cards are shown.
  getGridCenterX(cw: number): number {
    const { layoutX } = this.computeLayout(cw);
    return layoutX + ROW_WIDTH / 2;
  }

  // Adaptive layout math, shared by draw() and getGridCenterX.
  // Decides whether two detail cards fit side-by-side at full
  // width, side-by-side at a shrunk-but-readable width, or
  // collapses to a single card (the dualSideBySide flag goes
  // false in that case). Keeping this in one place ensures the
  // pill row above START stays centered on whatever layout draw()
  // actually rendered.
  private computeLayout(cw: number): {
    layoutX: number;
    detailW: number;
    dualSideBySide: boolean;
    dualDetailGap: number;
  } {
    const margin = 20;
    const DUAL_DETAIL_GAP = 20;
    const MIN_DUAL_CARD_W = 200;
    const dual = this.isDualPickMode() && !this.lobbyView;
    if (!dual) {
      const layoutW = ROW_WIDTH + DETAIL_GAP + DETAIL_W;
      return {
        layoutX: Math.max(margin, (cw - layoutW) / 2),
        detailW: DETAIL_W,
        dualSideBySide: false,
        dualDetailGap: DUAL_DETAIL_GAP,
      };
    }
    // Available width for two cards after grid + gaps + margins.
    const availableForCards =
      cw - margin * 2 - ROW_WIDTH - DETAIL_GAP - DUAL_DETAIL_GAP;
    const cardW = Math.min(DETAIL_W, availableForCards / 2);
    if (cardW < MIN_DUAL_CARD_W) {
      // Viewport too narrow to show both cards side-by-side at a
      // readable width — collapse to single. Player still gets the
      // YOU detail; the AI mini-card is dropped on this layout.
      // (A future iteration could stack the two cards vertically.)
      const layoutW = ROW_WIDTH + DETAIL_GAP + DETAIL_W;
      return {
        layoutX: Math.max(margin, (cw - layoutW) / 2),
        detailW: DETAIL_W,
        dualSideBySide: false,
        dualDetailGap: DUAL_DETAIL_GAP,
      };
    }
    const layoutW = ROW_WIDTH + DETAIL_GAP + cardW * 2 + DUAL_DETAIL_GAP;
    return {
      layoutX: Math.max(margin, (cw - layoutW) / 2),
      detailW: cardW,
      dualSideBySide: true,
      dualDetailGap: DUAL_DETAIL_GAP,
    };
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

    // RANDOMIZE / SWAP / SURPRISE hits in dual-pick mode — each
    // rebuilds the AI pick or its presentation. Order matches the
    // vertical stack so a vertically-near tap routes deterministically.
    if (this.isDualPickMode()) {
      if (this.randomizeBtn) {
        const b = this.randomizeBtn;
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
          playSound("ui_pick");
          this.startRoulette();
          this.hoverId = null;
          return;
        }
      }
      if (this.swapBtn) {
        const b = this.swapBtn;
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
          playSound("ui_pick");
          this.swapPicks();
          this.hoverId = null;
          if (this.selectedId) hooks.onSelect?.(this.selectedId);
          return;
        }
      }
      if (this.surpriseBtn) {
        const b = this.surpriseBtn;
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
          playSound("ui_pick");
          this.setSurprise();
          this.hoverId = null;
          return;
        }
      }
    }
    for (const tile of this.tiles) {
      if (
        tile.characterId &&
        p.x >= tile.x && p.x <= tile.x + tile.w &&
        p.y >= tile.y && p.y <= tile.y + tile.h
      ) {
        // Dual-pick routing: in VS Computer, opposing-role tile taps
        // set the AI's pick instead of swapping the player's role.
        // SWAP button handles role flips.
        if (this.isDualPickMode() && this.selectedId) {
          const playerDef = CHARACTERS[this.selectedId];
          if (playerDef && tile.role !== playerDef.role) {
            // Opposing role — set as AI's character. A deliberate
            // manual pick cancels SURPRISE + roulette so the player
            // sees what they just chose.
            this.rouletteAnim = null;
            this.aiSurprise = false;
            if (tile.characterId === this.aiSelectedId) return;
            this.aiSelectedId = tile.characterId;
            this.hoverId = null;
            playSound("ui_pick");
            return;
          }
        }
        const changed = tile.characterId !== this.selectedId;
        this.selectedId = tile.characterId;
        // On touch, we also want the detail panel to show the just-tapped
        // character — clear hover so the displayed character == selected.
        this.hoverId = null;
        playSound("ui_pick");
        // Keep the AI's pick consistent with the player's new role.
        this.ensureAiPick();
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
    return Object.values(CHARACTERS)
      .filter((c) => c.role === role)
      .filter((c) => this.isCharacterAllowed(c.id));
  }

  // The character shown in the detail panel = hover if any, else selected.
  // Lets desktop users preview before committing without losing the
  // current selection.
  private displayedId(): string | null {
    return this.hoverId ?? this.selectedId;
  }

  // The AI's currently-selected character id in dual-pick mode.
  // main.ts reads this when starting a VS Computer round.
  getAiSelected(): string | null {
    return this.aiSelectedId;
  }

  // Default the AI's pick to the first allowed character of the
  // opposing role from the player's pick. Called whenever the
  // player's selection changes role or aiSelectedId would otherwise
  // collide. No-op outside dual-pick mode.
  private ensureAiPick(): void {
    if (!this.isDualPickMode()) return;
    if (!this.selectedId) {
      this.aiSelectedId = null;
      return;
    }
    const playerDef = CHARACTERS[this.selectedId];
    if (!playerDef) return;
    const opposing: CharacterRole = playerDef.role === "hunter" ? "survivor" : "hunter";
    const pool = this.charactersByRole(opposing);
    if (pool.length === 0) {
      this.aiSelectedId = null;
      return;
    }
    // Keep the existing AI pick if it's still a valid opposing-role
    // character (preserves the player's explicit choice across
    // re-renders); otherwise default to the first allowed AND
    // cancel any active SURPRISE / roulette state (the player
    // changed roles so the old hidden pick is stale).
    const current = this.aiSelectedId ? CHARACTERS[this.aiSelectedId] : null;
    if (!current || current.role !== opposing || !this.isCharacterAllowed(this.aiSelectedId!)) {
      this.aiSelectedId = pool[0]!.id;
      this.aiSurprise = false;
      this.rouletteAnim = null;
    }
  }

  // Swap the player's pick with the AI's pick. Used by the SWAP
  // button between the two detail cards — clicking it switches which
  // role the player plays (e.g. "I want to play this survivor as a
  // hunter and let the AI take the survivor instead").
  private swapPicks(): void {
    if (!this.aiSelectedId || !this.selectedId) return;
    const tmp = this.selectedId;
    this.selectedId = this.aiSelectedId;
    this.aiSelectedId = tmp;
    // Any deliberate user action cancels surprise + roulette so
    // the player isn't blindsided by stale obfuscation.
    this.aiSurprise = false;
    this.rouletteAnim = null;
  }

  // All allowed characters from the OPPOSING role relative to the
  // player's current pick. Used by RANDOMIZE + SURPRISE to source
  // an AI candidate pool. Falls back to ALL allowed characters if
  // the player hasn't picked yet (defensive).
  private opposingCharacters(): CharacterDef[] {
    if (!this.selectedId) {
      return Object.values(CHARACTERS).filter((c) => this.isCharacterAllowed(c.id));
    }
    const playerDef = CHARACTERS[this.selectedId];
    if (!playerDef) return [];
    const opposing: CharacterRole = playerDef.role === "hunter" ? "survivor" : "hunter";
    return this.charactersByRole(opposing);
  }

  // Kick off the roulette animation. Pre-picks the landing character
  // so the easing logic only has to drive the visible cycle. Clears
  // surprise mode (visible cycle would defeat the secrecy anyway).
  private startRoulette(): void {
    const pool = this.opposingCharacters();
    if (pool.length === 0) return;
    const target = pool[Math.floor(Math.random() * pool.length)]!;
    this.rouletteAnim = {
      startTime: performance.now(),
      duration: 1800,
      targetId: target.id,
    };
    this.lastRouletteTickIdx = -1;
    this.aiSurprise = false;
  }

  // Commit a random AI pick AND hide it from the UI. Clears any
  // active roulette so the two states don't conflict. Fires an
  // ominous swell so the player feels the danger of an unknown
  // matchup.
  private setSurprise(): void {
    const pool = this.opposingCharacters();
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.aiSelectedId = pick.id;
    this.aiSurprise = true;
    this.rouletteAnim = null;
    playSound("surprise_reveal");
  }

  // Public — main.ts checks this when starting the round so it can
  // clear surprise state for the next round's select-screen visit.
  clearAiSurprise(): void {
    this.aiSurprise = false;
  }

  // Advance the roulette animation each frame. Cycles the AI's
  // visible pick at a rate that eases out (fast at first, slowing
  // toward the end), then snaps to the pre-picked targetId when
  // elapsed >= duration. No-op when no animation is active.
  // Plays a tick sound each time the integer index advances —
  // matches the visible cycle — and a landing chime when the
  // wheel settles.
  private tickRoulette(): void {
    if (!this.rouletteAnim) return;
    const elapsed = performance.now() - this.rouletteAnim.startTime;
    if (elapsed >= this.rouletteAnim.duration) {
      this.aiSelectedId = this.rouletteAnim.targetId;
      this.rouletteAnim = null;
      this.lastRouletteTickIdx = -1;
      playSound("roulette_settle");
      return;
    }
    const pool = this.opposingCharacters();
    if (pool.length === 0) return;
    const t = elapsed / this.rouletteAnim.duration;
    // easeOutQuart for the cumulative-tick curve — fast cycle at
    // first, slowing to a halt.
    const eased = 1 - Math.pow(1 - t, 4);
    const TOTAL_TICKS = 24;
    const tickIdx = Math.floor(eased * TOTAL_TICKS);
    this.aiSelectedId = pool[tickIdx % pool.length]!.id;
    if (tickIdx !== this.lastRouletteTickIdx) {
      this.lastRouletteTickIdx = tickIdx;
      playSound("roulette_tick");
    }
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

    // Dual-pick layout? In VS Computer hunt rounds (not network,
    // not FFA) we show TWO detail cards side-by-side — "YOU" and
    // "VS COMPUTER". computeLayout returns a per-frame
    // (layoutX, detailW, dualSideBySide) tuple — on narrow
    // viewports detailW shrinks below 380 so both cards still
    // fit; if even at the minimum readable width they don't fit,
    // dualSideBySide falls false and we draw the legacy single
    // card only.
    if (this.isDualPickMode()) this.ensureAiPick();
    const layout = this.computeLayout(cw);
    const { layoutX, detailW, dualDetailGap } = layout;
    const dual = layout.dualSideBySide;
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

    // Detail card(s).
    if (dual) {
      // Roulette animation ticks BEFORE we render the cards so
      // the displayed AI character matches the cycle frame.
      this.tickRoulette();
      const playerColor = "#ffd84a"; // yellow accent — matches the
      const aiColor = "#d05050";     // detail-card pill + tile border
      this.drawDetailCard(
        ctx, detailX, gridTop, detailW, DETAIL_H,
        this.selectedId, "YOU", playerColor,
      );
      const aiX = detailX + detailW + dualDetailGap;
      this.drawDetailCard(
        ctx, aiX, gridTop, detailW, DETAIL_H,
        this.aiSelectedId, "VS COMPUTER", aiColor,
        this.aiSurprise,
      );
      // Three stacked action buttons vertically centered between
      // the cards: RANDOMIZE (top) — ↻ roulette, SWAP (middle) —
      // ⇄ swap, SURPRISE (bottom) — ? hidden pick.
      const btnW = 32;
      const btnH = 32;
      const btnGap = 8;
      const stackH = btnH * 3 + btnGap * 2;
      const stackCenterY = gridTop + DETAIL_H / 2;
      const btnX = aiX - dualDetailGap / 2 - btnW / 2;
      const randY = stackCenterY - stackH / 2;
      const swapY = randY + btnH + btnGap;
      const surpY = swapY + btnH + btnGap;
      this.randomizeBtn = { x: btnX, y: randY, w: btnW, h: btnH };
      this.swapBtn = { x: btnX, y: swapY, w: btnW, h: btnH };
      this.surpriseBtn = { x: btnX, y: surpY, w: btnW, h: btnH };
      const drawCircleBtn = (
        x: number, y: number, w: number, h: number,
        glyph: string, glyphSize: number,
        highlight: boolean,
      ) => {
        ctx.fillStyle = highlight
          ? "rgba(80, 60, 18, 0.95)"
          : "rgba(30, 36, 34, 0.95)";
        this.roundedRect(ctx, x, y, w, h, w / 2);
        ctx.fill();
        ctx.strokeStyle = highlight
          ? "#ffd84a"
          : "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = highlight ? 2 : 1.5;
        this.roundedRect(ctx, x, y, w, h, w / 2);
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${glyphSize}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(glyph, x + w / 2, y + h / 2 + 1);
        ctx.textBaseline = "alphabetic";
      };
      drawCircleBtn(btnX, randY, btnW, btnH, "↻", 18, this.rouletteAnim !== null);
      drawCircleBtn(btnX, swapY, btnW, btnH, "⇄", 16, false);
      drawCircleBtn(btnX, surpY, btnW, btnH, "?", 18, this.aiSurprise);
    } else {
      this.swapBtn = null;
      this.randomizeBtn = null;
      this.surpriseBtn = null;
      this.drawDetailCard(ctx, detailX, gridTop, DETAIL_W, DETAIL_H);
    }

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
    // SURPRISE hides the AI's pick — including the red tile border
    // that would otherwise leak which character the computer
    // committed to.
    const aiSelected = def !== null && def.id === this.aiSelectedId
      && this.isDualPickMode() && !this.aiSurprise;
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
    } else if (aiSelected) {
      // Dual-pick: the AI's chosen character gets a red border so the
      // player can see at a glance which character the computer will
      // play. Doesn't override your own selection — that wins above.
      ctx.strokeStyle = "#d05050";
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

    // Lv N badge — top-right corner pill. Reads at a glance which
    // characters the player has grinded vs which are baseline.
    if (def) {
      const lv = this.getCharacterLevel(def.id);
      const badgeText = `Lv ${lv}`;
      ctx.font = "bold 10px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      const tw = Math.ceil(ctx.measureText(badgeText).width);
      const badgeW = tw + 10;
      const badgeH = 14;
      const bx = tile.x + tile.w - badgeW - 4;
      const by = tile.y + 4;
      ctx.fillStyle = "rgba(20, 20, 20, 0.78)";
      this.roundedRect(ctx, bx, by, badgeW, badgeH, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 216, 74, 0.55)";
      ctx.lineWidth = 1;
      this.roundedRect(ctx, bx, by, badgeW, badgeH, 4);
      ctx.stroke();
      ctx.fillStyle = "#ffd84a";
      ctx.textAlign = "center";
      ctx.fillText(badgeText, bx + badgeW / 2, by + badgeH - 3);
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
    // Override the displayed character (dual-pick mode passes the
    // player's pick on the left and the AI's pick on the right).
    // null = use the legacy displayedId() (hover ?? selected).
    overrideId: string | null = null,
    // Optional top-of-card label ("YOU" / "VS COMPUTER" in dual
    // mode). Renders in a small yellow pill anchored to the top
    // edge; falsy = no label.
    label: string | null = null,
    // Tint applied to the card border (player vs AI distinction).
    borderColor: string | null = null,
    // SURPRISE mode — render the AI's pick as a "?" placeholder
    // instead of revealing the actual character. Used by the
    // dual-pick VS COMPUTER card when aiSurprise is set.
    hidden: boolean = false,
  ): void {
    ctx.fillStyle = PANEL_BG;
    this.roundedRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.strokeStyle = borderColor ?? PANEL_STROKE;
    ctx.lineWidth = borderColor ? 2 : 1;
    this.roundedRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    // Top label pill — drawn first so the card content can flow
    // below it.
    if (label) {
      ctx.font = "bold 10px system-ui, sans-serif";
      const tw = Math.ceil(ctx.measureText(label).width);
      const padX = 10;
      const labelW = tw + padX * 2;
      const labelH = 18;
      const labelX = x + 14;
      const labelY = y - labelH / 2 + 2;
      ctx.fillStyle = "rgba(20, 20, 20, 0.92)";
      this.roundedRect(ctx, labelX, labelY, labelW, labelH, 4);
      ctx.fill();
      ctx.strokeStyle = borderColor ?? PANEL_STROKE;
      ctx.lineWidth = 1.5;
      this.roundedRect(ctx, labelX, labelY, labelW, labelH, 4);
      ctx.stroke();
      ctx.fillStyle = borderColor ?? ACCENT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, labelX + padX, labelY + labelH / 2 + 0.5);
      ctx.textBaseline = "alphabetic";
    }

    // SURPRISE: render a hidden "???" placeholder regardless of
    // what character is committed under the hood. The player only
    // learns the matchup when the round starts.
    if (hidden) {
      const cx = x + w / 2;
      const cy = y + h * 0.45;
      // Big spotlight-style "?" mark.
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(w, h) * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#d05050";
      ctx.font = "bold 140px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", cx, cy);
      ctx.fillStyle = TEXT;
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.fillText("SURPRISE", cx, y + h * 0.72);
      ctx.fillStyle = TEXT_DIM;
      ctx.font = "italic 12px system-ui, sans-serif";
      ctx.fillText("The computer's pick is hidden", cx, y + h * 0.78);
      ctx.fillText("until the round starts.", cx, y + h * 0.78 + 16);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      return;
    }
    const id = overrideId ?? this.displayedId();
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
    // Level row first — calls out the player's current level for
    // this character with a yellow accent so it doesn't get lost
    // in the stat list.
    const level = this.getCharacterLevel(def.id);
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = "left";
    ctx.fillText("Level", x + pad, cy);
    ctx.fillStyle = ACCENT;
    ctx.textAlign = "right";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillText(`Lv ${level}`, x + w - pad, cy);
    ctx.font = "12px system-ui, sans-serif";
    cy += 16;
    // XP row — shows progress within the CURRENT level as
    // "XP: nIn / nNeeded" on the left/right pair, plus a thin
    // horizontal progress bar underneath. At MAX_LEVEL the row
    // collapses to "XP: MAX" and the bar fills solid yellow.
    {
      const xp = this.getCharacterXp(def.id);
      const isMax = level >= this.maxLevel;
      const xpForCurrent = this.xpForLevel(level);
      const xpForNext = this.xpForLevel(level + 1);
      const xpInLevel = Math.max(0, xp - xpForCurrent);
      const xpNeededForLevel = Math.max(1, xpForNext - xpForCurrent);
      const progress = isMax ? 1 : Math.max(0, Math.min(1, xpInLevel / xpNeededForLevel));
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = "left";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("XP", x + pad, cy);
      ctx.fillStyle = TEXT;
      ctx.textAlign = "right";
      const xpLabel = isMax
        ? "MAX"
        : `${xpInLevel} / ${xpNeededForLevel}`;
      ctx.fillText(xpLabel, x + w - pad, cy);
      cy += 6;
      // Progress bar — full-width track with a filled portion.
      const barX = x + pad;
      const barY = cy;
      const barW = w - pad * 2;
      const barH = 5;
      ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
      this.roundedRect(ctx, barX, barY, barW, barH, barH / 2);
      ctx.fill();
      ctx.fillStyle = isMax ? "#ffd84a" : ACCENT;
      this.roundedRect(ctx, barX, barY, Math.max(barH, barW * progress), barH, barH / 2);
      ctx.fill();
      cy += barH + 12;
    }
    for (const stat of def.displayStats()) {
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = "left";
      ctx.fillText(stat.label, x + pad, cy);
      ctx.fillStyle = TEXT;
      ctx.textAlign = "right";
      ctx.fillText(stat.value, x + w - pad, cy);
      cy += 16;
    }
    // Level bonus modifier line — surfaces what the next round
    // will get for this character at the current level. Constants
    // mirror LEVEL_*_PER_LEVEL in src/core/leveling.ts; keeping
    // them inline avoids dragging a leveling.ts import into the UI
    // module just for two numbers.
    {
      const HP_PER_LEVEL = 0.010;
      const SPEED_PER_LEVEL = 0.003;
      const DAMAGE_PER_LEVEL = 0.010;
      const hpPct = Math.round(level * 100 * HP_PER_LEVEL);
      const spdPct = Math.round(level * 100 * SPEED_PER_LEVEL * 10) / 10;
      const dmgPct = Math.round(level * 100 * DAMAGE_PER_LEVEL);
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = "left";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText("Level bonus", x + pad, cy);
      ctx.textAlign = "right";
      ctx.fillText(`+${hpPct}% HP · +${spdPct}% spd · +${dmgPct}% dmg`, x + w - pad, cy);
      cy += 16;
    }
    cy += 8;

    // Abilities — name + wrapped description + cooldown/charge tag.
    // Replaces the bare name-and-cd line so a new player can read what
    // each ability actually does before committing to a character.
    ctx.fillStyle = ACCENT;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("ABILITIES", x + pad, cy);
    cy += 14;
    const descIndent = pad + 12; // indent description under the bullet
    const descRight = w - pad;
    const descWidth = descRight - descIndent;
    for (const slot of def.abilities) {
      if (!slot) continue;
      const ab = ABILITIES[slot];
      if (!ab) continue;
      // Header row: bullet + name + cd/charge tag on the right.
      ctx.fillStyle = TEXT;
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`• ${ab.name}`, x + pad, cy);
      ctx.fillStyle = TEXT_DIM;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "right";
      const tag = ab.chargeTime
        ? `${ab.chargeTime}s charge · ${ab.cooldown}s cd`
        : `${ab.cooldown}s cd`;
      ctx.fillText(tag, x + descRight, cy);
      cy += 13;
      // Description (wrapped, dimmer, indented under the bullet).
      ctx.fillStyle = TEXT_DIM;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      const descLines = wrapText(ctx, ab.description, descWidth);
      for (const line of descLines) {
        ctx.fillText(line, x + descIndent, cy);
        cy += 12;
      }
      cy += 5; // gap before next ability
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
      // Static portrait — forward-facing (facing = 0), idle pose
      // (walkSpeed = 0). The in-world renderer passes e.facing + a
      // computed anim state for cursor tracking and walk cycles.
      art(ctx, cx, cy, r, 0, { walkSpeed: 0, phase: 0 });
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
