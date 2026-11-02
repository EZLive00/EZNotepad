// ============================================================
// compare.js —— 独立对比窗口
//
// 一屏两栏 + 右侧预览条，像编辑器那样看差异：
//   · 差异一律标红（行底淡红 / 行内深红 / 行号栏红竖条 / 预览条红点）
//   · 两侧同步滚动，任一栏滚动另一栏跟着走
//   · 预览条按「全局高度」画差异位置，点一下 / 拖着走就能跳过去
//   · 「编辑」打开后两栏直接改写，改完 Ctrl+S 落盘
//
// 大文件靠虚拟滚动：只渲染可视区 ±6 行，行高固定 20px（--cmp-row），
// 位置 = 行号 × 行高。所以滚动不卡，预览条的坐标也是精确的。
// ============================================================
import * as be from './backend.js';
import { buildSideBySide, diffStats, inlineDiff } from './diff.js';
import { toast } from './ui.js';
import { invoke } from '../vendor/api/core.js';
import { listen } from '../vendor/api/event.js';
import { getCurrentWindow } from '../vendor/api/window.js';
import { PhysicalPosition, PhysicalSize } from '../vendor/api/dpi.js';
import { tt, setLang, resolveLang, applyDom } from './i18n.js';
import { settings } from './state.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let ROW_H = (() => {
  const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-row'));
  return Number.isFinite(v) && v > 0 ? v : 20;
})();

const sideKey = (s) => (s === 'l' ? 'L' : 'R');

/* ---------------- 状态 ---------------- */
const S = {
  /* loaded = 这一侧有内容可比（来自文件，或用户直接粘进来的文本）。
     只认 path 的话，剪贴板里两段文本就没法对比 —— 而那正是最常用的用法之一。 */
  sides: {
    l: { path: '', name: '', loaded: false, lines: [''], enc: 'UTF-8', bom: false, eol: '\n', dirty: false, undo: [], redo: [] },
    r: { path: '', name: '', loaded: false, lines: [''], enc: 'UTF-8', bom: false, eol: '\n', dirty: false, undo: [], redo: [] },
  },
  opt: { ignoreWS: true, ignoreCase: false },
  rows: [],
  blocks: [],
  lineRow: { l: new Map(), r: new Map() },
  inline: new Map(),   // 行内字符级 diff 缓存，滚动时不重算
  cur: 0,
  edit: false,
  ver: 0,
  units: { l: 0, r: 0 },
  sig: { l: '', r: '' },
  pending: null,       // 还没合并进模型的那一行（输入防抖）
};

/**
 * 兜底铺满屏幕工作区。
 *
 * 正常路径是 Rust 侧按 SPI_GETWORKAREA 给窗口定尺寸（见 lib.rs），这里只在
 * 「明显没铺满」时补一手。量尺寸用 window.outerWidth/Height 而不是
 * getCurrentWindow().outerSize()：后者要窗口读取权限，被拒时整个函数会
 * 静默进 catch，兜底就形同不存在（踩过一次）。
 */
async function fitToScreen() {
  try {
    const dpr = window.devicePixelRatio || 1;
    const aw = Math.round(window.screen.availWidth * dpr);
    const ah = Math.round(window.screen.availHeight * dpr);
    const cw = Math.round(window.outerWidth * dpr);
    const ch = Math.round(window.outerHeight * dpr);
    if (Math.abs(cw - aw) < 40 && Math.abs(ch - ah) < 40) return;
    const w = getCurrentWindow();
    await w.setPosition(new PhysicalPosition(0, 0));
    await w.setSize(new PhysicalSize(aw, ah));
  } catch {}
}

/* ---------------- 主题 ---------------- */
/** 字号跟主窗口设置保持一致：13.5 是默认，对比窗口整体小 1px 更紧凑 */
function applyFontSize() {
  /* 字号跟着主窗口的设置走，直接读 state.js 里那份已经合并过默认值的 settings：
     自己再解析一遍 localStorage 就是三份真相（默认值也会各自漂） */
  const fs = Number.isFinite(settings.fontSize) && settings.fontSize > 0 ? settings.fontSize : 13.5;
  const cfs = Math.max(10, fs - 1);
  ROW_H = Math.round(cfs * 1.6);
  document.body.style.setProperty('--cmp-fs', cfs + 'px');
  document.body.style.setProperty('--cmp-row', ROW_H + 'px');
}

function applyTheme() {
  let t = settings.theme || 'auto';
  if (t === 'auto') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.dataset.theme = t;
}

/* ---------------- 模型 ---------------- */
const unitsOf = (s) => {
  let n = 0;
  for (const ch of s) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC40-\uFFDC]/.test(ch) ? 2 : 1;
  return n;
};

/** 按「左/右各自的最长行」估算画布宽度；等宽字体，一个半角字符宽度固定 */
function measureCharW() {
  const mono = (getComputedStyle(document.body).getPropertyValue('--font-mono') || '').trim()
    || 'Consolas, monospace';
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;line-height:20px';
  probe.style.fontFamily = mono;
  probe.style.fontSize = (parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-fs')) || 12.5) + 'px';
  probe.textContent = '0123456789';
  document.body.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return w > 0 ? w : 7.6;
}
let CHAR_W = 7.6;

function recompute() {
  const L = S.sides.l, R = S.sides.r;
  const hasL = L.loaded, hasR = R.loaded;
  S.inline.clear();
  S.lineRow = { l: new Map(), r: new Map() };

  if (!hasL && !hasR) {
    S.rows = [];
    S.blocks = [];
    S.cur = 0;
    S.units = { l: 0, r: 0 };
    return;
  }

  if (hasL && hasR) {
    const { rows, blocks } = buildSideBySide(L.lines, R.lines, S.opt);
    S.rows = rows;
    S.blocks = blocks;
  } else {
    // 只开了一侧：当成并排阅读器用，不做差异标记
    const src = hasL ? L : R;
    S.rows = src.lines.map((text, i) => (hasL
      ? { l: { no: i + 1, text }, r: null, kind: 'same' }
      : { l: null, r: { no: i + 1, text }, kind: 'same' }));
    S.blocks = [];
  }

  S.rows.forEach((row, i) => {
    if (row.l) S.lineRow.l.set(row.l.no, i);
    if (row.r) S.lineRow.r.set(row.r.no, i);
  });

  let ul = 0, ur = 0;
  for (const row of S.rows) {
    if (row.l) ul = Math.max(ul, unitsOf(row.l.text));
    if (row.r) ur = Math.max(ur, unitsOf(row.r.text));
  }
  // 单侧打开时，另一侧按同一宽度排，滚动条不会左右跳
  if (!hasR) ur = ul;
  if (!hasL) ul = ur;
  S.units = { l: ul, r: ur };
  if (S.cur >= S.blocks.length) S.cur = 0;
}

/* ---------------- 渲染 ---------------- */
function el(side, what) {
  return $(what + sideKey(side));
}

function blockRange(i) {
  // 当前定位块的首尾行索引。不能用「下一块的起点 - 1」：最后一块没有下一块，
  // 也不该把块尾后面那些相同行算进来（会一路框到文档末尾）
  if (!S.blocks.length || i < 0 || i >= S.blocks.length) return [-1, -1];
  const start = S.blocks[i];
  let end = start;
  while (end + 1 < S.rows.length && S.rows[end + 1].kind !== 'same') end++;
  return [start, end];
}

function rowClass(row, i, side) {
  const cell = side === 'l' ? row.l : row.r;
  const isDiff = row.kind !== 'same' && !!cell;
  const cls = ['cmp-row'];
  if (isDiff) cls.push('diff');
  if (!cell) cls.push('void');
  if (isDiff) {
    if (i === 0 || S.rows[i - 1].kind === 'same') cls.push('b-start');
    if (i === S.rows.length - 1 || S.rows[i + 1].kind === 'same') cls.push('b-end');
  }
  return cls.join(' ');
}

function rowHtml(row, i, side) {
  const cell = side === 'l' ? row.l : row.r;
  let inner = '';
  if (cell) {
    if (row.kind === 'chg' && row.l && row.r) {
      let d = S.inline.get(i);
      if (!d) { d = inlineDiff(row.l.text, row.r.text); S.inline.set(i, d); }
      inner = side === 'l' ? d.l : d.r;
    } else {
      inner = esc(cell.text);
    }
  }
  const editable = S.edit && cell ? ' contenteditable="plaintext-only" spellcheck="false"' : '';
  return `<div class="${rowClass(row, i, side)}" style="top:${i * ROW_H}px">`
    + `<span class="cmp-ln">${cell ? cell.no : ''}</span>`
    + `<span class="cmp-tx" data-i="${i}" data-side="${side}" data-n="1"${editable}>${inner}</span>`
    + '</div>';
}

function renderRows(side, force = false) {
  const sc = el(side, 'scroll');
  const cv = el(side, 'canvas');
  const total = S.rows.length;
  const vh = sc.clientHeight || 400;

  const first = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 6);
  const last = Math.min(total - 1, Math.ceil((sc.scrollTop + vh) / ROW_H) + 6);
  const sig = `${first}:${last}:${S.ver}:${S.cur}`;
  if (!force && S.sig[side] === sig) return;

  // 正在这一栏里打字时不要重建 DOM：重建会把光标弄丢。
  // 但滚动到光标行之外还是要重建，否则会看着一屏旧内容。
  const active = document.activeElement;
  if (S.edit && !force && active && cv.contains(active)) {
    const ai = +active.dataset.i;
    if (ai >= first && ai <= last) return;
  }

  S.sig[side] = sig;
  const out = [];
  for (let i = first; i <= last; i++) out.push(rowHtml(S.rows[i], i, side));
  el(side, 'rows').innerHTML = out.join('');
}

function render(force = false) {
  const total = S.rows.length;
  const h = total * ROW_H;
  for (const side of ['l', 'r']) {
    const cv = el(side, 'canvas');
    cv.style.height = Math.max(h, 1) + 'px';
    cv.style.width = Math.round(S.units[side] * CHAR_W + 54 + 40) + 'px';
    renderRows(side, force);
  }
  updateCurBox();
  updateStats();
  updateMeta();
  drawRuler();
  updateEmpty();
}

// 当前定位块用一个覆盖层框住，而不是给每行各画一个框：
// 逐行画会把整块切成表格格子，看着像坏了
function updateCurBox() {
  const [cs, ce] = blockRange(S.cur);
  for (const side of ['l', 'r']) {
    const box = el(side, 'cur');
    if (!box) continue;
    if (cs < 0) { box.hidden = true; continue; }
    box.hidden = false;
    box.style.top = cs * ROW_H + 'px';
    box.style.height = (ce - cs + 1) * ROW_H + 'px';
  }
}

function updateStats() {
  const hasL = S.sides.l.loaded, hasR = S.sides.r.loaded;
  if (!hasL && !hasR) {
    $('stat').textContent = tt('选两个文件，或者直接粘贴两段文本');
    $('curInfo').textContent = '';
    return;
  }
  if (!hasL || !hasR) {
    $('stat').textContent = tt('只打开了一侧：可以当并排阅读器用，选另一侧即开始对比');
    $('curInfo').textContent = '';
    return;
  }
  const st = diffStats(S.rows);
  const same = st.add + st.del + st.chg === 0;
  $('stat').textContent = same
    ? tt('两侧内容完全一致')
    : tt('修改 {chg} 行 · 仅左 {del} 行 · 仅右 {add} 行 · 差异 {n} 处', { chg: st.chg, del: st.del, add: st.add, n: S.blocks.length });
  $('curInfo').textContent = S.blocks.length ? tt('第 {i} / {n} 处', { i: S.cur + 1, n: S.blocks.length }) : '';
  $('prev').disabled = !S.blocks.length;
  $('next').disabled = !S.blocks.length;
  $('report').disabled = same;
}

function updateMeta() {
  for (const side of ['l', 'r']) {
    const st = S.sides[side];
    const k = sideKey(side);
    const nameEl = $('name' + k);
    const phEl = $('ph' + k);
    const metaEl = $('meta' + k);
    if (st.loaded) {
      /* 没有文件的那一侧是用户粘进来的文本：槽位和栏头都不能写成「未选择」 */
      nameEl.textContent = st.path ? st.name : (side === 'l' ? tt('左侧文本') : tt('右侧文本'));
      nameEl.title = st.path || '';
      phEl.textContent = nameEl.textContent;
      const n = st.lines.length;
      metaEl.textContent = tt('{n} 行', { n }) + (st.path ? ' · ' + st.enc + (st.eol === '\r\n' ? ' · CRLF' : '') : '');
      /* 文本侧（无文件）永远存不进磁盘，标脏时也只是提醒「还没落盘过」 */
      if (!st.path || st.dirty) metaEl.textContent += ' · ' + tt('未保存');
    } else {
      nameEl.textContent = (side === 'l' ? tt('左侧') : tt('右侧')) + tt('未选择');
      nameEl.title = '';
      phEl.textContent = side === 'l' ? tt('左侧') : tt('右侧');
      metaEl.textContent = '';
    }
  }
  updateDots();
  $('save').disabled = !(S.sides.l.dirty || S.sides.r.dirty);
}

function updateDots() {
  $('dotL').classList.toggle('on', S.sides.l.dirty);
  $('dotR').classList.toggle('on', S.sides.r.dirty);
}

function updateEmpty() {
  const empty = !S.sides.l.loaded && !S.sides.r.loaded;
  $('empty').hidden = !empty;
}

/* ---------------- 预览条 ---------------- */
let RED = '#d92b2b';
let ACCENT = '#3366f0';

function cacheColors() {
  const cs = getComputedStyle(document.body);
  RED = (cs.getPropertyValue('--cmp-red') || '#d92b2b').trim();
  ACCENT = (cs.getPropertyValue('--accent') || '#3366f0').trim();
}

function drawRuler() {
  const box = $('ruler');
  const cv = $('rulerC');
  const w = box.clientWidth || 16;
  const h = box.clientHeight || 1;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const total = S.rows.length;
  if (!total) return;

  const per = h / total;
  const halfW = Math.max(3, (w - 5) / 2);
  const leftX = 2;
  const rightX = 2 + halfW + 1;

  // 差异块：左边一半标记左栏、右边一半标记右栏，两半都红，一眼能看出
  // 「这一段两侧都有改动」还是「只有一边有」
  g.fillStyle = RED;
  let i = 0;
  while (i < total) {
    const row = S.rows[i];
    if (row.kind === 'same') { i++; continue; }
    const start = i;
    while (i < total && S.rows[i].kind !== 'same') i++;
    const y = start * per;
    const hh = Math.max(2, (i - start) * per);
    // 整段里只要有一行在左/右存在，就在那半边画
    let onL = false, onR = false;
    for (let k = start; k < i; k++) {
      if (S.rows[k].l) onL = true;
      if (S.rows[k].r) onR = true;
    }
    if (onL) g.fillRect(leftX, y, halfW, hh);
    if (onR) g.fillRect(rightX, y, halfW, hh);
  }

  // 视口指示：细框，别盖住红点
  const sc = el('l', 'scroll');
  const totalH = total * ROW_H;
  const top = (sc.scrollTop / totalH) * h;
  const vh = Math.max(8, (sc.clientHeight / totalH) * h);
  g.globalAlpha = .16;
  g.fillStyle = ACCENT;
  g.fillRect(0, top, w, vh);
  g.globalAlpha = .5;
  g.strokeStyle = ACCENT;
  g.lineWidth = 1;
  g.strokeRect(.5, Math.round(top) + .5, w - 1, Math.max(6, vh) - 1);
  g.globalAlpha = 1;
}

function jumpToRatio(ratio) {
  const total = S.rows.length;
  if (!total) return;
  const sc = el('l', 'scroll');
  const y = ratio * total * ROW_H;
  sc.scrollTop = clamp(y - sc.clientHeight / 2, 0, Math.max(0, total * ROW_H - sc.clientHeight));
  syncFrom('l', sc.scrollTop, sc.scrollLeft);
  render(true);
}

let rulerDrag = false;

function rulerRatio(e) {
  const r = $('ruler').getBoundingClientRect();
  return clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1);
}

/* ---------------- 滚动同步 ---------------- */
let syncing = false;

function syncFrom(side, top, left) {
  const other = el(side === 'l' ? 'r' : 'l', 'scroll');
  if (Math.abs(other.scrollTop - top) > .5) other.scrollTop = top;
  if (Math.abs(other.scrollLeft - left) > .5) other.scrollLeft = left;
}

function bindScroll(side) {
  el(side, 'scroll').addEventListener('scroll', () => {
    const sc = el(side, 'scroll');
    if (!syncing) {
      syncing = true;
      syncFrom(side, sc.scrollTop, sc.scrollLeft);
      // 另一栏的 scroll 事件会紧跟在这个之后触发，下一帧才允许再同步
      requestAnimationFrame(() => { syncing = false; });
    }
    renderRows(side);
    const other = side === 'l' ? 'r' : 'l';
    renderRows(other);
    drawRuler();
  }, { passive: true });
}

/* ---------------- 导航 ---------------- */
function gotoBlock(i) {
  if (!S.blocks.length) { toast(tt('两侧没有差异')); return; }
  S.cur = ((i % S.blocks.length) + S.blocks.length) % S.blocks.length;
  const row = S.blocks[S.cur];
  const sc = el('l', 'scroll');
  sc.scrollTop = clamp(row * ROW_H - sc.clientHeight / 2 + ROW_H, 0, Math.max(0, S.rows.length * ROW_H - sc.clientHeight));
  syncFrom('l', sc.scrollTop, sc.scrollLeft);
  S.ver++;
  render(true);
}

/* ---------------- 打开文件 ---------------- */
async function loadSide(side, path) {
  if (!path) return;
  try {
    const r = await be.readText(path);
    const st = S.sides[side];
    st.path = r.path;
    st.name = r.name;
    st.loaded = true;
    st.enc = r.encoding || 'UTF-8';
    st.bom = !!r.bom;
    st.eol = r.eol === 'CRLF' ? '\r\n' : '\n';
    st.lines = String(r.content).replace(/\r\n?/g, '\n').split('\n');
    st.dirty = false;
    st.undo.length = 0;
    st.redo.length = 0;
  } catch (e) {
    toast(tt('读取失败：') + e);
    return;
  }
  S.pending = null;
  S.ver++;
  recompute();
  el('l', 'scroll').scrollTop = 0;
  el('r', 'scroll').scrollTop = 0;
  S.cur = 0;
  render(true);
  updateMeta();
}

async function loadPair(left, right) {
  if (left) await loadSide('l', left);
  if (right) await loadSide('r', right);
  if (left || right) {
    recompute();
    S.cur = 0;
    render(true);
  }
  updateEmpty();
}

/**
 * 没有文件也能比：把一侧开成空白文本，进编辑模式并把光标落进去，
 * 用户随后 Ctrl+V 粘进来就行（多行粘贴由 onInput 按行拆开并进模型）。
 * 这一侧已经有文件时只切编辑，不冲掉内容。
 */
function startText(side) {
  const st = S.sides[side];
  if (st.path) { setEdit(true); focusAt(side, 1, 0); return; }
  st.name = '';
  st.loaded = true;
  st.lines = [''];
  st.dirty = false;
  st.enc = 'UTF-8';
  st.bom = false;
  st.eol = '\n';
  st.undo.length = 0;
  st.redo.length = 0;
  S.pending = null;
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  updateEmpty();
  setEdit(true);
  focusAt(side, 1, 0);
}

/** 空状态里的「直接粘贴两段文本」：两侧都开白，最后把光标落在左侧 */
function startPairText() {
  startText('l');
  startText('r');
  focusAt('l', 1, 0);
}

/** 开/关编辑态。按钮与「直接粘贴文本」两条入口共用，避免两套状态切换 */
function setEdit(on) {
  if (S.pending) { flush(); S.ver++; recompute(); }
  S.edit = !!on;
  $('toggleEdit').classList.toggle('on', S.edit);
  $('paneL').classList.toggle('editing', S.edit);
  $('paneR').classList.toggle('editing', S.edit);
  S.ver++;
  render(true);
}

/* ---------------- 编辑 ---------------- */
function sideOf(node) {
  const pane = node.closest && node.closest('.cmp-pane');
  return pane && pane.id === 'paneL' ? 'l' : 'r';
}

function readRow(host) {
  let t = host.innerText.replace(/\r/g, '');
  // contenteditable 落单的空行会带一个隐式换行，它不是用户打的
  if (t.endsWith('\n')) t = t.slice(0, -1);
  return t;
}

function offsetIn(host, node, off) {
  try {
    const r = document.createRange();
    r.setStart(host, 0);
    r.setEnd(node, off);
    return r.toString().length;
  } catch { return 0; }
}

function caretPos() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node) return null;
  const elem = node.nodeType === 1 ? node : node.parentElement;
  const host = elem && elem.closest && elem.closest('.cmp-tx');
  if (!host) return null;
  const side = sideOf(host);
  const i = +host.dataset.i;
  const row = S.rows[i];
  if (!row) return null;
  const cell = side === 'l' ? row.l : row.r;
  if (!cell) return null;
  return { side, i, line: cell.no, col: offsetIn(host, sel.anchorNode, sel.anchorOffset) };
}

function nodeAt(host, col) {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let rest = col;
  let n = walker.nextNode();
  while (n) {
    if (rest <= n.data.length) return { node: n, off: rest };
    rest -= n.data.length;
    n = walker.nextNode();
  }
  return { node: host, off: host.childNodes.length };
}

function focusAt(side, line, col) {
  const i = S.lineRow[side].get(line);
  if (i == null) return;
  const sc = el(side, 'scroll');
  const y = i * ROW_H;
  if (y < sc.scrollTop || y + ROW_H > sc.scrollTop + sc.clientHeight) {
    sc.scrollTop = Math.max(0, y - sc.clientHeight / 2);
    syncFrom(side, sc.scrollTop, sc.scrollLeft);
  }
  render(true);
  const host = el(side, 'canvas').querySelector(`.cmp-tx[data-i="${i}"]`);
  if (!host) return;
  host.focus();
  const p = nodeAt(host, col);
  const r = document.createRange();
  try {
    r.setStart(p.node, p.off);
    r.collapse(true);
  } catch { return; }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 把「正在输入的那一行」并回模型（输入防抖，拖太久也不能丢字） */
function flush() {
  const p = S.pending;
  S.pending = null;
  if (!p || !p.host || !p.host.isConnected) return null;
  const text = readRow(p.host);
  const parts = text.split('\n');
  const st = S.sides[p.side];
  st.lines.splice(p.at, p.n, ...parts);
  st.dirty = true;
  updateMeta();
  return { side: p.side, line: p.at + 1, parts: parts.length };
}

let undoTick = 0;
function pushUndo(side) {
  const now = Date.now();
  if (now - undoTick < 700) return;
  undoTick = now;
  const st = S.sides[side];
  st.undo.push(st.lines.slice());
  if (st.undo.length > 120) st.undo.shift();
  st.redo.length = 0;
}

/** 结构性编辑（换行 / 并行 / 缩进 / 撤销）之后统一走这里：重算、重画、把光标放回去。
 *  必须顺手标脏 —— 只有打字那条路径会经 flush() 标脏，换行、并行这些不经过它，
 *  漏掉的话 Ctrl+S 会认为「没有需要保存的改动」，改动直接丢掉（实测踩过）。 */
function applyEdit(side, line, col) {
  S.sides[side].dirty = true;
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  focusAt(side, line, col);
}

function onInput(e) {
  const host = e.target.closest && e.target.closest('.cmp-tx');
  if (!host || !S.edit) return;
  const side = sideOf(host);
  const i = +host.dataset.i;
  const row = S.rows[i];
  if (!row) return;
  const cell = side === 'l' ? row.l : row.r;
  if (!cell) return;

  pushUndo(side);
  const pos = caretPos();
  const col = pos ? pos.col : 0;
  const text = readRow(host);
  const upto = text.slice(0, col);
  const nl = upto.split('\n').length - 1;
  const targetLine = cell.no + nl;
  const targetCol = col - (upto.lastIndexOf('\n') + 1);

  S.pending = { host, side, at: cell.no - 1, n: Math.max(1, +host.dataset.n || 1) };
  S.sides[side].dirty = true;
  updateDots();
  $('save').disabled = false;

  clearTimeout(onInput.timer);
  onInput.timer = setTimeout(() => {
    flush();
    applyEdit(side, targetLine, targetCol);
  }, 300);
}

function insertText(side, lineIdx, col, text) {
  const st = S.sides[side];
  const cur = st.lines[lineIdx] || '';
  st.lines[lineIdx] = cur.slice(0, col) + text + cur.slice(col);
  applyEdit(side, lineIdx + 1, col + text.length);
}

function splitLine(side, lineIdx, col) {
  const st = S.sides[side];
  const cur = st.lines[lineIdx] || '';
  st.lines.splice(lineIdx, 1, cur.slice(0, col), cur.slice(col));
  applyEdit(side, lineIdx + 2, 0);
}

function mergeUp(side, lineIdx) {
  if (lineIdx <= 0) return;
  const st = S.sides[side];
  const prev = st.lines[lineIdx - 1] || '';
  const cur = st.lines[lineIdx] || '';
  st.lines.splice(lineIdx - 1, 2, prev + cur);
  applyEdit(side, lineIdx, prev.length);
}

function mergeDown(side, lineIdx) {
  const st = S.sides[side];
  if (lineIdx >= st.lines.length - 1) return;
  const cur = st.lines[lineIdx] || '';
  const next = st.lines[lineIdx + 1] || '';
  st.lines.splice(lineIdx, 2, cur + next);
  applyEdit(side, lineIdx + 1, cur.length);
}

function moveVert(side, line, dir, col) {
  const target = line + dir;
  if (target < 1 || target > S.sides[side].lines.length) return;
  const len = (S.sides[side].lines[target - 1] || '').length;
  focusAt(side, target, Math.min(col, len));
}

function undo(side, redo) {
  const st = S.sides[side];
  const from = redo ? st.redo : st.undo;
  const to = redo ? st.undo : st.redo;
  if (!from.length) return;
  to.push(st.lines.slice());
  st.lines = from.pop();
  st.dirty = true;
  applyEdit(side, 1, 0);
}

function onKey(e) {
  if (!S.edit) return;
  const host = e.target.closest && e.target.closest('.cmp-tx');
  if (!host) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();

  if (mod && k === 's') { e.preventDefault(); save(); return; }
  if (mod && k === 'z') { e.preventDefault(); flush(); undo(sideOf(host), e.shiftKey); return; }
  if (mod && k === 'y') { e.preventDefault(); flush(); undo(sideOf(host), false); return; }

  const side = sideOf(host);
  if (e.key === 'Tab') { e.preventDefault(); const p = caretPos(); flush(); if (p) insertText(side, p.line - 1, p.col, '    '); return; }

  const pos = caretPos();
  if (!pos) return;
  const lineIdx = pos.line - 1;

  if (e.key === 'Enter') { e.preventDefault(); flush(); splitLine(side, lineIdx, pos.col); return; }
  if (e.key === 'Backspace' && pos.col === 0) { e.preventDefault(); flush(); mergeUp(side, lineIdx); return; }
  if (e.key === 'Delete' && pos.col === host.innerText.replace(/\r|\n/g, '').length) {
    e.preventDefault(); flush(); mergeDown(side, lineIdx); return;
  }
  if (e.key === 'ArrowUp') { e.preventDefault(); flush(); moveVert(side, pos.line, -1, pos.col); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); flush(); moveVert(side, pos.line, 1, pos.col); return; }
}

/* ---------------- 保存 ---------------- */
async function save() {
  if (S.pending) { flush(); S.ver++; recompute(); render(true); }
  const dirty = ['l', 'r'].filter((k) => S.sides[k].path && S.sides[k].dirty);
  if (!dirty.length) {
    /* 粘进来的文本没有磁盘目标，这时候说「没有需要保存的改动」是在骗人 */
    const textDirty = ['l', 'r'].some((k) => !S.sides[k].path && S.sides[k].loaded && S.sides[k].dirty);
    toast(textDirty ? tt('粘贴进来的文本没有对应文件，无法保存') : tt('没有需要保存的改动'));
    return;
  }
  for (const k of dirty) {
    const st = S.sides[k];
    try {
      await be.saveText({ path: st.path, content: st.lines.join(st.eol), encoding: st.enc, bom: st.bom });
      st.dirty = false;
    } catch (e) {
      toast(tt('保存失败：') + e);
      return;
    }
  }
  updateMeta();
  toast(tt('已保存 {n} 个文件', { n: dirty.length }));
}

/* ---------------- 报告 ---------------- */
async function saveReport() {
  const p = await be.pickSavePath(tt('对比报告.html'));
  if (!p) return;
  const st = diffStats(S.rows);
  const rowHtml = (side) => S.rows.map((r) => {
    const c = side === 'l' ? r.l : r.r;
    if (!c) return '<div class="row void"><span class="ln"></span><span class="tx"></span></div>';
    let t = esc(c.text);
    if (r.kind === 'chg' && r.l && r.r) t = side === 'l' ? inlineDiff(r.l.text, r.r.text).l : inlineDiff(r.l.text, r.r.text).r;
    const cls = r.kind === 'same' ? '' : 'diff';
    return `<div class="row ${cls}"><span class="ln">${c.no}</span><span class="tx">${t}</span></div>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>${tt('文本对比报告')}</title>
<style>
body{font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;margin:0;padding:28px;color:#1f2430;background:#fff}
h1{font-size:20px;margin:0 0 6px}.meta{color:#6b7280;font-size:12.5px;margin-bottom:16px}
.bar{display:flex;gap:18px;font-size:12.5px;margin-bottom:16px;color:#b4232a}
.grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #e2e6ec;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.col+.col{border-left:1px solid #e2e6ec}.head{background:#f4f6f9;font-weight:600;padding:8px 12px;font-family:sans-serif;font-size:12px}
.row{display:flex;line-height:1.6}.ln{width:52px;flex:none;text-align:right;padding-right:10px;color:#9aa3b2;font-size:11px}
.tx{flex:1;white-space:pre-wrap;word-break:break-all;padding:0 8px}
.diff{background:rgba(217,43,43,.07)}.diff .ln{color:#b4232a;box-shadow:inset 3px 0 0 #b4232a}
mark{background:rgba(217,43,43,.2)}mark.rem{background:rgba(217,43,43,.32);text-decoration:line-through}
</style>
<h1>${tt('文本对比报告')}</h1>
<div class="meta">${esc(S.sides.l.name || tt('空'))} ⇄ ${esc(S.sides.r.name || tt('空'))} · ${new Date().toLocaleString()}</div>
<div class="bar"><span>${tt('修改 {n} 行', { n: st.chg })}</span><span>${tt('仅左 {n} 行', { n: st.del })}</span><span>${tt('仅右 {n} 行', { n: st.add })}</span><span>${tt('差异 {n} 处', { n: S.blocks.length })}</span></div>
<div class="grid"><div class="col"><div class="head">${esc(S.sides.l.name || tt('左'))}</div>${rowHtml('l')}</div>
<div class="col"><div class="head">${esc(S.sides.r.name || tt('右'))}</div>${rowHtml('r')}</div></div>`;
  await be.writeBinary(p, new TextEncoder().encode(html));
  toast(tt('报告已导出：') + be.baseName(p));
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  // 窗口按钮。最大化不走 toggleMaximize：无边框窗口没有系统最大化状态可切
  // （tao 的 MAXIMIZED 标志位在窗口可见前就被写脏了），改成 Rust 侧切两个矩形。
  const w = (() => { try { return getCurrentWindow(); } catch { return null; } })();
  if (w) {
    let filled = true;               // 打开时就是铺满的，见 lib.rs
    $('wmin').onclick = () => w.minimize();
    $('wmax').onclick = () => {
      filled = !filled;
      be.setCompareFill(filled).catch(() => { filled = !filled; });
    };
    $('wclose').onclick = () => w.close();
  }

  $('slotL').onclick = pickSide('l');
  $('slotR').onclick = pickSide('r');
  $('pickL').onclick = pickSide('l');
  $('pickR').onclick = pickSide('r');

  $('swap').onclick = () => {
    if (!S.sides.l.loaded && !S.sides.r.loaded) return;
    const t = S.sides.l;
    S.sides.l = S.sides.r;
    S.sides.r = t;
    S.pending = null;
    S.ver++;
    recompute();
    render(true);
    updateMeta();
  };

  $('optWS').onchange = (e) => { S.opt.ignoreWS = e.target.checked; S.ver++; recompute(); render(true); };
  $('optCase').onchange = (e) => { S.opt.ignoreCase = e.target.checked; S.ver++; recompute(); render(true); };

  $('prev').onclick = () => gotoBlock(S.cur - 1);
  $('next').onclick = () => gotoBlock(S.cur + 1);
  $('save').onclick = save;
  $('report').onclick = saveReport;

  /* 编辑开关抽成函数：空状态「直接粘贴文本」也要进同一个状态机。
     两侧都空时点「编辑」，直接当成「我要粘两段文本」处理 —— 比弹一句
     「先选文件」有用得多 */
  $('toggleEdit').onclick = () => {
    if (!S.sides.l.loaded && !S.sides.r.loaded) { startPairText(); return; }
    setEdit(!S.edit);
    toast(S.edit ? tt('编辑已打开：直接改字，Ctrl+S 写回磁盘') : tt('编辑已关闭'));
  };
  $('pastePair').onclick = startPairText;

  for (const side of ['l', 'r']) {
    bindScroll(side);
    const cv = el(side, 'canvas');
    cv.addEventListener('input', onInput);
    cv.addEventListener('keydown', onKey);
    cv.addEventListener('blur', () => {
      if (!S.pending) return;
      const info = flush();
      S.ver++;
      recompute();
      render(true);
      void info;
    }, true);
    // 只读态下不允许输入，避免 caret 跑进去
    cv.addEventListener('beforeinput', (e) => { if (!S.edit) e.preventDefault(); });
  }

  const ruler = $('ruler');
  ruler.addEventListener('pointerdown', (e) => {
    rulerDrag = true;
    try { ruler.setPointerCapture(e.pointerId); } catch {}
    jumpToRatio(rulerRatio(e));
  });
  ruler.addEventListener('pointermove', (e) => { if (rulerDrag) jumpToRatio(rulerRatio(e)); });
  const endDrag = (e) => {
    rulerDrag = false;
    try { ruler.releasePointerCapture(e.pointerId); } catch {}
  };
  ruler.addEventListener('pointerup', endDrag);
  ruler.addEventListener('pointercancel', endDrag);
  ruler.addEventListener('wheel', (e) => {
    const sc = el('l', 'scroll');
    sc.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const k = e.key;
    if (k === 'F8') { e.preventDefault(); gotoBlock(S.cur + 1); return; }
    if (k === 'F7') { e.preventDefault(); gotoBlock(S.cur - 1); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) {
      // 焦点不在可编辑行时也要能存
      e.preventDefault();
      save();
    }
  });

  window.addEventListener('resize', () => {
    render(true);
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme();
    cacheColors();
    render(true);
  });
}

function pickSide(side) {
  return async () => {
    const p = await be.pickFile(side === 'l' ? tt('选择左侧文件') : tt('选择右侧文件'));
    if (p) await loadSide(side, p);
  };
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  /* 对比窗口是独立页面，自己把语言定一次 —— 读的是同一份设置，和主窗口一致 */
  setLang(resolveLang(settings.lang));
  applyDom();
  document.title = 'EZNotepad · ' + tt('对比');
  /* 两侧槽位在没选文件时显示占位文字；这两处是按文件动态写的，只能在这里给初值 */
  document.getElementById('nameL').textContent = tt('左侧未选择');
  document.getElementById('nameR').textContent = tt('右侧未选择');

  applyTheme();
  await fitToScreen();
  cacheColors();
  CHAR_W = measureCharW();
  bind();
  updateMeta();
  recompute();
  render(true);

  listen('compare:load', (ev) => {
    const p = ev && ev.payload ? ev.payload : {};
    loadPair(p.left || null, p.right || null);
  });

  let req = null;
  try { req = await invoke('take_compare_request'); } catch { req = null; }
  if (req && (req.left || req.right)) await loadPair(req.left, req.right);
  else updateEmpty();
})();
