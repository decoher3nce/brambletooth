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

// ---- Slagy ----
// Hulking slime monster, mutated by radioactive waste. Squat slug-
// like silhouette with a translucent shiny green body, scary fanged
// mouth, glowing yellow eyes that track the cursor, and stubby arms
// that swing during the walk cycle. A faint radioactive halo bleeds
// off the body's edge.
function drawSlagy(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  facing: number,
  anim: CharacterAnim,
): CharacterArtResult {
  const r = radius;

  // Squat proportions: shorter and stockier than Magnek (2.4r vs 2.8r).
  // Feet at cy; art extends upward. Body breathes idle and bobs while
  // walking — both expressed as a vertical-scale modulation that
  // anchors at the ground so feet never lift off.
  const baseH = r * 2.4;
  const walkSpeed = Math.max(0, Math.min(1, anim.walkSpeed));
  const breathe = Math.sin(anim.phase * 2.5) * 0.025;
  const walkBob = Math.sin(anim.phase * 8) * walkSpeed * 0.06;
  const scaleY = 1 + breathe + walkBob;
  const totalH = baseH * scaleY;

  const feetY = cy;
  const topY = cy - totalH;
  const headBaseY = cy - totalH * 0.5;
  const bodyMidY = (headBaseY + feetY) / 2;

  // ---- Body silhouette geometry ----
  // Single closed curve: ground → up the left side bulging at body mid
  // → in at head sides → over the head dome → mirror on the right →
  // back to ground. Built into a Path2D so we can reuse the same path
  // for fill, clip (highlight), and stroke without rebuilding.
  const headW = r * 1.7;
  const bodyMidW = r * 1.85;
  const bottomW = r * 1.5;
  const bodyPath = new Path2D();
  bodyPath.moveTo(cx - bottomW / 2, feetY);
  // Left side — bulge outward at body mid, taper in at head.
  bodyPath.quadraticCurveTo(cx - bodyMidW / 2, bodyMidY, cx - headW / 2, headBaseY);
  bodyPath.quadraticCurveTo(cx - headW / 2 + 2, topY + r * 0.18, cx, topY);
  // Right side — mirror.
  bodyPath.quadraticCurveTo(cx + headW / 2 - 2, topY + r * 0.18, cx + headW / 2, headBaseY);
  bodyPath.quadraticCurveTo(cx + bodyMidW / 2, bodyMidY, cx + bottomW / 2, feetY);
  // Bottom — slight bow downward.
  bodyPath.quadraticCurveTo(cx, feetY + 3, cx - bottomW / 2, feetY);
  bodyPath.closePath();

  ctx.save();

  // ---- Radioactive halo (outer glow) ----
  const haloR = r * 1.75;
  const halo = ctx.createRadialGradient(cx, cy - r * 0.7, r * 0.6, cx, cy - r * 0.7, haloR);
  halo.addColorStop(0, "rgba(170, 235, 110, 0)");
  halo.addColorStop(0.55, "rgba(170, 235, 110, 0.09)");
  halo.addColorStop(1, "rgba(170, 235, 110, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.7, haloR, 0, Math.PI * 2);
  ctx.fill();

  // ---- Body fill (translucent green) ----
  ctx.fillStyle = "rgba(95, 185, 107, 0.86)";
  ctx.fill(bodyPath);

  // ---- Shiny highlight (clipped to body, upper-left blob) ----
  ctx.save();
  ctx.clip(bodyPath);
  const hlCx = cx - r * 0.5;
  const hlCy = topY + r * 0.55;
  const hlR = r * 1.1;
  const hl = ctx.createRadialGradient(hlCx, hlCy, 0, hlCx, hlCy, hlR);
  hl.addColorStop(0, "rgba(225, 250, 205, 0.55)");
  hl.addColorStop(0.45, "rgba(190, 240, 175, 0.22)");
  hl.addColorStop(1, "rgba(190, 240, 175, 0)");
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(hlCx, hlCy, hlR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---- Body outline (matches the head-outline weight pattern Magnek
  // uses — visible 1-1.5px dark border around the silhouette) ----
  ctx.strokeStyle = "#1a2a15";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(bodyPath);

  // ---- Stubby arms (drawn after the body so they sit on top) ----
  // Idle: arms hang at the sides. Walking: gentle alternating swing.
  const swing = Math.sin(anim.phase * 8) * walkSpeed;
  const armCy = bodyMidY + r * 0.05;
  const armW = r * 0.5;
  const armH = r * 0.7;
  const armSwing = r * 0.18 * walkSpeed;
  drawSlagyArm(ctx, cx - bodyMidW / 2 + 2, armCy + swing * armSwing, armW, armH, -1);
  drawSlagyArm(ctx, cx + bodyMidW / 2 - 2, armCy - swing * armSwing, armW, armH, +1);

  // ---- Face: glowing yellow eyes + scary fanged mouth ----
  const faceY = topY + (headBaseY - topY) * 0.5;
  const eyeSpacing = r * 0.45;
  const eyeR = r * 0.24;
  const lookX = Math.cos(facing);
  const lookY = Math.sin(facing);
  drawSlagyEye(ctx, cx - eyeSpacing, faceY, eyeR, lookX, lookY);
  drawSlagyEye(ctx, cx + eyeSpacing, faceY, eyeR, lookX, lookY);

  const mouthCy = faceY + r * 0.62;
  const mouthW = r * 0.95;
  const mouthH = r * 0.45;
  drawSlagyMouth(ctx, cx, mouthCy, mouthW, mouthH);

  ctx.restore();

  return {
    topY: topY - 4,
    centerY: faceY,
  };
}

// Stubby arm — an oval green nub that sits against the body.
function drawSlagyArm(
  ctx: CanvasRenderingContext2D,
  attachX: number, attachY: number,
  w: number, h: number,
  dir: number, // -1 = left arm, +1 = right arm
): void {
  const tipX = attachX + dir * w * 1.1;
  const tipY = attachY + h * 0.15; // hang slightly downward
  ctx.save();
  // Outline first so the arm has the same dark border as the body.
  const armPath = new Path2D();
  // Capsule-ish shape: rounded rect via two arcs + side curves.
  const midX = (attachX + tipX) / 2;
  const midY = (attachY + tipY) / 2;
  const angle = Math.atan2(tipY - attachY, tipX - attachX);
  const len = Math.hypot(tipX - attachX, tipY - attachY);
  // Draw as a rotated ellipse.
  armPath.ellipse(midX, midY, len * 0.65, h * 0.45, angle, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(95, 185, 107, 0.86)";
  ctx.fill(armPath);
  ctx.strokeStyle = "#1a2a15";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(armPath);
  // Tiny highlight on top of arm.
  ctx.save();
  ctx.clip(armPath);
  const hl = ctx.createRadialGradient(midX - len * 0.2, midY - h * 0.2, 0, midX - len * 0.2, midY - h * 0.2, len * 0.6);
  hl.addColorStop(0, "rgba(220, 250, 200, 0.35)");
  hl.addColorStop(1, "rgba(220, 250, 200, 0)");
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(midX - len * 0.2, midY - h * 0.2, len * 0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// Glowing yellow eye that tracks aim. Pupil + iris shift inside the
// white toward the look direction.
function drawSlagyEye(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  lookX: number, lookY: number,
): void {
  // Eye white (slightly oval — taller than wide for menacing look).
  ctx.fillStyle = "#f5f5e8";
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 1.1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1a2a15";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Iris (yellow) + pupil (black). Both shift toward aim direction;
  // vertical shift dampened for iso feel.
  const shift = r * 0.35;
  const px = cx + lookX * shift;
  const py = cy + lookY * shift * 0.6;
  ctx.fillStyle = "#ffd84a";
  ctx.beginPath();
  ctx.arc(px, py, r * 0.65, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0a0a0a";
  ctx.beginPath();
  ctx.arc(px + lookX * 0.8, py + lookY * 0.4, r * 0.35, 0, Math.PI * 2);
  ctx.fill();
  // Small white highlight (specular).
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.beginPath();
  ctx.arc(px - r * 0.18, py - r * 0.22, r * 0.13, 0, Math.PI * 2);
  ctx.fill();
}

// Open mouth with jagged fangs — hunter intimidation factor.
function drawSlagyMouth(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, w: number, h: number,
): void {
  ctx.save();
  // Mouth interior — dark, slightly purple-red for menace.
  const mouthPath = new Path2D();
  mouthPath.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#2a0814";
  ctx.fill(mouthPath);
  ctx.strokeStyle = "#1a2a15";
  ctx.lineWidth = 1.4;
  ctx.stroke(mouthPath);

  // Clip teeth to the mouth shape so they don't poke past the lips.
  ctx.save();
  ctx.clip(mouthPath);

  const teethTop = 5;
  const fangColor = "#f0e8b0";
  // Top row — pointing down.
  for (let i = 0; i < teethTop; i++) {
    const fx = cx - w / 2 + (i + 0.5) * (w / teethTop);
    const fy = cy - h / 2;
    const fh = h * 0.42 + (i % 2) * h * 0.08;
    const fw = w * 0.07;
    ctx.fillStyle = fangColor;
    ctx.beginPath();
    ctx.moveTo(fx - fw, fy);
    ctx.lineTo(fx + fw, fy);
    ctx.lineTo(fx, fy + fh);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1a2a15";
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  // Bottom row — fewer, pointing up. Offset between top fangs.
  const teethBot = 4;
  for (let i = 0; i < teethBot; i++) {
    const fx = cx - w / 2 + (i + 1) * (w / (teethBot + 1));
    const fy = cy + h / 2;
    const fh = h * 0.32;
    const fw = w * 0.06;
    ctx.fillStyle = fangColor;
    ctx.beginPath();
    ctx.moveTo(fx - fw, fy);
    ctx.lineTo(fx + fw, fy);
    ctx.lineTo(fx, fy - fh);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#1a2a15";
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// ---- Necro ----
// Heraldic front-facing crow. Wings spread WIDE to both sides like
// a coat-of-arms eagle, big round head dominating the silhouette,
// large white eyes with pupils that track the aim direction. Big
// orange wedge beak in the middle of the face. Tail visible below
// the body, amber legs at the bottom.
//
// Floats slightly above the ground anchor so the airborne read is
// constant; a small translucent shadow under the anchor ties him
// back to the floor for the depth sort. Wings flap subtly when
// moving and rest spread-static when idle — body and wings are
// always symmetric (no facing-mirror) because the pose is front-on.
//
// Charge glow during the resurrect windup blooms violet around
// the whole silhouette so the cast is legible.
function drawNecro(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  facing: number,
  anim: CharacterAnim,
): CharacterArtResult {
  const r = radius;
  // Hover float — body sits this many pixels above the ground
  // anchor. A tiny bob drifts up/down so he reads as airborne.
  const hoverBase = 16;
  const hoverBob = Math.sin(anim.phase * 4) * 1.6;
  const flyY = cy - hoverBase + hoverBob;

  // ---- Ground shadow ----
  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.beginPath();
  ctx.ellipse(cx, cy - 2, r * 0.8, r * 0.30, 0, 0, Math.PI * 2);
  ctx.fill();

  const moving = anim.walkSpeed > 0.06;
  // Wings flap when moving; static spread when idle.
  const flap = moving ? Math.sin(anim.phase * 8) : 0;

  // ---- Wings (drawn first so they sit behind the body) ----
  drawHeraldicWing(ctx, cx, flyY, r, -1, flap);
  drawHeraldicWing(ctx, cx, flyY, r, +1, flap);

  // ---- Tail feather fan (drawn behind body, points down) ----
  ctx.fillStyle = "#08080c";
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.45, flyY + r * 0.6);
  ctx.lineTo(cx + r * 0.45, flyY + r * 0.6);
  ctx.lineTo(cx + r * 0.55, flyY + r * 1.25);
  ctx.lineTo(cx, flyY + r * 1.4);
  ctx.lineTo(cx - r * 0.55, flyY + r * 1.25);
  ctx.closePath();
  ctx.fill();
  // Three tail-feather divider lines for silhouette detail.
  ctx.strokeStyle = "rgba(60, 60, 70, 0.6)";
  ctx.lineWidth = 1;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(cx + i * r * 0.18, flyY + r * 0.65);
    ctx.lineTo(cx + i * r * 0.32, flyY + r * 1.30);
    ctx.stroke();
  }

  // ---- Body (rounded teardrop, front-facing) ----
  ctx.fillStyle = "#08080c";
  ctx.beginPath();
  ctx.ellipse(cx, flyY + r * 0.1, r * 0.62, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  // Breast highlight — soft vertical gradient stripe down the
  // center for that "glossy raven" feel.
  ctx.fillStyle = "rgba(110, 110, 140, 0.28)";
  ctx.beginPath();
  ctx.ellipse(cx, flyY + r * 0.0, r * 0.22, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  // ---- Legs (always visible — front-facing pose) ----
  ctx.strokeStyle = "#d8a85a"; // dull amber
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const sgn of [-1, 1]) {
    const footAnchorX = cx + sgn * r * 0.22;
    const legTopY = flyY + r * 0.85;
    const footY = cy - 2;
    ctx.beginPath();
    ctx.moveTo(footAnchorX, legTopY);
    ctx.lineTo(footAnchorX + sgn * 2, footY);
    ctx.stroke();
    // Three toes per foot — center + two splayed.
    const footX = footAnchorX + sgn * 2;
    ctx.beginPath();
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX - r * 0.18, footY + r * 0.12);
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX, footY + r * 0.14);
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX + r * 0.18, footY + r * 0.12);
    ctx.stroke();
  }

  // ---- HEAD ----
  // Oversized round head dominates the silhouette. Sits directly
  // above the body, slightly bobs with the hover for life.
  const headR = r * 0.78;
  const headY = flyY - r * 0.65;
  ctx.fillStyle = "#08080c";
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();
  // Subtle head highlight (top-left, for the standard upper-left
  // light direction the rest of the art uses).
  ctx.fillStyle = "rgba(120, 120, 150, 0.32)";
  ctx.beginPath();
  ctx.arc(cx - headR * 0.35, headY - headR * 0.4, headR * 0.32, 0, Math.PI * 2);
  ctx.fill();

  // ---- Beak (large front-facing wedge) ----
  // Diamond/triangle pointing DOWN, centered on the head's lower
  // half. Has both top and bottom mandibles for definition.
  const beakTopY = headY + headR * 0.15;
  const beakTipY = headY + headR * 0.95;
  const beakHalfW = headR * 0.30;
  ctx.fillStyle = "#ff8a3d";
  ctx.beginPath();
  ctx.moveTo(cx - beakHalfW, beakTopY);
  ctx.lineTo(cx + beakHalfW, beakTopY);
  ctx.lineTo(cx, beakTipY);
  ctx.closePath();
  ctx.fill();
  // Darker lower mandible split.
  ctx.fillStyle = "#c45f1e";
  ctx.beginPath();
  ctx.moveTo(cx - beakHalfW * 0.85, beakTopY + headR * 0.05);
  ctx.lineTo(cx + beakHalfW * 0.85, beakTopY + headR * 0.05);
  ctx.lineTo(cx, beakTipY);
  ctx.closePath();
  ctx.fill();
  // Beak center-line for the mandible split.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, beakTopY);
  ctx.lineTo(cx, beakTipY);
  ctx.stroke();

  // ---- EYES ----
  // Two large white sclera with black pupils that BOTH track aim.
  // Pupils share the same offset vector so the gaze is synchronized.
  const eyeSpacing = headR * 0.42;
  const eyeY = headY - headR * 0.15;
  const eyeR = headR * 0.28;
  const pupilMaxOffset = eyeR * 0.45;
  // Pupil offset from the facing direction. cos/sin of facing
  // already gives a unit vector; scale by max offset.
  const pupilDx = Math.cos(facing) * pupilMaxOffset;
  const pupilDy = Math.sin(facing) * pupilMaxOffset;
  for (const sgn of [-1, 1]) {
    const ex = cx + sgn * eyeSpacing;
    // Sclera (white) with a thin dark rim.
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
    ctx.stroke();
    // Pupil — black with a tiny white catchlight for a lively eye.
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(ex + pupilDx, eyeY + pupilDy, eyeR * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.beginPath();
    ctx.arc(
      ex + pupilDx - eyeR * 0.18,
      eyeY + pupilDy - eyeR * 0.18,
      eyeR * 0.12, 0, Math.PI * 2,
    );
    ctx.fill();
  }

  // ---- Charge glow (violet necromantic bloom during resurrect windup) ----
  if (anim.chargeGlow != null && anim.chargeGlow > 0) {
    const g = anim.chargeGlow;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(160, 90, 220, ${0.18 + g * 0.25})`;
    ctx.beginPath();
    ctx.arc(cx, flyY, r * (1.7 + g * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Top of art = top of head; body center for status rings = body
  // ellipse center.
  return { topY: headY - headR, centerY: flyY };
}

// One heraldic wing — extends out from the body's side at a slight
// downward angle, with a feathered trailing edge. `side` is -1 for
// the LEFT wing, +1 for the RIGHT wing. `flap` is a [-1..1] phase
// value that lifts/drops the wing tip subtly when in motion.
function drawHeraldicWing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  side: -1 | 1,
  flap: number,
): void {
  const span = r * 1.65;       // how far out the wingtip reaches
  const liftBase = -r * 0.15;  // baseline vertical at the wingtip
  const lift = liftBase + flap * 4 * side; // tiny alternating flap
  const innerX = cx + side * r * 0.45;
  const innerY = cy + r * 0.05;
  const tipX = cx + side * span;
  const tipY = cy + lift;
  const bottomX = cx + side * span * 0.55;
  const bottomY = cy + r * 0.45;

  // Wing body — a curved, feathered fan. Quad curves on both
  // edges so the shape reads as a real bird wing, not a triangle.
  ctx.fillStyle = "#08080c";
  ctx.beginPath();
  ctx.moveTo(innerX, innerY);
  ctx.quadraticCurveTo(
    cx + side * span * 0.6, cy - r * 0.15,
    tipX, tipY,
  );
  ctx.quadraticCurveTo(
    cx + side * span * 0.75, cy + r * 0.2,
    bottomX, bottomY,
  );
  ctx.quadraticCurveTo(
    cx + side * span * 0.35, cy + r * 0.55,
    cx + side * r * 0.35, cy + r * 0.5,
  );
  ctx.closePath();
  ctx.fill();

  // Primary-feather notches along the trailing edge — three small
  // ellipses for silhouette texture.
  ctx.fillStyle = "#1a1a22";
  for (let i = 0; i < 4; i++) {
    const t = 0.30 + i * 0.18;
    const fx = cx + side * span * t;
    const fy = cy + r * (0.05 + t * 0.45);
    ctx.beginPath();
    ctx.ellipse(fx, fy, r * 0.16, r * 0.07, side * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Faint inner-edge highlight where the wing meets the body.
  ctx.strokeStyle = "rgba(110, 110, 140, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(innerX, innerY);
  ctx.quadraticCurveTo(
    cx + side * span * 0.35, cy - r * 0.1,
    cx + side * span * 0.55, cy + r * 0.05,
  );
  ctx.stroke();
}

// ---- Gravemarch ----
// Stone golem hunter. Blocky body and head carved from grey rock,
// hairline blue cracks running across the surface, glowing-blue
// eye slits in an angry triangle, blue snarl mouth, blue V-chest
// glyph. Heavy mace held in one hand — grey shaft with a blue-
// spiked head. He's a little angry and a little scary by design
// — eye slits are narrow, mouth is a grimace, shoulders are
// hunched.
//
// Charging Rock Wall or Stone Step paints a blue energy glow
// through the cracks. While `shielded` is active (drawn on top
// by the renderer via a wrapped rock barrier), the cracks pulse
// brighter to signal the up state.
function drawGravemarch(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  facing: number,
  anim: CharacterAnim,
): CharacterArtResult {
  const r = radius;
  const bob = Math.sin(anim.phase * 4) * 1.4 * anim.walkSpeed;
  const baseY = cy - 2;
  const bodyTopY = cy - r * 1.85 + bob;
  const bodyBotY = cy - r * 0.35 + bob;
  // Head sits just above a short stout neck. Gap between body
  // top and head bottom is the neck band — small (0.22r) so the
  // golem reads as thick-necked, not long-necked.
  const headTopY = cy - r * 3.07 + bob;
  const headBotY = cy - r * 2.07 + bob;
  const neckTopY = headBotY;
  const neckBotY = bodyTopY;

  // Stone color palette — light to dark, used across every body
  // part so head/shoulders/arms/legs/hands/feet all share a
  // consistent rocky shading scheme.
  const STONE_LIT = "#7a828d";   // top-lit highlight
  const STONE_MID = "#6e7681";   // baseline
  const STONE_SHADOW = "#4a5058"; // bottom shadow band
  const STONE_DARK = "#3a3e44";   // deepest crevice / underside
  const OUTLINE = "#1f2228";
  const BLUE_LITE = "#5ab4ff";
  const BLUE_MID = "#3aa0ff";
  const BLUE_DARK = "#1860a0";
  const CRACK = "rgba(58, 160, 255, 0.85)";

  // Ground shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.ellipse(cx, baseY, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  // Crack helper. Originally drew a multi-segment zigzag —
  // toned down per playtest to a gentle 3-point polyline
  // (start, one mid waypoint, end) with a small perpendicular
  // bend. Reads as a fracture with one dog-leg, not a buzz-saw.
  // segments + ampMul are kept in the signature for API compat
  // with the existing call sites but effectively ignored; the
  // bend amplitude is a fixed small fraction of the length.
  const jaggedCrack = (
    sx: number, sy: number, ex: number, ey: number,
    _segments: number = 3, _ampMul: number = 0.10,
  ): void => {
    void _segments; void _ampMul;
    const dx = ex - sx;
    const dy = ey - sy;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1) return;
    const px = -dy / segLen;
    const py = dx / segLen;
    // Deterministic seed from the start point so the same crack
    // always looks the same.
    let seed = Math.floor(Math.abs(sx * 9.71 + sy * 3.13) * 1000) % 233280;
    const rand = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const amp = (0.5 + rand() * 0.5) * segLen * 0.10;
    const sign = rand() > 0.5 ? 1 : -1;
    const midX = sx + dx * 0.5 + px * amp * sign;
    const midY = sy + dy * 0.5 + py * amp * sign;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(midX, midY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  };

  const faceRight = Math.cos(facing) >= 0;
  const maceSide = faceRight ? 1 : -1;

  // ---- LEGS (drawn before body so cracks on body overlay legs at the top) ----
  // Two stubby legs with two-tone shading + cracks.
  const legW = r * 0.50;
  const legGap = r * 0.15;
  const legY = bodyBotY;
  const legH = r * 0.40;
  for (const sgn of [-1, 1]) {
    const lx = cx + sgn * (legGap + legW * 0.5) - legW * 0.5;
    // Light upper, dark lower.
    ctx.fillStyle = STONE_MID;
    ctx.fillRect(lx, legY, legW, legH * 0.55);
    ctx.fillStyle = STONE_SHADOW;
    ctx.fillRect(lx, legY + legH * 0.55, legW, legH * 0.45);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(lx, legY, legW, legH);
    // Crack on each leg.
    ctx.strokeStyle = CRACK;
    ctx.lineWidth = 1.4;
    jaggedCrack(lx + legW * 0.15, legY + legH * 0.10, lx + legW * 0.55, legY + legH * 0.85, 5, 0.18);
  }
  // ---- LUMPY FEET ----
  // Wider than the legs, irregular blob clusters with toe-bumps.
  for (const sgn of [-1, 1]) {
    const fx = cx + sgn * (legGap + legW * 0.5);
    const fy = legY + legH + r * 0.02;
    // Main foot blob.
    ctx.fillStyle = STONE_SHADOW;
    ctx.beginPath();
    ctx.ellipse(fx, fy, legW * 0.95, legH * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // Top highlight on foot (lit upper part).
    ctx.fillStyle = STONE_MID;
    ctx.beginPath();
    ctx.ellipse(fx - legW * 0.1, fy - legH * 0.1, legW * 0.75, legH * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    // Toe bumps — three small circles along the front.
    ctx.fillStyle = STONE_DARK;
    for (let i = 0; i < 3; i++) {
      const tFx = fx - legW * 0.5 + (i + 0.5) * (legW * 1.0 / 3) * (sgn > 0 ? 1 : 1);
      ctx.beginPath();
      ctx.arc(tFx, fy + legH * 0.18, legH * 0.10, 0, Math.PI * 2);
      ctx.fill();
    }
    // Crack across the foot.
    ctx.strokeStyle = CRACK;
    ctx.lineWidth = 1.3;
    jaggedCrack(fx - legW * 0.7, fy - legH * 0.08, fx + legW * 0.5, fy - legH * 0.05, 6, 0.10);
  }

  // ---- BODY block ----
  const bodyHalfW = r * 0.95;
  ctx.fillStyle = STONE_LIT;
  ctx.fillRect(cx - bodyHalfW, bodyTopY, bodyHalfW * 2, (bodyBotY - bodyTopY) * 0.45);
  ctx.fillStyle = STONE_MID;
  ctx.fillRect(cx - bodyHalfW, bodyTopY + (bodyBotY - bodyTopY) * 0.45,
    bodyHalfW * 2, (bodyBotY - bodyTopY) * 0.30);
  ctx.fillStyle = STONE_SHADOW;
  ctx.fillRect(cx - bodyHalfW, bodyTopY + (bodyBotY - bodyTopY) * 0.75,
    bodyHalfW * 2, (bodyBotY - bodyTopY) * 0.25);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(cx - bodyHalfW, bodyTopY, bodyHalfW * 2, bodyBotY - bodyTopY);

  // ---- SHOULDER rocks — three-tone shaded, irregular silhouette. ----
  // (Drawn over body to perch on the corners.)
  const drawShoulder = (sideX: number): void => {
    // Outer rough silhouette (darkest underside).
    ctx.fillStyle = STONE_SHADOW;
    ctx.beginPath();
    ctx.moveTo(sideX - r * 0.30, bodyTopY + r * 0.05);
    ctx.lineTo(sideX - r * 0.10, bodyTopY - r * 0.28);
    ctx.lineTo(sideX + r * 0.18, bodyTopY - r * 0.30);
    ctx.lineTo(sideX + r * 0.35, bodyTopY + r * 0.05);
    ctx.lineTo(sideX + r * 0.25, bodyTopY + r * 0.42);
    ctx.lineTo(sideX - r * 0.15, bodyTopY + r * 0.42);
    ctx.closePath();
    ctx.fill();
    // Mid-tone top section.
    ctx.fillStyle = STONE_MID;
    ctx.beginPath();
    ctx.moveTo(sideX - r * 0.25, bodyTopY + r * 0.0);
    ctx.lineTo(sideX - r * 0.10, bodyTopY - r * 0.25);
    ctx.lineTo(sideX + r * 0.15, bodyTopY - r * 0.28);
    ctx.lineTo(sideX + r * 0.28, bodyTopY + r * 0.0);
    ctx.lineTo(sideX + r * 0.18, bodyTopY + r * 0.20);
    ctx.lineTo(sideX - r * 0.12, bodyTopY + r * 0.20);
    ctx.closePath();
    ctx.fill();
    // Bright highlight peak.
    ctx.fillStyle = STONE_LIT;
    ctx.beginPath();
    ctx.moveTo(sideX - r * 0.05, bodyTopY - r * 0.22);
    ctx.lineTo(sideX + r * 0.08, bodyTopY - r * 0.26);
    ctx.lineTo(sideX + r * 0.12, bodyTopY - r * 0.10);
    ctx.lineTo(sideX - r * 0.02, bodyTopY - r * 0.05);
    ctx.closePath();
    ctx.fill();
    // Outline.
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sideX - r * 0.30, bodyTopY + r * 0.05);
    ctx.lineTo(sideX - r * 0.10, bodyTopY - r * 0.28);
    ctx.lineTo(sideX + r * 0.18, bodyTopY - r * 0.30);
    ctx.lineTo(sideX + r * 0.35, bodyTopY + r * 0.05);
    ctx.stroke();
    // Blue crack across the shoulder.
    ctx.strokeStyle = CRACK;
    ctx.lineWidth = 1.4;
    jaggedCrack(sideX - r * 0.18, bodyTopY - r * 0.03, sideX + r * 0.18, bodyTopY - r * 0.20, 5, 0.18);
  };
  drawShoulder(cx - bodyHalfW + r * 0.05);
  drawShoulder(cx + bodyHalfW - r * 0.05);

  // ---- ARMS — three-tone shaded. ----
  const armW = r * 0.50;
  const armH = r * 1.10;
  const leftArmX = cx - bodyHalfW - armW + 4;
  const rightArmX = cx + bodyHalfW - 4;
  const armTopY = bodyTopY + r * 0.25;
  const drawArm = (ax: number): void => {
    // Light upper, mid middle, dark lower.
    ctx.fillStyle = STONE_MID;
    ctx.fillRect(ax, armTopY, armW, armH * 0.40);
    ctx.fillStyle = STONE_SHADOW;
    ctx.fillRect(ax, armTopY + armH * 0.40, armW, armH * 0.40);
    ctx.fillStyle = STONE_DARK;
    ctx.fillRect(ax, armTopY + armH * 0.80, armW, armH * 0.20);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(ax, armTopY, armW, armH);
    // Light highlight on the lit side.
    ctx.fillStyle = "rgba(220, 225, 235, 0.18)";
    ctx.fillRect(ax + 1, armTopY + 2, armW * 0.3, armH - 4);
    // Two jagged cracks per arm.
    ctx.strokeStyle = CRACK;
    ctx.lineWidth = 1.4;
    jaggedCrack(ax + armW * 0.10, armTopY + armH * 0.18, ax + armW * 0.75, armTopY + armH * 0.55, 6, 0.16);
    jaggedCrack(ax + armW * 0.70, armTopY + armH * 0.65, ax + armW * 0.15, armTopY + armH * 0.85, 5, 0.18);
  };
  drawArm(leftArmX);
  drawArm(rightArmX);

  // ---- LUMPY HANDS — clusters of rocky blobs at the bottom of each arm. ----
  const drawHand = (handCx: number, handCy: number): void => {
    // Dark base cluster.
    ctx.fillStyle = STONE_SHADOW;
    ctx.beginPath();
    ctx.arc(handCx, handCy, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
    // Three knuckle bumps in a row.
    ctx.fillStyle = STONE_MID;
    ctx.beginPath();
    ctx.arc(handCx - r * 0.18, handCy - r * 0.04, r * 0.13, 0, Math.PI * 2);
    ctx.arc(handCx, handCy - r * 0.10, r * 0.16, 0, Math.PI * 2);
    ctx.arc(handCx + r * 0.18, handCy - r * 0.04, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
    // Bright highlight bump on top.
    ctx.fillStyle = STONE_LIT;
    ctx.beginPath();
    ctx.arc(handCx - r * 0.05, handCy - r * 0.13, r * 0.07, 0, Math.PI * 2);
    ctx.fill();
    // Outline around the cluster.
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(handCx, handCy, r * 0.30, 0, Math.PI * 2);
    ctx.stroke();
    // Jagged crack across the hand.
    ctx.strokeStyle = CRACK;
    ctx.lineWidth = 1.3;
    jaggedCrack(handCx - r * 0.22, handCy + r * 0.07, handCx + r * 0.22, handCy + r * 0.08, 6, 0.18);
  };
  const leftHandX = leftArmX + armW * 0.5;
  const leftHandY = armTopY + armH + r * 0.05;
  drawHand(leftHandX, leftHandY);
  const rightHandX = rightArmX + armW * 0.5;
  const rightHandY = armTopY + armH + r * 0.05;
  drawHand(rightHandX, rightHandY);

  // ---- MACE — emerges from the right hand, angled up and out. ----
  // Shaft starts at the hand and extends outward + upward.
  const maceTipX = rightHandX + maceSide * r * 1.20;
  const maceTipY = rightHandY - r * 1.30;
  // Shaft.
  ctx.strokeStyle = STONE_MID;
  ctx.lineWidth = r * 0.22;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(rightHandX, rightHandY - r * 0.05);
  ctx.lineTo(maceTipX, maceTipY);
  ctx.stroke();
  // Shaft outline + darker band for shading.
  ctx.strokeStyle = STONE_DARK;
  ctx.lineWidth = r * 0.08;
  ctx.beginPath();
  ctx.moveTo(rightHandX + maceSide * r * 0.05, rightHandY - r * 0.05);
  ctx.lineTo(maceTipX - maceSide * r * 0.02, maceTipY + r * 0.08);
  ctx.stroke();
  // Mace head ball.
  ctx.fillStyle = "#5a6470";
  ctx.beginPath();
  ctx.arc(maceTipX, maceTipY, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // Blue spikes radiating from the ball.
  ctx.fillStyle = BLUE_MID;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const sx0 = maceTipX + Math.cos(a) * r * 0.42;
    const sy0 = maceTipY + Math.sin(a) * r * 0.42;
    const sx1 = maceTipX + Math.cos(a) * r * 0.72;
    const sy1 = maceTipY + Math.sin(a) * r * 0.72;
    const perpX = -Math.sin(a) * r * 0.14;
    const perpY = Math.cos(a) * r * 0.14;
    ctx.beginPath();
    ctx.moveTo(sx0 + perpX, sy0 + perpY);
    ctx.lineTo(sx1, sy1);
    ctx.lineTo(sx0 - perpX, sy0 - perpY);
    ctx.closePath();
    ctx.fill();
  }
  // Bright core highlight on the ball.
  ctx.fillStyle = "rgba(110, 200, 255, 0.85)";
  ctx.beginPath();
  ctx.arc(maceTipX - r * 0.12, maceTipY - r * 0.12, r * 0.12, 0, Math.PI * 2);
  ctx.fill();

  // ---- SMALLER chest gem (compact diamond) ----
  // Per playtest the V was too big — shrunk to a small inverted
  // diamond/triangle centered on the upper-mid body.
  const chestCx = cx;
  const chestCy = bodyTopY + (bodyBotY - bodyTopY) * 0.40;
  const chestHalfW = r * 0.28;
  const chestHalfH = r * 0.30;
  ctx.fillStyle = BLUE_MID;
  ctx.beginPath();
  ctx.moveTo(chestCx, chestCy - chestHalfH);
  ctx.lineTo(chestCx + chestHalfW, chestCy);
  ctx.lineTo(chestCx, chestCy + chestHalfH);
  ctx.lineTo(chestCx - chestHalfW, chestCy);
  ctx.closePath();
  ctx.fill();
  // Shadow side.
  ctx.fillStyle = BLUE_DARK;
  ctx.beginPath();
  ctx.moveTo(chestCx, chestCy - chestHalfH);
  ctx.lineTo(chestCx + chestHalfW, chestCy);
  ctx.lineTo(chestCx, chestCy + chestHalfH);
  ctx.closePath();
  ctx.fill();
  // Bright highlight stripe.
  ctx.fillStyle = "rgba(180, 230, 255, 0.65)";
  ctx.beginPath();
  ctx.moveTo(chestCx - chestHalfW * 0.4, chestCy - chestHalfH * 0.5);
  ctx.lineTo(chestCx - 1, chestCy);
  ctx.lineTo(chestCx - chestHalfW * 0.15, chestCy + chestHalfH * 0.3);
  ctx.closePath();
  ctx.fill();
  // Outline.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(chestCx, chestCy - chestHalfH);
  ctx.lineTo(chestCx + chestHalfW, chestCy);
  ctx.lineTo(chestCx, chestCy + chestHalfH);
  ctx.lineTo(chestCx - chestHalfW, chestCy);
  ctx.closePath();
  ctx.stroke();

  // ---- Body cracks (jagged) ----
  ctx.strokeStyle = CRACK;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  // Six cracks: three diagonals across the body face, two near
  // the lower edges, one along the bottom band. Each routed
  // through jaggedCrack for a zigzag fracture read.
  jaggedCrack(cx - bodyHalfW + 3,            bodyTopY + r * 0.45, cx - bodyHalfW + r * 0.85, bodyTopY + r * 0.55, 7, 0.16);
  jaggedCrack(cx + bodyHalfW - 3,            bodyTopY + r * 0.85, cx + bodyHalfW - r * 0.6,  bodyTopY + r * 1.25, 7, 0.16);
  jaggedCrack(cx - bodyHalfW + r * 0.2,      bodyBotY - r * 0.15, cx + bodyHalfW - r * 0.2,  bodyBotY - r * 0.05, 8, 0.10);
  jaggedCrack(cx - bodyHalfW + r * 0.10,     bodyTopY + r * 0.15, cx - bodyHalfW + r * 0.20, bodyTopY + r * 0.42, 5, 0.30);
  jaggedCrack(cx + bodyHalfW - r * 0.10,     bodyTopY + r * 0.20, cx + bodyHalfW - r * 0.50, bodyTopY + r * 0.42, 6, 0.20);
  jaggedCrack(cx - r * 0.4,                  bodyTopY + r * 1.05, cx + r * 0.25,             bodyTopY + r * 1.10, 7, 0.14);

  // ---- NECK — short stout stone block between body and head. ----
  // Slightly narrower than body+head (r * 0.70) but wider than
  // the v1 neck so it reads as a thick golem column rather than
  // a slender stalk.
  const neckHalfW = r * 0.70;
  const neckH = neckBotY - neckTopY;
  ctx.fillStyle = STONE_MID;
  ctx.fillRect(cx - neckHalfW, neckTopY, neckHalfW * 2, neckH * 0.55);
  ctx.fillStyle = STONE_SHADOW;
  ctx.fillRect(cx - neckHalfW, neckTopY + neckH * 0.55, neckHalfW * 2, neckH * 0.45);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - neckHalfW, neckTopY, neckHalfW * 2, neckH);
  // Small lit highlight on the upper-left of the neck.
  ctx.fillStyle = "rgba(220, 225, 235, 0.18)";
  ctx.fillRect(cx - neckHalfW + 2, neckTopY + 2, neckHalfW * 0.55, neckH * 0.45);

  // ---- HEAD — lumpy boulder-ish silhouette, three-tone shaded. ----
  // Replaces the clean rectangle with a polygon that has small
  // rock bumps on every side so the outline reads as a chunk
  // of broken stone, not a rendered building. Three horizontal
  // bands inside the clip provide the lit / mid / shadow
  // banding without having to compose them around the lumps.
  const headHalfW = r * 0.85;
  const headH = headBotY - headTopY;
  // L = lump magnitude. Each side picks up 2-3 outward bumps
  // of this size.
  const L = r * 0.10;
  const headPath = new Path2D();
  // Walk perimeter clockwise from top-left.
  headPath.moveTo(cx - headHalfW - L * 0.3, headTopY + L * 0.4);                  // upper-left corner (rounded out)
  headPath.lineTo(cx - headHalfW * 0.65,    headTopY - L * 0.5);                  // top edge bump 1 (up)
  headPath.lineTo(cx - headHalfW * 0.25,    headTopY + L * 0.2);                  // top edge dip
  headPath.lineTo(cx + headHalfW * 0.10,    headTopY - L * 0.8);                  // top edge bump 2 (peak)
  headPath.lineTo(cx + headHalfW * 0.55,    headTopY - L * 0.1);                  // top edge bump 3
  headPath.lineTo(cx + headHalfW + L * 0.4, headTopY + L * 0.3);                  // upper-right corner
  headPath.lineTo(cx + headHalfW + L * 0.8, headTopY + headH * 0.30);             // right edge bump out
  headPath.lineTo(cx + headHalfW - L * 0.1, headTopY + headH * 0.50);             // right edge slight dip
  headPath.lineTo(cx + headHalfW + L * 0.7, headTopY + headH * 0.70);             // right edge bump out
  headPath.lineTo(cx + headHalfW + L * 0.1, headTopY + headH - L * 0.3);          // lower-right corner
  headPath.lineTo(cx + headHalfW * 0.40,    headTopY + headH + L * 0.3);          // bottom edge bump down
  headPath.lineTo(cx + headHalfW * 0.0,     headTopY + headH - L * 0.2);          // bottom edge dip
  headPath.lineTo(cx - headHalfW * 0.40,    headTopY + headH + L * 0.6);          // bottom edge bump down (chin)
  headPath.lineTo(cx - headHalfW - L * 0.1, headTopY + headH - L * 0.2);          // lower-left corner
  headPath.lineTo(cx - headHalfW - L * 0.7, headTopY + headH * 0.65);             // left edge bump out
  headPath.lineTo(cx - headHalfW + L * 0.1, headTopY + headH * 0.45);             // left edge slight dip
  headPath.lineTo(cx - headHalfW - L * 0.6, headTopY + headH * 0.25);             // left edge bump out
  headPath.closePath();
  // Fill with shadow (darkest band — anything not overdrawn
  // by the lit/mid stripes stays this color).
  ctx.fillStyle = STONE_SHADOW;
  ctx.fill(headPath);
  // Clip to the lumpy silhouette, then stripe the three bands
  // horizontally inside.
  ctx.save();
  ctx.clip(headPath);
  ctx.fillStyle = STONE_LIT;
  ctx.fillRect(cx - headHalfW - L * 2, headTopY - L * 2, headHalfW * 2 + L * 4, headH * 0.35 + L * 2);
  ctx.fillStyle = STONE_MID;
  ctx.fillRect(cx - headHalfW - L * 2, headTopY + headH * 0.35, headHalfW * 2 + L * 4, headH * 0.35);
  // Highlight stripe on the lit side.
  ctx.fillStyle = "rgba(220, 225, 235, 0.20)";
  ctx.fillRect(cx - headHalfW + 2, headTopY + 2, headHalfW * 0.4, headH - 4);
  ctx.restore();
  // Outline the lumpy silhouette.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.stroke(headPath);

  // ---- ANGRY half-circle eyes slanted DOWN toward the nose ----
  // Each eye is a downward-opening half-circle whose flat edge is
  // rotated so the OUTER corner is HIGHER than the INNER corner.
  // That's the classic angry-brow read. The fill is the dark socket
  // (blue iris), with a bright inner glow stripe.
  const eyeY = headTopY + headH * 0.40;
  const eyeOffset = headHalfW * 0.34;
  const eyeR = headHalfW * 0.24;
  const drawEye = (sideX: number, slantSign: -1 | 1): void => {
    const cxE = sideX;
    const cyE = eyeY;
    // Rotation: slantSign=-1 (left eye) tilts the diameter so the
    // RIGHT side is lower (inner closer to nose drops). slantSign=+1
    // (right eye) tilts so the LEFT side is lower. The angle is
    // negative for left, positive for right.
    // Tilt with the INNER corner (toward the nose) DROPPING and
    // the OUTER corner LIFTING — that's the cartoon angry-brow
    // read the kid asked for. slantSign=-1 is the left eye:
    // angle = +0.45 (CW) drops its right side (inner). slantSign
    // = +1 is the right eye: angle = -0.45 (CCW) drops its
    // left side (inner). Inversion of the v1 direction.
    const angle = -slantSign * 0.45; // ~26 degrees
    ctx.save();
    ctx.translate(cxE, cyE);
    ctx.rotate(angle);
    // Half-circle with the dome on the BOTTOM and the flat edge
    // on TOP. arc(0, 0, r, 0, π) sweeps through positive-y
    // (canvas down), so the closed path is the bottom half of a
    // circle — a downward dome that reads as a heavy brow above
    // a recessed pupil. Combined with the rotation it gives the
    // classic angry-V eye shape.
    ctx.fillStyle = BLUE_MID;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR, 0, Math.PI, false);
    ctx.closePath();
    ctx.fill();
    // Darker shadow inside (lower half of the dome).
    ctx.fillStyle = BLUE_DARK;
    ctx.beginPath();
    ctx.arc(0, 0, eyeR * 0.78, 0, Math.PI, false);
    ctx.closePath();
    ctx.fill();
    // Bright glow line along the flat top edge.
    ctx.fillStyle = "rgba(180, 230, 255, 0.95)";
    ctx.fillRect(-eyeR + 2, -2, (eyeR - 2) * 2, 2);
    // Small bright pupil dot below the flat edge (in the dome).
    const pupilNudge = Math.cos(facing) * 1.4 * slantSign;
    ctx.fillStyle = "#dff0ff";
    ctx.beginPath();
    ctx.arc(pupilNudge, eyeR * 0.35, eyeR * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  drawEye(cx - eyeOffset, -1);
  drawEye(cx + eyeOffset, +1);

  // ---- MONSTER zig-zag MOUTH ----
  // Closed-shape jagged maw with sawtooth top + bottom edges.
  const mouthY = headTopY + headH * 0.78;
  const mouthHalfW = headHalfW * 0.42;
  const mouthH = headH * 0.11;
  const teeth = 4;
  const stepX = (mouthHalfW * 2) / teeth;
  // Build a closed path: zigzag top + zigzag bottom.
  ctx.fillStyle = BLUE_MID;
  ctx.beginPath();
  // Top edge: start left, alternating UP (tooth tip pointing up
  // out of the mouth = teeth top edge) and DOWN.
  ctx.moveTo(cx - mouthHalfW, mouthY + mouthH * 0.5);
  for (let i = 0; i <= teeth; i++) {
    const x = cx - mouthHalfW + i * stepX;
    const y = (i % 2 === 0)
      ? mouthY + mouthH * 0.50  // valley
      : mouthY - mouthH * 0.35; // peak (tooth)
    ctx.lineTo(x, y);
  }
  // Bottom edge — zigzag in reverse so the closed shape has
  // sharp downward teeth on the bottom too.
  for (let i = teeth; i >= 0; i--) {
    const x = cx - mouthHalfW + i * stepX;
    const y = (i % 2 === 0)
      ? mouthY + mouthH * 0.50  // valley (same as top valley → bottom edge)
      : mouthY + mouthH * 1.40; // spike DOWN (lower tooth)
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Dark inner mouth (shadowy center).
  ctx.fillStyle = BLUE_DARK;
  ctx.beginPath();
  ctx.moveTo(cx - mouthHalfW * 0.65, mouthY + mouthH * 0.45);
  for (let i = 0; i <= teeth - 1; i++) {
    const t = i / (teeth - 1);
    const x = cx - mouthHalfW * 0.65 + t * mouthHalfW * 1.30;
    const y = mouthY + mouthH * (0.45 + 0.20 * Math.sin(i * Math.PI / 2));
    ctx.lineTo(x, y);
  }
  ctx.lineTo(cx + mouthHalfW * 0.65, mouthY + mouthH * 0.85);
  for (let i = teeth - 1; i >= 0; i--) {
    const t = i / (teeth - 1);
    const x = cx - mouthHalfW * 0.65 + t * mouthHalfW * 1.30;
    const y = mouthY + mouthH * (0.85 - 0.20 * Math.sin(i * Math.PI / 2));
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  // Bright glow accent along the top edge.
  ctx.strokeStyle = BLUE_LITE;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i <= teeth; i++) {
    const x = cx - mouthHalfW + i * stepX;
    const y = (i % 2 === 0)
      ? mouthY + mouthH * 0.50
      : mouthY - mouthH * 0.35;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ---- Head + neck cracks (jagged) ----
  ctx.strokeStyle = CRACK;
  ctx.lineWidth = 1.5;
  // Upper-left side, forehead diagonal.
  jaggedCrack(cx - headHalfW + 2, headTopY + r * 0.18, cx - headHalfW + r * 0.7, headTopY + r * 0.22, 6, 0.20);
  // Right cheek.
  jaggedCrack(cx + headHalfW - 2, headTopY + r * 0.50, cx + headHalfW - r * 0.6, headTopY + r * 0.55, 6, 0.20);
  // Forehead across (between the eyes, just above).
  jaggedCrack(cx - headHalfW * 0.5, headTopY + r * 0.12, cx + headHalfW * 0.4, headTopY + r * 0.10, 7, 0.18);
  // Chin (between mouth and head bottom).
  jaggedCrack(cx - headHalfW * 0.4, headTopY + headH * 0.92, cx + headHalfW * 0.45, headTopY + headH * 0.90, 6, 0.18);
  // Neck — one jagged crack across the front.
  jaggedCrack(cx - neckHalfW + 4, neckTopY + neckH * 0.4, cx + neckHalfW - 4, neckTopY + neckH * 0.55, 5, 0.20);

  // ---- Charge glow ----
  if (anim.chargeGlow != null && anim.chargeGlow > 0) {
    const g = anim.chargeGlow;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = `rgba(58, 160, 255, ${0.18 + g * 0.30})`;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 1.3, r * (1.8 + g * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return { topY: headTopY, centerY: bodyTopY + (bodyBotY - bodyTopY) * 0.5 };
}

export const CHARACTER_ART: Record<string, CharacterArtFn> = {
  magnek: drawMagnek,
  slagy: drawSlagy,
  necro: drawNecro,
  gravemarch: drawGravemarch,
};
