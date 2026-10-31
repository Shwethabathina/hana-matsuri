import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { World } from './world.js';
import { Player, EYE } from './player.js';
import { NavGrid } from './nav.js';
import { NPCSystem } from './npc.js';
import { Fireworks } from './fireworks.js';
import { Goldfish } from './games/goldfish.js';
import { Shateki } from './games/shateki.js';
import { Taiko } from './games/taiko.js';
import { Kimodameshi } from './games/kimodameshi.js';
import { TreasureHunt } from './town/hunt.js';
import { S as QS } from './town/quest.js';
import { buildBooth } from './booth.js';
import { buildStallGoods } from './stallgoods.js';
import { createUI } from './ui.js';
import { G } from './state.js';
import { initAudio, setAmbience, sfx } from './audio.js';
import { L, STALLS, stallFront, KIMO_PATH, WORLD_BOUNDS } from './layout.js';
import { damp, lerp, pick } from './util.js';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
let quality = 'high';
// Render resolution adapts to frame rate (see frame()); start near native.
let maxRatio = Math.min(devicePixelRatio, 1.5);
// Never render below the screen's native resolution: that is what made the image look jagged and blurry.
const minRatio = () => Math.min(1, maxRatio);
let pixelRatio = maxRatio;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Draw calls / triangles are accumulated over every pass of a frame and reset at the start of frame().
renderer.info.autoReset = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 5000);
scene.add(camera);

// 4x MSAA on the post-processing target gives smooth edges (the canvas' own antialias does not apply here).
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
// Ground-truth ambient occlusion, used only in the Old Town (small scene once the festival is culled):
// it gives the low-poly buildings soft contact shadows in corners, under eaves and along walls.
const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
gtao.enabled = false;
gtao.blendIntensity = 0.9;
gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
{
  // Alpha-tested foliage cards and sprites would occlude as solid quads: hide them from the normal pass.
  const hideExtra = [];
  const over = gtao._overrideVisibility.bind(gtao);
  const restore = gtao._restoreVisibility.bind(gtao);
  gtao._overrideVisibility = () => {
    over();
    scene.traverseVisible((o) => {
      if (o.isSprite || o.material?.alphaTest > 0 || o.material?.transparent) hideExtra.push(o);
    });
    for (const o of hideExtra) o.visible = false;
  };
  gtao._restoreVisibility = () => {
    for (const o of hideExtra) o.visible = true;
    hideExtra.length = 0;
    restore();
  };
}
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.55, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const ui = createUI();
const world = new World(scene, renderer);
const fireworks = new Fireworks(scene, camera);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  fireworks.resize(innerHeight * renderer.getPixelRatio(), camera.fov);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- game context
let activeGame = null;
const ctx = { scene, camera, world, ui, fireworks, finish };
const games = {};

function markDone(id) {
  if (G.done[id]) return;
  G.done[id] = true;
  ui.objectives();
}

function finish(id, success, html, opts = {}) {
  if (success) markDone(id);
  player.enabled = false;
  player.unlock();
  ui.panel(html, () => {
    if (activeGame && !opts.noCamera) exitGame();
    else player.enabled = true;
  });
}

// ---------------------------------------------------------------- camera tween between explore / minigame views
let tween = null;
function poseQuat(pos, look) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0)));
}
function tweenCamera(toPos, toQuat, dur, done) {
  tween = { fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone(), toPos, toQuat, t: 0, dur, done };
}

const PRICES = { goldfish: 300, shateki: 400, taiko: 0 };
function enterGame(id) {
  const game = games[id];
  if (PRICES[id] && G.coins < PRICES[id]) return ui.toast('Not enough yen!');
  G.coins -= PRICES[id] || 0;
  if (PRICES[id]) sfx.coin();
  activeGame = game;
  G.mode = id;
  player.enabled = false;
  player.unlock();
  ui.prompt(null);
  document.getElementById('hint').style.display = 'none';
  tweenCamera(game.cameraPose.pos, poseQuat(game.cameraPose.pos, game.cameraPose.look), 0.9, () => game.enter());
}

function exitGame() {
  if (!activeGame) return;
  activeGame.exit();
  activeGame = null;
  ui.gameHud(null);
  document.getElementById('hint').style.display = '';
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'));
  tweenCamera(new THREE.Vector3(player.pos.x, EYE, player.pos.z), q, 0.8, () => {
    G.mode = 'explore';
    player.enabled = true;
  });
}

// ---------------------------------------------------------------- festival actions
const FORTUNES = [
  ['大吉', 'Great blessing', 'Everything you try tonight will go well.'],
  ['中吉', 'Middle blessing', 'Patience brings a pleasant surprise.'],
  ['小吉', 'Small blessing', 'A small kindness returns to you.'],
  ['吉', 'Blessing', 'Walk slowly and enjoy the lanterns.'],
  ['末吉', 'Future blessing', 'Your luck is still growing — keep going.'],
  ['凶', 'Bad luck', 'Tie this paper to the rack to leave the bad luck behind.'],
];

world.cb.pray = () => {
  world.bell.amp = 0.55;
  sfx.suzu();
  setTimeout(() => sfx.clap(), 1300);
  G.player.shake = 0.3;
  ui.toast('🙏 You ring the bell, bow twice, clap twice and bow once more…');
  markDone('shrine');
};

world.cb.omikuji = () => {
  if (G.coins < 100) return ui.toast('Not enough yen!');
  G.coins -= 100;
  sfx.coin();
  const [jp, en, text] = pick(FORTUNES);
  world.tieFortune();
  player.enabled = false;
  player.unlock();
  ui.panel(`<h2>おみくじ Omikuji</h2><div class="fortune">${jp}</div><p style="text-align:center"><b>${en}</b><br>${text}</p><p class="muted">Your fortune has been tied to the rack.</p>`, () => (player.enabled = true));
};

function startFinale() {
  if (fireworks.show) {
    fireworks.launch();
    return;
  }
  if (world.tod < 0.85) {
    todTarget = 1;
    ui.toast('🌙 Night falls over the festival…');
  }
  ui.toast('🎆 The fireworks finale begins! Visitors head to the viewing area.');
  setTimeout(() => {
    fireworks.startShow(() => {
      markDone('fireworks');
      const act = ['goldfish', 'shateki', 'taiko', 'kimodameshi', 'shrine'].filter((k) => G.done[k]).length;
      player.enabled = false;
      player.unlock();
      ui.panel(`
        <h2>🎆 お疲れさまでした — Festival complete</h2>
        <p>Activities completed: <b>${act} / 5</b> · Foods tried: <b>${G.foods.size}</b> · Prizes: <b>${G.prizes.length}</b></p>
        <p class="muted">The finale mixed firework patterns unlocked by your activities. Complete more games and launch it again with <b>F</b> for new patterns.</p>`,
      () => (player.enabled = true));
    });
  }, world.tod < 0.85 ? 3500 : 400);
}
world.cb.fireworks = startFinale;

// ---------------------------------------------------------------- time of day
let autoTime = true;
let todTarget = null;
const todSlider = document.getElementById('tod');
const autoBtn = document.getElementById('btn-auto');
todSlider.addEventListener('input', () => {
  world.tod = todSlider.value / 1000;
  todTarget = null;
  setAuto(false);
});
function setAuto(v) {
  autoTime = v;
  autoBtn.textContent = v ? '⏵ Auto time: on' : '⏸ Auto time: off';
}
autoBtn.addEventListener('click', () => setAuto(!autoTime));
function cycleTime() {
  todTarget = world.tod < 0.55 ? 0.62 : world.tod < 0.95 ? 1 : 0;
  ui.toast(todTarget === 0.62 ? '🌇 Dusk…' : todTarget === 1 ? '🌙 Night…' : '☀️ Back to the afternoon');
}

// ---------------------------------------------------------------- debug / quality
let navDebug = null;
function toggleDebug() {
  G.debug = !G.debug;
  if (navDebug) navDebug.visible = G.debug;
  document.getElementById('btn-debug').classList.toggle('on', G.debug);
  ui.toast(G.debug ? '🧠 AI debug on: NPC behaviour-tree node, A* paths, nav grid (red = blocked)' : 'AI debug off');
}
function toggleQuality() {
  quality = quality === 'high' ? 'low' : 'high';
  const hi = quality === 'high';
  world.sun.castShadow = hi;
  bloom.enabled = hi;
  maxRatio = hi ? Math.min(devicePixelRatio, 1.5) : 0.85;
  pixelRatio = maxRatio;
  renderer.setPixelRatio(pixelRatio);
  resize();
  document.getElementById('btn-quality').textContent = hi ? 'High (G)' : 'Low (G)';
  const sq = document.getElementById('set-quality');
  if (sq) sq.textContent = hi ? 'High' : 'Low';
}
// Optional performance overlay: FPS, frame CPU time, draw calls and triangles from renderer.info.
let perfOn = false;
function togglePerf() {
  perfOn = !perfOn;
  document.getElementById('fps').style.display = perfOn ? 'block' : 'none';
  document.getElementById('btn-perf').classList.toggle('on', perfOn);
  const sp = document.getElementById('set-perf');
  if (sp) sp.textContent = perfOn ? 'On' : 'Off';
}
function toggleDev() {
  document.getElementById('dev').classList.toggle('open');
}
// Area culling (the Assignment 4 performance experiment): while the player is in the town, the festival
// (~200 m away and only partly hidden by fog) is not rendered and its NPC / minigame simulation is paused.
let areaCulling = true;
let festivalObjects = [];
function applyAreaVisibility() {
  const hide = areaCulling && hunt?.area === 'town';
  for (const o of festivalObjects) o.visible = hide ? false : o.userData.festivalVisible;
}
function toggleCulling() {
  areaCulling = !areaCulling;
  applyAreaVisibility();
  const b = document.getElementById('btn-cull');
  b.classList.toggle('on', areaCulling);
  b.textContent = `Area culling: ${areaCulling ? 'on' : 'off'}`;
}
function togglePerceptionDebug() {
  if (!hunt) return;
  hunt.setDebug(!hunt.debug);
  document.getElementById('btn-pdebug').classList.toggle('on', hunt.debug);
  ui.toast(hunt.debug ? '👁 Vision debug: cones = field of view, line = line of sight (red = blocked by a building)' : 'Vision debug off');
}
function togglePerceptionMode() {
  if (!hunt) return;
  hunt.mode = hunt.mode === 'fovlos' ? 'radius' : 'fovlos';
  document.getElementById('btn-pmode').textContent = hunt.mode === 'fovlos' ? 'Vision: FOV+LOS (O)' : 'Vision: radius only (O)';
  ui.toast(hunt.mode === 'fovlos' ? 'Villagers use distance + field of view + line of sight' : 'Comparison mode: villagers use a plain detection radius (they "see" through walls)');
}
document.getElementById('btn-debug').addEventListener('click', toggleDebug);
document.getElementById('btn-quality').addEventListener('click', toggleQuality);
document.getElementById('btn-fw').addEventListener('click', () => {
  initAudio();
  startFinale();
});
document.getElementById('btn-perf').addEventListener('click', togglePerf);
document.getElementById('btn-cull').addEventListener('click', toggleCulling);
document.getElementById('btn-pdebug').addEventListener('click', togglePerceptionDebug);
document.getElementById('btn-pmode').addEventListener('click', togglePerceptionMode);
document.getElementById('btn-tp').addEventListener('click', () => hunt?.area === 'festival' && hunt.enter());
document.getElementById('btn-tp2').addEventListener('click', () => hunt?.area === 'town' && hunt.exit());
document.getElementById('gear').addEventListener('click', toggleDev);
document.getElementById('journal-toggle').addEventListener('click', () => ui.toggleJournal());

// ---------------------------------------------------------------- input
const player = new Player(camera, canvas, world.colliders);
G.player = player;
player.place(L.start, -Math.PI / 2);

let nearest = null;
addEventListener('keydown', (e) => {
  if (!started || ui.panelOpen) return;
  if (activeGame) {
    if (e.code === 'Escape') exitGame();
    else activeGame.keyDown?.(e);
    return;
  }
  if (G.mode !== 'explore') return;
  switch (e.code) {
    case 'KeyE':
      nearest?.action();
      break;
    case 'KeyT':
      cycleTime();
      break;
    case 'KeyF':
      startFinale();
      break;
    case 'KeyN':
      toggleDebug();
      break;
    case 'KeyG':
      toggleQuality();
      break;
    case 'KeyH':
      player.unlock();
      ui.panel(`<h2>How to play</h2>${document.getElementById('howto').innerHTML}`, null, 'Close');
      break;
    case 'KeyJ':
      ui.toggleJournal();
      break;
    case 'Backquote':
      toggleDev();
      break;
    case 'KeyY':
      togglePerf();
      break;
    case 'KeyP':
      togglePerceptionDebug();
      break;
    case 'KeyO':
      togglePerceptionMode();
      break;
  }
});
const ndc = new THREE.Vector2();
canvas.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (activeGame && !tween) activeGame.pointerMove?.(ndc);
});
canvas.addEventListener('pointerdown', (e) => {
  if (activeGame && !tween) activeGame.pointerDown?.(e);
});
addEventListener('pointerup', (e) => {
  if (activeGame) activeGame.pointerUp?.(e);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- minimap
const mm = document.getElementById('minimap').getContext('2d');
const MM = { minX: -13, maxX: 58, minZ: -56, maxZ: 15 };
const mmX = (x) => ((x - MM.minX) / (MM.maxX - MM.minX)) * 388;
const mmY = (z) => ((z - MM.minZ) / (MM.maxZ - MM.minZ)) * 388;
function drawTownMinimap() {
  const T = hunt.town;
  const B = T.bounds;
  const sx = 388 / (B.maxX - B.minX);
  const sz = 388 / (B.maxZ - B.minZ);
  const tx = (x) => (x - B.minX) * sx;
  const tz = (z) => (z - B.minZ) * sz;
  mm.fillStyle = '#1c2a1c';
  mm.fillRect(0, 0, 388, 388);
  mm.imageSmoothingEnabled = false;
  mm.drawImage(T.minimap, 0, 0, 388, 388);
  mm.font = '20px sans-serif';
  mm.textAlign = 'center';
  mm.textBaseline = 'middle';
  const gate = T.toWorld(0.5, 16.3);
  mm.fillText('⛩️', tx(gate.x), tz(gate.z));
  for (const v of Object.values(hunt.villagers)) {
    mm.fillStyle = v.marker.visible ? '#ffd24a' : '#ffe9c0';
    mm.beginPath();
    mm.arc(tx(v.pos.x), tz(v.pos.z), v.marker.visible ? 7 : 5, 0, 7);
    mm.fill();
  }
  drawPlayerArrow(tx(player.pos.x), tz(player.pos.z));
}

function drawPlayerArrow(px, py) {
  mm.save();
  mm.translate(px, py);
  mm.rotate(-player.yaw);
  mm.fillStyle = '#ff5a3a';
  mm.beginPath();
  mm.moveTo(0, -13);
  mm.lineTo(8, 9);
  mm.lineTo(-8, 9);
  mm.closePath();
  mm.fill();
  mm.restore();
}

function drawMinimap(npcs) {
  if (hunt?.area === 'town') return drawTownMinimap();
  mm.fillStyle = '#1c2a1c';
  mm.fillRect(0, 0, 388, 388);
  mm.fillStyle = '#26361f';
  mm.fillRect(mmX(17), mmY(-56), mmX(58) - mmX(17), mmY(-11) - mmY(-56));
  mm.fillStyle = '#6a5a48';
  mm.fillRect(mmX(-11), mmY(-2.4), mmX(10) - mmX(-11), mmY(2) - mmY(-2.4));
  mm.fillRect(mmX(10), mmY(-1.6), mmX(45) - mmX(10), mmY(1.6) - mmY(-1.6));
  mm.fillStyle = '#8a6a4a';
  mm.fillRect(mmX(-7), mmY(-3.8), mmX(9.5) - mmX(-7), mmY(-2.5) - mmY(-3.8));
  mm.fillRect(mmX(-7), mmY(2.05), mmX(9.5) - mmX(-7), mmY(3.55) - mmY(2.05));
  mm.strokeStyle = '#7a6448';
  mm.lineWidth = 7;
  mm.beginPath();
  KIMO_PATH.forEach((p, i) => (i ? mm.lineTo(mmX(p.x), mmY(p.z)) : mm.moveTo(mmX(p.x), mmY(p.z))));
  mm.stroke();
  mm.fillStyle = '#9a8f80';
  mm.fillRect(mmX(44.4), mmY(-4.5), mmX(53.5) - mmX(44.4), mmY(4.5) - mmY(-4.5));
  mm.font = '22px sans-serif';
  mm.textAlign = 'center';
  mm.textBaseline = 'middle';
  const icons = [
    [L.goldfish, '🐟', G.done.goldfish], [L.shateki, '🎯', G.done.shateki], [L.taiko, '🥁', G.done.taiko],
    [L.kimoEntrance, '👻', G.done.kimodameshi], [L.torii, '⛩️', false], [L.offering, '🙏', G.done.shrine],
    [L.viewing, '🎆', G.done.fireworks], [L.omikuji, '📜', false], [new THREE.Vector3(0, 0, 0), '🏮', G.done.explore],
    [new THREE.Vector3(13.4, 0, 4.7), '🔔', hunt?.quest?.state === QS.COMPLETE],
  ];
  for (const [p, ic, done] of icons) {
    mm.globalAlpha = done ? 0.45 : 1;
    mm.fillText(ic, mmX(p.x), mmY(p.z));
  }
  mm.globalAlpha = 1;
  mm.fillStyle = '#ffe9c0';
  for (const a of npcs.agents) {
    mm.beginPath();
    mm.arc(mmX(a.pos.x), mmY(a.pos.z), 4, 0, 7);
    mm.fill();
  }
  drawPlayerArrow(mmX(player.pos.x), mmY(player.pos.z));
}

// ---------------------------------------------------------------- boot
let started = false;
let npcs = null;
let kimo = null;
let hunt = null;

async function boot() {
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => ui.progress(loaded / total, `Loading ${url.split('/').pop()} (${loaded}/${total})`);
  try {
    await world.loadModel(manager);
  } catch (err) {
    console.error(err);
    ui.progress(1, '⚠️ Could not load the festival street model — continuing with the procedural world.');
  }
  ui.progress(1, 'Building games, navigation grid and NPCs…');
  const goods = buildStallGoods(world);
  console.info(`Stall goods: ${goods.items} items on ${goods.spots} counters`);
  await new Promise((r) => setTimeout(r, 30));

  games.goldfish = new Goldfish(ctx);
  games.shateki = new Shateki(ctx);
  games.taiko = new Taiko(ctx);
  kimo = new Kimodameshi(ctx);
  buildBooth(world, { pos: L.ringtoss, flip: true, sign: '輪投げ', signBg: '#2e6b3a', awning: ['#3a9a4a', '#ffffff'], counter: true });

  for (const g of [games.goldfish, games.shateki, games.taiko]) {
    world.addInteractable({ ...g.interact, action: () => enterGame(g.interact.id) });
  }
  world.addInteractable({ ...kimo.interact, enabled: () => !kimo.active, action: () => kimo.start() });

  // Everything that blocks movement is registered: rasterise the nav grid.
  const nav = new NavGrid(world.colliders, { minX: WORLD_BOUNDS.minX, maxX: 52, minZ: -14, maxZ: WORLD_BOUNDS.maxZ, cell: 0.5, agentRadius: 0.4 });
  navDebug = nav.debugMesh();
  navDebug.visible = false;
  scene.add(navDebug);
  npcs = new NPCSystem(scene, world, nav);

  for (const s of STALLS) {
    world.addInteractable({
      id: `food-${s.name}`,
      pos: stallFront(s),
      radius: 1.6,
      label: `Buy ${s.name} ${s.jp} (¥${s.price})`,
      action: () => {
        if (G.coins < s.price) return ui.toast('Not enough yen!');
        G.coins -= s.price;
        G.foods.add(s.name);
        sfx.coin();
        npcs.ownerOf(s)?.thank();
        ui.toast(`${s.emoji} いただきます! You enjoy some ${s.name}.`);
      },
    });
  }

  // Everything in the scene so far belongs to the festival area (lights, sky, stars and moon stay on).
  const keep = new Set([camera, world.sky, world.stars, world.moon, world.sun, world.sun.target, world.hemi]);
  festivalObjects = scene.children.filter((o) => !keep.has(o) && !o.isLight);
  for (const o of festivalObjects) o.userData.festivalVisible = o.visible;

  ui.progress(1, 'Loading the Old Town…');
  hunt = new TreasureHunt({
    world, player, ui,
    onArea: (area) => {
      applyAreaVisibility();
      document.getElementById('mapname').textContent = area === 'town' ? 'Old Town' : 'Festival street';
    },
  });
  try {
    await hunt.load();
  } catch (err) {
    console.error(err);
    hunt = null;
    ui.progress(1, '⚠️ Could not load the Old Town model — the treasure hunt is unavailable.');
  }

  ui.objectives();
  // Handle for debugging / automated screenshots from the console.
  window.__hana = { THREE, world, player, G, camera, games, kimo, npcs, fireworks, enterGame, exitGame, startFinale, setAuto, hunt, renderer, measure, toggleCulling, get areaCulling() { return areaCulling; } };
  // Warm up shaders so the first frame after entering doesn't hitch.
  renderer.compile(scene, camera);
  // Tree models stream in after start-up; compile their shaders before they first appear.
  Promise.allSettled([world.forestReady, games.goldfish.ready]).then(() => renderer.compileAsync?.(scene, camera));
  ui.progress(1, 'Ready');
  setTimeout(() => (document.getElementById('progress').style.visibility = 'hidden'), 600);
  const begin = (toTown) => {
    initAudio();
    const start = document.getElementById('start');
    start.classList.add('fading');
    setTimeout(() => start.classList.add('hidden'), 600);
    document.body.classList.remove('menu');
    started = true;
    player.place(L.start, -Math.PI / 2);
    player.pitch = -0.05;
    player.enabled = true;
    try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
    if (toTown && hunt) hunt.enter();
    else ui.toast('Welcome to Hana Matsuri! Walk east (W) down the street of stalls.');
  };
  const btn = document.getElementById('enter');
  btn.disabled = false;
  btn.addEventListener('click', () => begin(false));
  const btnTown = document.getElementById('enter-town');
  btnTown.disabled = !hunt;
  btnTown.addEventListener('click', () => begin(true));
}

// ---------------------------------------------------------------- opening menu pages
{
  const page = document.getElementById('menu-page');
  let open = null;
  const show = (id) => {
    if (open === id) {
      page.classList.remove('open');
      open = null;
      return;
    }
    open = id;
    page.innerHTML = document.getElementById(id).innerHTML;
    page.classList.add('open');
    if (id === 'settings') {
      const sync = () => {
        page.querySelector('#set-quality').textContent = quality === 'high' ? 'High' : 'Low';
        page.querySelector('#set-perf').textContent = perfOn ? 'On' : 'Off';
        page.querySelector('#set-auto').textContent = autoTime ? 'On' : 'Off';
      };
      page.querySelector('#set-quality').onclick = () => (toggleQuality(), sync());
      page.querySelector('#set-perf').onclick = () => (togglePerf(), sync());
      page.querySelector('#set-auto').onclick = () => (setAuto(!autoTime), sync());
      sync();
    }
  };
  document.getElementById('btn-howto').addEventListener('click', () => show('howto'));
  document.getElementById('btn-settings').addEventListener('click', () => show('settings'));
}

// ---------------------------------------------------------------- measurement (performance experiment)
// Averages renderer statistics and frame timings over a window of frames: used to compare area culling
// on / off in the same position and view. Frame CPU time = JS update + render submission (not GPU time).
let sampler = null;
function measure(seconds = 4) {
  return new Promise((resolve) => {
    sampler = { until: performance.now() + seconds * 1000, n: 0, calls: 0, tris: 0, cpu: 0, dt: 0, resolve };
  });
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let elapsed = 0;
let ambT = 0;
let fpsAcc = 0;
let fpsN = 0;
let mmT = 0;
let perfT = 0;
let perfN = 0;

let cpuMs = 0;
function frame() {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  elapsed += dt;
  renderer.info.reset();

  // Time of day
  if (todTarget !== null) {
    world.tod = damp(world.tod, todTarget, 1.4, dt);
    if (Math.abs(world.tod - todTarget) < 0.003) {
      world.tod = todTarget;
      todTarget = null;
    }
  } else if (autoTime && started) {
    world.tod = Math.min(1, world.tod + dt / 300);
  }
  todSlider.value = Math.round(world.tod * 1000);

  // Opening menu: the festival is the backdrop, with a slow look along the street.
  if (!started) {
    player.yaw = -Math.PI / 2 + Math.sin(elapsed * 0.08) * 0.35;
    player.pitch = 0.04 + Math.sin(elapsed * 0.05) * 0.03;
  }
  player.update(dt);
  world.update(dt, player.pos);

  const festivalPaused = areaCulling && hunt?.area === 'town';
  if (npcs && !festivalPaused) {
    npcs.update(dt, elapsed);
    for (const g of Object.values(games)) g.update(dt, elapsed);
    kimo.update(dt, elapsed);
  }
  hunt?.update(dt, elapsed);
  fireworks.update(dt);

  // Camera: tween, minigame pose, or first-person
  if (tween) {
    tween.t += dt / tween.dur;
    const k = Math.min(1, tween.t);
    const e = k * k * (3 - 2 * k);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
    camera.quaternion.slerpQuaternions(tween.fromQuat, tween.toQuat, e);
    if (k >= 1) {
      const done = tween.done;
      tween = null;
      done?.();
    }
  } else if (!activeGame) {
    player.applyCamera();
  }

  // Interaction prompt
  if (started && G.mode === 'explore' && !ui.panelOpen) {
    nearest = null;
    let best = 1e9;
    for (const it of world.interactables) {
      if (!it.enabled()) continue;
      const d = Math.hypot(it.pos.x - player.pos.x, it.pos.z - player.pos.z);
      if (d < it.radius && d < best) {
        best = d;
        nearest = it;
      }
    }
    ui.prompt(typeof nearest?.label === 'function' ? nearest.label() : nearest?.label);
  } else {
    nearest = null;
    ui.prompt(null);
  }

  if (!G.done.explore && player.pos.x > 11) {
    markDone('explore');
    ui.toast('🏮 You reached the game plaza! Booths ahead, shrine to the east.');
  }

  bloom.strength = lerp(0.15, 0.55, world.glow);
  ambT -= dt;
  if (ambT <= 0) {
    ambT = 0.5;
    const streetness = hunt?.area === 'town' ? 0.25 : player.pos.x < 36 ? 1 - world.forest : 0;
    setAmbience({ day: 1 - world.glow, night: world.night, crowd: streetness * (G.fireworksActive ? 1.4 : 1) });
    ui.clock(world.clockLabel());
  }
  mmT -= dt;
  if (npcs && mmT <= 0) {
    mmT = 0.1;
    drawMinimap(npcs);
  }

  // Adaptive resolution: drop render scale when the frame rate sags, restore it when smooth.
  perfT += dt;
  perfN++;
  if (perfT > 1.5) {
    const fps = perfN / perfT;
    perfT = 0;
    perfN = 0;
    let next = pixelRatio;
    if (fps < 45 && pixelRatio > minRatio()) next = Math.max(minRatio(), pixelRatio - 0.15);
    else if (fps > 57 && pixelRatio < maxRatio) next = Math.min(maxRatio, pixelRatio + 0.1);
    if (next !== pixelRatio) {
      pixelRatio = next;
      renderer.setPixelRatio(pixelRatio);
      resize();
    }
  }

  gtao.enabled = quality === 'high' && areaCulling && hunt?.area === 'town';
  composer.render();
  cpuMs = performance.now() - t0;

  const info = renderer.info.render;
  if (sampler) {
    sampler.n++;
    sampler.calls += info.calls;
    sampler.tris += info.triangles;
    sampler.cpu += cpuMs;
    sampler.dt += rawDt;
    if (performance.now() > sampler.until) {
      const s = sampler;
      sampler = null;
      s.resolve({ frames: s.n, fps: +(s.n / s.dt).toFixed(1), frameMs: +((s.dt / s.n) * 1000).toFixed(2), cpuMs: +(s.cpu / s.n).toFixed(2), drawCalls: Math.round(s.calls / s.n), triangles: Math.round(s.tris / s.n), area: hunt?.area, areaCulling, pixelRatio });
    }
  }
  if (perfOn) {
    fpsAcc += rawDt;
    fpsN++;
    if (fpsAcc > 0.5) {
      const mem = renderer.info.memory;
      const area = hunt?.area === 'town' ? `town · culling ${areaCulling ? 'on' : 'off'}` : 'festival';
      document.getElementById('fps').textContent =
        `${Math.round(fpsN / fpsAcc)} fps · ${((fpsAcc / fpsN) * 1000).toFixed(1)} ms/frame\n` +
        `CPU ${cpuMs.toFixed(1)} ms · ${pixelRatio.toFixed(2)}x res\n` +
        `draw calls ${info.calls} · tris ${info.triangles.toLocaleString()}\n` +
        `geometries ${mem.geometries} · textures ${mem.textures}\n${area}`;
      fpsAcc = 0;
      fpsN = 0;
    }
  }
  if (hunt && document.getElementById('dev').classList.contains('open')) {
    const st = hunt.stats();
    document.getElementById('pstats').textContent =
      `Perception (${hunt.mode === 'fovlos' ? 'FOV+LOS' : 'radius'}) · samples ${st.senses}\n` +
      `radius-only detections: ${st.radiusHits}\nFOV+LOS detections: ${st.fovLosHits}\n` +
      `rejected (behind/blocked): ${st.falsePositivesAvoided}`;
    document.getElementById('pstats').style.whiteSpace = 'pre';
  }
}

boot();
frame();
