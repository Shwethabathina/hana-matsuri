import * as THREE from 'three';
import { canvasTexture, signTexture } from './util.js';

const stripes = (a, b) =>
  canvasTexture(256, 64, (g, w, h) => {
    const n = 8;
    for (let i = 0; i < n; i++) {
      g.fillStyle = i % 2 ? b : a;
      g.fillRect((i * w) / n, 0, w / n, h);
    }
  });

// Festival stall frame. Local +z is the open front. `flip` rotates it 180° (front faces -z).
export function buildBooth(world, { pos, flip = false, sign = '屋台', signBg = '#b3202a', awning = ['#c8241c', '#f6efe0'], counter = false, width = 5, depth = 4 }) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: '#6b4a2f', roughness: 0.85 });
  const hw = width / 2;
  const hd = depth / 2;
  for (const [x, z] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.7, 0.1), wood);
    p.position.set(x, 1.35, z);
    g.add(p);
  }
  const back = new THREE.Mesh(new THREE.BoxGeometry(width, 2.5, 0.06), new THREE.MeshStandardMaterial({ color: '#e9dcc0', roughness: 0.9 }));
  back.position.set(0, 1.25, -hd);
  g.add(back);
  for (const x of [-hw, hw]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.2, depth), new THREE.MeshStandardMaterial({ color: '#f1e6cf', roughness: 0.9 }));
    side.position.set(x, 0.6, 0);
    g.add(side);
  }
  // Striped awning roof, sloping toward the front.
  const roofTex = stripes(...awning);
  roofTex.wrapS = THREE.RepeatWrapping;
  roofTex.repeat.set(width / 1.2, 1);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, 0.05, depth + 0.8), new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.8, side: THREE.DoubleSide }));
  roof.position.set(0, 2.8, 0.2);
  roof.rotation.x = 0.12;
  g.add(roof);
  const valance = new THREE.Mesh(new THREE.BoxGeometry(width + 0.4, 0.35, 0.03), new THREE.MeshStandardMaterial({ map: stripes(...awning), roughness: 0.8 }));
  valance.position.set(0, 2.55, hd + 0.6);
  g.add(valance);
  // Sign board
  const signMat = new THREE.MeshStandardMaterial({ map: signTexture(sign, { bg: signBg, w: 512, h: 128, font: 78 }), emissive: '#ffffff', emissiveIntensity: 0.2 });
  signMat.emissiveMap = signMat.map;
  world.registerGlow(signMat, 0.15, 0.9);
  const board = new THREE.Mesh(new THREE.BoxGeometry(width * 0.62, 0.55, 0.06), signMat);
  board.position.set(0, 3.15, hd + 0.35);
  g.add(board);
  if (counter) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(width - 0.2, 0.95, 0.5), new THREE.MeshStandardMaterial({ map: stripes('#c8241c', '#ffffff'), roughness: 0.85 }));
    c.position.set(0, 0.475, hd - 0.3);
    g.add(c);
  }
  // Bare bulbs under the awning
  const bulbMat = new THREE.MeshStandardMaterial({ color: '#fff2c0', emissive: '#ffcf70', emissiveIntensity: 1 });
  world.registerGlow(bulbMat, 0.2, 4);
  for (const x of [-hw * 0.6, 0, hw * 0.6]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), bulbMat);
    b.position.set(x, 2.45, hd * 0.4);
    g.add(b);
  }
  g.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  g.position.copy(pos);
  if (flip) g.rotation.y = Math.PI;
  world.scene.add(g);

  // Colliders (booth is axis aligned, so flipping just mirrors z).
  const s = flip ? -1 : 1;
  const C = world.colliders;
  C.addBox(pos.x - hw, Math.min(pos.z - hd * s, pos.z - (hd - 0.3) * s), pos.x + hw, Math.max(pos.z - hd * s, pos.z - (hd - 0.3) * s), 'booth-back');
  for (const x of [-hw, hw]) C.addBox(pos.x + x - 0.08, pos.z - hd, pos.x + x + 0.08, pos.z + hd, 'booth-side');
  if (counter) {
    const cz = pos.z + (hd - 0.3) * s;
    C.addBox(pos.x - hw, cz - 0.3, pos.x + hw, cz + 0.3, 'booth-counter');
  }
  world.addLight(new THREE.Vector3(pos.x, 2.3, pos.z + hd * 0.6 * s), { base: 7, distance: 9, flicker: 0.03 });
  return g;
}
