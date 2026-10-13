import * as THREE from 'three';
import { G, emit } from './state.js';
import { L } from './layout.js';
import { pick, rand } from './util.js';
import { sfx } from './audio.js';

const GRAV = 9.8;

// GPU point sprites whose motion is integrated on the CPU:
// launch velocity, gravity, aerodynamic drag, fading, trails and splitting stars.
class ParticlePool {
  constructor(max, blending) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.flags = new Uint8Array(max);
    this.alpha0 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute vec4 color;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          float core = smoothstep(0.22, 0.0, d);
          gl_FragColor = vec4(vColor.rgb * (1.0 + core * 1.5), vColor.a * a);
        }`,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  spawn(p, v, { life = 2, size = 0.5, drag = 1, grav = 1, c0, c1 = c0, flags = 0, alpha = 1 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x;
    this.vel[i3 + 1] = v.y;
    this.vel[i3 + 2] = v.z;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.flags[i] = flags;
    this.alpha0[i] = alpha;
    this.c0[i3] = c0.r;
    this.c0[i3 + 1] = c0.g;
    this.c0[i3 + 2] = c0.b;
    this.c1[i3] = c1.r;
    this.c1[i3 + 1] = c1.g;
    this.c1[i3 + 2] = c1.b;
    return i;
  }

  update(dt, onDeath, onTrail) {
    const { pos, vel, col, size } = this;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      const i4 = i * 4;
      if (this.life[i] <= 0) {
        size[i] = 0;
        col[i4 + 3] = 0;
        if (this.flags[i] & 2) onDeath?.(i);
        continue;
      }
      vel[i3 + 1] -= GRAV * this.grav[i] * dt;
      const k = Math.exp(-this.drag[i] * dt);
      vel[i3] *= k;
      vel[i3 + 1] *= k;
      vel[i3 + 2] *= k;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i]; // 1 -> 0
      col[i4] = this.c1[i3] + (this.c0[i3] - this.c1[i3]) * f;
      col[i4 + 1] = this.c1[i3 + 1] + (this.c0[i3 + 1] - this.c1[i3 + 1]) * f;
      col[i4 + 2] = this.c1[i3 + 2] + (this.c0[i3 + 2] - this.c1[i3 + 2]) * f;
      let a = this.alpha0[i] * Math.min(1, f * 2.5);
      if (this.flags[i] & 8) a *= Math.min(1, (1 - f) * 4); // smoke fades in
      if (this.flags[i] & 4 && Math.random() < 0.45) a *= 0.15; // glitter twinkle
      col[i4 + 3] = a;
      size[i] = this.size0[i] * (this.flags[i] & 8 ? 1.6 - f * 0.6 : 0.55 + 0.45 * f);
      if (this.flags[i] & 1 && Math.random() < 0.3) onTrail?.(i);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.color.needsUpdate = true;
    a.size.needsUpdate = true;
  }
}

const hdr = (hex, k = 3) => new THREE.Color(hex).multiplyScalar(k);
const PALETTE = ['#ff4040', '#ffd24a', '#4ad2ff', '#7cff6a', '#ff6ad5', '#b07cff', '#ffffff', '#ff9a3a'];

// Firework patterns unlocked by completing activities.
export const PATTERN_UNLOCKS = {
  goldfish: { pattern: 'kingyo', label: 'Kingyo (goldfish) glitter' },
  shateki: { pattern: 'crossette', label: 'Crossette splits' },
  taiko: { pattern: 'taikoRing', label: 'Taiko double rings' },
  kimodameshi: { pattern: 'ghost', label: 'Ghost willow' },
  shrine: { pattern: 'sakura', label: 'Sakura blossoms' },
};

export class Fireworks {
  constructor(scene, camera) {
    this.camera = camera;
    this.stars = new ParticlePool(26000, THREE.AdditiveBlending);
    this.smoke = new ParticlePool(1500, THREE.NormalBlending);
    scene.add(this.stars.points, this.smoke.points);
    this.shells = [];
    this.show = null;
    this.flash = new THREE.PointLight(0xffffff, 0, 0, 2);
    scene.add(this.flash);
    this.flashI = 0;
    this.onShowEnd = null;
    this._v = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  resize(height, fov) {
    const s = height / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    this.stars.material.uniforms.uScale.value = s;
    this.smoke.material.uniforms.uScale.value = s;
  }

  availablePatterns() {
    const list = ['peony', 'chrysanthemum', 'peony'];
    for (const [k, u] of Object.entries(PATTERN_UNLOCKS)) if (G.done[k]) list.push(u.pattern, u.pattern);
    return list;
  }

  launch(pattern = pick(this.availablePatterns()), big = false) {
    const o = L.fireworksLaunch;
    const p = new THREE.Vector3(o.x + rand(-18, 18), 0, o.z + rand(-6, 6));
    const target = L.fireworksCenter;
    const height = target.y + rand(-8, 10) + (big ? 8 : 0);
    const fuse = rand(2.1, 2.6);
    // Choose launch speed so the shell reaches `height` at the end of its fuse (with light drag).
    const vy = (height + 0.5 * GRAV * fuse * fuse) / fuse;
    const v = new THREE.Vector3((target.x - p.x) / fuse * 0.5 + rand(-2, 2), vy, (target.z - p.z) / fuse * 0.6 + rand(-2, 2));
    this.shells.push({ p, v, fuse, pattern, big });
    sfx.whistle();
  }

  startShow(onEnd) {
    if (this.show) {
      this.launch();
      return;
    }
    const q = [];
    let t = 0.5;
    for (let i = 0; i < 18; i++) {
      q.push({ t, big: false });
      t += rand(0.7, 1.5);
    }
    t += 1.5;
    for (let i = 0; i < 16; i++) q.push({ t: t + i * 0.28, big: i % 3 === 0 });
    this.show = { t: 0, q, end: t + 16 * 0.28 + 6 };
    this.onShowEnd = onEnd;
    G.fireworksActive = true;
  }

  burst(s) {
    const P = s.p;
    const dist = this.camera.position.distanceTo(P);
    const stars = this.stars;
    const scale = s.big ? 1.35 : 1;
    const c = hdr(pick(PALETTE));
    const fadeTo = hdr('#ff5a1a', 1.2);
    const dir = this._v;
    const sphere = (n, speed, opt) => {
      for (let i = 0; i < n; i++) {
        dir.randomDirection().multiplyScalar(speed * scale * rand(0.92, 1.08));
        stars.spawn(P, dir, opt);
      }
    };
    const ring = (n, speed, normal, opt) => {
      const u = new THREE.Vector3().randomDirection().cross(normal).normalize();
      const w = normal.clone().cross(u);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        dir.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a)).multiplyScalar(speed * scale);
        stars.spawn(P, dir, opt);
      }
    };
    let crackle = false;
    switch (s.pattern) {
      case 'chrysanthemum':
        sphere(190, 14, { life: rand(1.8, 2.3), size: 0.55, drag: 1.3, grav: 0.8, c0: c, c1: fadeTo, flags: 1 });
        break;
      case 'kingyo':
        sphere(120, 15, { life: 2, size: 0.6, drag: 1.4, c0: hdr('#ff6a1a'), c1: hdr('#ff2a1a', 1.2) });
        sphere(90, 13, { life: 2.2, size: 0.5, drag: 1.4, c0: hdr('#ffffff', 2.5), c1: hdr('#ffb080', 1), flags: 4 });
        sphere(60, 7, { life: 2.4, size: 0.45, drag: 1.2, c0: hdr('#ffd24a'), c1: hdr('#ff6a1a', 1), flags: 4 });
        crackle = true;
        break;
      case 'crossette':
        sphere(14, 11, { life: 0.9, size: 0.9, drag: 0.9, c0: c, flags: 2 | 1 });
        crackle = true;
        break;
      case 'taikoRing': {
        const n = new THREE.Vector3(rand(-0.3, 0.3), 1, rand(-0.3, 0.3)).normalize();
        ring(120, 16, n, { life: 2, size: 0.6, drag: 1.3, c0: hdr('#ffd24a'), c1: fadeTo });
        ring(90, 10, new THREE.Vector3(0, 0.2, 1).normalize(), { life: 2, size: 0.55, drag: 1.3, c0: hdr('#ff3030'), c1: fadeTo });
        sphere(40, 3, { life: 1.4, size: 0.5, drag: 1.5, c0: hdr('#ffffff'), flags: 4 });
        break;
      }
      case 'ghost':
        sphere(170, 9, { life: rand(3.6, 4.4), size: 0.5, drag: 0.7, grav: 1, c0: hdr('#b8e0ff', 2.5), c1: hdr('#3050ff', 0.5), flags: 1 | 4 });
        break;
      case 'sakura':
        sphere(200, 13, { life: 2.3, size: 0.6, drag: 1.3, c0: hdr('#ff9ec4'), c1: hdr('#ff5a90', 1) });
        sphere(60, 6, { life: 2, size: 0.55, drag: 1.3, c0: hdr('#ffffff', 2.5), c1: hdr('#ffd0e0', 1) });
        break;
      case 'willow':
        sphere(170, 9, { life: 4, size: 0.5, drag: 0.7, c0: hdr('#ffc060', 2.5), c1: hdr('#803000', 0.4), flags: 1 });
        break;
      default: // peony
        sphere(240, 15, { life: rand(1.6, 2.1), size: 0.6, drag: 1.4, c0: c, c1: fadeTo });
        sphere(40, 5, { life: 1.4, size: 0.5, drag: 1.5, c0: hdr('#ffffff'), flags: 4 });
    }
    // Smoke puffs
    for (let i = 0; i < 10; i++) {
      dir.randomDirection().multiplyScalar(rand(1, 3));
      this.smoke.spawn(P, dir, { life: rand(5, 8), size: rand(6, 11) * scale, drag: 0.6, grav: -0.02, c0: new THREE.Color(0.18, 0.18, 0.2), c1: new THREE.Color(0.1, 0.1, 0.12), alpha: 0.22, flags: 8 });
    }
    // Burst light illuminates the festival below.
    this.flash.position.copy(P);
    this.flash.color.copy(c).multiplyScalar(1 / 3);
    this.flashI = (s.big ? 9000 : 6000) * scale;
    sfx.boom(dist, s.big ? 1 : 0.75);
    if (crackle) sfx.crackle(dist);
    if (Math.random() < 0.4 || s.big) emit('cheer', L.viewing);
  }

  update(dt) {
    // Scheduled show
    if (this.show) {
      const sh = this.show;
      sh.t += dt;
      while (sh.q.length && sh.q[0].t <= sh.t) {
        const e = sh.q.shift();
        this.launch(undefined, e.big);
      }
      if (sh.t > sh.end) {
        this.show = null;
        G.fireworksActive = false;
        this.onShowEnd?.();
      }
    }
    // Shells rising
    const trailCol = hdr('#ffb050', 1.5);
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.v.y -= GRAV * dt;
      s.v.multiplyScalar(Math.exp(-0.02 * dt));
      s.p.addScaledVector(s.v, dt);
      for (let k = 0; k < 2; k++) {
        this._v.set(rand(-0.6, 0.6), rand(-2, -0.5), rand(-0.6, 0.6));
        this.stars.spawn(s.p, this._v, { life: rand(0.3, 0.6), size: 0.35, drag: 2, grav: 0.3, c0: trailCol, c1: hdr('#ff3000', 0.5) });
      }
      s.fuse -= dt;
      if (s.fuse <= 0) {
        this.burst(s);
        this.shells.splice(i, 1);
      }
    }
    const st = this.stars;
    const p = this._p;
    const v = this._v;
    st.update(
      dt,
      (i) => {
        // Crossette: each star splits into four.
        p.fromArray(st.pos, i * 3);
        const col = new THREE.Color(st.c0[i * 3], st.c0[i * 3 + 1], st.c0[i * 3 + 2]);
        for (let k = 0; k < 4; k++) {
          v.fromArray(st.vel, i * 3).multiplyScalar(0.3);
          const a = (k / 4) * Math.PI * 2 + rand(0, 0.5);
          v.x += Math.cos(a) * 7;
          v.z += Math.sin(a) * 7;
          v.y += rand(-2, 2);
          st.spawn(p, v, { life: 1.3, size: 0.5, drag: 1.3, c0: col, c1: hdr('#ffffff', 1), flags: 4 });
        }
      },
      (i) => {
        p.fromArray(st.pos, i * 3);
        v.set(rand(-0.3, 0.3), rand(-0.6, 0), rand(-0.3, 0.3));
        const k = 0.5;
        st.spawn(p, v, { life: rand(0.4, 0.9), size: 0.28, drag: 2, grav: 0.4, c0: new THREE.Color(st.c0[i * 3] * k, st.c0[i * 3 + 1] * k, st.c0[i * 3 + 2] * k), c1: hdr('#ff4000', 0.3) });
      },
    );
    this.smoke.update(dt);
    this.flashI *= Math.exp(-7 * dt);
    this.flash.intensity = this.flashI;
  }
}
