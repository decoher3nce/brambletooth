// Heads-up display: timer, HP bar, ability cooldowns, objective counter,
// outcome banner.

import type { World } from "../core/world";
import type { CharacterEntity } from "../core/entity";
import { isObjective } from "../core/entity";
import { CHARACTERS } from "../characters/characters";
import { ABILITIES } from "../abilities/abilities";
import type { RoundOutcome } from "../modes/mode";

const ABILITY_KEYS = ["Q", "E", "R", "F"];

export function drawHUD(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  world: World,
  outcome: RoundOutcome,
  paused: boolean,
  dimensions?: { w: number; h: number },
): void {
  const cw = dimensions ? dimensions.w : canvas.width;
  const ch = dimensions ? dimensions.h : canvas.height;
  const player = world.playerCharacter();

  // Top center: timer + objectives
  const remaining = Math.max(0, world.timeLimit - world.elapsed);
  const mm = Math.floor(remaining / 60);
  const ss = Math.floor(remaining % 60);
  const timerText = `${mm}:${ss.toString().padStart(2, "0")}`;

  const objs = world.entities.filter(isObjective);
  const collected = objs.filter((o) => o.collected).length;

  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(cw / 2 - 100, 10, 200, 40);
  ctx.fillStyle = "#fff";
  ctx.fillText(timerText, cw / 2, 40);

  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(cw / 2 - 80, 56, 160, 22);
  ctx.fillStyle = "#ffd84a";
  ctx.fillText(`★ Objectives  ${collected} / ${objs.length}`, cw / 2, 72);

  // Bottom: player HP + ability bar
  if (player) {
    const def = CHARACTERS[player.characterId];

    // Name + HP
    const hpW = 240;
    const hpH = 16;
    const hpX = 20;
    const hpY = ch - 110;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(hpX - 6, hpY - 22, hpW + 12, hpH + 28);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${def.name} — ${player.team.toUpperCase()}`, hpX, hpY - 6);
    ctx.fillStyle = "#333";
    ctx.fillRect(hpX, hpY, hpW, hpH);
    ctx.fillStyle = player.team === "hunter" ? "#d04848" : "#48d0a0";
    ctx.fillRect(hpX, hpY, hpW * (player.hp / player.maxHp), hpH);
    ctx.fillStyle = "#fff";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.ceil(player.hp)} / ${player.maxHp}`, hpX + hpW / 2, hpY + 12);

    // Ability slots
    const slotSize = 56;
    const gap = 8;
    const startX = hpX;
    const startY = ch - 70;
    for (let i = 0; i < 4; i++) {
      const x = startX + i * (slotSize + gap);
      const y = startY;
      const abilityId = def.abilities[i];
      // Slot background
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(x, y, slotSize, slotSize);
      if (!abilityId) {
        // Locked slot
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, slotSize, slotSize);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("LOCKED", x + slotSize / 2, y + slotSize / 2);
        continue;
      }
      const ability = ABILITIES[abilityId];
      const cd = player.cooldowns[abilityId] ?? 0;
      const ready = cd <= 0;

      // Slot color
      ctx.strokeStyle = ready ? "#ffd84a" : "rgba(255,255,255,0.2)";
      ctx.lineWidth = ready ? 2 : 1;
      ctx.strokeRect(x, y, slotSize, slotSize);

      // Name
      ctx.fillStyle = ready ? "#fff" : "rgba(255,255,255,0.5)";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      const nameLines = ability.name.split(" ");
      let ty = y + 18;
      for (const line of nameLines) {
        ctx.fillText(line, x + slotSize / 2, ty);
        ty += 12;
      }

      // Cooldown overlay
      if (!ready) {
        const pct = cd / ability.cooldown;
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(x, y, slotSize, slotSize * pct);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 16px system-ui, sans-serif";
        ctx.fillText(cd.toFixed(1), x + slotSize / 2, y + slotSize / 2 + 6);
      }

      // Key binding label
      ctx.fillStyle = ready ? "#ffd84a" : "rgba(255,216,74,0.4)";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(ABILITY_KEYS[i], x + slotSize - 4, y + slotSize - 4);
    }
  }

  // Controls hint (small, top right)
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(cw - 200, 10, 190, 80);
  ctx.fillStyle = "#fff";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("WASD — move", cw - 192, 28);
  ctx.fillText("Mouse — aim", cw - 192, 44);
  ctx.fillText("Q E R F — abilities", cw - 192, 60);
  ctx.fillText("Esc — pause", cw - 192, 76);

  // Pause / outcome overlay
  if (paused || outcome !== "ongoing") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "bold 56px system-ui, sans-serif";
    let title = "PAUSED";
    let subtitle = "Press Esc to resume";
    if (outcome === "hunter_win") {
      title = "HUNTER WINS";
      subtitle = "Slagy got you. Press R to restart.";
      ctx.fillStyle = "#d04848";
    } else if (outcome === "survivor_win") {
      title = "SURVIVOR WINS";
      subtitle = "You made it. Press R to restart.";
      ctx.fillStyle = "#48d0a0";
    } else if (outcome === "draw") {
      title = "DRAW";
      ctx.fillStyle = "#fff";
    }
    ctx.fillText(title, cw / 2, ch / 2 - 10);
    ctx.fillStyle = "#fff";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText(subtitle, cw / 2, ch / 2 + 30);
  }
}
