import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World } from './world.js';
import { Player, EYE } from './player.js';
import { NavGrid } from './nav.js';
import { NPCSystem } from './npc.js';
import { Fireworks } from './fireworks.js';
import { Goldfish } from './games/goldfish.js';
import { Shateki } from './games/shateki.js';
import { Taiko } from './games/taiko.js';
import { Kimodameshi } from './games/kimodameshi.js';
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
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 5000);
scene.add(camera);

// 4x MSAA on the post-processing target gives smooth edges (the canvas' own antialias does not apply here).
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
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
  document.getElementById('fps').style.display = G.debug ? 'block' : 'none';
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
}
document.getElementById('btn-debug').addEventListener('click', toggleDebug);
document.getElementById('btn-quality').addEventListener('click', toggleQuality);
document.getElementById('btn-fw').addEventListener('click', () => {
  initAudio();
  startFinale();
});

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
      ui.panel(document.getElementById('start').querySelector('.grid').outerHTML, null, 'Close');
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
function drawMinimap(npcs) {
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
  const px = mmX(player.pos.x);
  const py = mmY(player.pos.z);
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

// ---------------------------------------------------------------- boot
let started = false;
let npcs = null;
let kimo = null;

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

  ui.objectives();
  // Handle for debugging / automated screenshots from the console.
  window.__hana = { THREE, world, player, G, camera, games, kimo, npcs, fireworks, enterGame, exitGame, startFinale, setAuto };
  // Warm up shaders so the first frame after entering doesn't hitch.
  renderer.compile(scene, camera);
  // Tree models stream in after start-up; compile their shaders before they first appear.
  Promise.allSettled([world.forestReady, games.goldfish.ready]).then(() => renderer.compileAsync?.(scene, camera));
  ui.progress(1, 'Ready. Put on your yukata!');
  const btn = document.getElementById('enter');
  btn.disabled = false;
  btn.addEventListener('click', () => {
    initAudio();
    document.getElementById('start').classList.add('hidden');
    started = true;
    player.enabled = true;
    try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {}
    ui.toast('Welcome to Hana Matsuri! Walk east (W) down the street of stalls.');
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

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

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

  player.update(dt);
  world.update(dt, player.pos);

  if (npcs) {
    npcs.update(dt, elapsed);
    for (const g of Object.values(games)) g.update(dt, elapsed);
    kimo.update(dt, elapsed);
  }
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
    ui.prompt(nearest?.label);
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
    const streetness = player.pos.x < 36 ? 1 - world.forest : 0;
    setAmbience({ day: 1 - world.glow, night: world.night, crowd: streetness * (G.fireworksActive ? 1.4 : 1) });
    ui.clock(world.clockLabel());
  }
  mmT -= dt;
  if (npcs && mmT <= 0) {
    mmT = 0.1;
    drawMinimap(npcs);
  }
  if (G.debug) {
    fpsAcc += dt;
    fpsN++;
    if (fpsAcc > 0.5) {
      document.getElementById('fps').textContent = `${Math.round(fpsN / fpsAcc)} fps · ${renderer.info.render.triangles.toLocaleString()} tris · ${pixelRatio.toFixed(2)}x res`;
      fpsAcc = 0;
      fpsN = 0;
    }
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

  composer.render();
}

boot();
frame();
