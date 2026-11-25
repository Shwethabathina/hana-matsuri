import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildSakuraGrove } from './sakura.js';
import { canvasTexture, glowTexture } from './util.js';

// Grand finale: a broad river below the fireworks viewing area, a riverfront deck, floating lanterns
// (tōrō nagashi), sky lanterns and fireworks — all mirrored in the moving water.
//
// Assets (CC-BY-4.0, credited in the page footer):
//   water.glb ("Free Ocean simulation-Tiled", the9thearl)  -> its surface textures became the river's two
//       ripple normal maps (river_normal / river_detail). Its 80k-triangle ocean mesh and wave morphs are not used.
//   Lantern 1/2/3 ("Red/Blue/Yellow Lantern (Sky Lantern)", Just Vy) -> instanced floating + sky lanterns.
//   fireworks -3.glb ("Fireworks Demo", Laurie Annis)         -> fw_sim: its 10 s particle animation baked to points.
//   Fireworks - 2.glb ("Playful Pyrotechnics", Tycho Magnetic Anomaly) -> fw_playful: its burst animation baked.
//   fireworks.glb ("fireworks", PENguins)                    -> fw_shape: its 2,499-particle burst shape.
//
// Reflections: a planar Reflector whose mirror camera renders only the REFLECT layer (sky, fireworks,
// lanterns, bank trees, bridge, pagoda) at half resolution, distorted by the flowing normal maps and
// stretched vertically so every light leaves a long shimmering trail on the water.

export const REFLECT = 3;
export const RIVER = { x0: -120, x1: 200, zN: 21, zF: 53, y: -0.05 };
export const DECK = { x: 31, z0: 15.2, z1: 20.7, hw: 4.6 };
const BASE = 'models/finale/';
const FLOW_SPEED = 0.55; // m/s, current toward -x

const PALETTE = ['#ffcc55', '#ff6fb0', '#b07aff', '#5aa8ff', '#ff8a3a', '#ffe9a8'].map((c) => new THREE.Color(c));

const riverVert = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const riverFrag = /* glsl */ `
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform sampler2D tNormal;
  uniform sampler2D tDetail;
  uniform float uTime;
  uniform float uReflect;
  uniform float uFlow;
  uniform vec3 uDeep;
  uniform vec3 uSky;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    vec2 p = vWorld.xz;
    // Two broad ripple layers drifting with the current plus fine detail: gentle, continuous flow.
    vec3 n1 = texture2D(tNormal, p * vec2(0.030, 0.045) + vec2(uTime * uFlow * 0.030, 0.0)).xyz * 2.0 - 1.0;
    vec3 n2 = texture2D(tNormal, p * vec2(0.052, 0.070) + vec2(uTime * uFlow * 0.045, uTime * 0.006)).xyz * 2.0 - 1.0;
    vec3 n3 = texture2D(tDetail, p * 0.21 + vec2(uTime * uFlow * 0.09, -uTime * 0.01)).xyz * 2.0 - 1.0;
    vec2 slope = (n1.xy + n2.xy) * 0.5 + n3.xy * 0.35;
    vec3 N = normalize(vec3(slope.x * 0.35, 1.0, slope.y * 0.35));
    vec3 V = normalize(cameraPosition - vWorld);
    float dist = length(cameraPosition - vWorld);
    // Distort the mirror image: little sideways, a lot vertically -> long light trails under every lantern.
    float near = 1.0 / (1.0 + dist * 0.035);
    vec2 d = vec2(slope.x * 0.010, slope.y * 0.055) * (0.35 + near);
    vec4 uv = vUv;
    uv.xy += d * uv.w;
    vec3 refl = texture2DProj(tDiffuse, uv).rgb;
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    float k = clamp(0.55 + fres * 0.7, 0.0, 1.0) * uReflect;
    vec3 base = mix(uDeep, uSky, clamp(0.35 + slope.y * 0.4, 0.0, 1.0));
    vec3 col = mix(base, refl, k);
    // Soft sheen of the night sky on ripple crests.
    col += uSky * pow(max(0.0, slope.x * 0.5 + slope.y * 0.5), 3.0) * 0.12;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

// Point sprites with perspective size (shares the fireworks' uScale so sizes match on screen).
function glowMaterial(uScale, { additive = true } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale, uMap: { value: glowTexture() } },
    vertexShader: /* glsl */ `
      attribute float size; attribute vec3 tint; attribute float alpha;
      uniform float uScale; varying vec3 vTint; varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uScale / max(0.1, -mv.z);
        gl_Position = projectionMatrix * mv;
        vTint = tint; vAlpha = alpha;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; varying vec3 vTint; varying float vAlpha;
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vTint * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

class PointCloud {
  constructor(max, uScale) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.tint = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, glowMaterial(uScale));
    this.points.frustumCulled = false;
    this.points.layers.enable(REFLECT);
    this.n = 0;
  }
  begin() {
    this.n = 0;
  }
  add(x, y, z, size, c, a, k = 1) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.size[i] = size;
    this.tint[i * 3] = c.r * k;
    this.tint[i * 3 + 1] = c.g * k;
    this.tint[i * 3 + 2] = c.b * k;
    this.alpha[i] = a;
  }
  end() {
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'size', 'tint', 'alpha']) g.attributes[k].needsUpdate = true;
  }
}

// A lantern model split into instanced parts (paper, frame, flame) normalised to 1 m tall.
function instancedLantern(scene, count, glow) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const norm = new THREE.Matrix4().makeScale(1 / size.y, 1 / size.y, 1 / size.y).multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
  const parts = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld).applyMatrix4(norm);
    const m = o.material.clone();
    const name = (m.name || '').toLowerCase();
    m.transparent = false;
    m.opacity = 1;
    m.depthWrite = true;
    if (name.includes('fire')) {
      m.emissive = new THREE.Color('#ffb347');
      m.emissiveIntensity = 3;
    } else if (name.includes('lantern')) {
      m.emissive = m.color.clone();
      m.emissiveIntensity = glow;
      m.side = THREE.DoubleSide;
    }
    const im = new THREE.InstancedMesh(g, m, count);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.count = 0;
    im.layers.enable(REFLECT);
    parts.push(im);
  });
  return parts;
}

// Baked firework (from the glTF models): frames of quantised particle positions + per-particle scale.
class BakedBurst {
  constructor(data, uScale, { pos, radius, color, color2, rate = 1 }) {
    this.d = data;
    this.cloud = new PointCloud(data.count, uScale);
    this.pos = pos;
    this.radius = radius;
    this.color = color;
    this.color2 = color2 || color;
    this.rate = rate;
    this.t = 0;
    this.dur = data.duration > 0 ? data.duration / rate : 3.2;
    this.done = false;
  }
  update(dt) {
    this.t += dt;
    const d = this.d;
    const c = this.cloud;
    c.begin();
    if (this.t >= this.dur) {
      this.done = true;
      c.end();
      return;
    }
    const R = this.radius;
    const P = d.P;
    const S = d.S;
    if (d.frames > 1) {
      const ft = (this.t * this.rate / d.duration) * (d.frames - 1);
      const f0 = Math.min(d.frames - 1, Math.floor(ft));
      const f1 = Math.min(d.frames - 1, f0 + 1);
      const k = ft - f0;
      for (let i = 0; i < d.count; i++) {
        const o0 = f0 * d.count + i;
        const o1 = f1 * d.count + i;
        const s = S[o0] * (1 - k) + S[o1] * k;
        if (s < 1) continue;
        const q = 2 / 32767;
        const x = (P[o0 * 3] * (1 - k) + P[o1 * 3] * k) * q;
        const y = (P[o0 * 3 + 1] * (1 - k) + P[o1 * 3 + 1] * k) * q;
        const z = (P[o0 * 3 + 2] * (1 - k) + P[o1 * 3 + 2] * k) * q;
        const life = ft / (d.frames - 1);
        const col = (i & 3) === 0 ? this.color2 : this.color;
        c.add(this.pos.x + x * R, this.pos.y + y * R, this.pos.z + z * R, 0.35 + (s / 255) * 0.9, col, Math.min(1, s / 60) * (1 - life * 0.4), 3.2);
      }
    } else {
      // Static burst shape: expand from the centre, droop and fade.
      const u = this.t / this.dur;
      const r = 1 - Math.exp(-4.5 * u);
      const droop = 0.18 * u * u;
      const fade = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25;
      const q = 2 / 32767;
      for (let i = 0; i < d.count; i += 2) {
        const col = (i & 7) === 0 ? this.color2 : this.color;
        const tw = 0.75 + 0.25 * Math.sin(this.t * 30 + i);
        c.add(this.pos.x + P[i * 3] * q * R * r, this.pos.y + (P[i * 3 + 1] * q * r - droop) * R, this.pos.z + P[i * 3 + 2] * q * R * r, 0.55, col, fade * tw, 3);
      }
    }
    c.end();
  }
}

export class RiverFinale {
  constructor({ world, fireworks, spirits }) {
    this.world = world;
    this.fireworks = fireworks;
    this.spirits = spirits;
    this.uScale = fireworks.stars.material.uniforms.uScale;
    this.t = 0;
    this.active = false;
    this.floating = [];
    this.sky = [];
    this.bursts = [];
    this.group = new THREE.Group();
    world.scene.add(this.group);
    this.buildRiver();
    this.buildBanks();
    this.buildDeck();
    this.buildFarBank();
    this.buildBridge();
    this.glows = new PointCloud(900, this.uScale);
    this.group.add(this.glows.points);
    this.ripples = [];
    // The celebration's lights and the fireworks render into the reflection; light the reflected scene too.
    for (const o of [fireworks.stars.points, fireworks.smoke.points, world.sky, world.moon, world.hemi, world.sun, ...(world.lightPool || [])]) o?.layers.enable(REFLECT);
    if (world.stars) world.stars.layers.enable(REFLECT);
    this.ready = this.load();
  }

  async load() {
    const loader = new GLTFLoader();
    const [red, blue, yellow] = await Promise.all(['lantern_red', 'lantern_blue', 'lantern_yellow'].map((n) => loader.loadAsync(BASE + n + '.glb')));
    // Floating lanterns: the yellow (warm paper) design sits best on water; sky lanterns use all three.
    this.floatParts = instancedLantern(yellow.scene, 160, 0.45);
    this.skyParts = [red, yellow, blue].map((g) => instancedLantern(g.scene, 110, 0.7));
    for (const p of [this.floatParts, ...this.skyParts].flat()) this.group.add(p);
    const meta = await (await fetch(BASE + 'fireworks.json')).json();
    this.fw = {};
    await Promise.all(meta.map(async (m) => {
      const buf = await (await fetch(BASE + m.name + '.bin')).arrayBuffer();
      const n = m.frames * m.count;
      this.fw[m.name] = { ...m, P: new Int16Array(buf, 0, n * 3), S: new Uint8Array(buf, n * 6, n) };
    }));
  }

  // ---------------------------------------------------------------- environment
  buildRiver() {
    const W = RIVER.x1 - RIVER.x0;
    const H = RIVER.zF - RIVER.zN;
    const loader = new THREE.TextureLoader();
    const tex = (f) => {
      const t = loader.load(BASE + f);
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      t.anisotropy = 4;
      return t;
    };
    const shader = {
      name: 'RiverShader',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
        tNormal: { value: null }, tDetail: { value: null }, uTime: { value: 0 }, uReflect: { value: 0.92 }, uFlow: { value: -1 },
        uDeep: { value: new THREE.Color('#081629') }, uSky: { value: new THREE.Color('#1d3260') },
      }]),
      vertexShader: riverVert,
      fragmentShader: riverFrag,
    };
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const river = new Reflector(new THREE.PlaneGeometry(W, H), {
      shader,
      textureWidth: Math.min(1280, Math.round(innerWidth * dpr * 0.5)),
      textureHeight: Math.min(720, Math.round(innerHeight * dpr * 0.5)),
      clipBias: 0.002,
      multisample: 0,
    });
    river.material.uniforms.tNormal.value = tex('river_normal.jpg');
    river.material.uniforms.tDetail.value = tex('river_detail.jpg');
    river.material.fog = true;
    river.rotation.x = -Math.PI / 2;
    river.position.set((RIVER.x0 + RIVER.x1) / 2, RIVER.y, (RIVER.zN + RIVER.zF) / 2);
    // The mirror camera sees only the celebration layer: cheap, and exactly what should shimmer on the river.
    const getCam = river.getReflectionCamera.bind(river);
    river.getReflectionCamera = (cam) => {
      const c = getCam(cam);
      c.layers.set(REFLECT);
      return c;
    };
    river.receiveShadow = false;
    this.river = river;
    this.group.add(river);
  }

  // Stone embankments along both banks, a darker earth slope, reeds and rocks at the water's edge.
  buildBanks() {
    const rockGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: '#5d5a55', roughness: 0.95, flatShading: true });
    const list = [];
    for (const z of [RIVER.zN, RIVER.zF]) {
      for (let x = RIVER.x0; x < RIVER.x1; x += 0.9 + Math.random() * 0.6) {
        if (z === RIVER.zN && Math.abs(x - DECK.x) < DECK.hw + 0.2) continue;
        list.push([x, z + (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.7]);
      }
    }
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    list.forEach(([x, z, s], i) => {
      q.setFromEuler(new THREE.Euler(Math.random(), Math.random() * 6, Math.random()));
      m.compose(new THREE.Vector3(x, -0.05, z), q, new THREE.Vector3(s * 1.3, s * 0.55, s));
      rocks.setMatrixAt(i, m);
    });
    rocks.layers.enable(REFLECT);
    this.group.add(rocks);
    // Earth slope strips
    const earth = new THREE.MeshStandardMaterial({ color: '#2f2a22', roughness: 1 });
    for (const [z, dir] of [[RIVER.zN - 0.7, 1], [RIVER.zF + 0.7, -1]]) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(RIVER.x1 - RIVER.x0, 1.8), earth);
      s.rotation.x = -Math.PI / 2 + 0.12 * dir;
      s.position.set((RIVER.x0 + RIVER.x1) / 2, -0.09, z);
      this.group.add(s);
    }
    // Far bank grass, a little raised so the water reads as sitting in a basin.
    const farGrass = new THREE.Mesh(new THREE.PlaneGeometry(RIVER.x1 - RIVER.x0, 60), new THREE.MeshStandardMaterial({ color: '#23331f', roughness: 1 }));
    farGrass.rotation.x = -Math.PI / 2;
    farGrass.position.set((RIVER.x0 + RIVER.x1) / 2, -0.02, RIVER.zF + 31);
    farGrass.layers.enable(REFLECT);
    this.group.add(farGrass);
    // Stone tōrō along the near bank (the stone lantern model used in the forest), lit warm.
    const L = this.spirits?.lantern;
    for (const x of [DECK.x - 14, DECK.x + 14, DECK.x - 28, DECK.x + 28]) {
      if (L) {
        const lan = L.scene.clone();
        lan.position.set(x, 0, RIVER.zN - 1.6);
        lan.layers.enable(REFLECT);
        lan.traverse((o) => o.layers.enable(REFLECT));
        this.group.add(lan);
      }
      this.world.addLight(new THREE.Vector3(x, 1.2, RIVER.zN - 1.6), { color: 0xffa860, base: 4, distance: 8, flicker: 0.2 });
    }
    // Sakura along both banks — framing the view, never in front of the river or the sky.
    const near = [];
    for (let x = RIVER.x0 + 20; x < RIVER.x1 - 20; x += 9) if (Math.abs(x - DECK.x) > 15) near.push([x + Math.random() * 3, RIVER.zN - 3.2 - Math.random() * 1.5, 0, 0.9 + Math.random() * 0.3]);
    const far = [];
    for (let x = RIVER.x0 + 10; x < RIVER.x1 - 10; x += 7.5) far.push([x + Math.random() * 3, RIVER.zF + 4 + Math.random() * 3, 0, 1 + Math.random() * 0.35]);
    this.bankTrees = [buildSakuraGrove(this.world, near, { shadows: false }), buildSakuraGrove(this.world, far, { shadows: false })];
  }

  // A wooden riverfront deck with a railing and a gap at the release steps; paper lanterns on the posts.
  buildDeck() {
    const wood = new THREE.MeshStandardMaterial({ color: '#6b4a2e', roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: '#3d2a1a', roughness: 0.9 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(DECK.hw * 2, 0.08, DECK.z1 - DECK.z0), wood);
    deck.position.set(DECK.x, 0.01, (DECK.z0 + DECK.z1) / 2);
    deck.receiveShadow = true;
    this.group.add(deck);
    const posts = [];
    const paper = new THREE.MeshStandardMaterial({ color: '#ffd9a0', emissive: '#ff9a40', emissiveIntensity: 1.4 });
    this.world.registerGlow?.(paper, 0.15, 1.4);
    for (let x = -DECK.hw; x <= DECK.hw + 0.01; x += DECK.hw / 3) {
      if (Math.abs(x) < 1.2) continue; // the release steps
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), dark);
      p.position.set(DECK.x + x, 0.5, DECK.z1 - 0.1);
      posts.push(p);
      const lan = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), paper);
      lan.scale.y = 1.3;
      lan.position.set(DECK.x + x, 1.15, DECK.z1 - 0.1);
      lan.layers.enable(REFLECT);
      posts.push(lan);
    }
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(DECK.hw - 1.2, 0.08, 0.08), dark);
      rail.position.set(DECK.x + side * (DECK.hw / 2 + 0.6), 0.95, DECK.z1 - 0.1);
      posts.push(rail);
      this.world.colliders.addRect(DECK.x + side * (DECK.hw / 2 + 0.6), DECK.z1 + 0.1, (DECK.hw - 1.2) / 2, 0.25, 'deck-rail');
    }
    this.group.add(...posts);
    // Release steps down to the water
    for (let i = 0; i < 3; i++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.35), wood);
      st.position.set(DECK.x, -0.02 - i * 0.03, DECK.z1 + 0.15 + i * 0.3);
      this.group.add(st);
    }
    this.world.addLight(new THREE.Vector3(DECK.x, 1.4, DECK.z1 - 0.3), { color: 0xffb070, base: 5, distance: 9, flicker: 0.15 });
    // Sign
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.55), new THREE.MeshStandardMaterial({ map: signBoard(), roughness: 0.8 }));
    sign.position.set(DECK.x - DECK.hw + 0.3, 1.4, DECK.z0 + 0.4);
    sign.rotation.y = Math.PI;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), dark);
    sp.position.set(sign.position.x, 0.7, sign.position.z + 0.04);
    this.group.add(sign, sp);
    this.world.colliders.addCircle(sp.position.x, sp.position.z, 0.12);
    this.releasePoint = new THREE.Vector3(DECK.x, 0, RIVER.zN + 0.9);
  }

  // Far bank: riverside houses with warm windows and a five-storey pagoda — they glow in the reflection.
  buildFarBank() {
    const winTex = canvasTexture(128, 64, (g, w, h) => {
      g.fillStyle = '#2a1c12';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = Math.random() < 0.8 ? '#ffc070' : '#5a3a20';
        g.fillRect(8 + i * 30, 20, 20, 26);
        g.fillStyle = '#2a1c12';
        g.fillRect(17 + i * 30, 20, 2, 26);
      }
    });
    const wall = new THREE.MeshStandardMaterial({ color: '#3b2a1e', roughness: 0.9, emissive: '#ffffff', emissiveMap: winTex, emissiveIntensity: 0.9, map: winTex });
    const roof = new THREE.MeshStandardMaterial({ color: '#232326', roughness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: '#7a1c16', roughness: 0.6, emissive: '#2a0705' });
    this.world.registerGlow?.(wall, 0.05, 1.0);
    const houses = [];
    const roofs = [];
    for (let x = RIVER.x0 + 30; x < RIVER.x1 - 30; x += 11 + Math.random() * 5) {
      if (Math.abs(x - 62) < 12) continue; // the pagoda
      const w = 6 + Math.random() * 3;
      const h = 3 + Math.random() * 1.5;
      const z = RIVER.zF + 12 + Math.random() * 6;
      houses.push(new THREE.BoxGeometry(w, h, 5).translate(x, h / 2, z));
      roofs.push(new THREE.ConeGeometry(w * 0.78, 1.8, 4).rotateY(Math.PI / 4).scale(1, 1, 5 / w).translate(x, h + 0.9, z));
    }
    const hm = new THREE.Mesh(mergeGeometries(houses), wall);
    const rm = new THREE.Mesh(mergeGeometries(roofs), roof);
    // Pagoda
    const tiers = [];
    const eaves = [];
    for (let i = 0; i < 5; i++) {
      const s = 5.2 - i * 0.7;
      const y = i * 3.3;
      tiers.push(new THREE.BoxGeometry(s * 0.7, 2.4, s * 0.7).translate(62, y + 1.2, RIVER.zF + 22));
      eaves.push(new THREE.ConeGeometry(s * 0.95, 1.1, 4).rotateY(Math.PI / 4).translate(62, y + 2.9, RIVER.zF + 22));
    }
    eaves.push(new THREE.CylinderGeometry(0.08, 0.08, 4, 6).translate(62, 5 * 3.3 + 2, RIVER.zF + 22));
    const pt = new THREE.Mesh(mergeGeometries(tiers), red);
    const pe = new THREE.Mesh(mergeGeometries(eaves), roof);
    for (const o of [hm, rm, pt, pe]) {
      o.layers.enable(REFLECT);
      this.group.add(o);
    }
  }

  // A red arched (taiko) bridge across the river in the distance, with lanterns along its rail.
  buildBridge() {
    const red = new THREE.MeshStandardMaterial({ color: '#a3261c', roughness: 0.6, emissive: '#300806' });
    const wood = new THREE.MeshStandardMaterial({ color: '#5a3b24', roughness: 0.85 });
    const X = -34;
    const z0 = RIVER.zN - 2;
    const z1 = RIVER.zF + 2;
    const N = 28;
    const deck = [];
    const rails = [];
    const archY = (u) => 0.4 + Math.sin(u * Math.PI) * 4.2;
    for (let i = 0; i < N; i++) {
      const u0 = i / N;
      const u1 = (i + 1) / N;
      const za = z0 + (z1 - z0) * u0;
      const zb = z0 + (z1 - z0) * u1;
      const ya = archY(u0);
      const yb = archY(u1);
      const len = Math.hypot(zb - za, yb - ya);
      const ang = Math.atan2(yb - ya, zb - za);
      deck.push(new THREE.BoxGeometry(3.4, 0.25, len + 0.05).rotateX(-ang).translate(X, (ya + yb) / 2, (za + zb) / 2));
      for (const s of [-1, 1]) {
        rails.push(new THREE.BoxGeometry(0.12, 0.12, len + 0.05).rotateX(-ang).translate(X + s * 1.6, (ya + yb) / 2 + 0.95, (za + zb) / 2));
        if (i % 3 === 0) rails.push(new THREE.BoxGeometry(0.14, 1.0, 0.14).translate(X + s * 1.6, ya + 0.5, za));
      }
    }
    // Piers
    for (const u of [0.25, 0.5, 0.75]) deck.push(new THREE.CylinderGeometry(0.35, 0.45, archY(u), 8).translate(X, archY(u) / 2 - 0.2, z0 + (z1 - z0) * u));
    const dm = new THREE.Mesh(mergeGeometries(deck), wood);
    const rm = new THREE.Mesh(mergeGeometries(rails), red);
    for (const o of [dm, rm]) {
      o.layers.enable(REFLECT);
      this.group.add(o);
    }
    this.bridgeLamps = [];
    for (let i = 1; i < 8; i++) {
      const u = i / 8;
      for (const s of [-1, 1]) this.bridgeLamps.push(new THREE.Vector3(X + s * 1.6, archY(u) + 1.25, z0 + (z1 - z0) * u));
    }
  }

  // ---------------------------------------------------------------- the celebration
  start() {
    this.clear();
    this.active = true;
    this.t = 0;
    this.spawnFloatT = 0;
    this.spawnSkyT = 0;
    this.burstT = 4;
    this.player = null;
  }

  clear() {
    this.floating.length = 0;
    this.sky.length = 0;
    for (const b of this.bursts) this.group.remove(b.cloud.points), b.cloud.points.geometry.dispose(), b.cloud.points.material.dispose();
    this.bursts.length = 0;
    this.ripples.length = 0;
    for (const p of [this.floatParts || [], ...(this.skyParts || [])].flat()) p.count = 0;
    this.active = false;
  }

  // The player's own lantern: appears in the hands, settles onto the water, then drifts with the current.
  releasePlayerLantern() {
    const p = this.releasePoint;
    this.player = { x: p.x, z: p.z - 0.9, y: 0.9, phase: 0, settle: 0, rot: 0, own: true, seed: Math.random() * 10, color: PALETTE[0] };
  }

  spawnFloating(x, z) {
    const zLane = z ?? RIVER.zN + 1.5 + Math.random() * (RIVER.zF - RIVER.zN - 3);
    this.floating.push({ x: x ?? DECK.x + 90 + Math.random() * 40, z: zLane, y: RIVER.y, seed: Math.random() * 10, rot: Math.random() * 6, speed: FLOW_SPEED * (0.75 + Math.random() * 0.5), scale: 0.3 + Math.random() * 0.08, color: PALETTE[Math.random() < 0.7 ? 0 : 4] });
  }

  spawnSky() {
    const r = Math.random();
    // foreground (near bank), middle (over the river, released from boats), far (beyond the far bank)
    const z = r < 0.2 ? RIVER.zN - 6 + Math.random() * 4 : r < 0.6 ? RIVER.zN + Math.random() * (RIVER.zF - RIVER.zN) : RIVER.zF + 5 + Math.random() * 70;
    const x = DECK.x - 70 + Math.random() * 150;
    this.sky.push({ x, z, y: 0.5, vy: 0.55 + Math.random() * 0.7, dx: (Math.random() - 0.5) * 0.25, dz: 0.15 + Math.random() * 0.25, seed: Math.random() * 10, rot: Math.random() * 6, model: Math.random() < 0.5 ? 1 : Math.random() < 0.5 ? 0 : 2, scale: 0.55 + Math.random() * 0.25 });
  }

  launchBurst() {
    if (!this.fw) return;
    const names = ['fw_sim', 'fw_sim', 'fw_playful', 'fw_shape'];
    const name = names[Math.floor(Math.random() * names.length)];
    const d = this.fw[name];
    const color = PALETTE[Math.floor(Math.random() * 5)];
    const color2 = PALETTE[Math.floor(Math.random() * 5)];
    const pos = new THREE.Vector3(DECK.x - 40 + Math.random() * 80, 0, RIVER.zF + 12 + Math.random() * 35);
    const radius = name === 'fw_sim' ? 9 + Math.random() * 5 : name === 'fw_playful' ? 10 + Math.random() * 4 : 8 + Math.random() * 4;
    // fw_sim includes its own rocket climb: start it near the ground; the others burst high in the sky.
    pos.y = name === 'fw_sim' ? 20 + Math.random() * 10 : 26 + Math.random() * 14;
    const b = new BakedBurst(d, this.uScale, { pos, radius, color, color2, rate: name === 'fw_sim' ? 1.4 : 1 });
    this.bursts.push(b);
    this.group.add(b.cloud.points);
  }

  ripple(x, z, size = 1) {
    this.ripples.push({ x, z, t: 0, size });
  }

  update(dt, t, playerPos) {
    this.river.material.uniforms.uTime.value = t;
    // The reflection only has to be rendered when the river can matter: festival area, south side.
    const show = playerPos.z > -14 && playerPos.x > -15;
    this.group.visible = show;
    if (!show) return;
    for (const tr of this.bankTrees) for (const m of tr.state.meshes) if (!m.layers.isEnabled(REFLECT)) m.layers.enable(REFLECT);
    this.glows.begin();
    // Bridge lamps and deck lanterns glow (and reflect) all the time at night.
    const night = Math.max(0, (this.world.tod - 0.55) / 0.45);
    for (const p of this.bridgeLamps) this.glows.add(p.x, p.y, p.z, 1.1, PALETTE[0], night * 0.8, 1.6);
    if (this.active) this.updateShow(dt, t);
    this.glows.end();
  }

  updateShow(dt, t) {
    this.t += dt;
    const T = this.t;
    const ready = !!this.floatParts;
    // The player's lantern
    const pl = this.player;
    if (pl) {
      if (pl.settle < 1) {
        pl.settle = Math.min(1, pl.settle + dt / 2.4);
        const e = pl.settle * pl.settle * (3 - 2 * pl.settle);
        pl.y = 0.9 + (RIVER.y - 0.9) * e;
        pl.z = this.releasePoint.z - 0.9 + 1.4 * e;
        if (pl.settle >= 1) {
          this.ripple(pl.x, pl.z, 1.4);
          this.ripple(pl.x, pl.z, 0.8);
        }
      } else {
        pl.x -= FLOW_SPEED * 0.8 * dt;
        pl.z += 0.12 * dt * (pl.z < RIVER.zN + 6 ? 1 : 0);
      }
    }
    // Floating lanterns: gradually more, carried by the current, bobbing; kept inside the banks.
    this.spawnFloatT -= dt;
    if (T > 6 && T < 84 && this.spawnFloatT <= 0 && this.floating.length < 150) {
      this.spawnFloatT = Math.max(0.12, 0.9 - T * 0.02);
      this.spawnFloating();
      if (Math.random() < 0.2) this.spawnFloating(DECK.x - 6 - Math.random() * 10, RIVER.zN + 3 + Math.random() * 4); // villagers releasing downstream of you
    }
    for (const l of this.floating) {
      l.x -= l.speed * dt;
      l.z += Math.sin(t * 0.3 + l.seed) * 0.05 * dt;
      l.z = Math.min(RIVER.zF - 1.2, Math.max(RIVER.zN + 1.0, l.z));
    }
    this.floating = this.floating.filter((l) => l.x > RIVER.x0 + 5);
    // Sky lanterns: rise with gentle drift and sway; more over time.
    this.spawnSkyT -= dt;
    if (T > 10 && T < 84 && this.spawnSkyT <= 0 && this.sky.length < 320) {
      this.spawnSkyT = Math.max(0.05, 0.6 - T * 0.012);
      this.spawnSky();
    }
    for (const s of this.sky) {
      s.y += s.vy * dt;
      s.x += (s.dx + Math.sin(t * 0.4 + s.seed) * 0.12) * dt;
      s.z += s.dz * dt;
      s.rot += dt * 0.15;
    }
    this.sky = this.sky.filter((s) => s.y < 110);
    // Fireworks from the baked models, timed between the existing show's shells.
    this.burstT -= dt;
    if (T > 12 && T < 74 && this.burstT <= 0) {
      this.burstT = T > 55 ? 0.7 + Math.random() * 0.8 : 1.6 + Math.random() * 1.8;
      this.launchBurst();
      if (T > 55 && Math.random() < 0.5) this.launchBurst();
    }
    for (const b of this.bursts) b.update(dt);
    for (const b of this.bursts.filter((x) => x.done)) {
      this.group.remove(b.cloud.points);
      b.cloud.points.geometry.dispose();
      b.cloud.points.material.dispose();
    }
    this.bursts = this.bursts.filter((b) => !b.done);
    if (!ready) return;
    this.writeInstances(t, dt);
  }

  writeInstances(t, dt) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    let n = 0;
    const floats = this.player ? [this.player, ...this.floating] : this.floating;
    for (const l of floats) {
      if (n >= 160) break;
      // Bob and tilt with the ripples; the base always sits on the surface.
      const bob = l.settle !== undefined && l.settle < 1 ? 0 : Math.sin(t * 1.7 + l.seed) * 0.025;
      e.set(Math.sin(t * 1.3 + l.seed) * 0.06, l.rot + t * 0.05, Math.cos(t * 1.1 + l.seed) * 0.06);
      q.setFromEuler(e);
      const sc = l.own ? 0.34 : l.scale;
      v.set(l.x, l.y + bob, l.z);
      s.setScalar(sc);
      m.compose(v, q, s);
      for (const p of this.floatParts) p.setMatrixAt(n, m);
      this.glows.add(l.x, l.y + sc * 0.45 + bob, l.z, l.own ? 1.2 : 0.9, l.own ? PALETTE[5] : l.color, 0.6, 1.3);
      n++;
    }
    for (const p of this.floatParts) {
      p.count = n;
      p.instanceMatrix.needsUpdate = true;
    }
    const counts = [0, 0, 0];
    for (const l of this.sky) {
      const k = l.model;
      if (counts[k] >= 110) continue;
      e.set(Math.sin(t * 0.8 + l.seed) * 0.08, l.rot, Math.cos(t * 0.7 + l.seed) * 0.08);
      q.setFromEuler(e);
      v.set(l.x, l.y, l.z);
      s.setScalar(l.scale);
      m.compose(v, q, s);
      for (const p of this.skyParts[k]) p.setMatrixAt(counts[k], m);
      counts[k]++;
      const fade = Math.min(1, l.y / 3) * (l.y > 80 ? Math.max(0, 1 - (l.y - 80) / 30) : 1);
      this.glows.add(l.x, l.y + l.scale * 0.3, l.z, 1.5 * l.scale + 0.6, PALETTE[k === 2 ? 3 : 0], 0.7 * fade, 1.4);
    }
    this.skyParts.forEach((parts, k) => {
      for (const p of parts) {
        p.count = counts[k];
        p.instanceMatrix.needsUpdate = true;
      }
    });
    // Expanding ripple rings where lanterns touch the water.
    for (const r of this.ripples) {
      r.t += dt;
      const k = r.t / 1.6;
      for (let a = 0; a < 18; a++) {
        const ang = (a / 18) * Math.PI * 2;
        this.glows.add(r.x + Math.cos(ang) * k * 1.6 * r.size, RIVER.y + 0.02, r.z + Math.sin(ang) * k * 1.6 * r.size, 0.22, PALETTE[5], (1 - k) * 0.6, 1.2);
      }
    }
    this.ripples = this.ripples.filter((r) => r.t < 1.6);
  }

  stats() {
    return { floating: this.floating.length + (this.player ? 1 : 0), sky: this.sky.length, bursts: this.bursts.length, t: this.t };
  }
}

function signBoard() {
  return canvasTexture(256, 88, (g, w, h) => {
    g.fillStyle = '#2a1d14';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffe7b0';
    g.font = 'bold 34px "Yu Mincho", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('灯籠流し', w / 2, h / 2 - 10);
    g.font = '16px sans-serif';
    g.fillText('Lantern Festival · riverfront', w / 2, h / 2 + 24);
  });
}
