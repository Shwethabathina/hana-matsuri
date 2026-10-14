import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildBooth } from '../booth.js';
import { L } from '../layout.js';
import { G, emit } from '../state.js';
import { sfx } from '../audio.js';
import { angleDamp, canvasTexture, clamp, damp, pick, rand } from '../util.js';

const TUB = new THREE.Vector3(L.goldfish.x, 0, L.goldfish.z + 1.8);
const HX = 1.45; // tub half extents (water area)
const HZ = 0.62;
const WATER_Y = 0.46;
const POI_R = 0.13;
const CATCH_DEPTH = 0.15; // fish deeper than this slip under the paper
const FISH_URL = 'models/goldfish.glb'; // rigged goldfish, 8 animation clips (CC-BY Picasty)

const FISH_TYPES = [
  { name: 'Wakin', tint: '#ffffff', weight: 0.14, score: 1, size: 1 },
  { name: 'Red wakin', tint: '#ff6a5a', weight: 0.14, score: 1, size: 1 },
  { name: 'Ryukin', tint: '#ffd9b0', weight: 0.16, score: 2, size: 1.1 },
  { name: 'Black demekin', tint: '#3a3a44', weight: 0.24, score: 3, size: 1.25 },
];

// =====================================================================
// Height-field water: discrete 2D wave equation on a grid (the classic
// "ripple tank" scheme). h' = (sum of 4 neighbours)/2 - h_prev, then damped.
// Fixed borders reflect waves off the tub walls.
// =====================================================================
class RippleWater {
  constructor(width, depth, cellsX) {
    this.w = width;
    this.d = depth;
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        roughness: 0.04,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 2;
    this.damping = 0.986;
    this.acc = 0;
    this.stepMs = 0;
    this.resize(cellsX);
  }

  resize(cellsX) {
    this.nx = cellsX;
    this.nz = Math.max(8, Math.round((cellsX * this.d) / this.w));
    const n = (this.nx + 1) * (this.nz + 1);
    this.cur = new Float32Array(n);
    this.prev = new Float32Array(n);
    const geo = new THREE.PlaneGeometry(this.w, this.d, this.nx, this.nz);
    geo.rotateX(-Math.PI / 2); // vertex (ix, iz) -> x = ix*dx - w/2, z = iz*dz - d/2
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    this.base = new THREE.Color('#2f86c8');
    this.crest = new THREE.Color('#d8f2ff');
  }

  get cells() {
    return this.nx * this.nz;
  }

  // Add a smooth (cosine) bump at tub-local x,z.
  disturb(x, z, radius, amount) {
    const fx = ((x + this.w / 2) / this.w) * this.nx;
    const fz = ((z + this.d / 2) / this.d) * this.nz;
    const rc = Math.max(1, (radius / this.w) * this.nx);
    const W = this.nx + 1;
    for (let j = Math.max(1, Math.floor(fz - rc)); j <= Math.min(this.nz - 1, Math.ceil(fz + rc)); j++) {
      for (let i = Math.max(1, Math.floor(fx - rc)); i <= Math.min(this.nx - 1, Math.ceil(fx + rc)); i++) {
        const dd = Math.hypot(i - fx, j - fz) / rc;
        if (dd < 1) this.cur[j * W + i] += amount * 0.5 * (1 + Math.cos(Math.PI * dd));
      }
    }
  }

  step() {
    const W = this.nx + 1;
    const c = this.cur;
    const p = this.prev;
    for (let j = 1; j < this.nz; j++) {
      const row = j * W;
      for (let i = 1; i < this.nx; i++) {
        const k = row + i;
        p[k] = ((c[k - 1] + c[k + 1] + c[k - W] + c[k + W]) * 0.5 - p[k]) * this.damping;
      }
    }
    this.cur = p;
    this.prev = c;
  }

  update(dt) {
    const t0 = performance.now();
    // Fixed 60 Hz simulation independent of frame rate.
    this.acc = Math.min(this.acc + dt, 0.1);
    let steps = 0;
    while (this.acc >= 1 / 60) {
      this.step();
      this.acc -= 1 / 60;
      steps++;
    }
    if (steps) {
      const pos = this.mesh.geometry.attributes.position;
      const col = this.mesh.geometry.attributes.color;
      const h = this.cur;
      const tmp = new THREE.Color();
      for (let k = 0; k < h.length; k++) {
        pos.setY(k, h[k]);
        tmp.copy(this.base).lerp(this.crest, Math.min(1, Math.max(0, h[k] * 60)));
        col.setXYZ(k, tmp.r, tmp.g, tmp.b);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      this.mesh.geometry.computeVertexNormals();
    }
    this.stepMs = performance.now() - t0;
  }
}

// =====================================================================
// Kingyo-sukui: scoop animated goldfish with a fragile paper poi.
// =====================================================================
export class Goldfish {
  constructor(ctx) {
    this.ctx = ctx;
    this.title = 'Kingyo-sukui 金魚すくい';
    const world = ctx.world;
    const scene = world.scene;
    buildBooth(world, { pos: L.goldfish, sign: '金魚すくい', signBg: '#1d4f91', awning: ['#2a6fc9', '#ffffff'] });

    // Tub
    const tub = new THREE.Group();
    const blue = new THREE.MeshStandardMaterial({ color: '#4aa6e8', roughness: 0.4 });
    const floorTex = canvasTexture(256, 128, (g, w, h) => {
      g.fillStyle = '#8fd0ff';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = 2;
      for (let i = 0; i < 14; i++) {
        g.beginPath();
        g.arc(Math.random() * w, Math.random() * h, 10 + Math.random() * 30, 0, 7);
        g.stroke();
      }
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(HX * 2 + 0.1, 0.05, HZ * 2 + 0.1), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6 }));
    floor.position.y = 0.12;
    tub.add(floor);
    for (const [w, d, x, z] of [[HX * 2 + 0.2, 0.08, 0, HZ + 0.06], [HX * 2 + 0.2, 0.08, 0, -HZ - 0.06], [0.08, HZ * 2 + 0.2, HX + 0.06, 0], [0.08, HZ * 2 + 0.2, -HX - 0.06, 0]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.55, d), blue);
      wall.position.set(x, 0.275, z);
      tub.add(wall);
    }
    this.water = new RippleWater(HX * 2, HZ * 2, 96);
    this.water.mesh.position.y = WATER_Y;
    tub.add(this.water.mesh);
    tub.position.copy(TUB);
    scene.add(tub);
    this.tub = tub;
    world.colliders.addRect(TUB.x, TUB.z, HX + 0.15, HZ + 0.15, 'tub');

    // Catch bowl on a stool at the corner
    this.bowlPos = new THREE.Vector3(TUB.x + HX + 0.5, 0.62, TUB.z + 0.55);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65), new THREE.MeshPhysicalMaterial({ color: '#dff4ff', transparent: true, opacity: 0.35, roughness: 0.05, side: THREE.DoubleSide }));
    bowl.position.copy(this.bowlPos).add(new THREE.Vector3(0, 0.1, 0));
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.52, 10), new THREE.MeshStandardMaterial({ color: '#7a5634' }));
    stool.position.set(this.bowlPos.x, 0.26, this.bowlPos.z);
    scene.add(bowl, stool);

    // Poi (paper scoop) with a fibrous paper texture and a torn variant.
    this.poi = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(POI_R, 0.012, 8, 28).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#ff4f8b', roughness: 0.4 }));
    const paperTex = canvasTexture(128, 128, (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(200,190,170,0.35)';
      for (let i = 0; i < 60; i++) {
        g.beginPath();
        const x = Math.random() * 128;
        const y = Math.random() * 128;
        g.moveTo(x, y);
        g.lineTo(x + rand(-20, 20), y + rand(-20, 20));
        g.stroke();
      }
    });
    this.tornAlpha = canvasTexture(128, 128, (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#000000';
      g.beginPath();
      g.moveTo(64, 64);
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.25) {
        const r = 34 + Math.random() * 26;
        g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
      }
      g.fill();
    }, { srgb: false });
    this.paperMat = new THREE.MeshStandardMaterial({ map: paperTex, transparent: true, opacity: 0.85, side: THREE.DoubleSide, roughness: 0.9 });
    this.paper = new THREE.Mesh(new THREE.CircleGeometry(POI_R, 24).rotateX(-Math.PI / 2), this.paperMat);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.22).translate(0, 0, POI_R + 0.11), ring.material);
    handle.rotation.x = -0.25;
    this.poi.add(ring, this.paper, handle);
    this.poi.visible = false;
    scene.add(this.poi);

    // Collision visualisation (toggle with V): catch radius + per-fish hit circles.
    this.debugGroup = new THREE.Group();
    this.debugGroup.visible = false;
    scene.add(this.debugGroup);
    const loop = (r, color) => {
      const pts = [];
      for (let i = 0; i <= 40; i++) pts.push(new THREE.Vector3(Math.cos((i / 40) * Math.PI * 2) * r, 0, Math.sin((i / 40) * Math.PI * 2) * r));
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    };
    this.poiRing = loop(POI_R, 0xffe04a);
    this.poiRing.renderOrder = 20;
    this.debugGroup.add(this.poiRing);
    this.loop = loop;

    this.fish = [];
    this.template = null;
    this.ready = this.loadFish().catch((err) => {
      console.warn('Goldfish model failed to load, using simple fish.', err);
      this.template = null;
    }).then(() => {
      for (let i = 0; i < 16; i++) this.addFish(i < 2 ? FISH_TYPES[3] : pick(FISH_TYPES.slice(0, 3)));
    });

    this.cameraPose = { pos: new THREE.Vector3(TUB.x, 1.62, TUB.z + 1.3), look: new THREE.Vector3(TUB.x, 0.28, TUB.z - 0.05) };
    this.interact = { id: 'goldfish', pos: new THREE.Vector3(TUB.x, 0, TUB.z + 1.8), label: 'Play Goldfish Scooping (¥300)' };
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -WATER_Y);
    this.active = false;
    this.fps = 60;
    this.fpsAcc = 0;
    this.fpsN = 0;
    this.ambientT = 0;
  }

  // ------------------------------------------------------------ fish model
  async loadFish() {
    const gltf = await new GLTFLoader().loadAsync(FISH_URL);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // Normalise: centre the fish, make its head point along +z, scale to ~17 cm.
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const tail = root.getObjectByName('goldfish2Tail3_011') || root.getObjectByName('goldfish2Tail1_09');
    const tailPos = tail ? tail.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(box.max.x, center.y, center.z);
    const head = center.clone().sub(tailPos).setY(0).normalize();
    root.position.sub(center);
    const pivot = new THREE.Group();
    pivot.add(root);
    pivot.rotation.y = -Math.atan2(head.x, head.z);
    const template = new THREE.Group();
    template.add(pivot);
    template.scale.setScalar(0.2 / Math.max(size.x, size.z));
    root.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = false;
        // Transmission forces an extra scene render pass every frame; the water already provides the look.
        o.material.transmission = 0;
        o.material.transparent = false;
      }
    });
    this.template = template;
    this.clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
    this.materials = new Map();
  }

  materialFor(type, src) {
    const key = type.name + src.uuid;
    if (!this.materials.has(key)) {
      const m = src.clone();
      m.color.multiply(new THREE.Color(type.tint));
      m.emissive = new THREE.Color(type.tint).multiplyScalar(0.06);
      this.materials.set(key, m);
    }
    return this.materials.get(key);
  }

  addFish(type = pick(FISH_TYPES)) {
    let obj;
    let mixer = null;
    let actions = null;
    if (this.template) {
      obj = SkeletonUtils.clone(this.template);
      obj.traverse((o) => {
        if (o.isMesh) o.material = this.materialFor(type, o.material);
      });
      mixer = new THREE.AnimationMixer(obj);
      const mk = (name) => (this.clips[name] ? mixer.clipAction(this.clips[name]) : null);
      actions = { slow: mk('Swim_Slow'), fast: mk('Swim_fast'), jump: mk('jump') };
      actions.slow?.play();
      if (actions.fast) {
        actions.fast.play();
        actions.fast.setEffectiveWeight(0);
      }
      mixer.update(Math.random() * 3);
    } else {
      obj = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshStandardMaterial({ color: type.tint === '#ffffff' ? '#ff6a1a' : type.tint }));
      obj.geometry.scale(0.035, 0.03, 0.085);
    }
    obj.scale.multiplyScalar(type.size);
    this.ctx.world.scene.add(obj);
    const a = rand(0, Math.PI * 2);
    const ring = this.loop(0.03 * type.size + 0.02, 0xff5a5a);
    ring.renderOrder = 20;
    this.debugGroup.add(ring);
    const f = {
      obj, mixer, actions, type, ring,
      x: rand(-HX + 0.2, HX - 0.2), z: rand(-HZ + 0.1, HZ - 0.1),
      vx: Math.sin(a) * 0.2, vz: Math.cos(a) * 0.2,
      depth: rand(0.06, 0.2), depthPhase: rand(0, 6.28),
      h: a, state: 'swim', t: 0, fastW: 0, wakeT: rand(0, 0.3),
    };
    this.fish.push(f);
    return f;
  }

  removeFish(f) {
    this.ctx.world.scene.remove(f.obj);
    this.debugGroup.remove(f.ring);
    f.ring.geometry.dispose();
    f.mixer?.stopAllAction();
    this.fish.splice(this.fish.indexOf(f), 1);
  }

  // ------------------------------------------------------------ game flow
  enter() {
    this.active = true;
    this.paperHP = 1;
    this.caught = 0;
    this.score = 0;
    this.caughtNames = [];
    this.torn = false;
    this.submerged = false;
    this.subT = 0;
    this.target = new THREE.Vector3(TUB.x, WATER_Y, TUB.z);
    this.poiPos = this.target.clone();
    this.lastPoi = this.poiPos.clone();
    this.poiSpeed = 0;
    this.poi.visible = true;
    this.paper.visible = true;
    this.paperMat.alphaMap = null;
    this.paperMat.alphaTest = 0;
    this.paperMat.needsUpdate = true;
    this.paperMat.opacity = 0.85;
    this.paperMat.color.set('#ffffff');
    this.endT = null;
    this.ctx.ui.gameHud(`
      <div class="gh-title">金魚すくい Goldfish Scooping</div>
      <div>Move the mouse to aim · <b>hold</b> to dip the poi · <b>release</b> under a shallow fish to scoop</div>
      <div class="bar"><span id="poi-hp"></span></div>
      <div>Fish: <b id="gf-count">0</b> · Score: <b id="gf-score">0</b> · Esc to leave</div>
      <div class="gf-dev"><span id="gf-stats"></span><br>
      <b>V</b> show colliders · <b>P</b> stress test: +20 fish · <b>O</b> water resolution · <b>R</b> reset stress</div>`);
    // Return previously caught fish to the water.
    for (const f of this.fish) {
      if (f.state !== 'swim') {
        f.state = 'swim';
        f.x = rand(-HX + 0.2, HX - 0.2);
        f.z = rand(-HZ + 0.1, HZ - 0.1);
        f.obj.rotation.set(0, f.h, 0);
      }
    }
    this.updateHud();
  }

  exit() {
    this.active = false;
    this.poi.visible = false;
    this.debugGroup.visible = false;
  }

  keyDown(e) {
    if (e.code === 'KeyV') this.debugGroup.visible = !this.debugGroup.visible;
    if (e.code === 'KeyP') {
      for (let i = 0; i < 20 && this.fish.length < 600; i++) this.addFish();
      this.ctx.ui.toast(`Stress test: ${this.fish.length} animated fish`);
    }
    if (e.code === 'KeyO') {
      const sizes = [64, 96, 160, 256, 384];
      const next = sizes[(sizes.indexOf(this.water.nx) + 1) % sizes.length];
      this.water.resize(next);
      this.ctx.ui.toast(`Water grid: ${this.water.nx} × ${this.water.nz} (${this.water.cells.toLocaleString()} cells)`);
    }
    if (e.code === 'KeyR') {
      while (this.fish.length > 16) this.removeFish(this.fish[this.fish.length - 1]);
      this.water.resize(96);
      this.ctx.ui.toast('Stress test reset');
    }
  }

  pointerMove(ndc) {
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.plane, hit)) {
      this.target.set(clamp(hit.x, TUB.x - HX + 0.08, TUB.x + HX - 0.08), WATER_Y, clamp(hit.z, TUB.z - HZ + 0.08, TUB.z + HZ - 0.08));
    }
  }

  pointerDown() {
    if (this.torn || !this.active) return;
    this.submerged = true;
    this.subT = 0;
    this.water.disturb(this.poiPos.x - TUB.x, this.poiPos.z - TUB.z, POI_R * 1.4, -0.03);
    sfx.splash(0.6);
  }

  // Collision test: fish whose body circle overlaps the paper disc AND who swim above the
  // paper's depth are scooped when it is lifted.
  catchable(f) {
    const d = Math.hypot(TUB.x + f.x - this.poiPos.x, TUB.z + f.z - this.poiPos.z);
    return f.state === 'swim' && d < POI_R + 0.02 * f.type.size && f.depth < CATCH_DEPTH;
  }

  pointerUp() {
    if (!this.submerged) return;
    this.submerged = false;
    this.water.disturb(this.poiPos.x - TUB.x, this.poiPos.z - TUB.z, POI_R * 1.5, 0.035);
    sfx.splash(0.4);
    if (this.subT < 0.12 || this.torn) return;
    const caughtNow = this.fish.filter((f) => this.catchable(f)).slice(0, 2);
    for (const f of caughtNow) {
      this.paperHP -= f.type.weight * (1 + this.poiSpeed * 2);
      if (this.paperHP <= 0) {
        this.tear();
        f.vx = -f.vx * 3;
        f.vz = -f.vz * 3;
        return;
      }
      f.state = 'flying';
      f.t = 0;
      f.from = new THREE.Vector3(TUB.x + f.x, WATER_Y + 0.05, TUB.z + f.z);
      if (f.actions?.jump) {
        f.actions.jump.reset().setLoop(THREE.LoopOnce, 1).fadeIn(0.1).play();
      }
      this.caught++;
      this.score += f.type.score;
      this.caughtNames.push(f.type.name);
      this.water.disturb(f.x, f.z, 0.1, 0.05);
      sfx.chime();
      emit('cheer', this.poiPos);
    }
    this.updateHud();
  }

  tear() {
    this.torn = true;
    this.submerged = false;
    this.paperMat.alphaMap = this.tornAlpha;
    this.paperMat.alphaTest = 0.5;
    this.paperMat.needsUpdate = true;
    sfx.tear();
    this.endT = 1.4;
    this.ctx.ui.toast('The paper tore! 破れた!');
  }

  updateHud() {
    const hp = document.getElementById('poi-hp');
    if (!hp) return;
    hp.style.width = `${Math.max(0, this.paperHP) * 100}%`;
    hp.style.background = this.paperHP > 0.5 ? '#7cf29a' : this.paperHP > 0.25 ? '#ffd24a' : '#ff5a5a';
    document.getElementById('gf-count').textContent = this.caught;
    document.getElementById('gf-score').textContent = this.score;
  }

  // ------------------------------------------------------------ simulation
  // Boids: separation, alignment, cohesion + wall avoidance + flee from the poi.
  steer(dt, t) {
    const fish = this.fish;
    const poiLocal = this.active ? { x: this.poiPos.x - TUB.x, z: this.poiPos.z - TUB.z } : null;
    const threat = this.active && (this.submerged || this.poiPos.y < WATER_Y + 0.05);
    for (const f of fish) {
      if (f.state !== 'swim') continue;
      let sx = 0, sz = 0, ax = 0, az = 0, cx = 0, cz = 0, n = 0;
      for (const o of fish) {
        if (o === f || o.state !== 'swim') continue;
        const dx = o.x - f.x;
        const dz = o.z - f.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.12) continue; // ~35 cm neighbourhood
        n++;
        ax += o.vx;
        az += o.vz;
        cx += dx;
        cz += dz;
        if (d2 < 0.018 && d2 > 1e-6) {
          sx -= dx / d2;
          sz -= dz / d2;
        }
      }
      let fx = sx * 0.004;
      let fz = sz * 0.004;
      if (n) {
        fx += (ax / n - f.vx) * 0.8 + (cx / n) * 0.6;
        fz += (az / n - f.vz) * 0.8 + (cz / n) * 0.6;
      }
      // Wander
      const wa = t * 0.6 + f.depthPhase * 3;
      fx += Math.sin(wa) * 0.12;
      fz += Math.cos(wa * 1.3) * 0.12;
      // Walls
      const mx = HX - 0.22;
      const mz = HZ - 0.14;
      if (f.x > mx) fx -= (f.x - mx) * 12;
      if (f.x < -mx) fx -= (f.x + mx) * 12;
      if (f.z > mz) fz -= (f.z - mz) * 14;
      if (f.z < -mz) fz -= (f.z + mz) * 14;
      // Flee
      let flee = 0;
      if (poiLocal && threat) {
        const dx = f.x - poiLocal.x;
        const dz = f.z - poiLocal.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.42 && d > 1e-4) {
          flee = (0.42 - d) / 0.42;
          const k = (2 + this.poiSpeed * 6) * flee;
          fx += (dx / d) * k;
          fz += (dz / d) * k;
        }
      }
      f.vx += fx * dt;
      f.vz += fz * dt;
      const sp = Math.hypot(f.vx, f.vz);
      const maxS = 0.3 + flee * 0.7;
      const minS = 0.08;
      const s = Math.min(maxS, Math.max(minS, sp));
      if (sp > 1e-5) {
        f.vx *= s / sp;
        f.vz *= s / sp;
      }
      f.speed = s;
      f.flee = flee;
      f.x = clamp(f.x + f.vx * dt, -HX + 0.05, HX - 0.05);
      f.z = clamp(f.z + f.vz * dt, -HZ + 0.05, HZ - 0.05);
      // Depth: drift between surface and bottom; frightened fish dive.
      const targetDepth = flee > 0.1 ? 0.21 : 0.12 + Math.sin(t * 0.35 + f.depthPhase) * 0.08;
      f.depth = damp(f.depth, targetDepth, flee > 0.1 ? 4 : 0.8, dt);
      // Shallow swimmers leave a wake on the height field.
      f.wakeT -= dt;
      if (f.depth < 0.09 && f.wakeT <= 0) {
        f.wakeT = 0.18;
        this.water.disturb(f.x, f.z, 0.05, 0.004 + s * 0.01);
      }
    }
  }

  // Runs every frame so the fish swim even when nobody is playing.
  update(dt, t) {
    const near = G.player.pos.distanceTo(TUB) < 18 || this.active;
    if (!near) return;
    // Passers-by only glance at the tub: simulate it at half rate unless the game is being played.
    this.half = !this.half;
    if (!this.active && this.half) {
      this.skipped = dt;
      return;
    }
    if (!this.active && this.skipped) {
      dt += this.skipped;
      this.skipped = 0;
    }

    this.steer(dt, t);
    for (const f of this.fish) {
      const o = f.obj;
      if (f.state === 'swim') {
        f.h = angleDamp(f.h, Math.atan2(f.vx, f.vz), 6, dt);
        o.position.set(TUB.x + f.x, WATER_Y - f.depth, TUB.z + f.z);
        o.rotation.set(0, f.h, 0);
        // Blend slow/fast swim cycles by speed; play rate follows speed.
        f.fastW = damp(f.fastW, f.speed > 0.36 ? 1 : 0, 6, dt);
        if (f.actions?.fast) {
          f.actions.fast.setEffectiveWeight(f.fastW);
          f.actions.slow.setEffectiveWeight(1 - f.fastW);
        }
        if (f.mixer) f.mixer.timeScale = 0.6 + f.speed * 2.2;
      } else if (f.state === 'flying') {
        f.t += dt / 0.8;
        const k = Math.min(1, f.t);
        o.position.lerpVectors(f.from, this.bowlPos, k);
        o.position.y += Math.sin(k * Math.PI) * 0.45;
        o.rotation.set(-Math.sin(k * Math.PI) * 0.8, f.h + k * 3, 0);
        if (f.mixer) f.mixer.timeScale = 1.6;
        if (k >= 1) {
          f.state = 'bowl';
          f.a = rand(0, 6.28);
          f.actions?.jump?.fadeOut(0.2);
        }
      } else {
        f.a += dt * 1.2;
        o.position.set(this.bowlPos.x + Math.cos(f.a) * 0.06, this.bowlPos.y + 0.06, this.bowlPos.z + Math.sin(f.a) * 0.06);
        o.rotation.set(0, -f.a, 0);
        if (f.mixer) f.mixer.timeScale = 0.7;
      }
      f.mixer?.update(dt);
      if (this.debugGroup.visible) {
        f.ring.visible = f.state === 'swim';
        f.ring.position.copy(o.position);
        f.ring.material.color.set(this.active && this.catchable(f) ? 0x5aff8a : f.depth < CATCH_DEPTH ? 0xffffff : 0xff5a5a);
      }
    }

    // Gentle ambient ripples so the surface never looks frozen.
    this.ambientT -= dt;
    if (this.ambientT <= 0) {
      this.ambientT = rand(0.4, 1.2);
      this.water.disturb(rand(-HX, HX), rand(-HZ, HZ), 0.06, 0.004);
    }
    this.water.update(dt);

    if (!this.active) return;
    // Poi follows the mouse; moving it fast while submerged weakens the paper (water drag)
    // and drags a wake through the height field.
    this.lastPoi.copy(this.poiPos);
    this.poiPos.x = damp(this.poiPos.x, this.target.x, 14, dt);
    this.poiPos.z = damp(this.poiPos.z, this.target.z, 14, dt);
    this.poiSpeed = this.lastPoi.distanceTo(this.poiPos) / Math.max(dt, 1e-3);
    const y = this.submerged ? WATER_Y - 0.07 : WATER_Y + 0.12;
    this.poiPos.y = damp(this.poiPos.y, y, 16, dt);
    this.poi.position.copy(this.poiPos);
    this.poi.rotation.z = (this.target.x - this.poiPos.x) * -2;
    this.poiRing.position.set(this.poiPos.x, WATER_Y + 0.012, this.poiPos.z);
    if (this.submerged && !this.torn) {
      this.subT += dt;
      if (this.poiSpeed > 0.05) this.water.disturb(this.poiPos.x - TUB.x, this.poiPos.z - TUB.z, POI_R, -this.poiSpeed * 0.006);
      this.paperHP -= dt * (0.035 + this.poiSpeed * 0.28);
      this.paperMat.opacity = 0.35 + 0.5 * this.paperHP;
      this.paperMat.color.setScalar(0.75 + 0.25 * this.paperHP);
      if (this.paperHP <= 0) this.tear();
      this.updateHud();
    }

    // Live performance readout for the stress test.
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
      const el = document.getElementById('gf-stats');
      if (el) el.textContent = `${this.fps} FPS · ${this.fish.length} animated fish · water ${this.water.nx}×${this.water.nz} grid · sim ${this.water.stepMs.toFixed(2)} ms/frame`;
    }

    if (this.endT !== null) {
      this.endT -= dt;
      if (this.endT <= 0) {
        this.endT = null;
        const success = this.caught > 0;
        const reward = this.score * 150;
        if (success) {
          G.coins += reward;
          G.prizes.push(`Goldfish ×${this.caught}`);
        }
        this.ctx.finish('goldfish', success, `
          <h2>${success ? '🎏 Nice scooping!' : '💧 No luck this time'}</h2>
          <p>Goldfish caught: <b>${this.caught}</b>${this.caughtNames.length ? ` (${this.caughtNames.join(', ')})` : ''} · Score: <b>${this.score}</b></p>
          ${success ? `<p>Reward: <b>¥${reward}</b> and a bag of goldfish 🎏</p>` : ''}
          <p class="muted">Fish are scooped only if their body circle overlaps the paper disc and they swim above its depth when you lift it.
          The paper weakens with water drag, so fast moves tear it sooner. The water is a real-time wave simulation.</p>
          ${success ? '<p>🎆 Unlocked: <b>Kingyo glitter</b> firework pattern</p>' : ''}`);
      }
    }
  }
}
