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
// Horseshoe-magnet head shaped like the letter U (opens UPWARD).
// Curved base at the bottom, prongs going up. Left prong blue with
// a "-" eye; right prong red with a "+" eye; smile at the base where
// the two colors meet.
//
// Body is a stranded copper-wire skeleton: 4-strand torso wide enough
// to legibly carry the "M" chest emblem, 3-strand arms and legs that
// terminate in copper-dark hand and foot blobs sized to overlap the
// strand-bundle endpoints (so the limbs visibly "come from" the
// strands).
//
// Canvas arc direction note: arc(cx, cy, r, π, 0, anticlockwise=TRUE)
// traverses angles π → π/2 → 0. At π/2, sin = +1 → y-offset is +halfW
// (BELOW center on canvas, where +y is down). That's the LOWER
// semicircle — which is what we want for a letter U. Using
// anticlockwise=false with the same endpoints would sweep through
// angle 3π/2 (sin = -1, ABOVE center) and give an upside-down U.
function drawMagnek(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
): CharacterArtResult {
  const r = radius;

  // Total visible height ≈ 2.8r, split ~50/50 between head (top) and
  // body (bottom). Feet at cy; art extends upward.
  const totalH = r * 2.8;
  const feetY = cy;
  const headTopY = cy - totalH;
  const headBaseY = cy - totalH * 0.5;

  // ---- U-shaped magnet head (opens UPWARD) ----
  const headW = r * 1.3;
  const thick = r * 0.4;
  const halfW = (headW - thick) / 2; // = r * 0.45
  const xL = cx - halfW;
  const xR = cx + halfW;
  // Curve at the bottom of the head. The arc traces the lower
  // semicircle; its outer-bottom edge sits at headBaseY.
  const curveCenterY = headBaseY - thick / 2 - halfW;
  const curveCenterlineBottom = curveCenterY + halfW; // centerline at base
  const prongTopY = headTopY + thick / 2;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Black outline (full U path traced thicker, sits behind colored halves).
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = thick + 4;
  ctx.beginPath();
  ctx.moveTo(xL, prongTopY);
  ctx.lineTo(xL, curveCenterY);
  ctx.arc(cx, curveCenterY, halfW, Math.PI, 0, true);
  ctx.lineTo(xR, prongTopY);
  ctx.stroke();

  // Blue half: top-left tip → down left prong → lower-left curve
  // quadrant → center-bottom. Anticlockwise from π to π/2 (sweeps
  // through angle 3π/4 = lower-left of arc center).
  ctx.strokeStyle = "#3a72c8";
  ctx.lineWidth = thick;
  ctx.beginPath();
  ctx.moveTo(xL, prongTopY);
  ctx.lineTo(xL, curveCenterY);
  ctx.arc(cx, curveCenterY, halfW, Math.PI, Math.PI / 2, true);
  ctx.stroke();

  // Red half: center-bottom → lower-right curve quadrant → up right
  // prong → top-right tip. Anticlockwise from π/2 to 0.
  ctx.strokeStyle = "#d04848";
  ctx.beginPath();
  ctx.arc(cx, curveCenterY, halfW, Math.PI / 2, 0, true);
  ctx.lineTo(xR, prongTopY);
  ctx.stroke();

  // Eyes at the prong tips (the magnetic poles).
  const eyeR = thick * 0.36;
  drawPoleEye(ctx, xL, prongTopY, eyeR, "-");
  drawPoleEye(ctx, xR, prongTopY, eyeR, "+");

  // Smile at the base of the U where blue and red meet. Centered on
  // the curve's bottom centerline; drawn after the colored halves so
  // it sits on top as the magnet's mouth.
  const smileR = thick * 0.45;
  const smileCy = curveCenterlineBottom - smileR * 0.15;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, smileCy, smileR, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // ---- Stranded copper-wire body ----
  // Strands SPIRAL like real twisted cable (sine-wave paths with
  // 360°/N phase offsets). Each strand drawn as a dark-brown shadow
  // followed by a copper highlight so crossings read as woven wire,
  // not pinstripes.
  const copper = "#c97a3a";
  const copperShadow = "#5a3315"; // deep umber for strand shadow + outlines
  const copperDark = "#7c4a1f";   // mid-brown for terminator fills

  const torsoStrands = 4;
  const torsoStrandThick = Math.max(1.7, r * 0.085);
  const torsoBundleW = Math.max(10, r * 0.55);
  const torsoAmp = (torsoBundleW - torsoStrandThick) / 2;

  const torsoTopY = headBaseY + r * 0.05;
  const torsoBottomY = cy - r * 0.5;

  drawSpiraledStrands(
    ctx,
    cx, torsoTopY,
    cx, torsoBottomY,
    torsoStrands, torsoStrandThick,
    torsoAmp, 2.5,
    copper, copperShadow,
  );

  // "M" chest emblem in the magnet's two polarity colors. Sharp split
  // down the middle — left half blue (matches the left prong), right
  // half red (matches the right prong).
  const mY = (torsoTopY + torsoBottomY) / 2;
  const fontSize = Math.max(11, Math.floor(r * 0.7));
  ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Left half: blue
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - fontSize, mY - fontSize, fontSize, fontSize * 2);
  ctx.clip();
  ctx.fillStyle = "#3a72c8";
  ctx.fillText("M", cx, mY);
  ctx.restore();
  // Right half: red
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, mY - fontSize, fontSize, fontSize * 2);
  ctx.clip();
  ctx.fillStyle = "#d04848";
  ctx.fillText("M", cx, mY);
  ctx.restore();

  // ---- Arms (3-strand, spiraled) ----
  const limbStrands = 3;
  const limbStrandThick = Math.max(1.4, r * 0.07);
  const limbBundleW = Math.max(5, r * 0.28);
  const limbAmp = (limbBundleW - limbStrandThick) / 2;
  const handR = Math.max(3, r * 0.18);
  const footR = Math.max(3.2, r * 0.2);

  const shoulderY = torsoTopY + (torsoBottomY - torsoTopY) * 0.18;
  const handReach = r * 0.95;
  const handRise = r * 0.42;

  // Arms emerge from the OUTER torso edges and rise outward.
  drawSpiraledStrands(
    ctx,
    cx - torsoBundleW / 2, shoulderY,
    cx - handReach, shoulderY - handRise,
    limbStrands, limbStrandThick, limbAmp, 2,
    copper, copperShadow,
  );
  drawSpiraledStrands(
    ctx,
    cx + torsoBundleW / 2, shoulderY,
    cx + handReach, shoulderY - handRise,
    limbStrands, limbStrandThick, limbAmp, 2,
    copper, copperShadow,
  );

  // Hands — copper-dark blobs at the strand-bundle ends. Sized to
  // cover the strand cluster so the limb visibly converges into them.
  drawTerminator(ctx, cx - handReach, shoulderY - handRise, handR, copperDark, copperShadow);
  drawTerminator(ctx, cx + handReach, shoulderY - handRise, handR, copperDark, copperShadow);

  // ---- Legs (3-strand, spiraled) ----
  const legSplay = r * 0.55;
  // Legs emerge from inner torso positions for visual continuity.
  const legTopXLeft = cx - torsoBundleW / 4;
  const legTopXRight = cx + torsoBundleW / 4;
  drawSpiraledStrands(
    ctx,
    legTopXLeft, torsoBottomY,
    cx - legSplay, feetY,
    limbStrands, limbStrandThick, limbAmp, 2,
    copper, copperShadow,
  );
  drawSpiraledStrands(
    ctx,
    legTopXRight, torsoBottomY,
    cx + legSplay, feetY,
    limbStrands, limbStrandThick, limbAmp, 2,
    copper, copperShadow,
  );

  // Feet — same blob treatment as hands.
  drawTerminator(ctx, cx - legSplay, feetY, footR, copperDark, copperShadow);
  drawTerminator(ctx, cx + legSplay, feetY, footR, copperDark, copperShadow);

  ctx.restore();

  return {
    topY: prongTopY - eyeR - 4,
    centerY: curveCenterY,
  };
}

// Spiraled stranded copper wire from (x1, y1) to (x2, y2). Each strand
// follows a sinusoidal path along the wire's axis with a 360°/N phase
// shift, so the bundle reads as a twisted cable (like real stranded
// wire) rather than a pinstripe of parallel lines. Each strand draws
// as a dark-brown shadow stroke followed by a copper highlight on top.
function drawSpiraledStrands(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  strands: number, strandThick: number,
  amplitude: number, twists: number,
  copperColor: string, shadowColor: string,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  // Unit perpendicular (rotate direction 90° CCW).
  const px = -dy / len;
  const py = dx / len;
  // Segment count scales with length so the curve stays smooth.
  const segs = Math.max(24, Math.floor(len * 1.6));

  // Pre-compute each strand's path. Pairs of (x, y) floats interleaved.
  const paths: number[][] = [];
  for (let i = 0; i < strands; i++) {
    const phase = (i / strands) * 2 * Math.PI;
    const pts: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const lx = x1 + dx * t;
      const ly = y1 + dy * t;
      const o = amplitude * Math.sin(t * 2 * Math.PI * twists + phase);
      pts.push(lx + px * o, ly + py * o);
    }
    paths.push(pts);
  }

  ctx.lineCap = "round";

  // Draw per-strand (shadow + highlight) so each strand's z-order is
  // consistent at crossings. The later-drawn strand sits on top.
  for (const pts of paths) {
    // Shadow base.
    ctx.strokeStyle = shadowColor;
    ctx.lineWidth = strandThick + 0.8;
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i]!, pts[i + 1]!);
    }
    ctx.stroke();
    // Copper highlight.
    ctx.strokeStyle = copperColor;
    ctx.lineWidth = strandThick;
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i]!, pts[i + 1]!);
    }
    ctx.stroke();
  }
}

// Hand / foot termination — a filled circle with a thin dark-brown
// outline, drawn ON TOP of the strand-bundle endpoint so the limb
// visually converges into it.
function drawTerminator(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  fill: string,
  outline: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
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
