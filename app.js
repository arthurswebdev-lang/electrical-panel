"use strict";

const QD_COLORS = ['#2f6fdb', '#e07b00', '#1f9d55', '#9b3fd1', '#d63384'];
const MCB_AMPS = [1, 2, 3, 4, 6, 10, 13, 16, 20, 25, 32, 40, 50, 63];
const RCD_AMPS = [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100];
const MAIN_AMPS = [16, 20, 25, 32, 40, 50, 63, 80, 100, 125];
const LEAK_MA = [10, 30, 100, 300];

function defaults() {
  const d = {};
  d.Q1  = { type: 'main',  amps: 63, label: 'Main switch (L + N)', on: true };
  d.KV1 = { type: 'relay', umax: 250, umin: 180, delay: 30, label: 'Voltage relay', on: true };
  d.KM1 = { type: 'km',    amps: 16, label: 'All lights', on: true };
  for (let i = 1; i <= 5; i++)  d['QD' + i] = { type: 'rcd', amps: 25, ma: 30, label: 'RCD ' + i, on: true };
  for (let i = 1; i <= 23; i++) d['QF' + i] = { type: 'mcb', curve: 'C', amps: 16, label: 'Line ' + i, qd: '', on: true };
  return d;
}

/* panel layout: [id, width in modules]; null id = free space */
const LAYOUT = [
  [['Q1', 2], ['KV1', 2], ['KM1', 1], [null, 7]],
  [['QD1', 2], ['QD2', 2], ['QD3', 2], ['QD4', 2], ['QD5', 2], [null, 2]],
  [...Array.from({ length: 11 }, (_, i) => ['QF' + (i + 1), 1]), [null, 1]],
  [...Array.from({ length: 12 }, (_, i) => ['QF' + (i + 12), 1])],
];

let state = defaults();

/* ---------------------------------------------------------------------
 * Storage: IndexedDB, one record per device in the "devices" store,
 * keyed by its id ("Q1", "QD3", "QF17" ...).
 * ------------------------------------------------------------------- */
const DB_NAME = 'electrical-panel-db';
const DB_VERSION = 1;
const STORE = 'devices';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function load() {
  const base = defaults();
  try {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    merge(base, Object.fromEntries(rows.map(r => [r.id, r])));
  } catch (e) {
    console.error('IndexedDB load failed', e);
  }
  return base;
}

/* copy known fields from saved data onto the defaults; ignore unknown ids */
function merge(base, saved) {
  for (const id in base) {
    if (saved[id] && typeof saved[id] === 'object') Object.assign(base[id], saved[id], { type: base[id].type });
  }
}

async function save() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      for (const id in state) store.put({ ...state[id], id });
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.error('IndexedDB save failed', e);
  }
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qdIndex = id => Number(id.slice(2)) - 1;

/* "QF1, QF2, QF3, QF7" -> "QF1–3, QF7" */
function compactList(ids) {
  const n = ids.map(id => Number(id.slice(2))).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `QF${n[i]}–${n[j]}` : `QF${n[i]}`);
    i = j;
  }
  return out.join(', ');
}
const breakersOf = qd => Object.keys(state).filter(id => state[id].type === 'mcb' && state[id].qd === qd);

/* is this device without power? (main OFF, or its RCD OFF) */
function dead(id) {
  const d = state[id];
  if (id !== 'Q1' && !state.Q1.on) return true;
  if (d.type === 'mcb' && d.qd && !state[d.qd].on) return true;
  return false;
}

function faceHTML(d) {
  switch (d.type) {
    case 'main':
      return `<span class="model">2P</span><span class="ind"></span><span class="tg wide"></span><b class="rate">${d.amps}A</b>`;
    case 'relay':
      return `<div class="lcd">222</div>
        <div class="set"><span>${d.umax}</span><span>${d.umin}</span><span>${d.delay}s</span></div>
        <div class="btns"><span>▲</span><span>▼</span></div>`;
    case 'km':
      return `<span class="model">A1 A2</span><span class="led"></span><span class="tg"></span><b class="rate">${d.amps}A</b>`;
    case 'rcd':
      return `<span class="model">RCD</span>
        <span class="body"><span class="col"><span class="ind"></span><span class="tg"></span></span><span class="test">T</span></span>
        <b class="rate">${d.amps}A<small>${d.ma}mA</small></b>`;
    case 'mcb':
      return `<span class="model">S201</span><span class="ind"></span><span class="tg"></span><b class="rate">${esc(d.curve)}${d.amps}</b>`;
  }
}

function slotHTML(id, w) {
  if (!id) {
    return `<div class="slot blank" style="--w:${w}"><span class="num">&nbsp;</span><div class="cover">${w > 1 ? 'free' : ''}</div><div class="lbl"></div></div>`;
  }
  const d = state[id];
  let numCls = 'num', numStyle = '';
  if (d.type === 'rcd') { numCls += ' grp'; numStyle = `--g:${QD_COLORS[qdIndex(id)]}`; }
  if (d.type === 'mcb' && d.qd) { numCls += ' grp'; numStyle = `--g:${QD_COLORS[qdIndex(d.qd)]}`; }

  let sub = '';
  if (d.type === 'rcd') { const l = breakersOf(id); sub = l.length ? compactList(l) : 'no breakers'; }
  if (d.type === 'mcb' && d.qd) sub = d.qd;
  if (d.type === 'relay') sub = `${d.umin}–${d.umax} V · ${d.delay} s`;

  const cls = ['slot', d.on || d.type === 'relay' ? 'on' : '', dead(id) ? 'dead' : ''].join(' ');
  return `<div class="${cls}" style="--w:${w}" data-id="${id}" role="button" tabindex="0" aria-label="Edit ${id}: ${esc(d.label)}">
      <span class="${numCls}" style="${numStyle}">${id}</span>
      <div class="mod">
        <div class="face">${faceHTML(d)}</div>
      </div>
      <div class="lbl"><span class="t">${esc(d.label)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>
    </div>`;
}

function render() {
  document.getElementById('frame').innerHTML = LAYOUT.map(row =>
    `<div class="row"><div class="rail"></div>${row.map(([id, w]) => slotHTML(id, w)).join('')}</div>`
  ).join('');
  fitLabels();
}

/* Keep every label on one line: shrink the font until the text
   fits the label height. Runs after each render and on resize. */
function fitLabels() {
  for (const lbl of document.querySelectorAll('#frame .lbl')) {
    const cs = getComputedStyle(lbl);
    const avail = lbl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    for (const line of lbl.querySelectorAll('.t, .sub')) {
      line.style.fontSize = '';                      // start from the normal size
      if (avail <= 0) continue;
      let size = parseFloat(getComputedStyle(line).fontSize);
      // text length does not scale exactly with font size, so repeat a few times
      for (let i = 0; i < 6 && line.offsetHeight > avail && size > 3; i++) {
        size = Math.max(3, Math.floor(size * avail / line.offsetHeight * 0.98 * 10) / 10);
        line.style.fontSize = size + 'px';
      }
    }
  }
}
let fitFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(fitLabels);
});

/* ---------- edit dialog ---------- */
const dlg = document.getElementById('dlg');
const dlgBody = document.getElementById('dlgBody');
let editing = null;

const opts = (list, val, unit = '') => list.map(v => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${v}${unit}</option>`).join('');
const labelField = d => `<label class="field"><span>Marker / name</span><input type="text" name="label" value="${esc(d.label)}" autocomplete="off"></label>`;
const onField = d => `<label class="switch"><input type="checkbox" name="on" ${d.on ? 'checked' : ''}> Switched ON</label>`;

const NAMES = { main: 'Main switch', relay: 'Voltage relay', km: 'Light relay (contactor)', rcd: 'RCD safety switch', mcb: 'Circuit breaker' };

function openEditor(id) {
  const d = state[id];
  editing = id;
  document.getElementById('dlgTitle').textContent = id;
  document.getElementById('dlgSub').textContent = NAMES[d.type];
  let html = labelField(d);

  if (d.type === 'main' || d.type === 'km') {
    html += `<label class="field"><span>Rated current</span><select name="amps">${opts(MAIN_AMPS, d.amps, ' A')}</select></label>`;
  }
  if (d.type === 'relay') {
    html += `<div class="trio">
      <label class="field"><span>Upper limit, V</span><input type="number" name="umax" inputmode="numeric" value="${d.umax}"></label>
      <label class="field"><span>Lower limit, V</span><input type="number" name="umin" inputmode="numeric" value="${d.umin}"></label>
      <label class="field"><span>Delay, s</span><input type="number" name="delay" inputmode="numeric" value="${d.delay}"></label>
    </div>`;
  }
  if (d.type === 'mcb') {
    html += `<div class="pair">
      <label class="field"><span>Curve</span><select name="curve">${opts(['B', 'C', 'D'], d.curve)}</select></label>
      <label class="field"><span>Current</span><select name="amps">${opts(MCB_AMPS, d.amps, ' A')}</select></label>
    </div>
    <label class="field"><span>Protected by RCD</span><select name="qd">
      <option value="">— none —</option>
      ${[1, 2, 3, 4, 5].map(i => `<option value="QD${i}" ${d.qd === 'QD' + i ? 'selected' : ''}>QD${i} · ${esc(state['QD' + i].label)}</option>`).join('')}
    </select></label>`;
  }
  if (d.type === 'rcd') {
    html += `<div class="pair">
      <label class="field"><span>Current</span><select name="amps">${opts(RCD_AMPS, d.amps, ' A')}</select></label>
      <label class="field"><span>Leakage</span><select name="ma">${opts(LEAK_MA, d.ma, ' mA')}</select></label>
    </div>
    <div class="field"><span>Breakers connected to this RCD</span><div class="checks">
      ${Array.from({ length: 23 }, (_, i) => {
        const q = 'QF' + (i + 1), b = state[q];
        const other = b.qd && b.qd !== id ? ` · now ${b.qd}` : '';
        return `<label><input type="checkbox" name="qf" value="${q}" ${b.qd === id ? 'checked' : ''}>
          <span>${q} ${esc(b.curve)}${b.amps}<em>${esc(b.label)}${other}</em></span></label>`;
      }).join('')}
    </div></div>`;
  }
  if (d.type !== 'relay') html += onField(d);

  dlgBody.innerHTML = html;
  dlg.showModal();
  document.getElementById('dlgTitle').focus();  // no keyboard pop-up on phones
}

dlg.addEventListener('close', () => {
  // the browser puts focus back on the tapped device; drop it so no ring stays
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (dlg.returnValue !== 'save' || !editing) { editing = null; return; }
  const id = editing, d = state[id];
  const f = new FormData(document.getElementById('dlgForm'));
  d.label = (f.get('label') || '').trim() || id;
  if (f.has('amps')) d.amps = Number(f.get('amps'));
  if (f.has('curve')) d.curve = f.get('curve');
  if (f.has('ma')) d.ma = Number(f.get('ma'));
  if (d.type === 'mcb') d.qd = f.get('qd') || '';
  if (d.type === 'relay') {
    d.umax = Number(f.get('umax')) || d.umax;
    d.umin = Number(f.get('umin')) || d.umin;
    d.delay = Number(f.get('delay')) || 0;
  } else {
    d.on = f.has('on');
  }
  if (d.type === 'rcd') {
    const picked = new Set(f.getAll('qf'));
    for (const q in state) {
      if (state[q].type !== 'mcb') continue;
      if (picked.has(q)) state[q].qd = id;          // moves it from another RCD
      else if (state[q].qd === id) state[q].qd = '';
    }
  }
  editing = null;
  render();
  save();
});

const frame = document.getElementById('frame');
frame.addEventListener('click', e => {
  const s = e.target.closest('.slot[data-id]');
  if (s) openEditor(s.dataset.id);
});
frame.addEventListener('keydown', e => {
  const s = e.target.closest('.slot[data-id]');
  if (s && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEditor(s.dataset.id); }
});

/* ---------- options menu: export / import JSON ---------- */
const moreBtn = document.getElementById('moreBtn');
const menu = document.getElementById('menu');
const menuNote = document.getElementById('menuNote');

function setMenu(open) {
  menu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) menuNote.textContent = '';
}
moreBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(menu.hidden); });
// a tap outside the open menu only closes it (it does not open a device)
document.addEventListener('click', e => {
  if (menu.hidden || menu.contains(e.target) || moreBtn.contains(e.target)) return;
  e.stopPropagation();
  e.preventDefault();
  setMenu(false);
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

document.getElementById('exportBtn').addEventListener('click', async () => {
  const name = `panel-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(state, null, 2)], name, { type: 'application/json' });
  setMenu(false);
  // iPhone / iPad: the share sheet offers "Save to Files", AirDrop, Telegram ...
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

const importFile = document.getElementById('importFile');
document.getElementById('importBtn').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !data.Q1 || !data.QF1) throw new Error('not a panel file');
    const base = defaults();
    merge(base, data);
    state = base;
    await save();
    render();
    menuNote.textContent = 'Imported ✓';
  } catch (e) {
    console.error('Import failed', e);
    menuNote.textContent = 'This file is not a panel export.';
  }
  menu.hidden = false;
  moreBtn.setAttribute('aria-expanded', 'true');
});

/* ---------- start ---------- */
async function init() {
  render();                 // draw defaults at once
  state = await load();
  render();                 // then the saved data

  // ask the browser not to delete our data when space is low
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update().catch(() => {});
    }).catch(() => {});

    // iOS home-screen apps keep the old page until reload; reload once
    // when a new service worker takes control so the update shows up.
    // (skip the very first install, when there was no old version yet)
    const hadController = !!navigator.serviceWorker.controller;
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
  }
}

init();
