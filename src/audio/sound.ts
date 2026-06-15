// Procedural Web Audio sound effects + a heartbeat looper. No audio
// asset files — each sound is a tiny synth voice (a few oscillators with
// envelopes). Plays through a single shared master gain.
//
// iOS Safari starts the AudioContext suspended until the first user
// gesture; callers should invoke unlockAudio() from a click/tap handler
// (we wire it up at the title screen).

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

// ---- Per-sound user preferences ----
// Settings UI (in main.ts) writes here via setAudioPrefs(); playSound
// and setHeartbeat read here to gate playback and scale volume. Keep
// the surface tiny so adding a new tunable sound is one entry + a
// gate inside playSound.
export interface AudioPrefs {
  heartbeat: { enabled: boolean; volume: number }; // volume 0..1
  footsteps: { enabled: boolean; volume: number };
}
let audioPrefs: AudioPrefs = {
  heartbeat: { enabled: true, volume: 1.0 },
  footsteps: { enabled: true, volume: 1.0 },
};
export function setAudioPrefs(p: AudioPrefs): void {
  audioPrefs = p;
}
export function getAudioPrefs(): AudioPrefs {
  return audioPrefs;
}

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
  | "magnesis_travel"
  | "overdrive"
  | "glitch"
  | "slash"
  | "slime_shot"
  | "slime_trap"
  | "relocate"
  | "objective_pickup"
  | "achievement"
  | "heartbeat"
  | "footsteps"
  | "caw"
  // Brush sounds — fired by the soft-collision detector while a
  // character is in an obstacle's brush ring. Retriggered at
  // short cadence with volumeMul scaling to current depth, so the
  // ear hears it as a soft loop that gets louder on heavier
  // brush.
  | "brush_rustle"    // tree, stump (organic foliage / soft wood)
  | "brush_crunch"    // rock, caverock (stone grit)
  | "brush_clang"     // pipe (metal cylinder)
  | "brush_thud"      // crate, pallet (wood box)
  | "brush_boom"      // oildrum (hollow metal)
  | "brush_chime"     // crystal (musical sparkle)
  | "brush_growl"     // bear
  | "brush_bleat"     // deer
  | "brush_wall"      // arena fence
  | "brush_beep"      // sweeper bot (Factory Map 4)
  | "brush_buzz"      // welder bot (Factory Map 4)
  // UI sounds (crisp, short — under ~100ms — so they don't pile up).
  | "ui_click"
  | "ui_pick"
  | "ui_back"
  // Roulette/surprise: fired by the dual-pick screen's RANDOMIZE
  // button as the AI's chosen character cycles, and by the
  // SURPRISE button when it commits a hidden pick. roulette_tick
  // fires per visible tile-cycle; roulette_settle lands when the
  // wheel stops; surprise_reveal is a single ominous swell.
  | "roulette_tick"
  | "roulette_settle"
  | "surprise_reveal"
  | "ui_denied";

export function playSound(id: SoundId, opts: PlayOpts = {}): void {
  const c = ensureContext();
  if (!c || !masterGain) return;
  if (c.state === "suspended") void c.resume();
  // Per-sound user gating + volume scaling. The heartbeat looper
  // applies its prefs in setHeartbeat instead (since it owns its own
  // volume curve), but a one-shot heartbeat through this path still
  // gets gated for safety.
  if (id === "footsteps" && !audioPrefs.footsteps.enabled) return;
  if (id === "heartbeat" && !audioPrefs.heartbeat.enabled) return;
  let prefVol = 1.0;
  if (id === "footsteps") prefVol = audioPrefs.footsteps.volume;
  else if (id === "heartbeat") prefVol = audioPrefs.heartbeat.volume;
  const dist = opts.distance ?? 0;
  const vol = distanceVolume(dist) * (opts.volumeMul ?? 1) * prefVol;
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
  // Magnesis cast: short rising charge sound at the moment Magnek
  // starts the channel windup.
  magnesis: (c, dest, opts) => {
    const dop = opts.doppler ?? -1;
    if (dop >= 0) {
      envOsc(c, dest, "sine", 220, 880, 0.55, 0.32);
    } else {
      envOsc(c, dest, "sine", 880, 220, 0.55, 0.32);
    }
    envNoise(c, dest, 0.4, 0.08, 1800);
  },
  // Magnesis travel: subtle airy whoosh that runs through the ~1.4s
  // transport arc. Long low-passed noise tail + a soft rising sine
  // sweep, both at modest volume — meant to be felt, not announced.
  magnesis_travel: (c, dest) => {
    envNoise(c, dest, 1.3, 0.09, 900);
    envOsc(c, dest, "sine", 260, 520, 1.3, 0.07);
    envOsc(c, dest, "sine", 130, 260, 1.3, 0.05);
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
  // Roulette wheel detent — short crisp click that fires per visible
  // tile-cycle. Two-layered: a bright square attack for the wood-on-
  // pin click, plus a high noise spritz for the bearing zing. Short
  // enough (~40ms) that 24 ticks across the 1.8s animation read as
  // a fast-slowing flurry rather than a stutter.
  roulette_tick: (c, dest) => {
    envOsc(c, dest, "square", 2000, 1400, 0.035, 0.20);
    envNoise(c, dest, 0.030, 0.10, 4500);
  },
  // Roulette landing — small chime + low thunk when the wheel
  // stops. Triangle bell on the fundamental plus an octave
  // sparkle, anchored by a quick sub-bass strike so it feels
  // committed rather than tinkly.
  roulette_settle: (c, dest) => {
    envOsc(c, dest, "triangle", 660, 660, 0.55, 0.34);   // bell body
    envOsc(c, dest, "sine",     1320, 1320, 0.50, 0.18); // octave shimmer
    envOsc(c, dest, "sine",     220, 110, 0.30, 0.24);   // bell strike
    envNoise(c, dest, 0.05, 0.08, 1800);                 // tiny attack hiss
  },
  // Surprise reveal — slow ominous swell with a descending sawtooth
  // menace, a sub-bass drone an octave below, a high whining sine,
  // and a low-passed noise rumble. Builds a dread cue suited to
  // "the computer's pick is hidden until the round starts."
  surprise_reveal: (c, dest) => {
    envOsc(c, dest, "sawtooth", 220, 80,  1.20, 0.30);  // descending menace
    envOsc(c, dest, "sawtooth", 110, 40,  1.20, 0.22);  // sub-octave drone
    envOsc(c, dest, "sine",     440, 220, 1.00, 0.12);  // dissonant whine
    envNoise(c, dest, 1.20, 0.16, 500);                 // low rumble bed
  },
  // Footstep: short soft thud — low-frequency hit + brief filtered
  // noise for grit. Plays once per character per ~step interval; the
  // caller in main.ts handles distance attenuation via PlayOpts.
  footsteps: (c, dest) => {
    envOsc(c, dest, "sine", 130, 70, 0.07, 0.32);
    envNoise(c, dest, 0.05, 0.16, 600);
  },
  // Necro's caw — harsh raspy descending call. Real crow caws have
  // a sharp noise-burst attack plus a strongly pitched harmonic
  // tail that drops fast. Sawtooth on top of band-passed noise gets
  // the rasp; the rapid frequency drop on the saw gives it the
  // "cah" inflection. Two beats per call for a "cah-cah."
  caw: (c, dest) => {
    // First call.
    envNoise(c, dest, 0.06, 0.32, 2400, 0);    // breathy attack
    envOsc(c, dest, "sawtooth", 520, 220, 0.20, 0.32, 0);
    envOsc(c, dest, "square", 260, 110, 0.18, 0.16, 0);
    // Brief pause, then a slightly lower second call.
    envNoise(c, dest, 0.05, 0.26, 2200, 0.22);
    envOsc(c, dest, "sawtooth", 480, 200, 0.22, 0.28, 0.22);
    envOsc(c, dest, "square", 240, 100, 0.20, 0.14, 0.22);
  },
  // ---- Brush sounds ----
  // Each is short (~80-150ms) so retriggering at high cadence
  // sounds like a soft continuous loop. Callers pass volumeMul
  // tied to current brush depth (deeper = louder).
  // Tree "shush" — sibilant noise band centered in the speech
  // sibilant range, with a slower attack/decay so it reads as
  // shhhhh rather than a leafy crackle. Long enough (~0.45s)
  // to feel like a single soft exhale through the branches.
  brush_rustle: (c, dest) => {
    // Pre-filter noise to the 3-7kHz band via two layered bursts
    // — a wider envelope shaped via the existing lowpass helper.
    envNoise(c, dest, 0.45, 0.32, 6500);    // upper sibilance
    envNoise(c, dest, 0.45, 0.20, 4200);    // mid body fills it
    // Subtle low-end whisper to anchor the shush so it doesn't
    // float — barely audible but adds body.
    envNoise(c, dest, 0.40, 0.08, 900);
  },
  // Rock "thud + crunch" — two-stage: a low impact thud lands
  // first, then a gritty crunch ride trails out behind it.
  brush_crunch: (c, dest) => {
    // Thud — low sine impact at the leading edge.
    envOsc(c, dest, "sine", 110, 60, 0.10, 0.55);
    envOsc(c, dest, "triangle", 220, 100, 0.08, 0.20);
    // Crunch — low-pass gritty noise that starts a hair later
    // so the ear hears the thud first, then the grind on top.
    envNoise(c, dest, 0.16, 0.45, 1600, 0.04);
    envNoise(c, dest, 0.10, 0.28, 600, 0.06);
  },
  // Metal pipe: sharp clang with a ringing partial.
  brush_clang: (c, dest) => {
    envOsc(c, dest, "triangle", 1200, 800, 0.18, 0.30);
    envOsc(c, dest, "sine", 2400, 1600, 0.10, 0.16);
  },
  // Wooden crate thud: low square attack + a tiny noise scrape.
  brush_thud: (c, dest) => {
    envOsc(c, dest, "square", 180, 90, 0.10, 0.34);
    envNoise(c, dest, 0.06, 0.18, 1200);
  },
  // Hollow oil drum: deep boom with a slight resonant decay.
  brush_boom: (c, dest) => {
    envOsc(c, dest, "sine", 90, 50, 0.25, 0.45);
    envOsc(c, dest, "triangle", 220, 110, 0.18, 0.18);
  },
  // Crystal chime: bright bell-like sine pair.
  brush_chime: (c, dest) => {
    envOsc(c, dest, "sine", 1400, 1400, 0.20, 0.32);
    envOsc(c, dest, "sine", 2100, 2100, 0.16, 0.18, 0.02);
  },
  // Bear growl: low sawtooth with rapid modulation, plus filtered
  // noise for breath. Reads as menacing rather than cute.
  brush_growl: (c, dest) => {
    envOsc(c, dest, "sawtooth", 110, 75, 0.32, 0.40);
    envOsc(c, dest, "triangle", 55, 38, 0.30, 0.22);
    envNoise(c, dest, 0.28, 0.18, 800);
  },
  // Deer bleat: short higher-pitched call with a quick descent.
  brush_bleat: (c, dest) => {
    envOsc(c, dest, "triangle", 620, 380, 0.18, 0.34);
    envOsc(c, dest, "sine", 1240, 760, 0.14, 0.12, 0.01);
  },
  // Arena wall thud: dull low impact.
  brush_wall: (c, dest) => {
    envOsc(c, dest, "sine", 70, 45, 0.16, 0.40);
    envNoise(c, dest, 0.05, 0.14, 400);
  },
  // Sweeper bot beep: cheerful electronic chirp — two square
  // pulses ascending. The "annoyed" overlay is just retrigger
  // cadence: heavier brush = more beeps per second.
  brush_beep: (c, dest) => {
    envOsc(c, dest, "square", 880, 880, 0.06, 0.32);
    envOsc(c, dest, "square", 1320, 1320, 0.06, 0.26, 0.07);
  },
  // Welder bot buzz: industrial low-mid hum with sawtooth grit.
  brush_buzz: (c, dest) => {
    envOsc(c, dest, "sawtooth", 220, 180, 0.20, 0.30);
    envOsc(c, dest, "square", 110, 90, 0.18, 0.20);
    envNoise(c, dest, 0.12, 0.10, 1200);
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
  if (distanceToHunter == null || !audioPrefs.heartbeat.enabled) {
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
  // Scale by user volume preference so the slider takes effect on the
  // next scheduled beat without needing a restart.
  heartbeatTargetVolume = (0.1 + (0.65 - 0.1) * t) * audioPrefs.heartbeat.volume;
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
