import * as THREE from 'three';
import { Town, townSpawn } from './town.js';
import { HeirloomQuest, S } from './quest.js';
import { Villager } from './villagers.js';
import { Tanuki } from './tanuki.js';

// Festival locations used by the quest (world coordinates, see layout.js).
const FESTIVAL = { taiko: new THREE.Vector3(26, 0, -6.6), shrine: new THREE.Vector3(44.9, 0, 0) };
import { sfx } from '../audio.js';

// Town Treasure Hunt controller: area switching, villagers, clue interactions, dialogue and the
// Start -> Active -> End -> Reset loop. All progress changes go through quest.advance().
const VILLAGERS = [
  {
    key: 'organizer', name: 'Hanae Sato', role: 'Festival organizer', at: [-1.6, 2.4], heading: 1.1, scan: 0.5,
    gender: 'f', yukata: ['#2d4a8a', '#f4e7c8'], obi: '#f2c14e', greet: 'Excuse me — could you help me?',
    patrol: [[-1.6, 2.4], [-0.3, 0.6]], speed: 0.6,
  },
  {
    key: 'shopkeeper', name: 'Kenta Mori', role: 'Dango seller', at: [-1.5, -2.2], heading: 0, scan: 0.6,
    gender: 'm', yukata: ['#5a3a2a', '#c9b48a'], obi: '#222222', greet: 'Dango, fresh off the grill!', anim: 'cook',
  },
  {
    key: 'child', name: 'Yuki', role: 'Village child', at: [2.6, -7.2], heading: Math.PI, scan: 0.9, range: 7,
    gender: 'f', yukata: ['#e86a92', '#ffffff'], obi: '#ffffff', child: true, greet: 'Are you here for the procession?',
    patrol: [[2.6, -7.2], [1.7, -11.8], [0.8, -1.2]], speed: 1.1,
  },
  {
    key: 'goro', name: 'Goro', role: 'Retired carpenter', at: [3.0, 2.0], heading: 0, scan: 0.5,
    gender: 'm', yukata: ['#3a3f4a', '#9aa4b8'], obi: '#6a5a3a', greet: 'Evening.',
    patrol: [[3.0, 2.0], [5.3, 6.0], [-2.0, 3.6]], speed: 0.55,
  },
  {
    key: 'aiko', name: 'Aiko', role: 'Lantern maker', at: [-4.6, 2.2], heading: Math.PI / 2, scan: 0.6,
    gender: 'f', yukata: ['#6a2d3a', '#f2c6a0'], obi: '#d4a02a', greet: 'Mind the lanterns, they’re still drying.',
    patrol: [[-4.6, 2.2], [-3.2, -4.6], [0.4, -3.0]], speed: 0.75,
  },
];

export class TreasureHunt {
  constructor({ world, player, ui, onArea, onComplete, onFinale }) {
    this.onComplete = onComplete;
    this.onFinale = onFinale;
    this.world = world;
    this.player = player;
    this.ui = ui;
    this.onArea = onArea;
    this.area = 'festival';
    this.mode = 'fovlos'; // perception mode: 'fovlos' (prototype) or 'radius' (comparison)
    this.debug = false;
    this.talking = null;
    this.bellPos = new THREE.Vector3();
    this.jingleT = 0;
  }

  async load() {
    this.town = new Town(this.world);
    await this.town.load();
    this.town.cb.enter = () => this.enter();
    this.town.cb.exit = () => this.exit();
    this.quest = new HeirloomQuest(this.town);
    this.villagers = {};
    for (const d of VILLAGERS) this.villagers[d.key] = new Villager(this.town, d);
    // Villagers are solid: the player walks around them. Their collider follows them as they patrol.
    for (const v of Object.values(this.villagers)) {
      this.world.colliders.addCircle(v.pos.x, v.pos.z, 0.28, 'villager');
      v.collider = this.world.colliders.circles[this.world.colliders.circles.length - 1];
    }
    this.tanuki = new Tanuki(this.town, {
      onDrop: (pos) => this.onBellDropped(pos),
      onFlee: (pos, n) => this.onTanukiFled(pos, n),
    });
    this.quest.onChange(() => this.refreshHud());

    const Q = this.quest;
    const inTown = () => this.area === 'town' && !this.talking;
    for (const v of Object.values(this.villagers)) {
      // Interaction depends on perception: a villager who has not noticed you must be hailed first.
      this.world.interactables.push({
        id: `villager-${v.def.key}`, pos: v.pos, radius: 1.9, enabled: inTown,
        label: () => (v.noticed ? `Talk to ${v.name}` : `Call out to ${v.name}`),
        action: () => this.interact(v),
      });
    }
    this.world.interactables.push({
      id: 'clue-cart', pos: Q.worldPoint('cart'), radius: 1.8, priority: true,
      label: 'Examine the festival cart', enabled: () => inTown() && Q.state === S.FIND_CORD,
      action: () => {
        sfx.chime();
        this.dialog([
          { name: 'The festival cart', text: 'The bell stand is empty. A <b>red-and-white cord</b> hangs from it, torn — not cut. Someone pulled the bell free with their teeth.' },
          { name: 'The festival cart', text: 'Pink-and-white <b>dango crumbs</b> on the boards, and small four-toed <b>paw prints</b> in the dust, heading north.' },
        ], () => {
          Q.advance(S.FIND_CORD, S.ASK_SHOPKEEPER);
          this.ui.toast('Journal updated: The cart');
        });
      },
    });
    this.world.interactables.push({
      id: 'tanuki', pos: this.tanuki.pos, radius: 1.5, priority: true,
      label: 'Grab the tanuki', enabled: () => inTown() && Q.state === S.FIND_TANUKI && this.tanuki.canBeCaught,
      action: () => {
        sfx.splash?.(0.4);
        this.player.shake = 0.15;
        this.tanuki.catch(this.player.pos);
      },
    });
    this.world.interactables.push({
      id: 'clue-bell', pos: this.bellPos, radius: 1.6, priority: true,
      label: 'Pick up the Kagura Bell', enabled: () => inTown() && Q.state === S.TAKE_BELL,
      action: () => this.takeBell(),
    });
    this.lines = this.buildLines();
    this.refreshHud();
  }

  // ---------------------------------------------------------------- story events
  onBellDropped(pos) {
    this.quest.dropBell(pos);
    this.bellPos.copy(pos);
    this.quest.advance(S.FIND_TANUKI, S.TAKE_BELL);
    this.ui.toast('The tanuki dropped the bell and bolted!');
    for (const v of Object.values(this.villagers)) v.react('tanuki', pos, 'There goes the thief!');
  }

  onTanukiFled(pos, n) {
    sfx.jingle(0.9);
    let seenBy = 0;
    for (const v of Object.values(this.villagers)) if (v.react('tanuki', pos, ['A tanuki!', 'Was that the thief?', 'Look — it’s carrying something!'][n % 3])) seenBy++;
    if (n === 3 && !this.hinted) {
      this.hinted = true;
      this.ui.toast('Tanuki see a wide arc in front and hear running feet. Hold C to crouch and approach from behind.');
    }
    return seenBy;
  }

  takeBell() {
    const Q = this.quest;
    sfx.suzu();
    setTimeout(() => sfx.chime(), 350);
    this.player.shake = 0.12;
    this.quest.burst(this.bellPos);
    for (const v of Object.values(this.villagers)) v.react('cheer', this.player.pos, ['The bell!', 'You found it!', 'The Kagura Bell!'][Math.floor(Math.random() * 3)]);
    this.dialog([{ name: 'The Kagura Bell', text: 'Five golden bells on a red handle, still warm from the lantern light. It rings softly as you lift it — <b>the festival heirloom is safe</b>.' }], () => {
      Q.advance(S.TAKE_BELL, S.RETURN_BELL);
      this.ui.toast('Journal updated: The heirloom');
    });
  }

  // Called by the festival when an activity finishes (the hunt reaches into the festival's games).
  onActivity(id) {
    if (id === 'taiko' && this.quest.advance(S.PLAY_DRUMS, S.FIND_TANUKI)) {
      this.tanuki.appear();
      this.ui.toast('The drums echo over the rooftops. In the Old Town, something small begins to jingle…');
    }
  }

  // Called by the festival shrine. Returns true if it started the quest finale.
  ringAtShrine() {
    if (!this.quest.advance(S.RING_BELL, S.COMPLETE)) return false;
    sfx.suzu();
    this.onComplete?.();
    this.onFinale?.(() => this.complete());
    return true;
  }

  buildLines() {
    return {
      organizer: {
        [S.NOT_STARTED]: [
          'Thank goodness — a fresh pair of eyes. I’m Hanae; I run the night procession.',
          'Our <b>Kagura Bell</b> has been taken from its cart. The procession can’t begin until it’s rung at the shrine.',
          'The cart is just across the courtyard. Would you look it over? You notice things, I can tell.',
        ],
        [S.FIND_CORD]: ['The cart is on the east side of the courtyard. Please — anything you can find.'],
        [S.ASK_SHOPKEEPER]: ['Dango crumbs? Then Kenta’s your man. His stall is on the north side of the courtyard.'],
        [S.PLAY_DRUMS]: ['A tanuki that comes out for the drums… the taiko stage is in the festival, through the torii.'],
        [S.FIND_TANUKI]: ['Listen for the bell. If it sees you coming, it’ll run — be patient.'],
        [S.TAKE_BELL]: ['It dropped it? Quickly, before it changes its mind!'],
        [S.RETURN_BELL]: [
          'You found it. I can hardly believe it — and look, not a scratch.',
          'Will you carry it one last time? Ring it at the <b>shrine at the end of the festival street</b>, and the procession will begin.',
        ],
        [S.RING_BELL]: ['The shrine is at the far end of the festival street, past the great torii.'],
        [S.COMPLETE]: ['Listen to that. Thank you — the whole town heard it tonight.'],
      },
      shopkeeper: {
        default: ['Three on a stick, sweet soy glaze. …Busy night, isn’t it?'],
        [S.ASK_SHOPKEEPER]: [
          'Pink-and-white crumbs? Those are mine. And four-toed prints — that’s our <b>tanuki</b>. It’s been stealing dango all week.',
          'Clever thing. It hides while the town is quiet and only comes out when the <b>festival drums</b> start — everyone’s looking the other way.',
          'The taiko stage in the festival has gone silent. Get those drums going and I’d wager our thief comes out to play.',
        ],
        [S.PLAY_DRUMS]: ['The taiko stage is in the festival plaza. Make some noise.'],
        [S.FIND_TANUKI]: ['Hear that jingle? Tanuki watch the path ahead of them. Come at it from behind — and don’t run, they’ve sharp ears.'],
        [S.COMPLETE]: ['Have a dango, on the house. You earned it.'],
      },
      child: {
        default: ['The procession starts when the bell rings. I’m going to watch from the very front!'],
        [S.ASK_SHOPKEEPER]: ['A tanuki stole Kenta’s dango yesterday. I saw it!'],
        [S.FIND_TANUKI]: ['It went that way! It hides in quiet corners — behind the shops, or up the north path.'],
        [S.COMPLETE]: ['The bell! Now the procession can start!'],
      },
      goro: {
        default: ['Fifty years I’ve carved those shrine gates. Never once heard the bell go missing.'],
        [S.FIND_TANUKI]: ['Tanuki are cautious. Stand still, and it’ll forget you. Run, and it’s gone.'],
        [S.COMPLETE]: ['That’s the sound I’ve waited for all evening.'],
      },
      aiko: {
        default: ['Each lantern takes a whole day to paper. We light them all for the procession.'],
        [S.FIND_TANUKI]: ['Something rustled behind my workshop. The alley to the west, I think.'],
        [S.COMPLETE]: ['Now the lanterns can be carried to the shrine. Thank you.'],
      },
    };
  }

  interact(v) {
    if (!v.noticed) {
      // Hailing works, but the villager is startled — perception decides how an approach plays out.
      v.state = 'notice';
      v.noticeT = 0;
      v.lastSeen = 0;
      v.say('Oh! You startled me!');
      // They turn around, then the conversation starts on its own.
      setTimeout(() => {
        if (this.area === 'town' && !this.talking && !this.ui.panelOpen) this.interact(v);
      }, 900);
      return;
    }
    const set = this.lines[v.def.key];
    const lines = set[this.quest.state] || set.default;
    const Q = this.quest;
    v.state = 'talk';
    this.talking = v;
    this.dialog(lines.map((text) => ({ name: v.name, role: v.role, text })), () => {
      v.state = 'notice';
      v.lastSeen = 0;
      this.talking = null;
      if (v.def.key === 'organizer') {
        if (Q.advance(S.NOT_STARTED, S.FIND_CORD)) this.ui.toast('Quest started: The Missing Festival Heirloom');
        else if (Q.advance(S.RETURN_BELL, S.RING_BELL)) this.ui.toast('Journal updated: The procession');
      } else if (v.def.key === 'shopkeeper') {
        if (Q.advance(S.ASK_SHOPKEEPER, S.PLAY_DRUMS)) this.ui.toast('Journal updated: Kenta’s story');
      }
    });
  }

  dialog(pages, done) {
    const P = this.player;
    P.enabled = false;
    this.ui.dialogue(pages, () => {
      P.enabled = true;
      done?.();
    });
  }

  // Shown after the shrine finale.
  complete() {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.ui.complete(
      `<div class="dlg-role">Quest complete</div><h2 class="fin">The Missing Festival Heirloom</h2>
       <p>You read the clues on the cart, learned the thief’s habits from Kenta, drew it out with the festival drums, crept up on it unseen and carried the Kagura Bell to the shrine. The night procession has begun.</p>
       <p class="muted">Emblem earned · Old Town Treasure Hunt</p>`,
      [
        ['Continue exploring', () => (P.enabled = true)],
        ['Restart the hunt', () => this.restart()],
      ],
    );
  }

  // ---------------------------------------------------------------- game loop: reset / areas
  restart() {
    this.quest.reset();
    this.tanuki.reset();
    this.hinted = false;
    if (this.area !== 'town') {
      this.enter();
      return;
    }
    for (const v of Object.values(this.villagers)) {
      v.state = 'idle';
      v.lastSeen = 99;
    }
    this.ui.fade(() => {
      this.placeInTown();
      this.player.enabled = true;
      this.ui.toast('The hunt has been reset. Speak to Hanae to begin again.');
    });
  }

  placeInTown() {
    const P = this.player;
    P.bounds = this.town.bounds;
    P.groundAt = (x, z) => this.town.heightAt(x, z);
    P.slide = true;
    P.vel.set(0, 0, 0);
    P.place(townSpawn(), 0);
    P.pitch = -0.05;
  }

  enter() {
    this.ui.fade(() => {
      this.area = 'town';
      this.placeInTown();
      if (this.quest.state === S.FIND_TANUKI && this.tanuki.state === 'hidden') this.tanuki.appear();
      this.onArea?.('town');
      this.refreshHud();
      this.player.enabled = true;
      if (!this.introShown) {
        this.introShown = true;
        this.howToPlay();
      }
    });
  }

  exit() {
    this.ui.fade(() => {
      const P = this.player;
      this.area = 'festival';
      P.bounds = undefined;
      P.groundAt = null;
      P.slide = false;
      P.vel.set(0, 0, 0);
      P.place(new THREE.Vector3(12.2, 0, 1.2), -Math.PI / 2);
      this.onArea?.('festival');
      this.refreshHud();
      P.enabled = true;
    });
  }

  howToPlay() {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.ui.panel(`<div class="dlg-role">The Old Town</div><h2 class="fin">The Missing Festival Heirloom</h2>
      <p>The festival’s Kagura Bell has been stolen on the night of the procession. Talk to the townsfolk, read the clues, and track down the thief.</p>
      <p class="muted"><b>E</b> talk / examine · <b>C</b> crouch (quieter, harder to see) · <b>Shift</b> run · <b>J</b> journal. People only notice you when they can see you.</p>`,
    () => (P.enabled = true), 'Begin');
  }

  // Where the player should go next (world position), following the quest state.
  target() {
    const Q = this.quest;
    const V = this.villagers;
    switch (Q.state) {
      case S.NOT_STARTED:
      case S.RETURN_BELL:
        return V.organizer.pos;
      case S.FIND_CORD:
        return Q.worldPoint('cart');
      case S.ASK_SHOPKEEPER:
        return V.shopkeeper.pos;
      case S.TAKE_BELL:
        return this.bellPos;
      default:
        return null; // tracking the tanuki and the festival steps are not marked: listen, look, ask
    }
  }

  // People to talk to get a marker; clues and the thief must be found by looking and listening.
  get beaconFor() {
    const st = this.quest.state;
    return st === S.NOT_STARTED || st === S.ASK_SHOPKEEPER || st === S.RETURN_BELL;
  }

  refreshHud() {
    const Q = this.quest;
    if (!Q) return;
    const active = Q.state !== S.NOT_STARTED || this.area === 'town';
    this.ui.questHud(active ? { title: 'The Missing Festival Heirloom', objective: Q.objective, clues: Q.clues, bell: Q.hasBell, done: Q.state === S.COMPLETE } : null);
    this.ui.questJournal(Q.journal(), Q.objective);
  }

  // Festival-side guidance for the steps that happen there (direct line: the festival is open ground).
  updateFestival(dt) {
    const st = this.quest?.state;
    const goal = st === S.PLAY_DRUMS ? FESTIVAL.taiko : st === S.RING_BELL ? FESTIVAL.shrine : null;
    this.dirT = (this.dirT || 0) - dt;
    if (this.dirT > 0) return;
    this.dirT = 0.15;
    if (!goal) return this.ui.questDir(null);
    const p = this.player;
    const d = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
    const f = p.forward;
    const dx = (goal.x - p.pos.x) / (d || 1);
    const dz = (goal.z - p.pos.z) / (d || 1);
    this.ui.questDir(Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz), d);
  }

  update(dt, t) {
    if (this.area !== 'town') return this.updateFestival(dt);
    const p = this.player;
    this.tanuki.update(dt, t, p);
    // The stolen bell jingles as the tanuki moves: louder when close, muffled behind buildings.
    if (this.quest.state === S.FIND_TANUKI && this.tanuki.root.visible) {
      const d = Math.hypot(this.tanuki.pos.x - p.pos.x, this.tanuki.pos.z - p.pos.z);
      this.jingleT -= dt;
      if (this.jingleT <= 0 && d < 20) {
        this.jingleT = 1.3 + Math.random() * 0.9;
        const muffled = this.tanuki.last && !this.tanuki.last.los ? 0.55 : 1;
        sfx.jingle(Math.pow(1 - d / 20, 1.5) * muffled);
      }
      this.noteT = (this.noteT || 0) - dt;
      if (this.noteT <= 0) {
        this.noteT = 0.25;
        const hint = this.tanuki.state === 'flee' ? 'It saw you — let it settle down' : d < 4 ? 'The jingling is right here' : d < 9 ? 'The jingle is close' : d < 20 ? 'A faint jingle somewhere nearby' : 'Search the town and listen';
        this.ui.questNote(`${hint}${p.crouch > 0.5 ? ' · crouching' : ''}`);
      }
    }
    for (const v of Object.values(this.villagers)) v.update(dt, t, p, this.mode, this.debug);
    // The organizer shows a marker when she is the next person to talk to.
    this.villagers.organizer.marker.visible = false;
    this.villagers.shopkeeper.marker.visible = false;
    this.quest.update(dt, t, p.pos);

    // Guidance: a gold marker above the next goal (visible through buildings), plus direction + distance.
    const tg = this.target();
    if (!this.beacon) {
      this.beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: beaconTexture(), depthTest: false, transparent: true }));
      this.beacon.renderOrder = 10;
      this.town.root.parent.add(this.beacon);
    }
    this.beacon.visible = !!tg && !this.talking && this.beaconFor;
    if (tg) {
      const d = Math.hypot(tg.x - p.pos.x, tg.z - p.pos.z);
      const s = THREE.MathUtils.clamp(d * 0.045, 0.3, 1.2);
      this.beacon.scale.set(s, s, 1);
      this.beacon.position.set(tg.x, this.town.heightAt(tg.x, tg.z) + 2.7 + Math.sin(t * 2.5) * 0.12, tg.z);
      this.beacon.material.opacity = d < 2.5 ? 0.35 : 1;
      // Route along walkable streets (not a straight line through buildings), refreshed 4x per second.
      this.routeT = (this.routeT || 0) - dt;
      if (this.routeT <= 0) {
        this.routeT = 0.25;
        const o = this.town.root.position;
        this.route = this.town.findPath([p.pos.x - o.x, p.pos.z - o.z], [tg.x - o.x, tg.z - o.z]).map(([x, z]) => [x + o.x, z + o.z]);
      }
      // Steer towards a point ~2.5 m ahead along the route; distance = remaining walking distance.
      let wx = tg.x;
      let wz = tg.z;
      let walk = 0;
      let px = p.pos.x;
      let pz = p.pos.z;
      let picked = false;
      for (const [x, z] of this.route || []) {
        walk += Math.hypot(x - px, z - pz);
        px = x;
        pz = z;
        if (!picked && walk >= 2.5) {
          wx = x;
          wz = z;
          picked = true;
        }
      }
      if (!this.route?.length) walk = d;
      const f = p.forward;
      const wd = Math.hypot(wx - p.pos.x, wz - p.pos.z) || 1;
      const dx = (wx - p.pos.x) / wd;
      const dz = (wz - p.pos.z) / wd;
      const ang = Math.atan2(f.x * dz - f.z * dx, f.x * dx + f.z * dz);
      this.dirT = (this.dirT || 0) - dt;
      if (this.dirT <= 0) {
        this.dirT = 0.1; // HUD text at 10 Hz is plenty and avoids per-frame DOM work
        this.ui.questDir(ang, d < 2.5 ? d : Math.max(d, walk));
      }
    } else if (this.quest.state !== S.FIND_TANUKI) {
      this.ui.questDir(null);
    }
  }

  setDebug(on) {
    this.debug = on;
  }

  // Aggregate perception statistics (radius-only vs FOV + line of sight).
  stats() {
    const out = { senses: 0, radiusHits: 0, fovLosHits: 0, falsePositivesAvoided: 0 };
    for (const v of Object.values(this.villagers)) for (const k in out) out[k] += v.stats[k];
    return out;
  }
}

let beaconTex = null;
function beaconTexture() {
  if (beaconTex) return beaconTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 54, 4, 64, 54, 60);
  grd.addColorStop(0, 'rgba(255,220,120,0.55)');
  grd.addColorStop(1, 'rgba(255,200,80,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#ffd24a';
  g.strokeStyle = '#4a2a08';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(34, 30);
  g.lineTo(94, 30);
  g.lineTo(64, 92);
  g.closePath();
  g.stroke();
  g.fill();
  beaconTex = new THREE.CanvasTexture(c);
  beaconTex.colorSpace = THREE.SRGBColorSpace;
  return beaconTex;
}
