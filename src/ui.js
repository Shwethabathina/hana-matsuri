import { G } from './state.js';
import { PATTERN_UNLOCKS } from './fireworks.js';

const $ = (id) => document.getElementById(id);

const OBJECTIVES = [
  ['explore', 'Explore the festival street', '屋台通り'],
  ['goldfish', 'Goldfish scooping', '金魚すくい'],
  ['shateki', 'Shooting gallery', '射的'],
  ['taiko', 'Taiko rhythm', '太鼓'],
  ['kimodameshi', 'Test of courage', '肝試し'],
  ['shrine', 'Pray at the shrine', '参拝'],
  ['fireworks', 'Watch the fireworks finale', '花火'],
];

export function createUI() {
  let panelCb = null;
  $('panel-btn').addEventListener('click', () => {
    $('panel').classList.add('hidden');
    const cb = panelCb;
    panelCb = null;
    cb?.();
  });

  return {
    toast(msg) {
      const el = document.createElement('div');
      el.className = 'toast card';
      el.textContent = msg;
      $('toasts').appendChild(el);
      setTimeout(() => el.remove(), 3300);
    },
    prompt(label) {
      const el = $('prompt');
      if (!label) {
        el.style.display = 'none';
        return;
      }
      el.innerHTML = `<kbd>E</kbd>${label}`;
      el.style.display = 'block';
    },
    gameHud(html) {
      const el = $('gamehud');
      el.style.display = html ? 'block' : 'none';
      el.innerHTML = html || '';
    },
    quest(text) {
      const el = $('quest');
      el.style.display = text ? 'block' : 'none';
      el.textContent = text;
    },
    panel(html, cb, btn = 'Continue') {
      $('panel-body').innerHTML = html;
      $('panel-btn').textContent = btn;
      $('panel-btn').style.display = '';
      $('panel-choices').innerHTML = '';
      $('panel').classList.remove('hidden');
      panelCb = cb;
    },
    // Panel with several choices (e.g. quest completion: restart / return).
    complete(html, choices) {
      $('panel-body').innerHTML = html;
      $('panel-btn').style.display = 'none';
      const box = $('panel-choices');
      box.innerHTML = '';
      for (const [label, fn] of choices) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = label;
        b.addEventListener('click', () => {
          $('panel').classList.add('hidden');
          box.innerHTML = '';
          fn();
        });
        box.appendChild(b);
      }
      $('panel').classList.remove('hidden');
    },
    questHud(q) {
      const el = $('quest');
      if (!q) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.classList.toggle('done', !!q.done);
      const pips = [0, 1].map((i) => `<span class="pip ${i < q.clues ? 'on' : ''}"></span>`).join('');
      el.innerHTML = `<div class="qt">${q.title}</div><div class="qo">${q.done ? '✔ ' : ''}${q.objective}</div>` +
        `<div class="qc">Clues ${pips} ${q.clues}/2${q.bell ? ' · 🔔 Kagura Bell in hand' : ''}</div><div class="qd" id="qdir"></div>`;
    },
    // Direction arrow + distance to the current goal (angle in radians, 0 = straight ahead, + = right).
    questDir(angle, dist) {
      const el = $('qdir');
      if (!el) return;
      if (angle === null) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      const deg = Math.round((angle * 180) / Math.PI);
      el.innerHTML = dist < 2.5 ? '<b>Here — press E</b>' : `<span class="arrow" style="transform:rotate(${deg}deg)">⬆</span> ${Math.round(dist)} m`;
    },
    // Short fade-to-black used for area transitions.
    fade(mid) {
      const f = $('fade');
      f.classList.add('on');
      setTimeout(() => {
        mid();
        setTimeout(() => f.classList.remove('on'), 120);
      }, 380);
    },
    toggleJournal() {
      $('topleft').classList.toggle('open');
    },
    get panelOpen() {
      return !$('panel').classList.contains('hidden');
    },
    flash() {
      const f = $('flash');
      f.classList.remove('on');
      void f.offsetWidth;
      f.classList.add('on');
    },
    clock(text) {
      $('clocktext').textContent = text;
      $('coins').textContent = `¥${G.coins}`;
    },
    objectives() {
      $('objectives').innerHTML = OBJECTIVES.map(
        ([k, en, jp]) => `<li class="${G.done[k] ? 'done' : ''}">${G.done[k] ? '✔' : '○'} ${en} <span class="p">${jp}</span></li>`,
      ).join('');
      const unlocked = Object.entries(PATTERN_UNLOCKS).filter(([k]) => G.done[k]).map(([, u]) => u.label);
      $('patterns').innerHTML = `🎆 Firework patterns: Peony, Chrysanthemum${unlocked.length ? ', <b>' + unlocked.join(', ') + '</b>' : ''}`;
    },
    progress(p, text) {
      $('progress').firstElementChild.style.width = `${Math.round(p * 100)}%`;
      if (text) $('loadtext').textContent = text;
    },
  };
}
