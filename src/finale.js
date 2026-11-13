import * as THREE from 'three';
import { RippleWater } from './games/goldfish.js';
import { L } from './layout.js';
import { G } from './state.js';
import { sfx } from './audio.js';
import { canvasTexture } from './util.js';

// Tōrō nagashi finale: once all five emblems are earned, the player releases one floating lantern per
// activity onto a small basin by the fireworks viewing area. The basin runs the same height-field wave
// simulation as the goldfish tub: each lantern splashes in, bobs on the surface height, tilts with the
// slope and drifts with the waves (and makes its own ripples). When the last lantern settles, the
// fireworks finale starts.
export const EMBLEMS = [
  { key: 'goldfish', icon: '🐟', name: 'Goldfish Scooping', color: '#ff7a3a' },
  { key: 'shateki', icon: '🎯', name: 'Shooting Gallery', color: '#e8423a' },
  { key: 'taiko', icon: '🥁', name: 'Taiko Rhythm', color: '#f2c14e' },
  { key: 'kimodameshi', icon: '👻', name: 'Test of Courage', color: '#9a7aff' },
  { key: 'treasure', icon: '🔔', name: 'Old Town Treasure Hunt', color: '#4ad08a' },
];

const POND = new THREE.Vector3(L.viewing.x, 0, L.viewing.z + 3.6);
const PW = 4.6; // basin water size (m)
const PD = 2.4;
const WATER_Y = 0.32;

export const emblemCount = () => EMBLEMS.filter((e) => G.done[e.key]).length;

export class LanternFinale {
  constructor({ world, ui, player, onFireworks }) {
    this.world = world;
    this.ui = ui;
    this.player = player;
    this.onFireworks = onFireworks;
    this.lanterns = [];
    this.state = 'locked'; // locked -> ready -> releasing -> done
    this.build();
  }

  build() {
    const W = this.world;
    const g = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: '#8d8a84', roughness: 0.95 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(PW + 0.1, 0.06, PD + 0.1), new THREE.MeshStandardMaterial({ color: '#23313a', roughness: 1 }));
    bed.position.y = 0.04;
    g.add(bed);
    for (const [w, d, x, z] of [[PW + 0.7, 0.35, 0, PD / 2 + 0.17], [PW + 0.7, 0.35, 0, -PD / 2 - 0.17], [0.35, PD, PW / 2 + 0.17, 0], [0.35, PD, -PW / 2 - 0.17, 0]]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, d), stone);
      rim.position.set(x, 0.21, z);
      rim.castShadow = rim.receiveShadow = true;
      g.add(rim);
    }
    this.water = new RippleWater(PW, PD, 72);
    this.water.base.set('#1d4f7a');
    this.water.crest.set('#bfe3ff');
    this.water.damping = 0.99;
    this.water.mesh.position.y = WATER_Y;
    g.add(this.water.mesh);
    g.position.copy(POND);
    W.scene.add(g);
    this.group = g;
    W.colliders.addRect(POND.x, POND.z, PW / 2 + 0.35, PD / 2 + 0.35, 'lantern-basin');

    // Sign
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.45), new THREE.MeshStandardMaterial({ map: signBoard(), roughness: 0.8 }));
    sign.position.set(POND.x - PW / 2 - 0.6, 1.05, POND.z - PD / 2 - 0.45);
    sign.rotation.y = Math.PI;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.0, 0.07), new THREE.MeshStandardMaterial({ color: '#4a3424' }));
    post.position.set(sign.position.x, 0.5, sign.position.z + 0.02);
    W.scene.add(sign, post);

    W.addInteractable({
      id: 'lanterns',
      pos: new THREE.Vector3(POND.x, 0, POND.z - PD / 2 - 0.9),
      radius: 2.4,
      label: () => (this.state === 'done' ? 'Watch the lanterns drift' : emblemCount() < 5 ? `Lantern basin — earn all five emblems first (${emblemCount()}/5)` : 'Release your five festival lanterns'),
      enabled: () => this.state !== 'releasing',
      action: () => this.release(),
    });
    this.sample = {};
  }

  release() {
    if (this.state === 'done') return;
    const n = emblemCount();
    if (n < 5) {
      const missing = EMBLEMS.filter((e) => !G.done[e.key]).map((e) => `${e.icon} ${e.name}`).join(', ');
      this.ui.toast(`Still to earn: ${missing}`);
      return;
    }
    this.state = 'releasing';
    this.ui.toast('🏮 Tōrō nagashi — one lantern for each part of your festival night');
    EMBLEMS.forEach((e, i) => setTimeout(() => this.addLantern(e, i), 600 + i * 900));
    setTimeout(() => {
      this.state = 'done';
      G.done.lanterns = true;
      this.onFireworks?.();
    }, 600 + EMBLEMS.length * 900 + 1800);
  }

  addLantern(emblem, i) {
    const g = new THREE.Group();
    const paper = new THREE.MeshStandardMaterial({ color: emblem.color, emissive: emblem.color, emissiveIntensity: 1.6, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), paper);
    body.position.y = 0.14;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.28), new THREE.MeshStandardMaterial({ color: '#5a3a22', roughness: 0.9 }));
    base.position.y = 0.02;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.025, 0.24), base.material);
    top.position.y = 0.255;
    g.add(base, body, top);
    // Start at the near edge, spread along it.
    const lx = -PW / 2 + 0.7 + i * ((PW - 1.4) / 4);
    const lz = -PD / 2 + 0.35;
    g.position.set(lx, WATER_Y, lz);
    this.group.add(g);
    const light = this.world.addLight(new THREE.Vector3(POND.x + lx, 0.6, POND.z + lz), { base: 3, distance: 5, color: emblem.color, flicker: 0.15 });
    this.lanterns.push({ g, x: lx, z: lz, vx: (Math.random() - 0.5) * 0.04, vz: 0.07 + Math.random() * 0.03, light, rippleT: 0 });
    this.water.disturb(lx, lz, 0.25, -0.06); // splash in
    sfx.splash?.(0.5);
  }

  update(dt) {
    const near = this.player.pos.distanceTo(POND) < 30 || this.lanterns.length;
    if (!near) return;
    this.water.update(dt);
    const s = this.sample;
    for (const l of this.lanterns) {
      this.water.sample(l.x, l.z, s);
      // Drift: a gentle current away from the shore plus the push of the local wave slope.
      l.vx += (-s.gx * 0.9 + (Math.random() - 0.5) * 0.02) * dt;
      l.vz += (-s.gz * 0.9 + 0.01) * dt;
      l.vx *= Math.exp(-0.6 * dt);
      l.vz *= Math.exp(-0.6 * dt);
      l.x += l.vx * dt;
      l.z += l.vz * dt;
      // Soft walls and lantern–lantern spacing.
      const mx = PW / 2 - 0.25;
      const mz = PD / 2 - 0.25;
      if (Math.abs(l.x) > mx) l.vx -= Math.sign(l.x) * (Math.abs(l.x) - mx) * 3 * dt;
      if (Math.abs(l.z) > mz) l.vz -= Math.sign(l.z) * (Math.abs(l.z) - mz) * 3 * dt;
      for (const o of this.lanterns) {
        if (o === l) continue;
        const dx = l.x - o.x;
        const dz = l.z - o.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.4 && d > 1e-4) {
          l.vx += (dx / d) * (0.4 - d) * 0.8 * dt;
          l.vz += (dz / d) * (0.4 - d) * 0.8 * dt;
        }
      }
      // Ride the surface: height, and tilt with the slope.
      l.g.position.set(l.x, WATER_Y + s.h, l.z);
      l.g.rotation.set(Math.atan(s.gz) * 0.8, l.g.rotation.y + dt * 0.1, -Math.atan(s.gx) * 0.8);
      // Each lantern leaves small ripples as it moves.
      l.rippleT -= dt;
      if (l.rippleT <= 0) {
        l.rippleT = 0.35;
        this.water.disturb(l.x, l.z, 0.12, 0.004 + Math.hypot(l.vx, l.vz) * 0.03);
      }
      l.light.pos.set(POND.x + l.x, 0.6, POND.z + l.z);
    }
  }

  get pos() {
    return POND;
  }
}

function signBoard() {
  return canvasTexture(256, 82, (g, w, h) => {
    g.fillStyle = '#2a1d14';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe7b0';
    g.font = 'bold 34px "Yu Mincho", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('灯籠流し', w / 2, h / 2 - 8);
    g.font = '16px sans-serif';
    g.fillText('Lantern basin', w / 2, h / 2 + 24);
  });
}
