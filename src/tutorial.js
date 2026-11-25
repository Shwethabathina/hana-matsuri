import * as THREE from 'three';
import { G } from './state.js';
import { sfx } from './audio.js';
import { glowTexture } from './util.js';
import { L } from './layout.js';

// Interactive first-visit tutorial. Short instruction cards in the bottom-left corner; the first four
// steps are played (they advance by themselves when the player does the thing), the rest are brief
// info cards with Back / Next. Skippable at any step. While it runs, G.tutorial is set: only the
// tutorial's own interactions respond to E, the clock is paused, the fireworks key and the Test of
// Courage auto-start are off, and nothing can complete an objective or award an emblem.
const DONE_KEY = 'hm-tutorial-done';
export const tutorialSeen = () => {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
};

const key = (k) => `<span class="tk" data-k="${k}">${k.replace('Key', '').replace('ShiftLeft', 'Shift').replace('Escape', 'Esc')}</span>`;

const MOVE_TO = new THREE.Vector3(-3, 0, 0.2); // 6 m down the street from the start
const LOOK_AT = new THREE.Vector3(5, 7.2, 0.2); // floating lantern high above the street ahead (open sky)
const GUIDE_AT = new THREE.Vector3(1.4, 0, -0.9); // Yui, the festival guide

export class Tutorial {
  constructor({ world, player, ui, camera, spirits, canvas }) {
    this.world = world;
    this.player = player;
    this.ui = ui;
    this.camera = camera;
    this.spirits = spirits;
    this.canvas = canvas;
    this.i = -1;
    this.el = document.getElementById('tut');
    this.keysDown = new Set();
    addEventListener('keydown', (e) => this.onKey(e, true), true);
    addEventListener('keyup', (e) => this.onKey(e, false), true);
    world.addInteractable({
      id: 'tut-guide',
      tutorial: true,
      priority: true,
      pos: GUIDE_AT.clone(),
      radius: 2.6,
      label: 'Talk to Yui, the festival guide',
      enabled: () => this.active && this.step?.id === 'talk' && !this.talked,
      action: () => this.talk(),
    });
    this.steps = this.defineSteps();
  }

  get active() {
    return this.i >= 0;
  }

  get step() {
    return this.steps[this.i];
  }

  // Compact welcome card shown on the first visit (or when replay was requested).
  welcome({ onSkip }) {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.onSkipStory = onSkip;
    this.ui.complete(
      `<div class="dlg-role">花祭り · Hana Matsuri</div><h2 class="fin">Welcome to Hana Matsuri!</h2>
       <p>Explore the Japanese festival, complete <b>five challenges</b>, earn ceremonial <b>emblems</b>, restore the festival spirit, and unlock the grand lantern and fireworks celebration.</p>
       <p class="muted">The tutorial takes about two minutes. You can skip it at any step, and replay it later from Help (H) or Settings.</p>`,
      [
        ['Start Tutorial', () => this.start({ first: true })],
        ['Skip Tutorial', () => this.markSeen() || onSkip?.()],
      ],
    );
  }

  markSeen() {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {}
  }

  start({ first = false } = {}) {
    if (this.active) this.cleanup();
    this.first = first;
    this.journalOpened = false;
    G.tutorial = true;
    const P = this.player;
    P.place(L.start, -Math.PI / 2);
    P.pitch = -0.05;
    P.vel.set(0, 0, 0);
    P.enabled = true;
    try {
      this.canvas.requestPointerLock?.()?.catch?.(() => {});
    } catch {}
    document.body.classList.add('tutorial');
    this.buildProps();
    this.go(0);
  }

  // ---------------------------------------------------------------- scene props
  buildProps() {
    const scene = this.world.scene;
    const mkMarker = (color) => {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.75, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide, fog: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.3; // above the street's stone slabs; drawn on top so it is never hidden
      ring.renderOrder = 20;
      const beam = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      beam.scale.set(0.9, 7, 1);
      beam.position.y = 3.2;
      g.add(ring, beam);
      g.userData = { ring, beam };
      g.visible = false;
      scene.add(g);
      return g;
    };
    this.moveMarker = mkMarker('#ffd24a');
    this.moveMarker.position.copy(MOVE_TO);
    this.guideMarker = mkMarker('#7cf2c4');
    this.guideMarker.position.copy(GUIDE_AT);
    this.guideMarker.userData.ring.visible = false;
    // The landmark for the camera step: a glowing paper lantern floating above the stalls.
    const lan = new THREE.Group();
    const paper = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 14), new THREE.MeshBasicMaterial({ color: '#ff9a3a', fog: false, depthTest: false }));
    paper.renderOrder = 21;
    paper.scale.y = 1.25;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffb45a', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    glow.material.depthTest = false;
    glow.renderOrder = 20;
    glow.scale.setScalar(3.2);
    lan.add(paper, glow);
    lan.position.copy(LOOK_AT);
    lan.visible = false;
    scene.add(lan);
    this.lantern = lan;
    // Yui, the festival guide (a kimono model; only present during the tutorial).
    const m = this.spirits?.kimonoWoman || this.spirits?.floralGeisha;
    if (m) {
      const root = new THREE.Group();
      root.add(m.scene.clone(true));
      root.position.copy(GUIDE_AT);
      root.rotation.y = -Math.PI / 2;
      root.visible = false;
      scene.add(root);
      this.guide = root;
      this.guideCollider = { x: GUIDE_AT.x, z: GUIDE_AT.z, r: 0.35, tag: 'tut-guide' };
      this.world.colliders.circles.push(this.guideCollider);
    }
  }

  cleanup() {
    const scene = this.world.scene;
    for (const o of [this.moveMarker, this.guideMarker, this.lantern]) {
      if (!o) continue;
      scene.remove(o);
      o.traverse((c) => {
        c.geometry?.dispose?.();
        c.material?.dispose?.(); // (the shared glow texture is kept)
      });
    }
    // Yui is a clone sharing geometry/materials with the loaded kimono asset: only remove her.
    if (this.guide) scene.remove(this.guide);
    if (this.guideCollider) {
      const cs = this.world.colliders.circles;
      const k = cs.indexOf(this.guideCollider);
      if (k >= 0) cs.splice(k, 1);
    }
    this.moveMarker = this.guideMarker = this.lantern = this.guide = this.guideCollider = null;
    for (const sel of document.querySelectorAll('.tut-hl')) sel.classList.remove('tut-hl');
    document.body.classList.remove('tutorial');
    this.el.classList.remove('on');
    this.el.innerHTML = '';
    this.i = -1;
    G.tutorial = false;
  }

  // ---------------------------------------------------------------- steps
  defineSteps() {
    const P = this.player;
    return [
      {
        id: 'move', title: 'Movement', play: true,
        body: () => `Use ${key('KeyW')} ${key('KeyA')} ${key('KeyS')} ${key('KeyD')} to walk. Walk to the <b class="gold">glowing gold circle</b> ahead of you.`,
        enter: () => (this.moveMarker.visible = true),
        exit: () => (this.moveMarker.visible = false),
        check: () => Math.hypot(P.pos.x - MOVE_TO.x, P.pos.z - MOVE_TO.z) < 1.3,
        goal: () => `${Math.max(0, Math.hypot(P.pos.x - MOVE_TO.x, P.pos.z - MOVE_TO.z) - 1.3).toFixed(1)} m to go`,
      },
      {
        id: 'look', title: 'Camera', play: true,
        body: () => `Move the <b>mouse</b> to look around (or use the ${key('Arrows')} keys). Look up at the <b class="gold">floating paper lantern</b> high above the street.`,
        enter: () => {
          this.lantern.visible = true;
          this.lookT = 0;
        },
        exit: () => (this.lantern.visible = false),
        check: (dt) => {
          const dir = new THREE.Vector3();
          this.camera.getWorldDirection(dir);
          const to = LOOK_AT.clone().sub(this.camera.position).normalize();
          this.lookAngle = Math.acos(Math.min(1, dir.dot(to)));
          this.lookT = this.lookAngle < 0.2 ? this.lookT + dt : 0; // within ~11° for a moment
          return this.lookT > 0.3;
        },
        goal: () => (document.pointerLockElement ? (this.lookAngle < 0.5 ? 'Almost — centre it on screen' : 'Find the lantern') : 'Click the scene first so the mouse turns the camera'),
      },
      {
        id: 'talk', title: 'Interaction', play: true,
        body: () => `Walk up to <b class="gold">Yui</b>, the festival guide (green beam). When the white prompt appears, press ${key('KeyE')} to talk. ${key('KeyE')} also examines clues, buys food and starts games.`,
        enter: () => {
          this.talked = false;
          this.guideMarker.visible = true;
          if (this.guide) this.guide.visible = true;
        },
        exit: () => (this.guideMarker.visible = false),
        check: () => this.talked && !this.ui.dialogueOpen,
        goal: () => (this.talked ? 'Finish the conversation' : `${Math.max(0, Math.hypot(P.pos.x - GUIDE_AT.x, P.pos.z - GUIDE_AT.z) - 2).toFixed(1)} m to Yui`),
      },
      {
        id: 'sprint', title: 'Running & crouching', play: true,
        body: () => `Hold ${key('ShiftLeft')} while walking to <b>run</b>. Hold ${key('KeyC')} to <b>crouch</b>.<br><span class="tsub">In stealth challenges running is loud and draws attention; crouching is slow but quiet and hard to spot.</span>`,
        enter: () => {
          this.runT = 0;
          this.crouchT = 0;
        },
        check: (dt) => {
          if (P.running && P.vel.length() > 4) this.runT += dt;
          if (P.crouch > 0.6) this.crouchT += dt;
          return this.runT > 1 && this.crouchT > 0.8;
        },
        goal: () => `${this.runT > 1 ? '✅' : '⬜'} Run for a moment &nbsp; ${this.crouchT > 0.8 ? '✅' : '⬜'} Crouch for a moment`,
      },
      {
        id: 'journal', title: 'Journal & minimap', play: true, info: true,
        body: () => `Press ${key('KeyJ')} to open the <b>festival journal</b>: objectives, clues and firework patterns. Press it again to close.<br><span class="tsub">The <b>minimap</b> (top right) shows you as a red arrow plus every booth and challenge; dimmed icons are finished. During quests a <b class="gold">gold arrow and dotted route</b> point to your next goal.</span>`,
        highlight: ['#topleft', '#mapcard'],
        check: () => this.journalOpened,
        goal: () => (this.journalOpened ? '✅ Journal opened' : `⬜ Press ${key('KeyJ')}`),
      },
      {
        id: 'games', title: 'Festival activities', info: true,
        body: () => `Five challenges each earn an <b>emblem</b> (top left):
          <div class="tgrid"><span>🐟 Goldfish Scooping</span><span>🎯 Shooting Gallery</span><span>🥁 Taiko Rhythm</span><span>👻 Test of Courage</span><span>🔔 Treasure Hunt</span></div>
          <span class="tsub">Walk up to a booth and press ${key('KeyE')} to play — each explains itself the first time. ${key('Escape')} leaves a game. Do them in any order.</span>`,
        highlight: ['#emblems', '#mapcard'],
      },
      {
        id: 'story', title: 'The main story', info: true,
        body: () => `The shrine’s <b>Kagura Bell</b> has vanished, and the festival lights are fading. Find <b>Hanae</b> in the Old Town (through the small torii on the game plaza), question townsfolk and follow their clues.<br><span class="tsub">The objective at the top of the screen and your journal always show the next step.</span>`,
        highlight: ['#topleft'],
      },
      {
        id: 'finale', title: 'Grand finale', info: true,
        body: () => `With all <b>five emblems</b>, go to the <b>riverfront deck</b> south of the fireworks viewing area (🏮 on the map) and press ${key('KeyE')} to begin the lantern festival and fireworks over the river.`,
        highlight: ['#emblems'],
      },
      {
        id: 'ready', title: 'You’re ready!', info: true, last: true,
        body: () => `<b>Enjoy the festival!</b><br><span class="tsub">Help is on ${key('KeyH')} (you can replay this tutorial there) · ${key('KeyM')} mutes the music.</span>`,
      },
    ];
  }

  go(i) {
    const prev = this.step;
    if (prev && this.i !== i) prev.exit?.();
    for (const el of document.querySelectorAll('.tut-hl')) el.classList.remove('tut-hl');
    this.i = i;
    const s = this.step;
    this.complete = false;
    s.enter?.();
    for (const sel of s.highlight || []) document.querySelector(sel)?.classList.add('tut-hl');
    // Info cards need the mouse to click Back / Next (the keyboard works too: Enter / Backspace).
    if (s.info && !s.play) this.player.unlock();
    this.render();
    sfx.tick?.(true);
  }

  render() {
    const s = this.step;
    const n = this.steps.length - 1; // the final card is not counted as a step
    const canNext = !s.play || this.complete;
    const firstInfo = this.steps.findIndex((x) => x.info);
    const back = s.info && this.i > firstInfo ? '<button class="btn ghost" data-a="back">Back</button>' : '';
    const next = canNext && (s.info || this.complete) ? `<button class="btn" data-a="next">${s.last ? 'Start exploring' : 'Next'}</button>` : '';
    this.el.innerHTML = `
      <div class="th"><span>${s.last ? 'Tutorial complete' : `Tutorial · Step ${this.i + 1} of ${n}`}</span><button class="tskip" data-a="skip">${s.last ? '' : 'Skip tutorial ✕'}</button></div>
      <div class="tt">${s.title}</div>
      <div class="tb">${s.body()}</div>
      <div class="tg" id="tut-goal">${s.goal ? s.goal() : ''}</div>
      <div class="tbtns">${back}${next}</div>
      ${s.info ? '<div class="tfoot">Enter ↵ next · Backspace back</div>' : '<div class="tfoot">Press Esc to free the mouse if you want to click.</div>'}`;
    this.el.classList.add('on');
    for (const b of this.el.querySelectorAll('[data-a]')) {
      b.onclick = (e) => {
        e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'skip') this.skip();
        else if (a === 'back') this.go(this.i - 1);
        else this.next();
      };
    }
    this.lightKeys();
  }

  lightKeys() {
    for (const k of this.el.querySelectorAll('.tk')) {
      const c = k.dataset.k;
      const on = c === 'Arrows' ? ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].some((x) => this.keysDown.has(x)) : this.keysDown.has(c) || (c === 'ShiftLeft' && this.keysDown.has('ShiftRight'));
      k.classList.toggle('on', on);
    }
  }

  next() {
    const s = this.step;
    if (s.play && !this.complete) return;
    if (s.last) return this.finish();
    this.go(this.i + 1);
  }

  onKey(e, down) {
    if (down) this.keysDown.add(e.code);
    else this.keysDown.delete(e.code);
    if (!this.active) return;
    this.lightKeys();
    if (!down || e.repeat || this.ui.panelOpen) return;
    const s = this.step;
    if (e.code === 'KeyJ' && s.id === 'journal') {
      this.journalOpened = true;
      setTimeout(() => this.active && this.render(), 0);
    }
    if (s.info && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
      e.preventDefault();
      this.next();
    }
    if (s.info && e.code === 'Backspace' && this.i > this.steps.findIndex((x) => x.info)) {
      e.preventDefault();
      this.go(this.i - 1);
    }
  }

  talk() {
    const P = this.player;
    P.enabled = false;
    this.ui.dialogue(
      [
        { name: 'Yui', role: 'Festival guide', text: 'Welcome to Hana Matsuri! I’m Yui — I help visitors find their way around the festival.' },
        { name: 'Yui', role: 'Festival guide', text: 'Whenever a white <b>E</b> prompt appears you can talk to someone, examine something, buy food or start a game.' },
        { name: 'Yui', role: 'Festival guide', text: 'People here notice things. In the Old Town especially, <b>talking to everyone</b> is how you find clues.' },
      ],
      () => {
        P.enabled = true;
        sfx.chime?.();
      },
    );
    this.talked = true;
  }

  skip() {
    const stepId = this.step?.id;
    const first = this.first;
    this.cleanup();
    this.markSeen();
    this.restoreControls();
    this.ui.toast('Tutorial skipped — press H any time for help or to replay it.');
    // A first-time player who skipped before the story card still gets the short story opening.
    if (first && !['story', 'finale', 'ready'].includes(stepId)) this.onSkipStory?.();
  }

  finish() {
    this.cleanup();
    this.markSeen();
    this.restoreControls();
    this.ui.toast('🏮 Enjoy the festival! Your first goal: find Hanae in the Old Town.');
    sfx.prize?.();
  }

  restoreControls() {
    const P = this.player;
    P.enabled = true;
    P.vel.set(0, 0, 0);
    if (document.getElementById('topleft').classList.contains('open')) this.ui.toggleJournal();
    try {
      this.canvas.requestPointerLock?.()?.catch?.(() => {});
    } catch {}
  }

  update(dt, t) {
    if (!this.active) return;
    const s = this.step;
    // Marker animation
    for (const m of [this.moveMarker, this.guideMarker]) {
      if (!m?.visible) continue;
      const k = 1 + Math.sin(t * 4) * 0.08;
      m.userData.ring.scale.set(k, k, k);
      m.userData.beam.material.opacity = 0.4 + Math.sin(t * 3) * 0.15;
    }
    if (this.lantern?.visible) this.lantern.position.y = LOOK_AT.y + Math.sin(t * 1.4) * 0.15;
    if (this.guide?.visible) {
      const P = this.player;
      const want = Math.atan2(P.pos.x - GUIDE_AT.x, P.pos.z - GUIDE_AT.z);
      const h = this.guide.rotation.y;
      this.guide.rotation.y = h + Math.atan2(Math.sin(want - h), Math.cos(want - h)) * (1 - Math.exp(-3 * dt));
    }
    if (s.play && !this.complete && s.check?.(dt)) {
      this.complete = true;
      sfx.chime?.();
      if (s.info) this.render(); // e.g. journal opened: now offer Next
      else {
        this.render();
        setTimeout(() => this.active && this.step === s && this.go(this.i + 1), 700);
      }
      return;
    }
    // Refresh the live goal line a few times a second
    this.goalT = (this.goalT || 0) - dt;
    if (this.goalT <= 0 && s.goal) {
      this.goalT = 0.15;
      const g = document.getElementById('tut-goal');
      if (g) g.innerHTML = s.goal();
      this.lightKeys();
    }
    this.el.classList.toggle('dim', this.ui.dialogueOpen);
  }
}
