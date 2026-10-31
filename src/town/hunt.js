import * as THREE from 'three';
import { Town, townSpawn } from './town.js';
import { HeirloomQuest, S } from './quest.js';
import { Villager } from './villagers.js';
import { sfx } from '../audio.js';

// Town Treasure Hunt controller: area switching, villagers, clue interactions, dialogue and the
// Start -> Active -> End -> Reset loop. All progress changes go through quest.advance().
const VILLAGERS = [
  {
    key: 'organizer', name: 'Hanae Sato', role: 'Festival organizer', at: [-1.6, 2.4], heading: 1.1, scan: 0.5,
    gender: 'f', yukata: ['#2d4a8a', '#f4e7c8'], obi: '#f2c14e', greet: 'Ah, a visitor! Over here, please!',
  },
  {
    key: 'shopkeeper', name: 'Kenta Mori', role: 'Dango seller', at: [-1.5, -2.2], heading: 0, scan: 0.6,
    gender: 'm', yukata: ['#5a3a2a', '#c9b48a'], obi: '#222222', greet: 'Welcome! Fresh dango today!', anim: 'cook',
  },
  {
    key: 'child', name: 'Yuki', role: 'Village child', at: [2.5, -9.5], heading: Math.PI, scan: 0.9, range: 7,
    gender: 'f', yukata: ['#e86a92', '#ffffff'], obi: '#ffffff', child: true, greet: 'Hi! Are you an adventurer?',
  },
];

export class TreasureHunt {
  constructor({ world, player, ui, onArea }) {
    this.world = world;
    this.player = player;
    this.ui = ui;
    this.onArea = onArea;
    this.area = 'festival';
    this.mode = 'fovlos'; // perception mode: 'fovlos' (prototype) or 'radius' (comparison)
    this.debug = false;
    this.talking = null;
  }

  async load() {
    this.town = new Town(this.world);
    await this.town.load();
    this.town.cb.enter = () => this.enter();
    this.town.cb.exit = () => this.exit();
    this.quest = new HeirloomQuest(this.town);
    this.villagers = {};
    for (const d of VILLAGERS) this.villagers[d.key] = new Villager(this.town, d);
    this.quest.onChange(() => this.refreshHud());

    const inTown = () => this.area === 'town' && !this.talking;
    for (const v of Object.values(this.villagers)) {
      // Interaction depends on perception: a villager who has not noticed you must be hailed first.
      this.world.interactables.push({
        id: `villager-${v.def.key}`, pos: v.pos, radius: 2.1, enabled: inTown,
        label: () => (v.noticed ? `Talk to ${v.name} (${v.role})` : `Call out to ${v.name} — they haven't noticed you`),
        action: () => this.interact(v),
      });
    }
    const Q = this.quest;
    const clue = (id, key, label, state, run) =>
      this.world.interactables.push({ id, pos: Q.worldPoint(key), radius: 1.7, label, enabled: () => inTown() && Q.state === state, action: run });
    clue('clue-cart', 'cart', 'Examine the festival cart', S.FIND_CORD, () => {
      sfx.chime();
      this.dialog([['Clue 1 of 2 — the festival cart', 'The bell stand is empty. A torn <b style="color:#ff6b5a">red-and-white cord</b> hangs from it, and a few <b>pink-and-white crumbs</b> are scattered on the cart. Someone was snacking here…']], () =>
        Q.advance(S.FIND_CORD, S.ASK_SHOPKEEPER));
    });
    clue('clue-dango', 'dango', 'Examine something on the ground', S.FIND_DANGO, () => {
      sfx.chime();
      this.dialog([['Clue 2 of 2 — a dropped dango', 'A half-eaten <b>dango skewer</b>, and next to it a trail of small <b>paw prints</b> leading back down the path and off to the side. A tanuki, perhaps?']], () =>
        Q.advance(S.FIND_DANGO, S.FIND_BELL));
    });
    clue('clue-bell', 'bell', 'Pick up the Kagura Bell', S.FIND_BELL, () => {
      sfx.suzu();
      this.dialog([['The Festival Heirloom!', 'Tucked in a straw nest behind the building: the golden <b>Kagura Bell</b>. The tanuki must have liked the sound. Time to take it back to Hanae.']], () =>
        Q.advance(S.FIND_BELL, S.RETURN_BELL));
    });
    this.lines = this.buildLines();
    this.refreshHud();
  }

  // ---------------------------------------------------------------- dialogue
  buildLines() {
    return {
      organizer: {
        [S.NOT_STARTED]: [
          'Welcome to the old town! I am Hanae, I organise tonight’s festival procession.',
          'Something terrible has happened — the <b>Kagura Bell</b>, our festival heirloom, has vanished from its cart!',
          'Its cart is right here, on the east side of the courtyard. Could you take a look for clues?',
        ],
        [S.FIND_CORD]: ['The festival cart is just over there, on the east side of the courtyard.'],
        [S.ASK_SHOPKEEPER]: ['Crumbs? Kenta sells dango in the courtyard. Ask him — he sees everyone who passes.'],
        [S.FIND_DANGO]: ['Kenta said the north road? Then follow it toward the temple.'],
        [S.FIND_BELL]: ['Paw prints… a tanuki! They like quiet corners behind buildings.'],
        [S.RETURN_BELL]: [
          'The Kagura Bell! You found it! Hidden right behind the shops? Of all places…',
          'Thank you. The procession can start on time. Please, enjoy the festival!',
        ],
        [S.COMPLETE]: ['Thank you again. The bell sounds wonderful tonight.'],
      },
      shopkeeper: {
        default: ['Dango, three on a stick! …Hm? Hanae is looking for something? I’ve been busy grilling.'],
        [S.ASK_SHOPKEEPER]: [
          'A red-and-white cord? That’s from the Kagura Bell cart!',
          'And pink-and-white crumbs… one of my dango went missing earlier, too.',
          'I saw something small and furry run up the <b>north road</b> toward the temple. Look along there!',
        ],
        [S.COMPLETE]: ['You found the bell? Have a dango on me!'],
      },
      child: {
        default: ['I’m waiting for the procession! Mama says it starts when the bell rings.'],
        [S.FIND_DANGO]: ['A furry thief? I saw a <b>tanuki</b> run up this road with something sweet!'],
        [S.FIND_BELL]: ['The tanuki ran back down toward the courtyard and <b>behind the big building</b>! I heard jingling!'],
        [S.COMPLETE]: ['The bell is back! Yay!'],
      },
    };
  }

  interact(v) {
    if (!v.noticed) {
      // Hailing works, but the villager is startled — perception decides how an approach plays out.
      v.state = 'notice';
      v.noticeT = 0;
      v.lastSeen = 0;
      v.say('Oh! You startled me!');
      // They turn around, then the conversation starts on its own.
      setTimeout(() => {
        if (this.area === 'town' && !this.talking && !this.ui.panelOpen) this.interact(v);
      }, 900);
      return;
    }
    const set = this.lines[v.def.key];
    const lines = set[this.quest.state] || set.default;
    const Q = this.quest;
    v.state = 'talk';
    this.talking = v;
    this.dialog(lines.map((l) => [`${v.name} · ${v.role}`, l]), () => {
      v.state = 'notice';
      v.lastSeen = 0;
      this.talking = null;
      if (v.def.key === 'organizer') {
        if (Q.advance(S.NOT_STARTED, S.FIND_CORD)) this.ui.toast('📜 Treasure hunt started: The Missing Festival Heirloom');
        else if (Q.advance(S.RETURN_BELL, S.COMPLETE)) this.complete();
      } else if (v.def.key === 'shopkeeper') {
        Q.advance(S.ASK_SHOPKEEPER, S.FIND_DANGO);
      }
    });
  }

  dialog(pages, done) {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    const show = (i) => {
      const [title, text] = pages[i];
      const last = i === pages.length - 1;
      this.ui.panel(`<div class="dlg-name">${title}</div><p class="dlg-text">${text}</p>`, () => {
        if (!last) return show(i + 1);
        P.enabled = true;
        done?.();
      }, last ? 'Continue' : 'Next ›');
    };
    show(0);
  }

  complete() {
    sfx.cheer?.();
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.ui.complete(
      `<h2>🔔 Quest complete</h2><p><b>The Missing Festival Heirloom</b></p><p>You followed the torn cord and the dropped dango to the tanuki’s nest and returned the Kagura Bell. Clues found: <b>2 / 2</b>.</p>`,
      [
        ['Restart the hunt', () => this.restart()],
        ['Return to the festival', () => this.exit()],
      ],
    );
  }

  // ---------------------------------------------------------------- game loop: reset / areas
  restart() {
    this.quest.reset();
    for (const v of Object.values(this.villagers)) {
      v.state = 'idle';
      v.lastSeen = 99;
    }
    this.ui.fade(() => {
      this.placeInTown();
      this.player.enabled = true;
      this.ui.toast('The hunt has been reset. Speak to Hanae to begin again.');
    });
  }

  placeInTown() {
    const P = this.player;
    P.bounds = this.town.bounds;
    P.groundAt = (x, z) => this.town.heightAt(x, z);
    P.vel.set(0, 0, 0);
    P.place(townSpawn(), 0);
    P.pitch = -0.05;
  }

  enter() {
    this.ui.fade(() => {
      this.area = 'town';
      this.placeInTown();
      this.onArea?.('town');
      this.refreshHud();
      this.player.enabled = true;
      if (!this.introShown) {
        this.introShown = true;
        this.howToPlay();
      }
    });
  }

  exit() {
    this.ui.fade(() => {
      const P = this.player;
      this.area = 'festival';
      P.bounds = undefined;
      P.groundAt = null;
      P.vel.set(0, 0, 0);
      P.place(new THREE.Vector3(12.2, 0, 1.2), -Math.PI / 2);
      this.onArea?.('festival');
      this.refreshHud();
      P.enabled = true;
    });
  }

  howToPlay() {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.ui.panel(`<h2>🔔 The Missing Festival Heirloom</h2>
      <p>The festival's golden <b>Kagura Bell</b> has been stolen. Find it and bring it back.</p>
      <ol class="howto">
        <li>Follow the <b style="color:#ffd24a">gold ▼ marker</b>. The arrow at the top of the screen shows its direction and distance.</li>
        <li>Walk up to people and press <b>E</b> to talk. They only notice you if they can <i>see</i> you, so approach from the front.</li>
        <li>Press <b>E</b> on <b>sparkling objects</b> to examine clues (2 to find).</li>
        <li>Bring the bell back to <b>Hanae</b> to finish. The torii gate in the courtyard takes you back to the festival.</li>
      </ol>
      <p class="muted">Controls: WASD move · Mouse look (click the screen) · Shift run · E interact.</p>`,
    () => (P.enabled = true), 'Start the hunt');
  }

  // Where the player should go next (world position), following the quest state.
  target() {
    const Q = this.quest;
    const V = this.villagers;
    switch (Q.state) {
      case S.NOT_STARTED:
      case S.RETURN_BELL:
        return V.organizer.pos;
      case S.FIND_CORD:
        return Q.worldPoint('cart');
      case S.ASK_SHOPKEEPER:
        return V.shopkeeper.pos;
      case S.FIND_DANGO:
        return Q.worldPoint('dango');
      case S.FIND_BELL:
        return Q.worldPoint('bell');
      default:
        return null;
    }
  }

  refreshHud() {
    const Q = this.quest;
    if (!Q) return;
    const active = Q.state !== S.NOT_STARTED || this.area === 'town';
    this.ui.questHud(active ? { title: 'The Missing Festival Heirloom', objective: Q.objective, clues: Q.clues, bell: Q.hasBell, done: Q.state === S.COMPLETE } : null);
  }

  update(dt, t) {
    if (this.area !== 'town') return;
    const p = this.player;
    for (const v of Object.values(this.villagers)) v.update(dt, t, p, this.mode, this.debug);
    // The organizer shows a marker when she is the next person to talk to.
    this.villagers.organizer.marker.visible = this.quest.state === S.NOT_STARTED || this.quest.state === S.RETURN_BELL;
    this.villagers.shopkeeper.marker.visible = this.quest.state === S.ASK_SHOPKEEPER;
    this.quest.update(dt, t, p.pos);

    // Guidance: a gold marker above the next goal (visible through buildings), plus direction + distance.
    const tg = this.target();
    if (!this.beacon) {
      this.beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: beaconTexture(), depthTest: false, transparent: true }));
      this.beacon.renderOrder = 10;
      this.town.root.parent.add(this.beacon);
    }
    this.beacon.visible = !!tg && !this.talking;
    if (tg) {
      const d = Math.hypot(tg.x - p.pos.x, tg.z - p.pos.z);
      const s = THREE.MathUtils.clamp(d * 0.045, 0.3, 1.2);
      this.beacon.scale.set(s, s, 1);
      this.beacon.position.set(tg.x, this.town.heightAt(tg.x, tg.z) + 2.7 + Math.sin(t * 2.5) * 0.12, tg.z);
      this.beacon.material.opacity = d < 2.5 ? 0.35 : 1;
      // Angle of the target relative to where the player looks (0 = straight ahead, + = to the right).
      const f = p.forward;
      const dx = (tg.x - p.pos.x) / (d || 1);
      const dz = (tg.z - p.pos.z) / (d || 1);
      const ang = Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
      this.dirT = (this.dirT || 0) - dt;
      if (this.dirT <= 0) {
        this.dirT = 0.1; // HUD text at 10 Hz is plenty and avoids per-frame DOM work
        this.ui.questDir(ang, d);
      }
    } else {
      this.ui.questDir(null);
    }
  }

  setDebug(on) {
    this.debug = on;
  }

  // Aggregate perception statistics (radius-only vs FOV + line of sight).
  stats() {
    const out = { senses: 0, radiusHits: 0, fovLosHits: 0, falsePositivesAvoided: 0 };
    for (const v of Object.values(this.villagers)) for (const k in out) out[k] += v.stats[k];
    return out;
  }
}

let beaconTex = null;
function beaconTexture() {
  if (beaconTex) return beaconTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 54, 4, 64, 54, 60);
  grd.addColorStop(0, 'rgba(255,220,120,0.55)');
  grd.addColorStop(1, 'rgba(255,200,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffd24a';
  g.strokeStyle = '#4a2a08';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(34, 30);
  g.lineTo(94, 30);
  g.lineTo(64, 92);
  g.closePath();
  g.stroke();
  g.fill();
  beaconTex = new THREE.CanvasTexture(c);
  beaconTex.colorSpace = THREE.SRGBColorSpace;
  return beaconTex;
}
