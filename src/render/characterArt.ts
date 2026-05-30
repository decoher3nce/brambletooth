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
// Horseshoe-magnet head shaped like the letter U (opens upward).
// Left prong blue with a "-" eye; right prong red with a "+" eye;
// smile sits at the base of the U where the two halves meet.
// Copper-wire body with chunky limbs and an "M" chest emblem.
function drawMagnek(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): CharacterArtResult {
  const r = radius;

  // Compact cartoon proportions. Total visible height ≈ 2.6r, split
  // ~50/50 between magnet head (top half) and copper-wire body
  // (bottom half). Feet sit at cy; the art extends UPWARD.
  const totalH = r * 2.6;
  const feetY = cy;
  const headTopY = cy - totalH;
  const headBaseY = cy - totalH * 0.5; // head/body split line

  // U geometry. Prongs go UP from the curved base.
  const headW = r * 1.6;
  const thick = r * 0.42;
  const halfW = (headW - thick) / 2;
  const xL = cx - halfW;
  const xR = cx + halfW;
  // Center of the curved base; arc radius = halfW. Pull the curve
  // upward enough that its outer-bottom kisses the head/body line.
  const curveCenterY = headBaseY - halfW;
  const curveBottomY = curveCenterY + halfW;
  const prongTopY = headTopY + thick * 0.5;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Black outline (full U path traced once thicker than the colored
  // halves, so it sits behind them as a border).
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = thick + 4;
  ctx.beginPath();
  ctx.moveTo(xL, prongTopY);
  ctx.lineTo(xL, curveCenterY);
  // Lower semicircle: π → 2π traverses left, down through bottom, right.
  ctx.arc(cx, curveCenterY, halfW, Math.PI, 2 * Math.PI);
  ctx.lineTo(xR, prongTopY);
  ctx.stroke();

  // Blue left half: from top-left tip down + lower-left curve quadrant
  // to center-bottom.
  ctx.strokeStyle = "#3a72c8";
  ctx.lineWidth = thick;
  ctx.beginPath();
  ctx.moveTo(xL, prongTopY);
  ctx.lineTo(xL, curveCenterY);
  ctx.arc(cx, curveCenterY, halfW, Math.PI, 1.5 * Math.PI);
  ctx.stroke();

  // Red right half: from center-bottom + lower-right curve quadrant up
  // to top-right tip.
  ctx.strokeStyle = "#d04848";
  ctx.beginPath();
  ctx.arc(cx, curveCenterY, halfW, 1.5 * Math.PI, 2 * Math.PI);
  ctx.lineTo(xR, prongTopY);
  ctx.stroke();

  // Eyes at the prong tips (the magnetic poles).
  const eyeR = thick * 0.36;
  drawPoleEye(ctx, xL, prongTopY, eyeR, "-");
  drawPoleEye(ctx, xR, prongTopY, eyeR, "+");

  // Smile at the base of the U where the blue and red halves meet.
  // Sits centered inside the curve band so it reads as the magnet's
  // mouth, drawn AFTER the colors so it's not painted over.
  const smileR = thick * 0.55;
  const smileCy = curveBottomY - thick * 0.5 - smileR * 0.35;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(cx, smileCy, smileR, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // ---- Copper-wire body ----
  // Chunkier than v1 so torso/arms/legs read at gameplay scale.
  const copper = "#c97a3a";
  const copperDark = "#7c4a1f";
  const torsoThick = Math.max(3.2, r * 0.22);
  const limbThick = Math.max(2.8, r * 0.19);
  const handR = Math.max(2.6, r * 0.16);
  const footR = Math.max(2.8, r * 0.18);

  const torsoTopY = headBaseY + r * 0.05;
  const torsoBottomY = cy - r * 0.55;
  const bodyW = r * 0.95;

  // Vertical torso wire.
  ctx.strokeStyle = copper;
  ctx.lineWidth = torsoThick;
  ctx.beginPath();
  ctx.moveTo(cx, torsoTopY);
  ctx.lineTo(cx, torsoBottomY);
  ctx.stroke();

  // M emblem on the chest.
  ctx.fillStyle = "#1a1a1a";
  ctx.font = `bold ${Math.max(10, Math.floor(r * 0.62))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("M", cx, (torsoTopY + torsoBottomY) / 2);

  // Arms — out and slightly up (cartoon raised pose).
  const armY = torsoTopY + (torsoBottomY - torsoTopY) * 0.22;
  const armHandY = armY - bodyW * 0.4;
  ctx.strokeStyle = copper;
  ctx.lineWidth = limbThick;
  ctx.beginPath();
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx - bodyW, armHandY);
  ctx.moveTo(cx, armY);
  ctx.lineTo(cx + bodyW, armHandY);
  ctx.stroke();
  ctx.fillStyle = copperDark;
  ctx.beginPath();
  ctx.arc(cx - bodyW, armHandY, handR, 0, Math.PI * 2);
  ctx.arc(cx + bodyW, armHandY, handR, 0, Math.PI * 2);
  ctx.fill();

  // Legs — splay outward to feet on the ground line (cy).
  const legX = bodyW * 0.55;
  ctx.strokeStyle = copper;
  ctx.lineWidth = limbThick;
  ctx.beginPath();
  ctx.moveTo(cx, torsoBottomY);
  ctx.lineTo(cx - legX, feetY);
  ctx.moveTo(cx, torsoBottomY);
  ctx.lineTo(cx + legX, feetY);
  ctx.stroke();
  ctx.fillStyle = copperDark;
  ctx.beginPath();
  ctx.arc(cx - legX, feetY, footR, 0, Math.PI * 2);
  ctx.arc(cx + legX, feetY, footR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Visible top of the art (account for the eye/prong round-cap).
  return {
    topY: prongTopY - eyeR - 4,
    // Status rings hug the head — Magnek channels through the magnet.
    centerY: curveCenterY,
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
