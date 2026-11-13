import { G } from './state.js';
import { PATTERN_UNLOCKS } from './fireworks.js';

const $ = (id) => document.getElementById(id);

const OBJECTIVES = [
  ['explore', 'Explore the festival street', '屋台通り'],
  ['goldfish', 'Goldfish scooping', '金魚すくい'],
  ['shateki', 'Shooting gallery', '射的'],
  ['taiko', 'Taiko rhythm', '太鼓'],
  ['kimodameshi', 'Test of courage', '肝試し'],
  ['treasure', 'Old Town treasure hunt', '宝探し'],
  ['lanterns', 'Release the festival lanterns', '灯籠流し'],
  ['shrine', 'Pray at the shrine', '参拝'],
  ['fireworks', 'Watch the fireworks finale', '花火'],
];

export function createUI() {
  let panelCb = null;
  // Dialogue box state
  let dlg = null; // { pages, i, shown, full, done, timer }
  const dlgEl = () => $('dialogue');
  const typeTick = () => {
    if (!dlg) return;
    const page = dlg.pages[dlg.i];
    dlg.shown = Math.min(dlg.full.length, dlg.shown + 2);
    $('dlg-text').innerHTML = cutHtml(page.text, dlg.shown);
    if (dlg.shown < dlg.full.length) dlg.timer = setTimeout(typeTick, 22);
    else $('dlg-next').classList.add('ready');
  };
  const showPage = () => {
    const page = dlg.pages[dlg.i];
    $('dlg-name').textContent = page.name || '';
    $('dlg-role').textContent = page.role || '';
    dlg.full = page.text.replace(/<[^>]+>/g, '');
    dlg.shown = 0;
    $('dlg-next').classList.remove('ready');
    $('dlg-next').textContent = dlg.i < dlg.pages.length - 1 ? 'E  next' : 'E  close';
    clearTimeout(dlg.timer);
    typeTick();
  };
  const advance = () => {
    if (!dlg) return;
    if (dlg.shown < dlg.full.length) {
      clearTimeout(dlg.timer);
      dlg.shown = dlg.full.length;
      $('dlg-text').innerHTML = dlg.pages[dlg.i].text;
      $('dlg-next').classList.add('ready');
      return;
    }
    if (dlg.i < dlg.pages.length - 1) {
      dlg.i++;
      showPage();
      return;
    }
    const done = dlg.done;
    clearTimeout(dlg.timer);
    dlg = null;
    dlgEl().classList.remove('open');
    // Swallow the key that closed the box so it does not also trigger an interaction.
    blockUntil = performance.now() + 250;
    done?.();
  };
  let blockUntil = 0;
  addEventListener('keydown', (e) => {
    if (!dlg) return;
    if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') {
      e.stopImmediatePropagation();
      if (!e.repeat) advance();
    }
  }, true);
  addEventListener('mousedown', () => dlg && advance());
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
    // Story dialogue at the bottom of the screen: pages [{ name, role, text }], typewriter reveal.
    dialogue(pages, done) {
      dlg = { pages, i: 0, done, shown: 0, full: '', timer: 0 };
      dlgEl().classList.add('open');
      showPage();
    },
    get dialogueOpen() {
      return !!dlg || performance.now() < blockUntil;
    },
    questJournal(entries, objective) {
      $('qjournal').innerHTML = entries.length
        ? `<div class="jh">The Missing Festival Heirloom</div><div class="jo">${objective}</div>` + entries.map((e) => `<div class="je"><b>${e.title}</b><span>${e.text}</span></div>`).join('')
        : '';
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
      const pips = [0, 1, 2].map((i) => `<span class="pip ${i < q.clues ? 'on' : ''}"></span>`).join('');
      el.innerHTML = `<div class="qt">${q.title}</div><div class="qo">${q.done ? '✔ ' : ''}${q.objective}</div>` +
        `<div class="qc">Clues ${pips}${q.bell ? ' · Kagura Bell in hand' : ''}</div><div class="qd" id="qdir"></div>`;
    },
    // Free-text hint line under the objective (e.g. how loud the stolen bell sounds).
    questNote(text) {
      const el = $('qdir');
      if (!el) return;
      el.style.display = text ? 'block' : 'none';
      el.innerHTML = text ? `<span class="note">${text}</span>` : '';
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
      return !$('panel').classList.contains('hidden') || !!dlg || performance.now() < blockUntil;
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
    // Five emblems, one per activity; all five unlock the lantern + fireworks finale.
    emblems(list) {
      const n = list.filter((e) => G.done[e.key]).length;
      $('emblems').innerHTML = list.map((e) => `<span class="em ${G.done[e.key] ? 'on' : ''}" title="${e.name}">${e.icon}</span>`).join('') + `<span class="emn">${n}/5</span>`;
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

// Show the first n visible characters of an HTML string (tags kept balanced by the browser).
function cutHtml(html, n) {
  let out = '';
  let count = 0;
  for (let i = 0; i < html.length && count < n; i++) {
    if (html[i] === '<') {
      const j = html.indexOf('>', i);
      out += html.slice(i, j + 1);
      i = j;
    } else {
      out += html[i];
      count++;
    }
  }
  return out;
}
