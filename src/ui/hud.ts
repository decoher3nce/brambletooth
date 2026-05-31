// Heads-up display: timer, HP, ability cooldowns, objective counter,
// score, optional all-survivors mini-list, and the pause/outcome overlay.
//
// Layout (all "top" so it doesn't compete with the player at the bottom
// of the screen):
//   Top-left, stacked:  [player card]  [ability bar (desktop)]  [points]
//   Top-center:         [timer]  [objective progress]
//   Top-right:          [mini-survivor HP list]  (multiplayer only)
//
// The achievement banner is drawn separately in main.ts and lives in
// the top-right column below this mini-list when present.

import type { World } from "../core/world";
import { CHARACTERS } from "../characters/characters";
import { ABILITIES } from "../abilities/abilities";
import type { RoundOutcome } from "../modes/mode";

const ABILITY_KEYS = ["Q", "E", "R", "F"];

export interface HUDOptions {
  outcome: RoundOutcome;
  paused: boolean;
  dimensions: { w: number; h: number };
  isTouchMode: boolean;
  // Lifetime points display (top-left, under the ability bar).
  points: number;
  // Per-survivor target (5) — used to render objective progress.
  objectivesRequired: number;
  // When true, render the all-survivors mini HP list in the top-right.
  // Caller passes true in multiplayer modes; single-player keeps it off
  // since the top-left card already shows the only survivor.
  showSurvivorList: boolean;
  // Danger Mode (mode-defined). True when the hunter's escalation
  // buffs are active. Renders a pulsing DANGER badge under the
  // timer so survivors and hunter both feel the shift.
  dangerMode: boolean;
}

// Layout constants shared so callers can mirror our top-left stack
// height (for positioning anything below it). Heights include the
// 6px gap that follows each row.
const PLAYER_CARD_H = 50;
const ABILITY_BAR_H = 50;
const POINTS_H = 32;
const ROW_GAP = 6;
const STACK_X = 20;
const STACK_TOP = 14;

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  _canvas: HTMLCanvasElement,
  world: World,
  opts: HUDOptions,
): void {
  const { dimensions: dims, isTouchMode, points, outcome, paused, objectivesRequired, showSurvivorList, dangerMode } = opts;
  const cw = dims.w;
  const ch = dims.h;
  const player = world.playerCharacter();

  // ---- Top-left vertical stack: player card → ability bar → points ----
  let stackY = STACK_TOP;
  if (player) {
    drawNameAndHp(ctx, player, STACK_X, stackY);
    stackY += PLAYER_CARD_H + ROW_GAP;
  }
  // Ability bar is desktop-only — touch mode shows cooldowns on the
  // bottom-right touch buttons, no need to draw it twice.
  if (!isTouchMode && player) {
    drawAbilityBar(ctx, player, STACK_X, stackY);
    stackY += ABILITY_BAR_H + ROW_GAP;
  }
  drawPoints(ctx, points, STACK_X, stackY);

  // ---- Top-center: timer + objective progress ----
  const remaining = Math.max(0, world.timeLimit - world.elapsed);
  const mm = Math.floor(remaining / 60);
  const ss = Math.floor(remaining % 60);
  const timerText = `${mm}:${ss.toString().padStart(2, "0")}`;
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(cw / 2 - 100, 10, 200, 40);
  ctx.fillStyle = "#fff";
  ctx.fillText(timerText, cw / 2, 40);

  // Objective progress: survivor sees their own count, hunter sees the
  // leading survivor's (since first-to-target wins).
  const survivors = world.charactersOnTeam("survivor");
  const leadingCount = survivors.reduce(
    (m, s) => (s.objectivesCollected > m ? s.objectivesCollected : m),
    0,
  );
  let objLine: string;
  if (player?.team === "survivor") {
    objLine = `★ ${player.objectivesCollected} / ${objectivesRequired}`;
  } else {
    objLine = `Lead ${leadingCount} / ${objectivesRequired}`;
  }
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(cw / 2 - 80, 56, 160, 22);
  ctx.fillStyle = "#ffd84a";
  ctx.fillText(objLine, cw / 2, 72);

  // Danger Mode badge (pulsing red) — sits just below the objective
  // line when active. Plays on every frame; main.ts can additionally
  // fire a one-shot banner on transition for ceremony.
  if (dangerMode) {
    const t = (performance.now() / 350) % (Math.PI * 2);
    const pulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t));
    const bw = 110;
    const bh = 22;
    const bx = cw / 2 - bw / 2;
    const by = 82;
    ctx.fillStyle = `rgba(208, 72, 72, ${0.85 * pulse})`;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = `rgba(255, 200, 200, ${pulse})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("⚠ DANGER MODE", cw / 2, by + bh / 2 + 1);
    ctx.textBaseline = "alphabetic";
  }

  // ---- Top-right: mini all-survivors HP list (multiplayer) ----
  if (showSurvivorList && survivors.length > 0) {
    drawSurvivorList(ctx, survivors, player?.id ?? null, cw);
  }

  // ---- Pause / outcome overlay ----
  if (paused || outcome !== "ongoing") {
    drawPauseOrOutcome(ctx, cw, ch, outcome, paused, isTouchMode);
  }
}

// Height of the top-right mini-survivors list given a survivor count.
// Exported so main.ts can position the achievement banner below it.
export function survivorListHeight(survivorCount: number): number {
  if (survivorCount <= 0) return 0;
  const padding = 6;
  const rowH = 18;
  return padding * 2 + survivorCount * rowH;
}
export const SURVIVOR_LIST_TOP = STACK_TOP;

function drawNameAndHp(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<World["playerCharacter"]> & {},
  x: number,
  y: number,
): void {
  const def = CHARACTERS[(p as { characterId: string }).characterId];
  const character = p as {
    team: "hunter" | "survivor";
    hp: number;
    maxHp: number;
  };
  const w = 220;
  const h = PLAYER_CARD_H;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${def.name} · ${character.team.toUpperCase()}`, x + 8, y + 18);
  // HP bar below the name.
  const barX = x + 8;
  const barY = y + 26;
  const barW = w - 16;
  const barH = 14;
  ctx.fillStyle = "#333";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = character.team === "hunter" ? "#d04848" : "#48d0a0";
  ctx.fillRect(barX, barY, barW * (character.hp / character.maxHp), barH);
  ctx.fillStyle = "#fff";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(
    `${Math.ceil(character.hp)} / ${character.maxHp}`,
    barX + barW / 2,
    barY + 11,
  );
}

// Four ability slots in a horizontal row, left-anchored at (x, y).
// Used to live in the top-right; moved to the top-left stack so the
// player's cooldowns sit next to their HP and score.
function drawAbilityBar(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<World["playerCharacter"]> & {},
  x0: number,
  y: number,
): void {
  const player = p as {
    characterId: string;
    cooldowns: Record<string, number>;
    charging?: { abilityId: string; remaining: number; total: number };
  };
  const def = CHARACTERS[player.characterId];
  const slot = 50;
  const gap = 6;
  for (let i = 0; i < 4; i++) {
    const x = x0 + i * (slot + gap);
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(x, y, slot, slot);
    const abilityId = def.abilities[i];
    if (!abilityId) {
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, slot, slot);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("LOCKED", x + slot / 2, y + slot / 2 + 2);
      continue;
    }
    const ability = ABILITIES[abilityId];
    const cd = player.cooldowns[abilityId] ?? 0;
    const ready = cd <= 0;
    ctx.strokeStyle = ready ? "#ffd84a" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = ready ? 2 : 1;
    ctx.strokeRect(x, y, slot, slot);
    ctx.fillStyle = ready ? "#fff" : "rgba(255,255,255,0.55)";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    const lines = ability.name.split(" ");
    let ty = y + 16;
    for (const line of lines) {
      ctx.fillText(line, x + slot / 2, ty);
      ty += 11;
    }
    if (!ready) {
      const pct = Math.min(1, cd / ability.cooldown);
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(x, y, slot, slot * pct);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillText(cd.toFixed(1), x + slot / 2, y + slot / 2 + 5);
    }
    ctx.fillStyle = ready ? "#ffd84a" : "rgba(255,216,74,0.45)";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(ABILITY_KEYS[i], x + slot - 4, y + slot - 4);
  }
}

// Score pill, left-anchored at (x, y). Used to live top-right; moved to
// the top-left stack at the player's request.
function drawPoints(ctx: CanvasRenderingContext2D, points: number, x: number, y: number): void {
  const label = points === 1 ? "★ 1" : `★ ${points}`;
  const h = POINTS_H;
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  const measured = ctx.measureText(label).width;
  const w = Math.max(80, measured + 24);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffd84a";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 12, y + 22);
}

// Compact list of every survivor's HP, top-right anchored. Shown in
// multiplayer so hunters can see who's wounded and survivors can see
// their teammates' status. Local player's row is bolded.
function drawSurvivorList(
  ctx: CanvasRenderingContext2D,
  survivors: ReturnType<World["charactersOnTeam"]>,
  currentPlayerId: number | null,
  cw: number,
): void {
  const w = 200;
  const padding = 6;
  const rowH = 18;
  const h = survivorListHeight(survivors.length);
  const x = cw - 16 - w;
  const y = SURVIVOR_LIST_TOP;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(x, y, w, h);

  let ry = y + padding;
  for (const s of survivors) {
    const character = s as { id: number; hp: number; maxHp: number; characterId: string };
    const isMe = currentPlayerId != null && character.id === currentPlayerId;
    const def = CHARACTERS[character.characterId];
    const name = def?.name ?? "Survivor";
    // Name (left, truncated to fit ~64px).
    ctx.fillStyle = isMe ? "#fff" : "rgba(255,255,255,0.85)";
    ctx.font = isMe ? "bold 11px system-ui, sans-serif" : "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(name.slice(0, 10), x + 8, ry + rowH / 2);
    // Thin HP bar (middle).
    const barX = x + 78;
    const barW = 80;
    const barH = 8;
    const barY = ry + (rowH - barH) / 2;
    ctx.fillStyle = "#333";
    ctx.fillRect(barX, barY, barW, barH);
    const ratio = Math.max(0, Math.min(1, character.hp / character.maxHp));
    ctx.fillStyle = "#48d0a0";
    ctx.fillRect(barX, barY, barW * ratio, barH);
    // HP number (right-aligned).
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(Math.ceil(character.hp).toString(), x + w - 8, ry + rowH / 2);
    ry += rowH;
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
}

function drawPauseOrOutcome(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  outcome: RoundOutcome,
  paused: boolean,
  isTouchMode: boolean,
): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(0, 0, cw, ch);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let title = "PAUSED";
  let subtitle = isTouchMode ? "Tap the pause button to resume" : "Press Esc to resume";
  let titleColor = "#fff";
  const restartHint = isTouchMode ? "Tap to restart." : "Press R to restart.";
  if (outcome === "hunter_win") {
    title = "HUNTER WINS";
    subtitle = restartHint;
    titleColor = "#d04848";
  } else if (outcome === "survivor_win") {
    title = "SURVIVORS WIN";
    subtitle = restartHint;
    titleColor = "#48d0a0";
  } else if (outcome === "draw") {
    title = "DRAW";
    titleColor = "#fff";
  }
  ctx.fillStyle = titleColor;
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.fillText(title, cw / 2, ch / 2 - 10);
  ctx.fillStyle = "#fff";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(subtitle, cw / 2, ch / 2 + 30);
}
