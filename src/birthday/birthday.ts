// Birthday surprise — a rainbow herd of frogs (mostly) and other
// critters that occasionally migrates across the screen during play.
// Bumping into one gives the player +5 HP forever (no max cap, once
// per critter). The critters carry text bubbles that read "Ribbit!"
// or "Happy Birthday!" as they pass through.
//
// Activation:
//   - AUTO for profile name "MOONLLAMA" during the 7-day window
//     starting BIRTHDAY_WINDOW_START. After the window, the auto-
//     activation expires.
//   - Anyone, anytime: 5 consecutive 'h' keystrokes (no other key
//     in between) on the main page.
//   - Once activated for a profile in either path, persists across
//     sessions in localStorage so the herd keeps coming.
//
// All in screen space — critters are decorative, not real entities.
// They live in this module's array; main.ts ticks + draws them and
// dispatches bump callbacks back when a critter overlaps the
// player's projected screen position.

// Window start. The window runs for BIRTHDAY_WINDOW_DAYS after this
// date. MoonLlama is auto-activated while inside the window; after,
// the keystroke gesture takes over.
const BIRTHDAY_WINDOW_START = new Date("2026-06-19T00:00:00").getTime();
const BIRTHDAY_WINDOW_DAYS = 7;

// Profile name (case-insensitive) for the auto-activated player.
const BIRTHDAY_PROFILE_NAME = "moonllama";

// 'h' presses needed in a row to manually activate.
const HBD_KEYSTROKE_COUNT = 5;

// localStorage key — when present (any truthy value) the birthday
// surprise stays on for this profile even if the auto window has
// passed and even without re-entering the 'h' gesture.
const BIRTHDAY_ACTIVE_KEY = "brambletooth.birthdayActive";

export type CritterSpecies = "frog" | "bunny" | "duck" | "butterfly";

export interface BirthdayCritter {
  id: number;
  // Screen position (CSS pixels, relative to the canvas).
  x: number;
  y: number;
  // Horizontal velocity (px/s). Negative = moving right-to-left.
  vx: number;
  // Body radius in px.
  r: number;
  // Hue in degrees [0, 360) — rainbow palette assigned at spawn.
  hue: number;
  species: CritterSpecies;
  // Speech bubble text. ~60% "Ribbit!", ~40% "Happy Birthday!".
  bubble: string;
  // Time alive (seconds) — drives hop bobbing.
  age: number;
  // Once a critter has bumped the player, it can't bump again.
  // Prevents an infinite +5 HP stack from one slow-moving critter.
  hasBumped: boolean;
  // Internal hop animation parameters per species.
  hopPhase: number;
  hopSpeed: number;
  hopAmplitude: number;
}

export interface BirthdayBumpEvent {
  // Critter ids that bumped this tick. Caller uses this to count
  // distinct bumps for any HP / sound effect logic.
  count: number;
}

export class BirthdayState {
  active = false;
  private nextHerdAt = 0;
  private elapsed = 0;
  private critters: BirthdayCritter[] = [];
  private nextCritterId = 1;
  private hRun = 0;
  private justActivated = false;

  constructor() {
    // Restore the "already activated" flag (we persist on first
    // activation so the herd keeps coming next session).
    try {
      if (localStorage.getItem(BIRTHDAY_ACTIVE_KEY)) this.active = true;
    } catch { /* private mode */ }
  }

  // Returns true and consumes the flag if activation happened this
  // tick (so main.ts can award the badge + flash a banner exactly
  // once).
  consumeJustActivated(): boolean {
    if (!this.justActivated) return false;
    this.justActivated = false;
    return true;
  }

  // Auto-activation gate. Called once on title-screen or play-screen
  // entry. Activates when the profile is MoonLlama AND the local
  // clock falls inside the 7-day window.
  tryAutoActivate(profileName: string): void {
    if (this.active) return;
    if (profileName.trim().toLowerCase() !== BIRTHDAY_PROFILE_NAME) return;
    const now = Date.now();
    const end = BIRTHDAY_WINDOW_START + BIRTHDAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (now < BIRTHDAY_WINDOW_START || now > end) return;
    this.activate();
  }

  // Per-tick 'h' keystroke check, called from the keydown handler in
  // main.ts. Any non-'h' key resets the run. Five in a row activate.
  noteKey(k: string): void {
    if (this.active) return;
    if (k === "h") {
      this.hRun += 1;
      if (this.hRun >= HBD_KEYSTROKE_COUNT) this.activate();
    } else {
      this.hRun = 0;
    }
  }

  private activate(): void {
    this.active = true;
    this.justActivated = true;
    try { localStorage.setItem(BIRTHDAY_ACTIVE_KEY, "1"); } catch { /* ignore */ }
    // First herd lands almost immediately so the player sees the
    // surprise right after the gesture.
    this.nextHerdAt = this.elapsed + 1.0;
  }

  // Reset the screen-space herd. Call on scene transitions so an
  // in-flight herd doesn't bleed across to the title screen.
  reset(): void {
    this.critters.length = 0;
    this.elapsed = 0;
    this.nextHerdAt = 0;
  }

  // Per-frame tick. Caller passes the current viewport dimensions
  // (so spawning + culling stay framerate-independent of canvas
  // size), the player's projected screen position + radius (for
  // bump detection — pass null when no player is on screen, e.g.
  // during countdown), and a callback that fires per bumped critter.
  tick(
    dt: number,
    dims: { w: number; h: number },
    playerScreen: { x: number; y: number; r: number } | null,
    onBump: () => void,
  ): void {
    if (!this.active) return;
    this.elapsed += dt;

    // Schedule the first herd lazily after activation, or after the
    // previous herd's window closes — the random gap reads as a
    // surprise rather than a metronome.
    if (this.elapsed >= this.nextHerdAt) {
      this.spawnHerd(dims);
      // "half the time" — random gap between 15 and 40 seconds.
      this.nextHerdAt = this.elapsed + 15 + Math.random() * 25;
    }

    // Advance + cull + bump-check every critter.
    const offscreenSlack = 80;
    for (let i = this.critters.length - 1; i >= 0; i--) {
      const c = this.critters[i]!;
      c.age += dt;
      c.x += c.vx * dt;
      c.hopPhase += dt * c.hopSpeed;
      // Bump detection: simple circle-vs-circle in screen space
      // against the player's projected position. The critter's
      // hop displacement is small enough that ignoring it here
      // doesn't cause perceptible misses.
      if (!c.hasBumped && playerScreen) {
        const dx = c.x - playerScreen.x;
        const dy = c.y - playerScreen.y;
        const rsum = c.r + playerScreen.r;
        if (dx * dx + dy * dy <= rsum * rsum) {
          c.hasBumped = true;
          onBump();
        }
      }
      // Cull when fully past the opposite edge.
      const past = c.vx > 0 ? c.x > dims.w + offscreenSlack : c.x < -offscreenSlack;
      if (past) this.critters.splice(i, 1);
    }
  }

  // Spawn a single herd off one screen edge moving toward the
  // other. Mostly frogs by request — ~70% frogs, the rest split
  // across bunny / duck / butterfly so the parade has variety.
  private spawnHerd(dims: { w: number; h: number }): void {
    const fromLeft = Math.random() < 0.5;
    const count = 22 + Math.floor(Math.random() * 12); // 22..33
    for (let i = 0; i < count; i++) {
      const species = pickSpecies();
      const r = species === "butterfly" ? 9 : species === "bunny" ? 13 : 14;
      // Stagger horizontally (~50–280 px of head-start spread) so
      // the herd doesn't enter as a wall.
      const startOffset = 50 + Math.random() * 230;
      const x = fromLeft ? -r - startOffset : dims.w + r + startOffset;
      // Distribute vertically across the central band of the
      // viewport (skip the very top + bottom strips so HUD pills
      // stay readable).
      const yMin = dims.h * 0.18;
      const yMax = dims.h * 0.82;
      const y = yMin + Math.random() * (yMax - yMin);
      // Speed: 70–140 px/s, with butterflies on the fast end.
      const baseSpeed = species === "butterfly" ? 110 : 70 + Math.random() * 70;
      const vx = fromLeft ? baseSpeed : -baseSpeed;
      // Rainbow assignment — evenly distribute hues across the
      // herd plus a small jitter so adjacent critters don't share
      // exactly the same color.
      const hue = ((i / count) * 360 + Math.random() * 20) % 360;
      const bubble = Math.random() < 0.6 ? "Ribbit!" : "Happy Birthday!";
      const c: BirthdayCritter = {
        id: this.nextCritterId++,
        x,
        y,
        vx,
        r,
        hue,
        species,
        bubble,
        age: Math.random() * 2, // out-of-phase hop animation
        hasBumped: false,
        hopPhase: Math.random() * Math.PI * 2,
        hopSpeed: species === "frog" ? 8 : species === "bunny" ? 5 : species === "duck" ? 3 : 12,
        hopAmplitude: species === "frog" ? 6 : species === "bunny" ? 7 : species === "duck" ? 2 : 4,
      };
      this.critters.push(c);
    }
  }

  // Render the herd + speech bubbles on top of the game canvas.
  // Called from main.ts after the world render so critters sit
  // over arena chrome but under HUD pills.
  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.active) return;
    for (const c of this.critters) {
      const hopDy = -Math.abs(Math.sin(c.hopPhase)) * c.hopAmplitude;
      const cx = c.x;
      const cy = c.y + hopDy;
      drawCritter(ctx, cx, cy, c);
      drawBubble(ctx, cx, cy - c.r - 4, c.bubble);
    }
  }
}

function pickSpecies(): CritterSpecies {
  const roll = Math.random();
  if (roll < 0.70) return "frog";
  if (roll < 0.85) return "bunny";
  if (roll < 0.95) return "duck";
  return "butterfly";
}

// Per-species body. Saturated rainbow palette with white belly.
function drawCritter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  c: BirthdayCritter,
): void {
  const body = `hsl(${c.hue} 85% 55%)`;
  const shade = `hsl(${c.hue} 70% 38%)`;
  const belly = `hsl(${c.hue} 70% 82%)`;
  ctx.save();
  // Shadow on the "ground" plane (just a flat ellipse under the
  // critter — there's no real ground in screen space, but a soft
  // shadow sells the hop).
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.beginPath();
  ctx.ellipse(cx, c.y + c.r * 0.55, c.r * 0.9, c.r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  if (c.species === "frog") {
    // Squat body — wider than tall.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx, cy, c.r, c.r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    // Belly highlight.
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(cx, cy + c.r * 0.18, c.r * 0.55, c.r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    // Two bumpy eyes on top.
    const eyeR = c.r * 0.32;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx - c.r * 0.45, cy - c.r * 0.55, eyeR, 0, Math.PI * 2);
    ctx.arc(cx + c.r * 0.45, cy - c.r * 0.55, eyeR, 0, Math.PI * 2);
    ctx.fill();
    // Pupils.
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx - c.r * 0.45, cy - c.r * 0.55, eyeR * 0.45, 0, Math.PI * 2);
    ctx.arc(cx + c.r * 0.45, cy - c.r * 0.55, eyeR * 0.45, 0, Math.PI * 2);
    ctx.fill();
    // Mouth — a tiny smile arc.
    ctx.strokeStyle = "#221a16";
    ctx.lineWidth = Math.max(1, c.r * 0.10);
    ctx.beginPath();
    ctx.arc(cx, cy + c.r * 0.10, c.r * 0.30, 0.15, Math.PI - 0.15);
    ctx.stroke();
    // Body outline.
    ctx.strokeStyle = shade;
    ctx.lineWidth = Math.max(1, c.r * 0.12);
    ctx.beginPath();
    ctx.ellipse(cx, cy, c.r, c.r * 0.75, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (c.species === "bunny") {
    // Round body.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, c.r, 0, Math.PI * 2);
    ctx.fill();
    // Belly.
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(cx, cy + c.r * 0.25, c.r * 0.5, c.r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    // Two long ears.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx - c.r * 0.35, cy - c.r * 1.2, c.r * 0.22, c.r * 0.7, -0.18, 0, Math.PI * 2);
    ctx.ellipse(cx + c.r * 0.35, cy - c.r * 1.2, c.r * 0.22, c.r * 0.7, 0.18, 0, Math.PI * 2);
    ctx.fill();
    // Inner ear pink.
    ctx.fillStyle = "#ffc8d8";
    ctx.beginPath();
    ctx.ellipse(cx - c.r * 0.35, cy - c.r * 1.2, c.r * 0.10, c.r * 0.45, -0.18, 0, Math.PI * 2);
    ctx.ellipse(cx + c.r * 0.35, cy - c.r * 1.2, c.r * 0.10, c.r * 0.45, 0.18, 0, Math.PI * 2);
    ctx.fill();
    // Eyes.
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx - c.r * 0.30, cy - c.r * 0.15, c.r * 0.10, 0, Math.PI * 2);
    ctx.arc(cx + c.r * 0.30, cy - c.r * 0.15, c.r * 0.10, 0, Math.PI * 2);
    ctx.fill();
    // Tiny pink nose.
    ctx.fillStyle = "#ff6f9a";
    ctx.beginPath();
    ctx.arc(cx, cy + c.r * 0.05, c.r * 0.10, 0, Math.PI * 2);
    ctx.fill();
  } else if (c.species === "duck") {
    // Round body.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx, cy, c.r, c.r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    // Head.
    ctx.beginPath();
    ctx.arc(cx + c.r * 0.55, cy - c.r * 0.45, c.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    // Beak — orange triangle off the head.
    ctx.fillStyle = "#ff8a3d";
    ctx.beginPath();
    ctx.moveTo(cx + c.r * 1.05, cy - c.r * 0.50);
    ctx.lineTo(cx + c.r * 1.55, cy - c.r * 0.35);
    ctx.lineTo(cx + c.r * 1.05, cy - c.r * 0.20);
    ctx.closePath();
    ctx.fill();
    // Eye.
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx + c.r * 0.65, cy - c.r * 0.55, c.r * 0.10, 0, Math.PI * 2);
    ctx.fill();
    // Wing fold line.
    ctx.strokeStyle = shade;
    ctx.lineWidth = Math.max(1, c.r * 0.10);
    ctx.beginPath();
    ctx.moveTo(cx - c.r * 0.50, cy);
    ctx.lineTo(cx + c.r * 0.30, cy + c.r * 0.20);
    ctx.stroke();
  } else {
    // Butterfly — four hue-shifted wing lobes around a thin body.
    const wing1 = `hsl(${c.hue} 85% 60%)`;
    const wing2 = `hsl(${(c.hue + 30) % 360} 85% 60%)`;
    // Wings beat — squashed via cos(hopPhase * 3).
    const flap = 0.65 + 0.35 * Math.abs(Math.cos(c.hopPhase * 3));
    ctx.fillStyle = wing1;
    ctx.beginPath();
    ctx.ellipse(cx - c.r * 0.55, cy - c.r * 0.25, c.r * 0.9 * flap, c.r * 0.6, 0.4, 0, Math.PI * 2);
    ctx.ellipse(cx + c.r * 0.55, cy - c.r * 0.25, c.r * 0.9 * flap, c.r * 0.6, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = wing2;
    ctx.beginPath();
    ctx.ellipse(cx - c.r * 0.55, cy + c.r * 0.30, c.r * 0.7 * flap, c.r * 0.45, -0.4, 0, Math.PI * 2);
    ctx.ellipse(cx + c.r * 0.55, cy + c.r * 0.30, c.r * 0.7 * flap, c.r * 0.45, 0.4, 0, Math.PI * 2);
    ctx.fill();
    // Body — slim ellipse.
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.ellipse(cx, cy, c.r * 0.18, c.r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    // Antennae.
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(1, c.r * 0.08);
    ctx.beginPath();
    ctx.moveTo(cx - c.r * 0.05, cy - c.r * 0.65);
    ctx.lineTo(cx - c.r * 0.30, cy - c.r * 0.95);
    ctx.moveTo(cx + c.r * 0.05, cy - c.r * 0.65);
    ctx.lineTo(cx + c.r * 0.30, cy - c.r * 0.95);
    ctx.stroke();
  }
  ctx.restore();
}

// Tiny rounded speech bubble above the critter. Centered on (cx, cy).
function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
): void {
  ctx.save();
  ctx.font = "bold 11px system-ui, sans-serif";
  const padX = 6;
  const padY = 3;
  const tw = Math.ceil(ctx.measureText(text).width);
  const bw = tw + padX * 2;
  const bh = 18;
  const bx = cx - bw / 2;
  const by = cy - bh - 4;
  // Bubble background — soft white with thin border.
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  roundRect(ctx, bx, by, bw, bh, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, bw, bh, 8);
  ctx.stroke();
  // Tail — small triangle pointing down toward the critter.
  ctx.beginPath();
  ctx.moveTo(cx - 4, by + bh);
  ctx.lineTo(cx + 4, by + bh);
  ctx.lineTo(cx, by + bh + 5);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Text.
  ctx.fillStyle = "#1a1a1a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, by + bh / 2 + padY * 0.10);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
