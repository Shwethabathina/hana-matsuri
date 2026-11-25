import { audioCore } from './audio.js';

// Background music: an original, procedurally performed score (no audio files, no licensing issues).
// Instruments are synthesised in WebAudio: a Karplus-Strong koto, a breathy shakuhachi-like flute with
// a "meri" pitch bend and vibrato, a soft pad, light taiko and suzu bells, all through a generated
// reverb. The piece is in the yo pentatonic scale (D E G A B), 32 bars at 76 BPM (~100 s), and loops
// seamlessly because the sequencer simply keeps counting eighth notes.
//
// Moods (cross-faded): festival (default), town (a little softer), haunted (music fades out; a quiet
// night-wind bed plays under the Test of Courage score), finale (fuller: more drums, flute doubled).
// The user volume (default 18 %) and mute are remembered on this device. Ducking lowers the music during
// dialogue / panels and mini-games (silent during the taiko rhythm game).

const BPM = 76;
const EIGHTH = 60 / BPM / 2;
const BASE = 293.66; // D4
const SEMIS = [0, 2, 5, 7, 9]; // yo scale: D E G A B
const freqOf = (n) => {
  const oct = Math.floor(n / 5);
  const d = ((n % 5) + 5) % 5;
  return BASE * Math.pow(2, (SEMIS[d] + 12 * oct) / 12);
};

// Bass root per bar (scale index; 0 = D4, -5 = D3). Sections: intro A (koto only) | A (flute) | B | A'.
const A_BASS = [0, 0, 2, 0, 0, 3, 2, 0];
const B_BASS = [-1, -1, 2, 3, -1, 2, 3, 0];
const BASS = [...A_BASS, ...A_BASS, ...B_BASS, ...A_BASS];
// Flute phrases: [scale index | null (rest), beats]; each section is 32 beats.
const MEL_A = [[5, 2], [6, 1], [7, 1], [6, 2], [5, 2], [4, 3], [2, 1], [3, 4], [5, 2], [7, 1], [8, 1], [7, 2], [6, 1], [5, 1], [4, 2], [3, 1], [2, 1], [0, 4]];
const MEL_B = [[7, 3], [8, 1], [9, 2], [8, 2], [7, 2], [6, 2], [5, 4], [6, 2], [7, 1], [6, 1], [5, 2], [4, 2], [3, 2], [4, 1], [5, 1], [5, 4]];
const MEL_A2 = [[null, 2], [5, 1], [6, 1], [7, 2], [5, 2], [4, 2], [3, 1], [2, 1], [3, 4], [5, 2], [7, 1], [8, 1], [7, 2], [6, 1], [5, 1], [4, 2], [2, 2], [0, 4]];
// Koto arpeggio patterns: offsets above the bar's root (null = rest), one per eighth note.
const PAT = [
  [0, null, 2, 4, 5, null, 4, 2],
  [0, 2, 4, null, 5, 4, 2, null],
  [5, null, 4, 2, 4, null, 2, 0],
];
const BARS = BASS.length;
const STEPS = BARS * 8;

// Melody events keyed by eighth-note step: [n, durationSeconds]
const FLUTE = new Map();
{
  const put = (mel, bar0) => {
    let step = bar0 * 8;
    for (const [n, beats] of mel) {
      if (n !== null) FLUTE.set(step, [n, beats * 2 * EIGHTH]);
      step += beats * 2;
    }
  };
  put(MEL_A, 8);
  put(MEL_B, 16);
  put(MEL_A2, 24);
}

const MOODS = { festival: 1, town: 0.8, haunted: 0, finale: 1.15, menu: 0.9, silent: 0 };

let M = null; // engine state once audio is running
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
const settings = {
  volume: Math.min(1, Math.max(0, parseFloat(store.get('hm-music-vol', '0.18')) || 0)),
  muted: store.get('hm-music-mute', '0') === '1',
};
const listeners = new Set();
const notify = () => listeners.forEach((f) => f(settings));

export const music = {
  get volume() {
    return settings.volume;
  },
  get muted() {
    return settings.muted;
  },
  get mood() {
    return M?.mood ?? null;
  },
  get running() {
    return !!M;
  },
  onChange(f) {
    listeners.add(f);
    f(settings);
  },
  setVolume(v) {
    settings.volume = Math.min(1, Math.max(0, v));
    if (settings.volume > 0 && settings.muted) settings.muted = false;
    store.set('hm-music-vol', String(settings.volume));
    store.set('hm-music-mute', settings.muted ? '1' : '0');
    applyGain(0.15);
    notify();
  },
  toggleMute() {
    settings.muted = !settings.muted;
    store.set('hm-music-mute', settings.muted ? '1' : '0');
    applyGain(0.3);
    notify();
  },
  // Start the engine (call after a user gesture has created/resumed the audio context).
  start() {
    if (M) return;
    const core = audioCore();
    if (!core) return;
    build(core);
  },
  // mood: 'festival' | 'town' | 'haunted' | 'finale' | 'menu' | 'silent'; duck: 0..1 multiplier
  set(mood, duck = 1) {
    if (!M) return;
    if (mood !== M.mood || Math.abs(duck - M.duck) > 0.01) {
      const prevMood = M.mood;
      M.mood = mood;
      M.duck = duck;
      // Slow cross-fades between areas; quicker ducking for dialogue.
      applyGain(mood !== prevMood ? 1.4 : 0.35);
      const t = M.ctx.currentTime;
      M.wind.gain.setTargetAtTime(mood === 'haunted' ? 0.05 : 0, t, 1.5);
    }
  },
  debug() {
    if (!M) return null;
    const buf = new Float32Array(M.an.fftSize);
    M.an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const r = (x) => Math.round(x * 10000) / 10000;
    return { mood: M.mood, duck: M.duck, step: M.step, loops: M.loops, gain: r(M.out.gain.value), target: r(targetGain()), rms: r(Math.sqrt(sum / buf.length)), volume: settings.volume, muted: settings.muted, ctx: M.ctx.state };
  },
};

function targetGain() {
  if (!M) return 0;
  if (settings.muted) return 0;
  // Perceptual curve: slider 0..1 -> gain (18 % slider ≈ gentle background level).
  return Math.pow(settings.volume, 1.5) * 2.2 * (MOODS[M.mood] ?? 1) * M.duck;
}

function applyGain(tc) {
  if (!M) return;
  M.out.gain.setTargetAtTime(targetGain(), M.ctx.currentTime, tc);
}

function impulse(ctx, seconds = 2.8) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  return buf;
}

function build({ ctx, master, noiseBuf }) {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(master);
  const dry = ctx.createGain();
  dry.gain.value = 0.8;
  dry.connect(out);
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.42;
  verb.connect(wet);
  wet.connect(out);
  const bus = ctx.createGain(); // instruments -> dry + reverb send
  bus.connect(dry);
  bus.connect(verb);
  // Haunted-forest bed: slow, low wind (independent of the score, faded in only for 'haunted').
  const wind = ctx.createGain();
  wind.gain.value = 0;
  const ws = ctx.createBufferSource();
  ws.buffer = noiseBuf;
  ws.loop = true;
  const wf = ctx.createBiquadFilter();
  wf.type = 'lowpass';
  wf.frequency.value = 420;
  const wl = ctx.createOscillator();
  wl.frequency.value = 0.09;
  const wlg = ctx.createGain();
  wlg.gain.value = 220;
  wl.connect(wlg);
  wlg.connect(wf.frequency);
  ws.connect(wf);
  wf.connect(wind);
  wind.connect(master);
  ws.start();
  wl.start();

  const an = ctx.createAnalyser(); // level meter for the settings readout / automated tests
  an.fftSize = 2048;
  out.connect(an);
  M = { ctx, out, bus, wind, an, noiseBuf, mood: 'menu', duck: 1, step: 0, loops: 0, next: ctx.currentTime + 0.3, koto: new Map() };
  applyGain(2.5); // gentle fade-in
  M.timer = setInterval(schedule, 90);
  document.addEventListener('visibilitychange', () => {
    if (!M) return;
    // Background tabs throttle timers: rather than scheduling a burst on return, resume on the beat.
    if (!document.hidden) M.next = Math.max(M.next, ctx.currentTime + 0.1);
  });
}

function schedule() {
  const ctx = M.ctx;
  if (ctx.state !== 'running') return;
  if (M.next < ctx.currentTime - 0.2) M.next = ctx.currentTime + 0.05; // fell behind (tab was hidden)
  const playing = targetGain() > 0.0005 || M.out.gain.value > 0.0005;
  while (M.next < ctx.currentTime + 0.45) {
    if (playing) playStep(M.step, M.next);
    M.next += EIGHTH;
    M.step = (M.step + 1) % STEPS;
    if (M.step === 0) M.loops++;
  }
}

function playStep(step, t) {
  const bar = Math.floor(step / 8);
  const e = step % 8;
  const root = BASS[bar];
  const fin = M.mood === 'finale';
  const sw = e % 2 === 1 ? EIGHTH * 0.12 : 0; // a light lilt on off-beats
  // Pad on each bar
  if (e === 0) pad(t, freqOf(root - 5), EIGHTH * 8);
  // Koto arpeggio (pattern changes per section and per pass)
  const pat = PAT[(Math.floor(bar / 8) + M.loops) % PAT.length];
  const off = pat[e];
  if (off !== null && !(bar >= 8 && bar < 24 && e % 2 === 1 && !fin && bar % 2 === 1)) {
    koto(t + sw, freqOf(root + off), (e === 0 ? 0.2 : 0.13) * (bar < 8 ? 1.1 : 0.9));
  }
  // Flute melody (from the second section on)
  const fl = FLUTE.get(step);
  if (fl) {
    flute(t, freqOf(fl[0]), fl[1], 0.075);
    if (fin) flute(t + 0.01, freqOf(fl[0] - 5), fl[1], 0.03);
  }
  // Soft percussion: taiko on bar starts (B and A' sections), shimmering suzu at section starts.
  if (e === 0 && (bar >= 16 || fin)) taiko(t, 0.22);
  if (fin && e === 4) taiko(t, 0.12);
  if (fin && (e === 3 || e === 7)) woodblock(t, 0.05);
  if (e === 0 && bar % 8 === 0) suzu(t, 0.035);
}

// ---------------------------------------------------------------- instruments
function kotoBuffer(f) {
  const key = Math.round(f * 10);
  let b = M.koto.get(key);
  if (b) return b;
  const ctx = M.ctx;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  b = ctx.createBuffer(1, len, sr);
  const d = b.getChannelData(0);
  const N = Math.max(2, Math.round(sr / f));
  const ring = new Float32Array(N);
  // Pluck: noise burst, pre-filtered for a softer, silk-string attack
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const r = Math.random() * 2 - 1;
    prev = prev * 0.55 + r * 0.45;
    ring[i] = prev;
  }
  const damp = 0.4985 - Math.min(0.004, f / 400000);
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const a = ring[idx];
    const nb = ring[(idx + 1) % N];
    const v = (a + nb) * damp;
    ring[idx] = v;
    d[i] = a;
    idx = (idx + 1) % N;
  }
  M.koto.set(key, b);
  return b;
}

function koto(t, f, gain) {
  const ctx = M.ctx;
  const s = ctx.createBufferSource();
  s.buffer = kotoBuffer(f);
  const g = ctx.createGain();
  g.gain.value = gain;
  const pan = ctx.createStereoPanner?.();
  s.connect(g);
  if (pan) {
    pan.pan.value = Math.max(-0.6, Math.min(0.6, (Math.log2(f / BASE) - 0.3) * 0.5));
    g.connect(pan);
    pan.connect(M.bus);
  } else g.connect(M.bus);
  s.start(t);
  s.stop(t + 2.4);
}

function flute(t, f, dur, gain) {
  const ctx = M.ctx;
  const o = ctx.createOscillator();
  o.type = 'sine';
  // "meri": start a little flat and bend up to pitch
  o.frequency.setValueAtTime(f * 0.975, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.14);
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(f * 2 * 0.975, t);
  o2.frequency.exponentialRampToValueAtTime(f * 2, t + 0.14);
  const g2 = ctx.createGain();
  g2.gain.value = 0.12;
  // Delayed vibrato
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.2;
  const vg = ctx.createGain();
  vg.gain.setValueAtTime(0, t);
  vg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.6, dur * 0.6));
  vib.connect(vg);
  vg.connect(o.frequency);
  const g = ctx.createGain();
  const end = t + dur * 0.96;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.12);
  g.gain.setTargetAtTime(gain * 0.75, t + 0.2, 0.4);
  g.gain.setTargetAtTime(0.0001, end - 0.08, 0.09);
  o.connect(g);
  o2.connect(g2);
  g2.connect(g);
  g.connect(M.bus);
  // Breath at the attack
  const n = ctx.createBufferSource();
  n.buffer = M.noiseBuf;
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = f * 2;
  nf.Q.value = 2.5;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(gain * 0.5, t + 0.05);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  n.connect(nf);
  nf.connect(ng);
  ng.connect(M.bus);
  for (const x of [o, o2, vib]) {
    x.start(t);
    x.stop(end + 0.5);
  }
  n.start(t, Math.random());
  n.stop(t + 0.35);
}

function pad(t, f, dur) {
  const ctx = M.ctx;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.045, t + 0.9);
  g.gain.setTargetAtTime(0.0001, t + dur - 0.6, 0.35);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  lp.connect(g);
  g.connect(M.bus);
  const os = [f, f * 1.004, f * 1.5].map((fr, i) => {
    const o = ctx.createOscillator();
    o.type = i === 2 ? 'sine' : 'triangle';
    o.frequency.value = fr;
    const og = ctx.createGain();
    og.gain.value = i === 2 ? 0.35 : 0.5;
    o.connect(og);
    og.connect(lp);
    o.start(t);
    o.stop(t + dur + 1.2);
    return o;
  });
  return os;
}

function taiko(t, gain) {
  const ctx = M.ctx;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.35);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  o.connect(g);
  g.connect(M.bus);
  o.start(t);
  o.stop(t + 0.6);
}

function woodblock(t, gain) {
  const ctx = M.ctx;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(1150, t);
  o.frequency.exponentialRampToValueAtTime(800, t + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g);
  g.connect(M.bus);
  o.start(t);
  o.stop(t + 0.1);
}

function suzu(t, gain) {
  const ctx = M.ctx;
  for (let i = 0; i < 6; i++) {
    const tt = t + i * 0.05 + Math.random() * 0.03;
    const o = ctx.createOscillator();
    o.frequency.value = 2600 + Math.random() * 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, tt);
    g.gain.exponentialRampToValueAtTime(gain, tt + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.5);
    o.connect(g);
    g.connect(M.bus);
    o.start(tt);
    o.stop(tt + 0.55);
  }
}
