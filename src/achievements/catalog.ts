// Achievement catalog + canvas-drawn icons themed to brambletooth.
// Each icon draws into a square box; locked items render dimmed so the
// profile screen can show the whole catalog at once.

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  // Draws the icon into a square area at (x, y) with the given side.
  draw: (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    locked: boolean,
  ) => void;
}

// Display order for the profile screen (loosely easiest -> hardest).
export const ACHIEVEMENT_ORDER = [
  "noob",
  "first_blood",
  "collector",
  "untouchable",
  "ghost",
  "veteran",
  "hunter_slayer",
  "pacifist",
  "forest_world_1",
  "difficult_sweep",
  "legendary_sweep",
  "hbd",
];

// ---- Icon helpers ----
function alpha(locked: boolean, full = 1): number {
  return locked ? 0.22 : full;
}

function drawSprout(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Stem
  ctx.strokeStyle = `rgba(82, 138, 60, ${a})`;
  ctx.lineWidth = Math.max(2, s * 0.06);
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.88);
  ctx.lineTo(s * 0.5, s * 0.42);
  ctx.stroke();
  // Three leaves
  ctx.fillStyle = `rgba(108, 188, 88, ${a})`;
  ctx.beginPath();
  ctx.ellipse(s * 0.32, s * 0.58, s * 0.14, s * 0.08, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s * 0.68, s * 0.66, s * 0.14, s * 0.08, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(140, 212, 110, ${a})`;
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.36, s * 0.12, s * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFang(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Tooth body (off-white)
  ctx.fillStyle = `rgba(245, 240, 220, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.9);
  ctx.lineTo(s * 0.24, s * 0.2);
  ctx.lineTo(s * 0.76, s * 0.2);
  ctx.closePath();
  ctx.fill();
  // Shaded side
  ctx.fillStyle = `rgba(168, 152, 118, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.9);
  ctx.lineTo(s * 0.55, s * 0.2);
  ctx.lineTo(s * 0.76, s * 0.2);
  ctx.closePath();
  ctx.fill();
  // Blood drop at the tip
  ctx.fillStyle = `rgba(208, 60, 60, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.92, Math.max(2, s * 0.07), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Diamond
  ctx.fillStyle = `rgba(255, 216, 74, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.12);
  ctx.lineTo(s * 0.88, s * 0.5);
  ctx.lineTo(s * 0.5, s * 0.92);
  ctx.lineTo(s * 0.12, s * 0.5);
  ctx.closePath();
  ctx.fill();
  // Shadow facet
  ctx.fillStyle = `rgba(184, 148, 30, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.12);
  ctx.lineTo(s * 0.88, s * 0.5);
  ctx.lineTo(s * 0.5, s * 0.5);
  ctx.closePath();
  ctx.fill();
  // Highlight
  ctx.fillStyle = `rgba(255, 240, 160, ${a * 0.9})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.12);
  ctx.lineTo(s * 0.5, s * 0.5);
  ctx.lineTo(s * 0.12, s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShield(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Shield body (survivor green)
  ctx.fillStyle = `rgba(72, 208, 160, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.12);
  ctx.lineTo(s * 0.82, s * 0.28);
  ctx.lineTo(s * 0.82, s * 0.6);
  ctx.lineTo(s * 0.5, s * 0.9);
  ctx.lineTo(s * 0.18, s * 0.6);
  ctx.lineTo(s * 0.18, s * 0.28);
  ctx.closePath();
  ctx.fill();
  // Center leaf badge
  ctx.fillStyle = `rgba(35, 110, 80, ${a})`;
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.5, s * 0.08, s * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // Leaf rib
  ctx.strokeStyle = `rgba(72, 208, 160, ${a * 0.9})`;
  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.32);
  ctx.lineTo(s * 0.5, s * 0.68);
  ctx.stroke();
  ctx.restore();
}

function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked, 0.85); // ghosts are always a touch faded
  ctx.save();
  ctx.translate(x, y);
  // Body
  ctx.fillStyle = `rgba(190, 210, 220, ${a * 0.85})`;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.42, s * 0.28, Math.PI, 0);
  ctx.lineTo(s * 0.78, s * 0.85);
  ctx.lineTo(s * 0.68, s * 0.78);
  ctx.lineTo(s * 0.58, s * 0.87);
  ctx.lineTo(s * 0.5, s * 0.78);
  ctx.lineTo(s * 0.42, s * 0.87);
  ctx.lineTo(s * 0.32, s * 0.78);
  ctx.lineTo(s * 0.22, s * 0.85);
  ctx.closePath();
  ctx.fill();
  // Eyes
  ctx.fillStyle = `rgba(20, 24, 36, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.42, s * 0.4, Math.max(1, s * 0.04), 0, Math.PI * 2);
  ctx.arc(s * 0.58, s * 0.4, Math.max(1, s * 0.04), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCrown(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Bramble ring
  ctx.strokeStyle = `rgba(122, 88, 60, ${a})`;
  ctx.lineWidth = Math.max(2, s * 0.07);
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.55, s * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  // Thorns
  ctx.fillStyle = `rgba(122, 88, 60, ${a})`;
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 - Math.PI / 2;
    const r1 = s * 0.3;
    const r2 = s * 0.46;
    const xa = s * 0.5 + Math.cos(angle + 0.15) * r1;
    const ya = s * 0.55 + Math.sin(angle + 0.15) * r1;
    const xb = s * 0.5 + Math.cos(angle - 0.15) * r1;
    const yb = s * 0.55 + Math.sin(angle - 0.15) * r1;
    const xc = s * 0.5 + Math.cos(angle) * r2;
    const yc = s * 0.55 + Math.sin(angle) * r2;
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xc, yc);
    ctx.lineTo(xb, yb);
    ctx.closePath();
    ctx.fill();
  }
  // Crown gem center
  ctx.fillStyle = `rgba(255, 216, 74, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.55, Math.max(2, s * 0.08), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Forest archway — two trees flanking a glowing exit portal,
// echoing the in-world exit zone visual. Used for the Forest World
// Map 1 completion achievement.
function drawForestArch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Glow portal in the center
  const grad = ctx.createRadialGradient(s * 0.5, s * 0.6, 0, s * 0.5, s * 0.6, s * 0.32);
  grad.addColorStop(0, `rgba(170, 240, 180, ${0.8 * a})`);
  grad.addColorStop(1, "rgba(170, 240, 180, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.6, s * 0.32, 0, Math.PI * 2);
  ctx.fill();
  // Two tree trunks
  ctx.fillStyle = `rgba(80, 50, 30, ${a})`;
  ctx.fillRect(s * 0.18, s * 0.42, s * 0.1, s * 0.46);
  ctx.fillRect(s * 0.72, s * 0.42, s * 0.1, s * 0.46);
  // Two tree canopies
  ctx.fillStyle = `rgba(60, 130, 70, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.23, s * 0.32, s * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(s * 0.77, s * 0.32, s * 0.17, 0, Math.PI * 2);
  ctx.fill();
  // Inner bright portal core
  ctx.fillStyle = `rgba(220, 250, 200, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.6, s * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Hunter Slayer — skull with crossed daggers behind it. Dark
// silhouette, white teeth.
function drawSkull(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, s: number, locked: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  const a = alpha(locked);
  // Crossed daggers behind.
  ctx.strokeStyle = `rgba(170, 180, 190, ${a * 0.85})`;
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s * 0.12, s * 0.18);
  ctx.lineTo(s * 0.88, s * 0.82);
  ctx.moveTo(s * 0.88, s * 0.18);
  ctx.lineTo(s * 0.12, s * 0.82);
  ctx.stroke();
  // Skull body.
  ctx.fillStyle = `rgba(240, 235, 220, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.42, s * 0.30, 0, Math.PI * 2);
  ctx.fill();
  // Jaw rectangle.
  ctx.fillRect(s * 0.30, s * 0.55, s * 0.40, s * 0.20);
  // Eye sockets.
  ctx.fillStyle = `rgba(20, 20, 25, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.39, s * 0.42, s * 0.08, 0, Math.PI * 2);
  ctx.arc(s * 0.61, s * 0.42, s * 0.08, 0, Math.PI * 2);
  ctx.fill();
  // Nose triangle.
  ctx.beginPath();
  ctx.moveTo(s * 0.5, s * 0.45);
  ctx.lineTo(s * 0.46, s * 0.55);
  ctx.lineTo(s * 0.54, s * 0.55);
  ctx.closePath();
  ctx.fill();
  // Teeth slits.
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(s * (0.34 + i * 0.085), s * 0.60, s * 0.04, s * 0.13);
  }
  ctx.restore();
}

// Pacifist — dove in flight with an olive branch. Soft white body,
// outstretched wing.
function drawDove(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, s: number, locked: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  const a = alpha(locked);
  // Soft halo.
  ctx.fillStyle = `rgba(255, 245, 220, ${a * 0.25})`;
  ctx.beginPath();
  ctx.arc(s * 0.55, s * 0.50, s * 0.40, 0, Math.PI * 2);
  ctx.fill();
  // Wing (the prominent shape).
  ctx.fillStyle = `rgba(245, 248, 252, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.45, s * 0.52);
  ctx.quadraticCurveTo(s * 0.20, s * 0.18, s * 0.05, s * 0.45);
  ctx.quadraticCurveTo(s * 0.25, s * 0.60, s * 0.40, s * 0.62);
  ctx.closePath();
  ctx.fill();
  // Body.
  ctx.beginPath();
  ctx.ellipse(s * 0.62, s * 0.55, s * 0.22, s * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Head.
  ctx.beginPath();
  ctx.arc(s * 0.80, s * 0.45, s * 0.10, 0, Math.PI * 2);
  ctx.fill();
  // Beak.
  ctx.fillStyle = `rgba(230, 175, 80, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.88, s * 0.44);
  ctx.lineTo(s * 0.96, s * 0.46);
  ctx.lineTo(s * 0.88, s * 0.49);
  ctx.closePath();
  ctx.fill();
  // Eye.
  ctx.fillStyle = `rgba(20, 20, 25, ${a})`;
  ctx.beginPath();
  ctx.arc(s * 0.82, s * 0.43, s * 0.018, 0, Math.PI * 2);
  ctx.fill();
  // Olive branch.
  ctx.strokeStyle = `rgba(80, 130, 60, ${a})`;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s * 0.95, s * 0.48);
  ctx.lineTo(s * 1.04, s * 0.55);
  ctx.stroke();
  // Two leaves.
  ctx.fillStyle = `rgba(110, 170, 80, ${a})`;
  ctx.beginPath();
  ctx.ellipse(s * 1.00, s * 0.50, s * 0.04, s * 0.018, -0.5, 0, Math.PI * 2);
  ctx.ellipse(s * 1.02, s * 0.56, s * 0.04, s * 0.018, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// HBD — tiered birthday cake silhouette with a flame, ribbon, and a
// confetti dot scatter so it reads as celebratory even when locked.
function drawBirthdayCake(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, s: number, locked: boolean,
): void {
  ctx.save();
  const a = alpha(locked);
  // Plate.
  ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * a})`;
  ctx.beginPath();
  ctx.ellipse(x + s * 0.50, y + s * 0.82, s * 0.42, s * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  // Lower tier — pink frosting band on top.
  ctx.fillStyle = `rgba(229, 110, 130, ${a})`;
  ctx.fillRect(x + s * 0.18, y + s * 0.55, s * 0.64, s * 0.25);
  ctx.fillStyle = `rgba(255, 200, 215, ${a})`;
  ctx.fillRect(x + s * 0.18, y + s * 0.52, s * 0.64, s * 0.08);
  // Upper tier — yellow.
  ctx.fillStyle = `rgba(245, 200, 70, ${a})`;
  ctx.fillRect(x + s * 0.28, y + s * 0.34, s * 0.44, s * 0.20);
  ctx.fillStyle = `rgba(255, 230, 130, ${a})`;
  ctx.fillRect(x + s * 0.28, y + s * 0.31, s * 0.44, s * 0.07);
  // Candle.
  ctx.fillStyle = `rgba(70, 140, 220, ${a})`;
  ctx.fillRect(x + s * 0.475, y + s * 0.18, s * 0.05, s * 0.16);
  // Flame.
  ctx.fillStyle = `rgba(255, 180, 50, ${a})`;
  ctx.beginPath();
  ctx.ellipse(x + s * 0.50, y + s * 0.14, s * 0.05, s * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  // Confetti dots.
  const dotColors = ["#5fb96b", "#5a8fc8", "#ffd84a", "#d05050", "#a06ac8"];
  for (let i = 0; i < 6; i++) {
    const dx = x + s * (0.08 + (i * 0.16) % 0.84);
    const dy = y + s * (0.10 + ((i * 37) % 20) * 0.012);
    ctx.fillStyle = locked
      ? `rgba(255, 255, 255, ${0.22})`
      : dotColors[i % dotColors.length]!;
    ctx.beginPath();
    ctx.arc(dx, dy, s * 0.025, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export const ACHIEVEMENT_CATALOG: Record<string, AchievementDef> = {
  noob: {
    id: "noob",
    name: "Noob",
    description: "Earn your first point",
    draw: drawSprout,
  },
  first_blood: {
    id: "first_blood",
    name: "First Blood",
    description: "Catch your first survivor as the hunter",
    draw: drawFang,
  },
  collector: {
    id: "collector",
    name: "Collector",
    description: "Collect 5 objectives in one round",
    draw: drawGem,
  },
  untouchable: {
    id: "untouchable",
    name: "Untouchable",
    description: "Survive a round without dropping below half HP",
    draw: drawShield,
  },
  ghost: {
    id: "ghost",
    name: "Ghost",
    description: "Win a round as the hunter without being seen",
    draw: drawSilhouette,
  },
  veteran: {
    id: "veteran",
    name: "Veteran",
    description: "Reach 100 lifetime points",
    draw: drawCrown,
  },
  hunter_slayer: {
    id: "hunter_slayer",
    name: "Hunter Slayer",
    description: "Be on the surviving team when a hunter falls",
    draw: drawSkull,
  },
  pacifist: {
    id: "pacifist",
    name: "Pacifist",
    description: "Win a round without casting a single ability",
    draw: drawDove,
  },
  forest_world_1: {
    id: "forest_world_1",
    name: "Forest World · Map 1",
    description: "Escape the forest via the exit",
    draw: drawForestArch,
  },
  difficult_sweep: {
    id: "difficult_sweep",
    name: "Difficult Sweep",
    description: "Defeat every character on Difficult",
    draw: (ctx, x, y, s, locked) => drawTrophyBadge(ctx, x, y, s, locked, "D"),
  },
  legendary_sweep: {
    id: "legendary_sweep",
    name: "Legendary Sweep",
    description: "Defeat every character on Legendary",
    draw: (ctx, x, y, s, locked) => drawTrophyBadge(ctx, x, y, s, locked, "L"),
  },
  hbd: {
    id: "hbd",
    name: "Happy Birthday!",
    description: "The rainbow herd came to play",
    draw: drawBirthdayCake,
  },
};

// Difficulty-sweep icon — a chunky trophy with a single-letter rank
// badge ("D" for Difficult, "L" for Legendary). Locked instances render
// at the same low alpha as the rest of the catalog.
function drawTrophyBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  locked: boolean,
  letter: string,
): void {
  const a = alpha(locked);
  ctx.save();
  ctx.translate(x, y);
  // Cup body — gold trapezoid.
  ctx.fillStyle = `rgba(232, 176, 74, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.30, s * 0.22);
  ctx.lineTo(s * 0.70, s * 0.22);
  ctx.lineTo(s * 0.62, s * 0.55);
  ctx.lineTo(s * 0.38, s * 0.55);
  ctx.closePath();
  ctx.fill();
  // Stem.
  ctx.fillStyle = `rgba(170, 120, 40, ${a})`;
  ctx.fillRect(s * 0.45, s * 0.55, s * 0.10, s * 0.18);
  // Base.
  ctx.fillStyle = `rgba(170, 120, 40, ${a})`;
  ctx.beginPath();
  ctx.moveTo(s * 0.30, s * 0.78);
  ctx.lineTo(s * 0.70, s * 0.78);
  ctx.lineTo(s * 0.66, s * 0.85);
  ctx.lineTo(s * 0.34, s * 0.85);
  ctx.closePath();
  ctx.fill();
  // Handles.
  ctx.strokeStyle = `rgba(232, 176, 74, ${a})`;
  ctx.lineWidth = Math.max(2, s * 0.04);
  ctx.beginPath();
  ctx.arc(s * 0.30, s * 0.34, s * 0.10, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s * 0.70, s * 0.34, s * 0.10, Math.PI / 2, -Math.PI / 2, true);
  ctx.stroke();
  // Rank letter inside the cup.
  ctx.fillStyle = `rgba(40, 28, 8, ${a})`;
  ctx.font = `bold ${Math.floor(s * 0.26)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, s * 0.50, s * 0.40);
  ctx.restore();
}

// Locked-tile background — drawn behind icons in the profile list.
export function drawAchievementTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  locked: boolean,
): void {
  ctx.save();
  const bg = locked ? "rgba(20, 26, 24, 0.7)" : "rgba(40, 52, 48, 0.9)";
  const border = locked ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 216, 74, 0.45)";
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, size, size, 6);
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = locked ? 1 : 1.5;
  roundRect(ctx, x, y, size, size, 6);
  ctx.stroke();
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Relative date formatter for profile screen entries.
export function formatEarnedDate(timestamp: number): string {
  if (!timestamp || timestamp === 0) return "Earned long ago";
  const earned = new Date(timestamp);
  const now = new Date();
  // Calendar-day diff (ignore time of day) so "yesterday" stays yesterday
  // regardless of when in the day they earned it.
  const a = new Date(earned.getFullYear(), earned.getMonth(), earned.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  if (days <= 0) return "Earned today";
  if (days === 1) return "Earned yesterday";
  if (days < 7) return `Earned ${days} days ago`;
  if (days < 30) return `Earned ${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? "" : "s"} ago`;
  return `Earned ${earned.toLocaleDateString()}`;
}
