// Heads-up display: timer, HP bar, ability cooldowns, objective counter,
// points, and pause/outcome banner. All live across the top now —
// gameplay reads cleaner without info competing with the player's
// character at the bottom of the screen.

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
  // Lifetime points display (top-right).
  points: number;
  // Per-survivor target (5) — used to render objective progress.
  objectivesRequired: number;
}

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  _canvas: HTMLCanvasElement,
  world: World,
  opts: HUDOptions,
): void {
  const { dimensions: dims, isTouchMode, points, outcome, paused, objectivesRequired } = opts;
  const cw = dims.w;
  const ch = dims.h;
  const player = world.playerCharacter();

  // ---- Top-left: name + HP ----
  if (player) {
    drawNameAndHp(ctx, player);
  }

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

  // ---- Top-right: points + (desktop) ability bar ----
  // Ability bar lives at the top-right on desktop. On touch the big
  // bottom-right touch buttons cover this, so we skip it and just show
  // points.
  let topRightX = cw - 16;
  if (!isTouchMode && player) {
    topRightX = drawAbilityBar(ctx, player, cw);
  }
  drawPoints(ctx, points, topRightX - 12);

  // ---- Pause / outcome overlay ----
  if (paused || outcome !== "ongoing") {
    drawPauseOrOutcome(ctx, cw, ch, outcome, paused, isTouchMode);
  }
}

function drawNameAndHp(ctx: CanvasRenderingContext2D, p: ReturnType<World["playerCharacter"]> & {}): void {
  const def = CHARACTERS[(p as { characterId: string }).characterId];
  const character = p as {
    team: "hunter" | "survivor";
    hp: number;
    maxHp: number;
  };
  const x = 20;
  const y = 14;
  const w = 220;
  const h = 50;
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

// Draws four ability slots in a horizontal row anchored to the top-right.
// Returns the X coordinate of the bar's LEFT edge so the points display
// can sit just left of it without overlapping.
function drawAbilityBar(
  ctx: CanvasRenderingContext2D,
  p: ReturnType<World["playerCharacter"]> & {},
  cw: number,
): number {
  const player = p as {
    characterId: string;
    cooldowns: Record<string, number>;
    charging?: { abilityId: string; remaining: number; total: number };
  };
  const def = CHARACTERS[player.characterId];
  const slot = 50;
  const gap = 6;
  const padding = 16;
  const rowW = 4 * slot + 3 * gap;
  const x0 = cw - padding - rowW;
  const y = 14;
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
  return x0;
}

function drawPoints(ctx: CanvasRenderingContext2D, points: number, rightEdgeX: number): void {
  const label = points === 1 ? "★ 1" : `★ ${points}`;
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  const w = ctx.measureText(label).width + 24;
  const h = 36;
  const x = rightEdgeX - w;
  const y = 14;
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffd84a";
  ctx.fillText(label, x + w - 12, y + 24);
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
