import * as THREE from 'three';
import { G } from '../state.js';
import { sfx } from '../audio.js';
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
const DIFF = {
  easy: { label: 'Easy', time: 240, detect: 0.6, chase: 2.2, range: 6, wander: 4, watch: 2, giveUp: 2, hint: 26, mult: 0.8, gate: 80, fuel: 0.6 },
  normal: { label: 'Normal', time: 180, detect: 1, chase: 2.6, range: 7, wander: 5, watch: 3, giveUp: 3, hint: 14, mult: 1, gate: 60, fuel: 0.9 },
  hard: { label: 'Hard', time: 130, detect: 1.45, chase: 3.0, range: 8, wander: 6, watch: 3, giveUp: 4, hint: 7, mult: 1.3, gate: 42, fuel: 1.2 },
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
        label: 'Take the mystical seal',
        enabled: () => this.running && !seal.taken && this.clear(G.player.pos.x, G.player.pos.z, seal.pos.x, seal.pos.z),
        action: () => this.collect(seal),
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
  path(from, to, maxNodes = 4000) {
    const g = this.grid;
    const s = this.cellOf(from.x, from.z);
    const t = this.cellOf(to.x, to.z);
    if (s < 0 || t < 0) return [to.clone()];
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
  // Candidate seal spots: 2–6 m off the path, free, reachable, one per forest section, re-rolled each run.
  placeSeals() {
    const zones = [[0.14, 0.38], [0.4, 0.63], [0.66, 0.88]];
    const chosen = [];
    for (const [a, b] of zones) {
      const cands = [];
      for (let k = 0; k < 140; k++) {
        const t = a + Math.random() * (b - a);
        const p = this.curve.getPointAt(t);
        const tan = this.curve.getTangentAt(t);
        const side = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4);
        const q = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
        if (!this.isFree(q)) continue;
        if (q.distanceTo(this.entry) < 8 || q.distanceTo(this.exit) < 8) continue;
        if (chosen.some((c) => c.distanceTo(q) < 9)) continue;
        cands.push({ q, t });
      }
      const pick = cands[Math.floor(Math.random() * cands.length)] || { q: this.curve.getPointAt((a + b) / 2).setY(0), t: (a + b) / 2 };
      chosen.push(pick.q);
    }
    this.seals.forEach((s, i) => {
      s.pos.copy(chosen[i]);
      s.g.position.copy(chosen[i]);
      s.g.visible = true;
      s.taken = false;
      s.anim = 0;
      s.g.scale.setScalar(1);
    });
  }

  makeSpirit(kind, home, heading, a = 0, b = 0) {
    const assets = this.ctx.spirits || {};
    const g = new THREE.Group();
    let model = null;
    if (assets.kasa) {
      model = assets.kasa.scene.clone();
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
      kind, g, model, glow, cone, mark, R, fovCos: Math.cos(half),
      pos: home.clone(), home: home.clone(), homeHeading: heading, heading, a, b,
      t: a + Math.random() * Math.max(0.001, b - a), dir: 1, pause: 0, look: 0,
      state: 'patrol', sus: 0, route: [], routeT: 0, lostT: 0, stun: 0, waitT: 0, target: home.clone(), senseT: Math.random() * 0.1,
    };
  }

  spawnSpirits() {
    for (const s of this.spirits) this.ctx.world.scene.remove(s.g);
    this.spirits = [];
    const sections = [[0.12, 0.22], [0.26, 0.36], [0.4, 0.5], [0.54, 0.64], [0.68, 0.78], [0.82, 0.92]];
    // Spread the wanderers evenly over the whole loop.
    const pickN = this.d.wander;
    const chosen = Array.from({ length: pickN }, (_, i) => sections[Math.round((i * (sections.length - 1)) / Math.max(1, pickN - 1))]);
    for (const [a, b] of chosen) {
      const p = this.curve.getPointAt(a).setY(0);
      this.spirits.push(this.makeSpirit('wander', p, 0, a, b));
    }
    const unusedSections = [];
    this.spawnHunter();
    // Watchers stand a few metres from a seal, gazing over it.
    this.seals.slice(0, this.d.watch).forEach((seal, i) => {
      let post = null;
      for (let k = 0; k < 24 && !post; k++) {
        const ang = (k / 24) * Math.PI * 2 + i;
        const q = new THREE.Vector3(seal.pos.x + Math.cos(ang) * 4, 0, seal.pos.z + Math.sin(ang) * 4);
        if (this.isFree(q, 0.4) && this.clear(q.x, q.z, seal.pos.x, seal.pos.z)) post = q;
      }
      if (!post) return;
      const heading = Math.atan2(seal.pos.x - post.x, seal.pos.z - post.z);
      this.spirits.push(this.makeSpirit('watch', post, heading));
    });
  }

  // The Rokurokubi: a pale woman waiting beside a stone lantern deep in the forest. When she notices the
  // player her neck stretches and she hunts them by sight, sound and last known position. After the
  // third seal she turns aggressive and senses the player wherever they are.
  spawnHunter() {
    let post = null;
    for (const t of [0.5, 0.47, 0.53, 0.44, 0.56]) {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      for (const side of [3, -3, 4.5, -4.5]) {
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
    // Her lantern
    const L = this.ctx.spirits?.lantern;
    if (L) {
      const lan = L.scene.clone();
      lan.position.set(post.q.x + 0.9, 0, post.q.z + 0.6);
      this.ctx.world.scene.add(lan);
      this.props.push(lan);
    }
    this.hunterLight = this.ctx.world.addLight(new THREE.Vector3(post.q.x + 0.9, 1, post.q.z + 0.6), { color: 0xffb070, base: 4, distance: 8, flicker: 0.4 });
    this.spirits.push(s);
    this.hunter = s;
  }

  // Player tools: the hand lantern (L) and pebbles to throw (Q).
  key(code) {
    if (!this.running) return;
    if (code === 'KeyL') {
      this.lanternOn = !this.lanternOn && this.fuel > 0;
      this.ctx.ui.toast(this.lanternOn ? 'Lantern lit — you can see, but so can they.' : 'Lantern dimmed — harder to see, harder to be seen.');
    }
    if (code === 'KeyQ') this.throwPebble();
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
      `<div class="dlg-role">肝試し · Test of Courage</div><h2 class="fin">The Three Mystical Seals</h2>
       <p>Spirits have hidden three sealing talismans in the haunted forest. Find all three before time runs out to win.</p>
       <p>A <b>Rokurokubi</b> waits by a lantern in the heart of the forest. If she sees you, her neck stretches and she hunts you.</p>
       <p class="muted"><b>E</b> take a seal · <b>C</b> crouch (harder to see, silent) · <b>Shift</b> run (spirits hear it) · <b>L</b> hand lantern (see more, be seen more; limited oil) · <b>Q</b> throw a pebble (spirits investigate the noise). Spirits cannot see through trees. Being spotted, chased or caught raises your <b>fear</b> — at 100% you flee the forest.</p>
       <p class="muted">Easy 4:00 · Normal 3:00 · Hard 2:10 (higher score multiplier)</p>`,
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
    this.timer = this.d.time;
    this.fear = 0;
    this.spotted = 0;
    this.caught = 0;
    this.found = 0;
    this.hbT = 0;
    this.fuel = 100;
    this.grace = 2;
    this.lanternOn = true;
    this.pebbles = 3;
    this.gate = null;
    this.stillT = 0;
    for (const p of this.props || []) this.ctx.world.scene.remove(p);
    this.props = [];
    this.hunter = null;
    if (this.hunterLight) this.hunterLight.pos.set(0, -50, 0);
    this.ctx.world.fogBoost = 0;
    this.placeSeals();
    this.spawnSpirits();
    this.exitBeacon.visible = false;
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
    this.hud();
  }

  headingAlong(t) {
    const a = this.curve.getPointAt(t);
    const b = this.curve.getPointAt(Math.min(1, t + 0.02));
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  collect(seal) {
    if (seal.taken || !this.running) return;
    seal.taken = true;
    seal.anim = 0.001;
    this.found++;
    this.fuel = Math.min(100, this.fuel + 30); // each seal glows with enough light to refill the lantern a little
    this.pebbles++;
    this.ctx.world.fogBoost = this.found * 0.012; // the forest grows thicker with every seal taken
    sfx.suzu();
    setTimeout(() => sfx.chime(), 250);
    this.ctx.ui.toast(this.found < 3 ? `Mystical seal ${this.found} / 3` : 'All three seals! Escape to the shrine exit at the end of the path.');
    // Suspense rises with each seal: a scare, then the darkness, then the exit opens.
    if (this.found === 1) this.kimo.scareGlide();
    if (this.found === 2) this.kimo.scareDarkness();
    if (this.found === 3) {
      // All three seals: the challenge is won.
      setTimeout(() => this.end(true), 1300);
      return this.hud();
    }
    if (false) {
      this.exitBeacon.visible = true;
      this.gate = this.d.gate;
      if (this.hunter) {
        this.hunter.state = 'chase';
        this.hunter.aggressive = true;
        this.hunter.stun = 1.5;
      }
      sfx.scare();
      this.ctx.ui.toast('She knows. RUN to the shrine gate before it closes!');
    }
    this.hud();
  }

  end(won, reason) {
    if (!this.running) return;
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
        `<div class="dlg-role">Test of Courage · ${this.d.label}</div><h2 class="fin">${reason === 'gate' ? 'The shrine gate closed' : reason === 'time' ? 'The night closes in' : 'Fear takes hold'}</h2>
         <p>${reason === 'gate' ? 'The gate sealed itself before you reached it.' : reason === 'time' ? 'The timer ran out before you escaped the forest.' : 'Your fear reached 100% and you fled the forest.'} Seals found: <b>${this.found} / 3</b>.</p>`,
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
       <p class="muted">Completion ${s.base} · time left ${Math.ceil(this.timer)}s (+${s.time}) · seals +${s.seals} · spotted ${this.spotted}× (−${s.spot}) · caught ${this.caught}× (−${s.catch}) · fear ${Math.round(this.fear)}% (−${s.fearP}) · ×${this.d.mult} difficulty</p>`,
      [['Retry', retry], ['Return to the festival', leave]],
    );
  }

  cleanupExtras() {
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
    const time = Math.round(Math.max(0, this.timer) * 8);
    const seals = this.found * 200;
    const spot = this.spotted * 60;
    const c = this.caught * 150;
    const fearP = Math.round(this.fear * 3);
    const total = Math.max(0, Math.round((base + time + seals - spot - c - fearP) * this.d.mult));
    const [, rank, title] = RATINGS.find(([min]) => total >= min);
    return { base, time, seals, spot, catch: c, fearP, total, rank, title };
  }

  hud() {
    const m = Math.floor(Math.max(0, this.timer) / 60);
    const s = String(Math.floor(Math.max(0, this.timer) % 60)).padStart(2, '0');
    const fear = Math.round(this.fear);
    const objective = 'Find the three mystical seals';
    const alarm = this.spirits.some((x) => x.state === 'chase') ? 'A spirit is chasing you!' : this.spirits.some((x) => x.state === 'investigate') ? 'Something is searching…' : '';
    const gate = this.gate !== null ? ` · <span style="color:#ff8a7a">Gate closes in <b>${Math.ceil(this.gate)}s</b></span>` : '';
    this.ctx.ui.gameHud(`<div class="gh-title">肝試し · ${objective}</div>
      <div>Seals <b>${this.found} / 3</b> · <b>${m}:${s}</b>${gate} · Fear <b>${fear}%</b> ${alarm ? `· <span style="color:#ff8a7a">${alarm}</span>` : ''}</div>
      <div class="gf-dev">Lantern ${this.lanternOn ? 'lit' : 'dim'} · oil ${Math.round(this.fuel)}% (L) · pebbles ${this.pebbles} (Q) · crouch C</div>
      <div class="bar"><span style="width:${fear}%;background:${fear > 70 ? '#ff5a5a' : fear > 40 ? '#ffb05a' : '#7cf29a'}"></span></div>`);
  }

  // ------------------------------------------------------------------ per frame
  update(dt, t) {
    if (!this.running) return;
    const P = G.player;
    this.timer -= dt;
    if (this.timer <= 0) return this.end(false, 'time');
    if (this.gate !== null) {
      this.gate -= dt;
      if (this.gate <= 0) return this.end(false, 'gate');
    }
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
        }
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
    for (const s of this.seals) {
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
    // Spirits
    let threat = 0;
    for (const s of this.spirits) threat = Math.max(threat, this.updateSpirit(s, dt, t, P));

    // Fear: rises with threat, recovers when safe.
    if (threat > 0) this.fear = Math.min(100, this.fear + threat * dt);
    else this.fear = Math.max(0, this.fear - 7 * dt);
    if (this.fear >= 100) return this.end(false, 'fear');
    this.fearEl.style.opacity = Math.max(0, (this.fear - 30) / 70) * 0.85;
    if (this.fear > 25) {
      this.hbT -= dt;
      if (this.hbT <= 0) {
        this.hbT = 1.3 - (this.fear / 100) * 0.8;
        sfx.don(0.15 + (this.fear / 100) * 0.35);
      }
    }

    // Exit
    if (this.found === 3) {
      this.exitBeacon.material.opacity = 0.6 + Math.sin(t * 3) * 0.25;
      if (Math.hypot(P.pos.x - this.exit.x, P.pos.z - this.exit.z) < 2.6) return this.end(true);
    }
    this.hudT = (this.hudT || 0) - dt;
    if (this.hudT <= 0) {
      this.hudT = 0.2;
      this.hud();
    }
  }

  // Returns the fear rate this spirit causes right now.
  updateSpirit(s, dt, t, P) {
    s.stun = Math.max(0, s.stun - dt, this.grace || 0);
    const d = Math.hypot(P.pos.x - s.pos.x, P.pos.z - s.pos.z);
    // Perception at 10 Hz: distance (crouch shrinks it) + field of view + line of sight past trees; hearing.
    s.senseT -= dt;
    if (s.senseT <= 0) {
      s.senseT = 0.1;
      const R = s.R * (1 - 0.45 * P.crouch) * (this.lanternOn ? 1.25 : 0.85);
      const dx = P.pos.x - s.pos.x;
      const dz = P.pos.z - s.pos.z;
      const inCone = d < R && (Math.sin(s.heading) * dx + Math.cos(s.heading) * dz) / (d || 1) > s.fovCos;
      s.seen = s.stun <= 0 && inCone && this.clear(s.pos.x, s.pos.z, P.pos.x, P.pos.z);
      s.heard = s.stun <= 0 && P.running && P.vel.length() > 1 && d < 5;
      s.closeness = Math.max(0, 1 - d / R);
    }
    if (s.aggressive) {
      // Final escape: she senses the player everywhere and keeps re-planning her route to them.
      s.state = 'chase';
      s.seen = true;
      s.target = P.pos.clone();
    }
    const gain = this.d.detect * (1 + 0.15 * this.found);
    if (s.seen) s.sus += dt * gain * (0.5 + 1.5 * s.closeness);
    else if (s.heard) s.sus = Math.max(s.sus, 0.45);
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
      s.target = P.pos.clone();
      s.route = this.path(s.pos, s.target);
      s.waitT = 0;
    }
    if (s.state === 'chase') {
      if (s.seen) {
        s.lostT = 0;
        s.target = P.pos.clone();
      } else s.lostT += dt;
      s.routeT -= dt;
      if (s.routeT <= 0) {
        s.routeT = 0.4;
        s.route = this.path(s.pos, s.target);
      }
      if (s.lostT > this.d.giveUp * (s.kind === 'hunter' ? 1.7 : 1) && !s.aggressive) {
        s.state = 'return'; // the player broke line of sight long enough
        s.sus = 0.3;
        s.route = this.path(s.pos, s.home);
      }
      if (d < 1.0 && s.stun <= 0) {
        // Caught: fear spikes, the player is shoved away, the spirit drifts back to its post.
        this.caught++;
        this.fear = Math.min(100, this.fear + 18);
        this.grace = 3; // a moment for every spirit to lose interest
        P.shake = 0.25;
        const away = new THREE.Vector3(P.pos.x - s.pos.x, 0, P.pos.z - s.pos.z).normalize();
        const to = P.pos.clone().addScaledVector(away, 1.6);
        if (this.isFree(to, 0.35)) P.pos.copy(to);
        sfx.scare();
        this.ctx.ui.toast('A spirit caught you! Fear rises…');
        s.state = 'return';
        s.stun = s.aggressive ? 1.8 : 4;
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
        s.heading = angleDamp(s.heading, s.homeHeading + Math.sin(t * 0.6 + s.home.x) * 0.9, 2, dt);
      }
    } else {
      const sp = s.state === 'chase' ? this.d.chase + (s.kind === 'hunter' ? 0.3 : 0) + (s.aggressive ? 0.5 : 0) : 1.3;
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
        if (s.waitT > 2.5) {
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

    // Visuals
    s.g.position.copy(s.pos);
    s.g.rotation.y = s.heading;
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
    if (s.model) {
      const hop = speed > 0 ? Math.abs(Math.sin(t * (4 + speed * 1.5) + s.home.x)) : 0;
      s.model.position.y = hop * 0.28;
      s.model.rotation.z = (hop - 0.5) * 0.1;
    }
    const col = s.state === 'chase' ? 0xff4a4a : s.state === 'investigate' || s.sus > 0.2 ? 0xffb05a : s.kind === 'watch' ? 0xb08aff : 0x6ab8ff;
    s.cone.material.color.setHex(col);
    s.cone.material.opacity = 0.12 + Math.min(1, s.sus) * 0.16;
    s.mark.visible = s.state === 'chase' || s.state === 'investigate';
    s.mark.position.y = s.char ? 2.3 + s.ext : 2.1;
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
