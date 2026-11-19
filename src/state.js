// Shared game state read by NPC behaviour trees, HUD and the fireworks finale.
export const G = {
  mode: 'explore',
  fireworksActive: false,
  taikoActive: false,
  taikoHype: 0,
  drumHit: 0, // increments on every taiko hit (player or NPC)
  events: [], // { type, pos } transient festival events NPCs react to
  player: null,
  coins: 3000,
  debug: false,
  difficulty: 'easy', // mini-game difficulty: 'easy' (default for first-time players) | 'normal' | 'hard'
  done: {
    explore: false,
    goldfish: false,
    shateki: false,
    taiko: false,
    kimodameshi: false,
    treasure: false,
    shrine: false,
    fireworks: false,
  },
  foods: new Set(),
  prizes: [],
};

export function emit(type, pos) {
  G.events.push({ type, pos: pos.clone() });
}

// Mini-game tuning per difficulty. Easy: forgiving and winnable in a few tries; Hard: the original tuning.
export const TUNING = {
  easy: { label: 'Easy', taikoBpm: 90, taikoBars: 10, great: 0.08, good: 0.16, late: 0.2, anyDrum: true, taikoPass: 40,
    corks: 12, spread: 0.04, dropComp: 0.95, hitR: 2.2, stability: 0.55, aimDot: true,
    wear: 0.5, weight: 0.6, fishSpeed: 0.75, flee: 0.6, catchR: 0.06, catchDepth: 0.19, ring: true },
  normal: { label: 'Normal', taikoBpm: 110, taikoBars: 13, great: 0.06, good: 0.12, late: 0.15, anyDrum: false, taikoPass: 50,
    corks: 9, spread: 0.08, dropComp: 0.85, hitR: 1.5, stability: 0.75, aimDot: true,
    wear: 0.62, weight: 0.7, fishSpeed: 0.82, flee: 0.7, catchR: 0.05, catchDepth: 0.18, ring: true },
  hard: { label: 'Hard', taikoBpm: 130, taikoBars: 16, great: 0.05, good: 0.11, late: 0.13, anyDrum: false, taikoPass: 60,
    corks: 7, spread: 0.12, dropComp: 0.75, hitR: 1, stability: 1, aimDot: false,
    wear: 0.85, weight: 0.9, fishSpeed: 0.95, flee: 0.9, catchR: 0.03, catchDepth: 0.16, ring: false },
};
export const tuning = () => TUNING[G.difficulty] || TUNING.easy;
