import * as THREE from 'three';
import { glintTexture } from './town.js';
import { canvasTexture } from '../util.js';

// "The Missing Festival Heirloom" — one short treasure hunt.
// QuestState is the single authority over progress: every action goes through advance(from, to),
// which only succeeds from the expected state, so progress can never become inconsistent.
export const S = {
  NOT_STARTED: 0,
  FIND_CORD: 1, // examine Hanae's festival cart in the courtyard
  ASK_SHOPKEEPER: 2, // ask Kenta, the dango seller, about the crumbs
  PLAY_DRUMS: 3, // the tanuki only comes out to the sound of the festival taiko
  FIND_TANUKI: 4, // track the thief by its jingle and sneak up on it
  TAKE_BELL: 5, // pick up the bell it dropped
  RETURN_BELL: 6, // bring the bell back to Hanae
  RING_BELL: 7, // ring it at the festival shrine — it rings hollow: its spirit is gone
  SPIRIT_REALM: 8, // cross the haunted forest and face the guardian spirit
  RETURN_SPIRIT: 9, // carry the restored spirit back and ring the bell again
  COMPLETE: 10,
};

const OBJECTIVES = {
  [S.NOT_STARTED]: 'Find Hanae in the Old Town — through the small torii on the game plaza',
  [S.FIND_CORD]: 'Examine Hanae’s festival cart in the courtyard',
  [S.ASK_SHOPKEEPER]: 'Ask Kenta the dango seller about the crumbs',
  [S.PLAY_DRUMS]: 'Return to the festival and play the taiko drums',
  [S.FIND_TANUKI]: 'Listen for the bell — sneak up on the tanuki and grab it',
  [S.TAKE_BELL]: 'Pick up the Kagura Bell',
  [S.RETURN_BELL]: 'Bring the Kagura Bell back to Hanae',
  [S.RING_BELL]: 'Ring the Kagura Bell at the festival shrine',
  [S.SPIRIT_REALM]: 'Enter the haunted forest path and free the festival spirit',
  [S.RETURN_SPIRIT]: 'Bring the festival spirit back to the shrine',
  [S.COMPLETE]: 'The festival spirit is restored — enjoy the night',
};

// Journal entries unlocked as the story moves past each state.
const JOURNAL = [
  [S.FIND_CORD, 'The theft', 'The Kagura Bell, the festival’s heirloom, vanished from Hanae’s cart in the Old Town courtyard.'],
  [S.ASK_SHOPKEEPER, 'The cart', 'A torn red-and-white bell cord, pink-and-white dango crumbs and small paw prints heading north.'],
  [S.PLAY_DRUMS, 'Kenta’s story', 'A tanuki has been stealing dango. It hides while the town is quiet and only comes out when the festival drums play.'],
  [S.FIND_TANUKI, 'The drums', 'The taiko sounded across the festival. Back in the Old Town, a faint jingle can be heard.'],
  [S.TAKE_BELL, 'The thief', 'Caught the tanuki from behind — it dropped the bell and fled. Tanuki see well in front, poorly behind, and hear running feet.'],
  [S.RETURN_BELL, 'The heirloom', 'The Kagura Bell is recovered, a little sticky with dango.'],
  [S.RING_BELL, 'The procession', 'Hanae asked for the bell to be rung at the festival shrine to open the night procession.'],
  [S.SPIRIT_REALM, 'A hollow ring', 'The bell rang without a voice. Its spirit was dragged into the forest by a corrupted guardian — and the festival lights are fading.'],
  [S.RETURN_SPIRIT, 'The guardian', 'Four shrine lanterns lit in the spirit realm. The guardian was purified and the festival spirit returned to the bell.'],
];

export class HeirloomQuest {
  constructor(town) {
    this.town = town;
    this.state = S.NOT_STARTED;
    this.listeners = [];
    this.build();
  }

  get objective() {
    return OBJECTIVES[this.state];
  }

  get clues() {
    return (this.state > S.FIND_CORD ? 1 : 0) + (this.state > S.ASK_SHOPKEEPER ? 1 : 0) + (this.state > S.FIND_TANUKI ? 1 : 0);
  }

  get hasBell() {
    return this.state === S.RETURN_BELL || this.state === S.RING_BELL;
  }

  journal() {
    return JOURNAL.filter(([st]) => this.state >= st).map(([, title, text]) => ({ title, text }));
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  advance(from, to) {
    if (this.state !== from) return false;
    this.state = to;
    this.syncWorld();
    for (const fn of this.listeners) fn(this.state, from);
    return true;
  }

  reset() {
    const from = this.state;
    this.state = S.NOT_STARTED;
    this.syncWorld();
    for (const fn of this.listeners) fn(this.state, from);
  }

  // ---------------------------------------------------------------- world objects
  build() {
    const T = this.town;
    const scene = T.root.parent;
    const at = (x, z, dy = 0) => {
      const w = T.toWorld(x, z);
      w.y = T.heightAt(w.x, w.z) + dy;
      return w;
    };
    this.points = {
      cart: [2.2, -0.9],
      dango: [2.0, -11.5],
      bell: [-3.3, -5.3], // moved to wherever the tanuki drops it
      trail: [1.7, -7.0], // paw prints from the cart lead to the north path
    };

    // Clue 1: the festival cart the bell was taken from, with a torn red-and-white cord.
    const cart = new THREE.Group();
    // Weathered wood grain (procedural) so the cart sits with the town's textured surfaces.
    const grain = canvasTexture(256, 256, (g) => {
      g.fillStyle = '#7a5634';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 90; i++) {
        const y = Math.random() * 256;
        g.strokeStyle = `rgba(${Math.random() < 0.5 ? '40,24,12' : '160,120,80'},${0.15 + Math.random() * 0.25})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        g.moveTo(0, y);
        g.bezierCurveTo(85, y + (Math.random() - 0.5) * 8, 170, y + (Math.random() - 0.5) * 8, 256, y + (Math.random() - 0.5) * 6);
        g.stroke();
      }
      for (let x = 0; x < 256; x += 64) {
        g.fillStyle = 'rgba(20,10,4,0.55)';
        g.fillRect(0, x, 256, 2); // plank seams
      }
    });
    const wood = new THREE.MeshStandardMaterial({ map: grain, roughness: 0.9 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.9), wood);
    bed.position.y = 0.62;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 0.05), wood);
    rail.position.set(0, 0.8, 0.43);
    const rail2 = rail.clone();
    rail2.position.z = -0.43;
    cart.add(bed, rail, rail2);
    for (const x of [-0.6, 0.6]) {
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 6, 16), wood);
      wheel.rotation.y = Math.PI / 2;
      wheel.position.set(x, 0.3, 0.5);
      const w2 = wheel.clone();
      w2.position.z = -0.5;
      cart.add(wheel, w2);
    }
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), new THREE.MeshStandardMaterial({ color: '#b3202a' }));
    stand.position.set(0, 0.92, 0);
    cart.add(stand);
    this.cord = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.025), new THREE.MeshStandardMaterial({ color: i % 2 ? '#ffffff' : '#c8241c' }));
      seg.position.set(0.55 + i * 0.1, 0.8 - i * 0.07, 0.45);
      seg.rotation.z = -0.6;
      this.cord.add(seg);
    }
    cart.add(this.cord);
    cart.position.copy(at(...this.points.cart));
    cart.rotation.y = 0.4;
    scene.add(cart);

    // Clue 2: a dropped, half-eaten dango skewer and the start of a paw-print trail.
    this.dango = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 5).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#e8d6a8' }));
    this.dango.add(stick);
    ['#f4b6c8', '#ffffff'].forEach((col, i) => {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }));
      ball.position.x = -0.06 + i * 0.08;
      this.dango.add(ball);
    });
    this.dango.position.copy(at(...this.points.dango, 0.05));
    this.dango.rotation.y = 0.8;
    scene.add(this.dango);

    // Paw prints from the dango to the hiding place (visible once clue 2 is found).
    this.prints = new THREE.Group();
    const printMat = new THREE.MeshBasicMaterial({ color: '#3b2a1c', transparent: true, opacity: 0.75, depthWrite: false });
    const printGeo = new THREE.CircleGeometry(0.06, 8).rotateX(-Math.PI / 2);
    // Follow the real walkable route from the dango to the hiding place.
    const route = T.findPath([this.points.cart[0] - 0.6, this.points.cart[1] - 0.6], this.points.trail);
    for (let i = 2; i < route.length - 1; i += 2) {
      const [x, z] = route[i];
      const [nx, nz] = route[Math.min(route.length - 1, i + 1)];
      const side = (i / 2) % 2 ? 0.09 : -0.09;
      const len = Math.hypot(nx - x, nz - z) || 1;
      const p = new THREE.Mesh(printGeo, printMat);
      p.position.copy(at(x - ((nz - z) / len) * side, z + ((nx - x) / len) * side)).add(new THREE.Vector3(0, 0.03, 0));
      this.prints.add(p);
    }
    scene.add(this.prints);

    // The heirloom: a golden Kagura bell cluster in a straw nest, tucked behind the round tower.
    this.bell = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: '#d9a93a', metalness: 0.85, roughness: 0.25, emissive: '#5a3a08', emissiveIntensity: 0.4 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 8), new THREE.MeshStandardMaterial({ color: '#b3202a' }));
    handle.position.y = 0.32;
    this.bell.add(handle);
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), gold);
      b.position.set(Math.cos(i * 1.26) * 0.09, 0.14 + (i % 2) * 0.05, Math.sin(i * 1.26) * 0.09);
      this.bell.add(b);
    }
    const nest = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.08, 6, 14).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#c9a35e', roughness: 1 }));
    nest.position.y = 0.06;
    this.nest = nest;
    this.bellRoot = new THREE.Group();
    this.bellRoot.add(nest, this.bell);
    this.bellRoot.position.copy(at(...this.points.bell));
    scene.add(this.bellRoot);

    // Small glints only near the current clue (they help the eye without being beacons).
    this.glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: glintTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.glint.scale.setScalar(0.45);
    scene.add(this.glint);
    this.syncWorld();
  }

  worldPoint(key) {
    const [x, z] = this.points[key];
    return this.town.toWorld(x, z);
  }

  currentTarget() {
    return { [S.FIND_CORD]: 'cart', [S.TAKE_BELL]: 'bell' }[this.state] || null;
  }

  syncWorld() {
    const s = this.state;
    // Clue objects only appear once the story has pointed the player towards them.
    this.dango.visible = false;
    this.prints.visible = s >= S.FIND_CORD && s <= S.FIND_TANUKI;
    this.bellRoot.visible = s === S.TAKE_BELL;
    this.bell.visible = s === S.TAKE_BELL;
    this.nest.visible = false;
    this.cord.visible = s <= S.FIND_CORD;
  }

  // Place the dropped bell (world position).
  dropBell(pos) {
    this.bellRoot.position.set(pos.x, this.town.heightAt(pos.x, pos.z), pos.z);
    const o = this.town.root.position;
    this.points.bell = [pos.x - o.x, pos.z - o.z];
  }

  // Discovery flourish: a ring of glints that expands and fades around the bell.
  burst(pos) {
    const scene = this.town.root.parent;
    const n = 14;
    const sprites = [];
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glintTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      sp.position.copy(pos).add(new THREE.Vector3(0, 0.25, 0));
      sp.userData.a = (i / n) * Math.PI * 2;
      scene.add(sp);
      sprites.push(sp);
    }
    this.bursts = { sprites, t: 0, origin: pos.clone() };
  }

  update(dt, t, playerPos) {
    if (this.bursts) {
      const b = this.bursts;
      b.t += dt;
      const k = b.t / 1.3;
      for (const sp of b.sprites) {
        const r = 0.2 + k * 1.4;
        sp.position.set(b.origin.x + Math.cos(sp.userData.a) * r, b.origin.y + 0.25 + k * 0.9, b.origin.z + Math.sin(sp.userData.a) * r);
        sp.scale.setScalar(0.35 * (1 - k * 0.6));
        sp.material.opacity = Math.max(0, 1 - k);
      }
      if (k >= 1) {
        for (const sp of b.sprites) {
          sp.parent.remove(sp);
          sp.material.dispose();
        }
        this.bursts = null;
      }
    }
    const key = this.currentTarget();
    if (!key) {
      this.glint.visible = false;
      return;
    }
    const p = { cart: this.cord, dango: this.dango, bell: this.bell }[key];
    const wp = p.getWorldPosition(new THREE.Vector3());
    const d = Math.hypot(wp.x - playerPos.x, wp.z - playerPos.z);
    this.glint.visible = d < 30;
    this.glint.position.copy(wp).add(new THREE.Vector3(0, 0.25 + Math.sin(t * 3) * 0.05, 0));
    this.glint.material.opacity = 0.5 + Math.sin(t * 6) * 0.3;
    if (key === 'bell') this.bell.rotation.y += dt * 0.6;
  }
}
