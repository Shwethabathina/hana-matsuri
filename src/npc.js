import * as THREE from 'three';
import { G } from './state.js';
import { L, STALLS, stallFront, stallOwnerPos } from './layout.js';
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
function yukataTexture(base, accent) {
  const key = base + accent;
  if (patternCache.has(key)) return patternCache.get(key);
  const tex = canvasTexture(128, 128, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    g.fillStyle = accent;
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
  }, { repeat: [2, 2] });
  patternCache.set(key, tex);
  return tex;
}

const GEO = {
  skirt: new THREE.CylinderGeometry(0.17, 0.25, 0.8, 12).translate(0, 0.45, 0),
  torso: new THREE.CylinderGeometry(0.2, 0.17, 0.55, 12).translate(0, 0.27, 0),
  obi: new THREE.CylinderGeometry(0.188, 0.188, 0.15, 12).translate(0, 0.06, 0),
  head: new THREE.SphereGeometry(0.13, 16, 12),
  hair: new THREE.SphereGeometry(0.138, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
  bun: new THREE.SphereGeometry(0.07, 10, 8),
  sleeve: new THREE.CylinderGeometry(0.06, 0.1, 0.5, 8).translate(0, -0.25, 0),
  hand: new THREE.SphereGeometry(0.045, 8, 6).translate(0, -0.52, 0),
  foot: new THREE.BoxGeometry(0.09, 0.05, 0.22).translate(0, 0.025, 0),
  stick: new THREE.CylinderGeometry(0.018, 0.018, 0.45, 6).rotateX(Math.PI / 2).translate(0, -0.55, 0.18),
};
const SKINS = ['#f1c9a5', '#e0ac85', '#c98e66', '#f5d6bd'];
const YUKATA = [
  ['#1f3a73', '#ffffff'],
  ['#f2f2f2', '#2c5aa0'],
  ['#c23b4a', '#ffd9e0'],
  ['#2e6b5a', '#f1e3b3'],
  ['#5b3a8a', '#f7c6e4'],
  ['#e79a3a', '#7a2a1a'],
  ['#232323', '#e14b4b'],
  ['#7fb3d9', '#ffffff'],
];
const OBI = ['#d4a02a', '#b3202a', '#f3e5c0', '#2a2a2a', '#e86aa6'];

export function makeCharacter({ yukata = pick(YUKATA), obi = pick(OBI), skin = pick(SKINS), bun = Math.random() < 0.5 } = {}) {
  const cloth = new THREE.MeshStandardMaterial({ map: yukataTexture(yukata[0], yukata[1]), roughness: 0.85 });
  const skinM = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const hairM = new THREE.MeshStandardMaterial({ color: '#15110f', roughness: 0.5 });
  const obiM = new THREE.MeshStandardMaterial({ color: obi, roughness: 0.6 });
  const getaM = new THREE.MeshStandardMaterial({ color: '#8a6440' });

  const root = new THREE.Group();
  const skirt = new THREE.Mesh(GEO.skirt, cloth);
  const footL = new THREE.Mesh(GEO.foot, getaM);
  const footR = new THREE.Mesh(GEO.foot, getaM);
  footL.position.x = 0.08;
  footR.position.x = -0.08;
  const upper = new THREE.Group();
  upper.position.y = 0.85;
  const torso = new THREE.Mesh(GEO.torso, cloth);
  const obiMesh = new THREE.Mesh(GEO.obi, obiM);
  const headG = new THREE.Group();
  headG.position.y = 0.72;
  const head = new THREE.Mesh(GEO.head, skinM);
  const hair = new THREE.Mesh(GEO.hair, hairM);
  hair.position.set(0, 0.012, -0.012);
  hair.rotation.x = -0.25;
  headG.add(head, hair);
  if (bun) {
    const b = new THREE.Mesh(GEO.bun, hairM);
    b.position.set(0, 0.1, -0.1);
    headG.add(b);
  }
  const mkArm = (side) => {
    const a = new THREE.Group();
    a.position.set(0.22 * side, 0.5, 0);
    a.add(new THREE.Mesh(GEO.sleeve, cloth), new THREE.Mesh(GEO.hand, skinM));
    return a;
  };
  const armL = mkArm(1);
  const armR = mkArm(-1);
  upper.add(torso, obiMesh, headG, armL, armR);
  root.add(skirt, footL, footR, upper);
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return { root, upper, head: headG, armL, armR, footL, footR, phase: Math.random() * 10, pose: {} };
}

// Pose targets are damped so transitions between animations blend smoothly.
function animate(c, anim, speed, dt, t) {
  const P = {
    uX: 0, uY: 0.85, hX: 0, hY: 0,
    lX: 0, lZ: 0.08, rX: 0, rZ: -0.08,
    fl: 0, fr: 0, jump: 0,
  };
  switch (anim) {
    case 'walk': {
      c.phase += dt * speed * 5.2;
      const s = Math.sin(c.phase);
      P.fl = s * 0.13;
      P.fr = -s * 0.13;
      P.lX = -s * 0.4;
      P.rX = s * 0.4;
      P.uY = 0.85 + Math.abs(Math.cos(c.phase)) * 0.03;
      break;
    }
    case 'eat':
      P.rX = -1.7 + Math.max(0, Math.sin(t * 2.4)) * 0.5;
      P.rZ = 0.25;
      P.lX = -0.7;
      P.hX = 0.12;
      break;
    case 'watch':
      P.hX = -0.45;
      P.lX = -0.3;
      P.rX = -0.3;
      break;
    case 'look':
      P.hX = 0.2;
      P.hY = Math.sin(t * 0.6) * 0.4;
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
      P.lX = -1.2 - (c.strikeSide === 0 ? k : 0) * 1.1 + 0.9 * (c.strikeSide === 0 ? 0 : 0);
      P.rX = -1.2 - (c.strikeSide === 1 ? k : 0) * 1.1;
      P.uX = 0.1;
      break;
    }
    default: // idle
      P.uY = 0.85 + Math.sin(t * 2 + c.phase) * 0.006;
      P.hY = Math.sin(t * 0.4 + c.phase) * 0.25;
  }
  const d = (key, target, rate = 10) => {
    c.pose[key] = damp(c.pose[key] ?? target, target, rate, dt);
    return c.pose[key];
  };
  c.upper.rotation.x = d('uX', P.uX, 8);
  c.upper.position.y = d('uY', P.uY, 14) + d('jump', P.jump, 20);
  c.head.rotation.x = d('hX', P.hX, 6);
  c.head.rotation.y = d('hY', P.hY, 4);
  c.armL.rotation.x = d('lX', P.lX, 12);
  c.armL.rotation.z = d('lZ', P.lZ, 12);
  c.armR.rotation.x = d('rX', P.rX, 12);
  c.armR.rotation.z = d('rZ', P.rZ, 12);
  c.footL.position.z = d('fl', P.fl, 14);
  c.footR.position.z = d('fr', P.fr, 14);
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
    this.c = makeCharacter();
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
    animate(this.c, anim, this.speed, dt, t);
    this.c.root.position.copy(this.pos);
    this.c.root.rotation.y = this.heading;

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
    this.c = makeCharacter({ yukata: ['#27324a', '#ffffff'], bun: false });
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
    this.c = makeCharacter({ yukata: ['#f4f0e6', '#b3202a'], obi: '#b3202a', bun: false });
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
