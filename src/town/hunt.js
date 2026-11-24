import * as THREE from 'three';
import { Town, townSpawn } from './town.js';
import { HeirloomQuest, S } from './quest.js';
import { Villager } from './villagers.js';
import { Tanuki } from './tanuki.js';

// Festival locations used by the quest (world coordinates, see layout.js).
const FESTIVAL = {
  taiko: new THREE.Vector3(26, 0, -6.6),
  shrine: new THREE.Vector3(44.9, 0, 0),
  townGate: new THREE.Vector3(13.4, 0, 3.7),
  forest: new THREE.Vector3(32, 0, -3.4),
};
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
    // Investigation 1: three pieces of evidence at the cart, examined separately, then a deduction.
    this.evidence = new Set();
    const cart = Q.worldPoint('cart');
    const EVIDENCE = [
      ['cord', -0.9, 0, 'Inspect the torn cord', 'The red-and-white bell cord is <b>torn, not cut</b> — frayed and chewed, as if pulled free by small teeth.'],
      ['crumbs', 0.9, 0, 'Inspect the cart boards', 'Sticky <b>pink-and-white dango crumbs</b> are scattered over the boards, and a skewer has been licked clean.'],
      ['tracks', 0, -1.3, 'Inspect the tracks in the dust', 'Small <b>four-toed paw prints</b>, too small for a dog, lead away from the cart <b>toward the north path</b>.'],
    ];
    for (const [key, dx, dz, label, text] of EVIDENCE) {
      this.world.interactables.push({
        id: `evidence-${key}`, pos: cart.clone().add(new THREE.Vector3(dx, 0, dz)), radius: 1.2, priority: true,
        label: () => (this.evidence.has(key) ? `${label} (noted)` : label),
        enabled: () => inTown() && Q.state === S.FIND_CORD,
        action: () => {
          sfx.chime();
          this.dialog([{ name: 'Evidence', role: `${this.evidence.size + (this.evidence.has(key) ? 0 : 1)} / 3`, text }], () => {
            this.evidence.add(key);
            Q.note({ cord: 'Torn cord', crumbs: 'Dango crumbs', tracks: 'Paw prints' }[key], text.replace(/<[^>]+>/g, ''));
            if (this.evidence.size === 3) this.deduceThief();
            else this.ui.toast(`Evidence noted (${this.evidence.size} / 3)`);
          });
        },
      });
    }
    // Investigation 3: the den at the end of the north path (only once the right lead is followed).
    this.denPos = this.town.toWorld(1.7, -12.8);
    this.world.interactables.push({
      id: 'den', pos: this.denPos, radius: 1.8, priority: true,
      label: 'Search the hollow under the bushes',
      enabled: () => inTown() && Q.state === S.ASK_SHOPKEEPER && this.lead === 'north',
      action: () => {
        sfx.chime();
        this.dialog([
          { name: 'The hollow', text: 'A nest of dry leaves — and <b>six licked-clean dango skewers</b>. The thief lives here.' },
          { name: 'The hollow', text: 'Pinned under a skewer: a crumpled <b>festival programme</b>. One line is chewed: “<b>Taiko performance — 19:00</b>”. The leaves are flattened as if something left in a hurry.' },
        ], () => {
          Q.note('The den', 'Dango skewers and a chewed festival programme: “Taiko performance — 19:00”.');
          this.deduceWhen();
        });
      },
    });
    this.world.interactables.push({
      id: 'tanuki', pos: this.tanuki.pos, radius: 2.4, priority: true,
      label: 'Grab the tanuki', enabled: () => inTown() && !this.struggle && Q.state === S.FIND_TANUKI && this.tanuki.canBeCaught,
      action: () => this.startStruggle(),
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

  // ---------------------------------------------------------------- bell recovery: a timing struggle
  // Grabbing the tanuki is only the start: a marker swings across a bar and the player must press
  // Space inside the target zone. Each hit shrinks the zone and speeds the marker; three hits pry the
  // bell loose. Two misses (or hesitating too long) and it wriggles free and bolts — sneak up again.
  startStruggle() {
    if (this.struggle) return;
    sfx.splash?.(0.4);
    this.player.shake = 0.15;
    this.player.enabled = false;
    this.tanuki.hold();
    this.struggle = { hits: 0, misses: 0, t: 0, ready: 1.6, phase: -Math.PI / 2, speed: 1.5, zone: 0.5, center: 0.5 + (Math.random() - 0.5) * 0.3, time: 16, fb: '', fbT: 0 };
    this.duelEl = this.duelEl || Object.assign(document.createElement('div'), { id: 'duel' });
    if (!this.duelEl.parentNode) document.body.appendChild(this.duelEl);
    this.duelEl.classList.add('on');
    this.struggleKey = (e) => {
      if (e.code !== 'Space' && e.code !== 'KeyE') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!e.repeat) this.struggleHit();
    };
    addEventListener('keydown', this.struggleKey, true);
    sfx.don?.(0.4);
  }

  markerPos() {
    const s = this.struggle;
    return 0.5 + 0.5 * Math.sin(s.phase + Math.max(0, s.t - s.ready) * s.speed);
  }

  duelFx(cls, text, color) {
    const s = this.struggle;
    s.fb = `<span style="color:${color}">${text}</span>`;
    s.fbT = 0.7;
    this.duelEl.classList.remove('hit', 'miss');
    void this.duelEl.offsetWidth;
    this.duelEl.classList.add(cls);
  }

  struggleHit() {
    const s = this.struggle;
    if (!s || s.t < s.ready) return; // presses during "Get ready" are ignored, not punished
    const m = this.markerPos();
    if (Math.abs(m - s.center) <= s.zone / 2) {
      s.hits++;
      sfx.chime();
      sfx.don?.(0.25 + s.hits * 0.15);
      this.player.shake = 0.08;
      this.duelFx('hit', ['', 'Got a grip!', 'Hold on!', 'Got it!'][s.hits], '#7cf29a');
      if (s.hits >= 3) {
        s.done = 0.6; // let the success register before the bell drops
        return;
      }
      s.zone *= 0.85; // a little tighter
      s.speed *= 1.15; // a little faster
      s.center = 0.25 + Math.random() * 0.5;
    } else {
      s.misses++;
      sfx.fail?.();
      this.duelFx('miss', s.misses >= 3 ? 'It slipped away!' : s.misses === 2 ? 'Slipped! One more and it escapes' : 'Slipped! Wait for the gold zone', '#ff6a5a');
      if (s.misses >= 3) s.lost = 0.6;
    }
  }

  endStruggle(won) {
    removeEventListener('keydown', this.struggleKey, true);
    this.struggle = null;
    this.duelEl.classList.remove('on');
    this.player.enabled = true;
    if (won) {
      this.quest.note('The struggle', 'Held on through the tanuki’s wriggling until it let go of the bell.');
      sfx.suzu();
      this.quest.burst(this.tanuki.pos.clone());
      this.ui.toast('You pried the bell loose! The tanuki scampers off.');
      this.tanuki.catch(this.player.pos);
    } else {
      this.tanuki.escapeFrom(this.player.pos);
      this.ui.toast('It wriggled free and bolted! Track it down and try again — time your grip.');
    }
  }

  updateStruggle(dt) {
    const s = this.struggle;
    s.t += dt;
    if (s.t > s.ready) s.time -= dt;
    s.fbT -= dt;
    if (s.done !== undefined && (s.done -= dt) <= 0) return this.endStruggle(true);
    if (s.lost !== undefined && (s.lost -= dt) <= 0) return this.endStruggle(false);
    if (s.time <= 0) {
      this.duelFx('miss', 'Too slow — it slipped away!', '#ff6a5a');
      return this.endStruggle(false);
    }
    const m = this.markerPos();
    const pips = [0, 1, 2].map((i) => `<span class="${i < s.hits ? 'on' : 'off'}">●</span>`).join('') + '&nbsp;&nbsp;' + [0, 1, 2].map((i) => `<span class="${i < s.misses ? 'x' : 'off'}">✕</span>`).join('');
    const sub = s.t < s.ready ? 'Get ready… press <b>SPACE</b> when the white marker is inside the gold zone' : `Press <b>SPACE</b> when the marker is in the gold zone · 3 grips win · 3 slips and it escapes · ${Math.ceil(s.time)}s`;
    this.duelEl.innerHTML = `<div class="dt">${s.t < s.ready ? 'You grabbed the thief!' : 'Hold on!'}</div><div class="ds">${sub}</div>
      <div class="track"><div class="zone" style="left:${(s.center - s.zone / 2) * 100}%;width:${s.zone * 100}%"></div><div class="marker" style="left:${m * 100}%"></div></div>
      <div class="pips">${pips}</div><div class="fb" style="opacity:${s.fbT > 0 ? 1 : 0}">${s.fb}</div>`;
  }

  // Called by the festival when an activity finishes (the hunt reaches into the festival's games).
  onActivity(id) {
    if (id === 'taiko' && this.quest.advance(S.PLAY_DRUMS, S.FIND_TANUKI)) {
      this.tanuki.appear();
      this.ui.toast('The drums echo over the rooftops. In the Old Town, something small begins to jingle…');
    }
  }

  // Called by the festival shrine. Returns true if the quest handled the shrine interaction.
  ringAtShrine() {
    const Q = this.quest;
    if (Q.state === S.RING_BELL) {
      sfx.suzu();
      this.dialog([
        { name: 'The Kagura Bell', text: 'You ring the bell before the shrine… and it makes no sound. Not a whisper.' },
        { name: 'A voice in the trees', text: 'The spirit that sang in this bell was taken into the forest by its old guardian, turned bitter and dark. Without it, <b>the festival lights will fade by midnight</b>.' },
        { name: 'A voice in the trees', text: 'Walk the haunted path. Slip past the wandering spirits. Light the four shrine lanterns in the clearing, and the guardian will let it go.' },
      ], () => {
        Q.advance(S.RING_BELL, S.SPIRIT_REALM);
        this.ui.toast('Journal updated: A hollow ring');
      });
      return true;
    }
    if (Q.state === S.RETURN_SPIRIT && Q.advance(S.RETURN_SPIRIT, S.COMPLETE)) {
      sfx.suzu();
      this.onComplete?.();
      this.onFinale?.(() => this.complete());
      return true;
    }
    if (Q.state === S.SPIRIT_REALM) {
      this.ui.toast('The bell is still silent. Its spirit waits in the forest — the haunted path starts by the game plaza.');
      return true;
    }
    return false;
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
          'A small furry thing with a mask on its face? I saw it dash past my stall and up the <b>north path</b>, clutching something that jingled.',
          'Funny thing — yesterday my dango vanished too. Right when the <b>taiko drums started</b> at the festival. Everyone was looking the other way.',
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
        [S.ASK_SHOPKEEPER]: ['The thief? It went out through the <b>south gate</b>, I’m certain. Big fellow, ran on two legs. Mind you, my eyes aren’t what they were after dark…'],
        [S.FIND_TANUKI]: ['Tanuki are cautious. Stand still, and it’ll forget you. Run, and it’s gone.'],
        [S.COMPLETE]: ['That’s the sound I’ve waited for all evening.'],
      },
      aiko: {
        default: ['Each lantern takes a whole day to paper. We light them all for the procession.'],
        [S.ASK_SHOPKEEPER]: ['I heard rustling in the <b>west alley</b> behind my workshop. Then a cat yowled. Could have been anything, really.'],
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
      }
      // Investigation 2: collect the witnesses' accounts, then decide which lead is credible.
      if (Q.state === S.ASK_SHOPKEEPER && !this.lead && ['shopkeeper', 'goro', 'aiko'].includes(v.def.key)) {
        this.witnesses = this.witnesses || new Set();
        this.witnesses.add(v.def.key);
        const said = { shopkeeper: ['Kenta’s account', 'Saw it run up the north path. His dango vanished yesterday when the taiko started.'], goro: ['Goro’s account', 'Says a big two-legged figure left through the south gate. Admits his eyes are poor after dark.'], aiko: ['Aiko’s account', 'Heard rustling and a cat in the west alley.'] }[v.def.key];
        Q.note(...said);
        if (this.witnesses.size === 3) this.deduceLead();
        else this.ui.toast(`Witness heard (${this.witnesses.size} / 3)`);
      }
    });
  }

  // A deduction: the player picks an answer; a wrong one explains why it does not fit, then asks again.
  deduce(title, question, options, onRight) {
    const P = this.player;
    P.enabled = false;
    P.unlock();
    this.ui.complete(
      `<div class="dlg-role">Deduction</div><h2 class="fin">${title}</h2><p>${question}</p><p class="muted">Your journal (J) holds everything you have found.</p>`,
      options.map(([label, right, why]) => [label, () => {
        if (right) {
          sfx.chime();
          P.enabled = true;
          onRight();
        } else {
          sfx.fail?.();
          this.dialog([{ name: 'That doesn’t fit', text: why }], () => this.deduce(title, question, options, onRight));
        }
      }]),
    );
  }

  deduceThief() {
    this.deduce('What took the bell?', 'You have examined the cord, the boards and the dust around the cart.', [
      ['A festival-goer pulled it off', false, 'A person would have <b>cut or untied</b> the cord — this one was chewed. And people don’t leave four-toed prints.'],
      ['A crow carried it away', false, 'A crow can’t carry a heavy bell — and birds don’t leave <b>four-toed paw prints</b> in the dust.'],
      ['A small animal with a sweet tooth', true, ''],
    ], () => {
      this.quest.advance(S.FIND_CORD, S.ASK_SHOPKEEPER);
      this.quest.note('Deduction: the thief', 'A small animal with teeth, four-toed paws and a taste for dango — a tanuki?');
      this.ui.toast('Deduction correct — now find out where it went. Ask around.');
    });
  }

  deduceLead() {
    this.deduce('Which lead do you follow?', 'Three townsfolk told three different stories. Only one fits the evidence from the cart.', [
      ['Goro — the south gate', false, 'Goro saw a <b>big, two-legged</b> figure, and admits his eyes are poor. The thief is small and four-footed — and the prints at the cart lead <b>north</b>.'],
      ['Aiko — the west alley', false, 'Aiko only <b>heard</b> rustling and a cat. Nothing she describes matches the jingling thief, and the prints don’t go west.'],
      ['Kenta — the north path', true, ''],
    ], () => {
      this.lead = 'north';
      this.quest.override = 'Follow Kenta’s lead up the north path — look for where the thief hides';
      this.quest.note('Deduction: the lead', 'Kenta’s account matches the paw prints: the thief went up the north path.');
      this.refreshHud();
      this.ui.toast('Kenta’s story matches the paw prints. Search the north path.');
    });
  }

  deduceWhen() {
    this.deduce('When does the thief come out?', 'The den is empty. To catch the thief, you must know when it leaves its hiding place.', [
      ['At dawn, when the town sleeps', false, 'Nothing points to dawn. Kenta’s dango vanished in the <b>evening</b> — and look at what the programme in the den says.'],
      ['When someone leaves food out', false, 'Food is what it steals, not what calls it out. Kenta’s dango went missing <b>at a particular moment</b> — when?'],
      ['When the festival drums play', true, ''],
    ], () => {
      this.quest.override = null;
      this.quest.advance(S.ASK_SHOPKEEPER, S.PLAY_DRUMS);
      this.quest.note('Deduction: the timing', 'It comes out when the taiko plays and everyone looks the other way. Make the drums play.');
      this.ui.toast('The drums! Play the taiko at the festival to draw the thief out.');
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
      `<div class="dlg-role">Quest complete</div><h2 class="fin">The Lost Festival Spirit</h2>
       <p>You read the clues on the cart, learned the thief’s habits from Kenta, drew it out with the festival drums and crept up on it unseen. In the spirit realm you slipped past the wandering onibi and lit the four lanterns that purified the guardian. The festival spirit sings in the Kagura Bell again, and the lights of Hana Matsuri burn bright.</p>
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
    this.evidence = new Set();
    this.witnesses = new Set();
    this.lead = null;
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
        return null; // the player decides whom to question and which lead to follow
      case S.TAKE_BELL:
        return this.bellPos;
      default:
        return null; // tracking the tanuki and the festival steps are not marked: listen, look, ask
    }
  }

  // People to talk to get a marker; clues and the thief must be found by looking and listening.
  get beaconFor() {
    const st = this.quest.state;
    return st === S.NOT_STARTED || st === S.RETURN_BELL;
  }

  refreshHud() {
    const Q = this.quest;
    if (!Q) return;
    const active = true; // the story is the spine of the game: always show the current objective
    this.ui.questHud(active ? { title: 'The Lost Festival Spirit', objective: Q.objective, clues: Q.clues, bell: Q.hasBell, done: Q.state === S.COMPLETE } : null);
    this.ui.questJournal(Q.journal(), Q.objective);
  }

  // Festival-side guidance for the steps that happen there (direct line: the festival is open ground).
  updateFestival(dt) {
    const st = this.quest?.state;
    const goal = this.festivalGoal ?? (st === S.NOT_STARTED ? FESTIVAL.townGate : st === S.PLAY_DRUMS ? FESTIVAL.taiko : st === S.RING_BELL || st === S.RETURN_SPIRIT ? FESTIVAL.shrine : st === S.SPIRIT_REALM ? FESTIVAL.forest : null);
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
    if (this.struggle) this.updateStruggle(dt);
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
        const hint = this.struggle ? 'Hold on!' : this.tanuki.state === 'flee' ? 'It saw you — let it settle down' : d < 2.4 ? 'Right next to you — press E to grab it!' : d < 4 ? 'The jingling is right here — crouch (C) and creep closer' : d < 9 ? 'The jingle is close' : d < 20 ? 'A faint jingle somewhere nearby' : 'Search the town and listen';
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
