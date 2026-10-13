import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Colliders } from './collision.js';
import { buildSakuraGrove } from './sakura.js';
import { L, KIMO_PATH, MODEL_SCALE, MODEL_URL, WORLD_BOUNDS } from './layout.js';
import { canvasTexture, clamp, damp, glowTexture, keyColor, keyLerp, lerp, rand, signTexture, smoothstep } from './util.js';

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...o });

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.colliders = new Colliders();
    this.colliders.bounds = { ...WORLD_BOUNDS };
    this.interactables = [];
    this.glowMats = []; // { mat, day, night } emissive multipliers
    this.lights = []; // { light, base, flicker }
    this.tod = 0; // 0 = late afternoon, 1 = full night
    this.glow = 0;
    this.night = 0;
    this.forest = 0;
    this.time = 0;
    this.wind = 0;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3(0.45, 0.72, -0.52).normalize();
    this.flash = null; // fireworks light injected later
    this.cb = {}; // callbacks wired by main (pray, omikuji, fireworks)

    this.setupEnvironment();
    this.buildGround();
    this.buildLanternStrings();
    this.buildTorii(L.torii, 1, 0);
    this.buildShrine();
    this.buildStoneLanterns();
    this.buildOmikuji();
    this.buildViewingArea();
    this.buildTrees();
    this.buildPetals();
    // Cherry-blossom grove framing the plaza, shrine and street (inspired by the concept art).
    buildSakuraGrove(this, [
      [-12, -15], [-6, -15.5], [0, -15.5], [6, -15], [-12, 14.5], [-6, 15], [0, 15], [6, 14.5],
      [13, -9], [13, 9.5], [19.5, 11.5], [27, 11.5], [36, 10.5], [42, 11], [48, 11],
      [33, -8.5], [37.5, -7.5], [55, -9.5], [55, 9.5], [44.5, -9], [44.5, 9],
    ]);
  }

  // ---------------------------------------------------------------- environment
  setupEnvironment() {
    const { scene, renderer } = this;
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;

    this.sky = new Sky();
    this.sky.scale.setScalar(4000);
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;

    // Stars
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const y = Math.random() * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(th) * r * 1800, y * 1800, Math.sin(th) * r * 1800], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    scene.add(this.stars);

    // Moon
    const moonTex = canvasTexture(128, 128, (g) => {
      const grd = g.createRadialGradient(64, 64, 20, 64, 64, 64);
      grd.addColorStop(0, 'rgba(255,255,245,1)');
      grd.addColorStop(0.36, 'rgba(240,244,255,0.95)');
      grd.addColorStop(0.42, 'rgba(180,200,255,0.25)');
      grd.addColorStop(1, 'rgba(120,150,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 128, 128);
    });
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, transparent: true, opacity: 0, fog: false, depthWrite: false }));
    this.moon.scale.setScalar(160);
    scene.add(this.moon);

    this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x6b5a45, 1);
    scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 2.5));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 1, far: 220 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    scene.fog = new THREE.FogExp2(0xcfe0ef, 0.005);
  }

  addLight(pos, { color = 0xffa45a, base = 10, distance = 14, flicker = 0.06 } = {}) {
    const light = new THREE.PointLight(color, 0, distance, 2);
    light.position.copy(pos);
    this.scene.add(light);
    this.lights.push({ light, base, flicker, seed: Math.random() * 100 });
    return light;
  }

  registerGlow(mat, day, night) {
    if (this.glowMats.some((g) => g.mat === mat)) return;
    this.glowMats.push({ mat, day, night });
  }

  addInteractable(def) {
    this.interactables.push({ radius: 2.2, enabled: () => true, ...def });
  }

  // ---------------------------------------------------------------- the Sketchfab street
  async loadModel(manager) {
    const loader = new GLTFLoader(manager);
    const gltf = await loader.loadAsync(MODEL_URL);
    const root = gltf.scene;
    root.scale.setScalar(MODEL_SCALE);
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      if (m.name === 'tenmaku') {
        // Awning cloth was exported as BLEND; alpha-test avoids sorting artefacts.
        m.transparent = false;
        m.alphaTest = 0.5;
        m.depthWrite = true;
      }
      if (/^material_0\.00[1-5]$/.test(m.name)) this.registerGlow(m, 0.8, 2.4); // stall signs/boards
      if (m.name === 'Material.004' || m.name === 'Material.002') this.registerGlow(m, 0.3, 2.8); // chouchin lanterns
      if (m.name === 'denkyu') this.registerGlow(m, 0.35, 3.2); // light bulbs
    });
    this.scene.add(root);
    this.model = root;

    // Colliders from the real model geometry: kohaku-maku stall counters and the fox-mask wall.
    const box = new THREE.Box3();
    const sane = THREE.PropertyBinding.sanitizeNodeName;
    for (const name of ['kohaku101.000', 'kohaku101.005', 'fox']) {
      const obj = root.getObjectByName(sane(name));
      if (obj) this.colliders.addBox3(box.setFromObject(obj), 0.05, name);
    }
    // Block the service space behind the stall rows.
    this.colliders.addBox(-14, -15, 13, -3.6, 'behind-north');
    this.colliders.addBox(-14, 3.4, 13, 15, 'behind-south');

    // Street lanterns get a few real lights.
    this.addLight(new THREE.Vector3(-4, 2.4, -0.3), { base: 9 });
    this.addLight(new THREE.Vector3(4.5, 2.4, -0.3), { base: 9 });
    return root;
  }

  // ---------------------------------------------------------------- ground and paths
  buildGround() {
    const grass = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#56733a';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = `hsl(${rand(75, 105)},${rand(25, 45)}%,${rand(18, 36)}%)`;
        g.fillRect(Math.random() * w, Math.random() * h, 1.5, rand(2, 6));
      }
    }, { repeat: [90, 90] });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), std('#ffffff', { map: grass, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.12;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const dirt = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#a28a66';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 3000; i++) {
        g.fillStyle = `rgba(${rand(70, 140)},${rand(55, 110)},${rand(40, 80)},${rand(0.2, 0.6)})`;
        g.fillRect(Math.random() * w, Math.random() * h, rand(1, 3), rand(1, 3));
      }
    }, { repeat: [7, 7] });
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(30, 26), std('#ffffff', { map: dirt, roughness: 1 }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(24, -0.09, 0);
    plaza.receiveShadow = true;
    this.scene.add(plaza);

    const gravel = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#b9b3a6';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 5000; i++) {
        const v = rand(120, 220);
        g.fillStyle = `rgb(${v},${v - 5},${v - 15})`;
        g.beginPath();
        g.arc(Math.random() * w, Math.random() * h, rand(0.6, 1.8), 0, 7);
        g.fill();
      }
    }, { repeat: [8, 8] });
    const court = new THREE.Mesh(new THREE.PlaneGeometry(22, 20), std('#ffffff', { map: gravel, roughness: 0.95 }));
    court.rotation.x = -Math.PI / 2;
    court.position.set(46, -0.08, 0);
    court.receiveShadow = true;
    this.scene.add(court);

    // Stone-slab approach (ishidatami) continuing the model's paving to the shrine.
    const stone = canvasTexture(256, 128, (g, w, h) => {
      g.fillStyle = '#6d6a64';
      g.fillRect(0, 0, w, h);
      const rows = 3;
      for (let r = 0; r < rows; r++) {
        let x = r % 2 ? -30 : 0;
        while (x < w) {
          const sw = rand(50, 80);
          const v = rand(120, 165);
          g.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
          g.fillRect(x + 3, (r * h) / rows + 3, sw - 6, h / rows - 6);
          x += sw;
        }
      }
    }, { repeat: [18, 1] });
    const path = new THREE.Mesh(new THREE.PlaneGeometry(36, 3.2), std('#ffffff', { map: stone, roughness: 0.55, metalness: 0.05 }));
    path.rotation.x = -Math.PI / 2;
    path.position.set(27.5, -0.035, 0);
    path.receiveShadow = true;
    this.scene.add(path);
    this.stoneMat = path.material;

    // Low fence marking the southern meadow edge (keeps the fireworks view open).
    const post = new THREE.CylinderGeometry(0.06, 0.07, 1, 6);
    const wood = std('#6b4a2f');
    const fence = new THREE.Group();
    for (let x = 12; x <= 56; x += 2) {
      const p = new THREE.Mesh(post, wood);
      p.position.set(x, 0.5, 13.3);
      fence.add(p);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(44, 0.08, 0.06), wood);
    rail.position.set(34, 0.8, 13.3);
    fence.add(rail);
    this.scene.add(fence);
  }

  // ---------------------------------------------------------------- lanterns (animated by wind)
  buildLanternStrings() {
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 3.4, 8);
    poleGeo.translate(0, 1.7, 0);
    const poleMat = std('#5a3b24');
    const xs = [11, 15.5, 20, 24.5, 29, 33.5];
    const anchors = [];
    const ropePts = [];
    for (const side of [-1.95, 1.95]) {
      for (let i = 0; i < xs.length; i++) {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(xs[i], 0, side);
        pole.castShadow = true;
        this.scene.add(pole);
        this.colliders.addCircle(xs[i], side, 0.12, 'pole');
        if (i === xs.length - 1) continue;
        const a = new THREE.Vector3(xs[i], 3.3, side);
        const b = new THREE.Vector3(xs[i + 1], 3.3, side);
        const seg = [];
        for (let k = 0; k <= 16; k++) {
          const t = k / 16;
          seg.push(new THREE.Vector3(lerp(a.x, b.x, t), 3.3 - Math.sin(t * Math.PI) * 0.4, side));
        }
        ropePts.push(seg);
        for (let k = 1; k < 5; k++) {
          const t = k / 5;
          anchors.push(new THREE.Vector3(lerp(a.x, b.x, t), 3.3 - Math.sin(t * Math.PI) * 0.4, side));
        }
      }
    }
    // A zig-zag string crossing over the path.
    for (let i = 0; i < xs.length - 1; i++) {
      const a = new THREE.Vector3(xs[i], 3.3, -1.95);
      const b = new THREE.Vector3(xs[i + 1], 3.3, 1.95);
      const seg = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        seg.push(new THREE.Vector3().lerpVectors(a, b, t).setY(3.3 - Math.sin(t * Math.PI) * 0.5));
      }
      ropePts.push(seg);
      for (let k = 1; k < 5; k++) {
        const t = k / 5;
        anchors.push(new THREE.Vector3().lerpVectors(a, b, t).setY(3.3 - Math.sin(t * Math.PI) * 0.5));
      }
    }
    const ropeMat = new THREE.LineBasicMaterial({ color: 0x2a1a10 });
    for (const seg of ropePts) this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg), ropeMat));

    const geo = new THREE.SphereGeometry(0.17, 14, 10);
    geo.scale(1, 1.3, 1);
    const cap = new THREE.CylinderGeometry(0.09, 0.09, 0.05, 10);
    const capT = cap.clone().translate(0, 0.22, 0);
    const capB = cap.clone().translate(0, -0.22, 0);
    const merged = mergeGeometries([geo, capT, capB], true);
    const paper = std('#e0442a', { emissive: '#ff6a2a', emissiveIntensity: 1, roughness: 0.6 });
    const capMat = std('#1b1210');
    this.registerGlow(paper, 0.25, 3.0);
    const mesh = new THREE.InstancedMesh(merged, [paper, capMat, capMat], anchors.length);
    mesh.castShadow = false;
    this.scene.add(mesh);
    this.lanterns = { mesh, anchors, phase: anchors.map(() => Math.random() * 6.28) };

    this.addLight(new THREE.Vector3(14, 2.7, 0), { base: 10 });
    this.addLight(new THREE.Vector3(27, 2.7, 0), { base: 10 });
  }

  updateLanterns(t) {
    const { mesh, anchors, phase } = this.lanterns;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < anchors.length; i++) {
      // Wind response: pendulum sway around the hanging point.
      const sway = Math.sin(t * 1.7 + phase[i]) * 0.08 + this.wind * 0.22 * Math.sin(t * 0.9 + phase[i] * 0.5);
      e.set(sway * 0.4, 0, sway);
      q.setFromEuler(e);
      p.set(0, -0.32, 0).applyQuaternion(q).add(anchors[i]);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- shrine district
  buildTorii(pos, s = 1, rotY = 0, parent = this.scene) {
    const g = new THREE.Group();
    const red = std('#c9331b', { roughness: 0.6 });
    const black = std('#1c1614', { roughness: 0.7 });
    const pillar = new THREE.CylinderGeometry(0.2 * s, 0.25 * s, 4.4 * s, 12);
    for (const z of [-2.2 * s, 2.2 * s]) {
      const p = new THREE.Mesh(pillar, red);
      p.position.set(0, 2.2 * s, z);
      p.castShadow = true;
      g.add(p);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, 0.32 * s, 0.35 * s, 12), black);
      base.position.set(0, 0.17 * s, z);
      g.add(base);
    }
    const kasagi = new THREE.Mesh(new THREE.BoxGeometry(0.55 * s, 0.3 * s, 6.4 * s), red);
    kasagi.position.y = 4.45 * s;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.7 * s, 0.18 * s, 6.9 * s), black);
    top.position.y = 4.68 * s;
    const nuki = new THREE.Mesh(new THREE.BoxGeometry(0.25 * s, 0.24 * s, 5.6 * s), red);
    nuki.position.y = 3.65 * s;
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.1 * s, 0.6 * s, 0.4 * s), black);
    plaque.position.y = 4.05 * s;
    for (const m of [kasagi, top, nuki, plaque]) {
      m.castShadow = true;
      g.add(m);
    }
    g.position.copy(pos);
    g.rotation.y = rotY;
    parent.add(g);
    g.updateMatrixWorld(true);
    for (const z of [-2.2 * s, 2.2 * s]) {
      const w = new THREE.Vector3(0, 0, z).applyMatrix4(g.matrixWorld);
      this.colliders.addCircle(w.x, w.z, 0.3 * s, 'torii');
    }
    return g;
  }

  buildShrine() {
    const S = L.shrine;
    const stoneMat = std('#8d8a84', { roughness: 0.9 });
    const woodMat = std('#7a3b22', { roughness: 0.75 });
    const redMat = std('#b8321c', { roughness: 0.6 });
    const roofMat = std('#34403e', { roughness: 0.7, metalness: 0.2 });
    const g = new THREE.Group();

    const base = new THREE.Mesh(new THREE.BoxGeometry(9, 0.8, 9), stoneMat);
    base.position.set(S.x, 0.4, 0);
    g.add(base);
    for (let i = 0; i < 3; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.27 * (i + 1), 3), stoneMat);
      step.position.set(S.x - 4.5 - (3 - i) * 0.35 + 0.17, 0.135 * (i + 1), 0);
      g.add(step);
    }
    const lattice = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#5a2a18';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#e9d9b8';
      for (let x = 10; x < w; x += 28) for (let y = 10; y < h; y += 28) c.fillRect(x, y, 20, 20);
    });
    const hall = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 6.4), [
      woodMat, woodMat, woodMat, woodMat, woodMat, woodMat,
    ]);
    hall.material = hall.material.map((m) => m.clone());
    hall.material[1] = std('#ffffff', { map: lattice, emissive: '#ffb060', emissiveIntensity: 0, emissiveMap: lattice }); // -x face (front)
    this.registerGlow(hall.material[1], 0, 0.6);
    hall.position.set(S.x + 0.5, 2.4, 0);
    g.add(hall);
    for (const [dx, dz] of [[-3.3, -3.4], [-3.3, 3.4], [3.3, -3.4], [3.3, 3.4], [-3.3, -1.2], [-3.3, 1.2]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.4, 10), redMat);
      p.position.set(S.x + 0.5 + dx, 2.5, dz);
      g.add(p);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.4, 2.8, 4, 1), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1.05, 1, 1.18);
    roof.position.set(S.x + 0.5, 5.4, 0);
    g.add(roof);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 2.4), std('#c9a23a', { metalness: 0.7, roughness: 0.35 }));
    ridge.position.set(S.x + 0.5, 6.7, 0);
    g.add(ridge);
    // Shimenawa rope with shide paper
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.2, 10), std('#d8c68a'));
    rope.rotation.x = Math.PI / 2;
    rope.position.set(S.x - 2.75, 3.75, 0);
    g.add(rope);
    const shideMat = std('#ffffff', { side: THREE.DoubleSide, emissive: '#ffffff', emissiveIntensity: 0.05 });
    for (const z of [-1.8, -0.6, 0.6, 1.8]) {
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.5).rotateY(Math.PI / 2), shideMat);
      sh.scale.z = 8;
      sh.position.set(S.x - 2.8, 3.4, z);
      g.add(sh);
    }
    g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(g);
    this.colliders.addBox(S.x - 5.6, -4.5, S.x + 4.5, 4.5, 'shrine');

    // Suzu bell with rope (animated when the player prays)
    const bell = new THREE.Group();
    bell.position.set(S.x - 4.2, 3.8, 0);
    const brope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6), std('#c93a2a'));
    brope.position.y = -1.3 - 0.35;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), std('#d6a93a', { metalness: 0.9, roughness: 0.25 }));
    ball.position.y = -0.2;
    bell.add(brope, ball);
    this.scene.add(bell);
    this.bell = { g: bell, amp: 0 };

    // Offering box
    const saisen = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.75, 1.8), std('#6a4526'));
    saisen.position.set(L.offering.x - 0.4, 0.37, 0);
    saisen.castShadow = true;
    this.scene.add(saisen);
    this.colliders.addRect(L.offering.x - 0.4, 0, 0.4, 0.9, 'saisen');
    this.addLight(new THREE.Vector3(S.x - 5, 3.2, 0), { base: 12, color: 0xffb070 });

    this.addInteractable({
      id: 'pray',
      pos: new THREE.Vector3(L.offering.x - 1.5, 0, 0),
      label: 'Ring the bell & pray',
      action: () => this.cb.pray?.(),
    });

    // Sakura accents
    const blossom = std('#f5b8c9', { roughness: 0.9, emissive: '#f59ab5', emissiveIntensity: 0.05 });
    const trunk = std('#4d3226');
    const blob = new THREE.IcosahedronGeometry(1, 1);
    for (const [x, z] of [[40, -7.5], [40, 7.5], [53, -7], [53, 7], [35.5, -6.5]]) {
      const t = new THREE.Group();
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 3, 7), trunk);
      tr.position.y = 1.5;
      t.add(tr);
      for (let i = 0; i < 6; i++) {
        const b = new THREE.Mesh(blob, blossom);
        b.position.set(rand(-1.3, 1.3), rand(3, 4.4), rand(-1.3, 1.3));
        b.scale.setScalar(rand(0.9, 1.5));
        t.add(b);
      }
      t.position.set(x, 0, z);
      t.traverse((o) => o.isMesh && (o.castShadow = true));
      this.scene.add(t);
      this.colliders.addCircle(x, z, 0.4, 'sakura');
    }
  }

  buildStoneLanterns() {
    const stone = std('#9a968e', { roughness: 0.95 });
    const flame = std('#ffcf7a', { emissive: '#ffb347', emissiveIntensity: 1 });
    this.registerGlow(flame, 0.1, 3.2);
    const make = (x, z) => {
      const g = new THREE.Group();
      const parts = [
        [new THREE.CylinderGeometry(0.35, 0.4, 0.25, 8), 0.12],
        [new THREE.CylinderGeometry(0.12, 0.14, 0.9, 8), 0.7],
        [new THREE.BoxGeometry(0.55, 0.12, 0.55), 1.2],
      ];
      for (const [geo, y] of parts) {
        const m = new THREE.Mesh(geo, stone);
        m.position.y = y;
        g.add(m);
      }
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.42), flame);
      box.position.y = 1.46;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.4, 4), stone);
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 1.86;
      g.add(box, roof);
      g.position.set(x, 0, z);
      g.traverse((o) => o.isMesh && (o.castShadow = true));
      this.scene.add(g);
      this.colliders.addCircle(x, z, 0.4, 'toro');
    };
    for (const x of [39.5, 42.2]) for (const z of [-2.8, 2.8]) make(x, z);
    this.makeStoneLantern = make;
  }

  buildOmikuji() {
    const O = L.omikuji;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.05, 0.6), std('#b8321c'));
    stand.position.set(O.x, 0.52, O.z);
    const box = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.4, 6), std('#c9a23a', { metalness: 0.3 }));
    box.position.set(O.x, 1.25, O.z);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4), new THREE.MeshStandardMaterial({ map: signTexture('おみくじ', { font: 58 }) }));
    sign.position.set(O.x, 0.7, O.z + 0.31);
    this.scene.add(stand, box, sign);
    this.colliders.addRect(O.x, O.z, 0.5, 0.35, 'omikuji');
    // Rack where drawn fortunes are tied.
    const rackX = O.x - 2.2;
    const wood = std('#5a3b24');
    for (const dx of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6), wood);
      p.position.set(rackX + dx, 0.8, O.z - 0.8);
      this.scene.add(p);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2, 5), std('#d8c68a'));
    bar.rotation.z = Math.PI / 2;
    bar.position.set(rackX, 1.45, O.z - 0.8);
    this.scene.add(bar);
    const knotGeo = new THREE.BoxGeometry(0.05, 0.14, 0.03);
    const knotMat = std('#f6f2e8');
    this.tieFortune = () => {
      const k = new THREE.Mesh(knotGeo, knotMat);
      k.position.set(rackX + rand(-0.9, 0.9), 1.4, O.z - 0.8);
      k.rotation.z = rand(-0.4, 0.4);
      this.scene.add(k);
    };
    for (let i = 0; i < 9; i++) this.tieFortune();
    this.addInteractable({ id: 'omikuji', pos: new THREE.Vector3(O.x, 0, O.z + 1.1), label: 'Draw an omikuji fortune (¥100)', action: () => this.cb.omikuji?.() });
  }

  buildViewingArea() {
    const V = L.viewing;
    const wood = std('#7a5634');
    for (const [dx, dz] of [[-3, -0.5], [0, 0.6], [3, -0.5]]) {
      const b = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.5), wood);
      seat.position.y = 0.45;
      b.add(seat);
      for (const lx of [-0.95, 0.95]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.45), wood);
        leg.position.set(lx, 0.22, 0);
        b.add(leg);
      }
      b.position.set(V.x + dx, 0, V.z + dz);
      b.traverse((o) => o.isMesh && (o.castShadow = true));
      this.scene.add(b);
      this.colliders.addRect(V.x + dx, V.z + dz, 1.1, 0.25, 'bench');
    }
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), wood);
    post.position.set(V.x - 5.2, 1.1, V.z - 2.5);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshStandardMaterial({ map: signTexture('花火 観覧席', { bg: '#1b2a55', font: 44 }) }));
    board.position.set(V.x - 5.2, 1.9, V.z - 2.56);
    board.rotation.y = Math.PI;
    this.scene.add(post, board);
    this.colliders.addCircle(V.x - 5.2, V.z - 2.5, 0.15);
    this.addInteractable({
      id: 'fireworks',
      pos: new THREE.Vector3(V.x, 0, V.z - 1.8),
      radius: 3,
      label: 'Start the fireworks finale',
      action: () => this.cb.fireworks?.(),
    });
  }

  // ---------------------------------------------------------------- trees
  buildTrees() {
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 3.2, 6).translate(0, 1.6, 0);
    const leafGeo = mergeGeometries([
      new THREE.ConeGeometry(1.9, 3.2, 7).translate(0, 3.6, 0),
      new THREE.ConeGeometry(1.45, 2.8, 7).translate(0, 5.2, 0),
      new THREE.ConeGeometry(0.95, 2.3, 7).translate(0, 6.6, 0),
    ]);
    const spots = [];
    const distToKimo = (x, z) => {
      let best = 1e9;
      for (let i = 0; i < KIMO_PATH.length - 1; i++) {
        const a = KIMO_PATH[i];
        const b = KIMO_PATH[i + 1];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const t = clamp(((x - a.x) * abx + (z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
        best = Math.min(best, Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)));
      }
      return best;
    };
    this.distToKimo = distToKimo;
    // Kimodameshi forest: dense cedars except along the path.
    for (let x = 17; x < 60; x += 2.3) {
      for (let z = -58; z < -11; z += 2.3) {
        const px = x + rand(-0.9, 0.9);
        const pz = z + rand(-0.9, 0.9);
        if (distToKimo(px, pz) < 2.6) continue;
        if (pz > -13.5 && px < 34) continue; // keep taiko area open
        spots.push([px, pz, rand(0.85, 1.35), true]);
      }
    }
    // Background woodland ringing the festival, leaving the southern sky open for fireworks.
    for (let x = -70; x < 110; x += 6) {
      for (let z = -95; z < 110; z += 6) {
        const px = x + rand(-2.5, 2.5);
        const pz = z + rand(-2.5, 2.5);
        if (px > -15 && px < 60 && pz > -17 && pz < 16) continue;
        if (px > 12 && px < 62 && pz > -62 && pz <= -17) continue;
        if (px > 0 && px < 80 && pz >= 16 && pz < 40) continue;
        if (px > 20 && px < 60 && pz >= 40 && pz < 95) continue;
        spots.push([px, pz, rand(0.9, 1.6), false]);
      }
    }
    // North strip between the street model and the forest
    for (let x = 12; x < 17; x += 2.4) for (let z = -13; z > -30; z -= 2.4) spots.push([x + rand(-0.6, 0.6), z, rand(0.9, 1.2), true]);

    const trunks = new THREE.InstancedMesh(trunkGeo, std('#4a3426', { roughness: 1 }), spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, std('#2d4a2b', { roughness: 0.95, flatShading: true }), spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    spots.forEach(([x, z, s, collide], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6.28);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * rand(0.9, 1.2), s));
      trunks.setMatrixAt(i, m);
      leaves.setMatrixAt(i, m);
      const c = new THREE.Color().setHSL(rand(0.27, 0.34), rand(0.3, 0.45), rand(0.16, 0.24));
      leaves.setColorAt(i, c);
      if (collide) this.colliders.addCircle(x, z, 0.35 * s, 'tree');
    });
    for (const im of [trunks, leaves]) {
      im.castShadow = true;
      im.receiveShadow = true;
      this.scene.add(im);
    }
  }

  // Falling sakura petals near the shrine and viewing area.
  buildPetals() {
    const n = 500;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set([rand(30, 56), rand(0, 7), rand(-9, 12)], i * 3);
      seed[i] = Math.random() * 10;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: '#ffc4d6', size: 0.09, map: glowTexture(), transparent: true, depthWrite: false, opacity: 0.9 });
    this.petals = new THREE.Points(geo, mat);
    this.petals.userData.seed = seed;
    this.scene.add(this.petals);
  }

  updatePetals(dt, t) {
    const a = this.petals.geometry.attributes.position;
    const seed = this.petals.userData.seed;
    for (let i = 0; i < a.count; i++) {
      let y = a.getY(i) - dt * (0.35 + (seed[i] % 1) * 0.3);
      let x = a.getX(i) + dt * (Math.sin(t * 1.3 + seed[i]) * 0.5 + this.wind * 0.8);
      const z = a.getZ(i) + dt * Math.cos(t * 0.9 + seed[i]) * 0.4;
      if (y < 0) {
        y = 7;
        x = rand(30, 56);
      }
      a.setXYZ(i, x, y, z);
    }
    a.needsUpdate = true;
  }

  // ---------------------------------------------------------------- per-frame lighting
  update(dt, focus) {
    this.time += dt;
    const t = this.time;
    const tod = this.tod;
    this.wind = 0.5 + 0.5 * Math.sin(t * 0.31) * Math.sin(t * 0.73 + 1.3);

    const inForest = focus.z < -11.5 && focus.x > 17 && focus.x < 58 ? 1 : 0;
    this.forest = damp(this.forest, inForest, 1.5, dt);
    const F = this.forest;

    const elev = THREE.MathUtils.degToRad(30 - 42 * tod);
    this.sunDir.set(-0.6 * Math.cos(elev), Math.sin(elev), 0.8 * Math.cos(elev));
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    u.rayleigh.value = keyLerp([[0, 1.1], [0.6, 2.6], [1, 0.4]], tod);
    u.turbidity.value = keyLerp([[0, 3], [0.6, 8], [1, 1.5]], tod);

    const sunI = keyLerp([[0, 2.7], [0.5, 2.3], [0.64, 1.0], [0.72, 0]], tod);
    const moonI = keyLerp([[0.72, 0], [0.9, 0.45], [1, 0.5]], tod);
    const sun = this.sun;
    const snap = (v) => Math.round(v / 2) * 2;
    const fx = snap(focus.x);
    const fz = snap(focus.z);
    if (sunI > 0.001) {
      sun.position.set(fx, 0, fz).addScaledVector(this.sunDir, 90);
      sun.intensity = sunI;
      keyColor([[0, '#fff3dc'], [0.45, '#ffdcaa'], [0.6, '#ff9c58'], [0.72, '#ff5a30']], tod, sun.color);
    } else {
      sun.position.set(fx, 0, fz).addScaledVector(this.moonDir, 90);
      sun.intensity = moonI;
      sun.color.set('#9fb4ff');
    }
    sun.intensity *= 1 - 0.85 * F;
    sun.target.position.set(fx, 0, fz);

    keyColor([[0, '#bcd8ff'], [0.6, '#ffb48a'], [0.8, '#4a4a8a'], [1, '#243060']], tod, this.hemi.color);
    keyColor([[0, '#7a6a52'], [0.6, '#6a4a3a'], [1, '#101020']], tod, this.hemi.groundColor);
    this.hemi.intensity = keyLerp([[0, 1.1], [0.6, 0.8], [0.85, 0.35], [1, 0.28]], tod) * (1 - 0.75 * F);

    const fog = this.scene.fog;
    keyColor([[0, '#cfe0ef'], [0.55, '#f3c29a'], [0.7, '#d9785a'], [0.82, '#3a2e55'], [1, '#0b1030']], tod, fog.color);
    fog.color.lerp(new THREE.Color('#05070d'), F * 0.85);
    fog.density = lerp(keyLerp([[0, 0.004], [0.7, 0.007], [1, 0.011]], tod), 0.075, F);

    this.renderer.toneMappingExposure = keyLerp([[0, 0.6], [0.6, 0.62], [1, 0.72]], tod);
    this.scene.environmentIntensity = keyLerp([[0, 0.8], [0.6, 0.45], [1, 0.12]], tod) * (1 - 0.8 * F);

    const night = smoothstep(0.62, 0.95, tod);
    this.night = night;
    const glow = smoothstep(0.4, 0.85, tod);
    this.glow = glow;
    for (const g of this.glowMats) g.mat.emissiveIntensity = lerp(g.day, g.night * 0.6, glow);
    for (const L0 of this.lights) {
      const flick = 1 + Math.sin(t * 13 + L0.seed) * L0.flicker * 0.5 + Math.sin(t * 7.3 + L0.seed * 2) * L0.flicker * 0.5;
      L0.light.intensity = L0.base * 0.45 * glow * flick;
    }
    this.stars.material.opacity = night * (1 - 0.5 * F);
    this.moon.material.opacity = night;
    this.moon.position.copy(this.moonDir).multiplyScalar(1500);

    // Bell swing
    const b = this.bell;
    b.amp = damp(b.amp, 0, 1.2, dt);
    b.g.rotation.z = Math.sin(t * 7) * b.amp;

    this.updateLanterns(t);
    this.updatePetals(dt, t);
  }

  clockLabel() {
    const mins = 16 * 60 + 30 + Math.round(this.tod * 240);
    const hh = Math.floor(mins / 60);
    const mm = String(mins % 60).padStart(2, '0');
    const phase = this.tod < 0.45 ? 'Afternoon' : this.tod < 0.8 ? 'Dusk' : 'Night';
    return `${hh}:${mm} · ${phase}`;
  }
}
