import * as THREE from 'three';
import { G } from '../state.js';
import { angleDamp, glowTexture } from '../util.js';

// Onibi spirits for the Test of Courage: wisps that patrol sections of the haunted path.
// Each one sees with distance + field of view + line of sight, where the line of sight is a 2D
// segment test against the forest's tree trunks (the same circle colliders the player collides with),
// so hiding behind a tree really works. Crouching shrinks their sight range. Being seen fills a
// suspicion meter; when full the player is caught and sent back to the last checkpoint.
const RANGE = 7;
const FOV = 80; // degrees
// Patrol sections sit between the courage seals (t = 0.2, 0.37, 0.58, 0.74, 0.93), which are checkpoints.
const DEF = [
  { a: 0.25, b: 0.33, speed: 1.0 },
  { a: 0.43, b: 0.53, speed: 1.2 },
  { a: 0.63, b: 0.7, speed: 1.1 },
  { a: 0.8, b: 0.88, speed: 1.2 },
];

export class SpiritPatrol {
  constructor(ctx, curve) {
    this.ctx = ctx;
    this.curve = curve;
    this.len = curve.getLength();
    this.active = false;
    this.spirits = [];
    const scene = ctx.world.scene;
    const coneMat = new THREE.MeshBasicMaterial({ color: 0x6ab8ff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const half = THREE.MathUtils.degToRad(FOV / 2);
    for (const d of DEF) {
      const g = new THREE.Group();
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#7ac8ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.scale.setScalar(0.9);
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#e8f6ff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      core.scale.setScalar(0.3);
      const body = new THREE.Group();
      body.position.y = 1.5;
      body.add(flame, core);
      // Kasa-obake model (one-legged umbrella yōkai) when available; the wisp becomes its eerie glow.
      let model = null;
      if (ctx.spirits?.kasa) {
        model = ctx.spirits.kasa.scene.clone();
        g.add(model);
        flame.scale.setScalar(0.55);
        core.scale.setScalar(0.18);
        body.position.y = 1.15;
      }
      const cone = new THREE.Mesh(new THREE.CircleGeometry(RANGE, 28, Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2), coneMat.clone());
      cone.position.y = 0.04;
      g.add(body, cone);
      g.visible = false;
      scene.add(g);
      this.spirits.push({ ...d, g, body, flame, cone, model, t: d.a + Math.random() * (d.b - d.a), dir: 1, heading: 0, pause: 0, look: 0, sus: 0, seen: false });
    }
    this.light = ctx.world.addLight(new THREE.Vector3(0, -50, 0), { color: 0x6ab8ff, base: 4, distance: 9, flicker: 0.3 });
    this.trees = null;
  }

  start(onCaught) {
    this.onCaught = onCaught;
    this.active = true;
    this.caughtCount = 0;
    // Tree trunks near the path are the sight blockers.
    if (!this.trees) {
      const pts = Array.from({ length: 60 }, (_, i) => this.curve.getPointAt(i / 59));
      this.trees = this.ctx.world.colliders.circles.filter((c) => pts.some((p) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 144));
    }
    for (const s of this.spirits) {
      s.g.visible = true;
      s.sus = 0;
    }
  }

  stop() {
    this.active = false;
    for (const s of this.spirits) s.g.visible = false;
    this.light.pos.set(0, -50, 0);
  }

  // Line of sight in the ground plane: blocked if the segment passes through a tree trunk.
  clear(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const L2 = dx * dx + dz * dz || 1;
    for (const c of this.trees) {
      const u = Math.max(0, Math.min(1, ((c.x - ax) * dx + (c.z - az) * dz) / L2));
      const px = ax + dx * u - c.x;
      const pz = az + dz * u - c.z;
      if (px * px + pz * pz < (c.r + 0.05) ** 2 && u > 0.02 && u < 0.98) return false;
    }
    return true;
  }

  update(dt, t) {
    if (!this.active) return;
    const P = G.player;
    this.grace = Math.max(0, (this.grace || 0) - dt);
    let nearest = null;
    let nd = 1e9;
    for (const s of this.spirits) {
      // Patrol back and forth along its section of the path, pausing to look around at each end.
      if (s.pause > 0) {
        s.pause -= dt;
        s.look += dt;
      } else {
        s.t += (s.dir * s.speed * dt) / this.len;
        if (s.t > s.b || s.t < s.a) {
          s.t = Math.max(s.a, Math.min(s.b, s.t));
          s.dir *= -1;
          s.pause = 1.8;
          s.look = 0;
        }
      }
      const p = this.curve.getPointAt(s.t);
      const tan = this.curve.getTangentAt(s.t).multiplyScalar(s.dir);
      const base = Math.atan2(tan.x, tan.z);
      const target = s.pause > 0 ? base + Math.sin(s.look * 2.2) * 1.2 : base;
      s.heading = angleDamp(s.heading, target, 4, dt);
      s.g.position.set(p.x, 0, p.z);
      s.g.rotation.y = s.heading;
      if (s.model) {
        // Hops on its single leg while moving, sways while it looks around.
        const hop = s.pause > 0 ? 0 : Math.abs(Math.sin(t * 5 + s.a * 9));
        s.model.position.y = hop * 0.28;
        s.model.rotation.z = s.pause > 0 ? Math.sin(t * 2 + s.a) * 0.08 : (hop - 0.5) * 0.12;
        s.body.position.y = 1.15 + hop * 0.28;
      } else s.body.position.y = 1.5 + Math.sin(t * 2.4 + s.a * 9) * 0.15;
      s.flame.material.opacity = 0.75 + Math.sin(t * 11 + s.a * 20) * 0.2;

      // Perception: distance (shrinks when crouching), field of view, line of sight past the trees.
      const dx = P.pos.x - p.x;
      const dz = P.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      const range = RANGE * (1 - 0.5 * P.crouch);
      const cosA = d > 1e-3 ? (Math.sin(s.heading) * dx + Math.cos(s.heading) * dz) / d : 1;
      s.seen = this.grace <= 0 && d < range && cosA > Math.cos(THREE.MathUtils.degToRad(FOV / 2)) && this.clear(p.x, p.z, P.pos.x, P.pos.z);
      s.sus = s.seen ? s.sus + dt * (1.2 + 2.5 * (1 - d / range)) : Math.max(0, s.sus - dt * 0.6);
      s.cone.material.color.setHex(s.seen ? 0xff6a5a : s.sus > 0.05 ? 0xffb05a : 0x6ab8ff);
      s.cone.material.opacity = 0.14 + Math.min(1, s.sus) * 0.18;
      if (s.sus >= 1) {
        for (const o of this.spirits) o.sus = 0;
        this.caughtCount++;
        this.grace = 2.5; // a moment to get bearings after waking at the checkpoint
        this.onCaught?.();
        return;
      }
      if (d < nd) {
        nd = d;
        nearest = s;
      }
    }
    // One real light follows the nearest wisp (the light pool picks it up when close).
    if (nearest) this.light.pos.set(nearest.g.position.x, 1.6, nearest.g.position.z);
    this.alarm = Math.max(...this.spirits.map((s) => s.sus));
  }
}
