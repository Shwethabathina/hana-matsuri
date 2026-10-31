import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { canvasTexture, signTexture } from '../util.js';

// "Japaneses Town" by Pasha (Sketchfab, CC-BY-4.0), placed away from the festival on the same
// grass plain so the existing renderer, lighting, player and day/night cycle are reused.
export const TOWN_URL = 'models/town/town.glb';
export const TOWN_SCALE = 9; // model units -> metres (its people cut-outs become ~1.8 m tall)
export const TOWN_ORIGIN = new THREE.Vector3(-150, 0, 150);
const CELL = 0.5;
const LOCAL = { minX: -23, maxX: 23, minZ: -29, maxZ: 19 }; // local ground extent (metres)
const CENTER = { x: 0, z: -5 }; // middle of the town's ground disc (local)
const WALK_RADIUS = 20; // walkable disc radius (local)

// Material groups (names come from the source SketchUp export).
const GROUND = /^(tuti22|tuti3|yuka2|yuka3|ring8|material_0)$/;
const FOLIAGE = /^(ki\d+|mori7)$/;
const HIDDEN = /^(sora00|sun|material_27|enkei|hito)$/; // sky dome, painted backdrop and flat cardboard people: the festival sky and 3D villagers replace them
const NON_SOLID = /^(hito|enkei)$/; // people cut-outs and the distant backdrop

export class Town {
  constructor(world) {
    this.world = world;
    this.root = new THREE.Group();
    this.root.name = 'town';
    this.root.position.copy(TOWN_ORIGIN);
    this.occluders = [];
    this.solidMeshes = [];
    this.loaded = false;
    this.cb = {};
  }

  // Local (town) <-> world coordinates
  toWorld(x, z, y = 0) {
    return new THREE.Vector3(TOWN_ORIGIN.x + x, y, TOWN_ORIGIN.z + z);
  }

  contains(x, z) {
    const lx = x - TOWN_ORIGIN.x;
    const lz = z - TOWN_ORIGIN.z;
    return lx > LOCAL.minX && lx < LOCAL.maxX && lz > LOCAL.minZ && lz < LOCAL.maxZ;
  }

  get bounds() {
    return {
      minX: TOWN_ORIGIN.x + LOCAL.minX,
      maxX: TOWN_ORIGIN.x + LOCAL.maxX,
      minZ: TOWN_ORIGIN.z + LOCAL.minZ,
      maxZ: TOWN_ORIGIN.z + LOCAL.maxZ,
    };
  }

  async load() {
    const gltf = await new GLTFLoader().loadAsync(TOWN_URL);
    const model = gltf.scene;
    model.scale.setScalar(TOWN_SCALE);
    this.root.add(model);
    this.world.scene.add(this.root);
    this.root.updateMatrixWorld(true);

    const matCache = new Map();
    const aniso = this.world.renderer.capabilities.getMaxAnisotropy();
    this.foliage = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const name = o.material.name;
      if (HIDDEN.test(name)) {
        o.visible = false;
        return;
      }
      const kind = GROUND.test(name) ? 'ground' : FOLIAGE.test(name) ? 'foliage' : NON_SOLID.test(name) ? 'decor' : 'solid';
      // The export is unlit (KHR_materials_unlit). A physically based material keeps its textures
      // but lets the town follow the festival's sun, sky light, lanterns and day/night cycle.
      if (!matCache.has(o.material)) {
        const src = o.material;
        const alpha = src.transparent || src.alphaTest > 0;
        if (src.map) {
          src.map.anisotropy = aniso; // keeps walls and paving sharp at grazing angles
          src.map.needsUpdate = true;
        }
        const mat = new THREE.MeshStandardMaterial({
          name,
          map: src.map,
          color: src.color,
          vertexColors: src.vertexColors,
          roughness: kind === 'ground' ? 0.95 : kind === 'foliage' ? 0.8 : 0.88,
          metalness: 0,
          side: alpha ? THREE.DoubleSide : src.side,
          alphaTest: alpha ? 0.5 : 0,
          alphaToCoverage: alpha, // smooth cut-out edges with the composer's MSAA
          transparent: false,
        });
        addSurfaceDetail(mat, kind);
        matCache.set(src, mat);
      }
      o.material = matCache.get(o.material);
      o.receiveShadow = true;
      o.castShadow = kind === 'solid' || kind === 'foliage';
      o.userData.townKind = kind;
      if (kind === 'solid') this.occluders.push(o);
      if (kind === 'foliage') this.foliage.push(o);
    });

    this.buildGrids(model);
    this.world.colliders.grids.push(this.grid);
    this.buildGates();
    this.buildLights();
    this.minimap = this.buildMinimapImage();
    this.loaded = true;
    return this;
  }

  // Rasterise ground triangles into a height grid and walls/foliage into a blocked grid.
  buildGrids(model) {
    const w = Math.ceil((LOCAL.maxX - LOCAL.minX) / CELL);
    const h = Math.ceil((LOCAL.maxZ - LOCAL.minZ) / CELL);
    const heights = new Float32Array(w * h).fill(NaN);
    const blocked = new Uint8Array(w * h);
    const tris = { ground: [], wall: [] };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const inv = new THREE.Matrix4().makeTranslation(-TOWN_ORIGIN.x, -TOWN_ORIGIN.y, -TOWN_ORIGIN.z);
    model.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const kind = o.userData.townKind;
      if (kind === 'decor') return;
      const m = inv.clone().multiply(o.matrixWorld);
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      const list = kind === 'ground' ? tris.ground : tris.wall;
      for (let k = 0; k < n; k += 3) {
        const i0 = idx ? idx.getX(k) : k;
        const i1 = idx ? idx.getX(k + 1) : k + 1;
        const i2 = idx ? idx.getX(k + 2) : k + 2;
        list.push([
          a.fromBufferAttribute(pos, i0).applyMatrix4(m).clone(),
          b.fromBufferAttribute(pos, i1).applyMatrix4(m).clone(),
          c.fromBufferAttribute(pos, i2).applyMatrix4(m).clone(),
        ]);
      }
    });
    const cellOf = (x, z) => [Math.floor((x - LOCAL.minX) / CELL), Math.floor((z - LOCAL.minZ) / CELL)];

    // Ground: highest walkable surface below 2.2 m in each cell (raised stone floors are 0.5 m).
    for (const [p, q, r] of tris.ground) {
      const minX = Math.min(p.x, q.x, r.x);
      const maxX = Math.max(p.x, q.x, r.x);
      const minZ = Math.min(p.z, q.z, r.z);
      const maxZ = Math.max(p.z, q.z, r.z);
      const [i0, j0] = cellOf(minX, minZ);
      const [i1, j1] = cellOf(maxX, maxZ);
      const det = (q.z - r.z) * (p.x - r.x) + (r.x - q.x) * (p.z - r.z);
      if (Math.abs(det) < 1e-9) continue;
      for (let j = Math.max(0, j0); j <= Math.min(h - 1, j1); j++) {
        for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i++) {
          const x = LOCAL.minX + (i + 0.5) * CELL;
          const z = LOCAL.minZ + (j + 0.5) * CELL;
          const l1 = ((q.z - r.z) * (x - r.x) + (r.x - q.x) * (z - r.z)) / det;
          const l2 = ((r.z - p.z) * (x - r.x) + (p.x - r.x) * (z - r.z)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
          const y = l1 * p.y + l2 * q.y + l3 * r.y;
          if (y > 2.2) continue;
          const k = j * w + i;
          if (Number.isNaN(heights[k]) || y > heights[k]) heights[k] = y;
        }
      }
    }
    const groundAt = (i, j) => {
      const v = heights[j * w + i];
      return Number.isNaN(v) ? 0 : v;
    };
    // Walls and foliage: sample each triangle; a sample between knee and head height blocks its cell.
    const s = new THREE.Vector3();
    for (const [p, q, r] of tris.wall) {
      const span = Math.max(p.distanceTo(q), q.distanceTo(r), r.distanceTo(p));
      const steps = Math.min(60, Math.max(2, Math.ceil(span / 0.2)));
      for (let u = 0; u <= steps; u++) {
        for (let v = 0; u + v <= steps; v++) {
          const fu = u / steps;
          const fv = v / steps;
          s.set(0, 0, 0).addScaledVector(p, 1 - fu - fv).addScaledVector(q, fu).addScaledVector(r, fv);
          const [i, j] = cellOf(s.x, s.z);
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const g = groundAt(i, j);
          if (s.y > g + 0.35 && s.y < g + 1.9) blocked[j * w + i] = 1;
        }
      }
    }
    // Keep the player on the town's ground disc.
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const x = LOCAL.minX + (i + 0.5) * CELL;
        const z = LOCAL.minZ + (j + 0.5) * CELL;
        if (Math.hypot(x - CENTER.x, z - CENTER.z) > WALK_RADIUS || Number.isNaN(heights[j * w + i])) blocked[j * w + i] = 1;
      }
    }
    this.heights = heights;
    this.grid = { minX: TOWN_ORIGIN.x + LOCAL.minX, minZ: TOWN_ORIGIN.z + LOCAL.minZ, cell: CELL, w, h, blocked };
  }

  // Bilinear ground height (world coordinates).
  heightAt(x, z) {
    const g = this.grid;
    const fx = (x - g.minX) / CELL - 0.5;
    const fz = (z - g.minZ) / CELL - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const get = (ii, jj) => {
      if (ii < 0 || jj < 0 || ii >= g.w || jj >= g.h) return 0;
      const v = this.heights[jj * g.w + ii];
      return Number.isNaN(v) ? 0 : v;
    };
    const tx = fx - i;
    const tz = fz - j;
    const top = get(i, j) * (1 - tx) + get(i + 1, j) * tx;
    const bot = get(i, j + 1) * (1 - tx) + get(i + 1, j + 1) * tx;
    return top * (1 - tz) + bot * tz;
  }

  isFree(x, z) {
    const g = this.grid;
    const i = Math.floor((x - g.minX) / CELL);
    const j = Math.floor((z - g.minZ) / CELL);
    return i >= 0 && j >= 0 && i < g.w && j < g.h && !g.blocked[j * g.w + i];
  }

  // Breadth-first reachability from a world point (used to verify quest locations).
  reachable(from) {
    const g = this.grid;
    const seen = new Uint8Array(g.w * g.h);
    const start = [Math.floor((from.x - g.minX) / CELL), Math.floor((from.z - g.minZ) / CELL)];
    const q = [start];
    seen[start[1] * g.w + start[0]] = 1;
    while (q.length) {
      const [i, j] = q.shift();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        const k = nj * g.w + ni;
        if (seen[k] || g.blocked[k]) continue;
        seen[k] = 1;
        q.push([ni, nj]);
      }
    }
    return (p) => seen[Math.floor((p.z - g.minZ) / CELL) * g.w + Math.floor((p.x - g.minX) / CELL)] === 1;
  }

  buildGates() {
    const W = this.world;
    // Festival side: a small torii at the west edge of the game plaza.
    const fGate = new THREE.Vector3(13.4, 0, 4.7);
    W.buildTorii(fGate, 0.55, Math.PI / 2);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.55), new THREE.MeshStandardMaterial({ map: signTexture('古い町 →', { bg: '#2a1d14', fg: '#ffe7b0', font: 52 }) }));
    sign.position.set(13.4, 2.0, 4.2);
    sign.rotation.y = Math.PI;
    W.scene.add(sign);
    W.addInteractable({ id: 'to-town', pos: new THREE.Vector3(13.4, 0, 3.7), radius: 1.8, label: 'Travel to the Old Town (treasure hunt)', action: () => this.cb.enter?.() });

    // Town side: a torii behind the arrival point leads back to the festival.
    const tGate = this.toWorld(0.5, 16.3);
    W.buildTorii(tGate, 0.6, Math.PI / 2);
    W.addInteractable({ id: 'to-festival', pos: this.toWorld(0.5, 14.5), radius: 1.6, label: 'Return to the festival', action: () => this.cb.exit?.() });
  }

  buildLights() {
    // Lantern light sources for the night (picked up by the festival's nearest-4 light pool).
    for (const [x, z] of [[0.5, 1], [0.5, 12], [1.5, -12], [-6, -4]]) this.world.addLight(this.toWorld(x, z, 3), { base: 8, distance: 14 });
    // Hanging paper chōchin lanterns along the courtyard and the north road; they glow after dusk.
    const paper = new THREE.MeshStandardMaterial({ color: '#d8402c', roughness: 0.7, emissive: '#ff7a3a', emissiveIntensity: 0 });
    this.world.registerGlow(paper, 0, 2.2);
    const cap = new THREE.MeshStandardMaterial({ color: '#1e1410', roughness: 0.6 });
    const body = new THREE.SphereGeometry(0.2, 14, 10).scale(1, 1.35, 1);
    const capGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12);
    const postMat = new THREE.MeshStandardMaterial({ color: '#4a3424', roughness: 0.9 });
    const postGeo = new THREE.CylinderGeometry(0.045, 0.06, 3.0, 8);
    const armGeo = new THREE.BoxGeometry(0.42, 0.05, 0.05);
    const cordGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.3, 4);
    const spots = [[-2.2, -1.8], [-2.2, 2.4], [3.2, -2.2], [3.2, 2.0], [0.5, -2.9], [-0.4, 5.2], [1.4, 8.4], [0.2, 10.2], [1.4, -6.2], [1.4, -9.0], [3.6, -12.0]];
    for (const [x, z] of spots) {
      const w = this.toWorld(x, z);
      const y = this.heightAt(w.x, w.z) + 2.35;
      const g = new THREE.Group();
      const b = new THREE.Mesh(body, paper);
      const top = new THREE.Mesh(capGeo, cap);
      top.position.y = 0.28;
      const bot = top.clone();
      bot.position.y = -0.28;
      // A wooden post with a short arm and cord holds each lantern.
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(0.38, -0.85, 0); // ground is 2.35 m below the lantern; post top at +0.65
      const arm = new THREE.Mesh(armGeo, postMat);
      arm.position.set(0.19, 0.62, 0);
      const cord = new THREE.Mesh(cordGeo, cap);
      cord.position.y = 0.45;
      g.add(b, top, bot, post, arm, cord);
      g.position.set(w.x, y, w.z);
      this.world.scene.add(g);
    }
  }

  buildMinimapImage() {
    const g = this.grid;
    const c = document.createElement('canvas');
    c.width = g.w;
    c.height = g.h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(g.w, g.h);
    for (let k = 0; k < g.w * g.h; k++) {
      const outside = Number.isNaN(this.heights[k]);
      const col = outside ? [28, 42, 28] : g.blocked[k] ? [120, 100, 84] : this.heights[k] > 0.3 ? [168, 160, 150] : [196, 176, 138];
      img.data.set([...col, 255], k * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

export const townSpawn = () => new THREE.Vector3(TOWN_ORIGIN.x + 0.5, 0, TOWN_ORIGIN.z + 12.0);

// Small glinting marker texture shared by clues.
let glintTex = null;
export function glintTexture() {
  glintTex ??= canvasTexture(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,250,220,1)');
    grd.addColorStop(0.2, 'rgba(255,230,150,0.7)');
    grd.addColorStop(1, 'rgba(255,200,100,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
  return glintTex;
}

// Fine surface detail for the low-resolution source textures: world-space value noise varies albedo and
// roughness (weathering, grain), and wall bases are darkened where they meet the ground (contact shadow).
function addSurfaceDetail(mat, kind) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTownPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvTownPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vTownPos;
float tHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float tNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(tHash(i), tHash(i + vec3(1,0,0)), f.x), mix(tHash(i + vec3(0,1,0)), tHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(tHash(i + vec3(0,0,1)), tHash(i + vec3(1,0,1)), f.x), mix(tHash(i + vec3(0,1,1)), tHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float tDetail = tNoise(vTownPos * 0.6) * 0.5 + tNoise(vTownPos * 3.1) * 0.3 + tNoise(vTownPos * 11.0) * 0.2;
diffuseColor.rgb *= mix(${kind === 'ground' ? '0.8, 1.12' : kind === 'foliage' ? '0.85, 1.1' : '0.84, 1.08'}, tDetail);
${kind === 'solid' ? 'diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 1.1, vTownPos.y));' : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (tDetail - 0.5) * 0.25, 0.4, 1.0);`);
  };
  mat.customProgramCacheKey = () => `town-${kind}`;
}
