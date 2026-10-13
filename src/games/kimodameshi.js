import * as THREE from 'three';
import { KIMO_PATH, L } from '../layout.js';
import { G } from '../state.js';
import { sfx } from '../audio.js';
import { canvasTexture, damp, glowTexture, rand, signTexture } from '../util.js';

// Kimodameshi (test of courage): a free-roam quest on the dark forest loop.
export class Kimodameshi {
  constructor(ctx) {
    this.ctx = ctx;
    const world = ctx.world;
    const scene = world.scene;
    this.curve = new THREE.CatmullRomCurve3(KIMO_PATH.map((p) => p.clone()), false, 'centripetal');

    // Dirt path ribbon
    const N = 160;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(1.15);
      pos.push(p.x + side.x, -0.06, p.z + side.z, p.x - side.x, -0.06, p.z - side.z);
      uv.push(0, t * 40, 1, t * 40);
      if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const dirt = canvasTexture(64, 64, (g) => {
      g.fillStyle = '#5a4632';
      g.fillRect(0, 0, 64, 64);
      for (let i = 0; i < 300; i++) {
        g.fillStyle = `rgba(${rand(30, 90)},${rand(25, 70)},${rand(15, 50)},0.6)`;
        g.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
      }
    });
    dirt.wrapS = dirt.wrapT = THREE.RepeatWrapping;
    const ribbon = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: dirt, roughness: 1, side: THREE.DoubleSide }));
    ribbon.receiveShadow = true;
    scene.add(ribbon);

    // Small torii gates along the route and stone lanterns.
    for (const t of [0.05, 0.42, 0.8]) {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      world.buildTorii(p, 0.62, Math.atan2(-tan.z, tan.x));
    }
    for (const t of [0.16, 0.3, 0.52, 0.66, 0.9]) {
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize().multiplyScalar(1.7);
      world.makeStoneLantern(p.x + side.x, p.z + side.z);
    }
    // Entrance sign
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshStandardMaterial({ map: signTexture('肝試し', { bg: '#15121a', fg: '#e8e0ff', font: 72 }) }));
    sign.position.set(L.kimoEntrance.x + 1.6, 1.6, L.kimoEntrance.z - 0.4);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), new THREE.MeshStandardMaterial({ color: '#3a2a1a' }));
    post.position.set(L.kimoEntrance.x + 1.6, 0.8, L.kimoEntrance.z - 0.45);
    scene.add(sign, post);

    // Courage seals (ofuda)
    const sealTex = canvasTexture(64, 128, (g) => {
      g.fillStyle = '#f7f0dc';
      g.fillRect(0, 0, 64, 128);
      g.strokeStyle = '#b3202a';
      g.lineWidth = 4;
      g.strokeRect(5, 5, 54, 118);
      g.fillStyle = '#b3202a';
      g.font = 'bold 44px "Yu Gothic", serif';
      g.textAlign = 'center';
      g.fillText('勇', 32, 60);
      g.font = 'bold 22px serif';
      g.fillText('符', 32, 100);
    });
    const sealMat = new THREE.MeshStandardMaterial({ map: sealTex, emissive: '#ffe0a0', emissiveMap: sealTex, emissiveIntensity: 1.4, side: THREE.DoubleSide });
    this.seals = [0.2, 0.37, 0.58, 0.74, 0.93].map((t, i) => {
      const p = this.curve.getPointAt(t);
      const g = new THREE.Group();
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.56), sealMat);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffcf70', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.scale.setScalar(1.3);
      g.add(card, halo);
      g.position.set(p.x + rand(-0.5, 0.5), 1.3, p.z + rand(-0.5, 0.5));
      g.visible = false;
      scene.add(g);
      return { g, taken: false, phase: i };
    });

    // Yurei ghost
    this.ghost = this.makeGhost();
    this.ghost.visible = false;
    scene.add(this.ghost);
    // Hitodama (will-o'-wisps)
    this.wisps = [0, 1, 2].map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#6ad8ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
      s.scale.setScalar(0.6);
      s.visible = false;
      scene.add(s);
      return s;
    });

    // Player's hand lantern (only lit in the forest)
    this.handLight = new THREE.PointLight(0xffa860, 0, 11, 2);
    ctx.camera.add(this.handLight);
    this.handLight.position.set(0.25, -0.35, -0.3);
    this.eerie = world.addLight(this.curve.getPointAt(0.55).setY(2.2), { color: 0x6a8cff, base: 5, distance: 12, flicker: 0.4 });

    this.active = false;
    this.done = false;
    this.scares = [
      { at: 0.24, fired: false, fn: () => this.scareGlide() },
      { at: 0.5, fired: false, fn: () => this.scareDarkness() },
      { at: 0.76, fired: false, fn: () => this.scareRush() },
    ];
    this.interact = { id: 'kimodameshi', pos: L.kimoEntrance.clone(), label: 'Begin Kimodameshi — Test of Courage', radius: 2.4 };
    this.anim = null;
    this.flicker = 0;
    // Precompute samples for nearest-parameter lookups.
    this.samples = Array.from({ length: 200 }, (_, i) => this.curve.getPointAt(i / 199));
  }

  makeGhost() {
    const g = new THREE.Group();
    const robe = new THREE.MeshStandardMaterial({ color: '#e8f0ff', emissive: '#9fb8ff', emissiveIntensity: 0.6, transparent: true, opacity: 0.8, depthWrite: false });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.5, 14, 1, true).rotateX(Math.PI), robe);
    body.position.y = 1.0;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), new THREE.MeshStandardMaterial({ color: '#dfe8f5', emissive: '#8fa8d0', emissiveIntensity: 0.4 }));
    head.position.y = 1.85;
    const hairMat = new THREE.MeshStandardMaterial({ color: '#050505', side: THREE.DoubleSide });
    const hair = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.9, 14, 1, true, Math.PI * 0.15, Math.PI * 1.7), hairMat);
    hair.position.y = 1.6;
    hair.rotation.y = Math.PI;
    const armGeo = new THREE.CylinderGeometry(0.04, 0.06, 0.5, 8).rotateX(Math.PI / 2).translate(0, 0, 0.25);
    for (const x of [-0.2, 0.2]) {
      const a = new THREE.Mesh(armGeo, robe);
      a.position.set(x, 1.5, 0.05);
      a.rotation.x = 0.25;
      g.add(a);
    }
    g.add(body, head, hair);
    return g;
  }

  start() {
    this.active = true;
    this.collected = 0;
    this.seals.forEach((s) => {
      s.taken = false;
      s.g.visible = true;
    });
    this.scares.forEach((s) => (s.fired = false));
    this.ctx.ui.toast('👻 Follow the dark path and collect 5 courage seals (勇).');
    this.ctx.ui.quest('👻 Courage seals: 0 / 5');
  }

  nearestT(p) {
    let best = 0;
    let bd = 1e9;
    for (let i = 0; i < this.samples.length; i++) {
      const d = this.samples[i].distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return { t: best / (this.samples.length - 1), d: Math.sqrt(bd) };
  }

  forward(dist) {
    const cam = this.ctx.camera;
    const f = new THREE.Vector3();
    cam.getWorldDirection(f);
    f.y = 0;
    f.normalize();
    return G.player.pos.clone().addScaledVector(f, dist);
  }

  scareGlide() {
    const cam = this.ctx.camera;
    const f = new THREE.Vector3();
    cam.getWorldDirection(f);
    f.y = 0;
    f.normalize();
    const right = new THREE.Vector3(-f.z, 0, f.x);
    const center = this.forward(9);
    this.anim = { kind: 'glide', t: 0, dur: 2.6, from: center.clone().addScaledVector(right, -7), to: center.clone().addScaledVector(right, 7) };
    this.ghost.visible = true;
    sfx.whisper();
  }

  scareDarkness() {
    this.flicker = 3.5;
    sfx.whisper();
    this.wispT = 7;
    this.wisps.forEach((w) => (w.visible = true));
  }

  scareRush() {
    this.anim = { kind: 'wait', t: 0, at: this.forward(8) };
    this.ghost.visible = true;
    this.ghost.position.copy(this.anim.at);
  }

  update(dt, t) {
    const world = this.ctx.world;
    // Hand lantern follows forest darkness
    const hand = world.forest * (this.flicker > 0 ? (Math.random() < 0.3 ? 1 : 0.05) : 1);
    this.handLight.intensity = hand * 2.2;
    this.flicker = Math.max(0, this.flicker - dt);

    for (const s of this.seals) {
      if (!s.g.visible) continue;
      s.g.rotation.y += dt * 1.5;
      s.g.position.y = 1.3 + Math.sin(t * 2 + s.phase) * 0.12;
    }
    if (this.wispT > 0) {
      this.wispT -= dt;
      this.wisps.forEach((w, i) => {
        const a = t * 1.3 + (i * Math.PI * 2) / 3;
        w.position.set(G.player.pos.x + Math.cos(a) * 2.5, 1.7 + Math.sin(t * 3 + i) * 0.3, G.player.pos.z + Math.sin(a) * 2.5);
        w.material.opacity = Math.min(1, this.wispT) * (0.7 + Math.random() * 0.3);
      });
      if (this.wispT <= 0) this.wisps.forEach((w) => (w.visible = false));
    }

    // Ghost animations
    const A = this.anim;
    if (A) {
      A.t += dt;
      const gh = this.ghost;
      if (A.kind === 'glide') {
        const k = A.t / A.dur;
        gh.position.lerpVectors(A.from, A.to, k);
        gh.position.y = 0.2 + Math.sin(t * 3) * 0.1;
        gh.lookAt(G.player.pos.x, gh.position.y, G.player.pos.z);
        gh.children.forEach((c) => c.material && (c.material.opacity = Math.sin(k * Math.PI) * 0.8));
        if (k >= 1) {
          gh.visible = false;
          this.anim = null;
        }
      } else if (A.kind === 'wait') {
        gh.position.y = 0.2 + Math.sin(t * 2) * 0.08;
        gh.lookAt(G.player.pos.x, gh.position.y, G.player.pos.z);
        gh.children.forEach((c) => c.material && (c.material.opacity = 0.8));
        if (gh.position.distanceTo(G.player.pos.clone().setY(gh.position.y)) < 5 || A.t > 6) {
          this.anim = { kind: 'rush', t: 0 };
          sfx.scare();
        }
      } else if (A.kind === 'rush') {
        const cam = this.ctx.camera;
        const target = cam.position.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(0.55));
        target.y -= 1.75;
        gh.position.lerp(target, 1 - Math.exp(-12 * dt));
        gh.lookAt(cam.position.x, gh.position.y, cam.position.z);
        if (A.t > 0.25 && !A.flashed) {
          A.flashed = true;
          this.ctx.ui.flash();
          G.player.shake = 1;
        }
        if (A.t > 1.1) {
          gh.visible = false;
          this.anim = null;
        }
      }
    }

    if (!this.active) return;
    const pp = G.player.pos;
    for (const s of this.seals) {
      if (s.taken) continue;
      if (Math.hypot(s.g.position.x - pp.x, s.g.position.z - pp.z) < 1.3) {
        s.taken = true;
        s.g.visible = false;
        this.collected++;
        sfx.chime();
        this.ctx.ui.toast(`勇 Courage seal ${this.collected} / 5`);
        this.ctx.ui.quest(`👻 Courage seals: ${this.collected} / 5`);
      }
    }
    const { t: pt, d } = this.nearestT(pp);
    if (d < 4) {
      for (const s of this.scares) {
        if (!s.fired && pt > s.at) {
          s.fired = true;
          s.fn();
        }
      }
    }
    if (pt > 0.97 && d < 3) {
      if (this.collected >= 5) {
        this.active = false;
        this.ctx.ui.quest('');
        this.ctx.finish('kimodameshi', true, `
          <h2>👻 Courage proven! 勇気</h2>
          <p>You walked the haunted path and collected all 5 courage seals.</p>
          <p class="muted">Rendering: the forest drives fog density, hemisphere and sun light down and switches on your hand lantern, so the same lighting rig produces a contrasting night scene.</p>
          <p>🎆 Unlocked: <b>Ghost willow</b> firework pattern</p>`, { noCamera: true });
      } else if (!this.warned) {
        this.warned = true;
        this.ctx.ui.toast(`You still need ${5 - this.collected} more seal(s)… go back into the forest.`);
        setTimeout(() => (this.warned = false), 6000);
      }
    }
  }
}
