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
      $('panel').classList.remove('hidden');
      panelCb = cb;
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
