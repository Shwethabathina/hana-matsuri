import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Yōkai models for the Test of Courage and the Spirit Realm (optimised: meshopt + WebP, ~3.7 MB total).
//   guardian — rigged multi-eyed imp with Idle / Run / Enrage / Flinch / Death clips (the corrupted guardian)
//   kasa     — kasa-obake, the one-legged umbrella yōkai (patrolling spirits)
//   kodama   — forest kodama (silent watchers along the path)
//   hannya   — hannya mask (the floating scare in the Test of Courage)
//   lantern  — mossy stone tōrō (the four shrine lanterns)
// [url, height in metres, self-illumination (spirits glow faintly so they read in the dark forest)]
const FILES = {
  guardian: ['models/spirits/guardian.glb', 3.0, 0.55],
  kasa: ['models/spirits/spirit1.glb', 1.5, 0.6],
  kodama: ['models/spirits/kodama.glb', 0.55, 0.9],
  hannya: ['models/spirits/spirit2.glb', 1.1, 0.5],
  lantern: ['models/spirits/lantern.glb', 1.4, 0],
};

// Scale to a target height, stand on y = 0, centre on x/z, and drop helper geometry
// (Sketchfab backdrop planes and flat shadow discs).
function normalise(root, height, glow) {
  root.updateMatrixWorld(true);
  const drop = [];
  const full = new THREE.Box3().setFromObject(root);
  const fs = full.getSize(new THREE.Vector3());
  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = (o.material?.name || '') + (o.name || '');
    const b = new THREE.Box3().setFromObject(o);
    const s = b.getSize(new THREE.Vector3());
    if (/background/i.test(name) || (s.y < fs.y * 0.03 && Math.max(s.x, s.z) > Math.max(fs.x, fs.z) * 0.45)) drop.push(o);
  });
  for (const o of drop) o.parent.remove(o);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const k = height / (size.y || 1);
  const pivot = new THREE.Group();
  const c = box.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box.min.y, -c.z);
  pivot.add(root);
  pivot.scale.setScalar(k);
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = !o.isSkinnedMesh;
      if (glow > 0 && o.material && 'emissive' in o.material) {
        o.material.emissive.set('#ffffff');
        o.material.emissiveMap = o.material.map || null;
        if (!o.material.map) o.material.emissive.copy(o.material.color);
        o.material.emissiveIntensity = glow;
      }
    }
  });
  const wrap = new THREE.Group();
  wrap.add(pivot);
  return wrap;
}

export async function loadSpiritAssets() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const out = {};
  await Promise.all(
    Object.entries(FILES).map(async ([key, [url, h, glow]]) => {
      try {
        const g = await loader.loadAsync(url);
        out[key] = { scene: normalise(g.scene, h, glow), animations: g.animations };
      } catch (err) {
        console.warn(`Spirit model ${key} failed to load`, err);
      }
    }),
  );
  return out;
}
