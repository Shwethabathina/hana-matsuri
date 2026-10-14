import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand } from './util.js';

const SAKURA_URL = 'models/sakura.glb'; // "Sakura Tree 01 - Low Poly Model" by Jogoss, CC-BY-4.0
const TREE_HEIGHT = 6.2; // metres for scale 1

// Wind is done in the vertex shader so every tree in the instanced grove bends for free.
// Displacement grows with height (squared), so the trunk base stays planted and the canopy
// swings; blossom vertices also get a fast flutter. Each instance gets its own phase from
// its world position so the grove does not move in lockstep.
const wind = { uTime: { value: 0 }, uAmp: { value: 0.1 }, uGust: { value: 0 } };

export function addWind(material, flutter, height = TREE_HEIGHT) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uAmp;
        uniform float uGust;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
            ip = instanceMatrix[3].xyz;
          #endif
          float ph = ip.x * 0.37 + ip.z * 0.21;
          float h = clamp((transformed.y - ${(height * 0.2).toFixed(2)}) / ${(height * 0.8).toFixed(2)}, 0.0, 1.2);
          h *= h;
          float s = sin(uTime * 1.3 + ph) + 0.35 * sin(uTime * 3.1 + ph * 2.3);
          transformed.x += (s * uAmp + uGust * 0.35) * h;
          transformed.z += cos(uTime * 1.05 + ph) * uAmp * 0.6 * h;
          transformed.y -= abs(s) * uAmp * 0.12 * h;
          ${flutter ? 'transformed += vec3(sin(uTime * 7.0 + position.x * 9.0 + position.z * 5.0), cos(uTime * 6.0 + position.y * 7.0), sin(uTime * 5.0 + position.z * 8.0)) * 0.035 * h;' : ''}
        }`,
      );
  };
  material.customProgramCacheKey = () => `wind-${flutter ? 'leaf' : 'bark'}-${height}`;
}

// Bake the glTF into Y-up world-space geometry with the trunk base at the origin.
let treePromise = null;
const loadTreeOnce = () => (treePromise ??= loadTree());

async function loadTree() {
  const gltf = await new GLTFLoader().loadAsync(SAKURA_URL);
  gltf.scene.updateMatrixWorld(true);
  const parts = { bark: [], leaf: [] };
  let barkMat = null;
  let leafMat = null;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (/bark/i.test(o.material.name)) {
      parts.bark.push(g);
      barkMat = o.material;
    } else {
      parts.leaf.push(g);
      leafMat = o.material;
    }
  });
  const bark = mergeGeometries(parts.bark);
  const leaf = mergeGeometries(parts.leaf);
  bark.computeBoundingBox();
  leaf.computeBoundingBox();
  const bb = bark.boundingBox.clone();
  const all = bb.clone().union(leaf.boundingBox);
  const s = TREE_HEIGHT / (all.max.y - all.min.y);
  for (const g of [bark, leaf]) {
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    g.scale(s, s, s);
  }
  return { bark, leaf, barkMat, leafMat };
}

// spots: [x, z, baseY, scale]
export function buildSakuraGrove(world, spots, { shadows = true, scale = 1.35 } = {}) {
  for (const [x, z, , s = 1] of spots) world.colliders.addCircle(x, z, 0.35 * s, 'sakura');
  const state = { meshes: [] };

  loadTreeOnce()
    .then(({ bark, leaf, barkMat, leafMat }) => {
      const bm = barkMat.clone();
      bm.roughness = 0.95;
      addWind(bm, false);
      const lm = leafMat.clone();
      // The blossom cards were exported as BLEND; alpha-test avoids sorting artefacts.
      lm.transparent = false;
      lm.alphaTest = 0.28;
      lm.side = THREE.DoubleSide;
      lm.emissive = new THREE.Color('#ff86b0');
      lm.emissiveMap = lm.map;
      lm.emissiveIntensity = 0.05;
      world.registerGlow(lm, 0.02, 0.35);
      addWind(lm, true);

      const trunks = new THREE.InstancedMesh(bark, bm, spots.length);
      const crowns = new THREE.InstancedMesh(leaf, lm, spots.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      spots.forEach(([x, z, y = 0, sc = 1], i) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand(0, Math.PI * 2));
        const k = sc * scale * rand(0.9, 1.12);
        m.compose(new THREE.Vector3(x, y - 0.05, z), q, new THREE.Vector3(k, k * rand(0.92, 1.08), k));
        trunks.setMatrixAt(i, m);
        crowns.setMatrixAt(i, m);
      });
      for (const im of [trunks, crowns]) {
        im.castShadow = shadows;
        im.receiveShadow = true;
        im.frustumCulled = false;
        world.scene.add(im);
      }
      state.meshes = [trunks, crowns];
    })
    .catch((err) => console.warn('Sakura model failed to load', err));

  return {
    state,
    update(t, w) {
      wind.uTime.value = t;
      wind.uAmp.value = 0.06 + w * 0.18;
      wind.uGust.value = w;
    },
  };
}
