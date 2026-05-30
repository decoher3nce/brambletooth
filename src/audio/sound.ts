// Procedural Web Audio sound effects + a heartbeat looper. No audio
// asset files — each sound is a tiny synth voice (a few oscillators with
// envelopes). Plays through a single shared master gain.
//
// iOS Safari starts the AudioContext suspended until the first user
// gesture; callers should invoke unlockAudio() from a click/tap handler
// (we wire it up at the title screen).

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function ensureContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

// Resume the AudioContext if suspended. Call from a user-gesture handler.
export function unlockAudio(): void {
  const c = ensureContext();
  if (c && c.state === "suspended") void c.resume();
}

// Quadratic distance falloff. Returns 1.0 at distance 0, smoothly drops
// to 0 at MAX_AUDIBLE.
const MAX_AUDIBLE = 1200;
function distanceVolume(dist: number): number {
  const v = 1 - dist / MAX_AUDIBLE;
  return v > 0 ? v * v : 0;
}

export interface PlayOpts {
  distance?: number; // distance from viewer in world units (default 0)
  // Doppler hint for moving sources: -1 receding (pitch falls), +1
  // approaching (pitch rises), 0 stationary.
  doppler?: number;
  // Multiplier on the per-sound base volume.
  volumeMul?: number;
}

export type SoundId =
  | "place_plate"
  | "magnesis"
  | "overdrive"
  | "glitch"
  | "slash"
  | "slime_shot"
  | "slime_trap"
  | "relocate"
  | "objective_pickup"
  | "achievement"
  | "heartbeat"
  // UI sounds (crisp, short — under ~100ms — so they don't pile up).
  | "ui_click"
  | "ui_pick"
  | "ui_back"
  | "ui_denied";

export function playSound(id: SoundId, opts: PlayOpts = {}): void {
  const c = ensureContext();
  if (!c || !masterGain) return;
  if (c.state === "suspended") void c.resume();
  const dist = opts.distance ?? 0;
  const vol = distanceVolume(dist) * (opts.volumeMul ?? 1);
  if (vol <= 0.005) return;
  const local = c.createGain();
  local.gain.value = vol;
  local.connect(masterGain);
  const def = SOUND_DEFS[id];
  if (def) def(c, local, opts);
}

// ---- Sound definitions ----

type SoundDef = (c: AudioContext, dest: AudioNode, opts: PlayOpts) => void;

// One-shot oscillator with a frequency sweep and exponential volume decay.
function envOsc(
  c: AudioContext,
  dest: AudioNode,
  type: OscillatorType,
  f0: number,
  f1: number,
  dur: number,
  vol = 0.5,
  startOffset = 0,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  const t = c.currentTime + startOffset;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  }
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function envNoise(
  c: AudioContext,
  dest: AudioNode,
  dur: number,
  vol: number,
  lp = 4000,
  startOffset = 0,
): void {
  const buf = c.createBuffer(
    1,
    Math.max(1, Math.floor(c.sampleRate * dur)),
    c.sampleRate,
  );
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = lp;
  const g = c.createGain();
  const t = c.currentTime + startOffset;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filt).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur);
}

const SOUND_DEFS: Record<SoundId, SoundDef> = {
  // Low double-thump used by the heartbeat looper. Sub-bass fundamental
  // with a triangle overtone for body and a low-passed noise burst for
  // a wet organic thud, plus a faint breath rumble after the dub.
  // Designed to be felt more than heard — creepy in the slow form,
  // panic-inducing in the fast form.
  heartbeat: (c, dest) => {
    // Lub — primary thud.
    envOsc(c, dest, "sine", 60, 22, 0.20, 0.7);          // sub-bass body
    envOsc(c, dest, "triangle", 120, 44, 0.14, 0.24);    // overtone for definition
    envNoise(c, dest, 0.09, 0.18, 220);                  // wet thud noise
    // Dub — slightly softer, delayed second beat, slower decay.
    envOsc(c, dest, "sine", 46, 18, 0.30, 0.55, 0.17);
    envOsc(c, dest, "triangle", 92, 36, 0.22, 0.20, 0.17);
    envNoise(c, dest, 0.12, 0.13, 200, 0.17);
    // Faint breath rumble tail.
    envNoise(c, dest, 0.32, 0.07, 130, 0.30);
  },
  // Magnek dropping a plate: metallic clank that bounces.
  place_plate: (c, dest) => {
    envOsc(c, dest, "square", 520, 110, 0.22, 0.28);
    envOsc(c, dest, "sine", 110, 70, 0.3, 0.18);
  },
  // Magnesis: Doppler sweep (up if approaching, down if receding) with a
  // breath of noise for "magnetic transport" texture.
  magnesis: (c, dest, opts) => {
    const dop = opts.doppler ?? -1;
    if (dop >= 0) {
      envOsc(c, dest, "sine", 220, 880, 0.55, 0.32);
    } else {
      envOsc(c, dest, "sine", 880, 220, 0.55, 0.32);
    }
    envNoise(c, dest, 0.4, 0.08, 1800);
  },
  // Match speed boost: rising whoosh.
  overdrive: (c, dest) => {
    envNoise(c, dest, 0.4, 0.22, 6000);
    envOsc(c, dest, "sawtooth", 220, 640, 0.4, 0.14);
  },
  // Match blink: short digital glitch — four rapid square fragments at
  // randomized pitches.
  glitch: (c, dest) => {
    const t0 = c.currentTime;
    for (let i = 0; i < 4; i++) {
      const osc = c.createOscillator();
      osc.type = "square";
      const f = 440 + Math.random() * 1100;
      const t = t0 + i * 0.038;
      osc.frequency.setValueAtTime(f, t);
      const g = c.createGain();
      g.gain.setValueAtTime(0.13, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(t + 0.08);
    }
  },
  // Slagy melee swipe: tight noise burst.
  slash: (c, dest) => {
    envNoise(c, dest, 0.14, 0.45, 5500);
  },
  // Slagy slime shot: gloopy descending blip.
  slime_shot: (c, dest) => {
    envOsc(c, dest, "triangle", 260, 75, 0.32, 0.34);
  },
  // Slagy slime trap: bubbling pair of pulses.
  slime_trap: (c, dest) => {
    envOsc(c, dest, "triangle", 160, 420, 0.35, 0.24);
    envOsc(c, dest, "sine", 100, 60, 0.32, 0.18);
  },
  // Slagy relocate: dual swoosh (out + in).
  relocate: (c, dest) => {
    envOsc(c, dest, "sine", 280, 720, 0.18, 0.3);
    envOsc(c, dest, "sine", 720, 280, 0.18, 0.3, 0.05);
  },
  // Two-note major chime — bright success.
  objective_pickup: (c, dest) => {
    envOsc(c, dest, "sine", 800, 800, 0.18, 0.4);
    envOsc(c, dest, "sine", 1200, 1200, 0.3, 0.4, 0.08);
  },
  // Triumphant arpeggio for unlocks.
  achievement: (c, dest) => {
    const notes = [523, 659, 784, 1047]; // C E G C
    notes.forEach((f, i) => {
      envOsc(c, dest, "triangle", f, f, 0.45, 0.42, i * 0.08);
    });
  },
  // UI: bright primary-button click — quick rising tick.
  ui_click: (c, dest) => {
    envOsc(c, dest, "sine", 700, 900, 0.07, 0.32);
  },
  // UI: lighter pick — tile selection / row hover-pin.
  ui_pick: (c, dest) => {
    envOsc(c, dest, "sine", 1100, 1100, 0.05, 0.22);
  },
  // UI: back/cancel — short descending blip.
  ui_back: (c, dest) => {
    envOsc(c, dest, "sine", 600, 380, 0.09, 0.26);
  },
  // UI: disabled — low dull thud, no melodic content.
  ui_denied: (c, dest) => {
    envOsc(c, dest, "sawtooth", 180, 90, 0.08, 0.18);
  },
};

// ---- Heartbeat looper ----
// Adjustable BPM + base volume. Caller updates target each frame via
// setHeartbeat(distanceToHunter); null stops the loop.

let heartbeatActive = false;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTargetBpm = 50;
let heartbeatTargetVolume = 0.05;

export function setHeartbeat(distanceToHunter: number | null): void {
  if (distanceToHunter == null) {
    stopHeartbeat();
    return;
  }
  // 50 bpm at ≥800 units, 150 bpm at ≤100 units, linear between.
  const minBpm = 50;
  const maxBpm = 150;
  const farD = 800;
  const nearD = 100;
  const t = Math.max(0, Math.min(1, (farD - distanceToHunter) / (farD - nearD)));
  heartbeatTargetBpm = minBpm + (maxBpm - minBpm) * t;
  heartbeatTargetVolume = 0.1 + (0.65 - 0.1) * t;
  if (!heartbeatActive) startHeartbeat();
}

function startHeartbeat(): void {
  if (heartbeatActive) return;
  heartbeatActive = true;
  scheduleNextHeartbeat();
}

function stopHeartbeat(): void {
  heartbeatActive = false;
  if (heartbeatTimer != null) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleNextHeartbeat(): void {
  if (!heartbeatActive) return;
  const interval = 60_000 / heartbeatTargetBpm;
  heartbeatTimer = setTimeout(() => {
    if (!heartbeatActive) return;
    playSound("heartbeat", { distance: 0, volumeMul: heartbeatTargetVolume / 0.5 });
    scheduleNextHeartbeat();
  }, interval);
}
