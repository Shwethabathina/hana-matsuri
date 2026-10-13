import * as THREE from 'three';

// World units are metres. The Sketchfab street is scaled x5 so stalls are ~3 m tall.
export const MODEL_SCALE = 5;
export const MODEL_URL = 'models/festival/festival.gltf'; // quantized + WebP, split into small buffers (97 MB -> 23 MB)

// The festival street (Sketchfab model) runs along +x from x≈-11 to x≈10.
// East of it we add a plaza with game booths, the shrine, a forest path and a fireworks viewing area.
export const L = {
  start: new THREE.Vector3(-9, 0, 0.2),
  goldfish: new THREE.Vector3(18, 0, -6.2), // booth opens toward +z (the path)
  shateki: new THREE.Vector3(18, 0, 6.2), // booth opens toward -z
  ringtoss: new THREE.Vector3(24, 0, 6.2),
  taiko: new THREE.Vector3(26, 0, -8.5),
  kimoEntrance: new THREE.Vector3(32, 0, -3.4),
  torii: new THREE.Vector3(35.8, 0, 0),
  omikuji: new THREE.Vector3(39.6, 0, -4.4),
  offering: new THREE.Vector3(46.4, 0, 0), // on the raised terrace
  shrine: new THREE.Vector3(51.5, 0, 0),
  seaTorii: new THREE.Vector3(24, 0, 16.4),
  bridge: new THREE.Vector3(59.5, 0, 9.5),
  viewing: new THREE.Vector3(31, 0, 7.5),
  fireworksCenter: new THREE.Vector3(38, 42, 62),
  fireworksLaunch: new THREE.Vector3(38, -3.2, 78),
};

export const WORLD_BOUNDS = { minX: -11, maxX: 58.5, minZ: -54, maxZ: 15 };

export const WATER_Y = -3.2;

// Raised shrine terrace (ishigaki stone wall) reached by stone stairs from the west.
export const TERRACE = { minX: 43, maxX: 57.5, minZ: -7.5, maxZ: 7.5, h: 2.4 };
export const STAIRS = { x0: 38.6, x1: 43, hw: 1.75 };

// Walkable ground height (player camera and NPC feet follow it).
export function heightAt(x, z) {
  const T = TERRACE;
  if (x >= T.minX && x <= T.maxX && z >= T.minZ && z <= T.maxZ) return T.h;
  if (x >= STAIRS.x0 && x < T.minX && Math.abs(z) <= STAIRS.hw + 0.3) return (T.h * (x - STAIRS.x0)) / (STAIRS.x1 - STAIRS.x0);
  return 0;
}

// Island outline (x, z), smoothed into a closed curve. Rocky cliffs drop to the water.
export const ISLAND = [
  [-15.5, -10], [-14.5, -2], [-15.5, 6], [-14.8, 14.5], [-9, 17.5], [0, 18], [10, 17.2], [18, 17.8], [22, 19.5], [26, 19.5],
  [31, 17.6], [40, 17], [50, 16.4], [57, 14.5], [61.5, 9], [62, 0], [60.5, -9], [61.5, -22], [60, -36], [61, -48],
  [55, -58.5], [44, -61], [30, -59.5], [19, -57], [14.5, -46], [15.5, -32], [13, -21], [5, -17.5], [-5, -18.2], [-12.5, -16.5],
];

// Kimodameshi forest loop (xz), starting at the entrance north of the path.
export const KIMO_PATH = [
  [32, -3.4],
  [31.5, -13],
  [27, -21],
  [29, -31],
  [36, -40],
  [45, -36],
  [49, -26],
  [45, -14],
  [41, -10],
  [39.2, -6.4],
].map(([x, z]) => new THREE.Vector3(x, 0, z));

// Street stall fronts from the model (x positions after scaling).
export const STALLS = [
  { name: 'Choco Banana', jp: 'チョコバナナ', x: -6.0, side: -1, price: 300, emoji: '🍫🍌' },
  { name: 'Jaga Butter', jp: 'じゃがバター', x: -3.2, side: -1, price: 400, emoji: '🥔' },
  { name: 'Oden', jp: 'おでん', x: 2.7, side: -1, price: 450, emoji: '🍢' },
  { name: 'Takoyaki', jp: 'たこ焼き', x: 7.8, side: -1, price: 500, emoji: '🐙' },
  { name: 'Yakitori', jp: '焼き鳥', x: -5.6, side: 1, price: 400, emoji: '🍗' },
  { name: 'Okonomiyaki', jp: 'お好み焼き', x: 0.0, side: 1, price: 600, emoji: '🥞' },
];
// Street counter faces: north row counter front at z≈-2.5, south row at z≈2.05.
export const stallFront = (s) => new THREE.Vector3(s.x, 0, s.side < 0 ? -1.95 : 1.5);
export const stallOwnerPos = (s) => new THREE.Vector3(s.x, 0, s.side < 0 ? -4.15 : 3.85);
