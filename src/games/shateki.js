import * as THREE from 'three';
import { buildBooth } from '../booth.js';
import { L } from '../layout.js';
import { G, emit } from '../state.js';
import { sfx } from '../audio.js';
import { sphereAABB } from '../collision.js';
import { canvasTexture, rand } from '../util.js';

const B = L.shateki; // booth opens toward -z
const SHELF_Z = B.z + 1.25; // shelf centre
const SHELF_D = 0.36;
const TIERS = [0.95, 1.42, 1.89];
const GRAV = 9.8;
const CORK_R = 0.028;
const CORK_SPEED = 15;

const PRIZES = [
  { name: 'Candy box', kind: 'box', w: 0.2, h: 0.28, d: 0.1, mass: 1, color: '#ff7aa8' },
  { name: 'Caramel', kind: 'box', w: 0.14, h: 0.2, d: 0.08, mass: 0.7, color: '#ffd24a' },
  { name: 'Daruma', kind: 'daruma', w: 0.2, h: 0.24, d: 0.2, mass: 2.4, color: '#d8262a' },
  { name: 'Ramune', kind: 'can', w: 0.12, h: 0.26, d: 0.12, mass: 1.3, color: '#6ad0ff' },
  { name: 'Game card', kind: 'box', w: 0.24, h: 0.32, d: 0.06, mass: 0.8, color: '#7c6aff' },
  { name: 'Lucky cat', kind: 'box', w: 0.18, h: 0.22, d: 0.16, mass: 1.8, color: '#ffffff' },
];

function darumaTex() {
  return canvasTexture(128, 64, (g) => {
    g.fillStyle = '#d8262a';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#f6e7d0';
    g.beginPath();
    g.ellipse(96, 28, 18, 16, 0, 0, 7);
    g.fill();
    g.fillStyle = '#111';
    g.beginPath();
    g.arc(90, 26, 4, 0, 7);
    g.arc(102, 26, 4, 0, 7);
    g.fill();
  });
}

// Shateki: cork-gun ballistics, sphere-vs-box collisions, momentum-based toppling.
export class Shateki {
  constructor(ctx) {
    this.ctx = ctx;
    this.title = 'Shateki 射的';
    const world = ctx.world;
    buildBooth(world, { pos: B, flip: true, sign: '射的', signBg: '#3a2a10', awning: ['#e8a21c', '#ffffff'], counter: true });

    const wood = new THREE.MeshStandardMaterial({ color: '#8a6440', roughness: 0.8 });
    this.statics = [];
    const addStatic = (w, h, d, x, y, z, mat = wood) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      world.scene.add(m);
      this.statics.push({ min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2) });
    };
    for (const y of TIERS) addStatic(3.8, 0.04, SHELF_D, B.x, y - 0.02, SHELF_Z);
    addStatic(0.06, 1.6, SHELF_D, B.x - 1.93, 1.2, SHELF_Z);
    addStatic(0.06, 1.6, SHELF_D, B.x + 1.93, 1.2, SHELF_Z);
    addStatic(4.2, 2.2, 0.04, B.x, 1.1, SHELF_Z + 0.55, new THREE.MeshStandardMaterial({ color: '#7a1a1a', roughness: 0.95 })); // curtain behind

    this.prizeGeo = {
      box: (p) => new THREE.BoxGeometry(p.w, p.h, p.d).translate(0, p.h / 2, 0),
      can: (p) => new THREE.CylinderGeometry(p.w / 2, p.w / 2, p.h, 14).translate(0, p.h / 2, 0),
      daruma: (p) => new THREE.SphereGeometry(p.w / 2, 16, 12).scale(1, p.h / p.w, 1).translate(0, p.h / 2, 0),
    };
    this.darumaMat = new THREE.MeshStandardMaterial({ map: darumaTex(), roughness: 0.5 });
    this.prizes = [];
    this.stock();

    // Cork gun held in view (child of camera)
    const gun = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.55, 10).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#333', metalness: 0.6, roughness: 0.35 }));
    barrel.position.z = -0.25;
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.3), new THREE.MeshStandardMaterial({ color: '#7a4a24' }));
    stock.position.set(0, -0.03, 0.12);
    const cork = new THREE.Mesh(new THREE.SphereGeometry(CORK_R, 10, 8), new THREE.MeshStandardMaterial({ color: '#c9a06a' }));
    cork.position.z = -0.53;
    gun.add(barrel, stock, cork);
    gun.visible = false;
    this.gun = gun;
    this.gunCork = cork;
    ctx.camera.add(gun);
    this.corkGeo = new THREE.SphereGeometry(CORK_R, 10, 8);
    this.corkMat = cork.material;
    this.corks = [];

    this.cameraPose = { pos: new THREE.Vector3(B.x, 1.55, B.z - 2.7), look: new THREE.Vector3(B.x, 1.35, SHELF_Z) };
    this.interact = { id: 'shateki', pos: new THREE.Vector3(B.x, 0, B.z - 2.9), label: 'Play Shooting Gallery (¥400)' };
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.active = false;
  }

  stock() {
    for (const p of this.prizes) this.ctx.world.scene.remove(p.mesh);
    this.prizes = [];
    TIERS.forEach((y, tier) => {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const def = PRIZES[(i * 7 + tier * 3 + Math.floor(rand(0, 2))) % PRIZES.length];
        const geo = this.prizeGeo[def.kind](def);
        const mat = def.kind === 'daruma' ? this.darumaMat : new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.5 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        const x = B.x - 1.5 + (i / (n - 1)) * 3;
        mesh.position.set(x + rand(-0.08, 0.08), y, SHELF_Z - 0.05);
        if (def.kind === 'daruma') mesh.rotation.y = -Math.PI / 2; // face the shooter
        this.ctx.world.scene.add(mesh);
        this.prizes.push({ def, mesh, tierY: y, state: 'rest', wobble: 0, wobV: 0, vel: new THREE.Vector3(), ang: 0, angV: 0 });
      }
    });
  }

  enter() {
    this.active = true;
    this.ammo = 8;
    this.won = [];
    this.endT = null;
    this.stock();
    this.gun.visible = true;
    this.gun.position.set(0.16, -0.17, -0.25);
    this.recoil = 0;
    this.ctx.ui.gameHud(`
      <div class="gh-title">射的 Shooting Gallery</div>
      <div>Click to fire a cork · corks drop with gravity — aim a little high · knock prizes <b>off</b> the shelf</div>
      <div>Corks: <b id="sh-ammo"></b> · Prizes: <b id="sh-won">0</b> · Esc to leave</div>`);
    this.updateHud();
    document.body.classList.add('aiming');
  }

  exit() {
    this.active = false;
    this.gun.visible = false;
    document.body.classList.remove('aiming');
  }

  updateHud() {
    const a = document.getElementById('sh-ammo');
    if (a) a.textContent = '🟤'.repeat(this.ammo) || '—';
    const w = document.getElementById('sh-won');
    if (w) w.textContent = this.won.length ? this.won.join(', ') : '0';
  }

  pointerMove(ndc) {
    this.ndc.copy(ndc);
  }

  pointerDown(e) {
    if (!this.active || this.ammo <= 0 || e.button !== 0) return;
    this.ammo--;
    this.updateHud();
    const cam = this.ctx.camera;
    this.raycaster.setFromCamera(this.ndc, cam);
    const muzzle = this.gunCork.getWorldPosition(new THREE.Vector3());
    // Aim point on the shelf plane.
    const ray = this.raycaster.ray;
    const tHit = (SHELF_Z - 0.1 - ray.origin.z) / ray.direction.z;
    const aim = ray.at(tHit > 0 ? tHit : 4, new THREE.Vector3());
    const flight = aim.distanceTo(muzzle) / CORK_SPEED;
    // Launch velocity: straight line + 75% gravity compensation, plus slight spread.
    const v = aim.clone().sub(muzzle).divideScalar(flight);
    v.y += 0.5 * GRAV * flight * 0.75;
    v.x += rand(-0.12, 0.12);
    v.y += rand(-0.12, 0.12);
    const mesh = new THREE.Mesh(this.corkGeo, this.corkMat);
    mesh.position.copy(muzzle);
    this.ctx.world.scene.add(mesh);
    this.corks.push({ mesh, p: muzzle, v, life: 3, hit: false });
    this.recoil = 1;
    sfx.pop();
  }

  prizeBox(pr) {
    const d = pr.def;
    const p = pr.mesh.position;
    return { min: new THREE.Vector3(p.x - d.w / 2, p.y, p.z - d.d / 2), max: new THREE.Vector3(p.x + d.w / 2, p.y + d.h, p.z + d.d / 2) };
  }

  hitPrize(pr, cork, c) {
    // Momentum transfer from the cork (mass ~ 1 unit vs prize mass).
    const speed = cork.v.length();
    const push = (speed * 0.06) / pr.def.mass;
    const lever = (c.py - pr.mesh.position.y) / pr.def.h; // 0 = base, 1 = top
    const torque = push * (0.3 + lever);
    const stability = (pr.def.d / pr.def.h) * 0.9;
    sfx.thock();
    if (torque > stability) {
      pr.state = 'fall';
      pr.angV = torque * 9;
      pr.vel.set(cork.v.x * 0.02, 0.4, Math.max(0.6, cork.v.z * 0.06 / pr.def.mass));
    } else {
      // Not enough to topple: wobble and slide back a little; slid past the edge -> falls.
      pr.wobV += torque * 12;
      pr.mesh.position.z += push * 0.25;
      if (pr.mesh.position.z > SHELF_Z + SHELF_D / 2 - pr.def.d * 0.2) {
        pr.state = 'fall';
        pr.angV = 2;
        pr.vel.set(0, 0, 0.5);
      }
    }
  }

  update(dt) {
    // Corks: ballistic flight integrated in sub-steps with collision tests.
    const steps = 4;
    const h = dt / steps;
    for (let i = this.corks.length - 1; i >= 0; i--) {
      const ck = this.corks[i];
      for (let s = 0; s < steps; s++) {
        ck.v.y -= GRAV * h;
        ck.v.multiplyScalar(Math.exp(-0.25 * h));
        ck.p.addScaledVector(ck.v, h);
        if (!ck.hit) {
          for (const pr of this.prizes) {
            if (pr.state !== 'rest') continue;
            const bx = this.prizeBox(pr);
            const c = sphereAABB(ck.p, CORK_R, bx.min, bx.max);
            if (c) {
              this.hitPrize(pr, ck, c);
              ck.hit = true;
              ck.v.set(ck.v.x * 0.2, 1, -ck.v.z * 0.15);
              break;
            }
          }
        }
        for (const st of this.statics) {
          const c = sphereAABB(ck.p, CORK_R, st.min, st.max);
          if (c) {
            ck.p.x += c.nx * c.depth;
            ck.p.y += c.ny * c.depth;
            ck.p.z += c.nz * c.depth;
            const vn = ck.v.x * c.nx + ck.v.y * c.ny + ck.v.z * c.nz;
            if (vn < 0) {
              ck.v.x -= 1.4 * vn * c.nx;
              ck.v.y -= 1.4 * vn * c.ny;
              ck.v.z -= 1.4 * vn * c.nz;
              ck.v.multiplyScalar(0.6);
              if (!ck.hit) sfx.thock();
              ck.hit = true;
            }
          }
        }
        if (ck.p.y < CORK_R) {
          ck.p.y = CORK_R;
          ck.v.y = Math.abs(ck.v.y) * 0.3;
          ck.v.x *= 0.7;
          ck.v.z *= 0.7;
        }
      }
      ck.mesh.position.copy(ck.p);
      ck.life -= dt;
      if (ck.life <= 0) {
        this.ctx.world.scene.remove(ck.mesh);
        this.corks.splice(i, 1);
      }
    }

    // Prizes
    let busy = false;
    for (const pr of this.prizes) {
      const m = pr.mesh;
      if (pr.state === 'rest') {
        // Damped spring wobble.
        pr.wobV += (-pr.wobble * 60 - pr.wobV * 6) * dt;
        pr.wobble += pr.wobV * dt;
        m.rotation.x = pr.wobble;
        if (Math.abs(pr.wobble) > 0.01) busy = true;
      } else if (pr.state === 'fall') {
        busy = true;
        pr.vel.y -= GRAV * dt;
        m.position.addScaledVector(pr.vel, dt);
        pr.ang = Math.min(Math.PI / 2 + 0.3, pr.ang + pr.angV * dt);
        pr.angV += 6 * dt;
        m.rotation.x = pr.ang;
        if (m.position.y < pr.tierY - 0.35 && !pr.counted) {
          pr.counted = true;
          this.won.push(pr.def.name);
          G.prizes.push(pr.def.name);
          sfx.prize();
          emit('cheer', this.cameraPose.pos);
          this.ctx.ui.toast(`🎯 Won a ${pr.def.name}!`);
          this.updateHud();
        }
        if (m.position.y < 0.02) {
          m.position.y = 0.02;
          pr.state = 'down';
        }
      }
    }

    if (this.active) {
      this.recoil = Math.max(0, this.recoil - dt * 6);
      this.gun.position.z = -0.25 + this.recoil * 0.06;
      // Point the gun toward the mouse ray.
      this.gun.rotation.set(this.ndc.y * 0.35 + this.recoil * 0.15, -this.ndc.x * 0.55, 0);
      if (this.ammo <= 0 && this.corks.length === 0 && !busy && this.endT === null) this.endT = 1;
      if (this.endT !== null) {
        this.endT -= dt;
        if (this.endT <= 0) {
          this.endT = -1;
          const success = this.won.length > 0;
          this.ctx.finish('shateki', success, `
            <h2>${success ? '🎯 Great shooting!' : '🎯 Nothing fell…'}</h2>
            <p>Prizes won: <b>${this.won.length ? this.won.join(', ') : 'none'}</b></p>
            <p class="muted">Physics: corks follow a ballistic arc (gravity + drag). A prize topples when the
            cork's momentum × hit height beats its stability (base depth ÷ height), so aim high on tall, light prizes.</p>
            ${success ? '<p>🎆 Unlocked: <b>Crossette</b> firework pattern</p>' : ''}`);
        }
      }
    }
  }
}
