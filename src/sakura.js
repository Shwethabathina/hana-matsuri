import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm } from './island.js';
import { rand } from './util.js';

// Instanced cherry-blossom trees: gnarled trunk + branches, a dome of blossom clusters.
// spots: [x, z, baseY, scale]
export function buildSakuraGrove(world, spots) {
  const branch = (len, r0, r1, rx, rz, y) => {
    const g = new THREE.CylinderGeometry(r1, r0, len, 7).translate(0, len / 2, 0);
    g.rotateX(rx);
    g.rotateZ(rz);
    g.translate(0, y, 0);
    return g;
  };
  const trunkGeo = mergeGeometries([
    branch(2.6, 0.34, 0.24, 0, 0.08, 0),
    branch(2.2, 0.2, 0.08, 0.1, 0.85, 2.3),
    branch(2.0, 0.18, 0.07, 0.2, -0.9, 2.2),
    branch(1.9, 0.17, 0.07, 0.95, 0.1, 2.4),
    branch(1.8, 0.16, 0.06, -0.9, -0.1, 2.3),
    branch(1.6, 0.15, 0.06, 0.1, 0.1, 2.5),
  ]);
  const blobGeo = new THREE.IcosahedronGeometry(1, 2);
  const bp = blobGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(bp, i);
    v.multiplyScalar(0.8 + fbm(v.x * 2.5 + 7, v.y * 2.5, v.z * 2.5) * 0.45);
    bp.setXYZ(i, v.x, v.y * 0.78, v.z);
  }
  blobGeo.computeVertexNormals();

  const BLOBS = 15;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#3e2a22', roughness: 0.95 }), spots.length);
  const blossomMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, emissive: '#ff86b0', emissiveIntensity: 0.05 });
  world.registerGlow(blossomMat, 0.03, 0.2);
  const blossoms = new THREE.InstancedMesh(blobGeo, blossomMat, spots.length * BLOBS);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pinks = ['#ffc0d4', '#ffb0c8', '#ff9fbf', '#ffd3e2', '#f7a6c4', '#ffe1ea'];
  const base = [];
  let k = 0;
  spots.forEach(([x, z, y = 0, s = 1], i) => {
    q.setFromEuler(e.set(0, rand(0, 6.28), 0));
    m.compose(new THREE.Vector3(x, y - 0.1, z), q, new THREE.Vector3(s, s * rand(0.9, 1.1), s));
    trunks.setMatrixAt(i, m);
    for (let b = 0; b < BLOBS; b++) {
      // Points inside a flattened dome, denser toward the outside.
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * 2.6;
      const h = 3.6 + rand(-0.4, 1.4) - (r / 2.6) * 0.9;
      const bs = rand(0.95, 1.55) * s;
      q.setFromEuler(e.set(rand(0, 3), rand(0, 6), rand(0, 3)));
      const p = new THREE.Vector3(x + Math.cos(a) * r * s, y + h * s, z + Math.sin(a) * r * s);
      m.compose(p, q, new THREE.Vector3(bs, bs, bs));
      base.push({ p, q: q.clone(), s: bs, lever: (h * s) / 4, phase: i * 1.7 + b * 0.35 });
      blossoms.setMatrixAt(k, m);
      blossoms.setColorAt(k, new THREE.Color(pinks[(i + b) % pinks.length]));
      k++;
    }
    world.colliders.addCircle(x, z, 0.4 * s, 'sakura');
  });
  trunks.castShadow = trunks.receiveShadow = true;
  blossoms.castShadow = true;
  blossoms.receiveShadow = true;
  world.scene.add(trunks, blossoms);

  // Wind sway: each blossom cluster swings around its rest position, more for higher clusters
  // and in gusts, with a per-tree phase so the grove does not move in lockstep.
  const pos = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const qq = new THREE.Quaternion();
  const tilt = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const update = (t, wind) => {
    const amp = 0.05 + wind * 0.16;
    for (let i = 0; i < base.length; i++) {
      const b = base[i];
      const sway = Math.sin(t * 1.3 + b.phase) + 0.35 * Math.sin(t * 3.1 + b.phase * 2.3);
      const ox = sway * amp * b.lever + wind * 0.06 * b.lever;
      const oz = Math.cos(t * 1.05 + b.phase) * amp * 0.6 * b.lever;
      pos.set(b.p.x + ox, b.p.y - Math.abs(ox) * 0.15, b.p.z + oz);
      tilt.setFromAxisAngle(axis.set(oz, 0, -ox).normalize(), Math.hypot(ox, oz) * 0.6);
      qq.copy(tilt).multiply(b.q);
      m.compose(pos, qq, sc.set(b.s, b.s, b.s));
      blossoms.setMatrixAt(i, m);
    }
    blossoms.instanceMatrix.needsUpdate = true;
  };
  return { trunks, blossoms, update };
}
