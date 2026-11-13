import * as THREE from 'three';
import { G } from './state.js';
import { sfx } from './audio.js';
import { angleDamp, glowTexture } from './util.js';

// Spirit Realm chapter: the haunted forest path becomes the spirit world. The player sneaks past the
// patrolling onibi (SpiritPatrol: FOV + tree line of sight, checkpoints) to a clearing where a corrupted
// guardian holds the festival spirit. Guardian encounter: light four shrine lanterns before time runs out.
// The guardian sees with a vision cone (distance + FOV + line of sight past the trees), hunts the player
// when it spots them, investigates the sound of each lantern being lit, and on contact knocks the player
// back and snuffs out one lantern.
const TIME = 150; // seconds for the lantern challenge
const G_RANGE = 9;
const G_FOV = 70;

export class SpiritRealm {
  constructor({ world, ui, kimo, onDone }) {
    this.world = world;
    this.ui = ui;
    this.kimo = kimo;
    this.onDone = onDone;
    this.active = false;
    this.phase = 'off';
    const curve = kimo.curve;
    this.curve = curve;
    // Clearing at the far end of the forest loop.
    this.center = curve.getPointAt(0.5).setY(0);
    this.entry = curve.getPointAt(0.4).setY(0);
    const scene = world.scene;

    // Four stone shrine lanterns (tōrō) around the clearing.
    this.lanterns = [0.42, 0.47, 0.53, 0.58].map((t, i) => {
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = i % 2 ? 1.6 : -1.6;
      const want = new THREE.Vector3(p.x - tan.z * side, 0, p.z + tan.x * side);
      const pos = freeSpot(world.colliders, want, p);
      const g = new THREE.Group();
      const stone = new THREE.MeshStandardMaterial({ color: '#7d7a74', roughness: 1 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.5, 8), stone);
      base.position.y = 0.25;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 0.42), stone);
      box.position.y = 0.67;
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.44), new THREE.MeshBasicMaterial({ color: '#2a3550' }));
      light.position.y = 0.67;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.28, 4).rotateY(Math.PI / 4), stone);
      roof.position.y = 0.98;
      const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffb35a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.scale.setScalar(1.1);
      flame.position.y = 0.7;
      flame.visible = false;
      g.add(base, box, light, roof, flame);
      g.position.copy(pos);
      g.visible = false;
      scene.add(g);
      const src = world.addLight(new THREE.Vector3(pos.x, -50, pos.z), { color: 0xffa050, base: 5, distance: 8, flicker: 0.25 });
      return { g, pos, flame, light, src, lit: false };
    });
    for (const L of this.lanterns) {
      world.addInteractable({
        id: 'realm-lantern', pos: L.pos, radius: 1.5,
        label: 'Light the shrine lantern',
        enabled: () => this.phase === 'guardian' && !L.lit,
        action: () => this.light(L),
      });
    }

    // The guardian: a towering pale spirit with a red vision cone.
    this.guardian = kimo.makeGhost();
    this.guardian.scale.setScalar(1.9);
    this.guardian.traverse((o) => {
      if (o.material?.emissive) o.material = o.material.clone();
      if (o.material?.emissive) o.material.emissive.set('#c84a6a');
    });
    const half = THREE.MathUtils.degToRad(G_FOV / 2);
    this.cone = new THREE.Mesh(
      new THREE.CircleGeometry(G_RANGE, 28, Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff5a6a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    this.cone.position.y = 0.05;
    this.cone.scale.setScalar(1 / 1.9);
    this.guardian.add(this.cone);
    this.guardian.visible = false;
    scene.add(this.guardian);
    this.gPos = this.center.clone();
    this.gHeading = 0;
    this.gState = 'patrol';
    this.orbit = 0;

    // The festival spirit (golden orb) shown once the guardian is purified.
    this.spirit = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffd77a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.spirit.scale.setScalar(1.2);
    this.spirit.visible = false;
    scene.add(this.spirit);
  }

  get litCount() {
    return this.lanterns.filter((l) => l.lit).length;
  }

  // Called when the player steps onto the haunted path during the SPIRIT_REALM quest step.
  start() {
    if (this.active) return;
    this.active = true;
    this.phase = 'path';
    this.kimo.spiritPatrol.start(() => this.caughtOnPath());
    this.checkpoint = this.curve.getPointAt(0.02).setY(0);
    this.ui.toast('The air turns cold. You have stepped into the spirit realm.');
    sfx.whisper?.();
  }

  caughtOnPath() {
    this.ui.flash();
    sfx.scare();
    G.player.shake = 0.6;
    G.player.place(this.checkpoint, this.headingAlong(0.04));
    G.player.vel.set(0, 0, 0);
    this.ui.toast('A spirit saw you… you wake at the edge of the forest.');
  }

  headingAlong(t) {
    const a = this.curve.getPointAt(t);
    const b = this.curve.getPointAt(Math.min(1, t + 0.02));
    return Math.atan2(-(b.x - a.x), -(b.z - a.z));
  }

  beginGuardian() {
    this.phase = 'guardian';
    this.kimo.spiritPatrol.stop();
    this.timer = TIME;
    this.grace = 2;
    this.gPos.copy(this.center);
    this.gState = 'patrol';
    this.guardian.visible = true;
    for (const L of this.lanterns) {
      L.g.visible = true;
      L.lit = false;
      L.flame.visible = false;
      L.light.material.color.set('#2a3550');
      L.src.pos.set(L.pos.x, -50, L.pos.z);
    }
    sfx.scare();
    this.ui.flash();
    this.ui.toast('A corrupted guardian blocks the way. Light the four shrine lanterns before the darkness wins.');
  }

  light(L) {
    L.lit = true;
    L.flame.visible = true;
    L.light.material.color.set('#ffcf8a');
    L.src.pos.set(L.pos.x, 1.0, L.pos.z);
    sfx.chime();
    // The guardian hears the lantern catch and comes to investigate.
    this.gTarget = L.pos.clone();
    if (this.gState === 'patrol') this.gState = 'search';
    if (this.litCount === 4) this.win();
    else this.ui.toast(`Shrine lantern lit (${this.litCount} / 4) — the guardian heard that…`);
  }

  win() {
    this.phase = 'won';
    this.wonT = 0;
    sfx.suzu();
    this.ui.toast('The guardian’s darkness breaks apart. The festival spirit is free!');
  }

  fail(reason) {
    this.ui.flash();
    sfx.scare();
    G.player.shake = 0.8;
    G.player.place(this.entry, this.headingAlong(0.42));
    G.player.vel.set(0, 0, 0);
    this.grace = 3;
    this.gState = 'patrol';
    this.gPos.copy(this.center);
    if (reason === 'time') {
      for (const L of this.lanterns) {
        L.lit = false;
        L.flame.visible = false;
        L.light.material.color.set('#2a3550');
        L.src.pos.set(L.pos.x, -50, L.pos.z);
      }
      this.timer = TIME;
      this.ui.toast('The darkness swallowed every lantern. Try again.');
    } else {
      const lit = this.lanterns.filter((l) => l.lit);
      if (lit.length) {
        const L = lit[Math.floor(Math.random() * lit.length)];
        L.lit = false;
        L.flame.visible = false;
        L.light.material.color.set('#2a3550');
        L.src.pos.set(L.pos.x, -50, L.pos.z);
      }
      this.ui.toast('The guardian caught you and snuffed out a lantern!');
    }
  }

  // Guardian sight: distance + field of view + line of sight past the tree trunks.
  sees(P) {
    const dx = P.pos.x - this.gPos.x;
    const dz = P.pos.z - this.gPos.z;
    const d = Math.hypot(dx, dz);
    const range = G_RANGE * (1 - 0.4 * P.crouch);
    if (d > range) return false;
    if ((Math.sin(this.gHeading) * dx + Math.cos(this.gHeading) * dz) / (d || 1) < Math.cos(THREE.MathUtils.degToRad(G_FOV / 2))) return false;
    return this.kimo.spiritPatrol.clear(this.gPos.x, this.gPos.z, P.pos.x, P.pos.z);
  }

  update(dt, t) {
    if (!this.active) return;
    const P = G.player;
    if (this.phase === 'path') {
      this.kimo.spiritPatrol.update(dt, t);
      // Seals on the path still act as checkpoints.
      const near = this.kimo.nearestT(P.pos);
      if (near.d < 4 && near.t > 0.2) this.checkpoint = this.curve.getPointAt(Math.max(0.02, near.t - 0.03)).setY(0);
      if (P.pos.distanceTo(this.entry) < 3.5) this.beginGuardian();
      return;
    }
    if (this.phase === 'guardian') {
      this.timer -= dt;
      this.grace = Math.max(0, this.grace - dt);
      if (this.timer <= 0) return this.fail('time');
      const seen = this.grace <= 0 && this.sees(P);
      if (seen) {
        this.gState = 'hunt';
        this.lostT = 0;
        this.gTarget = P.pos.clone();
      } else if (this.gState === 'hunt') {
        this.lostT += dt;
        if (this.lostT > 1.5) this.gState = 'search'; // keeps going to where it last saw the player
      }
      let goal;
      let speed;
      if (this.gState === 'patrol') {
        this.orbit += dt * 0.25;
        goal = new THREE.Vector3(this.center.x + Math.cos(this.orbit) * 4.5, 0, this.center.z + Math.sin(this.orbit) * 4.5);
        speed = 1.2;
      } else {
        goal = this.gTarget;
        speed = this.gState === 'hunt' ? 1.9 : 1.4; // the player can out-walk it, but not while crouching
        if (this.gState === 'search' && this.gPos.distanceTo(goal) < 0.6) {
          this.searchT = (this.searchT || 0) + dt;
          if (this.searchT > 2.5) {
            this.gState = 'patrol';
            this.searchT = 0;
          }
        }
      }
      const dx = goal.x - this.gPos.x;
      const dz = goal.z - this.gPos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        this.gPos.x += (dx / d) * Math.min(d, speed * dt);
        this.gPos.z += (dz / d) * Math.min(d, speed * dt);
        this.gHeading = angleDamp(this.gHeading, Math.atan2(dx, dz), 4, dt);
      } else {
        this.gHeading += dt * 0.9; // looks around
      }
      if (this.grace <= 0 && Math.hypot(P.pos.x - this.gPos.x, P.pos.z - this.gPos.z) < 1.0) return this.fail('caught');
      this.guardian.position.set(this.gPos.x, 0.2 + Math.sin(t * 2) * 0.12, this.gPos.z);
      this.guardian.rotation.y = this.gHeading;
      this.cone.material.color.setHex(this.gState === 'hunt' ? 0xff3a3a : this.gState === 'search' ? 0xffa04a : 0xff8aa0);
      const m = Math.floor(this.timer / 60);
      const sec = String(Math.floor(this.timer % 60)).padStart(2, '0');
      this.note = `Shrine lanterns ${this.litCount} / 4 · ${m}:${sec} · ${this.gState === 'hunt' ? 'it has seen you!' : this.gState === 'search' ? 'it is searching' : 'stay out of its red light'}`;
      return;
    }
    if (this.phase === 'won') {
      this.wonT += dt;
      const k = Math.min(1, this.wonT / 2.5);
      this.guardian.scale.setScalar(1.9 * (1 - k));
      this.guardian.position.y = 0.2 + k * 2;
      this.spirit.visible = true;
      this.spirit.position.set(this.gPos.x, 1.2 + k * 1.5 + Math.sin(t * 3) * 0.1, this.gPos.z);
      this.spirit.material.opacity = 0.6 + Math.sin(t * 6) * 0.3;
      if (this.wonT > 3) {
        this.guardian.visible = false;
        this.guardian.scale.setScalar(1.9);
        this.spirit.visible = false;
        this.phase = 'off';
        this.active = false;
        for (const L of this.lanterns) L.src.pos.set(L.pos.x, -50, L.pos.z);
        this.onDone?.();
      }
    }
  }

  reset() {
    this.active = false;
    this.phase = 'off';
    this.guardian.visible = false;
    this.spirit.visible = false;
    this.kimo.spiritPatrol.stop();
    for (const L of this.lanterns) {
      L.g.visible = false;
      L.lit = false;
      L.src.pos.set(L.pos.x, -50, L.pos.z);
    }
  }
}

// Nearest spot to `want` (searching outward, then toward the path) where the lantern and the player fit.
function freeSpot(colliders, want, onPath) {
  for (let r = 0; r <= 2.5; r += 0.25) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = want.x + Math.cos(a) * r;
      const z = want.z + Math.sin(a) * r;
      if (!colliders.blocked(x, z, 0.6)) return new THREE.Vector3(x, 0, z);
    }
  }
  return new THREE.Vector3(onPath.x, 0, onPath.z);
}
