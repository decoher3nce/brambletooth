// Per-character visual art. Each character can register a bespoke
// draw function that paints their head/body/face; the renderer wraps
// it with universal layers (shadow, charging ring, status overlays,
// HP bar, name tag).
//
// Art functions take a (cx, cy, radius) anchor so the same code drives
// both in-world rendering and the select-screen portrait. They return
// the visible top Y and a body-center Y so the caller can position
// overlays correctly for characters that don't fit the original
// gumdrop bounds (e.g., Magnek's oversized magnet head).
//
// Adding a new character's art = drop a draw function into CHARACTER_ART
// keyed by characterId. Characters without a registered function fall
// back to the gumdrop language used during the v0.1 prototyping phase.

export interface CharacterArtResult {
  // Top of the visible art in screen coordinates. HP bar and name
  // sit above this.
  topY: number;
  // Center of the body for status rings (charging, overdrive, slowed).
  centerY: number;
}

export type CharacterArtFn = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
) => CharacterArtResult;

// ---- Generic gumdrop fallback ----
// Mirrors the original renderer body + face. facing is in radians,
// 0 = right; portraits pass 0 for static forward-facing.
export function drawGumdropBody(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  colorDark: string,
  facing: number,
): CharacterArtResult {
  const r = radius;
  const h = r * 1.6;
  // Dark base.
  ctx.fillStyle = colorDark;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();
  // Body dome.
  ctx.fillStyle = color;
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
  // Eyes (white dots with black pupils, facing-aware).
  const fx = Math.cos(facing) * 4;
  const fy = Math.sin(facing) * 2;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx - 5 + fx, cy - h * 0.55 + fy, 3, 0, Math.PI * 2);
  ctx.arc(cx + 5 + fx, cy - h * 0.55 + fy, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(cx - 5 + fx * 1.4, cy - h * 0.55 + fy * 1.4, 1.5, 0, Math.PI * 2);
  ctx.arc(cx + 5 + fx * 1.4, cy - h * 0.55 + fy * 1.4, 1.5, 0, Math.PI * 2);
  ctx.fill();
  return { topY: cy - h, centerY: cy - h * 0.4 };
}

// ---- Magnek ----
// Horseshoe-magnet head, red (right, "+") + blue (left, "-") halves
// with eyes on the prong tips, smile in the gap of the U, and a
// thin copper-wire body with "M" chest emblem, arms-up, and feet.
function drawMagnek(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): CharacterArtResult {
  const r = radius;

  // ---- Head geometry ----
  // Oversized cartoon head — outer span ~3.4× collision radius. The
  // U opens downward; eyes sit at the prong tips.
  const headW = r * 3.4;
  const thick = r * 0.95;
  const halfW = (headW - thick) / 2;
  // Where the prong tips end. The body starts just below this.
  const bottomY = cy - r * 0.15;
  // Center of the curved top of the U.
  const topCenterY = bottomY - halfW - r * 0.4;
  const topY = topCenterY - halfW - thick / 2;
  const xL = cx - halfW;
  const xR = cx + halfW;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Black outline (thicker, full U path).
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = thick + 4;
  ctx.beginPath();
  ctx.moveTo(xL, bottomY);
  ctx.lineTo(xL, topCenterY);
  ctx.arc(cx, topCenterY, halfW, Math.PI, 2 * Math.PI);
  ctx.lineTo(xR, bottomY);
  ctx.stroke();

  // Blue half — bottom-left up + over the top-left quadrant to top
  // dead center. Drawn after the outline so the colored fill sits
  // inside the black border.
  ctx.strokeStyle = "#3a72c8";
  ctx.lineWidth = thick;
  ctx.beginPath();
  ctx.moveTo(xL, bottomY);
  ctx.lineTo(xL, topCenterY);
  ctx.arc(cx, topCenterY, halfW, Math.PI, 1.5 * Math.PI);
  ctx.stroke();

  // Red half — top dead center down + over the top-right quadrant to
  // bottom-right prong tip.
  ctx.strokeStyle = "#d04848";
  ctx.beginPath();
  ctx.arc(cx, topCenterY, halfW, 1.5 * Math.PI, 2 * Math.PI);
  ctx.lineTo(xR, bottomY);
  ctx.stroke();

  // Eyes on the prong tips. Blue side gets "-", red side gets "+".
  const eyeR = thick * 0.34;
  const eyeY = bottomY - thick * 0.5;
  drawPoleEye(ctx, xL, eyeY, eyeR, "-");
  drawPoleEye(ctx, xR, eyeY, eyeR, "+");

  // Smile floating inside the U gap, centered horizontally between
  // the prongs and tucked just above the body connection so it sits
  // below the eyes without clipping the chest.
  const smileR = r * 0.35;
  const smileCy = bottomY - smileR * 1.1;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, smileCy, smileR, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // ---- Copper-wire body ----
  const copper = "#c97a3a";
  const copperDark = "#7c4a1f";

  // Torso runs from just below the head down to about r below center.
  const bodyTopY = bottomY + r * 0.15;
  const bodyBottomY = cy + r * 0.55;
  const bodyW = r * 0.95;

  // Vertical torso wire.
  ctx.strokeStyle = copper;
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, bodyTopY);
  ctx.lineTo(cx, bodyBottomY);
  ctx.stroke();

  // "M" emblem on the chest. Sized to read at gameplay scale and
  // legible on the select-screen portrait too.
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `bold ${Math.max(9, Math.floor(r * 0.7))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("M", cx, (bodyTopY + bodyBottomY) / 2);

  // Arms — splayed outward and slightly up like the sketch's raised
  // hands. Wire-thin with small darker hand dots.
  const armY = bodyTopY + (bodyBottomY - bodyTopY) * 0.22;
  const armHandY = armY - bodyW * 0.7;
  ctx.strokeStyle = copper;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx - bodyW, armHandY);
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx + bodyW, armHandY);
  ctx.stroke();
  ctx.fillStyle = copperDark;
  ctx.beginPath();
  ctx.arc(cx - bodyW, armHandY, 2.6, 0, Math.PI * 2);
  ctx.arc(cx + bodyW, armHandY, 2.6, 0, Math.PI * 2);
  ctx.fill();

  // Legs — splay outward to small feet at the ground plane.
  const legX = bodyW * 0.6;
  const feetY = cy + r * 1.05;
  ctx.strokeStyle = copper;
  ctx.lineWidth = 2.8;
  ctx.beginPath();
  ctx.moveTo(cx, bodyBottomY);
  ctx.lineTo(cx - legX, feetY);
  ctx.moveTo(cx, bodyBottomY);
  ctx.lineTo(cx + legX, feetY);
  ctx.stroke();
  ctx.fillStyle = copperDark;
  ctx.beginPath();
  ctx.arc(cx - legX, feetY, 2.8, 0, Math.PI * 2);
  ctx.arc(cx + legX, feetY, 2.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  return {
    topY: topY - 4,
    // Status rings hug the head — that's where Magnek "channels".
    centerY: topCenterY + r * 0.1,
  };
}

// Single eye on a magnet pole. "+" gets cross marks, "-" gets just
// the horizontal bar.
function drawPoleEye(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  symbol: "+" | "-",
): void {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Polarity glyph in the pupil position.
  ctx.lineWidth = Math.max(1.6, r * 0.32);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.55, cy);
  ctx.lineTo(cx + r * 0.55, cy);
  if (symbol === "+") {
    ctx.moveTo(cx, cy - r * 0.55);
    ctx.lineTo(cx, cy + r * 0.55);
  }
  ctx.stroke();
}

export const CHARACTER_ART: Record<string, CharacterArtFn> = {
  magnek: drawMagnek,
};
