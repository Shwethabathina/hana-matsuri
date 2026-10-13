import * as THREE from 'three';
import { G } from './state.js';
import { angleDamp, clamp, damp } from './util.js';
import { heightAt } from './layout.js';

// Dogs on leashes that follow visitors: trot gait with diagonal leg pairs, tail wag,
// sitting when the owner stops, and a sagging leash from the owner's hand to the collar.

const BREEDS = [
  { name: 'Shiba', coat: '#c9772f', belly: '#f4e6d2', ears: '#c9772f', size: 1 },
  { name: 'Black shiba', coat: '#262220', belly: '#e8c9a0', ears: '#262220', size: 1 },
  { name: 'Akita', coat: '#f1ebe0', belly: '#ffffff', ears: '#e8dccb', size: 1.25 },
  { name: 'Corgi', coat: '#d98a3c', belly: '#fbf3e6', ears: '#d98a3c', size: 0.85, shortLegs: true },
];

function makeDog(b) {
  const coat = new THREE.MeshStandardMaterial({ color: b.coat, roughness: 0.85 });
  const belly = new THREE.MeshStandardMaterial({ color: b.belly, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: '#141010', roughness: 0.4 });
  const collarM = new THREE.MeshStandardMaterial({ color: '#c8243a', roughness: 0.5 });
  const legLen = b.shortLegs ? 0.13 : 0.24;
  const hipY = legLen + 0.06;

  const root = new THREE.Group();
  const body = new THREE.Group(); // pitches when sitting
  body.position.y = hipY;
  root.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.3, 6, 12).rotateX(Math.PI / 2), coat);
  torso.position.set(0, 0.06, 0);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.24, 6, 12).rotateX(Math.PI / 2), belly);
  chest.position.set(0, 0.025, 0.03);
  chest.scale.set(0.95, 0.9, 1);
  body.add(torso, chest);

  // Head with muzzle, nose, eyes and pointed ears
  const head = new THREE.Group();
  head.position.set(0, 0.17, 0.25);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), coat);
  skull.scale.set(1, 0.92, 1.05);
  const muzzle = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.06, 4, 8).rotateX(Math.PI / 2), belly);
  muzzle.position.set(0, -0.025, 0.08);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), dark);
  nose.position.set(0, -0.012, 0.135);
  head.add(skull, muzzle, nose);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), dark);
    eye.position.set(0.035 * s, 0.02, 0.07);
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 4), new THREE.MeshStandardMaterial({ color: b.ears, roughness: 0.85 }));
    ear.position.set(0.045 * s, 0.085, -0.01);
    ear.rotation.set(-0.15, 0, -0.3 * s);
    head.add(eye, ear);
  }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.14, 10), coat);
  neck.position.set(0, 0.12, 0.2);
  neck.rotation.x = 0.6;
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16), collarM);
  collar.position.set(0, 0.13, 0.21);
  collar.rotation.x = Math.PI / 2 + 0.6;
  body.add(neck, head, collar);

  // Curled tail (spitz breeds) or short tail (corgi)
  const tail = new THREE.Group();
  tail.position.set(0, 0.11, -0.2);
  const tailMesh = b.shortLegs
    ? new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), coat)
    : new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.02, 6, 12, Math.PI * 1.6), coat);
  if (!b.shortLegs) {
    tailMesh.rotation.y = Math.PI / 2;
    tailMesh.position.set(0, 0.04, -0.02);
  }
  tail.add(tailMesh);
  body.add(tail);

  // Legs: pivot at the shoulder/hip so they swing
  const legGeo = new THREE.CylinderGeometry(0.024, 0.02, legLen, 8).translate(0, -legLen / 2, 0);
  const pawGeo = new THREE.SphereGeometry(0.026, 8, 6).translate(0, -legLen, 0.01);
  const legs = [];
  for (const [x, z] of [[0.06, 0.15], [-0.06, 0.15], [0.06, -0.15], [-0.06, -0.15]]) {
    const leg = new THREE.Group();
    leg.position.set(x, 0, z);
    leg.add(new THREE.Mesh(legGeo, coat), new THREE.Mesh(pawGeo, belly));
    body.add(leg);
    legs.push(leg);
  }
  root.traverse((o) => o.isMesh && (o.castShadow = true));
  root.scale.setScalar(b.size);
  return { root, body, head, tail, legs, collar, hipY };
}

class Dog {
  constructor(sys, owner, breed) {
    this.sys = sys;
    this.owner = owner;
    this.breed = breed;
    this.d = makeDog(breed);
    this.pos = owner.pos.clone().add(new THREE.Vector3(0.5, 0, -0.5));
    this.vel = new THREE.Vector3();
    this.heading = owner.heading;
    this.phase = Math.random() * 6;
    this.still = 0;
    this.sit = 0;
    this.sniff = 0;
    sys.scene.add(this.d.root);
    // Leash: a sagging curve drawn as a line strip.
    this.leashPts = Array.from({ length: 12 }, () => new THREE.Vector3());
    this.leash = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.leashPts), new THREE.LineBasicMaterial({ color: '#c8243a' }));
    this.leash.frustumCulled = false;
    sys.scene.add(this.leash);
    this.hand = new THREE.Vector3();
    this.collarW = new THREE.Vector3();
  }

  update(dt, t) {
    const o = this.owner;
    // Heel position: slightly behind and to the right of the owner.
    const fx = Math.sin(o.heading);
    const fz = Math.cos(o.heading);
    const target = new THREE.Vector3(o.pos.x - fx * 0.55 - fz * 0.45, 0, o.pos.z - fz * 0.55 + fx * 0.45);
    const to = target.sub(this.pos).setY(0);
    const dist = to.length();
    let want = new THREE.Vector3();
    if (dist > 0.18) want = to.multiplyScalar(clamp((dist - 0.12) * 3, 0, 2.6) / dist);
    // Keep a little distance from the player.
    const pd = Math.hypot(this.pos.x - G.player.pos.x, this.pos.z - G.player.pos.z);
    if (pd < 0.7 && pd > 1e-3) {
      want.x += ((this.pos.x - G.player.pos.x) / pd) * (0.7 - pd) * 4;
      want.z += ((this.pos.z - G.player.pos.z) / pd) * (0.7 - pd) * 4;
    }
    this.vel.lerp(want, 1 - Math.exp(-7 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.sys.colliders.resolve(this.pos, 0.16);
    const speed = this.vel.length();
    if (speed > 0.08) this.heading = angleDamp(this.heading, Math.atan2(this.vel.x, this.vel.z), 7, dt);
    else this.heading = angleDamp(this.heading, Math.atan2(o.pos.x - this.pos.x, o.pos.z - this.pos.z), 1.5, dt);

    // Sit after the owner has been still for a while; sniff the ground now and then.
    this.still = speed < 0.1 ? this.still + dt : 0;
    this.sit = damp(this.sit, this.still > 1.6 ? 1 : 0, 4, dt);
    this.sniff = damp(this.sniff, this.still > 0.3 && this.still < 1.6 && Math.sin(t * 0.7 + this.phase) > 0.3 ? 1 : 0, 3, dt);

    // Trot: diagonal leg pairs move together; stride rate follows speed.
    const k = Math.min(1, speed / 1.2);
    this.phase += dt * (4 + speed * 9);
    const sw = Math.sin(this.phase) * 0.65 * k;
    const [fl, fr, bl, br] = this.d.legs;
    const s = this.sit;
    fl.rotation.x = sw;
    br.rotation.x = sw - s * 1.3;
    fr.rotation.x = -sw;
    bl.rotation.x = -sw - s * 1.3;
    const body = this.d.body;
    body.rotation.x = -s * 0.5;
    body.position.y = this.d.hipY - s * 0.07 + Math.abs(Math.cos(this.phase)) * 0.015 * k;
    this.d.head.rotation.x = this.sniff * 0.6 - s * 0.25 + Math.sin(t * 1.3 + this.phase) * 0.05;
    this.d.head.rotation.y = Math.sin(t * 0.8 + this.phase) * 0.35 * (1 - k);
    this.d.tail.rotation.y = Math.sin(t * (speed > 0.1 ? 14 : 7)) * (0.35 + 0.2 * k);
    this.d.root.position.set(this.pos.x, heightAt(this.pos.x, this.pos.z), this.pos.z);
    this.d.root.rotation.y = this.heading;

    // Leash from the owner's right hand to the collar, sagging more when slack.
    o.c.armR.localToWorld(this.hand.set(0, -0.52, 0.02));
    this.d.collar.getWorldPosition(this.collarW);
    const span = this.hand.distanceTo(this.collarW);
    const sag = Math.max(0.05, 1.1 - span) * 0.35;
    for (let i = 0; i < this.leashPts.length; i++) {
      const u = i / (this.leashPts.length - 1);
      this.leashPts[i].lerpVectors(this.hand, this.collarW, u);
      this.leashPts[i].y -= Math.sin(u * Math.PI) * sag;
    }
    this.leash.geometry.setFromPoints(this.leashPts);
  }
}

export function addPets(sys) {
  const owners = sys.agents.filter((_, i) => i % 3 === 1).slice(0, 4);
  return owners.map((o, i) => {
    o.hasDog = true;
    return new Dog(sys, o, BREEDS[i % BREEDS.length]);
  });
}
