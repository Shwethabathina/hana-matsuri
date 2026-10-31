import * as THREE from 'three';
import { makeCharacter, animate } from '../npc.js';
import { angleDamp, textSprite } from '../util.js';
import { Perception } from './perception.js';

const STATE_COLOR = { idle: 0x9a96a8, notice: 0x4ade80, talk: 0x60a5fa };

// A treasure-hunt villager with a small perception-driven state machine:
//   Idle   — scans the area (heading sways), does not react.
//   Notice — the player is visible (distance + field of view + line of sight); turns to face and greets.
//   Talk   — dialogue open (set by the game).
// Perception mode can be switched to 'radius' to compare against a radius-only check.
export class Villager {
  constructor(town, def) {
    this.town = town;
    this.def = def;
    this.name = def.name;
    this.role = def.role;
    const [x, z] = def.at;
    this.pos = town.toWorld(x, z, town.heightAt(town.toWorld(x, z).x, town.toWorld(x, z).z));
    this.baseHeading = def.heading;
    this.heading = def.heading;
    this.scan = def.scan ?? 0.45;
    this.phase = Math.random() * 6;
    this.state = 'idle';
    this.noticeT = 0;
    this.lastSeen = 99;
    this.senseT = Math.random() * 0.1; // stagger raycasts between villagers
    this.result = null;
    this.stats = { senses: 0, radiusHits: 0, fovLosHits: 0, falsePositivesAvoided: 0 };
    this.c = makeCharacter({ gender: def.gender, yukata: def.yukata, obi: def.obi, child: def.child });
    this.c.root.position.copy(this.pos);
    this.c.root.rotation.y = this.heading;
    town.root.parent.add(this.c.root);
    this.perception = new Perception({ range: def.range ?? 9, fovDeg: def.fov ?? 110, occluders: town.occluders });

    this.bubble = textSprite('', { height: 0.12, bg: 'rgba(255,248,235,0.94)', color: '#3a1d12' });
    this.bubble.position.y = 2.25;
    this.bubble.visible = false;
    this.c.root.add(this.bubble);
    this.bubbleT = 0;
    this.marker = textSprite('?', { font: 44, height: 0.38, bg: 'rgba(30,20,10,0.75)', color: '#ffd24a' });
    this.marker.position.y = 2.35;
    this.marker.visible = false;
    this.c.root.add(this.marker);

    // Debug: field-of-view cone, line-of-sight ray and a state label.
    this.debug = new THREE.Group();
    const half = THREE.MathUtils.degToRad((def.fov ?? 110) / 2);
    const cone = new THREE.Mesh(
      new THREE.CircleGeometry(def.range ?? 9, 32, -Math.PI / 2 - half, half * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: STATE_COLOR.idle, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    );
    cone.position.y = 0.06;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry((def.range ?? 9) - 0.06, def.range ?? 9, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    ring.position.y = 0.05;
    this.cone = cone;
    this.debug.add(cone, ring);
    this.debug.position.copy(this.pos);
    this.debug.visible = false;
    town.root.parent.add(this.debug);
    this.losLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.losLine.frustumCulled = false;
    this.losLine.visible = false;
    town.root.parent.add(this.losLine);
    this.label = textSprite('', { font: 28, height: 0.24 });
    this.label.position.y = 2.75;
    this.label.visible = false;
    this.c.root.add(this.label);
  }

  say(text, dur = 2.4) {
    this.bubble.userData.setText(text);
    this.bubble.visible = true;
    this.bubbleT = dur;
  }

  get noticed() {
    return this.state === 'notice' || this.state === 'talk';
  }

  update(dt, t, player, mode, debug) {
    // Perception at 10 Hz (raycasts are the expensive part).
    this.senseT -= dt;
    if (this.senseT <= 0) {
      this.senseT = 0.1;
      const r = this.perception.sense(this.pos, this.heading, player.pos);
      this.result = r;
      this.stats.senses++;
      if (r.radiusOnly) this.stats.radiusHits++;
      if (r.sees) this.stats.fovLosHits++;
      if (r.radiusOnly && !r.sees) this.stats.falsePositivesAvoided++;
    }
    const detected = this.result ? (mode === 'radius' ? this.result.radiusOnly : this.result.sees) : false;
    this.lastSeen = detected ? 0 : this.lastSeen + dt;

    if (this.state === 'idle' && detected) {
      this.state = 'notice';
      this.noticeT = 0;
      this.say(this.def.greet || 'Oh! Hello there.');
    } else if (this.state === 'notice' && this.lastSeen > 2.5) {
      this.state = 'idle'; // short memory: forgets the player a moment after losing sight
    }
    this.noticeT += dt;

    let target = this.baseHeading + Math.sin(t * 0.35 + this.phase) * this.scan;
    if (this.state !== 'idle') target = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    this.heading = angleDamp(this.heading, target, this.state === 'idle' ? 1.2 : 5, dt);
    this.c.root.rotation.y = this.heading;
    const anim = this.state === 'notice' && this.noticeT < 1.4 ? 'wave' : this.def.anim || 'idle';
    animate(this.c, anim, 1, dt, t);

    this.bubbleT -= dt;
    if (this.bubbleT <= 0) this.bubble.visible = false;

    // Debug visuals
    this.debug.visible = debug;
    this.losLine.visible = debug;
    this.label.visible = debug;
    if (debug && this.result) {
      this.debug.rotation.y = this.heading;
      const col = this.state === 'talk' ? STATE_COLOR.talk : detected ? STATE_COLOR.notice : this.result.inRange && this.result.inFov && !this.result.los ? 0xef4444 : STATE_COLOR.idle;
      this.cone.material.color.setHex(col);
      const a = this.pos.clone().setY(this.pos.y + 1.55);
      const b = this.result.hitPoint || player.pos.clone().setY(player.pos.y + 1.6);
      this.losLine.geometry.setFromPoints([a, b]);
      this.losLine.material.color.setHex(this.result.sees ? 0x4ade80 : this.result.hitPoint ? 0xef4444 : 0x777777);
      const radius = this.result.radiusOnly ? 'radius: DETECT' : 'radius: —';
      const fov = this.result.sees ? 'FOV+LOS: DETECT' : `FOV+LOS: — (${this.result.reason})`;
      this.label.userData.setText(`${this.name} · ${this.state.toUpperCase()} · ${radius} · ${fov}`);
    }
  }
}
