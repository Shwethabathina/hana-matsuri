import * as THREE from 'three';
import { G } from '../state.js';
import { sfx, startHorror, setHorror } from '../audio.js';
import { glowTexture } from '../util.js';
import { CourageChallenge } from './courage.js';

// Test of Courage — "The Cursed Bell".
// Enter the haunted forest, break three curses, ring the abandoned shrine's bell, and escape the Rokurokubi.
//   Curse 1 · The Misleading Paths — three ruined shrines, one true; sacred marks show only in lantern light
//             (and light draws the kasa-obake). Praying at a false shrine chills you.
//   Curse 2 · The Shrine Guardian — a hannya mask stares at the second ofuda. Lure it with a pebble, hide in
//             the reeds, and perform the ritual while it is looking away.
//   Curse 3 · The Sleeping Rokurokubi — the last ofuda lies beside her lantern. Approach dark and crouched,
//             keep trees between you, and finish the ritual while she searches.
//   The Bell — the abandoned shrine across the path. One pull: the bell tolls, the lanterns gutter, the forest
//             falls silent, and her neck rises.
//   Escape — she hunts by sight (her neck sees far) and sound (she hears running). Break her line of sight and
//             she searches where she last saw you. Two ways out: on to the shrine gate past the stone lanterns
//             she cannot enter, or back the long way through the reeds to the entrance torii.
const CB = {
  easy: { label: 'Easy', faints: 5, sight: 13, fov: 60 },
  normal: { label: 'Normal', faints: 4, sight: 15, fov: 65 },
  hard: { label: 'Hard', faints: 3, sight: 17, fov: 70 },
};

export class CursedBell extends CourageChallenge {
  constructor(ctx, kimo) {
    super(ctx, kimo);
    this.mode = 'cursed';
    this.phase = 'idle';
    // The second exit (the entrance torii) gets its own beacon during the escape.
    this.entryBeacon = this.exitBeacon.clone();
    this.entryBeacon.material = this.exitBeacon.material;
    this.entryBeacon.position.copy(this.entry).setY(2);
    this.entryBeacon.visible = false;
    ctx.world.scene.add(this.entryBeacon);
    // Gold light beams over the current objective(s): seen through the trees from far away.
    this.beams = [0, 1, 2].map(() => {
      const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffcf6a', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      b.scale.set(0.9, 9, 1);
      b.visible = false;
      ctx.world.scene.add(b);
      return b;
    });
    ctx.world.addInteractable({
      id: 'cursed-bell', pos: new THREE.Vector3(), radius: 2.2, priority: true,
      label: () => (this.phase === 'bell' ? 'Ring the shrine bell' : 'The bell is sealed — collect the three seals first'),
      enabled: () => this.running && (this.phase === 'bell' || this.phase === 'curses') && !!this.bellPos,
      action: () => (this.phase === 'bell' ? this.ringBell() : this.ctx.ui.toast(`The bell will not move. Seals ${this.found} / 3.`)),
    });
    const it = ctx.world.interactables[ctx.world.interactables.length - 1];
    Object.defineProperty(it, 'pos', { get: () => this.bellPos || this.entry });
  }

  intro() {
    const P = G.player;
    P.enabled = false;
    P.unlock();
    const best = (k) => {
      try {
        const v = localStorage.getItem(`hm-cursed-best-${k}`);
        return v ? ` · best ${v}` : '';
      } catch {
        return '';
      }
    };
    this.ctx.ui.complete(
      `<div class="dlg-role">肝試し · Test of Courage</div><h2 class="fin">The Cursed Bell</h2>
       <p><b>Collect three seals → ring the shrine bell → escape the Rokurokubi.</b></p>
       <ul class="intro">
         <li><b>Objective</b> The panel at the top names the current goal; a <b style="color:#ff6a5a">red arrow</b>, the dotted route on the map and gold light beams lead to it. Press <b>E</b> at each seal and at the bell.</li>
         <li><b>Lantern</b> <b>L</b> lights your hand lantern: it reveals sacred marks but burns oil and makes you easier to spot.</li>
         <li><b>Hiding</b> Press <b>E</b> in tall reeds to hide. Spirits lose you unless they watch you go in. <b>C</b> crouch is quiet; <b>Shift</b> run is fast but loud.</li>
         <li><b>Distractions</b> <b>Q</b> throws a pebble: spirits go to check the noise. <b>R</b> uses an ofuda ward to dim their senses for a moment.</li>
         <li><b>Retry / exit</b> No time limit. If fear overwhelms you, you restart at the last checkpoint. <b>X</b> leaves the forest.</li>
       </ul>`,
      [
        [`Easy${best('easy')}`, () => this.start('easy')],
        [`Normal${best('normal')}`, () => this.start('normal')],
        [`Hard${best('hard')}`, () => this.start('hard')],
        ['Not now', () => (G.player.enabled = true)],
      ],
    );
  }

  start(diff) {
    this.cb = CB[diff];
    this.maxFaints = this.cb.faints;
    this.phase = 'curses';
    this.bellPending = true;
    this.bellPos = null;
    this.cpPassed = { a: false, b: false };
    this.cine = 0;
    super.start(diff); // curses (seals), spirits, Rokurokubi, reeds, stone lanterns, trail
    this.gate = null;
    this.fuel = 100; // a full lantern at the start of every run (and every retry)
    this.buildBellShrine();
    this.entryBeacon.visible = false;
    this.hud();
  }

  // The abandoned shrine stands across the path from the Rokurokubi's post.
  buildBellShrine() {
    const h = this.hunter;
    const near = this.kimo.nearestT(h ? h.home : this.curve.getPointAt(0.72));
    const tt = Math.min(0.9, near.t + 0.025);
    const p = this.curve.getPointAt(tt);
    const tan = this.curve.getTangentAt(tt);
    let pos = null;
    for (const side of [-4, 4, -5, 5, -3.5, 3.5, -6, 6]) {
      const q = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
      if (this.isFree(q, 1.1) && (!h || q.distanceTo(h.home) > 4.5)) {
        pos = q;
        break;
      }
    }
    pos = pos || this.clampToForest(p);
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#6f6c66', roughness: 1 });
    const wood = new THREE.MeshStandardMaterial({ color: '#3a281c', roughness: 0.9 });
    const red = new THREE.MeshStandardMaterial({ color: '#7d1c16', roughness: 0.7, emissive: '#2a0604' });
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.3, 2.2), stone);
    base.position.y = 0.15;
    const hut = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 0.9), wood);
    hut.position.set(0, 0.8, -0.5);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.05, 0.55, 4).rotateY(Math.PI / 4), wood);
    roof.position.set(0, 1.55, -0.5);
    roof.rotation.z = 0.08;
    g.add(base, hut, roof);
    for (const x of [-0.55, 0.55]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.9, 0.1), red);
      post.position.set(x, 1.1, 0.55);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.12), red);
    beam.position.set(0, 2.05, 0.55);
    this.bell = new THREE.Group();
    const bronze = new THREE.MeshStandardMaterial({ color: '#7a5a2a', metalness: 0.7, roughness: 0.4, side: THREE.DoubleSide, emissive: '#1a0e02' });
    const bellMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.27, 0.48, 16, 1, true), bronze);
    bellMesh.position.y = -0.3;
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6), new THREE.MeshStandardMaterial({ color: '#c8392b' }));
    rope.position.y = -0.9;
    this.bell.add(bellMesh, rope);
    this.bell.position.set(0, 2.0, 0.55);
    g.add(beam, this.bell);
    // Three curse talismans tied to the frame: they burn away one by one as the curses break.
    this.curseTags = [-0.35, 0, 0.35].map((x) => {
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.3), new THREE.MeshBasicMaterial({ color: '#f2e6c8', side: THREE.DoubleSide, transparent: true }));
      tag.position.set(x, 1.78, 0.62);
      g.add(tag);
      return tag;
    });
    for (const x of [-1.4, 1.4]) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.6, 10), red);
      pil.position.set(x, 1.3, 1.6);
      g.add(pil);
    }
    const kasagi = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.16, 0.26), red);
    kasagi.position.set(0, 2.65, 1.6);
    g.add(kasagi);
    this.shrineFlames = [];
    for (const x of [-1.2, 1.2]) {
      const L = this.ctx.spirits?.lantern;
      if (L) {
        const lan = L.scene.clone();
        lan.position.set(x, 0, 0.9);
        g.add(lan);
      }
      const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ff7a3a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      fl.scale.setScalar(1.1);
      fl.position.set(x, 0.95, 0.9);
      g.add(fl);
      this.shrineFlames.push(fl);
    }
    g.position.copy(pos);
    g.rotation.y = Math.atan2(p.x - pos.x, p.z - pos.z); // faces the trail
    this.ctx.world.scene.add(g);
    this.props.push(g);
    this.bellPos = pos.clone();
    this.ctx.world.colliders.circles.push({ x: pos.x, z: pos.z, r: 0.9, tag: 'bellshrine', tmp: true });
  }

  // Trial banners and hints, renamed as curses.
  banner(n) {
    const T = {
      1: ['Find the First Seal', 'Follow the lantern trail to the ruined shrines (gold beams). Lantern (L) reveals glowing marks at the true one — pray there (E).'],
      2: ['Second Seal', 'A spirit guards it. Throw a pebble (Q) away from it, then hold E at the seal while it looks away.'],
      3: ['Third Seal', 'It lies beside the sleeping Rokurokubi. Lantern off (L), crouch (C), and hold E at the seal unseen.'],
      4: ['Ring the Bell', 'All three seals are yours. Ring the shrine bell across the path (E) — she will wake.'],
    };
    this.trialText = T[n];
    this.ctx.ui.toast(T[n][0]);
  }

  collect(seal) {
    const wasLast = this.found === 2 && !seal.taken;
    super.collect(seal);
    this.curseTags?.forEach((tag, i) => (tag.visible = i >= this.found));
    if (!wasLast) return;
    // The third curse breaks — she does not wake yet. The bell is next.
    this.gate = null;
    this.exitBeacon.visible = false;
    const h = this.hunter;
    if (h) {
      h.aggressive = false;
      h.state = 'return';
      h.stun = 5; // a breather after the ritual
      h.sus = 0;
      h.route = this.path(h.pos, h.home);
    }
    for (const z of this.safe) z.ring.material.opacity = 0.25;
    this.phase = 'bell';
    this.checkpoint = this.clampToForest(this.bellPos.clone().add(new THREE.Vector3(1.2, 0, 1.2)));
    this.hud();
  }

  ringBell() {
    if (this.phase !== 'bell') return;
    this.phase = 'cinematic';
    this.cine = 0;
    this.toll2 = false;
    this.risen = false;
    this.hidden = null;
    const P = G.player;
    P.enabled = false;
    P.vel.set(0, 0, 0);
    sfx.suzu();
    sfx.don?.(1);
    setHorror(0);
    this.trialText = ['…', 'The bell tolls through the silent forest.'];
    this.hud();
  }

  updateCinematic(dt, P) {
    this.cine += dt;
    const c = this.cine;
    this.bell.rotation.x = Math.sin(c * 6) * Math.max(0, 0.6 - c * 0.15);
    if (c > 1.0 && !this.toll2) {
      this.toll2 = true;
      sfx.don?.(0.8);
    }
    // The lanterns gutter, then nearly die; the hand lantern stutters.
    for (const fl of this.shrineFlames) fl.material.opacity = c < 1.8 ? 0.2 + Math.random() * 0.8 : 0.15;
    this.kimo.handLight.intensity = c < 1.8 ? Math.random() * 3 : 0.5;
    const h = this.hunter;
    if (!h) return this.beginEscape(P);
    if (c > 1.8 && !this.risen) {
      this.risen = true;
      sfx.scare();
      this.ctx.ui.toast('Behind you… her neck is rising.');
      h.pos.copy(h.home);
    }
    if (this.risen) {
      // Turn the camera toward her as she rises.
      const want = Math.atan2(-(h.pos.x - P.pos.x), -(h.pos.z - P.pos.z));
      P.yaw += Math.atan2(Math.sin(want - P.yaw), Math.cos(want - P.yaw)) * Math.min(1, dt * 3);
      h.ext = Math.min(1.1, (c - 1.8) * 0.9);
      if (h.geisha) h.geisha.uni.uExt.value = h.ext;
      h.heading = Math.atan2(P.pos.x - h.pos.x, P.pos.z - h.pos.z);
      h.g.rotation.y = h.heading;
      h.g.position.copy(h.pos);
    }
    if (c > 3.4) this.beginEscape(P);
  }

  beginEscape(P) {
    this.phase = 'escape';
    this.bellPending = false;
    P.enabled = true;
    const h = this.hunter;
    if (h) {
      h.aggressive = true;
      h.state = 'chase';
      h.R = this.cb.sight; // her raised neck sees far over the undergrowth
      h.fovCos = Math.cos(THREE.MathUtils.degToRad(this.cb.fov));
      // Her visible sight cone grows with the neck, so the player can read exactly where she can see.
      const fov = THREE.MathUtils.degToRad(this.cb.fov);
      h.cone.geometry.dispose();
      h.cone.geometry = new THREE.CircleGeometry(h.R, 32, Math.PI / 2 - fov, fov * 2).rotateX(-Math.PI / 2);
      h.hearR = 9; // and hears running feet
      h.lastSeenPos = P.pos.clone();
      h.lostKnow = 0;
      h.stun = 1.6; // a readable beat before she comes
    }
    for (const z of this.safe) z.ring.material.opacity = 0.55;
    this.exitBeacon.visible = true;
    this.entryBeacon.visible = true;
    this.trialText = ['Escape', 'Run (Shift) to either torii gate. Break her line of sight, hide in reeds (E), or shelter in stone-lantern light.'];
    startHorror();
    setHorror(0.9);
    this.ctx.ui.toast('RUN! Either gate — forward past the stone lanterns, or back the way you came.');
  }

  faint(reason) {
    super.faint(reason);
    if (!this.running) return;
    this.gate = null;
    const h = this.hunter;
    if (h && this.phase === 'escape') {
      h.pos.copy(h.home);
      h.lostKnow = 9;
      h.lastSeenPos = h.home.clone();
      h.stun = 3.5;
    }
    if (reason === 'caught' || this.phase === 'escape') this.ctx.ui.toast('You wake at the last checkpoint. She is back at her shrine — move!');
  }

  update(dt, t) {
    if (!this.running || this.paused) return;
    const P = G.player;
    if (this.phase === 'cinematic') {
      this.timer += dt;
      this.updateCinematic(dt, P);
      this.updateLevel(dt, t, P);
      this.hunter?.mixer?.update?.(dt);
      return;
    }
    super.update(dt, t);
    this.updateBeams(t);
    this.updateGuide(dt);
    if (this.running && (this.hudT || 0) > 0.1) this.hudT = 0.1; // arrow refresh at 10 Hz
    if (!this.running) return;
    for (const fl of this.shrineFlames || []) fl.material.opacity = (this.phase === 'escape' ? 0.25 : 0.6) + Math.sin(t * 7) * 0.12;
    if (this.phase === 'bell') {
      // The bell glows faintly to draw the player across the path.
      this.bell.children[0].material.emissive.setRGB(0.25 + Math.sin(t * 3) * 0.12, 0.15, 0.02);
    }
    if (this.phase === 'escape') {
      const here = this.kimo.nearestT(P.pos);
      const bellT = this.kimo.nearestT(this.bellPos).t;
      // Checkpoints part-way along each route.
      if (here.t < bellT - 0.2 && !this.cpPassed.a) {
        this.cpPassed.a = true;
        this.checkpoint = this.clampToForest(P.pos.clone());
        this.ctx.ui.toast('Checkpoint');
      }
      if (here.t > bellT + 0.1 && !this.cpPassed.b) {
        this.cpPassed.b = true;
        this.checkpoint = this.clampToForest(P.pos.clone());
        this.ctx.ui.toast('Checkpoint');
      }
      this.entryBeacon.scale.y = 4.5 + Math.sin(t * 3) * 0.3;
      if (here.t < 0.045 && here.d < 4) return this.end(true);
    }
  }

  // X: leave the forest (with confirmation). Nothing is awarded; spirits and effects are cleaned up.
  giveUp() {
    const P = G.player;
    P.enabled = false;
    P.unlock();
    this.paused = true;
    this.ctx.ui.complete(
      `<div class="dlg-role">Test of Courage</div><h2 class="fin">Leave the forest?</h2><p>Your progress in this run will be lost.</p>`,
      [
        ['Keep going', () => { this.paused = false; P.enabled = true; try { this.ctx.canvas?.requestPointerLock?.(); } catch {} }],
        ['Leave', () => {
          this.paused = false;
          this.ctx.world.colliders.circles = this.ctx.world.colliders.circles.filter((c) => c.tag !== 'bellshrine');
          this.entryBeacon.visible = false;
          this.beams.forEach((b) => (b.visible = false));
          this.phase = 'idle';
          this.abort();
          P.place(new THREE.Vector3(32, 0, -1.4), Math.PI);
          P.enabled = true;
        }],
      ],
    );
  }

  // The current objective location(s) for beams, the minimap and the direction arrow.
  targets() {
    if (!this.running) return [];
    if (this.phase === 'curses') {
      if (this.trial === 1) return (this.shrines || []).filter((x) => !x.used).map((x) => ({ p: x.pos, icon: '🙏' }));
      const seal = this.seals[this.trial - 1];
      return seal && !seal.taken ? [{ p: seal.pos, icon: '📜' }] : [];
    }
    if (this.phase === 'bell' || this.phase === 'cinematic') return [{ p: this.bellPos, icon: '🔔' }];
    if (this.phase === 'escape') return [{ p: this.exit, icon: '⛩️' }, { p: this.entry, icon: '⛩️' }];
    return [];
  }

  mapMarkers() {
    if (!this.running) return [];
    const cur = new Set(this.targets().map((x) => x.p));
    const out = [];
    const st = this.phase === 'curses' ? this.trial : 4; // which stage the player is on (1-3 seals, 4 = bell/escape)
    // Seal 1 shrines (the true one is not revealed: the lantern marks still have to be read)
    for (const sh of this.shrines || []) {
      const done = st > 1 && sh === this.trueShrine;
      if (st > 1 && !done) continue;
      out.push({ p: sh.pos, icon: done ? '✅' : '🙏', alpha: sh.used && !done ? 0.35 : 1, ring: cur.has(sh.pos) });
    }
    // Seals 2 and 3
    [1, 2].forEach((i) => {
      const seal = this.seals[i];
      if (!seal) return;
      out.push({ p: seal.pos, icon: seal.taken ? '✅' : '📜', alpha: st < i + 1 ? 0.45 : 1, ring: cur.has(seal.pos) });
    });
    // The bell shrine and the two exit gates
    if (this.bellPos) out.push({ p: this.bellPos, icon: '🔔', alpha: st < 4 ? 0.45 : 1, ring: cur.has(this.bellPos) });
    out.push({ p: this.entry, icon: '⛩️', alpha: this.phase === 'escape' ? 1 : 0.5, ring: this.phase === 'escape' });
    out.push({ p: this.exit, icon: '⛩️', alpha: this.phase === 'escape' ? 1 : 0.5, ring: this.phase === 'escape' });
    return out;
  }

  // Route guidance (same approach as the Old Town's arrow): a walkable route around trees on the forest
  // grid, refreshed 4x a second; the red HUD arrow points ~2.5 m ahead along it and shows walking distance.
  updateGuide(dt) {
    this.guideT = (this.guideT || 0) - dt;
    if (this.guideT > 0) return;
    this.guideT = 0.25;
    const P = G.player;
    const tgs = this.targets();
    if (!tgs.length || this.phase === 'cinematic') {
      this.route = [];
      this.guide = null;
      return;
    }
    let best = null;
    for (const tg of tgs) {
      const r = this.path(P.pos, tg.p, 30000);
      let walk = 0;
      let px = P.pos.x;
      let pz = P.pos.z;
      for (const q of r) {
        walk += Math.hypot(q.x - px, q.z - pz);
        px = q.x;
        pz = q.z;
      }
      walk += Math.hypot(tg.p.x - px, tg.p.z - pz);
      if (!best || walk < best.walk) best = { tg, r, walk };
    }
    this.route = best.r;
    this.guide = best;
  }

  guideArrow() {
    const g = this.guide;
    if (!g) return '';
    const P = G.player;
    let wx = g.tg.p.x;
    let wz = g.tg.p.z;
    let acc = 0;
    let px = P.pos.x;
    let pz = P.pos.z;
    for (const q of this.route || []) {
      acc += Math.hypot(q.x - px, q.z - pz);
      px = q.x;
      pz = q.z;
      if (acc >= 2.5) {
        wx = q.x;
        wz = q.z;
        break;
      }
    }
    const f = P.forward;
    const wd = Math.hypot(wx - P.pos.x, wz - P.pos.z) || 1;
    const dx = (wx - P.pos.x) / wd;
    const dz = (wz - P.pos.z) / wd;
    const deg = Math.round((Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz) * 180) / Math.PI);
    const near = Math.hypot(g.tg.p.x - P.pos.x, g.tg.p.z - P.pos.z) < 2.5;
    return near
      ? `<b style="color:#ffd24a">${g.tg.icon} here — press E</b>`
      : `<span style="display:inline-block;transform:rotate(${deg}deg);color:#ff4a3a;font-size:19px;transition:transform 0.1s linear">⬆</span> ${g.tg.icon} ${Math.round(g.walk)} m`;
  }

  updateBeams(t) {
    const tg = this.phase === 'escape' ? [] : this.targets(); // exits already have their own beacons
    this.beams.forEach((b, i) => {
      const x = tg[i];
      b.visible = !!x && this.running;
      if (!x) return;
      b.position.set(x.p.x, 4.6, x.p.z);
      b.material.opacity = 0.35 + Math.sin(t * 2 + i) * 0.12;
    });
  }

  hud() {
    const fear = Math.round(this.fear || 0);
    const P = G.player;
    const h = this.hunter;
    let warn = '';
    if (this.phase === 'escape' && h) warn = this.hidden && !this.hideSeen ? 'hidden — stay still' : h.searching ? 'she lost you' : 'SHE SEES YOU';
    else if (this.hidden) warn = this.hideSeen ? 'it saw you hide!' : 'hidden in the reeds';
    else if (this.spirits.some((x) => x.state === 'chase')) warn = 'a spirit is chasing you!';
    // Direction to the nearest objective, relative to where the player is looking.
    void P;
    const dir = this.guideArrow();
    const ritual = this.ritual ? `<div style="color:#ffd24a"><b>Ritual ${this.ritual.t.toFixed(1)} / ${this.ritual.dur}s</b> — stay close and unseen</div>` : '';
    const progress = this.phase === 'escape' ? 'Bell rung' : `Seals <b>${this.found} / 3</b>`;
    this.ctx.ui.gameHud(`<div class="gh-title">${this.trialText?.[0] || 'The Cursed Bell'} <span style="float:right;font-weight:400">${dir}</span></div>
      <div class="gf-dev">${this.trialText?.[1] || ''}</div>${ritual}
      <div>${progress} · Fear <b>${fear}%</b> · Oil <b>${Math.round(this.fuel)}%</b> · Pebbles ${this.pebbles}${warn ? ` · <span style="color:#ff8a7a">${warn}</span>` : ''}</div>
      <div class="bar"><span style="width:${fear}%;background:${fear > 70 ? '#ff5a5a' : fear > 40 ? '#ffb05a' : '#7cf29a'}"></span></div>`);
  }

  end(won, reason) {
    if (!this.running) return;
    this.entryBeacon.visible = false;
    this.beams.forEach((b) => (b.visible = false));
    this.ctx.world.colliders.circles = this.ctx.world.colliders.circles.filter((c) => c.tag !== 'bellshrine');
    const phase = this.phase;
    this.phase = 'idle';
    if (won) {
      // Same flow as the base (score, best, Courage Emblem, Retry / Return), with the bell's own best key.
      const s = this.score();
      try {
        const key = `hm-cursed-best-${this.diff}`;
        if (s.total > Number(localStorage.getItem(key) || 0)) localStorage.setItem(key, String(s.total));
      } catch {}
      super.end(true, reason);
      const h2 = document.querySelector('#panel h2');
      if (h2) h2.insertAdjacentHTML('beforebegin', '<p style="margin:0 0 4px;color:#ffd890"><b>You escaped the forest — the Courage Emblem is yours.</b></p>');
      return;
    }
    super.end(false, reason);
    const p = document.querySelector('#panel p');
    if (p) p.innerHTML = `${reason === 'caught' || phase === 'escape' ? 'The Rokurokubi caught you one time too many.' : 'Terror overwhelmed you one time too many.'} Seals collected: <b>${this.found} / 3</b>${phase === 'escape' ? ' · the bell was rung' : ''}. Try a different route, hide sooner, or lure her with a pebble.`;
  }
}
