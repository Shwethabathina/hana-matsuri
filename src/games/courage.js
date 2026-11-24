import * as THREE from 'three';
import { G } from '../state.js';
import { sfx, startHorror, setHorror, stopHorror } from '../audio.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { angleDamp, canvasTexture, glowTexture, textSprite } from '../util.js';
import { makeCharacter, animate } from '../npc.js';

// Test of Courage — "Find the Three Mystical Seals".
// A timed stealth challenge on the haunted forest loop:
//   * three seals spawn at validated, reachable spots (one per section of the forest, re-rolled each run);
//   * spirits (wanderers on the path, watchers guarding the seals) perceive the player with distance +
//     field of view + line of sight against the tree trunks, hear running, and escalate
//     patrol -> investigate -> chase -> return, pathfinding around trees on a walkable grid;
//   * a fear meter rises when spotted / chased / caught and recovers when safe (100% = fail);
//   * collect all three, then escape to the shrine-side exit before the timer runs out.
export const DIFF = {
  easy: { label: 'Easy', time: 240, detect: 0.6, chase: 2.2, range: 6, wander: 4, watch: 2, giveUp: 2, hint: 26, mult: 0.8, gate: 75, fuel: 0.6 },
  normal: { label: 'Normal', time: 180, detect: 1, chase: 2.6, range: 7, wander: 5, watch: 3, giveUp: 3, hint: 14, mult: 1, gate: 55, fuel: 0.9 },
  hard: { label: 'Hard', time: 130, detect: 1.45, chase: 3.0, range: 8, wander: 6, watch: 3, giveUp: 4, hint: 7, mult: 1.3, gate: 40, fuel: 1.2 },
};
const CELL = 0.5;
const RATINGS = [
  [2600, 'S', 'Fearless Explorer'],
  [2000, 'A', 'Spirit Whisperer'],
  [1400, 'B', 'Brave Wanderer'],
  [0, 'C', 'Festival Survivor'],
];

export class CourageChallenge {
  constructor(ctx, kimo) {
    this.ctx = ctx;
    this.kimo = kimo;
    this.curve = kimo.curve;
    this.running = false;
    this.spirits = [];
    this.seals = [];
    this.entry = this.curve.getPointAt(0.015).setY(0);
    this.exit = this.curve.getPointAt(0.985).setY(0);
    const scene = ctx.world.scene;

    // Three seal objects: a glowing ofuda talisman with drifting motes.
    const tex = canvasTexture(128, 256, (g, w, h) => {
      g.fillStyle = '#f4ead2';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#b3202a';
      g.lineWidth = 6;
      g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#b3202a';
      g.font = 'bold 74px "Yu Mincho", serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('封', w / 2, h / 2 - 34);
      g.font = 'bold 48px "Yu Mincho", serif';
      g.fillText('印', w / 2, h / 2 + 46);
    });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.56), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, emissive: '#ffd9a0', emissiveMap: tex, emissiveIntensity: 0.6 }));
      paper.position.y = 1.15;
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffcf7a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(1.4);
      glow.position.y = 1.15;
      const motes = [];
      for (let m = 0; m < 6; m++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffe2a8', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        s.scale.setScalar(0.12);
        s.userData.phase = Math.random() * 6;
        motes.push(s);
        g.add(s);
      }
      g.add(paper, glow);
      g.visible = false;
      scene.add(g);
      const seal = { g, paper, glow, motes, pos: new THREE.Vector3(), taken: false, anim: 0 };
      this.seals.push(seal);
      ctx.world.addInteractable({
        id: 'courage-seal', pos: seal.pos, radius: 1.7, priority: true,
        label: () => (this.ritual ? 'Performing the ritual…' : this.seals.indexOf(seal) === 0 ? 'Take the mystical seal' : 'Begin the sealing ritual'),
        enabled: () => this.running && !seal.taken && seal.g.visible && seal.g.scale.x > 0.5 && this.clear(G.player.pos.x, G.player.pos.z, seal.pos.x, seal.pos.z),
        action: () => (this.seals.indexOf(seal) === 0 ? this.collect(seal) : this.startRitual(seal, this.seals.indexOf(seal) === 1 ? 2 : this.diff === 'easy' ? 2.5 : 3)),
      });
    }

    // Exit beacon at the shrine end of the path (shown once all seals are found).
    this.exitBeacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#9ad8ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.exitBeacon.scale.set(1.6, 4.5, 1);
    this.exitBeacon.position.copy(this.exit).setY(2);
    this.exitBeacon.visible = false;
    scene.add(this.exitBeacon);

    // Screen-edge fear vignette (DOM overlay, no extra render pass).
    this.fearEl = document.createElement('div');
    this.fearEl.id = 'fear-edge';
    document.body.appendChild(this.fearEl);
    // Hiding feedback: reed frame over the view + a status chip; and an edge arrow pointing at danger.
    this.reedEl = Object.assign(document.createElement('div'), { id: 'reeds' });
    this.chipEl = Object.assign(document.createElement('div'), { id: 'hidechip' });
    this.dangerEl = Object.assign(document.createElement('div'), { id: 'danger' });
    this.dangerEl.innerHTML = '<span>▲</span>';
    document.body.append(this.reedEl, this.chipEl, this.dangerEl);
    this.hinted = new Set();
  }

  // ------------------------------------------------------------------ navigation grid of the forest
  buildGrid() {
    if (this.grid) return;
    const pts = Array.from({ length: 80 }, (_, i) => this.curve.getPointAt(i / 79));
    const minX = Math.min(...pts.map((p) => p.x)) - 9;
    const maxX = Math.max(...pts.map((p) => p.x)) + 9;
    const minZ = Math.min(...pts.map((p) => p.z)) - 9;
    const maxZ = Math.max(...pts.map((p) => p.z)) + 4;
    const w = Math.ceil((maxX - minX) / CELL);
    const h = Math.ceil((maxZ - minZ) / CELL);
    const C = this.ctx.world.colliders;
    const free = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) free[j * w + i] = C.blocked(minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL, 0.35) ? 0 : 1;
    this.grid = { minX, minZ, w, h, free };
    this.reach = this.flood(this.entry);
    // Tree trunks near the path block sight.
    this.trees = C.circles.filter((c) => pts.some((p) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 196));
  }

  cellOf(x, z) {
    const g = this.grid;
    const i = Math.floor((x - g.minX) / CELL);
    const j = Math.floor((z - g.minZ) / CELL);
    return i < 0 || j < 0 || i >= g.w || j >= g.h ? -1 : j * g.w + i;
  }

  flood(from) {
    const g = this.grid;
    const seen = new Uint8Array(g.w * g.h);
    const s = this.cellOf(from.x, from.z);
    if (s < 0) return seen;
    const q = [s];
    seen[s] = 1;
    for (let h = 0; h < q.length; h++) {
      const k = q[h];
      const i = k % g.w;
      const j = (k - i) / g.w;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const nk = nj * g.w + ni;
        if (seen[nk] || !g.free[nk]) continue;
        seen[nk] = 1;
        q.push(nk);
      }
    }
    return seen;
  }

  // Breadth-first path on the grid (8-connected, no corner cutting) -> list of world points.
  // Nearest walkable, reachable forest cell to p (spirits never target or stand outside the forest).
  clampToForest(p) {
    const g = this.grid;
    const k0 = this.cellOf(p.x, p.z);
    if (k0 >= 0 && this.reach[k0] && g.free[k0]) return p.clone().setY(0);
    const ci = Math.min(g.w - 1, Math.max(0, Math.floor((p.x - g.minX) / CELL)));
    const cj = Math.min(g.h - 1, Math.max(0, Math.floor((p.z - g.minZ) / CELL)));
    for (let r = 1; r < 60; r++) {
      let best = -1;
      let bd = Infinity;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (i < 0 || j < 0 || i >= g.w || j >= g.h || (Math.abs(i - ci) !== r && Math.abs(j - cj) !== r)) continue;
          const k = j * g.w + i;
          if (!this.reach[k] || !g.free[k]) continue;
          const dd = (i - ci) ** 2 + (j - cj) ** 2;
          if (dd < bd) {
            bd = dd;
            best = k;
          }
        }
      }
      if (best >= 0) {
        const i = best % g.w;
        return new THREE.Vector3(g.minX + (i + 0.5) * CELL, 0, g.minZ + ((best - i) / g.w + 0.5) * CELL);
      }
    }
    return this.entry.clone();
  }

  // Keep a target inside the spirit's territory and inside the forest.
  territorial(s, p) {
    const c = s.territory?.c || s.home;
    const r = s.aggressive ? 1e9 : s.territory?.r || 14;
    const q = p.clone().setY(0);
    const dx = q.x - c.x;
    const dz = q.z - c.z;
    const d = Math.hypot(dx, dz);
    if (d > r) q.set(c.x + (dx / d) * r, 0, c.z + (dz / d) * r);
    return this.clampToForest(q);
  }

  path(from, to, maxNodes = 4000) {
    if (this.grid) {
      from = this.clampToForest(from);
      to = this.clampToForest(to);
    }
    const g = this.grid;
    const s = this.cellOf(from.x, from.z);
    const t = this.cellOf(to.x, to.z);
    if (s < 0 || t < 0) return []; // never a straight line out of the forest (see clampToForest)
    const prev = new Map([[s, s]]);
    const q = [s];
    let best = s;
    let bestD = Infinity;
    const ti = t % g.w;
    const tj = (t - ti) / g.w;
    for (let h = 0; h < q.length && h < maxNodes; h++) {
      const k = q[h];
      const i = k % g.w;
      const j = (k - i) / g.w;
      const dd = (i - ti) ** 2 + (j - tj) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = k;
      }
      if (k === t) break;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const nk = nj * g.w + ni;
        if (!g.free[nk] || prev.has(nk)) continue;
        if (di && dj && (!g.free[j * g.w + ni] || !g.free[nj * g.w + i])) continue;
        prev.set(nk, k);
        q.push(nk);
      }
    }
    const out = [];
    let k = best;
    while (k !== s) {
      const i = k % g.w;
      out.push(new THREE.Vector3(g.minX + (i + 0.5) * CELL, 0, g.minZ + ((k - i) / g.w + 0.5) * CELL));
      k = prev.get(k);
    }
    return out.reverse();
  }

  // 2D line of sight against tree trunks.
  clear(ax, az, bx, bz) {
    if (!this.trees) return true;
    const dx = bx - ax;
    const dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    for (const c of this.trees) {
      const u = Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / L2));
      if (u < 0.03 || u > 0.97) continue;
      const px = ax + dx * u - c.x;
      const pz = az + dz * u - c.z;
      if (px * px + pz * pz < (c.r + 0.05) ** 2) return false;
    }
    return true;
  }

  isFree(p, r = 0.6) {
    const k = this.cellOf(p.x, p.z);
    return k >= 0 && this.reach[k] && !this.ctx.world.colliders.blocked(p.x, p.z, r);
  }

  // ------------------------------------------------------------------ setup
  // A validated spot 'lo'–'hi' metres off the path within path section [a, b] (free and reachable).
  pickSpot(a, b, lo, hi, avoid = []) {
    for (let k = 0; k < 200; k++) {
      const t = a + Math.random() * (b - a);
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const side = (Math.random() < 0.5 ? -1 : 1) * (lo + Math.random() * (hi - lo));
      const q = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
      if (!this.isFree(q)) continue;
      if (avoid.some((c) => c.distanceTo(q) < 8)) continue;
      return { q, t };
    }
    return { q: this.curve.getPointAt((a + b) / 2).setY(0), t: (a + b) / 2 };
  }

  // Trial 1: three ruined shrines off the first stretch of path; only one is true. Sacred marks that only
  // show in lantern light lead from the path to it. Trial 2's seal sits in the guardian's clearing.
  placeSeals() {
    const a = this.pickSpot(0.11, 0.18, 3.5, 6, [this.entry]);
    const b = this.pickSpot(0.2, 0.26, 3.5, 6, [this.entry, a.q]);
    const c = this.pickSpot(0.27, 0.33, 3.5, 6, [this.entry, a.q, b.q]);
    this.shrines = [a, b, c].map((x) => ({ pos: x.q, t: x.t, used: false, isTrue: false }));
    this.trueShrine = this.shrines[Math.floor(Math.random() * 3)];
    this.trueShrine.isTrue = true;
    const s1 = { q: this.trueShrine.pos.clone().add(new THREE.Vector3(0, 0, 0.01)) };
    const s2 = this.pickSpot(0.45, 0.56, 3, 5, [s1.q]);
    [s1.q, s2.q].forEach((q, i) => this.seals[i].pos.copy(q));
    for (const sh of this.shrines) {
      if (sh.registered) continue;
      sh.registered = true;
    }
    if (!this.shrineHooks) {
      this.shrineHooks = true;
      for (let i = 0; i < 3; i++) {
        this.ctx.world.addInteractable({
          id: 'courage-shrine', pos: new THREE.Vector3(), radius: 1.6, priority: true,
          get label() { return 'Offer a prayer at the shrine'; },
          enabled: () => this.running && this.trial === 1 && this.shrines?.[i] && !this.shrines[i].used && G.player.pos.distanceTo(this.shrines[i].pos) < 1.7,
          action: () => this.pray(this.shrines[i]),
        });
        const it = this.ctx.world.interactables[this.ctx.world.interactables.length - 1];
        Object.defineProperty(it, 'pos', { get: () => this.shrines?.[i]?.pos || this.entry });
      }
    }
    this.seals.forEach((s) => {
      s.g.position.copy(s.pos);
      s.g.visible = false;
      s.taken = false;
      s.anim = 0;
      s.g.scale.setScalar(1);
      s.paper.material.opacity = 1;
      s.glow.material.opacity = 0.6;
      s.paper.position.y = 1.15;
      s.glow.scale.setScalar(1.4);
    });
  }

  makeSpirit(kind, home, heading, a = 0, b = 0, modelKey = 'kasa') {
    const assets = this.ctx.spirits || {};
    const g = new THREE.Group();
    let model = null;
    let mixer = null;
    const src = assets[modelKey] || assets.kasa;
    if (src) {
      model = modelKey === 'guardian' ? SkeletonUtils.clone(src.scene) : src.scene.clone();
      model.visible = true; // the source may be hidden (the Spirit Realm hides its guardian when idle)
      if (modelKey === 'guardian') {
        model.scale.setScalar(0.75);
        mixer = new THREE.AnimationMixer(model);
        const clip = (n) => src.animations.find((x) => x.name.endsWith('|' + n));
        model.userData.acts = { idle: clip('Idle') && mixer.clipAction(clip('Idle')), run: clip('Run') && mixer.clipAction(clip('Run')) };
        model.userData.acts.idle?.play();
      }
      g.add(model);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: kind === 'watch' ? '#c79aff' : '#7ac8ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(model ? 0.6 : 1.0);
    glow.position.y = 1.15;
    g.add(glow);
    const half = THREE.MathUtils.degToRad((kind === 'watch' ? 70 : 90) / 2);
    const R = this.d.range + (kind === 'watch' ? 2 : 0);
    const cone = new THREE.Mesh(
      new THREE.CircleGeometry(R, 28, Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x6ab8ff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    cone.position.y = 0.05;
    g.add(cone);
    const mark = textSprite('?', { font: 40, height: 0.3, bg: 'rgba(10,6,14,0.75)', color: '#ffd24a' });
    mark.position.y = 2.1;
    mark.visible = false;
    g.add(mark);
    g.position.copy(home);
    this.ctx.world.scene.add(g);
    return {
      kind, g, model, glow, cone, mark, R, fovCos: Math.cos(half), modelKey, mixer, float: modelKey === 'hannya' || modelKey === 'tengu',
      territory: { c: (kind === 'wander' ? this.curve.getPointAt((a + b) / 2) : home).clone().setY(0), r: kind === 'hunter' ? 24 : kind === 'watch' ? 11 : 15 },
      pos: home.clone(), home: home.clone(), homeHeading: heading, heading, a, b,
      t: a + Math.random() * Math.max(0.001, b - a), dir: 1, pause: 0, look: 0,
      state: 'patrol', sus: 0, route: [], routeT: 0, lostT: 0, stun: 0, waitT: 0, target: home.clone(), senseT: Math.random() * 0.1,
    };
  }

  spawnSpirits() {
    for (const sp of this.spirits) this.ctx.world.scene.remove(sp.g);
    this.spirits = [];
    // Trial 1 — two light-drawn wanderers patrol the first stretch of the path.
    // Fewer, purposeful spirits: Trial 1 has one light-drawn wanderer on Easy, two otherwise.
    const t1 = this.diff === 'easy' || this.mode === 'cursed' ? [[0.12, 0.3]] : [[0.08, 0.19], [0.2, 0.32]];
    for (const [a, b] of t1) this.spirits.push(Object.assign(this.makeSpirit('wander', this.curve.getPointAt(a).setY(0), 0, a, b), { trial: 1 }));
    // Kodama are forest spirits, not enemies: one guide watches over the true shrine of trial 1,
    // two act as alarms at choke points (trials 2 and 3); the rest stay hidden during the challenge.
    const kd = this.kimo.kodama || [];
    const alarms = new Set([5, 9]);
    kd.forEach((k, i) => {
      k.visible = alarms.has(i);
      k.userData.role = alarms.has(i) ? 'alarm' : null;
    });
    if (this.trueShrine && kd.length) {
      const guide = kd.filter((_, i) => !alarms.has(i)).sort((a, b) => a.position.distanceTo(this.trueShrine.pos) - b.position.distanceTo(this.trueShrine.pos))[0];
      const spot = this.clampToForest(this.trueShrine.pos.clone().add(new THREE.Vector3(1.6, 0, -1.2)));
      guide.userData.home = guide.userData.home || guide.position.clone();
      guide.position.copy(spot);
      guide.visible = true;
      guide.userData.role = 'guide';
      this.guideKodama = guide;
    }
    // Trial 2 — a guardian watcher stares at the second seal; one wanderer passes nearby.
    const seal = this.seals[1];
    let post = null;
    for (let k = 0; k < 32 && !post; k++) {
      const ang = (k / 32) * Math.PI * 2;
      const q = new THREE.Vector3(seal.pos.x + Math.cos(ang) * 3.2, 0, seal.pos.z + Math.sin(ang) * 3.2);
      if (this.isFree(q, 0.4) && this.clear(q.x, q.z, seal.pos.x, seal.pos.z)) post = q;
    }
    if (post) {
      const g = this.makeSpirit('watch', post, Math.atan2(seal.pos.x - post.x, seal.pos.z - post.z), 0, 0, 'hannya');
      g.guard = true;
      g.trial = 2;
      g.waitMax = 5; // a lured guardian searches the noise for a few seconds before returning
      this.spirits.push(g);
      this.guard = g;
    }
    // Trial 2's stalker: the big imp roams the guardian's stretch of path.
    if (this.mode !== 'cursed' || this.diff !== 'easy') this.spirits.push(Object.assign(this.makeSpirit('wander', this.curve.getPointAt(0.4).setY(0), 0, 0.38, 0.6, 'guardian'), { trial: 2 }));
    // Trial 3's sentinel: a tengu mask flies back and forth between the safe lanterns.
    if (this.mode !== 'cursed' || this.diff === 'hard') this.spirits.push(Object.assign(this.makeSpirit('wander', this.curve.getPointAt(0.84).setY(0), 0, 0.84, 0.9, 'tengu'), { trial: 3 }));
    // Trial 3 — the Rokurokubi and her seal; safe lanterns on the escape route.
    this.spawnHunter();
    this.buildSafeZones();
    this.buildHides();
    this.buildLevel();
  }

  // Stone lanterns whose light the Rokurokubi cannot enter.
  buildSafeZones() {
    this.safe = [];
    for (const t of [0.82, 0.91]) {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      let pos = null;
      for (const side of [1.4, -1.4, 0.6, -0.6, 0]) {
        const q = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
        if (this.isFree(q, 0.5)) {
          pos = q;
          break;
        }
      }
      if (!pos) continue;
      const L = this.ctx.spirits?.lantern;
      if (L) {
        const lan = L.scene.clone();
        lan.position.copy(pos);
        this.ctx.world.scene.add(lan);
        this.props.push(lan);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.25, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.position.copy(pos).setY(0.06);
      this.ctx.world.scene.add(ring);
      this.props.push(ring);
      const light = this.ctx.world.addLight(new THREE.Vector3(pos.x, 1.1, pos.z), { color: 0xffb070, base: 5, distance: 7, flicker: 0.2 });
      this.safe.push({ pos, r: 2.2, ring, light });
    }
  }

  // Reed clumps to hide in: along trial 1, around the guardian's seal, and on the escape route.
  buildHides(custom) {
    this.hides = [];
    const spots = [];
    const near = (center, rMin, rMax) => {
      for (let k = 0; k < 60; k++) {
        const a = Math.random() * Math.PI * 2;
        const r = rMin + Math.random() * (rMax - rMin);
        const q = new THREE.Vector3(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
        if (this.isFree(q, 0.6) && !spots.some((o) => o.distanceTo(q) < 4)) return q;
      }
      return null;
    };
    const pathPt = (t, side) => {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      for (const sd of [side, -side, side * 1.5, -side * 1.5]) {
        const q = new THREE.Vector3(p.x - tan.z * sd, 0, p.z + tan.x * sd);
        if (this.isFree(q, 0.6) && !spots.some((o) => o.distanceTo(q) < 4)) return q;
      }
      return null;
    };
    const cands = custom ? custom.map(([t, side]) => pathPt(t, side)) : [pathPt(0.17, 2), pathPt(0.27, 2), near(this.seals[1].pos, 4, 7), near(this.seals[1].pos, 5, 8), pathPt(0.78, 2), pathPt(0.87, 2), near(this.seals[2].pos, 4, 7)];
    for (const q of cands) if (q) spots.push(q);
    const reedMat = new THREE.MeshStandardMaterial({ color: '#4a5a2a', roughness: 1 });
    const tipMat = new THREE.MeshStandardMaterial({ color: '#8a7a4a', roughness: 1 });
    for (const pos of spots) {
      const g = new THREE.Group();
      for (let i = 0; i < 26; i++) {
        const h = 1.2 + Math.random() * 0.7;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.035, h, 4), i % 5 ? reedMat : tipMat);
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.55;
        blade.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
        blade.rotation.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3);
        g.add(blade);
      }
      g.position.copy(pos);
      this.ctx.world.scene.add(g);
      this.props.push(g);
      const spot = { pos, g };
      this.hides.push(spot);
      this.ctx.world.addInteractable({
        id: 'courage-hide', pos, radius: 1.4,
        label: () => (this.hidden === spot ? 'Leave the reeds' : 'Hide in the reeds'),
        enabled: () => this.running && this.hides?.includes(spot) && (!this.hidden || this.hidden === spot),
        action: () => this.toggleHide(spot),
      });
    }
  }

  // Hiding: invisible to spirits unless one saw you dive in — then it comes to drag you out.
  toggleHide(spot) {
    const P = G.player;
    if (this.hidden === spot) {
      this.hidden = null;
      sfx.rustle(0.6);
      return;
    }
    this.hidden = spot;
    // Only a spirit with real line of sight at this moment sees the player dive into the reeds.
    this.hideSeen = this.spirits.some((s) => s.realSeen && (s.state === 'chase' || s.state === 'investigate'));
    this.lastKnown = P.pos.clone();
    P.place(spot.pos, P.yaw);
    P.vel.set(0, 0, 0);
    sfx.rustle(1);
    if (this.hideSeen) sfx.whisper?.();
  }

  // ---------------------------------------------------------------- level dressing (route, landmarks, atmosphere)
  // Readable route: dim guide lanterns along the main path, a red torii at the start of each trial,
  // stepping-stone branches to the seal shrines (small ruined hokora), drifting hitodama for mood.
  buildLevel() {
    if (this.level) this.ctx.world.scene.remove(this.level);
    const L = new THREE.Group();
    this.level = L;
    const stone = new THREE.MeshStandardMaterial({ color: '#77746e', roughness: 1 });
    const darkWood = new THREE.MeshStandardMaterial({ color: '#3a2a20', roughness: 0.9 });
    const red = new THREE.MeshStandardMaterial({ color: '#8f1f1a', roughness: 0.7, emissive: '#2a0604', emissiveIntensity: 1 });
    const glowSprite = (color, scale, opacity = 0.8) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.scale.setScalar(scale);
      return sp;
    };
    const sideOf = (t, side) => {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      return new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
    };
    // Guide lanterns every ~7 m, alternating sides — the line of pale lights IS the route.
    const len = this.curve.getLength();
    const n = Math.floor(len / 7);
    this.guides = [];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      let q = null;
      for (const sd of [1.8, -1.8, 2.4, -2.4]) {
        const c = sideOf(t, (i % 2 ? 1 : -1) * Math.abs(sd) * Math.sign(sd));
        if (!this.ctx.world.colliders.blocked(c.x, c.z, 0.25)) {
          q = c;
          break;
        }
      }
      if (!q) continue;
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.8, 6), stone);
      post.position.y = 0.4;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.22), stone);
      box.position.y = 0.9;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.14, 4).rotateY(Math.PI / 4), stone);
      cap.position.y = 1.07;
      const flame = glowSprite('#9fc8ff', 0.55, 0.7);
      flame.position.y = 0.9;
      g.add(post, box, cap, flame);
      g.position.copy(q);
      L.add(g);
      this.guides.push({ flame, t });
    }
    // Trial gates: a red torii spanning the path where each trial begins, with a kanji plaque.
    const gate = (t, label) => {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const g = new THREE.Group();
      for (const s of [-1.5, 1.5]) {
        const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 2.7, 10), red);
        pil.position.set(s, 1.35, 0);
        g.add(pil);
      }
      const kasagi = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.18, 0.3), red);
      kasagi.position.y = 2.75;
      const nuki = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 0.18), red);
      nuki.position.y = 2.3;
      const plaque = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.55), new THREE.MeshBasicMaterial({ map: canvasTexture(64, 84, (c, w, h) => {
        c.fillStyle = '#1a120c';
        c.fillRect(0, 0, w, h);
        c.fillStyle = '#e8c27a';
        c.font = 'bold 44px "Yu Mincho", serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, w / 2, h / 2);
      }), side: THREE.DoubleSide }));
      plaque.position.y = 2.52;
      plaque.position.z = 0.1;
      g.add(kasagi, nuki, plaque);
      const lamp = glowSprite('#ff8a5a', 1.3, 0.55);
      lamp.position.y = 2.3;
      g.add(lamp);
      g.position.set(p.x, 0, p.z);
      g.rotation.y = Math.atan2(tan.x, tan.z);
      L.add(g);
    };
    if (this.mode === 'escape') {
      gate(0.035, '入');
      gate(0.965, '出');
    } else {
      gate(0.035, '一');
      gate(0.37, '二');
      gate(0.63, '三');
    }
    // Seal shrines: a small ruined hokora at seals 1 and 2, reached by stepping stones from the path.
    const shrineSites = this.mode === 'escape' ? [] : [...(this.shrines || []).map((x) => ({ pos: x.pos })), { pos: this.seals[1].pos }];
    for (const seal of shrineSites) {
      const sh = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.7), stone);
      base.position.y = 0.17;
      const hut = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.45, 0.45), darkWood);
      hut.position.y = 0.58;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.3, 4).rotateY(Math.PI / 4), darkWood);
      roof.position.y = 0.95;
      roof.rotation.z = 0.12; // weathered, slightly askew
      const broken = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.7, 6), stone);
      broken.position.set(0.7, 0.35, 0.3);
      broken.rotation.z = 0.5;
      sh.add(base, hut, roof, broken);
      sh.position.set(seal.pos.x + 0.9, 0, seal.pos.z + 0.6);
      L.add(sh);
      const near = this.curve.getPointAt(this.kimo.nearestT(seal.pos).t);
      const d = Math.hypot(seal.pos.x - near.x, seal.pos.z - near.z);
      for (let k = 1; k < d / 0.75; k++) {
        const u = k / (d / 0.75);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.06, 7), stone);
        st.position.set(near.x + (seal.pos.x - near.x) * u, 0.03, near.z + (seal.pos.z - near.z) * u);
        st.rotation.y = Math.random() * 3;
        L.add(st);
      }
    }
    // Sacred marks: glowing kanji on the ground from the path to the true shrine — visible only in lantern light.
    this.marks = [];
    if (this.trueShrine && this.mode !== 'escape') {
      const tex = canvasTexture(64, 64, (c, w, h) => {
        c.clearRect(0, 0, w, h);
        c.fillStyle = '#bfe8ff';
        c.font = 'bold 46px "Yu Mincho", serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('封', w / 2, h / 2 + 2);
      });
      const from = this.curve.getPointAt(Math.max(0.02, this.trueShrine.t - 0.04));
      const to = this.trueShrine.pos;
      const steps = Math.max(3, Math.round(from.distanceTo(to) / 1.6));
      for (let k = 1; k < steps; k++) {
        const u = k / steps;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        m.position.set(from.x + (to.x - from.x) * u, 0.04, from.z + (to.z - from.z) * u);
        m.rotation.y = Math.random() * 0.6;
        L.add(m);
        this.marks.push(m);
      }
    }
    // Hitodama: a few pale ghost-lights drifting near the path, always a little ahead of the player.
    this.wisps = [];
    for (let i = 0; i < 5; i++) {
      const w = glowSprite(i % 2 ? '#a8d8ff' : '#c8b8ff', 0.5, 0.6);
      L.add(w);
      this.wisps.push({ w, phase: Math.random() * 6, t: Math.random() });
    }
    // Hiding spots read as cover: faint firefly glints over each reed patch.
    for (const h of this.hides || []) {
      const ff = glowSprite('#c8ff8a', 0.25, 0.7);
      ff.position.copy(h.pos).setY(1.7);
      L.add(ff);
      h.fly = ff;
    }
    this.ctx.world.scene.add(L);
  }

  updateLevel(dt, t, P) {
    // Sacred marks glow only inside the lantern's light.
    for (const m of this.marks || []) {
      const d = Math.hypot(m.position.x - P.pos.x, m.position.z - P.pos.z);
      const want = this.trial === 1 && this.lanternOn && d < 6.5 ? 0.85 : 0;
      m.material.opacity += (want - m.material.opacity) * Math.min(1, dt * 4);
    }
    for (const g of this.guides || []) {
      g.flame.material.opacity = 0.45 + Math.sin(t * 5 + g.t * 40) * 0.12 + (Math.random() < 0.01 ? -0.3 : 0);
    }
    const here = this.kimo.nearestT(P.pos).t;
    for (const w of this.wisps || []) {
      w.t = (w.t + dt * 0.004) % 1;
      const tt = Math.min(0.99, here + 0.05 + ((w.t * 0.25 + w.phase * 0.01) % 0.2));
      const p = this.curve.getPointAt(tt);
      const tan = this.curve.getTangentAt(tt);
      const side = Math.sin(t * 0.3 + w.phase) * 6;
      w.w.position.set(p.x - tan.z * side, 1.3 + Math.sin(t * 0.9 + w.phase) * 0.5, p.z + tan.x * side);
      w.w.material.opacity = 0.35 + Math.sin(t * 3 + w.phase) * 0.25;
    }
    for (const h of this.hides || []) {
      if (!h.fly) continue;
      const d = h.pos.distanceTo(P.pos);
      h.fly.visible = d < 14 && this.hidden !== h;
      h.fly.position.set(h.pos.x + Math.sin(t * 1.3 + h.pos.x) * 0.4, 1.4 + Math.sin(t * 2 + h.pos.z) * 0.3, h.pos.z + Math.cos(t * 1.1 + h.pos.x) * 0.4);
      h.fly.material.opacity = 0.4 + Math.sin(t * 7 + h.pos.x) * 0.3;
    }
    // Cold, blue moonlit fog: the forest reads as cursed, not just dark.
    const W = this.ctx.world;
    W.scene.fog.color.lerp(new THREE.Color('#16203a'), 0.7);
  }

  inSafe(p) {
    return (this.safe || []).find((z) => Math.hypot(p.x - z.pos.x, p.z - z.pos.z) < z.r) || null;
  }

  // The Rokurokubi: a pale woman waiting beside a stone lantern deep in the forest. When she notices the
  // player her neck stretches and she hunts them by sight, sound and last known position. After the
  // third seal she turns aggressive and senses the player wherever they are.
  spawnHunter(ts = [0.72, 0.7, 0.74, 0.68, 0.76]) {
    let post = null;
    for (const t of ts) {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      for (const side of [3.5, -3.5, 4.5, -4.5]) {
        const q = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
        if (this.isFree(q, 0.5)) {
          post = { q, face: Math.atan2(p.x - q.x, p.z - q.z) };
          break;
        }
      }
      if (post) break;
    }
    if (!post) return;
    const s = this.makeSpirit('hunter', post.q, post.face);
    s.R = this.d.range + 2;
    s.fovCos = Math.cos(THREE.MathUtils.degToRad(50));
    s.cone.geometry.dispose();
    s.cone.geometry = new THREE.CircleGeometry(s.R, 28, Math.PI / 2 - THREE.MathUtils.degToRad(50), THREE.MathUtils.degToRad(100)).rotateX(-Math.PI / 2);
    s.glow.visible = false;
    if (s.model) {
      s.g.remove(s.model);
      s.model = null;
    }
    const geisha = this.ctx.spirits?.geisha;
    if (geisha) {
      // The geisha model: vertices above the shoulders rise with uExt, stretching the neck in the vertex shader.
      const body = geisha.scene.clone();
      const uni = { uExt: { value: 0 }, uBase: { value: 0 }, uH: { value: 1.7 } };
      body.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.material = o.material.clone();
        o.material.onBeforeCompile = (sh) => {
          Object.assign(sh.uniforms, uni);
          sh.vertexShader = 'uniform float uExt; uniform float uBase; uniform float uH;\n' + sh.vertexShader.replace('#include <project_vertex>', `
            vec4 wp = modelMatrix * vec4(transformed, 1.0);
            float hh = (wp.y - uBase) / uH;
            float k = smoothstep(0.80, 0.86, hh);
            wp.y += uExt * k;
            wp.x += sin(hh * 9.0) * 0.06 * uExt * k * (1.0 - k) * 4.0;
            vec4 mvPosition = viewMatrix * wp;
            gl_Position = projectionMatrix * mvPosition;`);
        };
        o.material.customProgramCacheKey = () => 'rokurokubi';
      });
      s.g.add(body);
      s.geisha = { body, uni };
      s.ext = 0;
      s.mark.position.y = 2.4;
    } else {
    const c = makeCharacter({ gender: 'f', yukata: ['#ece8e0', '#cfc7ba'], obi: '#1c1c1c', skin: '#e9e2d8', hair: '#060606', bun: false });
    c.root.traverse((o) => o.isMesh && (o.castShadow = true));
    // A neck that can stretch: a plain mesh on the upper-body bone, and the head bone lifted above it.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.042, 1, 10).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#e9e2d8', roughness: 0.8 }));
    neck.position.y = 0.6;
    neck.scale.y = 0.001;
    c.upper.add(neck);
    s.char = c;
    s.neck = neck;
    s.headY = c.head.position.y;
    s.ext = 0;
    s.g.add(c.root);
    s.mark.position.y = 2.4;
    }
    // Her lantern
    const L = this.ctx.spirits?.lantern;
    if (L) {
      const lan = L.scene.clone();
      lan.position.set(post.q.x + 0.9, 0, post.q.z + 0.6);
      this.ctx.world.scene.add(lan);
      this.props.push(lan);
    }
    this.hunterLight = this.ctx.world.addLight(new THREE.Vector3(post.q.x + 0.9, 1, post.q.z + 0.6), { color: 0xffb070, base: 4, distance: 8, flicker: 0.4 });
    if (this.mode !== 'escape') {
      // The third seal rests at her lantern, just in front of her: she must be approached unseen.
      const sealPos = new THREE.Vector3(post.q.x + 0.9, 0, post.q.z - 0.8);
      this.seals[2].pos.copy(this.isFree(sealPos, 0.3) ? sealPos : post.q.clone().add(new THREE.Vector3(0, 0, 1.2)));
      this.seals[2].g.position.copy(this.seals[2].pos);
    }
    this.spirits.push(s);
    this.hunter = s;
  }

  // Seal 1: praying at a false shrine chills you (fear), the true one releases the first seal.
  pray(sh) {
    sh.used = true;
    if (!sh.isTrue) {
      this.fear = Math.min(100, this.fear + 14);
      sfx.whisper?.();
      this.ctx.ui.toast('Cold fingers brush your neck… this shrine is empty. Look for the sacred marks.');
      return;
    }
    sfx.suzu();
    this.collect(this.seals[0]);
  }

  // Rituals (seals 2 and 3): stay beside the seal, unseen, while the ritual completes.
  startRitual(seal, dur) {
    if (this.ritual) return;
    this.ritual = { seal, t: 0, dur, at: G.player.pos.clone() };
    sfx.chime();
  }

  updateRitual(dt, P) {
    const r = this.ritual;
    if (!r) return;
    const moved = Math.hypot(P.pos.x - r.seal.pos.x, P.pos.z - r.seal.pos.z) > 1.9;
    const seenBy = this.spirits.find((s) => s.seen && !s.aggressive);
    if (moved || seenBy) {
      this.ritual = null;
      sfx.fail?.();
      this.ctx.ui.toast(moved ? 'You stepped away — the ritual fades.' : 'You were seen — the ritual is broken!');
      return;
    }
    r.t += dt;
    if (r.t >= r.dur) {
      this.ritual = null;
      this.collect(r.seal);
    }
  }

  // Ofuda ward (R): a limited protective charm — spirits' senses dim for a few seconds and anything
  // chasing you loses track and searches where it last saw you.
  useWard() {
    if (this.charms <= 0 || this.ward > 0) return;
    this.charms--;
    this.ward = 6;
    sfx.suzu();
    for (const s of this.spirits) if (s.state === 'chase') s.lostT = 99;
    document.body.classList.add('ward');
    this.ctx.ui.toast(`The ofuda flares — the spirits lose your scent (${this.charms} left)`);
  }

  // Player tools: the hand lantern (L) and pebbles to throw (Q).
  key(code) {
    if (code === 'KeyX' && this.running) return this.giveUp?.();
    if (!this.running) return;
    if (code === 'KeyL') {
      this.lanternOn = !this.lanternOn && this.fuel > 0;
      this.ctx.ui.toast(this.lanternOn ? 'Lantern lit — you can see, but so can they.' : 'Lantern dimmed — harder to see, harder to be seen.');
    }
    if (code === 'KeyQ') this.throwPebble();
    if (code === 'KeyR') this.useWard();
  }

  throwPebble() {
    if (this.pebbles <= 0 || this.pebble) return;
    this.pebbles--;
    const P = G.player;
    const f = P.forward;
    let land = P.pos.clone();
    for (let d = 1; d <= 8; d += 0.5) {
      const q = P.pos.clone().addScaledVector(f, d);
      if (!this.isFree(q, 0.15)) break;
      land = q;
    }
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: '#8a8580' }));
    this.ctx.world.scene.add(m);
    this.pebble = { m, from: P.pos.clone().setY(1.4), to: land, t: 0 };
  }

  // ------------------------------------------------------------------ flow
  intro() {
    const P = G.player;
    P.enabled = false;
    P.unlock();
    const best = (k) => {
      try {
        const v = localStorage.getItem(`hm-courage-best-${k}`);
        return v ? ` · best ${v}` : '';
      } catch {
        return '';
      }
    };
    this.ctx.ui.complete(
      `<div class="dlg-role">肝試し · Test of Courage</div><h2 class="fin">The Three Trials</h2>
       <p><b>1 · The Hidden Shrine</b> — three ruined shrines, one true. Sacred marks glow only in lantern light, and light draws the spirits.<br>
       <b>2 · Outwit the Guardian</b> — a spirit watches the second seal. Lure it away and perform the ritual unseen.<br>
       <b>3 · The Rokurokubi</b> — take the last seal from beside her lantern, then escape to the gate. She cannot enter the light of the stone lanterns.</p>
       <p class="muted"><b>E</b> take a seal · <b>C</b> crouch (harder to see, silent) · <b>Shift</b> run (spirits hear it) · <b>L</b> hand lantern (see more, be seen more; limited oil) · <b>Q</b> throw a pebble (spirits investigate the noise). Spirits cannot see through trees. Being spotted, chased or caught raises your <b>fear</b> — at 100% you flee the forest.</p>
       <p class="muted">No time limit while you explore — only the final escape is timed. If terror overwhelms you, you wake at the last shrine you reached. <b>R</b> burns one of your ofuda charms: for a few seconds the spirits cannot sense you.</p>`,
      [
        [`Easy${best('easy')}`, () => this.start('easy')],
        [`Normal${best('normal')}`, () => this.start('normal')],
        [`Hard${best('hard')}`, () => this.start('hard')],
        ['Not now', () => (G.player.enabled = true)],
      ],
    );
  }

  start(diff) {
    this.buildGrid();
    this.diff = diff;
    this.d = DIFF[diff];
    this.timer = 0; // elapsed time (no global limit; only the final escape has a countdown)
    this.checkpoint = this.entry.clone();
    this.faints = 0;
    this.charms = 2;
    this.ward = 0;
    this.ritual = null;
    this.reedSearch = 0;
    this.fear = 0;
    this.spotted = 0;
    this.caught = 0;
    this.found = 0;
    this.hbT = 0;
    this.fuel = 70;
    this.grace = 2;
    this.trial = 1;
    this.guard = null;
    this.safe = [];
    this.lastSafe = null;
    this.revealed = false;
    this.hidden = null;
    this.hideSeen = false;
    this.hinted = new Set();
    this.lanternOn = true;
    this.pebbles = 3;
    this.gate = null;
    this.stillT = 0;
    for (const p of this.props || []) this.ctx.world.scene.remove(p);
    this.props = [];
    this.hunter = null;
    if (this.hunterLight) this.hunterLight.pos.set(0, -50, 0);
    this.ctx.world.fogBoost = 0.008;
    this.placeSeals();
    this.spawnSpirits();
    this.exitBeacon.visible = false;
    this.banner(1);
    this.running = true;
    this.kimo.active = true;
    document.body.classList.add('courage');
    const P = G.player;
    P.place(this.entry, this.headingAlong(0.015));
    P.vel.set(0, 0, 0);
    P.enabled = true;
    try {
      this.ctx.canvas?.requestPointerLock?.();
    } catch {}
    sfx.whisper?.();
    startHorror();
    this.hud();
  }

  headingAlong(t) {
    const a = this.curve.getPointAt(t);
    const b = this.curve.getPointAt(Math.min(1, t + 0.02));
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  collect(seal) {
    if (seal.taken || !this.running) return;
    seal.g.scale.setScalar(1);
    seal.g.visible = true;
    seal.taken = true;
    seal.anim = 0.001;
    this.found++;
    this.fuel = Math.min(100, this.fuel + 30); // each seal glows with enough light to refill the lantern a little
    this.pebbles += 2;
    this.trial = this.found + 1;
    this.checkpoint = this.clampToForest(seal.pos.clone().add(new THREE.Vector3(0.8, 0, 0.8)));
    // A trial won is a breather: its spirits lose interest and drift home, and fear eases.
    for (const sp of this.spirits) {
      if ((sp.trial || 3) > this.found) continue;
      sp.sus = 0;
      sp.stun = 4;
      if (sp.state !== 'patrol') {
        sp.state = 'return';
        sp.route = this.path(sp.pos, sp.home);
      }
    }
    this.fear = Math.max(0, this.fear - 25);
    this.ctx.world.fogBoost = 0.008 + this.found * 0.01; // the forest grows thicker with every seal taken
    sfx.suzu();
    setTimeout(() => sfx.chime(), 250);
    if (this.found < 3) {
      this.ctx.ui.toast(`Seal ${this.found} / 3 — trial complete`);
      this.banner(this.trial);
      if (this.found === 2) this.kimo.scareDarkness(); // the forest reacts as the seals are broken
    } else {
      // Trial 3: taking her seal wakes the Rokurokubi. Escape to the shrine gate.
      this.exitBeacon.visible = true;
      this.gate = this.d.gate + 15; // only the final escape is timed
      if (this.hunter) {
        this.hunter.state = 'chase';
        this.hunter.aggressive = true;
        this.hunter.stun = 2.2; // a readable beat: her neck rises with a scream, then she comes
      }
      for (const z of this.safe) z.ring.material.opacity = 0.55;
      sfx.scare();
      this.banner(4);
    }
    this.hud();
  }

  end(won, reason) {
    if (!this.running) return;
    this.lastEnd = { won, reason, found: this.found, caught: this.caught, fear: Math.round(this.fear) };
    this.running = false;
    this.kimo.active = false;
    for (const s of this.spirits) this.ctx.world.scene.remove(s.g);
    this.spirits = [];
    for (const s of this.seals) s.g.visible = false;
    this.exitBeacon.visible = false;
    this.fearEl.style.opacity = 0;
    document.body.classList.remove('courage');
    this.ctx.ui.gameHud(null);
    this.cleanupExtras();
    const P = G.player;
    P.enabled = false;
    P.unlock();
    const retry = () => this.start(this.diff);
    const leave = () => {
      P.place(new THREE.Vector3(32, 0, -1.4), Math.PI);
      P.enabled = true;
    };
    if (!won) {
      this.ctx.ui.complete(
        `<div class="dlg-role">Test of Courage · ${this.d.label}</div><h2 class="fin">${reason === 'gate' ? 'The shrine gate closed' : 'Fear takes hold'}</h2>
         <p>${reason === 'gate' ? 'The gate sealed itself three times before you reached it.' : 'Terror overwhelmed you three times and you fled the forest.'} Seals found: <b>${this.found} / 3</b>.</p>`,
        [['Retry', retry], ['Return to the festival', leave]],
      );
      return;
    }
    const s = this.score();
    let bestText = '';
    try {
      const key = `hm-courage-best-${this.diff}`;
      const prev = Number(localStorage.getItem(key) || 0);
      if (s.total > prev) {
        localStorage.setItem(key, String(s.total));
        bestText = prev ? ' · <b>new personal best!</b>' : '';
      } else bestText = ` · personal best ${prev}`;
    } catch {}
    this.ctx.markDone?.('kimodameshi');
    this.ctx.ui.complete(
      `<div class="dlg-role">Test of Courage · ${this.d.label}</div><h2 class="fin">Rank ${s.rank} — ${s.title}</h2>
       <p>Score <b>${s.total}</b>${bestText}</p>
       <p class="muted">Completion ${s.base} · time ${Math.round(this.timer)}s (+${s.time}) · faints ${this.faints} · ${this.mode === 'cursed' ? 'curses' : 'seals'} +${s.seals} · spotted ${this.spotted}× (−${s.spot}) · caught ${this.caught}× (−${s.catch}) · fear ${Math.round(this.fear)}% (−${s.fearP}) · ×${this.d.mult} difficulty</p>`,
      [['Retry', retry], ['Return to the festival', leave]],
    );
  }

  // Trial banner + one-line hint (the HUD keeps it; the toast announces it).
  banner(n) {
    const T = {
      1: ['Trial 1 · The Hidden Shrine', 'Three ruined shrines hide in the trees; only one is true. Sacred marks glow in lantern light — but light draws the spirits. Pray at the right shrine (E).'],
      2: ['Trial 2 · Outwit the Guardian', 'Its gaze never leaves the seal. Lure it away with a pebble (Q), then perform the ritual (E) unseen — it takes a moment. Hide in the reeds if it turns back.'],
      3: ['Trial 3 · The Rokurokubi', 'Her seal rests at her lantern. She notices lantern light from far away — go dark, crouch, keep trees between you, then perform the ritual beside her.'],
      4: ['Escape!', 'She is awake. Dash from stone lantern to stone lantern (she cannot enter their light), or vanish into the reeds before she sees — then reach the shrine gate.'],
    };
    this.trialText = T[n];
    this.ctx.ui.toast(T[n][0]);
  }

  // Ground ripple where a pebble lands (feedback for the distraction).
  ripple(pos) {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.3, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false }));
    r.position.copy(pos).setY(0.05);
    this.ctx.world.scene.add(r);
    this.ripples = this.ripples || [];
    this.ripples.push({ r, t: 0 });
  }

  cleanupExtras() {
    stopHorror();
    // No forest ghost may follow the player out: stop any jump-scare / wisp effect still in flight.
    this.kimo.anim = null;
    if (this.kimo.ghost) this.kimo.ghost.visible = false;
    this.kimo.wispT = 0;
    this.kimo.wisps?.forEach((w) => (w.visible = false));
    this.kimo.flicker = 0;
    document.body.classList.remove('ward');
    if (this.level) {
      this.ctx.world.scene.remove(this.level);
      this.level = null;
    }
    for (const k of this.kimo.kodama || []) {
      k.visible = true;
      if (k.userData.home) k.position.copy(k.userData.home);
      k.userData.role = null;
    }
    this.reedEl?.classList.remove('on', 'seen');
    this.chipEl?.classList.remove('on');
    this.dangerEl?.classList.remove('on');
    this.hidden = null;
    this.hides = [];
    for (const z of this.safe || []) z.light.pos.set(0, -50, 0);
    this.safe = [];
    for (const p of this.props || []) this.ctx.world.scene.remove(p);
    this.props = [];
    if (this.hunterLight) this.hunterLight.pos.set(0, -50, 0);
    if (this.pebble) {
      this.ctx.world.scene.remove(this.pebble.m);
      this.pebble = null;
    }
    this.ctx.world.fogBoost = 0;
    this.hunter = null;
  }

  // Deterministic, transparent score.
  score() {
    const base = 1000;
    const time = Math.round(Math.max(0, 600 - this.timer) * 1.2); // efficiency bonus, no hard limit
    const seals = this.found * 200;
    const spot = this.spotted * 60;
    const c = this.caught * 150;
    const fearP = Math.round(this.fear * 3) + (this.faints || 0) * 200;
    const total = Math.max(0, Math.round((base + time + seals - spot - c - fearP) * this.d.mult));
    const [, rank, title] = RATINGS.find(([min]) => total >= min);
    return { base, time, seals, spot, catch: c, fearP, total, rank, title };
  }

  hud() {
    const m = Math.floor(Math.max(0, this.timer) / 60);
    const s = String(Math.floor(Math.max(0, this.timer) % 60)).padStart(2, '0');
    const fear = Math.round(this.fear);
    const objective = this.trialText?.[0] || 'The Three Trials';
    const ritual = this.ritual ? ` · <b style="color:#ffd24a">Ritual ${(this.ritual.t).toFixed(1)} / ${this.ritual.dur}s — stay still and unseen</b>` : '';
    const alarm = this.spirits.some((x) => x.state === 'chase') ? 'A spirit is chasing you!' : this.spirits.some((x) => x.state === 'investigate') ? 'Something is searching…' : '';
    const gate = this.gate !== null ? ` · <span style="color:#ff8a7a">Gate closes in <b>${Math.ceil(this.gate)}s</b></span>` : '';
    this.ctx.ui.gameHud(`<div class="gh-title">肝試し · ${objective}</div>
      <div>Seals <b>${this.found} / 3</b> · ${m}:${s}${gate} · Fear <b>${fear}%</b>${ritual} ${alarm ? `· <span style="color:#ff8a7a">${alarm}</span>` : ''}</div>
      <div class="gf-dev">${this.trialText?.[1] || ''}</div>
      <div class="gf-dev">Lantern ${this.lanternOn ? 'lit' : 'dark'} · oil ${Math.round(this.fuel)}% (L) · pebbles ${this.pebbles} (Q) · ofuda ${this.charms}${this.ward > 0 ? ` <b style="color:#ffd24a">active ${Math.ceil(this.ward)}s</b>` : ''} (R) · crouch C${this.inSafe(G.player.pos) ? ' · <b style="color:#ffc27a">safe in the lantern light</b>' : ''}${this.hidden ? ` · <b style="color:#9ad88a">${this.hideSeen ? 'hiding — but it saw you!' : 'hidden in the reeds'}</b>` : ''}</div>
      <div class="bar"><span style="width:${fear}%;background:${fear > 70 ? '#ff5a5a' : fear > 40 ? '#ffb05a' : '#7cf29a'}"></span></div>`);
  }

  // ------------------------------------------------------------------ per frame
  update(dt, t) {
    if (!this.running) return;
    const P = G.player;
    this.timer += dt;
    if (this.gate !== null) {
      this.gate -= dt;
      if (this.gate <= 0) return this.faint('gate');
    }
    this.ward = Math.max(0, (this.ward || 0) - dt);
    if (this.ward <= 0) document.body.classList.remove('ward');
    this.updateRitual(dt, P);
    // Hand lantern: burns oil while lit; light lets you see but makes you easier to spot.
    if (this.lanternOn) {
      this.fuel = Math.max(0, this.fuel - dt * this.d.fuel);
      if (this.fuel <= 0) {
        this.lanternOn = false;
        this.ctx.ui.toast('Your lantern sputters out of oil…');
      }
    }
    this.kimo.handLight.intensity = this.lanternOn ? 3.4 + Math.sin(t * 9) * 0.2 : 0.5;
    this.kimo.handLight.distance = this.lanternOn ? 15 : 6;
    // Moonlight through the canopy keeps the forest readable (suspense, not blindness); it fades as fog thickens.
    const W = this.ctx.world;
    W.hemi.intensity += 0.22 - this.found * 0.03;
    W.hemi.color.lerp(new THREE.Color('#7f95c8'), 0.5);
    // Thrown pebble: arcs to its landing spot; spirits nearby go to investigate the sound.
    if (this.pebble) {
      const pb = this.pebble;
      pb.t += dt / 0.6;
      const k = Math.min(1, pb.t);
      pb.m.position.lerpVectors(pb.from, pb.to, k);
      pb.m.position.y = 1.4 * (1 - k) + Math.sin(k * Math.PI) * 1.2 + 0.05;
      if (k >= 1) {
        sfx.thock?.();
        for (const s of this.spirits) {
          if (s.state === 'chase' || s.pos.distanceTo(pb.to) > 11) continue;
          s.state = 'investigate';
          s.target = pb.to.clone();
          s.route = this.path(s.pos, s.target);
          s.waitT = 0;
          s.sus = Math.max(s.sus, 0.4);
          if (s.guard) this.ctx.ui.toast('The guardian turns toward the sound — now!');
        }
        this.ripple(pb.to);
        this.ctx.world.scene.remove(pb.m);
        this.pebble = null;
      }
    }
    // Dynamic ghost: linger too long in one place and something drifts past behind you.
    this.stillT = P.vel.length() < 0.3 ? this.stillT + dt : 0;
    if (this.stillT > 11) {
      this.stillT = 0;
      this.kimo.scareGlide();
      this.fear = Math.min(100, this.fear + 6);
    }

    // Seals: bob, glow visible from a difficulty-dependent distance, motes drift up.
    for (const [i, s] of this.seals.entries()) {
      if (!s.taken && i === this.trial - 1) s.g.visible = true;
      if (!s.g.visible) continue;
      if (s.anim > 0) {
        // Collection: the talisman rises, spins and dissolves into light.
        s.anim += dt;
        const k = Math.min(1, s.anim / 1.2);
        s.paper.position.y = 1.15 + k * 1.2;
        s.paper.rotation.y += dt * 12;
        s.glow.scale.setScalar(1.4 + k * 2.5);
        s.glow.material.opacity = 1 - k;
        s.paper.material.opacity = 1 - k;
        s.paper.material.transparent = true;
        if (k >= 1) s.g.visible = false;
        continue;
      }
      const d = Math.hypot(s.pos.x - P.pos.x, s.pos.z - P.pos.z);
      // Only the current trial's seal exists; trial 1's seal only shows itself inside lantern light.
      const idx = this.seals.indexOf(s);
      if (idx !== this.trial - 1) {
        s.g.visible = false;
        continue;
      }
      if (idx === 0) {
        // The first seal rests in the true shrine and only appears when the prayer is answered.
        s.g.scale.setScalar(0.001);
        continue;
      }
      if (idx === -1) {
        const lit = this.lanternOn && d < 7;
        if (lit && !this.revealed) {
          this.revealed = true;
          sfx.chime();
          this.ctx.ui.toast('Something glints in the lantern light…');
        }
        s.g.scale.setScalar(lit ? 1 : 0.001);
      }
      s.paper.position.y = 1.15 + Math.sin(t * 2 + s.pos.x) * 0.06;
      s.paper.rotation.y = t * 0.8;
      s.glow.material.opacity = d < this.d.hint ? 0.55 + Math.sin(t * 3) * 0.2 : 0.12;
      s.motes.forEach((m) => {
        const u = (t * 0.4 + m.userData.phase) % 1;
        m.position.set(Math.sin(m.userData.phase * 3 + t) * 0.35, 0.5 + u * 1.6, Math.cos(m.userData.phase * 2 + t) * 0.35);
        m.material.opacity = (1 - u) * (d < this.d.hint * 1.4 ? 0.8 : 0.2);
      });
    }

    this.grace = Math.max(0, (this.grace || 0) - dt);
    // At most two spirits chase at once; any extra one falls back to searching.
    const chasers = this.spirits.filter((s) => s.state === 'chase' && !s.aggressive).sort((a, b) => b.sus - a.sus);
    for (const s of chasers.slice(2)) {
      s.state = 'investigate';
      s.target = this.territorial(s, s.lastSeenPos || s.pos);
      s.route = this.path(s.pos, s.target);
      s.waitT = 0;
    }
    // The Rokurokubi's neck rises over the reeds: if she searches right beside your hiding place, she
    // finds you after a few seconds (a clear warning first) — hiding is not an invincibility button.
    const h = this.hunter;
    if (h && this.hidden && !this.hideSeen && (h.state === 'investigate' || h.aggressive) && h.pos.distanceTo(this.hidden.pos) < 3.2) {
      this.reedSearch += dt;
      if (this.reedSearch > 3.2) {
        this.hideSeen = true;
        sfx.scare();
        this.ctx.ui.toast('Her neck curls over the reeds — she found you! RUN!');
      }
    } else this.reedSearch = Math.max(0, this.reedSearch - dt);
    // Dread: the lantern gutters when something dangerous is near; distant rustles from unseen spirits.
    const nearDanger = this.spirits.some((s) => (s.kind === 'hunter' || s.state === 'chase') && s.pos.distanceTo(P.pos) < 11);
    if (nearDanger && this.lanternOn && Math.random() < 0.15) this.kimo.handLight.intensity *= 0.3;
    this.rustleT = (this.rustleT || 4) - dt;
    if (this.rustleT <= 0) {
      this.rustleT = 6 + Math.random() * 8;
      const unseen = this.spirits.find((s) => s.pos.distanceTo(P.pos) < 18 && !s.seen);
      if (unseen) sfx.rustle(0.3);
    }
    for (const rp of this.ripples || []) {
      rp.t += dt;
      rp.r.scale.setScalar(1 + rp.t * 6);
      rp.r.material.opacity = Math.max(0, 0.7 - rp.t);
      if (rp.t > 0.8) this.ctx.world.scene.remove(rp.r);
    }
    this.ripples = (this.ripples || []).filter((rp) => rp.t <= 0.8);
    // Spirits
    let threat = 0;
    for (const s of this.spirits) threat = Math.max(threat, this.updateSpirit(s, dt, t, P));

    // Fear: rises with threat, recovers when safe.
    if (this.hidden) {
      P.vel.set(0, 0, 0);
      P.pos.x = this.hidden.pos.x;
      P.pos.z = this.hidden.pos.z;
      if (!this.hideSeen) threat = 0;
    }
    const zone = this.inSafe(P.pos);
    if (zone) threat = 0; // the stone lantern's light is a refuge
    if (threat > 0) this.fear = Math.min(100, this.fear + threat * dt);
    else this.fear = Math.max(0, this.fear - 7 * dt);
    if (this.fear >= 100) return this.faint('fear');
    this.fearEl.style.opacity = Math.max(0, (this.fear - 30) / 70) * 0.85;
    if (this.fear > 25) {
      this.hbT -= dt;
      if (this.hbT <= 0) {
        this.hbT = 1.3 - (this.fear / 100) * 0.8;
        sfx.don(0.15 + (this.fear / 100) * 0.35);
      }
    }

    // Exit
    if (zone) this.lastSafe = zone;
    if (this.found === 3 && !this.bellPending) {
      this.exitBeacon.material.opacity = 0.6 + Math.sin(t * 3) * 0.25;
      for (const z of this.safe) {
        z.ring.material.opacity = 0.55 + Math.sin(t * 4) * 0.25;
        z.ring.scale.setScalar(1 + Math.sin(t * 4) * 0.03);
      }
      if (Math.hypot(P.pos.x - this.exit.x, P.pos.z - this.exit.z) < 2.6) return this.end(true);
    }
    this.feedback(dt, P);
    this.updateLevel(dt, t, P);
    this.hudT = (this.hudT || 0) - dt;
    if (this.hudT <= 0) {
      this.hudT = 0.2;
      this.hud();
    }
  }

  // Checkpoints: overwhelming fear (or the gate closing) sends you back to the last seal shrine instead of
  // ending the run; spirits calm down and return to their territories.
  faint(reason) {
    this.faints++;
    if (this.faints >= (this.maxFaints || 3)) return this.end(false, reason); // three times overwhelmed: the run is lost
    this.fear = 35;
    this.hidden = null;
    this.ritual = null;
    const P = G.player;
    P.place(this.checkpoint, P.yaw);
    P.vel.set(0, 0, 0);
    for (const s of this.spirits) {
      s.sus = 0;
      s.stun = 4;
      if (!s.aggressive) {
        s.state = 'return';
        s.route = this.path(s.pos, s.home);
      }
    }
    if (this.hunter?.aggressive) {
      // The escape restarts: she returns to her lantern, the gate opens again.
      this.hunter.pos.copy(this.hunter.home);
      this.hunter.stun = 3;
      this.gate = this.mode === 'cursed' ? null : this.d.gate + 15;
    }
    sfx.scare();
    this.ctx.ui.toast(reason === 'gate' ? 'The gate sealed itself… you wake by her lantern. Try the escape again.' : 'Terror overwhelms you… you come to at the last shrine.');
  }

  // Readable state for the player: hidden / seen / searched, the Rokurokubi's direction and distance,
  // and one-time hints the first time a mechanic becomes relevant.
  feedback(dt, P) {
    const hunter = this.hunter;
    // Kodama are alarm spirits: if one sees you (and you are not crouched in the dark or hidden), it
    // rattles and calls the nearest idle spirit to come and look where you are.
    for (const k of this.kimo.kodama || []) {
      k.userData.cool = Math.max(0, (k.userData.cool || 0) - dt);
      if (k.userData.role === 'guide') {
        // The guide kodama watches the true shrine and chimes softly when you come near with a light.
        const want = Math.atan2(this.trueShrine.pos.x - k.position.x, this.trueShrine.pos.z - k.position.z);
        k.rotation.y += (Math.atan2(Math.sin(want - k.rotation.y), Math.cos(want - k.rotation.y))) * Math.min(1, dt * 2);
        if (this.trial === 1 && k.position.distanceTo(P.pos) < 7 && k.userData.cool <= 0) {
          k.userData.cool = 9;
          sfx.chime();
          if (!this.hinted.has('guide')) {
            this.hinted.add('guide');
            this.ctx.ui.toast('A kodama gazes at one of the shrines…');
          }
        }
        continue;
      }
      if (!k.visible || k.userData.role !== 'alarm' || k.userData.cool > 0 || this.hidden) continue;
      const d = Math.hypot(P.pos.x - k.position.x, P.pos.z - k.position.z);
      const reach = (this.lanternOn ? 4.5 : 2.5) * (1 - 0.4 * P.crouch);
      if (d > reach || !this.clear(k.position.x, k.position.z, P.pos.x, P.pos.z)) continue;
      k.userData.cool = 12;
      k.userData.rattle = 0.6;
      for (let i = 0; i < 5; i++) setTimeout(() => sfx.ka?.(0.35), i * 70);
      const near = this.spirits.filter((s) => s.state === 'patrol' && !s.guard && s.kind !== 'hunter').sort((a, b) => a.pos.distanceTo(P.pos) - b.pos.distanceTo(P.pos))[0];
      if (near && near.pos.distanceTo(P.pos) < 22) {
        near.state = 'investigate';
        near.target = P.pos.clone();
        near.route = this.path(near.pos, near.target);
        near.waitT = 0;
        near.sus = Math.max(near.sus, 0.45);
      }
      if (!this.hinted.has('kodama')) {
        this.hinted.add('kodama');
        this.ctx.ui.toast('A kodama rattled — it is calling the spirits to you! Crouch and dim your lantern near them.');
      }
    }
    for (const k of this.kimo.kodama || []) {
      if (k.userData.rattle > 0) {
        k.userData.rattle -= dt;
        k.rotation.z = Math.sin(performance.now() / 20) * 0.25 * Math.max(0, k.userData.rattle);
      } else k.rotation.z = 0;
    }
    // Music tension follows the danger.
    const chase = this.spirits.some((s) => s.state === 'chase');
    const search = this.spirits.some((s) => s.state === 'investigate');
    setHorror(Math.min(1, (chase ? 0.75 : search ? 0.4 : 0.1) + this.fear / 250));
    const searching = this.spirits.some((s) => s.state === 'investigate' || (s.aggressive && this.hidden && !this.hideSeen));
    this.reedEl.classList.toggle('on', !!this.hidden);
    this.reedEl.classList.toggle('seen', !!this.hidden && this.hideSeen);
    let chip = '';
    if (this.hidden) chip = this.hideSeen ? ['IT SAW YOU HIDE — get out and run!', '#ff4a4a', '#fff'] : this.reedSearch > 0.5 ? ['She is searching the reeds right above you — slip out and run!', '#ff7a3a', '#1a0804'] : searching ? ['Hidden · something is searching nearby — stay still', '#e8a52a', '#1a1004'] : ['Hidden in the reeds', '#3a7a3a', '#eaffea'];
    else if (this.ward > 0) chip = [`Ofuda ward — the spirits cannot sense you (${Math.ceil(this.ward)}s)`, '#c9a23a', '#1a1004'];
    else if (this.inSafe(P.pos) && hunter?.aggressive) chip = ['Safe in the lantern light — she cannot enter', '#c98a2a', '#1a1004'];
    this.chipEl.classList.toggle('on', !!chip);
    if (chip) Object.assign(this.chipEl.style, { background: chip[1], color: chip[2] }), (this.chipEl.textContent = chip[0]);
    // Danger arrow: where the Rokurokubi is, relative to where the player looks (only while she hunts).
    if (hunter && hunter.state !== 'patrol' && !this.inSafe(P.pos)) {
      const dx = hunter.pos.x - P.pos.x;
      const dz = hunter.pos.z - P.pos.z;
      const d = Math.hypot(dx, dz);
      const f = P.forward;
      const ang = Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
      const r = Math.min(innerWidth, innerHeight) * 0.36;
      this.dangerEl.classList.toggle('on', d < 16);
      this.dangerEl.style.transform = `translate(${Math.sin(ang) * r}px, ${-Math.cos(ang) * r}px) rotate(${ang}rad)`;
      this.dangerEl.style.opacity = Math.max(0.35, 1 - d / 16);
      this.whisperT = (this.whisperT || 0) - dt;
      if (d < 9 && this.whisperT <= 0) {
        this.whisperT = 1.2 + d * 0.15;
        sfx.whisper?.();
      }
    } else this.dangerEl.classList.remove('on');
    // One-time contextual hints.
    // At most one new hint every few seconds, so they never pile up.
    this.hintT = (this.hintT || 0) - dt;
    const once = (k, msg) => {
      if (this.hinted.has(k) || this.hintT > 0) return;
      this.hinted.add(k);
      this.hintT = 4;
      this.ctx.ui.toast(msg);
    };
    if (this.hides?.some((h) => h.pos.distanceTo(P.pos) < 3.5)) once('reeds', 'Tall reeds — press E to hide inside. Spirits lose you unless they watch you go in.');
    if (this.trial === 2 && this.guard && this.guard.pos.distanceTo(P.pos) < 11) once('pebble', 'The guardian watches the seal. Throw a pebble (Q) somewhere away from it to make it look.');
    if (this.trial === 1 && P.pos.distanceTo(this.seals[0].pos) < 12) once('lantern', 'The seal is near — only lantern light (L) reveals it.');
    if (P.crouch > 0.5 && this.spirits.some((s) => s.state === 'chase' && !s.aggressive)) once('run', 'It is chasing you — crouching is too slow to escape. Stand up and RUN (Shift), then hide.');
    if (hunter?.aggressive && !this.hinted.has('wake')) once('wake', 'She is awake! Run (Shift) to the glowing stone lanterns — she cannot enter their light.');
  }

  // Returns the fear rate this spirit causes right now.
  updateSpirit(s, dt, t, P) {
    s.stun = Math.max(0, s.stun - dt, this.grace || 0);
    const d = Math.hypot(P.pos.x - s.pos.x, P.pos.z - s.pos.z);
    // Perception at 10 Hz: distance (crouch shrinks it) + field of view + line of sight past trees; hearing.
    s.senseT -= dt;
    if (s.senseT <= 0) {
      s.senseT = 0.1;
      const light = this.trial === 1 ? (this.lanternOn ? 1.6 : 0.6) : this.lanternOn ? 1.25 : 0.85; // trial 1 spirits are drawn to light
      const R = s.R * (1 - 0.45 * P.crouch) * light;
      const dx = P.pos.x - s.pos.x;
      const dz = P.pos.z - s.pos.z;
      const inCone = d < R && (Math.sin(s.heading) * dx + Math.cos(s.heading) * dz) / (d || 1) > s.fovCos;
      s.realSeen = s.stun <= 0 && inCone && this.clear(s.pos.x, s.pos.z, P.pos.x, P.pos.z); // true line of sight right now
      s.seen = s.realSeen && (!this.hidden || this.hideSeen);
      s.heard = s.stun <= 0 && !this.hidden && P.running && P.vel.length() > 1 && d < (s.hearR || 5);
      if (this.ward > 0) {
        s.seen = s.seen && d < 2;
        s.heard = false;
      }
      // The Rokurokubi notices lantern light from far away, even when the player is outside her cone.
      if (s.kind === 'hunter' && !s.aggressive && this.lanternOn && !this.hidden && d < 14 && this.clear(s.pos.x, s.pos.z, P.pos.x, P.pos.z) && this.ward <= 0) s.lightSeen = true;
      else s.lightSeen = false;
      if (s.seen) s.lastSeenPos = P.pos.clone();
      s.closeness = Math.max(0, 1 - d / R);
    }
    if (s.aggressive) {
      // Final escape: she senses the player everywhere — but cannot enter a stone lantern's light,
      // so she prowls its edge instead, giving the player a place to breathe and plan the next dash.
      s.state = 'chase';
      s.seen = true;
      const z = this.inSafe(P.pos);
      const knows = this.mode !== 'cursed' || (s.realSeen && (!this.hidden || this.hideSeen)) || s.heard || d < 3;
      if (this.mode === 'cursed' && !knows && !z && !(this.hidden && !this.hideSeen)) {
        // Lost sight of you: she keeps momentum for a moment, then sweeps around where she last saw you,
        // drifting her guesses only roughly toward you — breaking line of sight genuinely buys time.
        s.seen = false;
        s.lostKnow = (s.lostKnow || 0) + dt;
        s.searchT = (s.searchT || 0) - dt;
        if (s.lostKnow < 1.2) s.target = P.pos.clone();
        else if (s.searchT <= 0 || !s.target || s.pos.distanceTo(s.target) < 1) {
          s.searchT = 3;
          const a = Math.random() * Math.PI * 2;
          const base = (s.lastSeenPos || P.pos).clone().lerp(P.pos, 0.35);
          s.target = this.clampToForest(base.add(new THREE.Vector3(Math.cos(a) * 5, 0, Math.sin(a) * 5)));
          s.route = this.path(s.pos, s.target);
        }
        s.searching = true;
      } else if (this.hidden && !this.hideSeen) {
        // Lost you in the reeds: she searches around where she last saw you.
        s.seen = false;
        s.searchT = (s.searchT || 0) - dt;
        if (s.searchT <= 0 || !s.target) {
          s.searchT = 2.2;
          const a = Math.random() * Math.PI * 2;
          s.target = this.lastKnown.clone().add(new THREE.Vector3(Math.cos(a) * 4, 0, Math.sin(a) * 4));
          s.route = this.path(s.pos, s.target);
        }
      } else if (z) {
        const away = new THREE.Vector3(s.pos.x - z.pos.x, 0, s.pos.z - z.pos.z);
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        away.normalize().multiplyScalar(z.r + 1.2);
        s.target = z.pos.clone().add(away);
      } else {
        s.target = P.pos.clone();
        s.lastSeenPos = P.pos.clone();
        if (s.lostKnow > 1.2) sfx.whisper?.(); // she found you again
        s.lostKnow = 0;
        s.searching = false;
      }
    }
    const gain = this.d.detect * (1 + 0.15 * this.found);
    if (s.seen) s.sus += dt * gain * (0.5 + 1.5 * s.closeness);
    else if (s.heard || s.lightSeen) {
      s.sus = Math.max(s.sus, 0.45);
      s.lastSeenPos = P.pos.clone();
    }
    else s.sus = Math.max(0, s.sus - dt * 0.3);

    // State transitions
    if (s.state !== 'chase' && s.sus >= 1) {
      s.state = 'chase';
      s.lostT = 0;
      this.spotted++;
      this.fear = Math.min(100, this.fear + 8);
      sfx.whisper?.();
    } else if ((s.state === 'patrol' || s.state === 'return') && s.sus > 0.35) {
      s.state = 'investigate';
      s.target = this.territorial(s, s.lastSeenPos || P.pos);
      s.route = this.path(s.pos, s.target);
      s.waitT = 0;
    }
    if (s.state === 'chase') {
      if (s.seen) {
        s.lostT = 0;
        if (!s.aggressive) s.target = this.territorial(s, P.pos); // never chase beyond its territory / the forest
      } else s.lostT += dt;
      s.routeT -= dt;
      if (s.routeT <= 0) {
        s.routeT = 0.4;
        s.route = this.path(s.pos, s.target);
      }
      if (s.lostT > this.d.giveUp * (s.kind === 'hunter' ? 1.7 : 1) && !s.aggressive) {
        // Line of sight broken: it does not track you perfectly — it searches where it last saw you.
        s.state = 'investigate';
        s.sus = 0.3;
        s.target = this.territorial(s, s.lastSeenPos || s.target);
        s.route = this.path(s.pos, s.target);
        s.waitT = 0;
        s.waitMax = s.kind === 'hunter' ? 4 : 3;
      }
      // Out of its territory: it gives up and goes home.
      if (!s.aggressive && s.territory && Math.hypot(P.pos.x - s.territory.c.x, P.pos.z - s.territory.c.z) > s.territory.r + 5) {
        s.state = 'return';
        s.sus = 0;
        s.route = this.path(s.pos, s.home);
      }
      if (d < 1.0 && s.stun <= 0 && !this.inSafe(P.pos) && (!this.hidden || this.hideSeen)) {
        if (this.hidden) {
          this.hidden = null; // dragged out of the reeds
          this.ctx.ui.toast('It pulled you out of the reeds!');
        }
        // Caught: fear spikes, the player is shoved away, the spirit drifts back to its post.
        this.caught++;
        this.fear = Math.min(100, this.fear + 18);
        this.grace = 3; // a moment for every spirit to lose interest
        P.shake = 0.25;
        if (s.aggressive && this.lastSafe) {
          // During the escape a catch throws the player back to the last lantern they reached.
          P.place(this.lastSafe.pos.clone().add(new THREE.Vector3(0.6, 0, 0.6)), P.yaw);
        } else {
          const away = new THREE.Vector3(P.pos.x - s.pos.x, 0, P.pos.z - s.pos.z).normalize();
          const to = P.pos.clone().addScaledVector(away, 1.6);
          if (this.isFree(to, 0.35)) P.pos.copy(to);
        }
        sfx.scare();
        this.ctx.ui.toast('A spirit caught you! Fear rises…');
        s.state = 'return';
        s.stun = s.aggressive ? (this.diff === 'easy' ? 3 : 1.8) : 4; // a fair head start after a catch
        s.sus = 0;
        s.route = this.path(s.pos, s.home);
        if (s.aggressive) s.state = 'chase';
      }
    }

    // Movement
    let speed = 0;
    if (s.state === 'patrol') {
      if (s.kind === 'wander') {
        if (s.pause > 0) {
          s.pause -= dt;
          s.look += dt;
        } else {
          s.t += (s.dir * 1.1 * dt) / this.curve.getLength();
          if (s.t > s.b || s.t < s.a) {
            s.t = Math.max(s.a, Math.min(s.b, s.t));
            s.dir *= -1;
            s.pause = 1.8;
            s.look = 0;
          }
          speed = 1.1;
        }
        const p = this.curve.getPointAt(s.t);
        s.pos.set(p.x, 0, p.z);
        const tan = this.curve.getTangentAt(s.t).multiplyScalar(s.dir);
        const base = Math.atan2(tan.x, tan.z);
        s.heading = angleDamp(s.heading, s.pause > 0 ? base + Math.sin(s.look * 2.2) * 1.1 : base, 4, dt);
      } else if (s.kind === 'hunter') {
        s.heading = angleDamp(s.heading, s.homeHeading + Math.sin(t * 0.35) * 0.5, 1.5, dt);
      } else {
        // Watchers sweep their gaze across the seal they guard.
        s.heading = angleDamp(s.heading, s.homeHeading + Math.sin(t * 0.6 + s.home.x) * (s.guard ? 0.45 : 0.9), 2, dt);
      }
    } else {
      const sp = s.state === 'chase' ? (s.aggressive ? Math.min(3.1, this.d.chase + 0.3) : this.d.chase + (s.kind === 'hunter' ? 0.3 : 0) + (s.chaseBonus || 0)) : s.searchSpeed || 1.3;
      const next = s.route[0];
      if (next) {
        const dx = next.x - s.pos.x;
        const dz = next.z - s.pos.z;
        const dd = Math.hypot(dx, dz);
        if (dd < 0.15) s.route.shift();
        else {
          s.pos.x += (dx / dd) * Math.min(dd, sp * dt);
          s.pos.z += (dz / dd) * Math.min(dd, sp * dt);
          s.heading = angleDamp(s.heading, Math.atan2(dx, dz), 6, dt);
          speed = sp;
        }
      } else if (s.state === 'investigate') {
        s.waitT += dt;
        s.heading += dt * 1.5; // looks around where it heard / glimpsed the player
        if (s.waitT > (s.waitMax || 2.5)) {
          s.state = 'return';
          s.route = this.path(s.pos, s.home);
        }
      } else if (s.state === 'return') {
        s.state = 'patrol';
        if (s.kind === 'wander') {
          // Rejoin the path at the nearest point of its section.
          s.t = Math.max(s.a, Math.min(s.b, this.kimo.nearestT(s.pos).t));
        }
      }
    }

    // Stay inside the forest (snap back to the nearest walkable cell if pushed into a tree or out of bounds).
    if (s.kind !== 'wander' || s.state !== 'patrol') {
      const k = this.cellOf(s.pos.x, s.pos.z);
      if (k < 0 || !this.reach[k] || !this.grid.free[k]) s.pos.copy(this.clampToForest(s.pos));
    }
    // Separation: spirits never stack on the same spot.
    for (const o of this.spirits) {
      if (o === s) continue;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const dd = Math.hypot(dx, dz);
      if (dd < 1.6 && dd > 1e-4 && !(s.state === 'patrol' && s.kind === 'wander')) {
        s.pos.x += (dx / dd) * (1.6 - dd) * 0.5;
        s.pos.z += (dz / dd) * (1.6 - dd) * 0.5;
      }
    }
    // Visuals
    s.g.position.copy(s.pos);
    s.g.rotation.y = s.heading;
    if (s.geisha) {
      const want = s.state === 'patrol' ? 0 : s.state === 'investigate' ? 0.45 : 1.1;
      if (want > 0.9 && s.ext < 0.3 && !s.screamed) {
        s.screamed = true;
        sfx.scare();
      }
      if (want === 0) s.screamed = false;
      s.ext += (want - s.ext) * (1 - Math.exp(-3 * dt));
      s.geisha.uni.uExt.value = s.ext + Math.sin(t * 2.3) * 0.04 * s.ext;
      s.geisha.uni.uBase.value = s.pos.y;
      s.geisha.body.position.y = speed > 0 ? Math.abs(Math.sin(t * 6)) * 0.03 : 0;
      s.geisha.body.rotation.z = speed > 0 ? Math.sin(t * 6) * 0.04 : 0;
    }
    if (s.char) {
      // Rokurokubi: the neck stretches when she is hunting.
      const want = s.state === 'patrol' ? 0 : s.state === 'investigate' ? 0.5 : 1.15;
      if (want > 0.9 && s.ext < 0.3 && !s.screamed) {
        s.screamed = true;
        sfx.scare();
      }
      if (want === 0) s.screamed = false;
      s.ext += (want - s.ext) * (1 - Math.exp(-3 * dt));
      s.char.head.position.y = s.headY + s.ext;
      s.neck.scale.y = Math.max(0.001, s.ext + 0.05);
      s.char.head.rotation.z = Math.sin(t * 1.7) * 0.25 * s.ext;
      animate(s.char, speed > 0 ? 'walk' : 'idle', speed > 0 ? speed * 0.6 : 1, dt, t);
    }
    if (s.model && s.float) {
      // Masks hover and drift; the tengu banks as it flies.
      s.model.position.y = (s.modelKey === 'tengu' ? 1.9 : 1.2) + Math.sin(t * 1.6 + s.home.x) * 0.15;
      s.model.rotation.z = s.modelKey === 'tengu' ? Math.sin(t * 2) * 0.15 : 0;
    } else if (s.mixer) {
      const A = s.model.userData.acts;
      const want = speed > 0 ? A.run : A.idle;
      if (want && want !== s.curAct) {
        want.reset().fadeIn(0.2).play();
        s.curAct?.fadeOut(0.2);
        s.curAct = want;
      }
      if (A.run) A.run.timeScale = Math.max(0.5, speed / 2.6);
      s.mixer.update(dt);
    } else if (s.model) {
      const hop = speed > 0 ? Math.abs(Math.sin(t * (4 + speed * 1.5) + s.home.x)) : 0;
      s.model.position.y = hop * 0.28;
      s.model.rotation.z = (hop - 0.5) * 0.1;
    }
    const col = s.state === 'chase' ? 0xff4a4a : s.state === 'investigate' || s.sus > 0.2 ? 0xffb05a : s.kind === 'watch' ? 0xb08aff : 0x6ab8ff;
    s.cone.material.color.setHex(col);
    s.cone.material.opacity = 0.08 + Math.min(1, s.sus) * 0.16;
    s.mark.visible = s.state === 'chase' || s.state === 'investigate';
    s.mark.position.y = s.char || s.geisha ? 2.3 + s.ext : s.float ? 2.6 : s.mixer ? 2.7 : 2.1;
    if (s.mark.visible) s.mark.userData.setText(s.state === 'chase' ? '!' : '?');

    // Fear contribution
    if (s.state === 'chase') return (d < 4 ? 8 : 4) * (s.kind === 'hunter' ? 1.3 : 1);
    if (s.seen) return 2;
    if (s.state === 'investigate' && d < 5) return 3;
    return 0;
  }

  // Leaving or resetting from elsewhere (e.g. the developer teleport).
  abort() {
    if (!this.running) return;
    this.cleanupExtras();
    this.running = false;
    this.kimo.active = false;
    for (const s of this.spirits) this.ctx.world.scene.remove(s.g);
    this.spirits = [];
    for (const s of this.seals) s.g.visible = false;
    this.exitBeacon.visible = false;
    this.fearEl.style.opacity = 0;
    document.body.classList.remove('courage');
    this.ctx.ui.gameHud(null);
  }
}
