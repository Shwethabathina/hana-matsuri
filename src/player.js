import * as THREE from 'three';
import { clamp } from './util.js';

const EYE = 1.62;

// First-person walker: WASD move, arrows / mouse (pointer lock) look, circle-vs-world collision.
export class Player {
  constructor(camera, dom, colliders) {
    this.camera = camera;
    this.dom = dom;
    this.colliders = colliders;
    this.pos = new THREE.Vector3();
    this.yaw = -Math.PI / 2; // facing +x, down the street
    this.pitch = -0.05;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.enabled = false;
    this.radius = 0.3;
    this.bob = 0;
    this.shake = 0;
    this.lastStep = 0;
    this.bounds = undefined; // collision bounds override (undefined = festival bounds)
    this.slide = false; // axis-separated sliding movement (used in the town)
    this.slideRadius = 0.22;
    this.groundAt = null; // optional (x, z) => ground height, used on the town's raised stone floors

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('click', () => {
      if (this.enabled && document.pointerLockElement !== dom) try { dom.requestPointerLock?.()?.catch?.(() => {}); } catch {}
    });
    addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.35, 1.35);
    });
  }

  place(v, yaw = this.yaw) {
    this.pos.set(v.x, this.groundAt ? this.groundAt(v.x, v.z) : 0, v.z);
    this.yaw = yaw;
  }

  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  update(dt) {
    const k = this.keys;
    if (this.enabled) {
      const turn = 1.9 * dt;
      if (k.has('ArrowLeft')) this.yaw += turn;
      if (k.has('ArrowRight')) this.yaw -= turn;
      if (k.has('ArrowUp')) this.pitch = clamp(this.pitch + turn * 0.7, -1.35, 1.35);
      if (k.has('ArrowDown')) this.pitch = clamp(this.pitch - turn * 0.7, -1.35, 1.35);

      const f = this.forward;
      const r = new THREE.Vector3(-f.z, 0, f.x);
      const wish = new THREE.Vector3();
      if (k.has('KeyW')) wish.add(f);
      if (k.has('KeyS')) wish.sub(f);
      if (k.has('KeyD')) wish.add(r);
      if (k.has('KeyA')) wish.sub(r);
      const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 6.2 : 3.4;
      if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
      // Smooth acceleration.
      this.vel.lerp(wish, 1 - Math.exp(-10 * dt));
    } else {
      this.vel.multiplyScalar(Math.exp(-10 * dt));
    }
    if (this.slide) {
      // Town: move each axis separately and only where free, so the player glides along the
      // blocky collision grid instead of snagging on cell corners.
      const r = this.slideRadius;
      const nx = this.pos.x + this.vel.x * dt;
      if (!this.colliders.blocked(nx, this.pos.z, r, this.bounds)) this.pos.x = nx;
      const nz = this.pos.z + this.vel.z * dt;
      if (!this.colliders.blocked(this.pos.x, nz, r, this.bounds)) this.pos.z = nz;
      if (this.colliders.blocked(this.pos.x, this.pos.z, r, this.bounds)) this.colliders.resolve(this.pos, r, this.bounds);
    } else {
      this.pos.addScaledVector(this.vel, dt);
      this.colliders.resolve(this.pos, this.radius, this.bounds);
    }
    const gy = this.groundAt ? this.groundAt(this.pos.x, this.pos.z) : 0;
    this.pos.y += (gy - this.pos.y) * (1 - Math.exp(-14 * dt)); // smooth steps onto raised floors

    const sp = this.vel.length();
    this.bob += sp * dt * 2.2;
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  applyCamera() {
    const c = this.camera;
    const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, this.vel.length() / 3);
    const sh = this.shake * this.shake;
    c.position.set(this.pos.x + (Math.random() - 0.5) * sh * 0.15, this.pos.y + EYE + bobY + (Math.random() - 0.5) * sh * 0.15, this.pos.z);
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}

export { EYE };
