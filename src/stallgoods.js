import * as THREE from 'three';
import { L, STALLS } from './layout.js';
import { rand } from './util.js';

// Festival food and goods on the stall counters. Counter tops are found by ray-casting
// down onto the real street model, so items sit on whatever surface the stall has.

const KINDS = {
  tray: [new THREE.BoxGeometry(0.17, 0.025, 0.09), { color: '#e6d6b0', roughness: 0.8 }],
  tako: [new THREE.SphereGeometry(0.024, 10, 8), { color: '#b0702c', roughness: 0.55 }],
  nori: [new THREE.BoxGeometry(0.008, 0.002, 0.008), { color: '#2f6a2a' }],
  skewer: [new THREE.CylinderGeometry(0.003, 0.003, 0.24, 5).rotateZ(Math.PI / 2), { color: '#e8d6a8' }],
  meat: [new THREE.BoxGeometry(0.03, 0.028, 0.03), { color: '#7a3416', roughness: 0.5 }],
  grill: [new THREE.BoxGeometry(0.5, 0.04, 0.2), { color: '#2a2622', metalness: 0.6, roughness: 0.5 }],
  ember: [new THREE.BoxGeometry(0.46, 0.01, 0.16), { color: '#ff5a1a', emissive: '#ff4a10', emissiveIntensity: 1.2 }],
  styro: [new THREE.BoxGeometry(0.42, 0.09, 0.12), { color: '#f2f2ee', roughness: 0.9 }],
  banana: [new THREE.CylinderGeometry(0.017, 0.016, 0.1, 10).translate(0, 0.05, 0), { color: '#f0d050' }],
  choco: [new THREE.CylinderGeometry(0.02, 0.019, 0.09, 10).translate(0, 0.135, 0), { roughness: 0.3 }],
  stick: [new THREE.CylinderGeometry(0.004, 0.004, 0.12, 5).translate(0, -0.03, 0), { color: '#e8d6a8' }],
  foil: [new THREE.SphereGeometry(0.045, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { color: '#d8d8dc', metalness: 0.95, roughness: 0.3 }],
  potato: [new THREE.SphereGeometry(0.035, 10, 8).scale(1.1, 0.7, 0.9), { color: '#d9b26a' }],
  butter: [new THREE.BoxGeometry(0.022, 0.014, 0.022), { color: '#ffe680', roughness: 0.3 }],
  plate: [new THREE.CylinderGeometry(0.1, 0.09, 0.012, 20), { color: '#f6f3ea', roughness: 0.4 }],
  pancake: [new THREE.CylinderGeometry(0.075, 0.075, 0.022, 20), { color: '#c4863c' }],
  sauce: [new THREE.CylinderGeometry(0.068, 0.068, 0.004, 20), { color: '#3a180a', roughness: 0.25 }],
  bonito: [new THREE.BoxGeometry(0.012, 0.002, 0.01), { color: '#e8b896' }],
  bottle: [new THREE.CylinderGeometry(0.022, 0.024, 0.17, 12).translate(0, 0.085, 0), { color: '#9fe6dc', transparent: true, opacity: 0.6, roughness: 0.05, metalness: 0.1 }],
  marble: [new THREE.SphereGeometry(0.011, 8, 6), { color: '#cfe8ff', roughness: 0.05 }],
  cap: [new THREE.CylinderGeometry(0.016, 0.016, 0.02, 10), { color: '#2a6fd0' }],
  tub: [new THREE.BoxGeometry(0.42, 0.14, 0.24).translate(0, 0.07, 0), { color: '#3a86c8', roughness: 0.4 }],
  ice: [new THREE.BoxGeometry(0.38, 0.02, 0.2), { color: '#dff4ff', transparent: true, opacity: 0.7, roughness: 0.05 }],
  apple: [new THREE.SphereGeometry(0.036, 14, 10), { color: '#ffffff', roughness: 0.12, metalness: 0.1 }],
  wata: [new THREE.SphereGeometry(1, 12, 8).scale(0.065, 0.085, 0.035), { color: '#ffffff', roughness: 0.6, emissive: '#ffffff', emissiveIntensity: 0.06 }],
  pole: [new THREE.CylinderGeometry(0.008, 0.008, 0.5, 6).translate(0, 0.25, 0), { color: '#8a6440' }],
  cup: [new THREE.CylinderGeometry(0.036, 0.026, 0.055, 12).translate(0, 0.0275, 0), { color: '#f4f4f4' }],
  shaved: [new THREE.SphereGeometry(0.042, 12, 8).scale(1, 0.85, 1), { color: '#ffffff', roughness: 0.8 }],
  pot: [new THREE.CylinderGeometry(0.16, 0.15, 0.12, 20).translate(0, 0.06, 0), { color: '#9a9aa0', metalness: 0.8, roughness: 0.35 }],
  broth: [new THREE.CylinderGeometry(0.15, 0.15, 0.005, 20), { color: '#c99a4a', roughness: 0.1 }],
  egg: [new THREE.SphereGeometry(0.025, 10, 8).scale(1, 1.2, 1), { color: '#c9a26a' }],
  daikon: [new THREE.CylinderGeometry(0.03, 0.03, 0.025, 12), { color: '#e6d7a8' }],
  toy: [new THREE.BoxGeometry(0.07, 0.09, 0.05).translate(0, 0.045, 0), { roughness: 0.5 }],
  step: [new THREE.BoxGeometry(2.6, 0.22, 0.4), { color: '#b3202a', roughness: 0.8 }],
  sign: [new THREE.BoxGeometry(0.16, 0.08, 0.005), { color: '#fff4dc' }],
};

// Slightly larger than life so food reads at first-person distance.
const SCALE = 1.35;

export function buildStallGoods(world) {
  const lists = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const anchor = new THREE.Vector3();
  const add = (kind, x, y, z, ry = 0, s = 1, color = null, rx = 0, rz = 0) => {
    q.setFromEuler(e.set(rx, ry, rz));
    // Scale the whole arrangement about its anchor so spacing grows with item size.
    const k = s * SCALE;
    const p = new THREE.Vector3(anchor.x + (x - anchor.x) * SCALE, anchor.y + (y - anchor.y) * SCALE, anchor.z + (z - anchor.z) * SCALE);
    lists[kind].push({ m: m.clone().compose(p, q, new THREE.Vector3(k, k, k)), color });
  };

  // ---- item arrangements (x,z = centre on the counter, y = counter top) ----
  const takoyaki = (x, y, z) => {
    for (let b = 0; b < 2; b++) {
      const bx = x + (b - 0.5) * 0.22;
      add('tray', bx, y + 0.012, z, rand(-0.2, 0.2));
      for (let i = 0; i < 8; i++) add('tako', bx + ((i % 4) - 1.5) * 0.034, y + 0.042, z + (Math.floor(i / 4) - 0.5) * 0.036);
      for (let i = 0; i < 10; i++) add('nori', bx + rand(-0.06, 0.06), y + 0.066, z + rand(-0.03, 0.03), rand(0, 3));
    }
  };
  const yakitori = (x, y, z) => {
    add('grill', x, y + 0.02, z);
    add('ember', x, y + 0.045, z);
    for (let i = 0; i < 7; i++) {
      const sx = x - 0.21 + i * 0.07;
      add('skewer', sx, y + 0.06, z, Math.PI / 2);
      for (let k = 0; k < 4; k++) add('meat', sx, y + 0.065, z - 0.06 + k * 0.035, rand(-0.3, 0.3));
    }
  };
  const chocoBanana = (x, y, z) => {
    add('styro', x, y + 0.045, z);
    const tops = ['#3a1d10', '#f4a6c8', '#f2f0ea', '#5a2a14'];
    for (let i = 0; i < 6; i++) {
      const bx = x - 0.17 + i * 0.068;
      const tilt = rand(-0.08, 0.08);
      add('stick', bx, y + 0.12, z, 0, 1, null, tilt);
      add('banana', bx, y + 0.12, z, 0, 1, null, tilt);
      add('choco', bx, y + 0.12, z, 0, 1, tops[i % tops.length], tilt);
    }
  };
  const jagaButter = (x, y, z) => {
    for (let i = 0; i < 4; i++) {
      const px = x - 0.15 + i * 0.1;
      add('foil', px, y, z + rand(-0.02, 0.02));
      add('potato', px, y + 0.035, z);
      add('butter', px, y + 0.06, z, rand(0, 1));
    }
  };
  const okonomiyaki = (x, y, z) => {
    for (let i = 0; i < 2; i++) {
      const px = x + (i - 0.5) * 0.22;
      add('plate', px, y + 0.006, z);
      add('pancake', px, y + 0.023, z);
      add('sauce', px, y + 0.036, z);
      for (let k = 0; k < 14; k++) add('bonito', px + rand(-0.05, 0.05), y + 0.04, z + rand(-0.05, 0.05), rand(0, 3), 1, null, rand(-0.5, 0.5));
    }
  };
  const oden = (x, y, z) => {
    add('pot', x, y, z);
    add('broth', x, y + 0.1, z);
    for (let i = 0; i < 4; i++) add('egg', x + rand(-0.09, 0.09), y + 0.105, z + rand(-0.09, 0.09));
    for (let i = 0; i < 4; i++) add('daikon', x + rand(-0.09, 0.09), y + 0.104, z + rand(-0.09, 0.09));
  };
  const ramune = (x, y, z) => {
    add('tub', x, y, z);
    add('ice', x, y + 0.13, z);
    for (let i = 0; i < 8; i++) {
      const bx = x - 0.15 + (i % 4) * 0.1;
      const bz = z - 0.05 + Math.floor(i / 4) * 0.1;
      add('bottle', bx, y + 0.06, bz, 0, 1, null, rand(-0.12, 0.12), rand(-0.12, 0.12));
      add('marble', bx, y + 0.2, bz);
      add('cap', bx, y + 0.235, bz);
    }
  };
  const candyApple = (x, y, z) => {
    add('styro', x, y + 0.045, z);
    for (let i = 0; i < 6; i++) {
      const ax = x - 0.17 + i * 0.068;
      add('stick', ax, y + 0.12, z);
      add('apple', ax, y + 0.17, z, 0, i % 3 === 0 ? 0.7 : 1, i % 3 === 0 ? '#c8183a' : '#b00a14');
    }
  };
  const watagashi = (x, y, z) => {
    const cols = ['#ffb0cf', '#a8d8ff', '#fff0a0', '#c8b0ff', '#b8f0c8'];
    for (let i = 0; i < 3; i++) {
      const px = x - 0.18 + i * 0.18;
      add('pole', px, y, z);
      for (let k = 0; k < 3; k++) add('wata', px + (k - 1) * 0.06, y + 0.32 + (k % 2) * 0.12, z + 0.04, rand(-0.3, 0.3), 1, cols[(i * 3 + k) % cols.length]);
    }
  };
  const kakigori = (x, y, z) => {
    const syrups = ['#ff3a4a', '#4ac0ff', '#7ae05a', '#ffd23a'];
    for (let i = 0; i < 4; i++) {
      const cx = x - 0.15 + i * 0.1;
      add('cup', cx, y, z);
      add('shaved', cx, y + 0.075, z, 0, 1, syrups[i]);
    }
  };
  const THEMES = {
    'Takoyaki': takoyaki,
    'Yakitori': yakitori,
    'Choco Banana': chocoBanana,
    'Jaga Butter': jagaButter,
    'Okonomiyaki': okonomiyaki,
    'Oden': oden,
  };
  const generic = [ramune, candyApple, watagashi, kakigori];

  // ---- find counter tops on the street model ----
  // The stall tables are the "*_dai_*" meshes. Their top vertices give the height and depth
  // of each counter, so items sit exactly on the model.
  const spots = [];
  if (world.model) {
    const verts = [];
    const v = new THREE.Vector3();
    world.model.traverse((o) => {
      if (!o.isMesh || !/_dai_/.test(o.name)) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        if (v.y > 0.55 && v.y < 1.15) verts.push({ x: v.x, y: v.y, z: v.z });
      }
    });
    for (const side of [-1, 1]) {
      const row = verts.filter((p) => Math.sign(p.z) === side);
      for (let x = -7.2; x <= 9.9; x += 0.7) {
        const near = row.filter((p) => Math.abs(p.x - x) < 0.8);
        if (near.length < 3) continue;
        const y = Math.max(...near.map((p) => p.y));
        // Only the top-surface vertices define the counter depth.
        const top = near.filter((p) => p.y > y - 0.02 && Math.abs(p.x - x) < 0.45);
        if (top.length < 2) continue;
        const zs = top.map((p) => p.z);
        spots.push({ x, y, z: (Math.min(...zs) + Math.max(...zs)) / 2, side });
      }
    }
  }
  let g = 0;
  for (const s of spots) {
    const stall = STALLS.find((st) => st.side === s.side && Math.abs(st.x - s.x) < 1.1);
    anchor.set(s.x, s.y, s.z);
    (stall ? THEMES[stall.name] : generic[g++ % generic.length])(s.x, s.y, s.z);
  }

  // ---- ring-toss prize steps (booth opens toward -z) ----
  const R = L.ringtoss;
  const toyCols = ['#ff5a5a', '#5ab0ff', '#ffd24a', '#7ae05a', '#c87aff', '#ff9a3a'];
  anchor.set(R.x, 0, R.z + 0.7);
  for (let i = 0; i < 3; i++) {
    const y = 0.11 + i * 0.22;
    const z = R.z + 0.7 + i * 0.4;
    add('step', R.x, y, z);
    for (let k = 0; k < 7; k++) {
      const px = R.x - 1.1 + k * 0.37;
      if ((k + i) % 2) add('bottle', px, y + 0.11, z, 0, 1.3);
      else add('toy', px, y + 0.11, z, rand(-0.3, 0.3), 1.6, toyCols[(k + i) % toyCols.length]);
    }
  }

  // ---- build one instanced mesh per item kind ----
  const meshes = [];
  for (const [kind, items] of Object.entries(lists)) {
    if (!items.length) continue;
    const [geo, mat] = KINDS[kind];
    const material = new THREE.MeshStandardMaterial({ roughness: 0.6, ...mat });
    if (kind === 'ember') world.registerGlow(material, 0.8, 2.2);
    const im = new THREE.InstancedMesh(geo, material, items.length);
    items.forEach((it, i) => {
      im.setMatrixAt(i, it.m);
      // Instance colour multiplies the material colour, so un-tinted items use white.
      if (items.some((o) => o.color)) im.setColorAt(i, new THREE.Color(it.color || '#ffffff'));
    });
    im.castShadow = kind === 'step' || kind === 'pot' || kind === 'styro';
    im.receiveShadow = true;
    world.scene.add(im);
    meshes.push(im);
  }
  return { spots: spots.length, items: Object.values(lists).reduce((a, l) => a + l.length, 0) };
}
