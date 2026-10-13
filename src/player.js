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
    this.pos.set(v.x, 0, v.z);
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
    this.pos.addScaledVector(this.vel, dt);
    this.colliders.resolve(this.pos, this.radius);

    const sp = this.vel.length();
    this.bob += sp * dt * 2.2;
    this.shake = Math.max(0, this.shake - dt * 1.6);
  }

  applyCamera() {
    const c = this.camera;
    const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, this.vel.length() / 3);
    const sh = this.shake * this.shake;
    c.position.set(this.pos.x + (Math.random() - 0.5) * sh * 0.15, EYE + bobY + (Math.random() - 0.5) * sh * 0.15, this.pos.z);
    c.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}

export { EYE };
