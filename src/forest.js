import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addWind } from './sakura.js';
import { rand } from './util.js';

const FOREST_URL = 'models/forest.glb'; // "a forest (3) with a road at night for game" by dasy444, CC-BY-4.0
const METRES_PER_UNIT = 4.2; // the source diorama's trees are ~2.4 units tall -> ~10 m
const MAX_TYPES = 6;

// Copy an (often quantized) geometry into plain float position/normal/uv so it can be
// transformed and merged.
function toFloat(src, matrix) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.attributes[name];
    if (!a) continue;
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      arr[i * a.itemSize] = a.getX(i);
      if (a.itemSize > 1) arr[i * a.itemSize + 1] = a.getY(i);
      if (a.itemSize > 2) arr[i * a.itemSize + 2] = a.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (src.index) g.setIndex(Array.from(src.index.array));
  return g.applyMatrix4(matrix);
}

// The source scene builds each tree from a bark cylinder plus many photo-card branch clumps.
// Group the cards around their trunk to rebuild whole trees, then keep a few distinct types.
async function loadTreeTypes() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(FOREST_URL);
  gltf.scene.updateMatrixWorld(true);
  const trunks = [];
  const cards = [];
  let barkMat = null;
  let cardMat = null;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const box = new THREE.Box3().setFromObject(o);
    const entry = { o, box, c: box.getCenter(new THREE.Vector3()) };
    if (o.material.name === 'Material.004') {
      trunks.push(entry);
      barkMat = o.material;
    } else if (o.material.name === 'Material') {
      cards.push(entry);
      cardMat = o.material;
    }
  });
  const trees = trunks.map((t) => ({ t, cards: [] }));
  for (const c of cards) {
    let best = null;
    let bd = 0.9;
    for (const tr of trees) {
      const d = Math.hypot(c.c.x - tr.t.c.x, c.c.z - tr.t.c.z);
      if (d < bd && c.box.min.y > tr.t.box.min.y - 0.1) {
        bd = d;
        best = tr;
      }
    }
    best?.cards.push(c);
  }
  const good = trees
    .filter((tr) => tr.cards.length >= 6)
    .sort((a, b) => b.cards.length - a.cards.length)
    .slice(0, MAX_TYPES);
  const s = METRES_PER_UNIT;
  return {
    barkMat,
    cardMat,
    types: good.map((tr) => {
      const base = new THREE.Vector3(tr.t.c.x, tr.t.box.min.y, tr.t.c.z);
      const fix = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-base.x, -base.y, -base.z));
      const bark = toFloat(tr.t.o.geometry, fix.clone().multiply(tr.t.o.matrixWorld));
      let parts = tr.cards.map((c) => toFloat(c.o.geometry, fix.clone().multiply(c.o.matrixWorld)));
      if (parts.some((g) => !g.index)) parts = parts.map((g) => (g.index ? g.toNonIndexed() : g));
      const leaf = mergeGeometries(parts);
      leaf.computeBoundingBox();
      return { bark, leaf, height: leaf.boundingBox.max.y };
    }),
  };
}

// spots: [x, z, scale, castsShadow]
export async function buildForest(world, spots) {
  const { types, barkMat, cardMat } = await loadTreeTypes();
  if (!types.length) throw new Error('no tree types found');
  const groups = types.map(() => ({ near: [], far: [] }));
  spots.forEach((sp, i) => groups[i % types.length][sp[3] ? 'near' : 'far'].push(sp));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const meshes = [];
  types.forEach((type, ti) => {
    const bm = barkMat.clone();
    bm.roughness = 0.95;
    addWind(bm, false, type.height);
    const lm = cardMat.clone();
    // Photo cards were exported as BLEND; alpha-test keeps depth sorting stable.
    lm.transparent = false;
    lm.alphaTest = 0.5;
    lm.side = THREE.DoubleSide;
    lm.roughness = 0.9;
    addWind(lm, true, type.height);
    for (const [key, list] of Object.entries(groups[ti])) {
      if (!list.length) continue;
      const trunkIM = new THREE.InstancedMesh(type.bark, bm, list.length);
      const leafIM = new THREE.InstancedMesh(type.leaf, lm, list.length);
      list.forEach(([x, z, sc], i) => {
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand(0, Math.PI * 2));
        const k = sc * rand(0.85, 1.15);
        m.compose(new THREE.Vector3(x, -0.08, z), q, new THREE.Vector3(k, k * rand(0.9, 1.15), k));
        trunkIM.setMatrixAt(i, m);
        leafIM.setMatrixAt(i, m);
        leafIM.setColorAt(i, new THREE.Color().setHSL(0.3, 0.15, rand(0.78, 1)));
      });
      for (const im of [trunkIM, leafIM]) {
        im.castShadow = key === 'near';
        im.receiveShadow = true;
        im.frustumCulled = false;
        world.scene.add(im);
        meshes.push(im);
      }
    }
  });
  return { types: types.length, meshes };
}
