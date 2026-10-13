import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { ISLAND, WATER_Y } from './layout.js';
import { canvasTexture, keyColor, rand } from './util.js';

// ---------------------------------------------------------------- value noise for rugged cliffs
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, z) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (t) => t * t * (3 - 2 * t);
  const fx = s(x - xi);
  const fy = s(y - yi);
  const fz = s(z - zi);
  const L = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(xi + i, yi + j, zi + k);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), fx), L(c(0, 1, 0), c(1, 1, 0), fx), fy),
    L(L(c(0, 0, 1), c(1, 0, 1), fx), L(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}
export const fbm = (x, y, z) => vnoise(x, y, z) * 0.6 + vnoise(x * 2.1, y * 2.1, z * 2.1) * 0.28 + vnoise(x * 4.3, y * 4.3, z * 4.3) * 0.12;

export function pointInIsland(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const rockTexture = () =>
  canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#5b544c';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const v = rand(55, 120);
      g.fillStyle = `rgba(${v + 8},${v},${v - 8},${rand(0.2, 0.6)})`;
      g.fillRect(Math.random() * w, Math.random() * h, rand(4, 26), rand(2, 8));
    }
    g.strokeStyle = 'rgba(20,16,14,0.55)';
    for (let i = 0; i < 40; i++) {
      g.lineWidth = rand(1, 3);
      g.beginPath();
      let x = Math.random() * w;
      let y = Math.random() * h;
      g.moveTo(x, y);
      for (let k = 0; k < 5; k++) g.lineTo((x += rand(-30, 30)), (y += rand(5, 30)));
      g.stroke();
    }
    // Moss streaks near the top
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(${rand(50, 80)},${rand(80, 110)},${rand(40, 60)},${rand(0.25, 0.5)})`;
      g.fillRect(Math.random() * w, Math.random() * 40, rand(3, 12), rand(2, 6));
    }
  });

const grassTexture = () =>
  canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3e5a2c';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3500; i++) {
      g.fillStyle = `hsl(${rand(78, 110)},${rand(25, 45)}%,${rand(14, 32)}%)`;
      g.fillRect(Math.random() * w, Math.random() * h, 1.5, rand(2, 6));
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(${rand(100, 140)},${rand(85, 110)},${rand(60, 80)},0.35)`;
      g.beginPath();
      g.ellipse(Math.random() * w, Math.random() * h, rand(6, 20), rand(4, 12), rand(0, 3), 0, 7);
      g.fill();
    }
  });

// ---------------------------------------------------------------- water shader (planar reflection + ripples + fresnel)
const WaterShader = {
  name: 'FestivalWater',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color('#0b1a30') },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.01 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uDeep;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 w = vWorld.xz;
      vec2 d = vec2(
        sin(w.x * 0.9 + uTime * 1.1) + 0.6 * sin(w.y * 1.7 - uTime * 0.8) + 0.3 * sin((w.x + w.y) * 3.1 + uTime * 2.0),
        cos(w.y * 0.8 + uTime * 0.9) + 0.5 * cos(w.x * 1.9 + uTime * 1.3) + 0.3 * cos((w.x - w.y) * 2.7 - uTime * 1.7)
      ) * 0.006;
      vec4 uv = vUv;
      uv.xy += d * uv.w * 3.0;
      vec3 refl = texture2DProj(tDiffuse, uv).rgb;
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = 0.3 + 0.7 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
      vec3 col = uDeep + refl * fres;
      float dist = length(cameraPosition - vWorld);
      float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
      gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
    }`,
};

// ---------------------------------------------------------------- island
export function buildIsland(world) {
  const scene = world.scene;
  const curve = new THREE.CatmullRomCurve3(ISLAND.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
  const contour = curve.getSpacedPoints(300).slice(0, -1);
  world.islandContour = contour;

  const TOP = -0.12;
  const DEPTH = TOP - (WATER_Y - 1.6);
  const shape = new THREE.Shape(contour.map((p) => new THREE.Vector2(p.x, -p.z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, steps: 6, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, TOP - DEPTH, 0);
  // Rugged cliffs: displace outward with 3D noise, stronger toward the water.
  const pos = geo.attributes.position;
  const cx = 22;
  const cz = -20;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const below = (TOP - y) / DEPTH; // 0 at top rim, 1 at bottom
    const n = fbm(x * 0.35, y * 0.5, z * 0.35) - 0.45;
    const amp = 0.4 + below * 2.2;
    let dx = x - cx;
    let dz = z - cz;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const flare = below * below * 1.4; // cliffs widen slightly toward the base
    pos.setXYZ(i, x + dx * (n * amp + flare), y, z + dz * (n * amp + flare));
  }
  geo.computeVertexNormals();
  const grass = grassTexture();
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(0.22, 0.22);
  const rock = rockTexture();
  rock.wrapS = rock.wrapT = THREE.RepeatWrapping;
  rock.repeat.set(0.18, 0.2);
  const island = new THREE.Mesh(geo, [
    new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }),
    new THREE.MeshStandardMaterial({ map: rock, roughness: 0.95, flatShading: true }),
  ]);
  island.receiveShadow = true;
  island.castShadow = true;
  scene.add(island);

  // Boulders around the waterline and cliff face.
  const bGeo = new THREE.IcosahedronGeometry(1, 1);
  const bp = bGeo.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(bp, i);
    v.multiplyScalar(0.75 + fbm(v.x * 2 + 3, v.y * 2, v.z * 2) * 0.55);
    bp.setXYZ(i, v.x, v.y * 0.8, v.z);
  }
  bGeo.computeVertexNormals();
  const rockMat = new THREE.MeshStandardMaterial({ color: '#6a625a', roughness: 0.95, flatShading: true, map: rock });
  const rocks = [];
  contour.forEach((p, i) => {
    const out = new THREE.Vector3(p.x - cx, 0, p.z - cz).normalize();
    if (i % 2 === 0) rocks.push([p.x + out.x * rand(1.2, 2.6), WATER_Y + rand(-0.4, 0.6), p.z + out.z * rand(1.2, 2.6), rand(1, 2.4)]);
    if (i % 3 === 0) rocks.push([p.x + out.x * rand(0.6, 1.4), rand(-2.2, -1), p.z + out.z * rand(0.6, 1.4), rand(0.7, 1.5)]);
    if (i % 7 === 0) rocks.push([p.x + out.x * rand(3, 5), WATER_Y + rand(-0.8, 0.1), p.z + out.z * rand(3, 5), rand(0.5, 1.2)]);
  });
  const bm = new THREE.InstancedMesh(bGeo, rockMat, rocks.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  rocks.forEach(([x, y, z, s], i) => {
    q.setFromEuler(e.set(rand(0, 3), rand(0, 6), rand(0, 3)));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s * rand(0.9, 1.5), s, s * rand(0.9, 1.4)));
    bm.setMatrixAt(i, m);
  });
  bm.castShadow = bm.receiveShadow = true;
  scene.add(bm);

  // Shrubs and wildflowers along the cliff top.
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const shrubs = [];
  const flowers = [];
  contour.forEach((p, i) => {
    const inward = new THREE.Vector3(cx - p.x, 0, cz - p.z).normalize();
    if (i % 2 === 0) shrubs.push([p.x + inward.x * rand(0.4, 1.6), p.z + inward.z * rand(0.4, 1.6), rand(0.45, 0.9)]);
    for (let k = 0; k < 2; k++) flowers.push([p.x + inward.x * rand(0.2, 2) + rand(-0.6, 0.6), p.z + inward.z * rand(0.2, 2) + rand(-0.6, 0.6)]);
  });
  const shrubM = new THREE.InstancedMesh(bushGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), shrubs.length);
  shrubs.forEach(([x, z, s], i) => {
    m.compose(new THREE.Vector3(x, TOP + s * 0.4, z), q.identity(), new THREE.Vector3(s * 1.3, s, s * 1.3));
    shrubM.setMatrixAt(i, m);
    shrubM.setColorAt(i, new THREE.Color().setHSL(rand(0.25, 0.33), rand(0.35, 0.5), rand(0.16, 0.26)));
  });
  shrubM.castShadow = true;
  scene.add(shrubM);
  const flowerM = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4), new THREE.MeshStandardMaterial({ roughness: 0.7, emissive: '#ffffff', emissiveIntensity: 0.05 }), flowers.length);
  const fcols = ['#f06aa8', '#b77cf0', '#ffffff', '#ff9ec4', '#7a8cf0'];
  flowers.forEach(([x, z], i) => {
    m.compose(new THREE.Vector3(x, TOP + 0.12, z), q.identity(), new THREE.Vector3(1, 1, 1));
    flowerM.setMatrixAt(i, m);
    flowerM.setColorAt(i, new THREE.Color(fcols[i % fcols.length]));
  });
  scene.add(flowerM);

  // ---- water
  const waterGeo = new THREE.PlaneGeometry(1400, 1400);
  const reflector = new Reflector(waterGeo, {
    clipBias: 0.003,
    textureWidth: Math.round(innerWidth * 0.5),
    textureHeight: Math.round(innerHeight * 0.5),
    shader: WaterShader,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.y = WATER_Y;
  scene.add(reflector);
  const plainWater = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({ color: '#0e2440', roughness: 0.15, metalness: 0.2 }));
  plainWater.rotation.x = -Math.PI / 2;
  plainWater.position.y = WATER_Y;
  plainWater.visible = false;
  scene.add(plainWater);

  // Sakura petals floating on the water.
  const petals = [];
  while (petals.length < 900) {
    const x = rand(-40, 95);
    const z = rand(-85, 55);
    if (pointInIsland(x, z, contour)) continue;
    petals.push({ x, z, r: rand(0, 6), s: rand(0.7, 1.4), ph: rand(0, 6) });
  }
  const petalGeo = new THREE.CircleGeometry(0.07, 5).rotateX(-Math.PI / 2);
  petalGeo.scale(1, 1, 0.65);
  const petalMat = new THREE.MeshStandardMaterial({ color: '#ffc2d6', emissive: '#ff8fb6', emissiveIntensity: 0.1, roughness: 0.8, side: THREE.DoubleSide });
  world.registerGlow(petalMat, 0.05, 0.35);
  const petalMesh = new THREE.InstancedMesh(petalGeo, petalMat, petals.length);
  scene.add(petalMesh);

  const water = {
    reflector,
    plainWater,
    setQuality(hi) {
      reflector.visible = hi;
      plainWater.visible = !hi;
    },
    resize(w, h) {
      reflector.getRenderTarget().setSize(Math.round(w * 0.5), Math.round(h * 0.5));
    },
    update(dt, t) {
      const u = reflector.material.uniforms;
      u.uTime.value = t;
      keyColor([[0, '#1d4a6a'], [0.6, '#3a3148'], [0.85, '#08101f'], [1, '#050a16']], world.tod, u.uDeep.value);
      u.uFogColor.value.copy(scene.fog.color);
      u.uFogDensity.value = scene.fog.density;
      plainWater.material.color.copy(u.uDeep.value).multiplyScalar(1.4);
      for (let i = 0; i < petals.length; i++) {
        const p = petals[i];
        p.x += Math.sin(t * 0.15 + p.ph) * dt * 0.15 + world.wind * dt * 0.1;
        p.z += Math.cos(t * 0.12 + p.ph) * dt * 0.12;
        p.r += dt * 0.1;
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.r);
        m.compose(new THREE.Vector3(p.x, WATER_Y + 0.02 + Math.sin(t * 1.3 + p.ph) * 0.02, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        petalMesh.setMatrixAt(i, m);
      }
      petalMesh.instanceMatrix.needsUpdate = true;
    },
  };
  return water;
}
