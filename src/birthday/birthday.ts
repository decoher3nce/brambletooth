// Birthday surprise — rainbow herds of frogs (mostly) and other
// critters that wander across the arena during play. Bumping one
// gives the player +5 HP forever (no max cap, once per critter).
// Critters speak in ephemeral bubbles ("Ribbit!" / "Happy Birthday!")
// and call out with species-specific sounds so the migration feels
// alive even when the player isn't in melee range.
//
// Coordinate space:
//   - Critters and herds live in WORLD coordinates. They don't move
//     with the camera, so when the player runs, the herd doesn't
//     appear to follow — it stays where it was. Bump detection uses
//     world-space distance against the player's body. Rendering
//     projects to screen via the camera's worldToScreen.
//
// Herd behavior:
//   - Spawned in clusters of 12-22 same-species critters with one
//     wandering "target" point. Each critter is offset from the
//     target by a per-critter formation slot and steered toward
//     its slot, with light velocity smoothing. This produces a
//     cohesive flock that wanders together without all moving
//     identically.
//   - The target re-picks every 6-12s within arena bounds so the
//     herd wanders organically across the field.
//
// Activation:
//   - AUTO for profile name "MOONLLAMA" during the 7-day window
//     starting BIRTHDAY_WINDOW_START.
//   - Anyone, anytime: 5 consecutive 'h' keystrokes (no other key
//     in between).
//   - Once activated for a profile in either path, persists across
//     sessions in localStorage so the herd keeps coming.

import { playSound } from "../audio/sound";
import type { SoundId } from "../audio/sound";
import type { Vec2 } from "../core/math";

const BIRTHDAY_WINDOW_START = new Date("2026-06-19T00:00:00").getTime();
const BIRTHDAY_WINDOW_DAYS = 7;
const BIRTHDAY_PROFILE_NAME = "moonllama";
const HBD_KEYSTROKE_COUNT = 5;
const BIRTHDAY_ACTIVE_KEY = "brambletooth.birthdayActive";

export type CritterSpecies = "frog" | "bunny" | "duck" | "butterfly";

interface ArenaBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Herd {
  id: number;
  species: CritterSpecies;
  // World-space wander target the cluster steers toward. Re-picked
  // every retarget interval. Members aim for target + their own
  // formation offset so the cluster moves together without
  // collapsing onto one point.
  target: Vec2;
  retargetAt: number;   // mode elapsed time at which to pick again
  endAt: number;        // mode elapsed time at which to despawn
}

export interface BirthdayCritter {
  id: number;
  herdId: number;
  species: CritterSpecies;
  // World-space position + velocity (px in world units).
  pos: Vec2;
  vel: Vec2;
  // Per-critter offset from the herd's target — gives each member
  // a stable "spot" in the formation so they hold a loose cluster
  // shape as the target moves. Re-rolled on every retarget so the
  // herd doesn't read as a rigid lattice.
  formationOffset: Vec2;
  // Per-critter speed cap, ~70-130 px/s. Variation keeps the herd
  // from snapping like a single object.
  maxSpeed: number;
  // Render-only — hop animation phase + amplitude per species.
  hopPhase: number;
  hopSpeed: number;
  hopAmplitude: number;
  // Render-only — body radius in world units. Bump uses bumpRadius
  // (slightly larger, so the player gets a generous hit window).
  bodyRadius: number;
  bumpRadius: number;
  // Rainbow hue (degrees, 0..360).
  hue: number;
  // Speech bubble — ephemeral. When text is null, no bubble shows.
  // openAt / closeAt drive a tiny fade-in/out animation.
  bubble: { text: string; openAt: number; closeAt: number } | null;
  nextSpeechAt: number;
  // Sound timing — re-rolled per critter so the chorus doesn't
  // strobe-fire on the same frame.
  nextSoundAt: number;
  // One-shot bump flag — keeps repeat bumps from one slow critter
  // from stacking +5 HP each frame.
  hasBumped: boolean;
}

const HERD_RETARGET_MIN = 6;   // seconds
const HERD_RETARGET_MAX = 12;
const HERD_LIFETIME_MIN = 60;  // seconds — how long a herd wanders before dropping off
const HERD_LIFETIME_MAX = 110;
const HERD_FORMATION_RADIUS = 90; // world-px spread of formation slots
// Padding inside the arena bounds — herds keep this far from the
// fence so a wandering critter doesn't sit on the wall.
const ARENA_PADDING = 80;
// Between-herd-spawn cadence (random in this range each time).
const HERD_GAP_MIN = 12;
const HERD_GAP_MAX = 32;

export class BirthdayState {
  active = false;
  private nextHerdAt = 0;
  private elapsed = 0;
  private herds: Herd[] = [];
  private critters: BirthdayCritter[] = [];
  private nextCritterId = 1;
  private nextHerdId = 1;
  private hRun = 0;
  private justActivated = false;

  constructor() {
    try {
      if (localStorage.getItem(BIRTHDAY_ACTIVE_KEY)) this.active = true;
    } catch { /* private mode */ }
  }

  consumeJustActivated(): boolean {
    if (!this.justActivated) return false;
    this.justActivated = false;
    return true;
  }

  tryAutoActivate(profileName: string): void {
    if (this.active) return;
    if (profileName.trim().toLowerCase() !== BIRTHDAY_PROFILE_NAME) return;
    const now = Date.now();
    const end = BIRTHDAY_WINDOW_START + BIRTHDAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (now < BIRTHDAY_WINDOW_START || now > end) return;
    this.activate();
  }

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
    this.nextHerdAt = this.elapsed + 1.0;
  }

  reset(): void {
    this.herds.length = 0;
    this.critters.length = 0;
    this.elapsed = 0;
    this.nextHerdAt = 0;
  }

  // Returns the critters' visible state for the renderer. Kept
  // narrow on purpose so a caller that wants to read them (test
  // harness, screenshot helper) doesn't get the internal herd
  // bookkeeping leaked out with them.
  getCritters(): readonly BirthdayCritter[] {
    return this.critters;
  }

  // Per-frame tick.
  //   dt              — seconds since last frame
  //   bounds          — current arena bounds (clamps wander targets
  //                     and spawn positions so critters stay on the
  //                     playing field)
  //   playerWorldPos  — pass the local player's world pos for
  //                     bump detection + sound attenuation, or null
  //                     when no player (countdown, dead, exited).
  //   playerRadius    — player body radius for the bump circle test
  //   onBump          — called once per distinct critter bump
  tick(
    dt: number,
    bounds: ArenaBounds,
    playerWorldPos: Vec2 | null,
    playerRadius: number,
    onBump: () => void,
  ): void {
    if (!this.active) return;
    this.elapsed += dt;

    // Schedule + spawn herds.
    if (this.elapsed >= this.nextHerdAt) {
      this.spawnHerd(bounds);
      this.nextHerdAt = this.elapsed + HERD_GAP_MIN + Math.random() * (HERD_GAP_MAX - HERD_GAP_MIN);
    }

    // Advance herds (retarget + expire).
    for (let i = this.herds.length - 1; i >= 0; i--) {
      const h = this.herds[i]!;
      if (this.elapsed >= h.retargetAt) {
        h.target = pickHerdTarget(bounds);
        h.retargetAt = this.elapsed + HERD_RETARGET_MIN + Math.random() * (HERD_RETARGET_MAX - HERD_RETARGET_MIN);
        // Re-roll member formation offsets so the cluster reshapes
        // — a static lattice would feel mechanical.
        for (const c of this.critters) {
          if (c.herdId === h.id) c.formationOffset = randomFormationOffset();
        }
      }
      // Expire — but actually keep them in the field; we let them
      // wander forever once spawned, and just remove the herd record
      // (members keep going under their last target until they
      // walk through it). Simpler than easing them off.
      if (this.elapsed >= h.endAt) this.herds.splice(i, 1);
    }

    // Advance critters.
    const margin = ARENA_PADDING * 0.6;
    for (const c of this.critters) {
      // Steer toward (herd target + formation offset). If the herd
      // record was removed (after endAt), the critter just keeps
      // its last desired direction by reading the last known
      // formationOffset against a "drift" target — the existing
      // critter pos + a tiny push (a no-op direction).
      const herd = this.herds.find((h) => h.id === c.herdId);
      const desiredX = herd ? herd.target.x + c.formationOffset.x : c.pos.x + c.vel.x;
      const desiredY = herd ? herd.target.y + c.formationOffset.y : c.pos.y + c.vel.y;
      const dx = desiredX - c.pos.x;
      const dy = desiredY - c.pos.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const wantSpeed = Math.min(c.maxSpeed, d * 1.6);
      const wantVx = (dx / d) * wantSpeed;
      const wantVy = (dy / d) * wantSpeed;
      // Smooth toward want-velocity. Linear blend works fine for
      // a decorative parade; no need for proper time-stable
      // exponential smoothing here.
      const blend = Math.min(1, dt * 2.0);
      c.vel.x += (wantVx - c.vel.x) * blend;
      c.vel.y += (wantVy - c.vel.y) * blend;
      c.pos.x += c.vel.x * dt;
      c.pos.y += c.vel.y * dt;
      // Clamp inside arena bounds so they stay on the playing
      // field. Reflect velocity at the edge so they bounce inward
      // rather than grinding the wall.
      if (c.pos.x < bounds.minX + margin) { c.pos.x = bounds.minX + margin; c.vel.x = Math.abs(c.vel.x); }
      if (c.pos.x > bounds.maxX - margin) { c.pos.x = bounds.maxX - margin; c.vel.x = -Math.abs(c.vel.x); }
      if (c.pos.y < bounds.minY + margin) { c.pos.y = bounds.minY + margin; c.vel.y = Math.abs(c.vel.y); }
      if (c.pos.y > bounds.maxY - margin) { c.pos.y = bounds.maxY - margin; c.vel.y = -Math.abs(c.vel.y); }
      // Hop phase advances with movement so static critters don't
      // bob (looks less alive but reads as "they paused").
      const speed = Math.sqrt(c.vel.x * c.vel.x + c.vel.y * c.vel.y);
      c.hopPhase += dt * c.hopSpeed * (0.5 + Math.min(1, speed / 100));

      // Bump check — circle-vs-circle in world space. One-shot per
      // critter. Heals 5 HP / +5 max for free.
      if (!c.hasBumped && playerWorldPos) {
        const bdx = c.pos.x - playerWorldPos.x;
        const bdy = c.pos.y - playerWorldPos.y;
        const rsum = c.bumpRadius + playerRadius;
        if (bdx * bdx + bdy * bdy <= rsum * rsum) {
          c.hasBumped = true;
          onBump();
        }
      }

      // Speech bubble lifecycle.
      if (c.bubble && this.elapsed >= c.bubble.closeAt) {
        c.bubble = null;
        // After a speech closes, schedule the next attempt 4-12s
        // out so two consecutive speeches don't feel chatty.
        c.nextSpeechAt = this.elapsed + 4 + Math.random() * 8;
      } else if (!c.bubble && this.elapsed >= c.nextSpeechAt) {
        // ~70% chance to actually open a bubble when the timer
        // fires (otherwise re-delay) — keeps the herd's chatter
        // sparse rather than synchronized.
        if (Math.random() < 0.70) {
          const text = Math.random() < 0.55 ? "Ribbit!" : "Happy Birthday!";
          c.bubble = {
            text,
            openAt: this.elapsed,
            closeAt: this.elapsed + 1.8 + Math.random() * 1.8,
          };
        } else {
          c.nextSpeechAt = this.elapsed + 2 + Math.random() * 6;
        }
      }

      // Sound cadence — independent of the speech bubble so the
      // ambient cacophony reads as constant background rather than
      // sync'd to visible bubbles. Distance-attenuated against the
      // player so distant herds become a soft murmur.
      if (this.elapsed >= c.nextSoundAt) {
        if (playerWorldPos) {
          const ddx = c.pos.x - playerWorldPos.x;
          const ddy = c.pos.y - playerWorldPos.y;
          const distance = Math.sqrt(ddx * ddx + ddy * ddy);
          const sid = soundForSpecies(c.species);
          if (sid) {
            // Quiet the herd a touch so 20 critters don't blow
            // the player's ears off. PlayOpts distance handles
            // falloff via the engine's distanceVolume curve.
            playSound(sid, { distance, volumeMul: 0.18 });
          }
        }
        c.nextSoundAt = this.elapsed + soundIntervalForSpecies(c.species);
      }
    }
  }

  // Render the herd in world-space, projecting through the supplied
  // worldToScreen function. Caller binds that function with the
  // active camera + viewport dimensions so birthday.ts doesn't
  // depend on renderer internals.
  draw(
    ctx: CanvasRenderingContext2D,
    worldToScreen: (p: Vec2) => Vec2,
  ): void {
    if (!this.active) return;
    // Depth-sort by y so a frog in front of a bunny actually paints
    // in front. The whole herd is on the same iso plane so y
    // ordering is the right tiebreaker.
    const ordered = [...this.critters].sort((a, b) => a.pos.y - b.pos.y);
    for (const c of ordered) {
      const screen = worldToScreen(c.pos);
      const hopDy = -Math.abs(Math.sin(c.hopPhase)) * c.hopAmplitude;
      drawCritter(ctx, screen.x, screen.y + hopDy, screen.y, c);
      if (c.bubble) {
        const t = (this.elapsed - c.bubble.openAt) / (c.bubble.closeAt - c.bubble.openAt);
        const alpha = bubbleAlpha(t);
        if (alpha > 0.02) {
          drawBubble(ctx, screen.x, screen.y + hopDy - c.bodyRadius - 6, c.bubble.text, alpha);
        }
      }
    }
  }

  // Spawn one herd. ~85% chance the herd is a single species so
  // the visual + audio chorus reads as "a frog migration" or
  // "a duck migration" rather than mixed noise. The remaining 15%
  // mixes species for variety.
  private spawnHerd(bounds: ArenaBounds): void {
    const dominantSpecies = pickDominantSpecies();
    const mixed = Math.random() < 0.15;
    const target = pickHerdTarget(bounds);
    const count = 12 + Math.floor(Math.random() * 11); // 12..22
    const herd: Herd = {
      id: this.nextHerdId++,
      species: dominantSpecies,
      target,
      retargetAt: this.elapsed + HERD_RETARGET_MIN + Math.random() * (HERD_RETARGET_MAX - HERD_RETARGET_MIN),
      endAt: this.elapsed + HERD_LIFETIME_MIN + Math.random() * (HERD_LIFETIME_MAX - HERD_LIFETIME_MIN),
    };
    this.herds.push(herd);
    // Spawn members near (target + formation offset) so they
    // appear already in formation rather than racing in from one
    // point.
    for (let i = 0; i < count; i++) {
      const species = mixed && Math.random() < 0.30
        ? pickDominantSpecies()
        : dominantSpecies;
      const formationOffset = randomFormationOffset();
      const hue = ((i / count) * 360 + Math.random() * 20) % 360;
      const bodyRadius = species === "butterfly" ? 9 : species === "bunny" ? 13 : 14;
      const c: BirthdayCritter = {
        id: this.nextCritterId++,
        herdId: herd.id,
        species,
        pos: {
          x: target.x + formationOffset.x + (Math.random() - 0.5) * 30,
          y: target.y + formationOffset.y + (Math.random() - 0.5) * 30,
        },
        vel: { x: 0, y: 0 },
        formationOffset,
        maxSpeed: species === "butterfly" ? 100 + Math.random() * 40 : 70 + Math.random() * 50,
        hopPhase: Math.random() * Math.PI * 2,
        hopSpeed: species === "frog" ? 8 : species === "bunny" ? 5 : species === "duck" ? 3 : 12,
        hopAmplitude: species === "frog" ? 6 : species === "bunny" ? 7 : species === "duck" ? 2 : 4,
        bodyRadius,
        bumpRadius: bodyRadius + 8,
        hue,
        bubble: null,
        nextSpeechAt: this.elapsed + Math.random() * 8,
        nextSoundAt: this.elapsed + 0.5 + Math.random() * soundIntervalForSpecies(species),
        hasBumped: false,
      };
      // Clamp inside arena bounds at spawn — a herd target near the
      // edge could otherwise spawn members outside the field.
      const m = ARENA_PADDING * 0.6;
      c.pos.x = Math.max(bounds.minX + m, Math.min(bounds.maxX - m, c.pos.x));
      c.pos.y = Math.max(bounds.minY + m, Math.min(bounds.maxY - m, c.pos.y));
      this.critters.push(c);
    }
  }
}

function pickDominantSpecies(): CritterSpecies {
  // Frog-heavy by user request.
  const roll = Math.random();
  if (roll < 0.65) return "frog";
  if (roll < 0.82) return "bunny";
  if (roll < 0.94) return "duck";
  return "butterfly";
}

function randomFormationOffset(): Vec2 {
  // Uniform sample in a disk of radius HERD_FORMATION_RADIUS so the
  // cluster is roughly circular, not square.
  const r = HERD_FORMATION_RADIUS * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function pickHerdTarget(bounds: ArenaBounds): Vec2 {
  const minX = bounds.minX + ARENA_PADDING;
  const maxX = bounds.maxX - ARENA_PADDING;
  const minY = bounds.minY + ARENA_PADDING;
  const maxY = bounds.maxY - ARENA_PADDING;
  return {
    x: minX + Math.random() * (maxX - minX),
    y: minY + Math.random() * (maxY - minY),
  };
}

function soundForSpecies(species: CritterSpecies): SoundId | null {
  switch (species) {
    case "frog":      return "frog_ribbit";
    case "duck":      return "duck_quack";
    case "bunny":     return "bunny_squeak";
    case "butterfly": return null; // butterflies are silent
  }
}

// Average seconds between sound calls per critter. Frogs are
// chatty (they really should sound like a pond), ducks are a touch
// less frequent, bunnies sparse so their squeaks don't blanket the
// soundscape.
function soundIntervalForSpecies(species: CritterSpecies): number {
  const base = species === "frog" ? 2.5 : species === "duck" ? 3.5 : species === "bunny" ? 6 : 99;
  return base + Math.random() * base * 0.6;
}

// Bubble fade-in/out shape. Pops up fast, holds, fades out.
function bubbleAlpha(t: number): number {
  if (t < 0) return 0;
  if (t < 0.12) return t / 0.12;
  if (t > 0.86) return Math.max(0, 1 - (t - 0.86) / 0.14);
  return 1;
}

// Critter render — same body designs as before, just keyed off
// world-projected screen position. groundY = the critter's iso
// y at the FEET so the shadow ellipse sits flat against the
// "ground" plane below the hopping body.
function drawCritter(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  groundY: number,
  c: BirthdayCritter,
): void {
  const body = `hsl(${c.hue} 85% 55%)`;
  const shade = `hsl(${c.hue} 70% 38%)`;
  const belly = `hsl(${c.hue} 70% 82%)`;
  const r = c.bodyRadius;
  ctx.save();
  // Shadow at ground level (not bobbed) — flat ellipse.
  ctx.fillStyle = "rgba(0, 0, 0, 0.20)";
  ctx.beginPath();
  ctx.ellipse(cx, groundY + r * 0.45, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  if (c.species === "frog") {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.18, r * 0.55, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    const eyeR = r * 0.32;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx - r * 0.45, cy - r * 0.55, eyeR, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.45, cy - r * 0.55, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx - r * 0.45, cy - r * 0.55, eyeR * 0.45, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.45, cy - r * 0.55, eyeR * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#221a16";
    ctx.lineWidth = Math.max(1, r * 0.10);
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.10, r * 0.30, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.strokeStyle = shade;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.75, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (c.species === "bunny") {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = belly;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 0.25, r * 0.5, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 1.2, r * 0.22, r * 0.7, -0.18, 0, Math.PI * 2);
    ctx.ellipse(cx + r * 0.35, cy - r * 1.2, r * 0.22, r * 0.7, 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffc8d8";
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - r * 1.2, r * 0.10, r * 0.45, -0.18, 0, Math.PI * 2);
    ctx.ellipse(cx + r * 0.35, cy - r * 1.2, r * 0.10, r * 0.45, 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx - r * 0.30, cy - r * 0.15, r * 0.10, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.30, cy - r * 0.15, r * 0.10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff6f9a";
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.05, r * 0.10, 0, Math.PI * 2);
    ctx.fill();
  } else if (c.species === "duck") {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    // Face the direction of travel — flip the head for left-moving
    // critters so the beak leads.
    const facingLeft = c.vel.x < 0;
    const fx = facingLeft ? -1 : 1;
    ctx.beginPath();
    ctx.arc(cx + fx * r * 0.55, cy - r * 0.45, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff8a3d";
    ctx.beginPath();
    ctx.moveTo(cx + fx * r * 1.05, cy - r * 0.50);
    ctx.lineTo(cx + fx * r * 1.55, cy - r * 0.35);
    ctx.lineTo(cx + fx * r * 1.05, cy - r * 0.20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#0a0a0a";
    ctx.beginPath();
    ctx.arc(cx + fx * r * 0.65, cy - r * 0.55, r * 0.10, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = shade;
    ctx.lineWidth = Math.max(1, r * 0.10);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.50, cy);
    ctx.lineTo(cx + r * 0.30, cy + r * 0.20);
    ctx.stroke();
  } else {
    const wing1 = `hsl(${c.hue} 85% 60%)`;
    const wing2 = `hsl(${(c.hue + 30) % 360} 85% 60%)`;
    const flap = 0.65 + 0.35 * Math.abs(Math.cos(c.hopPhase * 3));
    ctx.fillStyle = wing1;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.55, cy - r * 0.25, r * 0.9 * flap, r * 0.6, 0.4, 0, Math.PI * 2);
    ctx.ellipse(cx + r * 0.55, cy - r * 0.25, r * 0.9 * flap, r * 0.6, -0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = wing2;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.55, cy + r * 0.30, r * 0.7 * flap, r * 0.45, -0.4, 0, Math.PI * 2);
    ctx.ellipse(cx + r * 0.55, cy + r * 0.30, r * 0.7 * flap, r * 0.45, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.18, r * 0.7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.05, cy - r * 0.65);
    ctx.lineTo(cx - r * 0.30, cy - r * 0.95);
    ctx.moveTo(cx + r * 0.05, cy - r * 0.65);
    ctx.lineTo(cx + r * 0.30, cy - r * 0.95);
    ctx.stroke();
  }
  ctx.restore();
}

// Speech bubble — tiny rounded rect with a downward tail. alpha
// fades both the body and the border together so the pop in/out
// reads cleanly.
function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = "bold 11px system-ui, sans-serif";
  const padX = 6;
  const padY = 3;
  const tw = Math.ceil(ctx.measureText(text).width);
  const bw = tw + padX * 2;
  const bh = 18;
  const bx = cx - bw / 2;
  const by = cy - bh - 4;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  roundRect(ctx, bx, by, bw, bh, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, bw, bh, 8);
  ctx.stroke();
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
