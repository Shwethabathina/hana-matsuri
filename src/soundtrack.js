// Recorded soundtrack (local-only): four music files the team keeps in /local-music on their own machine.
// That folder is git-ignored and outside /public, so the files are never committed or deployed; on the
// public site the probe below fails and the game keeps its original procedural score (music.js).
//
// One <audio> element + one MediaElementSource + one gain per track, created once and reused (no
// duplicates, no leaks). Switching areas cross-fades over 2.5 s; the outgoing track is paused after its
// fade so only one soundtrack is ever audible. Area tracks loop; the finale track restarts from 0:00
// each time the Lantern Festival begins, plays to the end, then loops while the celebration continues.
export const TRACKS = {
  festival: 'local-music/festival.mp3',
  town: 'local-music/town.mp3',
  haunted: 'local-music/horror.mp3',
  finale: 'local-music/finale.flac', // FLAC plays natively in Chrome, Edge, Firefox and Safari (lossless)
};
const MOOD_TRACK = { festival: 'festival', menu: 'festival', town: 'town', haunted: 'haunted', finale: 'finale', silent: null };
const FADE = 2.5;

let probed = null;
export function probeSoundtrack() {
  if (!probed) {
    probed = Promise.all(
      Object.values(TRACKS).map((u) =>
        fetch(u, { method: 'HEAD', cache: 'no-store' })
          .then((r) => r.ok && !/text\/html/i.test(r.headers.get('content-type') || ''))
          .catch(() => false),
      ),
    ).then((oks) => oks.every(Boolean));
  }
  return probed;
}

export function createSoundtrack(ctx, getLevel) {
  const bus = ctx.createGain(); // user volume x mute x ducking
  bus.gain.value = getLevel();
  bus.connect(ctx.destination); // straight to the output: the SFX compressor never pumps the music
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  bus.connect(an);

  const T = {};
  for (const [name, url] of Object.entries(TRACKS)) {
    const el = new Audio();
    el.src = url;
    el.loop = true;
    el.preload = name === 'festival' ? 'auto' : 'metadata';
    const src = ctx.createMediaElementSource(el);
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(bus);
    const t = { name, el, g, token: 0, playedOnce: false, last: 0, error: null };
    el.addEventListener('timeupdate', () => {
      if (el.currentTime < t.last - 1) t.playedOnce = true; // wrapped around: one full play finished
      t.last = el.currentTime;
    });
    el.addEventListener('error', () => (t.error = el.error?.message || `code ${el.error?.code}`));
    T[name] = t;
  }

  let current = null;
  let mood = null;
  let duck = 1;

  const ramp = (g, to, secs) => {
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(to, now + secs);
  };
  const play = (t) => {
    const p = t.el.play();
    p?.catch?.((e) => (t.error = String(e?.message || e)));
  };
  const fadeOut = (t, secs) => {
    const tok = ++t.token;
    ramp(t.g, 0, secs);
    setTimeout(() => {
      if (t.token === tok && current !== t) t.el.pause(); // keeps its position for when we come back
    }, secs * 1000 + 120);
  };
  const fadeIn = (t, secs, fromStart) => {
    t.token++;
    if (fromStart) {
      t.el.currentTime = 0;
      t.last = 0;
      t.playedOnce = false;
    }
    play(t);
    ramp(t.g, 1, secs);
  };

  const switchTo = (name, { fromStart = false, fade = FADE } = {}) => {
    const next = name ? T[name] : null;
    if (next === current) return;
    if (current) fadeOut(current, fade);
    current = next;
    if (next) fadeIn(next, fade, fromStart);
  };

  return {
    // Start Game: the festival track from 0:00 (short fade-in so the opening is heard).
    begin() {
      mood = 'festival';
      switchTo('festival', { fromStart: true, fade: 0.25 });
    },
    set(m, d) {
      duck = d;
      this.level(0.35);
      if (m === mood) return;
      mood = m;
      switchTo(MOOD_TRACK[m] ?? 'festival');
    },
    level(tc = 0.15) {
      bus.gain.setTargetAtTime(getLevel() * duck, ctx.currentTime, tc);
    },
    // The Lantern Festival (re)starts: its track from the beginning.
    restart(name) {
      const t = T[name];
      if (!t) return;
      if (current !== t) {
        t.el.currentTime = 0;
        t.last = 0;
        t.playedOnce = false;
        return; // the coming mood switch fades it in from 0:00
      }
      // Already playing (replay from the end screen): quick dip, back to 0:00, fade up again.
      const tok = ++t.token;
      ramp(t.g, 0, 0.4);
      setTimeout(() => {
        if (t.token !== tok || current !== t) return;
        fadeIn(t, 1.2, true);
      }, 450);
    },
    // Test / debug helper: jump within a track (seconds from the end when negative).
    seek(name, sec) {
      const el = T[name]?.el;
      if (el) el.currentTime = sec < 0 ? Math.max(0, el.duration + sec) : sec;
    },
    get finaleUnfinished() {
      return current === T.finale && !T.finale.playedOnce;
    },
    debug() {
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      const r = (x) => Math.round(x * 1000) / 1000;
      return {
        mode: 'files', mood, duck, current: current?.name ?? null, bus: r(bus.gain.value), rms: r(Math.sqrt(s / buf.length)),
        playing: Object.values(T).filter((t) => !t.el.paused).map((t) => t.name),
        tracks: Object.fromEntries(Object.values(T).map((t) => [t.name, { time: r(t.el.currentTime), gain: r(t.g.gain.value), paused: t.el.paused, playedOnce: t.playedOnce, ready: t.el.readyState, error: t.error }])),
      };
    },
  };
}
