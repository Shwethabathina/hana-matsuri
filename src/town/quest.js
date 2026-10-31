import * as THREE from 'three';
import { glintTexture } from './town.js';
import { canvasTexture } from '../util.js';

// "The Missing Festival Heirloom" — one short treasure hunt.
// QuestState is the single authority over progress: every action goes through advance(from, to),
// which only succeeds from the expected state, so progress can never become inconsistent.
export const S = {
  NOT_STARTED: 0,
  FIND_CORD: 1, // examine the festival cart in the courtyard
  ASK_SHOPKEEPER: 2, // ask the dango seller about the cord
  FIND_DANGO: 3, // follow the north road to what the thief dropped
  FIND_BELL: 4, // follow the paw prints to the hiding place
  RETURN_BELL: 5, // bring the bell back to the organizer
  COMPLETE: 6,
};

const OBJECTIVES = {
  [S.NOT_STARTED]: 'Talk to Hanae, the festival organizer',
  [S.FIND_CORD]: 'Examine the festival cart in the courtyard',
  [S.ASK_SHOPKEEPER]: 'Ask Kenta the dango seller about the torn cord',
  [S.FIND_DANGO]: 'Search the north road for what the thief dropped',
  [S.FIND_BELL]: 'Follow the paw prints to the hiding place',
  [S.RETURN_BELL]: 'Return the Kagura Bell to the organizer',
  [S.COMPLETE]: 'Treasure hunt complete!',
};

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
    return (this.state > S.FIND_CORD ? 1 : 0) + (this.state > S.FIND_DANGO ? 1 : 0);
  }

  get hasBell() {
    return this.state === S.RETURN_BELL;
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
      bell: [-3.3, -5.3], // quiet pocket behind the west building
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
    const route = T.findPath(this.points.dango, this.points.bell);
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
    return { [S.FIND_CORD]: 'cart', [S.FIND_DANGO]: 'dango', [S.FIND_BELL]: 'bell' }[this.state] || null;
  }

  syncWorld() {
    const s = this.state;
    // Clue objects only appear once the story has pointed the player towards them.
    this.dango.visible = s === S.FIND_DANGO || s === S.FIND_BELL;
    this.prints.visible = s === S.FIND_BELL;
    this.bellRoot.visible = s === S.FIND_BELL;
    this.bell.visible = s === S.FIND_BELL;
    this.cord.visible = s <= S.FIND_CORD;
  }

  update(dt, t, playerPos) {
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
