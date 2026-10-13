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
      m.compose(new THREE.Vector3(x + Math.cos(a) * r * s, y + h * s, z + Math.sin(a) * r * s), q, new THREE.Vector3(bs, bs, bs));
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
  return { trunks, blossoms };
}
