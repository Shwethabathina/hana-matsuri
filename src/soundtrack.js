
import.meta;

// Hana Matsuri — Soundtrack Manager
//
// Soundtrack priority:
// 1. Local recordings: /local-music/
// 2. Custom public recordings: /custom-music/
// 3. Original game soundtrack: /music/
//
// The first complete set of four accessible tracks is selected.
//
// Local files are used during private development.
// Custom files are used on Vercel when publicly deployed.
// Original music is used if custom tracks are unavailable.
//
// Crossfade duration: 2.5 seconds.
// All tracks loop. The finale restarts when the Lantern
// Festival begins or is replayed.

export const TRACK_SETS = [
  {
    id: 'local',
    tracks: {
      festival: '/local-music/festival.mp3',
      town: '/local-music/town.mp3',
      haunted: '/local-music/horror.mp3',
      finale: '/local-music/finale.flac',
    },
  },
  {
    id: 'custom',
    tracks: {
      festival: '/custom-music/festival.mp3',
      town: '/custom-music/town.mp3',
      haunted: '/custom-music/horror.mp3',
      finale: '/custom-music/finale.flac',
    },
  },
  {
    id: 'public',
    tracks: {
      festival: '/music/festival.mp3',
      town: '/music/town.mp3',
      haunted: '/music/horror.mp3',
      finale: '/music/finale.mp3',
    },
  },
];

const MOOD_TRACK = {
  festival: 'festival',
  menu: 'festival',
  town: 'town',
  haunted: 'haunted',
  finale: 'finale',
  silent: null,
};

const FADE = 2.5;

// Verify that the file exists and is not an HTML fallback.
const exists = (url) =>
  fetch(url, {
    method: 'HEAD',
    cache: 'no-store',
  })
    .then((response) => {
      if (!response.ok) return false;

      const type =
        response.headers.get('content-type') || '';

      return !/text\/html/i.test(type);
    })
    .catch(() => false);

// Probe only once per page load.
let probed = null;

export function probeSoundtrack() {
  if (!probed) {
    probed = (async () => {
      for (const set of TRACK_SETS) {
        const results = await Promise.all(
          Object.values(set.tracks).map(exists)
        );

        if (results.every(Boolean)) {
          console.info(
            `[Hana Matsuri] Using soundtrack: ${set.id}`
          );

          return set;
        }
      }

      console.warn(
        '[Hana Matsuri] No complete soundtrack found.'
      );

      return null;
    })();
  }

  return probed;
}

export function createSoundtrack(ctx, getLevel, set) {
  const TRACKS = set.tracks;

  // Independent music bus.
  // Game sound effects remain unaffected.
  const bus = ctx.createGain();
  bus.gain.value = getLevel();
  bus.connect(ctx.destination);

  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  bus.connect(an);

  const T = {};

  // Create one audio element per track.
  for (const [name, url] of Object.entries(TRACKS)) {
    const el = new Audio();

    el.src = url;
    el.loop = true;
    el.preload =
      name === 'festival' ? 'auto' : 'metadata';

    const src = ctx.createMediaElementSource(el);
    const g = ctx.createGain();

    g.gain.value = 0;

    src.connect(g);
    g.connect(bus);

    const t = {
      name,
      el,
      g,
      token: 0,
      playedOnce: false,
      last: 0,
      error: null,
    };

    el.addEventListener('timeupdate', () => {
      if (el.currentTime < t.last - 1) {
        t.playedOnce = true;
      }

      t.last = el.currentTime;
    });

    el.addEventListener('error', () => {
      t.error =
        el.error?.message ||
        `Audio error code ${el.error?.code}`;

      console.error(
        `[Hana Matsuri] ${name} failed:`,
        t.error
      );
    });

    T[name] = t;
  }

  let current = null;
  let mood = null;
  let duck = 1;

  // Smooth gain transition.
  const ramp = (g, to, seconds) => {
    const now = ctx.currentTime;

    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);

    g.gain.linearRampToValueAtTime(
      to,
      now + Math.max(0.01, seconds)
    );
  };

  const play = (t) => {
    const promise = t.el.play();

    promise?.catch?.((error) => {
      t.error = String(error?.message || error);

      console.error(
        `[Hana Matsuri] Playback error: ${t.name}`,
        t.error
      );
    });
  };

  // Fade out the previous soundtrack.
  const fadeOut = (t, seconds) => {
    const token = ++t.token;

    ramp(t.g, 0, seconds);

    setTimeout(() => {
      if (t.token === token && current !== t) {
        t.el.pause();
      }
    }, seconds * 1000 + 120);
  };

  // Fade in the selected soundtrack.
  const fadeIn = (
    t,
    seconds,
    fromStart = false
  ) => {
    t.token++;

    if (fromStart) {
      t.el.currentTime = 0;
      t.last = 0;
      t.playedOnce = false;
    }

    play(t);
    ramp(t.g, 1, seconds);
  };

  // Change soundtrack when entering another area.
  const switchTo = (
    name,
    { fromStart = false, fade = FADE } = {}
  ) => {
    const next = name ? T[name] : null;

    if (next === current) return;

    if (current) {
      fadeOut(current, fade);
    }

    current = next;

    if (next) {
      fadeIn(next, fade, fromStart);

      console.info(
        `[Hana Matsuri] Playing: ${name}`
      );
    }
  };

  return {
    // Starts when the user clicks Start Game.
    // Festival music begins at 0:00.
    begin() {
      mood = 'festival';

      switchTo('festival', {
        fromStart: true,
        fade: 0.25,
      });
    },

    // Called continuously by main.js.
    // Changes music only when the area changes.
    set(m, d) {
      duck = d;
      this.level(0.35);

      if (m === mood) return;

      mood = m;

      switchTo(
        MOOD_TRACK[m] ?? 'festival'
      );
    },

    // Music volume, mute, and activity ducking.
    level(tc = 0.15) {
      bus.gain.setTargetAtTime(
        getLevel() * duck,
        ctx.currentTime,
        tc
      );
    },

    // Restart a track.
    // Used when the Lantern Festival begins or replays.
    restart(name) {
      const t = T[name];

      if (!t) return;

      // Not currently playing:
      // reset it before the mood switch.
      if (current !== t) {
        t.el.currentTime = 0;
        t.last = 0;
        t.playedOnce = false;
        return;
      }

      // Already playing: fade down, restart, fade up.
      const token = ++t.token;

      ramp(t.g, 0, 0.4);

      setTimeout(() => {
        if (
          t.token !== token ||
          current !== t
        ) {
          return;
        }

        fadeIn(t, 1.2, true);
      }, 450);
    },

    // Developer helper for seeking within a song.
    seek(name, seconds) {
      const el = T[name]?.el;

      if (!el) return;

      el.currentTime =
        seconds < 0
          ? Math.max(0, el.duration + seconds)
          : seconds;
    },

    // Whether the first finale playback is unfinished.
    get finaleUnfinished() {
      return (
        current === T.finale &&
        !T.finale.playedOnce
      );
    },

    // Debug information.
    debug() {
      const buffer =
        new Float32Array(an.fftSize);

      an.getFloatTimeDomainData(buffer);

      let sum = 0;

      for (const value of buffer) {
        sum += value * value;
      }

      const round = (value) =>
        Math.round(value * 1000) / 1000;

      return {
        mode: 'files',
        set: set.id,
        mood,
        duck,
        current: current?.name ?? null,
        bus: round(bus.gain.value),
        rms: round(
          Math.sqrt(sum / buffer.length)
        ),
        playing: Object.values(T)
          .filter((t) => !t.el.paused)
          .map((t) => t.name),
        tracks: Object.fromEntries(
          Object.values(T).map((t) => [
            t.name,
            {
              time: round(t.el.currentTime),
              gain: round(t.g.gain.value),
              paused: t.el.paused,
              playedOnce: t.playedOnce,
              ready: t.el.readyState,
              error: t.error,
            },
          ])
        ),
      };
    },
  };
}
