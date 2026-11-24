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
    ctx.world.addInteractable({
      id: 'cursed-bell', pos: new THREE.Vector3(), radius: 2.2, priority: true,
      label: () => (this.phase === 'bell' ? 'Ring the cursed bell' : 'The bell is bound by three curses'),
      enabled: () => this.running && (this.phase === 'bell' || this.phase === 'curses') && !!this.bellPos,
      action: () => (this.phase === 'bell' ? this.ringBell() : this.ctx.ui.toast(`The bell will not move. Break the curses first (${this.found} / 3).`)),
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
       <p>Deep in the forest an abandoned shrine holds a bell bound by three curses. <b>Break the curses, ring the bell, and escape alive.</b></p>
       <p><b>一 Misleading Paths</b> — three ruined shrines, one true. Its marks glow only in lantern light.<br>
       <b>二 The Guardian</b> — a spirit watches the second ofuda. Distract it, then perform the ritual unseen.<br>
       <b>三 The Sleeping Rokurokubi</b> — take the last ofuda from beside her lantern without waking her.</p>
       <p class="muted">Ring the bell and she wakes. She sees far and hears running — break her line of sight, hide in reeds, shelter in stone-lantern light, and reach either torii gate.</p>
       <p class="muted"><b>C</b> crouch · <b>Shift</b> run · <b>L</b> lantern · <b>E</b> interact / hide · <b>Q</b> pebble · <b>R</b> ofuda ward. No time limit. Caught or overwhelmed → back to the last checkpoint.</p>`,
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
      1: ['Curse 1 · The Misleading Paths', 'Three ruined shrines, only one true. Its sacred marks glow only in lantern light (L) — but light draws the kasa-obake. Pray (E) at the true shrine.'],
      2: ['Curse 2 · The Shrine Guardian', 'The hannya never stops watching its ofuda. Throw a pebble (Q) away from it, slip in, and hold the ritual (E) while it looks away. Reeds (E) hide you.'],
      3: ['Curse 3 · The Sleeping Rokurokubi', 'The last ofuda lies beside her lantern. Lantern off, crouch (C), keep trees between you, and finish the ritual while she searches.'],
      4: ['Ring the Cursed Bell', 'All three curses are broken. The abandoned shrine is across the path from her — ring its bell (E). Then run.'],
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
    this.trialText = ['ESCAPE — reach either torii gate', 'On past the stone lanterns (she cannot enter their light) to the shrine gate, or back through the reeds to the entrance. Running is fast but she hears it; break her line of sight and she has to search.'];
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
          this.phase = 'idle';
          this.abort();
          P.place(new THREE.Vector3(32, 0, -1.4), Math.PI);
          P.enabled = true;
        }],
      ],
    );
  }

  hud() {
    const fear = Math.round(this.fear || 0);
    const h = this.hunter;
    let warn = '';
    if (this.phase === 'escape' && h) warn = this.hidden && !this.hideSeen ? 'hidden — stay still' : h.searching ? 'she lost you — she is searching' : 'SHE SEES YOU';
    else if (this.spirits.some((x) => x.state === 'chase')) warn = 'a spirit is chasing you!';
    else if (this.spirits.some((x) => x.state === 'investigate')) warn = 'something is searching…';
    const ritual = this.ritual ? ` · <b style="color:#ffd24a">Ritual ${this.ritual.t.toFixed(1)} / ${this.ritual.dur}s — stay still and unseen</b>` : '';
    const curses = this.phase === 'curses' ? `Curses <b>${this.found} / 3</b> · ` : '';
    this.ctx.ui.gameHud(`<div class="gh-title">肝試し · ${this.trialText?.[0] || 'The Cursed Bell'}</div>
      <div>${curses}Fear <b>${fear}%</b> · Lantern oil <b>${Math.round(this.fuel)}%</b>${ritual}${warn ? ` · <span style="color:#ff8a7a">${warn}</span>` : ''}</div>
      <div class="bar"><span style="width:${fear}%;background:${fear > 70 ? '#ff5a5a' : fear > 40 ? '#ffb05a' : '#7cf29a'}"></span></div>
      <div class="gf-dev">${this.trialText?.[1] || ''}</div>
      <div class="gf-dev">C crouch · Shift run · L lantern · E interact/hide · Q pebble (${this.pebbles}) · R ward (${this.charms}) · X leave · checkpoints left ${Math.max(0, (this.maxFaints || 3) - this.faints - 1)}</div>`);
  }

  end(won, reason) {
    if (!this.running) return;
    this.entryBeacon.visible = false;
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
      if (h2) h2.insertAdjacentHTML('beforebegin', '<p style="margin:0 0 4px;color:#ffd890"><b>You escaped the cursed forest — the Courage Emblem is yours.</b></p>');
      return;
    }
    super.end(false, reason);
    const p = document.querySelector('#panel p');
    if (p) p.innerHTML = `${reason === 'caught' || phase === 'escape' ? 'The Rokurokubi caught you one time too many.' : 'Terror overwhelmed you one time too many.'} Curses broken: <b>${this.found} / 3</b>${phase === 'escape' ? ' · the bell was rung' : ''}. Try a different route, hide sooner, or lure her with a pebble.`;
  }
}
