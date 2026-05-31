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
  "forest_world_1",
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
  forest_world_1: {
    id: "forest_world_1",
    name: "Forest World · Map 1",
    description: "Escape the forest via the exit",
    draw: drawForestArch,
  },
};

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
