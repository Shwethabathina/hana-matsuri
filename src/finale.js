import * as THREE from 'three';
import { G } from './state.js';
import { sfx } from './audio.js';
import { RiverFinale, RIVER, DECK } from './riverfinale.js';

// Grand finale — the Lantern Festival on the river (tōrō nagashi).
// Earning all five emblems unlocks the riverfront deck south of the fireworks viewing area. Pressing E
// there begins the celebration: a short camera sequence (establishing shot -> your lantern settling onto
// the water -> the wide view), then control returns while hundreds of lanterns drift downstream, sky
// lanterns rise and fireworks bloom above the river, all mirrored in the moving water. A "Festival
// Restored" screen closes the show, with Continue Exploring and Restart.
export const EMBLEMS = [
  { key: 'goldfish', icon: '🐟', name: 'Goldfish Scooping', color: '#ff7a3a' },
  { key: 'shateki', icon: '🎯', name: 'Shooting Gallery', color: '#e8423a' },
  { key: 'taiko', icon: '🥁', name: 'Taiko Rhythm', color: '#f2c14e' },
  { key: 'kimodameshi', icon: '👻', name: 'Test of Courage', color: '#9a7aff' },
  { key: 'treasure', icon: '🔔', name: 'Old Town Treasure Hunt', color: '#4ad08a' },
];

export const emblemCount = () => EMBLEMS.filter((e) => G.done[e.key]).length;
const missing = () => EMBLEMS.filter((e) => !G.done[e.key]);
const SHOW_END = 80; // seconds from pressing E to the completion screen

const look = (pos, target) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0)));

export class LanternFinale {
  constructor({ world, ui, player, fireworks, spirits, onNight, onDone }) {
    this.world = world;
    this.ui = ui;
    this.player = player;
    this.fireworks = fireworks;
    this.onNight = onNight;
    this.onDone = onDone;
    this.state = 'idle'; // idle -> intro -> show -> done
    this.river = new RiverFinale({ world, fireworks, spirits });
    this.cam = null;
    world.addInteractable({
      id: 'lanterns',
      pos: this.river.releasePoint.clone().setZ(DECK.z1 - 0.6),
      radius: 2.6,
      priority: true,
      label: () => {
        if (this.state === 'intro' || this.state === 'show') return 'The Lantern Festival is under way';
        if (emblemCount() < 5) return `Lantern Festival — still to earn: ${missing().map((e) => `${e.icon} ${e.name}`).join(', ')}`;
        return this.state === 'done' ? 'Release another lantern (replay the festival)' : 'Begin the Lantern Festival';
      },
      enabled: () => this.state !== 'intro' && this.state !== 'show',
      action: () => this.begin(),
    });
  }

  get pos() {
    return this.river.releasePoint;
  }

  begin() {
    if (this.state === 'intro' || this.state === 'show') return;
    if (emblemCount() < 5) {
      this.ui.toast(`The festival spirit needs all five emblems. Still to earn: ${missing().map((e) => `${e.icon} ${e.name}`).join(', ')}`);
      return;
    }
    if (!this.explained) {
      // First time: a short explanation of what is about to happen.
      this.explained = true;
      const P = this.player;
      P.enabled = false;
      P.unlock();
      this.ui.complete(
        `<div class="dlg-role">灯籠流し · Tōrō nagashi</div><h2 class="fin">The Lantern Festival</h2>
         <ul class="intro">
           <li><b>Your lantern</b> When you begin, the camera follows as your paper lantern is set on the river (it is released for you).</li>
           <li><b>The show</b> After a few seconds you can walk again: watch hundreds of lanterns drift downstream, sky lanterns rise and fireworks bloom over the water (about a minute).</li>
           <li><b>Afterwards</b> Choose <b>Continue exploring</b> or <b>Restart</b>. Press <b>E</b> on the deck any time to replay it.</li>
         </ul>`,
        [
          ['Begin the Lantern Festival', () => this.begin()],
          ['Not yet', () => (P.enabled = true)],
        ],
      );
      return;
    }
    this.state = 'intro';
    this.river.start();
    this.onNight?.();
    const P = this.player;
    P.enabled = false;
    P.unlock();
    P.vel.set(0, 0, 0);
    this.ui.prompt(null);
    this.ui.toast('🏮 Tōrō nagashi — the Lantern Festival begins');
    sfx.suzu();
    const D = DECK;
    // Camera keyframes: [time, position, look-at]
    this.cam = {
      t: 0,
      start: { pos: null, quat: null },
      keys: [
        [3.4, new THREE.Vector3(D.x - 2, 9.5, D.z1 - 0.2), new THREE.Vector3(D.x + 3, 6, 80)], // establishing: river, banks, sky
        [6.2, new THREE.Vector3(D.x, 1.55, D.z1 - 0.4), new THREE.Vector3(D.x, -0.3, RIVER.zN + 2.2)], // the release, from the steps
        [9.6, new THREE.Vector3(D.x, 1.6, D.z1 - 0.3), new THREE.Vector3(D.x - 3, 0.2, RIVER.zN + 5)], // it drifts away
        [12.5, new THREE.Vector3(D.x, 2.1, D.z1 - 0.9), new THREE.Vector3(D.x, 9, 75)], // the wide view
      ],
    };
    this.released = false;
    this.fwStarted = 0;
  }

  // Called by main every frame while this.cam is set (replaces the first-person camera).
  applyCamera(camera) {
    const C = this.cam;
    if (!C.start.quat) {
      C.start.pos = camera.position.clone();
      C.start.quat = camera.quaternion.clone();
    }
    let prevT = 0;
    let prevPos = C.start.pos;
    let prevQ = C.start.quat;
    for (const [kt, kp, kl] of C.keys) {
      const kq = look(kp, kl);
      if (C.t <= kt) {
        const u = Math.min(1, Math.max(0, (C.t - prevT) / (kt - prevT)));
        const e = u * u * (3 - 2 * u);
        camera.position.lerpVectors(prevPos, kp, e);
        camera.quaternion.slerpQuaternions(prevQ, kq, e);
        return;
      }
      prevT = kt;
      prevPos = kp;
      prevQ = kq;
    }
    camera.position.copy(prevPos);
    camera.quaternion.copy(prevQ);
  }

  update(dt, t) {
    this.river.update(dt, t, this.player.pos);
    if (this.state !== 'intro' && this.state !== 'show') return;
    const T = this.river.t;
    if (this.cam) {
      this.cam.t += dt;
      if (!this.released && this.cam.t > 5.6) {
        this.released = true;
        this.river.releasePlayerLantern();
        sfx.splash?.(0.4);
        this.ui.toast('Your lantern settles onto the river…');
      }
      if (this.cam.t > 12.6) {
        // Hand control back on the deck, looking out over the river; the show continues around the player.
        const P = this.player;
        P.place(new THREE.Vector3(DECK.x, 0, DECK.z1 - 0.9), Math.PI);
        P.pitch = 0.16;
        P.enabled = true;
        this.cam = null;
        this.state = 'show';
        this.ui.toast('Look around — lanterns fill the river and the sky. Walk freely; the show goes on.');
      }
    }
    // The existing fireworks show (shells, crackle, sound) joins the baked fireworks over the river.
    if (T > 12 && this.fwStarted === 0) {
      this.fwStarted = 1;
      this.fireworks.startShow(() => {});
    }
    if (T > 46 && this.fwStarted === 1 && !this.fireworks.show) {
      this.fwStarted = 2;
      this.fireworks.startShow(() => {});
    }
    if (T > SHOW_END && this.state === 'show') this.finish();
  }

  finish() {
    this.state = 'done';
    G.done.lanterns = true;
    this.onDone?.();
    const P = this.player;
    P.enabled = false;
    P.unlock();
    const s = this.river.stats();
    this.ui.complete(
      `<div class="dlg-role">花祭り · Hana Matsuri</div><h2 class="fin">🏮 Festival Restored</h2>
       <p>The Kagura Bell sings again, and the festival spirit has come home. Your lantern leads ${Math.max(0, s.floating - 1)} others down the river while ${s.sky} sky lanterns drift toward the stars.</p>
       <p class="muted">Emblems ${EMBLEMS.map((e) => e.icon).join(' ')} · Foods tried ${G.foods?.size ?? 0} · Prizes ${G.prizes?.length ?? 0}. Thank you for spending the night at Hana Matsuri.</p>`,
      [
        ['Continue exploring', () => (P.enabled = true)],
        ['Restart the Lantern Festival', () => this.begin()],
      ],
    );
  }
}
