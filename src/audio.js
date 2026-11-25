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

// Shared context + master bus for other audio modules (the background music).
export const audioCore = () => (ctx ? { ctx, master, noiseBuf } : null);

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
  rustle: S((t, v = 1) => {
    noise(t, { type: 'bandpass', freq: 1800, q: 0.8, gain: 0.18 * v, attack: 0.02, decay: 0.35 });
    noise(t + 0.12, { type: 'bandpass', freq: 2600, q: 0.8, gain: 0.1 * v, attack: 0.02, decay: 0.25 });
  }),
  step: S((t, v = 0.5) => noise(t, { type: 'lowpass', freq: 520 + Math.random() * 180, gain: 0.07 * v, attack: 0.004, decay: 0.07 })),
  // Small bell cluster; v = 0..1 loudness (used for the tanuki's stolen Kagura bell).
  jingle: S((t, v = 1) => {
    for (let i = 0; i < 4; i++) tone(t + i * 0.07 + Math.random() * 0.03, { freq: 2300 + Math.random() * 900, gain: 0.05 * v, decay: 0.22 });
  }),
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

// Horror score for the Test of Courage: a detuned low drone with a slow swell, breathy shakuhachi-like
// noise phrases and sparse dissonant koto plucks. setHorror(level) raises tension (0 calm .. 1 chase).
let horror = null;
export function startHorror() {
  if (!ctx || horror) return;
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(master);
  out.gain.setTargetAtTime(1, ctx.currentTime, 1.5);
  const drone = ctx.createGain();
  drone.gain.value = 0.05;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  drone.connect(lp);
  lp.connect(out);
  const oscs = [55, 55 * 1.007, 82.4 * 0.995, 116.5].map((f, i) => {
    const o = ctx.createOscillator();
    o.type = i === 3 ? 'triangle' : 'sawtooth';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = i === 3 ? 0.25 : 0.5;
    o.connect(g);
    g.connect(drone);
    o.start();
    return o;
  });
  const swell = ctx.createOscillator();
  swell.frequency.value = 0.07;
  const sg = ctx.createGain();
  sg.gain.value = 0.03;
  swell.connect(sg);
  sg.connect(drone.gain);
  swell.start();
  horror = { out, drone, lp, oscs, swell, level: 0, nextPluck: ctx.currentTime + 3, nextBreath: ctx.currentTime + 6 };
  horror.timer = setInterval(horrorTick, 250);
}

function horrorTick() {
  if (!horror) return;
  const t = ctx.currentTime;
  const L = horror.level;
  if (t > horror.nextPluck) {
    // Koto-like pluck from an unsettling scale (in-sen), sometimes a tritone pair.
    const scale = [220, 233.1, 293.7, 329.6, 349.2, 440, 466.2];
    const f = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.3 ? 0.5 : 1);
    tone(t, { type: 'triangle', freq: f, gain: 0.05, decay: 1.6 });
    if (Math.random() < 0.35) tone(t + 0.02, { type: 'triangle', freq: f * 1.414, gain: 0.03, decay: 1.4 });
    horror.nextPluck = t + (L > 0.6 ? 0.9 : 2.5) + Math.random() * (L > 0.6 ? 1 : 4);
  }
  if (t > horror.nextBreath) {
    noise(t, { type: 'bandpass', freq: 600 + Math.random() * 500, q: 6, gain: 0.05 + L * 0.05, attack: 0.8, decay: 1.8 });
    horror.nextBreath = t + 5 + Math.random() * 7;
  }
}

export function setHorror(level) {
  if (!horror) return;
  horror.level = level;
  const t = ctx.currentTime;
  horror.lp.frequency.setTargetAtTime(380 + level * 1400, t, 0.4);
  horror.drone.gain.setTargetAtTime(0.05 + level * 0.07, t, 0.4);
  horror.oscs[3].frequency.setTargetAtTime(116.5 * (1 + level * 0.06), t, 0.6); // pitch creeps sharp under stress
}

export function stopHorror() {
  if (!horror) return;
  const h = horror;
  horror = null;
  clearInterval(h.timer);
  h.out.gain.setTargetAtTime(0, ctx.currentTime, 0.8);
  setTimeout(() => {
    for (const o of [...h.oscs, h.swell]) o.stop();
    h.out.disconnect();
  }, 3000);
}
