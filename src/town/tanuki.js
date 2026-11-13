import * as THREE from 'three';
import { Perception } from './perception.js';
import { angleDamp, textSprite } from '../util.js';

// The bell thief: a tanuki agent that roams the Old Town on the walkable grid.
//   Sight   — distance + wide forward field of view + raycast line of sight (Perception), with the
//             detection range scaled by the player's stance (crouching is hard to spot).
//   Hearing — running footsteps within a few metres alert it even from behind or through walls.
//   Suspicion builds while it perceives the player (faster when close) and decays otherwise;
//   at 1 it flees along a grid path to the hiding spot farthest from the player.
// States: hidden -> wander <-> sniff -> alert -> flee -> (calm) wander ... -> caught -> gone.
const SPOTS = [
  [1.7, -13.5], // north path end
  [-3.3, -5.3], // west pocket behind the shops
  [5.3, 6.2], // south-east lane
  [-4.8, 2.3], // west alley
  [1.7, -8.8], // middle of the north path
];
const SIGHT = 6; // m, standing player
const FOV = 120; // tanuki see a wide arc in front, nothing behind
const HEAR_RUN = 6; // m

export class Tanuki {
  constructor(town, hooks = {}) {
    this.town = town;
    this.hooks = hooks;
    this.o = town.root.position;
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.state = 'hidden';
    this.suspicion = 0;
    this.escapes = 0;
    this.path = [];
    this.timer = 0;
    this.senseT = 0;
    this.seen = false;
    this.heard = false;
    this.build();
    this.perception = new Perception({ range: SIGHT, fovDeg: FOV, eyeHeight: 0.35, occluders: town.occluders });
  }

  build() {
    const g = new THREE.Group();
    const fur = new THREE.MeshStandardMaterial({ color: '#7a5a3c', roughness: 0.95 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2a1f18', roughness: 0.95 });
    const light = new THREE.MeshStandardMaterial({ color: '#cdb594', roughness: 0.95 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10).scale(1, 0.85, 1.35), fur);
    body.position.y = 0.26;
    const head = new THREE.Group();
    head.position.set(0, 0.36, 0.27);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10).scale(1.1, 0.95, 1), light);
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8).scale(1.7, 0.6, 0.6), dark);
    mask.position.set(0, 0.01, 0.08);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.1, 8).rotateX(Math.PI / 2), light);
    snout.position.set(0, -0.02, 0.13);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), dark);
    nose.position.set(0, -0.01, 0.18);
    head.add(skull, mask, snout, nose);
    for (const x of [-0.07, 0.07]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.06, 6), dark);
      ear.position.set(x, 0.1, -0.01);
      head.add(ear);
    }
    // Stolen bell cluster held in the mouth.
    this.bell = new THREE.Group();
    const gold = new THREE.MeshStandardMaterial({ color: '#d9a93a', metalness: 0.85, roughness: 0.25, emissive: '#5a3a08', emissiveIntensity: 0.5 });
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), gold);
      b.position.set(-0.035 + i * 0.035, -0.07, 0.15);
      this.bell.add(b);
    }
    head.add(this.bell);
    this.head = head;
    // Ringed tail
    this.tail = new THREE.Group();
    this.tail.position.set(0, 0.28, -0.26);
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Mesh(new THREE.SphereGeometry(0.07 - i * 0.008, 8, 6).scale(1, 1, 1.4), i % 2 ? dark : fur);
      seg.position.set(0, -i * 0.025, -i * 0.07);
      this.tail.add(seg);
    }
    this.legs = [];
    for (const [x, z] of [[-0.1, 0.15], [0.1, 0.15], [-0.1, -0.15], [0.1, -0.15]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.16, 6), dark);
      leg.position.set(x, 0.08, z);
      this.legs.push(leg);
      g.add(leg);
    }
    g.add(body, head, this.tail);
    g.traverse((o) => o.isMesh && (o.castShadow = true));
    // Awareness indicator: "?" while suspicious, "!" when it bolts.
    this.mark = textSprite('?', { font: 40, height: 0.22, bg: 'rgba(20,12,8,0.7)', color: '#ffd24a' });
    this.mark.position.y = 0.75;
    this.mark.visible = false;
    g.add(this.mark);
    g.visible = false;
    this.root = g;
    this.town.root.parent.add(g);
  }

  local(p) {
    return [p.x - this.o.x, p.z - this.o.z];
  }

  world([x, z]) {
    return new THREE.Vector3(this.o.x + x, 0, this.o.z + z);
  }

  goTo(spot) {
    this.path = this.town.findPath(this.local(this.pos), spot).map((p) => this.world(p));
  }

  appear() {
    const s = SPOTS[0];
    this.pos.copy(this.world(s));
    this.state = 'sniff';
    this.sniffHeading = 0;
    this.timer = 2;
    this.suspicion = 0;
    this.escapes = 0;
    this.bell.visible = true;
    this.root.visible = true;
  }

  reset() {
    this.state = 'hidden';
    this.root.visible = false;
    this.path = [];
    this.suspicion = 0;
    this.escapes = 0;
  }

  get canBeCaught() {
    // Can be grabbed unless it has bolted: sneaking right up while it is only suspicious still works.
    return this.state !== 'flee' && this.state !== 'gone' && this.state !== 'hidden' && this.suspicion < 1;
  }

  // Grabbed from behind: drops the bell and scampers off to the farthest spot, then disappears.
  catch(playerPos) {
    this.bell.visible = false;
    this.hooks.onDrop?.(this.pos.clone());
    this.state = 'gone';
    this.goTo(this.farthestSpot(playerPos));
    this.mark.visible = false;
  }

  farthestSpot(from) {
    let best = SPOTS[0];
    let bd = -1;
    for (const s of SPOTS) {
      const w = this.world(s);
      const d = Math.hypot(w.x - from.x, w.z - from.z) - Math.hypot(w.x - this.pos.x, w.z - this.pos.z) * 0.3;
      if (d > bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  sense(player) {
    // Stance changes how far it can spot the player: crouching halves the range, running extends it.
    const k = 1 - 0.6 * player.crouch + (player.running ? 0.3 : 0);
    this.perception.range = SIGHT * k;
    const r = this.perception.sense(this.pos, this.heading, player.pos, 1.6 - player.crouch * 0.6);
    const moving = player.vel.length() > 0.5;
    this.heard = player.running && moving && r.dist < HEAR_RUN;
    this.seen = r.sees;
    this.last = r;
    return r;
  }

  update(dt, t, player) {
    if (this.state === 'hidden') return;
    const g = this.root;
    let speed = 0;

    if (this.state !== 'gone') {
      this.senseT -= dt;
      if (this.senseT <= 0) {
        this.senseT = 0.1;
        this.sense(player);
      }
      const d = this.last ? this.last.dist : 99;
      if (this.state !== 'flee') {
        if (this.heard) this.suspicion = 1;
        else if (this.seen) this.suspicion += dt * (0.55 + 1.6 * Math.max(0, 1 - d / this.perception.range)) * (this.escapes >= 3 ? 0.6 : 1);
        else this.suspicion = Math.max(0, this.suspicion - dt * 0.35);
        if (this.suspicion >= 1) {
          this.state = 'flee';
          this.escapes++;
          this.goTo(this.farthestSpot(player.pos));
          this.hooks.onFlee?.(this.pos.clone(), this.escapes);
        } else if (this.suspicion > 0.4 && this.state !== 'alert') {
          this.state = 'alert'; // freezes and stares, giving the player a moment to back off
          this.timer = 1.2;
        }
      }
    }

    switch (this.state) {
      case 'sniff':
        this.timer -= dt;
        this.heading = angleDamp(this.heading, this.sniffHeading + Math.sin(t * 0.9) * 0.6, 2, dt);
        if (this.timer <= 0) {
          this.state = 'wander';
          const options = SPOTS.filter((s) => Math.hypot(this.world(s).x - this.pos.x, this.world(s).z - this.pos.z) > 2);
          this.goTo(options[Math.floor(Math.random() * options.length)]);
        }
        break;
      case 'alert':
        this.timer -= dt;
        if (this.last) this.heading = angleDamp(this.heading, Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z), 4, dt);
        if (this.timer <= 0 && this.suspicion < 0.4) this.state = 'sniff';
        if (this.timer <= 0 && this.suspicion < 1) this.timer = 0.3;
        break;
      case 'wander':
        speed = 0.9;
        break;
      case 'flee':
        speed = this.escapes > 4 ? 2.4 : 3.3; // gets tired after many escapes
        break;
      case 'gone':
        speed = 3.6;
        break;
    }

    if (speed > 0) {
      const next = this.path[0];
      if (!next) {
        if (this.state === 'gone') {
          g.visible = false;
          this.state = 'hidden';
          return;
        }
        if (this.state === 'flee') this.suspicion = 0.5; // nervous for a while after escaping
        this.state = 'sniff';
        this.sniffHeading = this.heading;
        this.timer = 2.5 + Math.random() * 2.5;
      } else {
        const dx = next.x - this.pos.x;
        const dz = next.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.15) this.path.shift();
        else {
          const step = Math.min(d, speed * dt);
          this.pos.x += (dx / d) * step;
          this.pos.z += (dz / d) * step;
          this.heading = angleDamp(this.heading, Math.atan2(dx, dz), 10, dt);
        }
      }
    }

    // Pose and animation
    this.pos.y = this.town.heightAt(this.pos.x, this.pos.z);
    g.position.copy(this.pos);
    g.rotation.y = this.heading;
    const gait = t * (speed > 2 ? 18 : 9);
    this.legs.forEach((l, i) => (l.rotation.x = speed > 0 ? Math.sin(gait + (i % 2 ? Math.PI : 0) + (i > 1 ? Math.PI / 2 : 0)) * 0.7 : 0));
    this.tail.rotation.y = Math.sin(t * (speed > 0 ? 8 : 2)) * 0.35;
    this.head.rotation.x = this.state === 'sniff' ? Math.sin(t * 6) * 0.15 + 0.2 : 0;
    g.position.y += speed > 0 ? Math.abs(Math.sin(gait)) * 0.03 : 0;
    this.mark.visible = this.state === 'alert' || this.state === 'flee';
    if (this.mark.visible) this.mark.userData.setText(this.state === 'flee' ? '!' : '?');
  }
}
