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
  done: {
    explore: false,
    goldfish: false,
    shateki: false,
    taiko: false,
    kimodameshi: false,
    shrine: false,
    fireworks: false,
  },
  foods: new Set(),
  prizes: [],
};

export function emit(type, pos) {
  G.events.push({ type, pos: pos.clone() });
}
