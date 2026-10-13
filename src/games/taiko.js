import * as THREE from 'three';
import { L } from '../layout.js';
import { G, emit } from '../state.js';
import { audioTime, sfx } from '../audio.js';
import { canvasTexture, damp, pick, rand, signTexture } from '../util.js';

const T = L.taiko;
const STAGE_H = 1.05;
const DRUM = new THREE.Vector3(T.x, STAGE_H + 0.95, T.z);
const BPM = 120;
const STEP = 60 / BPM / 2; // eighth notes
const BARS = [
  'd...d...', 'd...d.d.', 'd.k.d.k.', 'd.d.d...',
  'd..kd..k', 'dd..k.k.', 'd.k.ddk.', 'kkd.kkd.',
  'd.dkd.dk', 'ddk.ddk.', 'dkdkd.d.', 'd.d.d.d.',
  'ddkkddk.', 'd.dkdkd.', 'dkdkdkd.', 'd...d...',
];
const SPEED = 420; // px per second on the lane

function tomoeTex() {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#efe3c6';
    g.fillRect(0, 0, 256, 256);
    g.translate(128, 128);
    const cols = ['#b3202a', '#1b1b1b', '#d4a02a'];
    for (let i = 0; i < 3; i++) {
      g.rotate((Math.PI * 2) / 3);
      g.fillStyle = cols[i];
      g.beginPath();
      g.arc(0, -34, 30, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(30, -34);
      g.quadraticCurveTo(40, 30, -30, 60);
      g.quadraticCurveTo(20, 10, -30, -34);
      g.fill();
    }
  });
}

// Taiko rhythm game on the festival stage. Audio clock drives note timing.
export class Taiko {
  constructor(ctx) {
    this.ctx = ctx;
    this.title = 'Taiko 太鼓';
    const world = ctx.world;
    const stage = new THREE.Group();
    const kohaku = canvasTexture(256, 64, (g) => {
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? '#ffffff' : '#c8241c';
        g.fillRect(i * 32, 0, 32, 64);
      }
    }, { repeat: [6, 1] });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(6, STAGE_H, 4.6), [
      new THREE.MeshStandardMaterial({ map: kohaku }), new THREE.MeshStandardMaterial({ map: kohaku }),
      new THREE.MeshStandardMaterial({ color: '#8a6440' }), new THREE.MeshStandardMaterial({ color: '#8a6440' }),
      new THREE.MeshStandardMaterial({ map: kohaku }), new THREE.MeshStandardMaterial({ map: kohaku }),
    ]);
    deck.position.set(T.x, STAGE_H / 2, T.z);
    stage.add(deck);
    // Drum on its stand, heads facing ±z
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.95, 28, 1, true).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#7a2a14', roughness: 0.5, side: THREE.DoubleSide }));
    const headMat = new THREE.MeshStandardMaterial({ map: tomoeTex(), roughness: 0.7 });
    this.headFront = new THREE.Mesh(new THREE.CircleGeometry(0.63, 32), headMat);
    this.headFront.position.z = 0.476;
    this.headBack = new THREE.Mesh(new THREE.CircleGeometry(0.63, 32).rotateY(Math.PI), headMat);
    this.headBack.position.z = -0.476;
    this.drum = new THREE.Group();
    this.drum.add(body, this.headFront, this.headBack);
    const studGeo = new THREE.SphereGeometry(0.025, 6, 4);
    const studMat = new THREE.MeshStandardMaterial({ color: '#d4b04a', metalness: 0.8, roughness: 0.3 });
    for (const z of [-0.44, 0.44]) {
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const s = new THREE.Mesh(studGeo, studMat);
        s.position.set(Math.cos(a) * 0.63, Math.sin(a) * 0.63, z);
        this.drum.add(s);
      }
    }
    this.drum.position.copy(DRUM);
    stage.add(this.drum);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 0.9), new THREE.MeshStandardMaterial({ color: '#3a2414' }));
    stand.position.set(T.x, STAGE_H + 0.2, T.z);
    stage.add(stand);
    // Stage lantern posts
    const lanternMat = new THREE.MeshStandardMaterial({ color: '#f4e4c0', emissive: '#ffb050', emissiveIntensity: 1 });
    world.registerGlow(lanternMat, 0.3, 3.2);
    this.stageLanternMat = lanternMat;
    for (const x of [-2.8, 2.8]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3), new THREE.MeshStandardMaterial({ color: '#3a2414' }));
      pole.position.set(T.x + x, STAGE_H + 1.5, T.z + 2.1);
      const lan = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 14), lanternMat);
      lan.position.set(T.x + x, STAGE_H + 2.8, T.z + 2.1);
      stage.add(pole, lan);
    }
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.7), new THREE.MeshStandardMaterial({ map: signTexture('盆踊り 太鼓', { w: 512, h: 200, font: 110 }) }));
    banner.position.set(T.x, STAGE_H + 3.1, T.z - 2.2);
    const bannerPole = new THREE.Mesh(new THREE.BoxGeometry(2, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: '#3a2414' }));
    bannerPole.position.set(T.x, STAGE_H + 3.5, T.z - 2.2);
    stage.add(banner, bannerPole);
    stage.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    world.scene.add(stage);
    world.colliders.addRect(T.x, T.z, 3.05, 2.35, 'stage');
    this.stageLight = world.addLight(new THREE.Vector3(T.x, STAGE_H + 3, T.z + 2.5), { base: 10, distance: 16 });
    this.stageLightBase = world.lights[world.lights.length - 1];

    // Player's bachi (sticks), children of the camera.
    const stickMat = new THREE.MeshStandardMaterial({ color: '#e0c190' });
    this.sticks = [-1, 1].map((side) => {
      const g = new THREE.Group();
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.5, 8).translate(0, 0.25, 0), stickMat);
      g.add(s);
      g.position.set(0.16 * side, -0.32, -0.45);
      g.rotation.x = -0.6;
      g.visible = false;
      ctx.camera.add(g);
      return { g, hit: 0 };
    });

    this.cameraPose = { pos: new THREE.Vector3(T.x, STAGE_H + 1.75, T.z - 1.6), look: new THREE.Vector3(T.x, STAGE_H + 0.9, T.z + 3) };
    this.interact = { id: 'taiko', pos: new THREE.Vector3(T.x, 0, T.z + 3), label: 'Play the Taiko rhythm game', radius: 2.6 };
    this.active = false;
    this.pulse = 0;
  }

  enter() {
    this.active = true;
    G.taikoActive = true;
    G.taikoHype = 0;
    this.notes = [];
    const t0 = audioTime() + 2.2;
    this.t0 = t0;
    let slot = 0;
    for (const bar of BARS) {
      for (const ch of bar) {
        if (ch !== '.') this.notes.push({ t: t0 + slot * STEP, type: ch, judged: false });
        slot++;
      }
    }
    this.endTime = t0 + slot * STEP + 1.2;
    this.nextTick = t0 - 4 * STEP * 2;
    this.tickIdx = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.stats = { great: 0, good: 0, miss: 0 };
    this.judgeText = '';
    this.judgeT = 0;
    this.finished = false;
    for (const s of this.sticks) s.g.visible = true;
    this.ctx.ui.gameHud(`
      <div class="gh-title">太鼓 Taiko Rhythm</div>
      <canvas id="taiko-lane" width="900" height="120"></canvas>
      <div><b>F / J</b> or <b>left click</b> = <span style="color:#ff5a4a">DON (centre)</span> ·
      <b>D / K</b> or <b>right click</b> = <span style="color:#4ab0ff">KA (rim)</span> · Esc to leave</div>`);
    this.lane = document.getElementById('taiko-lane').getContext('2d');
  }

  exit() {
    this.active = false;
    G.taikoActive = false;
    G.taikoHype = 0;
    for (const s of this.sticks) s.g.visible = false;
  }

  keyDown(e) {
    if (e.repeat) return;
    if (e.code === 'KeyF' || e.code === 'KeyJ') this.hit('d', e.code === 'KeyJ' ? 1 : 0);
    if (e.code === 'KeyD' || e.code === 'KeyK') this.hit('k', e.code === 'KeyK' ? 1 : 0);
  }

  pointerDown(e) {
    if (e.button === 0) this.hit('d', 0);
    if (e.button === 2) this.hit('k', 1);
  }

  hit(type, side) {
    if (!this.active || this.finished) return;
    const now = audioTime();
    type === 'd' ? sfx.don(1) : sfx.ka(1);
    this.sticks[side].hit = 1;
    this.pulse = type === 'd' ? 1 : 0.6;
    G.drumHit++;
    // Find the closest unjudged note within the timing window.
    let best = null;
    let bestD = 0.16;
    for (const n of this.notes) {
      if (n.judged) continue;
      const d = Math.abs(n.t - now);
      if (d < bestD) {
        best = n;
        bestD = d;
      }
      if (n.t > now + 0.2) break;
    }
    if (!best) return;
    best.judged = true;
    if (best.type !== type) return this.judge('miss', best);
    if (bestD < 0.05) this.judge('great', best);
    else if (bestD < 0.11) this.judge('good', best);
    else this.judge('miss', best);
  }

  judge(kind, note) {
    note.result = kind;
    this.stats[kind]++;
    if (kind === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.score += (kind === 'great' ? 300 : 100) + Math.min(this.combo, 50) * 4;
      this.sparks(kind === 'great' ? 26 : 12);
      if (this.combo % 10 === 0) {
        emit('cheer', DRUM);
        sfx.cheer();
      }
    }
    this.judgeText = { great: '良 GREAT', good: '可 GOOD', miss: '不可 MISS' }[kind];
    this.judgeT = 0.5;
  }

  sparks(n) {
    const fw = this.ctx.fireworks;
    const col = new THREE.Color(pick(['#ffd24a', '#ff6a3a', '#ffffff'])).multiplyScalar(2.5);
    const v = new THREE.Vector3();
    const p = DRUM.clone().add(new THREE.Vector3(0, 0.3, -0.5));
    for (let i = 0; i < n; i++) {
      v.set(rand(-2, 2), rand(1.5, 4), rand(-1.5, 1.5));
      fw.stars.spawn(p, v, { life: rand(0.4, 0.8), size: 0.06, drag: 1.5, grav: 0.6, c0: col, c1: new THREE.Color(1, 0.3, 0.1), flags: 4 });
    }
  }

  drawLane(now) {
    const g = this.lane;
    if (!g) return;
    const W = 900;
    const H = 120;
    const HX = 110;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(20,10,20,0.75)';
    g.fillRect(0, 20, W, 80);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.beginPath();
    g.moveTo(0, 60);
    g.lineTo(W, 60);
    g.stroke();
    // Beat lines
    for (let k = -2; k < 20; k++) {
      const bt = this.t0 + k * STEP * 2;
      const x = HX + (bt - now) * SPEED;
      if (x < 0 || x > W) continue;
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x, 24, 2, 72);
    }
    // Hit target
    g.lineWidth = 4;
    g.strokeStyle = this.judgeT > 0 ? '#ffe27a' : 'rgba(255,255,255,0.8)';
    g.beginPath();
    g.arc(HX, 60, 32, 0, Math.PI * 2);
    g.stroke();
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.judged && n.result !== 'miss') continue;
      const x = HX + (n.t - now) * SPEED;
      if (x < -40 || x > W + 40) continue;
      g.globalAlpha = n.judged ? 0.3 : 1;
      g.fillStyle = n.type === 'd' ? '#ff4a3a' : '#3aa8ff';
      g.beginPath();
      g.arc(x, 60, 26, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = '#fff';
      g.stroke();
      g.globalAlpha = 1;
    }
    g.fillStyle = '#fff';
    g.font = 'bold 22px "Segoe UI", sans-serif';
    g.textAlign = 'right';
    g.fillText(`${this.score}`, W - 16, 16);
    g.textAlign = 'left';
    g.fillText(this.combo > 2 ? `${this.combo} combo` : '', 170, 16);
    if (this.judgeT > 0) {
      g.fillStyle = this.judgeText.includes('MISS') ? '#9ab' : '#ffe27a';
      g.font = 'bold 26px "Yu Gothic", sans-serif';
      g.fillText(this.judgeText, HX - 60, 116);
    }
    if (now < this.t0) {
      g.fillStyle = '#fff';
      g.font = 'bold 36px sans-serif';
      g.textAlign = 'center';
      g.fillText(String(Math.ceil((this.t0 - now) / (STEP * 2) / 1)), W / 2, 72);
    }
  }

  update(dt, t) {
    // Visual response (runs even when the NPC drummer plays)
    this.pulse = damp(this.pulse, 0, 8, dt);
    const s = 1 + this.pulse * 0.04;
    this.drum.scale.set(s, s, 1);
    this.stageLightBase.base = 10 + this.pulse * 40;
    this.stageLanternMat.emissiveIntensity *= 1 + this.pulse * 0.6;
    for (const st of this.sticks) {
      st.hit = damp(st.hit, 0, 14, dt);
      st.g.rotation.x = -0.6 - st.hit * 0.9;
    }
    if (!this.active) {
      G.taikoHype = 0;
      return;
    }
    const now = audioTime();
    // Metronome kane on each beat during the count-in.
    while (this.nextTick <= now && this.nextTick < this.t0) {
      sfx.tick(this.tickIdx % 4 === 0);
      this.tickIdx++;
      this.nextTick += STEP * 2;
    }
    for (const n of this.notes) {
      if (!n.judged && now - n.t > 0.13) {
        n.judged = true;
        this.judge('miss', n);
      }
    }
    G.taikoHype = damp(G.taikoHype, Math.min(1.2, this.combo / 10), 3, dt);
    this.judgeT -= dt;
    this.drawLane(now);
    if (now > this.endTime && !this.finished) {
      this.finished = true;
      const total = this.notes.length;
      const acc = Math.round(((this.stats.great + this.stats.good * 0.5) / total) * 100);
      const success = acc >= 50;
      this.ctx.finish('taiko', success, `
        <h2>${success ? '🥁 Splendid performance!' : '🥁 Keep practising!'}</h2>
        <p>Score <b>${this.score}</b> · Accuracy <b>${acc}%</b> · Max combo <b>${this.maxCombo}</b></p>
        <p>良 Great ${this.stats.great} · 可 Good ${this.stats.good} · 不可 Miss ${this.stats.miss}</p>
        <p class="muted">Visitors' behaviour trees switched to "Gather at taiko" while you played; they cheer as your combo grows.</p>
        ${success ? '<p>🎆 Unlocked: <b>Taiko double-ring</b> firework pattern</p>' : '<p class="muted">Reach 50% accuracy to unlock a firework pattern.</p>'}`);
    }
  }
}
