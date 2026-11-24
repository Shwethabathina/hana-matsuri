import * as THREE from 'three';
import { G } from './state.js';
import { L, STALLS, stallFront, stallOwnerPos } from './layout.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { angleDamp, canvasTexture, damp, pick, rand, textSprite } from './util.js';
import { sfx } from './audio.js';
import { addPets } from './pets.js';

// =====================================================================
// Minimal behaviour-tree runtime
// =====================================================================
export const SUCCESS = 1;
export const FAILURE = 2;
export const RUNNING = 3;
let nodeId = 0;

class BTNode {
  constructor(name) {
    this.id = nodeId++;
    this.name = name;
  }
  reset() {}
}

// Tries children in priority order; a higher-priority success/running interrupts lower ones.
export class Selector extends BTNode {
  constructor(children) {
    super('Selector');
    this.children = children;
  }
  tick(bb, dt) {
    for (let i = 0; i < this.children.length; i++) {
      const s = this.children[i].tick(bb, dt);
      if (s !== FAILURE) {
        for (let j = i + 1; j < this.children.length; j++) this.children[j].reset(bb);
        return s;
      }
    }
    return FAILURE;
  }
  reset(bb) {
    this.children.forEach((c) => c.reset(bb));
  }
}

// Runs children in order, remembering which one is running.
export class Sequence extends BTNode {
  constructor(children) {
    super('Sequence');
    this.children = children;
  }
  tick(bb, dt) {
    let i = bb.mem[this.id] || 0;
    while (i < this.children.length) {
      const s = this.children[i].tick(bb, dt);
      if (s === RUNNING) {
        bb.mem[this.id] = i;
        return RUNNING;
      }
      if (s === FAILURE) {
        this.reset(bb);
        return FAILURE;
      }
      i++;
    }
    this.reset(bb);
    return SUCCESS;
  }
  reset(bb) {
    bb.mem[this.id] = 0;
    this.children.forEach((c) => c.reset(bb));
  }
}

// Re-evaluates its condition every tick (reactive), aborting the child when false.
export class Guard extends BTNode {
  constructor(cond, child) {
    super('Guard');
    this.cond = cond;
    this.child = child;
  }
  tick(bb, dt) {
    if (!this.cond(bb)) {
      this.child.reset(bb);
      return FAILURE;
    }
    return this.child.tick(bb, dt);
  }
  reset(bb) {
    this.child.reset(bb);
  }
}

export class Action extends BTNode {
  constructor(name, { start, tick, stop }) {
    super(name);
    this.startFn = start;
    this.tickFn = tick;
    this.stopFn = stop;
  }
  tick(bb, dt) {
    let m = bb.mem[this.id];
    if (!m) {
      m = bb.mem[this.id] = {};
      if (this.startFn && this.startFn(bb, m) === FAILURE) {
        delete bb.mem[this.id];
        return FAILURE;
      }
    }
    bb.current = this.name;
    const s = this.tickFn(bb, m, dt);
    if (s !== RUNNING) {
      this.stopFn?.(bb, m);
      delete bb.mem[this.id];
    }
    return s;
  }
  reset(bb) {
    if (bb.mem[this.id]) {
      this.stopFn?.(bb, bb.mem[this.id]);
      delete bb.mem[this.id];
    }
  }
}

// =====================================================================
// Procedural yukata character
// =====================================================================
const patternCache = new Map();
// Traditional yukata prints: sakura, asanoha (hemp-leaf), stripes, seigaiha (waves), kasuri dots, kikkō.
const PATTERNS = ['sakura', 'asanoha', 'stripes', 'waves', 'dots', 'kikko'];
function yukataTexture(base, accent, pattern = 'sakura') {
  const key = base + accent + pattern;
  if (patternCache.has(key)) return patternCache.get(key);
  const tex = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
    g.strokeStyle = accent;
    if (pattern === 'stripes') {
      for (let x = 0; x < w; x += 16) {
        g.fillRect(x, 0, 5, h);
        g.globalAlpha = 0.5;
        g.fillRect(x + 8, 0, 1.5, h);
        g.globalAlpha = 1;
      }
    } else if (pattern === 'waves') {
      g.lineWidth = 2;
      for (let row = 0; row < 6; row++) {
        for (let col = -1; col < 5; col++) {
          const x = col * 32 + (row % 2) * 16;
          const y = row * 24 + 24;
          for (const r of [14, 9, 4]) {
            g.beginPath();
            g.arc(x, y, r, Math.PI, 0);
            g.stroke();
          }
        }
      }
    } else if (pattern === 'dots') {
      for (let y = 8; y < h; y += 16) for (let x = ((y / 16) % 2) * 8 + 4; x < w; x += 16) g.fillRect(x, y, 5, 3);
    } else if (pattern === 'asanoha') {
      g.lineWidth = 1.2;
      for (let y = 0; y <= h; y += 32) {
        for (let x = 0; x <= w; x += 32) {
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            g.beginPath();
            g.moveTo(x, y);
            g.lineTo(x + Math.cos(a) * 16, y + Math.sin(a) * 16);
            g.stroke();
          }
        }
      }
    } else if (pattern === 'kikko') {
      g.lineWidth = 1.5;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 6; col++) {
          const cx = col * 24 + (row % 2) * 12;
          const cy = row * 20;
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
            g.lineTo(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10);
          }
          g.closePath();
          g.stroke();
        }
      }
    } else {
      for (let i = 0; i < 9; i++) {
        const x = (i % 3) * 44 + 20 + ((Math.floor(i / 3) % 2) * 22);
        const y = Math.floor(i / 3) * 44 + 20;
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2;
          g.beginPath();
          g.ellipse(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 5, 3.4, a, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  }, { repeat: [2, 2] });
  patternCache.set(key, tex);
  return tex;
}

const GEO = {
  stick: new THREE.CylinderGeometry(0.018, 0.018, 0.45, 6).rotateX(Math.PI / 2).translate(0, -0.55, 0.18),
};
const SKINS = ['#f1cba8', '#e6b48f', '#d19c74', '#f6d9c0', '#c98e66'];
const HAIRS = ['#15110f', '#24180f', '#3a2618', '#1b1714', '#4a3020'];
const YUKATA = [
  ['#1f3a73', '#ffffff'],
  ['#f2f2f2', '#2c5aa0'],
  ['#c23b4a', '#ffd9e0'],
  ['#2e6b5a', '#f1e3b3'],
  ['#5b3a8a', '#f7c6e4'],
  ['#e79a3a', '#7a2a1a'],
  ['#232323', '#e14b4b'],
  ['#7fb3d9', '#ffffff'],
  ['#f4c6d6', '#c23b6a'],
];
const YUKATA_M = [
  ['#2b2f3a', '#8a94a8'],
  ['#3a3226', '#c9b48a'],
  ['#1f3a73', '#9fb4d9'],
  ['#4a4a4a', '#bdbdbd'],
  ['#26323a', '#6f8796'],
];
const OBI = ['#d4a02a', '#b3202a', '#f3e5c0', '#2a2a2a', '#e86aa6', '#4a7ac8'];
const KANZASHI = ['#ff6a8a', '#ffd24a', '#ffffff', '#c86aff'];

// One rigidly-skinned part: geometry in bind-pose model space, bound to one bone, with a vertex colour.
function part(geo, bone, color = '#ffffff', xf = {}) {
  const g = geo.index ? geo.clone() : geo.clone();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...(xf.p || [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(xf.r || [0, 0, 0]))),
    new THREE.Vector3(...(xf.s || [1, 1, 1])),
  );
  g.applyMatrix4(m);
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.clearGroups();
  return g;
}

const lathe = (pts, seg = 20) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
const sphere = (r, w = 16, h = 12, ...rest) => new THREE.SphereGeometry(r, w, h, ...rest);

// Bone indices
const B = { root: 0, upper: 1, head: 2, armL: 3, armR: 4, footL: 5, footR: 6 };

// A yukata-clad visitor built as a single skinned mesh (two draw calls: patterned cloth + plain parts),
// so a crowd stays cheap while each person still has animated arms, feet, torso and head.
export function makeCharacter({
  gender = Math.random() < 0.6 ? 'f' : 'm',
  yukata = pick(gender === 'f' ? YUKATA : YUKATA_M),
  obi = pick(OBI),
  skin = pick(SKINS),
  hair = pick(HAIRS),
  bun = gender === 'f',
  child = false,
  pattern = gender === 'f' ? pick(PATTERNS) : pick(['stripes', 'kikko', 'dots', 'asanoha', 'waves']),
  hairStyle = gender === 'f' ? (bun ? pick(['bun', 'bun', 'bun', 'pony']) : 'long') : pick(['short', 'short', 'topknot']),
  fan = Math.random() < 0.3,
  build = rand(0.94, 1.08),
} = {}) {
  const f = gender === 'f';
  const W = 0.85; // waist height
  const SH = W + 0.5; // shoulder pivot height
  const HD = W + 0.72; // head centre
  const cloth = [];
  const plain = [];

  // Lower kimono, flaring slightly at the hips and narrowing at the ankles.
  cloth.push(part(lathe(f
    ? [[0, 0.05], [0.145, 0.05], [0.155, 0.2], [0.172, 0.45], [0.182, 0.68], [0.16, W + 0.02], [0, W + 0.02]]
    : [[0, 0.05], [0.16, 0.05], [0.17, 0.3], [0.182, 0.6], [0.178, W + 0.02], [0, W + 0.02]]), B.root));
  // Torso: waist -> chest -> sloping shoulders.
  cloth.push(part(lathe(f
    ? [[0, 0], [0.155, 0], [0.17, 0.15], [0.185, 0.32], [0.19, 0.44], [0.16, 0.52], [0.07, 0.575], [0, 0.58]]
    : [[0, 0], [0.165, 0], [0.18, 0.18], [0.2, 0.36], [0.205, 0.46], [0.17, 0.53], [0.07, 0.575], [0, 0.58]]), B.upper, '#ffffff', { p: [0, W, 0] }));
  // Wide kimono sleeves on each arm.
  for (const [side, bone] of [[1, B.armL], [-1, B.armR]]) {
    const x = 0.205 * side;
    cloth.push(part(new THREE.CylinderGeometry(0.062, 0.085, 0.32, 12), bone, '#ffffff', { p: [x, SH - 0.16, 0] }));
    cloth.push(part(new THREE.BoxGeometry(0.045, f ? 0.26 : 0.2, 0.19), bone, '#ffffff', { p: [x + 0.012 * side, SH - (f ? 0.29 : 0.26), -0.015] }));
    // Forearm and hand
    plain.push(part(new THREE.CylinderGeometry(0.026, 0.032, 0.17, 10), bone, skin, { p: [x, SH - 0.4, 0.01] }));
    plain.push(part(sphere(0.036, 12, 8), bone, skin, { p: [x, SH - 0.515, 0.012], s: [0.75, 1.15, 0.55] }));
  }
  // Obi sash; women get a bow on the back.
  plain.push(part(new THREE.CylinderGeometry(f ? 0.172 : 0.182, f ? 0.172 : 0.182, f ? 0.16 : 0.07, 20), B.upper, obi, { p: [0, W + (f ? 0.07 : 0.04), 0] }));
  if (f) {
    for (const s of [-1, 1]) plain.push(part(sphere(1, 12, 8), B.upper, obi, { p: [0.075 * s, W + 0.1, -0.185], s: [0.085, 0.06, 0.035], r: [0, 0, 0.3 * s] }));
    plain.push(part(new THREE.BoxGeometry(0.06, 0.08, 0.05), B.upper, obi, { p: [0, W + 0.09, -0.18] }));
  }
  // Crossed collar (eri), left over right.
  const chestZ = (f ? 0.19 : 0.205) + 0.004;
  // Each side runs from beside the neck down to the centre of the chest, forming a V.
  for (const s of [-1, 1]) plain.push(part(new THREE.BoxGeometry(0.02, 0.2, 0.01), B.upper, '#f4efe6', { p: [0.04 * s, W + 0.45, chestZ - 0.01], r: [-0.22, 0, -0.4 * s] }));
  // Neck and head
  plain.push(part(new THREE.CylinderGeometry(0.042, 0.048, 0.1, 12), B.upper, skin, { p: [0, W + 0.6, 0] }));
  plain.push(part(sphere(1, 24, 18), B.head, skin, { p: [0, HD, 0.005], s: [0.098, 0.118, 0.106] }));
  // Face
  for (const s of [-1, 1]) {
    plain.push(part(sphere(0.012, 10, 8), B.head, '#1b120e', { p: [0.034 * s, HD + 0.012, 0.105], s: [1.1, 0.75, 0.5] }));
    plain.push(part(new THREE.BoxGeometry(0.032, 0.006, 0.01), B.head, hair, { p: [0.036 * s, HD + 0.042, 0.101], r: [0, 0, -0.12 * s] }));
    plain.push(part(sphere(0.022, 10, 8), B.head, skin, { p: [0.097 * s, HD, 0], s: [0.45, 1, 0.75] }));
  }
  plain.push(part(sphere(0.014, 10, 8), B.head, skin, { p: [0, HD - 0.012, 0.106], s: [0.7, 1, 0.9] }));
  plain.push(part(new THREE.BoxGeometry(0.03, 0.006, 0.008), B.head, f ? '#c0605a' : '#a8705f', { p: [0, HD - 0.045, 0.105] }));
  // Hair
  if (f) {
    plain.push(part(sphere(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.56), B.head, hair, { p: [0, HD + 0.016, -0.012], s: [0.106, 0.124, 0.116], r: [-0.72, 0, 0] }));
    if (hairStyle === 'pony') {
      // High ponytail tied with a ribbon
      plain.push(part(sphere(0.04, 12, 8), B.head, hair, { p: [0, HD + 0.07, -0.1] }));
      plain.push(part(new THREE.CylinderGeometry(0.035, 0.012, 0.2, 10), B.head, hair, { p: [0, HD - 0.03, -0.13], r: [0.25, 0, 0] }));
      plain.push(part(sphere(0.022, 8, 6), B.head, pick(KANZASHI), { p: [0, HD + 0.07, -0.135], s: [1.6, 0.8, 0.8] }));
    } else if (bun) {
      plain.push(part(sphere(0.058, 14, 10), B.head, hair, { p: [0, HD + 0.09, -0.085] }));
      const kc = pick(KANZASHI);
      for (let i = 0; i < 3; i++) plain.push(part(sphere(0.014, 8, 6), B.head, kc, { p: [0.04 + i * 0.012, HD + 0.11 + i * 0.008, -0.06] }));
    } else {
      plain.push(part(new THREE.BoxGeometry(0.19, 0.16, 0.05), B.head, hair, { p: [0, HD - 0.06, -0.09] }));
    }
  } else {
    plain.push(part(sphere(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), B.head, hair, { p: [0, HD + 0.014, -0.01], s: [0.104, 0.12, 0.112], r: [-0.55, 0, 0] }));
    if (hairStyle === 'topknot') plain.push(part(new THREE.CylinderGeometry(0.018, 0.022, 0.07, 8), B.head, hair, { p: [0, HD + 0.115, -0.02], r: [0.6, 0, 0] }));
    // Hachimaki / tenugui headband on some men
    else if (Math.random() < 0.3) plain.push(part(new THREE.CylinderGeometry(0.108, 0.108, 0.025, 20, 1, true), B.head, pick(['#f4efe6', '#b3202a', '#1f3a73']), { p: [0, HD + 0.03, -0.004], r: [-0.12, 0, 0] }));
  }
  // An uchiwa fan in the right hand for some visitors.
  if (fan && !child) {
    plain.push(part(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 5), B.armR, '#a07a4a', { p: [-0.205, SH - 0.58, 0.04] }));
    plain.push(part(new THREE.CylinderGeometry(0.075, 0.075, 0.006, 16).rotateX(Math.PI / 2), B.armR, pick(['#f4f0e6', '#ffd9e0', '#d6ecff', '#ffe9a8']), { p: [-0.205, SH - 0.7, 0.04] }));
  }
  // Geta sandals with tabi-white feet
  for (const [side, bone] of [[1, B.footL], [-1, B.footR]]) {
    const x = 0.075 * side;
    plain.push(part(new THREE.BoxGeometry(0.085, 0.032, 0.21), bone, '#9a7048', { p: [x, 0.016, 0.02] }));
    plain.push(part(sphere(1, 12, 8), bone, f ? '#f4f1ea' : skin, { p: [x, 0.05, 0.03], s: [0.038, 0.026, 0.085] }));
  }

  const geo = mergeGeometries([mergeGeometries(cloth), mergeGeometries(plain)], true);
  const clothMat = new THREE.MeshStandardMaterial({ map: yukataTexture(yukata[0], yukata[1], pattern), roughness: 0.85 });
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });

  const bones = [0, 1, 2, 3, 4, 5, 6].map(() => new THREE.Bone());
  const [root, upper, head, armL, armR, footL, footR] = bones;
  root.add(upper, footL, footR);
  upper.position.set(0, W, 0);
  upper.add(head, armL, armR);
  head.position.set(0, HD - W, 0);
  armL.position.set(0.205, SH - W, 0);
  armR.position.set(-0.205, SH - W, 0);
  footL.position.set(0.075, 0, 0);
  footR.position.set(-0.075, 0, 0);
  const mesh = new THREE.SkinnedMesh(geo, [clothMat, plainMat]);
  mesh.add(root);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true;
  mesh.frustumCulled = false;

  const holder = new THREE.Group();
  holder.add(mesh);
  holder.scale.setScalar((child ? 0.68 : 1) * (f ? rand(0.93, 1.0) : rand(1.0, 1.08)));
  mesh.scale.set(build, 1, 0.5 + build * 0.5); // slimmer / sturdier builds
  return { root: holder, upper, head, armL, armR, footL, footR, phase: Math.random() * 10, gait: 0, pose: {}, look: { t: 0, y: 0, x: 0 } };
}

// Pose targets are damped so transitions between animations blend smoothly.
// Walk: a stride-matched gait — each foot is planted (moving backward exactly as fast as the body moves
// forward, so feet never skate), then swings forward with a lift and toe pitch. Hips sway over the stance
// foot, the body bobs twice per cycle and leans with speed, arms swing against the legs, the head stays level.
const smooth = (k) => k * k * (3 - 2 * k);
function footCycle(u, A, lift) {
  const ST = 0.6; // stance share of the cycle
  if (u < ST) return { z: A - 2 * A * (u / ST), y: 0, p: 0 };
  const k = (u - ST) / (1 - ST);
  return { z: -A + 2 * A * smooth(k), y: Math.sin(k * Math.PI) * lift, p: -Math.sin(k * Math.PI) * 0.45 + (k > 0.85 ? (k - 0.85) * 1.5 : 0) };
}
export function animate(c, anim, speed, dt, t) {
  const P = {
    uX: 0.02, uY: 0.85, uRY: 0, uZ: 0, uPX: 0, hX: 0, hY: 0,
    lX: 0, lZ: 0.08, rX: 0, rZ: -0.08,
    fl: 0, fr: 0, flY: 0, frY: 0, flP: 0, frP: 0, jump: 0,
  };
  // Occasional glances: a slowly re-targeted head look shared by idle poses.
  c.look = c.look || { t: 0, y: 0, x: 0 };
  c.look.t -= dt;
  if (c.look.t <= 0) {
    c.look.t = 1.5 + Math.random() * 3.5;
    c.look.y = (Math.random() - 0.5) * 1.0;
    c.look.x = (Math.random() - 0.5) * 0.25;
  }
  let walking = false;
  switch (anim) {
    case 'walk': {
      walking = true;
      const v = Math.max(0.2, speed);
      const A = Math.min(0.17, 0.08 + 0.055 * v); // half stride (a yukata limits the step)
      c.gait = ((c.gait || 0) + (dt * 0.6 * v) / (2 * A)) % 1; // stance foot speed == body speed
      const u = c.gait;
      const L = footCycle(u, A, 0.045 + 0.02 * v);
      const R = footCycle((u + 0.5) % 1, A, 0.045 + 0.02 * v);
      P.fl = L.z;
      P.fr = R.z;
      P.flY = L.y;
      P.frY = R.y;
      P.flP = L.p;
      P.frP = R.p;
      const sw = Math.sin(u * Math.PI * 2);
      P.lX = (R.z / A) * (0.22 + 0.12 * v); // arm swings with the opposite leg
      P.rX = (L.z / A) * (0.22 + 0.12 * v);
      P.lZ = 0.1;
      P.rZ = -0.1;
      P.uY = 0.85 + (1 - Math.cos(u * Math.PI * 4)) * 0.011; // lowest at double support
      P.uPX = sw * 0.018; // weight over the stance foot
      P.uZ = -sw * 0.03;
      P.uRY = sw * 0.08; // shoulders counter-rotate against the stride
      P.uX = 0.03 + 0.03 * v;
      P.hY = -P.uRY * 0.9 + c.look.y * 0.25; // head stabilised, eyes ahead with a glance now and then
      P.hX = -P.uX * 0.6;
      break;
    }
    case 'talk':
      // Conversation: open-hand gestures, small nods and weight shifts.
      P.rX = -0.55 + Math.sin(t * 2.6 + c.phase) * 0.25;
      P.rZ = -0.25 + Math.sin(t * 1.7) * 0.1;
      P.lX = -0.2 + Math.max(0, Math.sin(t * 1.3 + 1)) * -0.45;
      P.lZ = 0.15;
      P.hX = Math.sin(t * 3.4) * 0.07;
      P.hY = Math.sin(t * 0.8 + c.phase) * 0.12;
      P.uPX = Math.sin(t * 0.6 + c.phase) * 0.012;
      P.uY = 0.85 + Math.sin(t * 1.6) * 0.004;
      break;
    case 'eat':
      P.rX = -1.7 + Math.max(0, Math.sin(t * 2.4)) * 0.5;
      P.rZ = 0.25;
      P.lX = -0.7;
      P.hX = 0.12;
      P.uPX = Math.sin(t * 0.5 + c.phase) * 0.01;
      break;
    case 'watch':
      P.hX = -0.45;
      P.lX = -0.3;
      P.rX = -0.3;
      P.uY = 0.85 + Math.sin(t * 1.5 + c.phase) * 0.004;
      break;
    case 'look':
      P.hX = 0.2 + c.look.x * 0.5;
      P.hY = Math.sin(t * 0.6) * 0.3 + c.look.y * 0.4;
      P.uPX = Math.sin(t * 0.45 + c.phase) * 0.014;
      P.uZ = -P.uPX * 1.2;
      P.lX = -0.15;
      P.rX = -0.15;
      break;
    case 'cheer':
      P.lZ = 2.6 + Math.sin(t * 12) * 0.25;
      P.rZ = -2.6 - Math.sin(t * 12) * 0.25;
      P.jump = Math.abs(Math.sin(t * 7)) * 0.12;
      P.hX = -0.3;
      break;
    case 'wave':
      P.lZ = 2.5 + Math.sin(t * 11) * 0.35;
      P.hY = 0.1;
      P.uZ = -0.04;
      break;
    case 'pray':
      P.lX = -1.25;
      P.rX = -1.25;
      P.lZ = -0.45;
      P.rZ = 0.45;
      P.hX = 0.3;
      break;
    case 'bow':
      P.uX = 0.55;
      P.hX = 0.2;
      break;
    case 'cook':
      P.lX = -0.9 + Math.sin(t * 5) * 0.15;
      P.rX = -0.9 + Math.sin(t * 5 + 2) * 0.25;
      P.hX = 0.35;
      P.hY = Math.sin(t * 0.7) * 0.3;
      break;
    case 'drum': {
      // Two alternating strikes, timed from G.drumHit elsewhere via c.strike
      const k = c.strike || 0;
      P.lX = -1.2 - (c.strikeSide === 0 ? k : 0) * 1.1;
      P.rX = -1.2 - (c.strikeSide === 1 ? k : 0) * 1.1;
      P.uX = 0.1;
      break;
    }
    default: // idle: breathing, slow weight shift between the feet, relaxed arms, glances around
      P.uY = 0.85 + Math.sin(t * 1.7 + c.phase) * 0.005;
      P.uPX = Math.sin(t * 0.35 + c.phase) * 0.016;
      P.uZ = -P.uPX * 1.4;
      P.hY = c.look.y;
      P.hX = c.look.x;
      P.lZ = 0.1 + Math.sin(t * 1.7 + c.phase) * 0.02;
      P.rZ = -0.1 - Math.sin(t * 1.7 + c.phase) * 0.02;
      P.lX = -0.06;
      P.rX = -0.06;
  }
  if (!walking) c.gait = 0;
  // Turning in place: a small step of the feet in the turn direction.
  const turn = c.turnRate || 0;
  if (!walking && Math.abs(turn) > 0.6) {
    const ph = Math.sin(t * 9);
    P.flY = Math.max(0, ph) * 0.03;
    P.frY = Math.max(0, -ph) * 0.03;
    P.hY += Math.sign(turn) * 0.25; // the head leads the turn
  }
  const d = (key, target, rate = 10) => {
    c.pose[key] = damp(c.pose[key] ?? target, target, rate, dt);
    return c.pose[key];
  };
  const fr = walking ? 40 : 12; // feet follow the gait tightly while walking (no lag = no sliding)
  c.upper.rotation.x = d('uX', P.uX, 8);
  c.upper.rotation.y = d('uRY', P.uRY, 10);
  c.upper.rotation.z = d('uZ', P.uZ, 8);
  c.upper.position.x = d('uPX', P.uPX, 8);
  c.upper.position.y = d('uY', P.uY, 14) + d('jump', P.jump, 20);
  c.head.rotation.x = d('hX', P.hX, 6);
  c.head.rotation.y = d('hY', P.hY, 4);
  c.armL.rotation.x = d('lX', P.lX, 12);
  c.armL.rotation.z = d('lZ', P.lZ, 12);
  c.armR.rotation.x = d('rX', P.rX, 12);
  c.armR.rotation.z = d('rZ', P.rZ, 12);
  c.footL.position.z = d('fl', P.fl, fr);
  c.footR.position.z = d('fr', P.fr, fr);
  c.footL.position.y = Math.max(0, d('flY', P.flY, fr));
  c.footR.position.y = Math.max(0, d('frY', P.frY, fr));
  c.footL.rotation.x = d('flP', P.flP, fr);
  c.footR.rotation.x = d('frP', P.frP, fr);
}

// Heading helper for agents: remembers the turn rate so idle characters step into their turns.
export function setHeading(c, heading, dt) {
  const prev = c.lastHeading ?? heading;
  const dh = Math.atan2(Math.sin(heading - prev), Math.cos(heading - prev));
  c.turnRate = dt > 0 ? dh / dt : 0;
  c.lastHeading = heading;
  c.root.rotation.y = heading;
}

// =====================================================================
// Agents
// =====================================================================
const V = (x, z) => new THREE.Vector3(x, 0, z);
const DIR = { n: V(0, -1), s: V(0, 1), e: V(1, 0), w: V(-1, 0) };

function buildPOIs() {
  const list = STALLS.map((s) => ({ name: `Buy ${s.name}`, pos: stallFront(s), face: s.side < 0 ? DIR.n : DIR.s, anim: 'eat', dur: [4, 8], spread: 0.6 }));
  list.push(
    { name: 'Watch goldfish', pos: V(L.goldfish.x, L.goldfish.z + 3.2), face: DIR.n, anim: 'look', dur: [5, 9], spread: 1.2 },
    { name: 'Watch shateki', pos: V(L.shateki.x, L.shateki.z - 3), face: DIR.s, anim: 'look', dur: [4, 8], spread: 1.4 },
    { name: 'Ring toss', pos: V(L.ringtoss.x, L.ringtoss.z - 3), face: DIR.s, anim: 'look', dur: [4, 7], spread: 1 },
    { name: 'Look at torii', pos: V(L.torii.x - 2.5, 0), face: DIR.e, anim: 'watch', dur: [3, 5], spread: 1 },
    { name: 'Pray at shrine', pos: V(L.offering.x - 1.5, 0), face: DIR.e, anim: 'pray', dur: [3, 5], spread: 0.7, then: 'bow' },
    { name: 'Draw omikuji', pos: V(L.omikuji.x, L.omikuji.z + 1.1), face: DIR.n, anim: 'look', dur: [3, 5], spread: 0.4 },
    { name: 'Rest on bench', pos: V(L.viewing.x, L.viewing.z - 1.6), face: DIR.s, anim: 'idle', dur: [5, 10], spread: 3 },
    { name: 'Stroll street', pos: V(-6, 0), face: DIR.e, anim: 'look', dur: [2, 4], spread: 1 },
    { name: 'Stroll plaza', pos: V(22, 0), face: DIR.e, anim: 'look', dur: [2, 4], spread: 3 },
  );
  return list;
}

export class Visitor {
  constructor(sys, pos) {
    this.sys = sys;
    this.c = makeCharacter({ child: Math.random() < 0.15 });
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.heading = rand(0, 6.28);
    this.speed = rand(1.0, 1.45);
    this.anim = 'idle';
    this.override = null;
    this.path = null;
    this.pi = 0;
    this.greetCooldown = rand(0, 10);
    this.likesTaiko = Math.random() < 0.8;
    this.bb = { mem: {}, npc: this, current: '' };
    this.label = textSprite('', { height: 0.22 });
    this.label.position.y = 2.05;
    this.label.visible = false;
    this.bubble = textSprite('', { height: 0.26, bg: 'rgba(255,248,235,0.92)', color: '#3a1d12' });
    this.bubble.position.y = 2.3;
    this.bubble.visible = false;
    this.bubbleT = 0;
    this.c.root.add(this.label, this.bubble);
    sys.scene.add(this.c.root);
  }

  say(text, dur = 2.2) {
    this.bubble.userData.setText(text);
    this.bubble.visible = true;
    this.bubbleT = dur;
  }

  goTo(target) {
    const p = this.sys.nav.findPath(this.pos, target);
    if (!p) return false;
    this.path = p;
    this.pi = 1;
    this.stuck = 0;
    this.lastD = 1e9;
    return true;
  }

  // Returns true when the path is finished.
  follow(dt) {
    if (!this.path || this.pi >= this.path.length) return true;
    const wp = this.path[this.pi];
    const to = new THREE.Vector3(wp.x - this.pos.x, 0, wp.z - this.pos.z);
    const d = to.length();
    const last = this.pi === this.path.length - 1;
    if (d < (last ? 0.35 : 0.6)) {
      this.pi++;
      return this.pi >= this.path.length;
    }
    this.desired = to.multiplyScalar(this.speed / d);
    this.anim = 'walk';
    // Stuck detection -> give up so the tree picks something else.
    this.stuck += dt;
    if (this.stuck > 1.5) {
      if (this.lastD - d < 0.3) return 'stuck';
      this.lastD = d;
      this.stuck = 0;
    }
    return false;
  }

  facePoint(p, dt, rate = 5) {
    this.heading = angleDamp(this.heading, Math.atan2(p.x - this.pos.x, p.z - this.pos.z), rate, dt);
  }

  update(dt, t) {
    this.desired = null;
    this.greetCooldown -= dt;
    this.anim = 'idle';
    this.sys.tree.tick(this.bb, dt);

    // Local avoidance: separation from other agents and the player.
    const sep = new THREE.Vector3();
    for (const o of this.sys.agents) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.7 * 0.7 && d2 > 1e-5) {
        const d = Math.sqrt(d2);
        sep.x += (dx / d) * (0.7 - d) * 3;
        sep.z += (dz / d) * (0.7 - d) * 3;
      }
    }
    const pp = G.player.pos;
    const pdx = this.pos.x - pp.x;
    const pdz = this.pos.z - pp.z;
    const pd = Math.hypot(pdx, pdz);
    if (pd < 0.85 && pd > 1e-4) {
      sep.x += (pdx / pd) * (0.85 - pd) * 6;
      sep.z += (pdz / pd) * (0.85 - pd) * 6;
    }
    const want = (this.desired || new THREE.Vector3()).add(sep);
    this.vel.lerp(want, 1 - Math.exp(-6 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.sys.colliders.resolve(this.pos, 0.28);
    if (this.desired && this.vel.lengthSq() > 0.05) {
      this.heading = angleDamp(this.heading, Math.atan2(this.vel.x, this.vel.z), 8, dt);
    }

    let anim = this.anim;
    if (this.override) {
      this.override.t -= dt;
      anim = this.override.anim;
      if (this.override.t <= 0) this.override = null;
    }
    const vNow = Math.hypot(this.vel.x, this.vel.z);
    if (anim === 'walk' && vNow < 0.12) anim = 'idle';
    animate(this.c, anim, anim === 'walk' ? vNow : this.speed, dt, t);
    this.c.root.position.copy(this.pos);
    setHeading(this.c, this.heading, dt);

    this.bubbleT -= dt;
    if (this.bubbleT <= 0) this.bubble.visible = false;
    this.label.visible = G.debug;
    if (G.debug) this.label.userData.setText(this.bb.current || '—');
  }
}

// ---------------------------------------------------------------- Behaviour tree shared by all visitors
function buildVisitorTree(sys) {
  const goToFn = (name, targetFn) =>
    new Action(name, {
      start: (bb, m) => {
        m.target = targetFn(bb);
        return bb.npc.goTo(m.target) ? RUNNING : FAILURE;
      },
      tick: (bb, m, dt) => {
        const r = bb.npc.follow(dt);
        if (r === 'stuck') return FAILURE;
        return r ? SUCCESS : RUNNING;
      },
    });
  const near = (p, r) => V(p.x + rand(-r, r), p.z + rand(-r * 0.5, r * 0.5));

  const watchFireworks = new Action('Watch fireworks', {
    tick: (bb, m, dt) => {
      bb.npc.anim = 'watch';
      bb.npc.facePoint(L.fireworksCenter, dt);
      return G.fireworksActive ? RUNNING : SUCCESS;
    },
  });
  const watchTaiko = new Action('Watch taiko', {
    tick: (bb, m, dt) => {
      bb.npc.anim = G.taikoHype > 0.6 ? 'cheer' : 'watch';
      bb.npc.facePoint(L.taiko, dt);
      return G.taikoActive ? RUNNING : SUCCESS;
    },
  });
  const react = new Action('React to player', {
    start: (bb, m) => {
      m.t = 2.2;
      const nightTime = sys.world.tod > 0.7;
      bb.npc.say(pick(nightTime ? ['こんばんは!', 'Konbanwa!', 'Nice night!', 'Fireworks soon!'] : ['こんにちは!', 'Konnichiwa!', 'Try the takoyaki!', 'Hot today…']));
      bb.npc.greetCooldown = rand(18, 30);
    },
    tick: (bb, m, dt) => {
      m.t -= dt;
      bb.npc.anim = 'wave';
      bb.npc.facePoint(G.player.pos, dt, 8);
      return m.t > 0 ? RUNNING : SUCCESS;
    },
  });
  const choose = new Action('Choose destination', {
    tick: (bb) => {
      const poi = pick(sys.pois.filter((p) => p !== bb.poi));
      bb.poi = poi;
      bb.dest = near(poi.pos, poi.spread);
      return SUCCESS;
    },
  });
  const interact = new Action('Interact', {
    start: (bb, m) => {
      m.t = rand(...bb.poi.dur);
    },
    tick: (bb, m, dt) => {
      m.t -= dt;
      const poi = bb.poi;
      bb.current = poi.name;
      bb.npc.anim = m.t < 1.2 && poi.then ? poi.then : poi.anim;
      bb.npc.facePoint(bb.npc.pos.clone().add(poi.face), dt);
      return m.t > 0 ? RUNNING : SUCCESS;
    },
  });

  return new Selector([
    new Guard(() => G.fireworksActive, new Sequence([goToFn('Go to fireworks', () => near(L.viewing, 4.5)), watchFireworks])),
    new Guard((bb) => G.taikoActive && bb.npc.likesTaiko, new Sequence([goToFn('Gather at taiko', () => V(L.taiko.x + rand(-4, 4), L.taiko.z + rand(4, 5.5))), watchTaiko])),
    new Guard((bb) => bb.npc.greetCooldown <= 0 && bb.npc.pos.distanceTo(G.player.pos) < 2.4 && G.mode === 'explore', react),
    new Sequence([choose, goToFn('Walk', (bb) => bb.dest), interact]),
  ]);
}

// ---------------------------------------------------------------- Stall owners: finite state machine
export class Owner {
  constructor(sys, stall) {
    this.sys = sys;
    this.stall = stall;
    this.c = makeCharacter({ gender: 'm', yukata: ['#27324a', '#ffffff'] });
    // Hachimaki headband
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.018, 6, 16), new THREE.MeshStandardMaterial({ color: '#ffffff' }));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.05;
    this.c.head.add(band);
    this.pos = stallOwnerPos(stall);
    this.baseHeading = stall.side < 0 ? 0 : Math.PI;
    this.heading = this.baseHeading;
    this.state = 'idle';
    this.t = 0;
    this.greeted = false;
    this.bubble = textSprite('', { height: 0.26, bg: 'rgba(255,248,235,0.92)', color: '#3a1d12' });
    this.bubble.position.y = 2.3;
    this.bubble.visible = false;
    this.c.root.add(this.bubble);
    this.c.root.position.copy(this.pos);
    sys.scene.add(this.c.root);
    this.label = textSprite('', { height: 0.22 });
    this.label.position.y = 2.05;
    this.c.root.add(this.label);
  }

  say(text) {
    this.bubble.userData.setText(text);
    this.bubble.visible = true;
    this.bubbleT = 2.2;
  }

  thank() {
    this.state = 'response';
    this.t = 1.8;
    this.say('ありがとう! Arigatō!');
  }

  update(dt, t) {
    const d = this.pos.distanceTo(G.player.pos);
    this.t -= dt;
    switch (this.state) {
      case 'idle':
        if (d < 4 && !this.greeted) {
          this.state = 'interact';
          this.t = 2.4;
          this.greeted = true;
          this.say('いらっしゃいませ!');
        }
        if (d > 7) this.greeted = false;
        break;
      case 'interact':
        if (this.t <= 0 || d > 5) this.state = 'idle';
        break;
      case 'response':
        if (this.t <= 0) this.state = 'idle';
        break;
    }
    const anim = { idle: 'cook', interact: 'wave', response: 'bow' }[this.state];
    const target = this.state === 'interact' ? Math.atan2(G.player.pos.x - this.pos.x, G.player.pos.z - this.pos.z) : this.baseHeading;
    this.heading = angleDamp(this.heading, target, 5, dt);
    this.c.root.rotation.y = this.heading;
    animate(this.c, anim, 1, dt, t);
    this.bubbleT -= dt;
    if (this.bubbleT <= 0) this.bubble.visible = false;
    this.label.visible = G.debug;
    if (G.debug) this.label.userData.setText(`FSM: ${this.state}`);
  }
}

// ---------------------------------------------------------------- Taiko drummer on the stage
export class Drummer {
  constructor(sys, standPos) {
    this.sys = sys;
    this.c = makeCharacter({ gender: 'm', yukata: ['#f4f0e6', '#b3202a'], obi: '#b3202a' });
    const stickM = new THREE.MeshStandardMaterial({ color: '#d9b98a' });
    this.c.armL.add(new THREE.Mesh(GEO.stick, stickM));
    this.c.armR.add(new THREE.Mesh(GEO.stick, stickM));
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.02, 6, 16), new THREE.MeshStandardMaterial({ color: '#b3202a' }));
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.05;
    this.c.head.add(band);
    this.home = standPos.clone();
    this.aside = standPos.clone().add(V(-2, 0.4));
    this.pos = standPos.clone();
    this.c.root.position.copy(this.pos);
    this.c.strike = 0;
    this.c.strikeSide = 0;
    this.beatT = 0;
    this.lastHit = G.drumHit;
    sys.scene.add(this.c.root);
    this.label = textSprite('', { height: 0.22 });
    this.label.position.y = 2.05;
    this.c.root.add(this.label);
  }

  update(dt, t) {
    const playerPlaying = G.mode === 'taiko';
    const target = playerPlaying ? this.aside : this.home;
    this.pos.x = damp(this.pos.x, target.x, 3, dt);
    this.pos.z = damp(this.pos.z, target.z, 3, dt);
    this.c.root.position.set(this.pos.x, this.home.y, this.pos.z);
    this.c.root.rotation.y = 0; // faces +z toward the audience
    let anim;
    if (playerPlaying) {
      anim = G.taikoHype > 0.6 ? 'cheer' : 'watch';
    } else {
      // Ambient festival drumming: two strikes per second.
      anim = 'drum';
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = pick([0.5, 0.5, 0.25, 0.75]);
        this.c.strike = 1;
        this.c.strikeSide ^= 1;
        const dist = this.pos.distanceTo(G.player.pos);
        if (dist < 30 && G.mode === 'explore') sfx.don(Math.max(0, 0.5 - dist / 60));
      }
      this.c.strike = damp(this.c.strike, 0, 12, dt);
    }
    animate(this.c, anim, 1, dt, t);
    this.label.visible = G.debug;
    if (G.debug) this.label.userData.setText(playerPlaying ? 'Spectating' : 'Performing');
  }
}

// ---------------------------------------------------------------- System
export class NPCSystem {
  constructor(scene, world, nav) {
    this.scene = scene;
    this.world = world;
    this.nav = nav;
    this.colliders = world.colliders;
    this.pois = buildPOIs();
    this.tree = buildVisitorTree(this);
    this.agents = [];
    const spawnSpots = [V(-7, 0.5), V(-3, -0.8), V(1, 0.6), V(5, -0.4), V(12, 0), V(16, 1), V(20, -1), V(24, 0.5), V(28, -0.5), V(33, 1), V(38, -1), V(31, 5.8)];
    for (const s of spawnSpots) this.agents.push(new Visitor(this, s));
    this.owners = STALLS.map((s) => new Owner(this, s));
    this.drummer = new Drummer(this, new THREE.Vector3(L.taiko.x, 1.05, L.taiko.z - 1.3));
    this.pets = addPets(this);
    this.pathLines = new THREE.Group();
    scene.add(this.pathLines);
  }

  ownerOf(stall) {
    return this.owners.find((o) => o.stall === stall);
  }

  update(dt, t) {
    // Festival events (prize won, firework burst, taiko combo) make nearby visitors cheer.
    for (const e of G.events) {
      for (const a of this.agents) {
        if (a.pos.distanceTo(e.pos) < 10 && !a.override) a.override = { anim: 'cheer', t: rand(1, 1.8) };
      }
    }
    G.events.length = 0;
    for (const a of this.agents) a.update(dt, t);
    for (const p of this.pets) p.update(dt, t);
    for (const o of this.owners) o.update(dt, t);
    this.drummer.update(dt, t);

    this.pathLines.visible = G.debug;
    if (G.debug) {
      for (const l of this.pathLines.children) l.geometry.dispose();
      this.pathLines.clear();
      this.lineMat ??= new THREE.LineBasicMaterial({ color: 0x33ffcc });
      for (const a of this.agents) {
        if (!a.path || a.pi >= a.path.length) continue;
        const pts = [a.pos.clone().setY(0.15), ...a.path.slice(a.pi).map((p) => p.clone().setY(0.15))];
        this.pathLines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.lineMat));
      }
    }
  }
}
