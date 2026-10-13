// All sound is synthesised with WebAudio, so the demo ships no audio files.
let ctx = null;
let master = null;
let noiseBuf = null;
let amb = null;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startAmbience();
}

export const audioTime = () => (ctx ? ctx.currentTime : performance.now() / 1000);

function env(g, t, attack, peak, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(t, { type = 'lowpass', freq = 1000, q = 1, gain = 0.5, attack = 0.005, decay = 0.3 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t, attack, gain, decay);
  s.connect(f);
  f.connect(g);
  g.connect(master);
  s.start(t, Math.random() * 1.5);
  s.stop(t + attack + decay + 0.05);
}

function tone(t, { type = 'sine', freq = 440, freqEnd = 0, gain = 0.3, attack = 0.005, decay = 0.3 } = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + decay);
  const g = ctx.createGain();
  env(g, t, attack, gain, decay);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

const S = (fn) => (...args) => {
  if (!ctx) return;
  fn(ctx.currentTime, ...args);
};

export const sfx = {
  don: S((t, v = 1) => {
    tone(t, { freq: 150, freqEnd: 52, gain: 0.9 * v, decay: 0.45 });
    noise(t, { freq: 380, gain: 0.35 * v, decay: 0.12 });
  }),
  ka: S((t, v = 1) => {
    tone(t, { type: 'triangle', freq: 950, freqEnd: 700, gain: 0.22 * v, decay: 0.06 });
    noise(t, { type: 'bandpass', freq: 2600, q: 2, gain: 0.5 * v, decay: 0.05 });
  }),
  tick: S((t, accent = false) => tone(t, { freq: accent ? 2400 : 1800, gain: accent ? 0.1 : 0.05, decay: 0.05 })),
  suzu: S((t) => {
    for (let i = 0; i < 10; i++) {
      tone(t + i * 0.06 + Math.random() * 0.03, { freq: 2500 + Math.random() * 1100, gain: 0.07, decay: 0.3 });
    }
  }),
  clap: S((t) => {
    noise(t, { type: 'bandpass', freq: 1300, q: 0.8, gain: 0.6, decay: 0.08 });
    noise(t + 0.35, { type: 'bandpass', freq: 1300, q: 0.8, gain: 0.6, decay: 0.08 });
  }),
  pop: S((t) => {
    tone(t, { freq: 620, freqEnd: 200, gain: 0.3, decay: 0.07 });
    noise(t, { type: 'highpass', freq: 1500, gain: 0.35, decay: 0.05 });
  }),
  thock: S((t) => tone(t, { type: 'triangle', freq: 330, freqEnd: 170, gain: 0.25, decay: 0.08 })),
  prize: S((t) => [660, 880, 1320].forEach((f, i) => tone(t + i * 0.08, { type: 'triangle', freq: f, gain: 0.16, decay: 0.3 }))),
  splash: S((t, v = 1) => noise(t, { type: 'bandpass', freq: 1700, q: 0.7, gain: 0.25 * v, decay: 0.25 })),
  tear: S((t) => noise(t, { type: 'highpass', freq: 2400, gain: 0.35, decay: 0.3 })),
  chime: S((t) => [880, 1175, 1568].forEach((f, i) => tone(t + i * 0.09, { freq: f, gain: 0.15, decay: 0.7 }))),
  coin: S((t) => {
    tone(t, { type: 'square', freq: 988, gain: 0.05, decay: 0.07 });
    tone(t + 0.08, { type: 'square', freq: 1319, gain: 0.05, decay: 0.25 });
  }),
  fail: S((t) => tone(t, { type: 'sawtooth', freq: 300, freqEnd: 120, gain: 0.12, decay: 0.4 })),
  whistle: S((t) => {
    tone(t, { freq: 500, freqEnd: 1900, gain: 0.04, attack: 0.05, decay: 1.3 });
    noise(t, { type: 'bandpass', freq: 3000, q: 4, gain: 0.04, attack: 0.1, decay: 1.1 });
  }),
  boom: S((t, dist = 60, v = 1) => {
    const d = t + dist / 343;
    noise(d, { freq: 170, gain: 0.9 * v, decay: 1.8 });
    tone(d, { freq: 70, freqEnd: 32, gain: 0.55 * v, decay: 1.0 });
  }),
  crackle: S((t, dist = 60) => {
    const t0 = t + dist / 343 + 0.35;
    for (let i = 0; i < 22; i++) noise(t0 + Math.random() * 1.4, { type: 'highpass', freq: 3000, gain: 0.1, decay: 0.03 });
  }),
  scare: S((t) => {
    [233, 247, 349, 370].forEach((f) => tone(t, { type: 'sawtooth', freq: f, freqEnd: f * 0.75, gain: 0.12, attack: 0.01, decay: 1.3 }));
    noise(t, { type: 'bandpass', freq: 900, q: 0.5, gain: 0.45, decay: 1.1 });
  }),
  whisper: S((t) => noise(t, { type: 'bandpass', freq: 1400, q: 3, gain: 0.14, attack: 0.4, decay: 1.4 })),
  cheer: S((t) => noise(t, { type: 'bandpass', freq: 1100, q: 0.4, gain: 0.18, attack: 0.15, decay: 1.2 })),
};

function startAmbience() {
  const bus = () => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(master);
    return g;
  };
  const src = () => {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    return s;
  };
  // Cicadas (daytime): band-passed noise with fast amplitude modulation.
  const cicada = bus();
  const s1 = src();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 4800;
  bp.Q.value = 6;
  const am = ctx.createGain();
  am.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 28;
  const lg = ctx.createGain();
  lg.gain.value = 0.5;
  lfo.connect(lg);
  lg.connect(am.gain);
  s1.connect(bp);
  bp.connect(am);
  am.connect(cicada);
  // Crickets (night): chirped sine.
  const cricket = bus();
  const o = ctx.createOscillator();
  o.frequency.value = 4300;
  const am2 = ctx.createGain();
  am2.gain.value = 0.5;
  const l2 = ctx.createOscillator();
  l2.type = 'square';
  l2.frequency.value = 13;
  const l2g = ctx.createGain();
  l2g.gain.value = 0.5;
  l2.connect(l2g);
  l2g.connect(am2.gain);
  o.connect(am2);
  am2.connect(cricket);
  // Crowd murmur.
  const crowd = bus();
  const s3 = src();
  const f3 = ctx.createBiquadFilter();
  f3.type = 'bandpass';
  f3.frequency.value = 450;
  f3.Q.value = 0.6;
  s3.connect(f3);
  f3.connect(crowd);
  [s1, lfo, o, l2, s3].forEach((n) => n.start());
  amb = { cicada, cricket, crowd };
}

export function setAmbience({ day = 0, night = 0, crowd = 0 }) {
  if (!amb) return;
  const t = ctx.currentTime;
  amb.cicada.gain.setTargetAtTime(day * 0.035, t, 0.6);
  amb.cricket.gain.setTargetAtTime(night * 0.008, t, 0.6);
  amb.crowd.gain.setTargetAtTime(crowd * 0.05, t, 0.6);
}
