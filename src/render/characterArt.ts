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

// Per-frame animation state passed from the renderer / portrait.
// Computed by the caller from entity fields + a wall-clock phase so
// the art function stays a pure function of these inputs.
export interface CharacterAnim {
  // Walking speed, 0..1. 0 = idle, 1 = moving at the character's
  // configured speed. Drives walk-cycle phase amplitude.
  walkSpeed: number;
  // Seconds since some shared origin. Used to compute walk-cycle
  // phase (sin/cos of a multiple of this). Wall-clock based, not
  // tied to snapshot ticks, so the animation runs smoothly between
  // server updates.
  phase: number;
  // Magnesis-style charge progress, 0..1, when this character is
  // channeling a long ability that should visualize energy buildup.
  // Used to drive the red→yellow→white glow.
  chargeGlow?: number;
  // Pose override: when "kneel", the character bends a leg to
  // visualize dropping a plate. Lasts a short time after the cast.
  pose?: "kneel";
}

export type CharacterArtFn = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  facing: number, // radians; 0 = right, π/2 = down, used for eye aim
  anim: CharacterAnim,
) => CharacterArtResult;

// ---- Generic gumdrop fallback ----
// Mirrors the original renderer body + face. facing is in radians,
// 0 = right; portraits pass 0 for static forward-facing. Gumdrop
// ignores animation state for now (idle posed) — characters that
// want walk cycles should ship bespoke art (e.g. drawMagnek).
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
  facing: number,
  anim: CharacterAnim,
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

  // Black outline (thin — was thick + 4, now thick + 2 for ~1px
  // visible border on each side of the colored stroke).
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = thick + 2;
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

  // Eyes at the prong tips (the magnetic poles). Symbols shift inside
  // the white toward the facing direction so the eyes track the aim
  // cursor (same input as the gumdrop facing — engine updates
  // c.facing to atan2 of aim vector).
  const eyeR = thick * 0.36;
  const lookX = Math.cos(facing);
  const lookY = Math.sin(facing);
  drawPoleEye(ctx, xL, prongTopY, eyeR, "-", lookX, lookY);
  drawPoleEye(ctx, xR, prongTopY, eyeR, "+", lookX, lookY);

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
  // Strands SPIRAL gently like real twisted cable — low amplitude and
  // few twists so the weave reads at a glance instead of looking like
  // bandages. Each strand draws as a dark-brown shadow followed by a
  // copper highlight so crossings layer naturally.
  const copper = "#c97a3a";
  const copperShadow = "#5a3315"; // deep umber for strand shadow + outlines

  const torsoStrands = 4;
  const torsoStrandThick = Math.max(1.7, r * 0.085);
  const torsoBundleW = Math.max(10, r * 0.55);
  // Gentler than v4: amplitude halved, ~1.2 twists across torso length.
  const torsoAmp = ((torsoBundleW - torsoStrandThick) / 2) * 0.5;
  const torsoTwists = 1.2;

  const torsoTopY = headBaseY + r * 0.05;
  const torsoBottomY = cy - r * 0.5;

  drawSpiraledStrands(
    ctx,
    cx, torsoTopY,
    cx, torsoBottomY,
    torsoStrands, torsoStrandThick,
    torsoAmp, torsoTwists,
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
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - fontSize, mY - fontSize, fontSize, fontSize * 2);
  ctx.clip();
  ctx.fillStyle = "#3a72c8";
  ctx.fillText("M", cx, mY);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx, mY - fontSize, fontSize, fontSize * 2);
  ctx.clip();
  ctx.fillStyle = "#d04848";
  ctx.fillText("M", cx, mY);
  ctx.restore();

  // ---- Arms + legs ----
  const limbStrands = 3;
  const limbStrandThick = Math.max(1.4, r * 0.07);
  const limbBundleW = Math.max(5, r * 0.28);
  const limbAmp = ((limbBundleW - limbStrandThick) / 2) * 0.55;
  const limbTwists = 1.0;

  const shoulderY = torsoTopY + (torsoBottomY - torsoTopY) * 0.18;
  // Wrist sits 70% of the way from shoulder to hand tip; the bundle
  // ends here and the 2 hand strands continue to the tip.
  const wristFrac = 0.7;

  // ---- Animation-driven limb endpoints ----
  // Walk cycle: arms swing forward/back, legs stride opposite. Phase
  // frequency rises with walk speed so faster movement = faster steps.
  // At idle (walkSpeed == 0), arms hang straight down at the sides and
  // legs go straight to feet with no splay.
  const walkSpeed = Math.max(0, Math.min(1, anim.walkSpeed));
  const swing = Math.sin(anim.phase * 8) * walkSpeed; // -1..1, eased by walkSpeed
  const oppSwing = -swing; // arms and legs mirror each other (opposite limb pairs)

  // Idle arms hang down close to the body; walking arms swing
  // forward/back. Arm "reach" lerps with walkSpeed.
  const idleHandX = r * 0.45;             // close to torso when idle
  const idleHandY = r * 0.45;             // below shoulder (hanging)
  const walkHandX = r * 0.75;
  const walkHandY = r * 0.05;              // higher (swinging forward) when moving
  const handReachBase = idleHandX + (walkHandX - idleHandX) * walkSpeed;
  const handRiseBase = idleHandY + (walkHandY - idleHandY) * walkSpeed;
  // Per-arm swing: left arm leads with +swing, right arm with oppSwing.
  // Swing shifts both forward/back (along facing-ignorant body axis) and
  // up/down a touch for natural cadence.
  const armForward = r * 0.35 * walkSpeed; // how far swing pushes each arm fwd/back
  const armBob = r * 0.12 * walkSpeed;

  // Left arm (driven by swing)
  drawWireLimb(
    ctx,
    cx - torsoBundleW / 2, shoulderY,
    cx - handReachBase + swing * armForward,
    shoulderY + handRiseBase - Math.abs(swing) * armBob,
    limbStrands, limbStrandThick, limbAmp, limbTwists,
    wristFrac, copper, copperShadow,
  );
  // Right arm (driven by oppSwing)
  drawWireLimb(
    ctx,
    cx + torsoBundleW / 2, shoulderY,
    cx + handReachBase + oppSwing * armForward,
    shoulderY + handRiseBase - Math.abs(oppSwing) * armBob,
    limbStrands, limbStrandThick, limbAmp, limbTwists,
    wristFrac, copper, copperShadow,
  );

  // Legs: stride opposite to the arm on the same side. Idle = legs
  // straight down from hip positions (feet under hips, NOT crossed
  // at center — no ballet pose). Walking = alternating stride that
  // splays outward and bobs fwd/back.
  const idleLegSplay = r * 0.0;
  const walkLegSplay = r * 0.35;
  const legSplay = idleLegSplay + (walkLegSplay - idleLegSplay) * walkSpeed;
  const legTopXLeft = cx - torsoBundleW / 4;
  const legTopXRight = cx + torsoBundleW / 4;
  // Kneel pose: left knee bent forward, right leg planted under hip.
  // Replaces walk-cycle stride for the short kneel window.
  const kneeling = anim.pose === "kneel";
  const leftLegEndX = kneeling
    ? cx - r * 0.2
    : legTopXLeft - legSplay + oppSwing * r * 0.3 * walkSpeed;
  const leftLegEndY = kneeling ? cy - r * 0.05 : feetY;
  const rightLegEndX = kneeling
    ? cx + r * 0.55
    : legTopXRight + legSplay + swing * r * 0.3 * walkSpeed;
  const rightLegEndY = feetY;

  drawWireLimb(
    ctx,
    legTopXLeft, torsoBottomY,
    leftLegEndX, leftLegEndY,
    limbStrands, limbStrandThick, limbAmp, limbTwists,
    wristFrac, copper, copperShadow,
  );
  drawWireLimb(
    ctx,
    legTopXRight, torsoBottomY,
    rightLegEndX, rightLegEndY,
    limbStrands, limbStrandThick, limbAmp, limbTwists,
    wristFrac, copper, copperShadow,
  );

  // Magnesis charging glow — red → yellow → white as progress climbs.
  // Drawn LAST so it sits on top of the head as a coronal halo.
  if (anim.chargeGlow !== undefined && anim.chargeGlow > 0) {
    drawChargeGlow(ctx, cx, curveCenterY, headW * 0.9, anim.chargeGlow);
  }

  ctx.restore();

  return {
    topY: prongTopY - eyeR - 4,
    centerY: curveCenterY,
  };
}

// Halo that climbs red → yellow → white as progress goes 0 → 1.
// Used for the Magnesis windup so the audience can read how close
// Magnek is to launching.
function drawChargeGlow(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, baseR: number, progress: number,
): void {
  // Hue progression: 0=red, 0.5=yellow, 1=white-hot.
  const t = Math.max(0, Math.min(1, progress));
  let r1: number, g1: number, b1: number;
  if (t < 0.5) {
    // Red → yellow
    const k = t * 2;
    r1 = 255;
    g1 = Math.round(100 + (220 - 100) * k);
    b1 = Math.round(40 + (60 - 40) * k);
  } else {
    // Yellow → white
    const k = (t - 0.5) * 2;
    r1 = 255;
    g1 = Math.round(220 + (255 - 220) * k);
    b1 = Math.round(60 + (255 - 60) * k);
  }
  const glowR = baseR * (1.0 + 0.4 * t);
  ctx.save();
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  const innerA = 0.35 + 0.45 * t;
  grad.addColorStop(0, `rgba(${r1}, ${g1}, ${b1}, ${innerA})`);
  grad.addColorStop(0.55, `rgba(${r1}, ${g1}, ${b1}, ${innerA * 0.35})`);
  grad.addColorStop(1, `rgba(${r1}, ${g1}, ${b1}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
    // Shadow base (~1px visible dark border on each side of the copper
    // highlight — matches the head outline's visual weight).
    ctx.strokeStyle = shadowColor;
    ctx.lineWidth = strandThick + 2;
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

// A full wire limb: spiraled N-strand bundle from (x1, y1) to a
// "wrist" point at fraction `wristFrac` along the way, then 2 straight
// strands continuing the rest of the way to (x2, y2) with a slight
// outward splay. Used for both arms and legs — the 2 terminal strands
// ARE the hand or foot (no separate ball terminator).
function drawWireLimb(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number,
  bundleStrands: number, strandThick: number,
  bundleAmp: number, bundleTwists: number,
  wristFrac: number,
  copperColor: string, shadowColor: string,
): void {
  // Wrist (where the bundle ends and the 2 hand strands begin).
  const wristX = x1 + (x2 - x1) * wristFrac;
  const wristY = y1 + (y2 - y1) * wristFrac;

  // Spiraled bundle: shoulder/hip → wrist/ankle.
  drawSpiraledStrands(
    ctx,
    x1, y1, wristX, wristY,
    bundleStrands, strandThick,
    bundleAmp, bundleTwists,
    copperColor, shadowColor,
  );

  // The 2 hand/foot strands: from wrist to (x2, y2), splayed slightly
  // perpendicular to the limb axis. Slightly thicker than bundle
  // strands so the hand/foot has visible weight.
  const dx = x2 - wristX;
  const dy = y2 - wristY;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 0.01) return;
  const px = -dy / segLen;
  const py = dx / segLen;
  // Splay grows from 0 at wrist to `splayMax` at the tip — strands
  // converge at the wrist and fan outward at the hand/foot end.
  const splayMax = strandThick * 1.4;
  const tipThick = strandThick * 1.15;

  for (const sign of [-1, 1]) {
    const sx = wristX + px * splayMax * 0.15 * sign;
    const sy = wristY + py * splayMax * 0.15 * sign;
    const ex = x2 + px * splayMax * sign;
    const ey = y2 + py * splayMax * sign;
    // Shadow (matches strand-shadow width — body silhouette has a
    // consistent dark border like the head's).
    ctx.strokeStyle = shadowColor;
    ctx.lineWidth = tipThick + 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Copper highlight.
    ctx.strokeStyle = copperColor;
    ctx.lineWidth = tipThick;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

// Single eye on a magnet pole. White circle stays anchored to the
// prong tip; the polarity symbol shifts inside the white toward the
// look direction (lookX, lookY = cos/sin of facing). Gives Magnek
// cursor-tracking eyes without dislodging them from the prongs.
// "+" gets cross marks, "-" gets just the horizontal bar.
function drawPoleEye(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  symbol: "+" | "-",
  lookX: number,
  lookY: number,
): void {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Symbol shifts inside the white toward the aim direction.
  // Vertical shift dampened to feel right against the iso ground plane.
  const shift = r * 0.32;
  const sx = cx + lookX * shift;
  const sy = cy + lookY * shift * 0.6;
  // Symbol bars sized so even at max shift they stay inside the white.
  const barHalf = r * 0.45;
  ctx.lineWidth = Math.max(1.6, r * 0.32);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(sx - barHalf, sy);
  ctx.lineTo(sx + barHalf, sy);
  if (symbol === "+") {
    ctx.moveTo(sx, sy - barHalf);
    ctx.lineTo(sx, sy + barHalf);
  }
  ctx.stroke();
}

export const CHARACTER_ART: Record<string, CharacterArtFn> = {
  magnek: drawMagnek,
};
