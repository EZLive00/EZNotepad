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
import { blockItems, arrange, rangeText } from './difflist.js';
import { sortLines, isSorted } from './linesort.js';
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

/* 对比窗口的上限。
   引擎本身很快（实测 5 万行 160ms、两份无关的 5 万行 85ms），真正吃资源的是
   读取、每行一个对象的行模型，以及导出报告（要把每一行都拼成 HTML）。
   8MB / 5 万行是「两份几万行的日志或导出文件」这个真实场景的上界。 */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 50000;

const fmtSize = (n) => (n >= 1024 * 1024
  ? (n / (1024 * 1024)).toFixed(1) + ' MB'
  : Math.max(1, Math.round(n / 1024)) + ' KB');

/* ---------------- 状态 ---------------- */
const S = {
  /* loaded = 这一侧有内容可比（来自文件，或用户直接粘进来的文本）。
     只认 path 的话，剪贴板里两段文本就没法对比 —— 而那正是最常用的用法之一。 */
  sides: {
    l: { path: '', name: '', loaded: false, lines: [''], enc: 'UTF-8', bom: false, eol: '\n', dirty: false, base: [''], undo: [], redo: [], undoAt: 0 },
    r: { path: '', name: '', loaded: false, lines: [''], enc: 'UTF-8', bom: false, eol: '\n', dirty: false, base: [''], undo: [], redo: [], undoAt: 0 },
  },
  opt: { ignoreWS: true, ignoreCase: false },
  rows: [],
  blocks: [],
  items: [],           // 差异清单的数据（recompute 时折好）
  lineRow: { l: new Map(), r: new Map() },
  inline: new Map(),   // 行内字符级 diff 缓存，滚动时不重算
  cur: 0,
  edit: false,
  ver: 0,
  units: { l: 0, r: 0 },
  sig: { l: '', r: '' },
  pending: null,       // 还没合并进模型的那一行（输入防抖）
  lastSort: null,      // 上一次「按字典排序」前的快照（两侧一起，Ctrl+Z 一次还原）
  lastSide: '',        // 最近一次改动落在哪一侧：光标不在行里时 Ctrl+Z 按它来
  list: { open: false, sort: 'pos', dir: 1, filter: 'all', sig: '' },
  warn: '',            // 上限提示文案，空串表示没有
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

  /* 占位行要能写。
     并排对齐必然让短的一侧补出「这一侧没有对应行」的空位。以前这些空位
     只是画个空 span：看着像空行，点上去没反应、也不能粘 —— 一侧贴完另一
     侧就彻底没法动了。现在它们可写，写下去等价于「在这一侧这里插一行」，
     插入位置 = 前面最后一个本侧行号 + 1。 */
  let lastL = 0, lastR = 0;
  for (const row of S.rows) {
    if (row.l) lastL = row.l.no; else row.fL = lastL + 1;
    if (row.r) lastR = row.r.no; else row.fR = lastR + 1;
  }

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
  /* 差异清单在这里一次性折好：render 会被滚动和导航频繁调用，不能每次都
     把几万行重扫一遍。rev 变化时清单才重建 DOM。 */
  S.items = blockItems(S.rows, S.blocks);
  S.list.rev = (S.list.rev || 0) + 1;
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
  /* 占位行（这一侧在这条对齐位置上没有行）同样可编辑：编辑即插入一行。
     不这样的话，一侧贴完内容，另一侧就只剩第 1 行能点，剩下全是「看着像
     空行、点上去毫无反应」的死行 —— 而那正是「粘贴两段文本」的必经之路。 */
  const editable = S.edit ? ' contenteditable="plaintext-only" spellcheck="false"' : '';
  const fill = S.edit && !cell ? ' data-fill="1"' : '';
  return `<div class="${rowClass(row, i, side)}" style="top:${i * ROW_H}px">`
    + `<span class="cmp-ln">${cell ? cell.no : ''}</span>`
    + `<span class="cmp-tx" data-i="${i}" data-side="${side}" data-n="1"${fill}${editable}>${inner}</span>`
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
    /* 宽度 **至少** 铺满可视区。只按内容算的话，贴上两段短文本时 canvas
       只有内容那么宽，行右侧那一大片「看起来还是正文」的空白其实不属于任何行；
       点上去落在 .cmp-sc 上，光标不动 —— 用户看到的就是「点了没反应」。
       内容更宽时仍然按内容算，横向滚动照旧。 */
    const viewW = el(side, 'scroll').clientWidth || 0;
    cv.style.width = Math.max(Math.round(S.units[side] * CHAR_W + 54 + 40), viewW) + 'px';
    renderRows(side, force);
  }
  /* 预览条本身只占内容那么高：短文档时它就是一小截，不会拉满整列 */
  const viewH = el('l', 'scroll').clientHeight || 0;
  $('ruler').style.height = Math.max(1, Math.min(viewH || h, h || 1)) + 'px';
  rulerCache = null;               // 高度/行数都可能刚变过，几何缓存作废
  updateCurBox();
  updateStats();
  updateMeta();
  drawRuler();
  updateEmpty();
  renderList();
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
    $('listBtn').disabled = true;
    if (S.list.open) toggleList(false);
    return;
  }
  if (!hasL || !hasR) {
    $('stat').textContent = tt('只打开了一侧：可以当并排阅读器用，选另一侧即开始对比');
    $('curInfo').textContent = '';
    $('listBtn').disabled = true;
    if (S.list.open) toggleList(false);
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
  $('listBtn').disabled = same;
  if (same && S.list.open) toggleList(false);
}

/**
 * 内容和「基线」（磁盘上那份）比：撤销回到原样时，脏标记必须自己消失。
 *
 * 逐行比字符串引用就够 —— slice() 只复制数组，没改过的行还是同一批字符串对象，
 * 8MB / 5 万行的文件也不会为此多存一份拼好的长字符串。
 */
function sameAsBase(st) {
  const a = st.base;
  const b = st.lines;
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function refreshDirty() {
  for (const k of ['l', 'r']) {
    const st = S.sides[k];
    st.dirty = st.loaded && !sameAsBase(st);
  }
}

/** 撤销 / 重做按钮的可用性：跟着**真实的历史栈**走，不跟「有没有加载文件」走。
 *  排序是整侧替换、只存一个 S.lastSort 快照，它也算一步可撤销的改动。
 *  只读态一律禁用 —— 键盘在只读态也不吃 Ctrl+Z，按钮亮着却点不动是更糟的谎话。 */
function syncHist() {
  const undoable = !!S.lastSort || S.sides.l.undo.length > 0 || S.sides.r.undo.length > 0;
  const redoable = S.sides.l.redo.length > 0 || S.sides.r.redo.length > 0;
  $('undoBtn').disabled = !S.edit || !undoable;
  $('redoBtn').disabled = !S.edit || !redoable;
}

/** 工具栏按钮的撤销 / 重做：落哪一侧跟 Ctrl+Z 用同一套判断
 *  （光标所在侧 → 最近改动侧 → 左边）。点了按钮焦点就在按钮上，
 *  `activeElement` 里找不到 .cmp-tx，正好落到后两级。 */
function doUndo(redo) {
  if (!S.edit) return;
  flush();                 // 还没落库的那一行先落，否则会说「没有可撤销的」
  const side = undoTarget({ target: document.activeElement });
  if (!side) return;
  if (!redo && undoSort()) return;   // 排序是整侧替换，先按整体撤
  undo(side, redo);
  /* undo() 在栈空时会提前 return，不经过 updateMeta —— 这里兜一次，
     让「撤到底」的瞬间按钮就变灰，而不是等下一次无关的重绘 */
  syncHist();
}

/** 工具栏按**真实溢出量**降级，不按窗口宽度猜阈值：同一份布局在九种语言下宽度
 *  差 100px 以上，猜出来的阈值必然在某种语言下把最右边的按钮裁掉。
 *  读 scrollWidth 会强制同步布局，所以只在 resize / 字体就绪 / 打完文字之后跑。 */
function fitTools() {
  const bar = $('tools');
  if (!bar) return;
  bar.classList.remove('tight', 'tighter');
  if (bar.scrollWidth <= bar.clientWidth + 1) return;
  bar.classList.add('tight');            // 一级：按钮只留图标
  if (bar.scrollWidth <= bar.clientWidth + 1) return;
  bar.classList.add('tighter');          // 二级：连勾选项的文字也收起来
}

let fitQueued = false;
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitTools(); });
}

function updateMeta() {
  refreshDirty();
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
  syncHist();
  /* 统计文字的长度会随内容变（「12 处差异」比「完全一致」长得多），
     折叠档位要跟着重算，否则统计一变长就又把右边挤出去了 */
  queueFit();
}

function updateDots() {
  $('dotL').classList.toggle('on', S.sides.l.dirty);
  $('dotR').classList.toggle('on', S.sides.r.dirty);
}

function updateEmpty() {
  const empty = !S.sides.l.loaded && !S.sides.r.loaded;
  $('empty').hidden = !empty;
}

/* ---------------- 差异清单 ----------------
   一个可排序的差异索引：大文件里 F8 只能一处一处挪，想「先把所有仅右的
   新增过一遍」就没有入口。清单把每个差异块摊平成一行，按位置 / 类型 /
   行数排序，也能按类型筛。 */
const LIST_MAX = 300;      // 超过就只画前 300 条：几万条 DOM 会让展开变卡

const kindText = (k) => (k === 'chg' ? tt('修改') : (k === 'add' ? tt('仅右') : tt('仅左')));

function renderList() {
  const panel = $('listPanel');
  if (!S.list.open) { panel.hidden = true; return; }
  panel.hidden = false;

  const list = arrange(S.items, S.list);
  $('listN').textContent = tt('共 {n} 处', { n: list.length });

  for (const b of $('listFilter').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.f === S.list.filter);
  }
  for (const b of document.querySelectorAll('.cmp-list-sort')) {
    const on = b.dataset.sort === S.list.sort;
    b.classList.toggle('on', on);
    b.textContent = (b.dataset.k || b.textContent) + (on ? (S.list.dir > 0 ? ' ↑' : ' ↓') : '');
  }

  /* 只在内容真的变了才重建 DOM：点清单里的某一条会触发 render，重建会把
     清单自己的滚动位置扔回顶部，连续浏览时很难用 */
  const sig = `${S.list.rev}:${S.list.sort}:${S.list.dir}:${S.list.filter}`;
  let rebuilt = false;
  if (sig !== S.list.drawn) {
    S.list.drawn = sig;
    S.list.cur = -1;
    rebuilt = true;
    if (!list.length) {
      $('listBody').innerHTML = `<div class="cmp-list-empty">${esc(tt('两侧没有差异'))}</div>`;
    } else {
      const out = list.slice(0, LIST_MAX).map((it) => {
        const pos = it.lFrom && it.rFrom
          ? `${it.lFrom} ⇄ ${it.rFrom}`
          : String(it.lFrom || it.rFrom);
        return `<button type="button" class="cmp-li" data-i="${it.index}">`
          + `<span class="cmp-li-pos">${pos}</span>`
          + `<span class="cmp-li-kind">${esc(kindText(it.kind))}</span>`
          + `<span class="cmp-li-n">${it.lines}</span>`
          + `<span class="cmp-li-tx">${esc(it.text || '')}</span>`
          + '</button>';
      }).join('');
      const more = list.length > LIST_MAX
        ? `<div class="cmp-list-more">${esc(tt('仅显示前 {n} 处，用 F8 继续浏览', { n: LIST_MAX }))}</div>`
        : '';
      $('listBody').innerHTML = out + more;
    }
  }

  if (S.list.cur !== S.cur) {
    S.list.cur = S.cur;
    for (const n of $('listBody').querySelectorAll('.cmp-li')) {
      n.classList.toggle('cur', +n.dataset.i === S.cur);
    }
    /* 重建后把当前项带进可视区。用 rect 差值手动改 scrollTop，
       scrollIntoView 会连正文一起滚 */
    const bd = $('listBody');
    const hit = bd.querySelector('.cmp-li.cur');
    if (rebuilt && hit) {
      const hb = hit.getBoundingClientRect(), bb = bd.getBoundingClientRect();
      bd.scrollTop += hb.top - bb.top - bd.clientHeight / 2 + hb.height / 2;
    }
  }
}

function toggleList(open) {
  S.list.open = open === undefined ? !S.list.open : !!open;
  $('listBtn').classList.toggle('on', S.list.open);
  $('listBtn').setAttribute('aria-expanded', String(S.list.open));
  $('listPanel').hidden = !S.list.open;
  if (S.list.open) renderList();
}

/* ---------------- 上限提示 ---------------- */
function showWarn(text) {
  const was = !!S.warn;
  S.warn = text || '';
  $('warnText').textContent = S.warn;
  $('warn').hidden = !S.warn;
  /* 提示条会挤占正文：空状态整体下移，预览条高度也要重算。
     高度取实测值 —— 文案长短不同会换行，写死一个数会差几像素。 */
  requestAnimationFrame(() => {
    const h = $('warn').hidden ? 0 : Math.round($('warn').getBoundingClientRect().height) + 8;
    document.body.style.setProperty('--cmp-warn-h', h + 'px');
    if (was !== !!S.warn) render(true);
  });
}

/* ---------------- 预览条 ----------------
 * 三种颜色，各说一件事，不许混用：
 *   红   = 这里有差异
 *   蓝   = 你现在停在这一处（只有一处）
 *   灰框 = 你正看着的这一屏
 * 以前视口框也用强调色：一条预览条上两处蓝，用户没法知道「蓝框」和「蓝点」
 * 根本不是一回事。视口是导航，不是内容，所以它该是中性色。
 */
let RED = '#d92b2b';
let ACCENT = '#3366f0';
let SOFT = '#8a8a8a';          // --fg-soft：视口框的中性色

function cacheColors() {
  const cs = getComputedStyle(document.body);
  RED = (cs.getPropertyValue('--cmp-red') || '#d92b2b').trim();
  ACCENT = (cs.getPropertyValue('--accent') || '#3366f0').trim();
  SOFT = (cs.getPropertyValue('--fg-soft') || '#8a8a8a').trim();
}

/** 圆角矩形：canvas 的 roundRect 在旧 WebView2 上不一定有，自己画 */
function roundRect(g, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

/**
 * 预览条的几何。
 *
 * 轨道从**滚动区顶部**开始，不是从预览条顶部：预览条与整列同高，而每栏
 * 顶上还有 26px 的文件名条。原先按预览条自身高度映射，最下面那 26px 的
 * 内容永远画不到，点击也差一截 —— 这就是「定位不准」的来源。
 *
 * 轨道高度 = min(可视高度, 内容高度)：文档不足一屏时按 1:1 画，预览条
 * 不会比正文还长，也不会再出现「视口框比容器还高」。
 */
let rulerCache = null;   // 滚动时几何不变，别每帧都量一遍（getBoundingClientRect 会触发 layout）

function rulerGeom(force = false) {
  if (!force && rulerCache) return rulerCache;
  const box = $('ruler');
  const sc = el('l', 'scroll');
  const rb = box.getBoundingClientRect();
  const sb = sc.getBoundingClientRect();
  const total = S.rows.length;
  const contentH = total * ROW_H;
  const viewH = sc.clientHeight || box.clientHeight || 1;
  const top = Math.max(0, Math.round(sb.top - rb.top));
  const h = Math.max(1, Math.round(Math.min(viewH, contentH || 1)));
  rulerCache = { box, cv: $('rulerC'), rb, top, h, contentH, viewH, total };
  return rulerCache;
}

function drawRuler() {
  const { box, cv, top, h, contentH, viewH, total } = rulerGeom();
  const w = Math.max(1, Math.round(box.clientWidth));
  const totalH = Math.max(1, Math.round(box.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(totalH * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(totalH * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, totalH);
  if (!total) return;

  // 轨道：整条竖槽，告诉用户「这块区域代表整个文件」
  const tw = 10;
  const tx = Math.round((w - tw) / 2);
  g.fillStyle = 'rgba(127,127,127,.11)';
  roundRect(g, tx, top, tw, h, 3);
  g.fill();

  const per = h / total;
  const sc = el('l', 'scroll');

  /* 差异段。直接用 recompute 折好的 S.items：每帧扫 5 万行去拼段，
     光这一步就能吃掉十几毫秒，滚动会明显发黏。
     密集处（每两行一处）几千个 3px 方块会叠成一整条红 —— 那本来就是实话，
     但逐块 fill 太碎，先把间距不足 1px 的合并成一段，再统一上色。 */
  const segs = [];
  for (const it of S.items) {
    const y = top + it.start * per;
    const hh = Math.max(3, (it.end - it.start + 1) * per);
    const last = segs[segs.length - 1];
    if (last && y <= last.y + last.h + .75) {
      last.h = Math.max(last.h, y + hh - last.y);
      last.cur = last.cur || it.index === S.cur;
    } else {
      segs.push({ y, h: hh, cur: it.index === S.cur });
    }
  }
  for (const s of segs) {
    /* 当前这处差异压得宽一点（左右各多 2px），像夹子夹住它。
       只靠蓝色不够：色弱、或者屏上只有一条窄缝时，宽度差比色相差更靠得住。 */
    g.fillStyle = s.cur ? ACCENT : RED;
    const w2 = s.cur ? tw + 4 : tw;
    const x2 = s.cur ? tx - 2 : tx;
    roundRect(g, x2, s.y, w2, s.h, Math.min(2, s.h / 2));
    g.fill();
  }

  /* 视口框：内容装得下一屏时不画 —— 那时整条轨道就是视口，
     画一个比容器还高的框既不准确也没有信息量（原先短文档就是这样）。
     用中性灰：它回答「我在文件的哪一段」，跟「哪里不一样」不是一件事。 */
  if (contentH <= viewH + 1) return;
  const y = top + (sc.scrollTop / contentH) * h;
  const vh = clamp((viewH / contentH) * h, 12, h);
  g.fillStyle = SOFT;
  g.globalAlpha = .15;
  roundRect(g, tx - 1, y, tw + 2, vh, 3);
  g.fill();
  g.globalAlpha = .55;
  g.strokeStyle = SOFT;
  g.lineWidth = 1;
  roundRect(g, tx - .5, Math.round(y) + .5, tw + 1, Math.max(11, vh - 1), 3);
  g.stroke();
  g.globalAlpha = 1;
}

/** 指针落在轨道上时返回 0..1；落在轨道外返回 null（短文档下半截是空白） */
function rulerRatio(e) {
  const { rb, top, h } = rulerGeom();
  const y = e.clientY - rb.top - top;
  if (y < 0 || y > h) return null;
  return clamp(y / h, 0, 1);
}

function jumpToRatio(ratio) {
  const total = S.rows.length;
  if (!total || ratio === null) return;
  const sc = el('l', 'scroll');
  const y = ratio * total * ROW_H;
  sc.scrollTop = clamp(y - sc.clientHeight / 2, 0, Math.max(0, total * ROW_H - sc.clientHeight));
  syncFrom('l', sc.scrollTop, sc.scrollLeft);
  renderRows('l');
  renderRows('r');
  drawRuler();
}

/** 悬停浮标：这一行是哪一侧的第几行、属于哪种改动 */
function rulerHover(e) {
  const tip = $('rulerTip');
  const gg = rulerGeom();
  const total = gg.total;
  if (!total) { tip.hidden = true; return; }
  const y = e.clientY - gg.rb.top - gg.top;
  if (y < 0 || y > gg.h) { tip.hidden = true; return; }
  const rowIdx = Math.min(total - 1, Math.floor((y / gg.h) * total));
  const r = S.rows[rowIdx];
  if (!r) { tip.hidden = true; return; }
  /* 并排行号对用户没意义，显示的是两侧文件里的真实行号 */
  const pos = r.l && r.r
    ? `${r.l.no} ⇄ ${r.r.no}`
    : (r.l ? tt('仅左') + ' ' + r.l.no : tt('仅右') + ' ' + r.r.no);
  const kind = r.kind === 'same' ? '' : ' · ' + (r.kind === 'chg' ? tt('修改') : (r.kind === 'add' ? tt('仅右') : tt('仅左')));
  tip.textContent = pos + kind;
  tip.hidden = false;
  tip.style.top = clamp(e.clientY - gg.rb.top, 14, gg.rb.height - 14) + 'px';
}

let rulerDrag = false;

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

/** 让浏览器先画一帧（toast / 按钮态），再做同步的重活 */
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function loadSide(side, path, opts = {}) {
  if (!path) return false;
  const name = be.baseName(path) || path;
  const st = S.sides[side];

  /* 「打开一对文件」时先清掉这一侧的旧内容：否则新文件因为超限没读进来，
     界面会拿上一轮的旧文件和新文件的另一侧去比，给出一个看似正常的结论 */
  if (opts.reset) {
    st.path = '';
    st.name = '';
    st.loaded = false;
    st.lines = [''];
    st.base = [''];
    st.dirty = false;
    st.undo.length = 0;
    st.redo.length = 0;
    st.undoAt = 0;
  }

  /* 先问大小再读：几百 MB 的文件读进内存再放弃，代价比一次 metadata 大得多 */
  let size = 0;
  try { size = await be.fileSize(path); } catch { size = 0; }
  if (size > MAX_BYTES) {
    const msg = tt('{name} 太大：{size}，上限 {limit}。请拆分后再比较。', {
      name, size: fmtSize(size), limit: fmtSize(MAX_BYTES),
    });
    showWarn(msg);
    toast(msg);
    return false;
  }

  try {
    const r = await be.readText(path);
    const lines = String(r.content).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MAX_LINES) {
      const msg = tt('{name} 行数太多：{n} 行，上限 {max} 行。请拆分后再比较。', {
        name, n: lines.length, max: MAX_LINES,
      });
      showWarn(msg);
      toast(msg);
      return false;
    }
    st.path = r.path;
    st.name = r.name;
    st.loaded = true;
    st.enc = r.encoding || 'UTF-8';
    st.bom = !!r.bom;
    st.eol = r.eol === 'CRLF' ? '\r\n' : '\n';
    st.lines = lines;
    st.base = lines.slice();
    st.dirty = false;
    st.undo.length = 0;
    st.redo.length = 0;
    st.undoAt = 0;
  } catch (e) {
    toast(tt('读取失败：') + e);
    return false;
  }
  if (opts.defer) return true;    // 成对打开时交给 loadPair 统一算一次

  S.pending = null;
  S.ver++;
  recompute();
  el('l', 'scroll').scrollTop = 0;
  el('r', 'scroll').scrollTop = 0;
  S.cur = 0;
  render(true);
  updateMeta();
  return true;
}

async function loadPair(left, right) {
  /* 清提示放在「用户发起了新的一次比较」这一刻：如果放进 loadSide 的成功
     分支，先失败（文件超限）、后成功（另一侧）会把刚给出的原因抹掉 */
  showWarn('');
  let got = false;
  const asked = !!(left || right);
  if (left) got = (await loadSide('l', left, { defer: true, reset: true })) || got;
  if (right) got = (await loadSide('r', right, { defer: true, reset: true })) || got;
  if (asked) {
    /* 上万行时先让「正在比较」这一帧画出来再算：同步计算会把整段
       绘制一起挡住，看上去就是点了没反应 */
    const n = Math.max(S.sides.l.lines.length, S.sides.r.lines.length);
    if (got && n > 20000) {
      toast(tt('正在比较 {n} 行…', { n }));
      await nextPaint();
    }
    S.pending = null;
    S.ver++;
    recompute();
    S.cur = 0;
    el('l', 'scroll').scrollTop = 0;
    el('r', 'scroll').scrollTop = 0;
    render(true);
    updateMeta();
    /* 打开一对文件就直接可写。用户已经在看这两份东西了，想改一个字却要先
       去工具栏找「编辑」按钮 —— 那个按钮的默认值一直是错的来源：点一下正文
       没反应，人会以为窗口坏了。只读仍然保留，作为用户主动选择的状态。
       误改有三层兜底：行上的脏标记、「Ctrl+Z」、关窗前确认。 */
    if (got && !S.edit) setEdit(true);
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
  st.base = [''];
  st.dirty = false;
  st.enc = 'UTF-8';
  st.bom = false;
  st.eol = '\n';
  st.undo.length = 0;
  st.redo.length = 0;
  st.undoAt = 0;
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
  /* 只读态撤销/重做按钮跟着灰掉：键盘在只读态也不吃 Ctrl+Z，
     按钮亮着却点不动，比直接灰着更让人困惑 */
  syncHist();
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
  const col = offsetIn(host, sel.anchorNode, sel.anchorOffset);
  const cell = side === 'l' ? row.l : row.r;
  /* 占位行：这一侧还没有这一行，但光标确实停在这里 —— 用户正在往这里写。
     返回「将来会插到第几行」，后续的 splitLine / mergeUp 才有行号可用。 */
  if (!cell) {
    const no = side === 'l' ? row.fL : row.fR;
    return no ? { side, i, line: no, col, fill: true } : null;
  }
  return { side, i, line: cell.no, col };
}

/**
 * 选区的起点与终点落在哪个可编辑宿主里。折叠（光标）时返回 null。
 *
 * 存在的理由：Backspace / Delete 的行首、行尾合并只看「光标」，
 * 而三击一行给出的选区**锚点就在行首**（实测 anchor.col=0、focus.col=11）。
 * 不分清楚「选中了一段」和「光标停在行首」，三击后再按 Backspace 就会被
 * 当成「光标在行首」→ mergeUp()，把整行并进上一行：看着只删掉了一个换行，
 * 选中的内容一点没动。
 */
function selectionSpan() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const hostOf = (node) => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    const h = e && e.closest ? e.closest('.cmp-tx') : null;
    return h || null;
  };
  const ha = hostOf(r.startContainer);
  const hb = hostOf(r.endContainer);
  if (!ha || !hb) return null;
  const sa = sideOf(ha);
  const sb = sideOf(hb);
  return {
    same: ha === hb,
    side: sa === sb ? sa : '',        // 跨两侧没有「一条文本」可删，别装作能删
    aI: +ha.dataset.i,
    bI: +hb.dataset.i,
    aCol: offsetIn(ha, r.startContainer, r.startOffset),
    bCol: offsetIn(hb, r.endContainer, r.endOffset),
  };
}

/** 删掉跨行的选区：把头尾两行的残段拼起来，中间整行去掉。
 *  浏览器不能跨 contenteditable 宿主删除，所以这一段必须自己算。 */
function deleteSpan(span) {
  const st = S.sides[span.side];
  const rowA = S.rows[span.aI];
  const rowB = S.rows[span.bI];
  if (!rowA || !rowB) return;
  const cellA = span.side === 'l' ? rowA.l : rowA.r;
  const cellB = span.side === 'l' ? rowB.l : rowB.r;
  if (!cellA || !cellB) return;
  const from = cellA.no - 1;
  const to = cellB.no - 1;
  if (from >= to) return;             // 同一行（或方向反常）：交给别的分支
  recordUndo(span.side);
  const head = st.lines[from] || '';
  const tail = st.lines[to] || '';
  st.lines.splice(from, to - from + 1, head.slice(0, span.aCol) + tail.slice(span.bCol));
  applyEdit(span.side, from + 1, span.aCol);
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
  /* 行号列号一律夹到当前内容里：撤销之后文档可能变短，调用方给的
     「原来那一行」就不存在了。不夹的话 lineRow.get() 返回 undefined，
     这个函数会直接 return —— 重画后 DOM 已换新，焦点就掉到 body 上，
     界面上表现为「撤完以后键盘没反应了」。 */
  const lines = S.sides[side].lines;
  line = Math.min(Math.max(1, line | 0), Math.max(1, lines.length));
  col = Math.min(Math.max(0, col | 0), (lines[line - 1] || '').length);
  focusRowIdx(side, S.lineRow[side].get(line), col);
}

/** 按「对齐行索引」聚焦。占位行没有本侧行号，只有索引 —— 点它时只能走这条 */
function focusRowIdx(side, i, col) {
  if (i == null || i < 0 || i >= S.rows.length) return;
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
  /* 排着队的那次「300ms 后再 flush + 把光标放回去」必须一起取消。
     否则：打完字马上点别处 → blur 在这里已经 flush 完、光标也挪到了新行，
     300ms 一到定时器照样 applyEdit(旧行号和旧列号)，把光标硬拽回原来那一行 ——
     表现就是「点了别处没反应，字还进原来那行」。 */
  clearTimeout(onInput.timer);
  if (!p || !p.host || !p.host.isConnected) return null;
  const text = readRow(p.host);
  const parts = text.split('\n');
  const st = S.sides[p.side];
  if (p.fill) {
    /* 占位行：这一侧还没有这一行，写下去 = 在这里插一行。
       什么都没写就什么也别插 —— 点一下空位不该给文档凭空添一行。 */
    if (!text) return null;
    const at = Math.min(Math.max(0, p.at), st.lines.length);
    st.lines.splice(at, 0, ...parts);
    st.dirty = true;
    updateMeta();
    return { side: p.side, line: at + 1, parts: parts.length };
  }
  st.lines.splice(p.at, p.n, ...parts);
  st.dirty = true;
  updateMeta();
  return { side: p.side, line: p.at + 1, parts: parts.length };
}

/* ---------------- 撤销 / 重做 ----------------
 * 历史上这里只有一个「打字专用」的 pushUndo，而且用**模块级**的 undoTick 节流：
 *   1. 换行、Tab 缩进、回车合并、删选区这些结构性编辑根本不记快照 → 按 Ctrl+Z 撤不回来
 *   2. 节流是全局的，左侧刚打完字 700ms 内改右侧，右侧连第一步都记不下
 * 于是「对比窗口没有撤销」这个印象是成立的。现在分成两条：
 *   recordUndo —— 结构性编辑，一次算一步，永远记
 *   pushUndo   —— 打字，700ms 内的连击并成一步（跟原生编辑器的手感一致）
 */
function snapshot(st) {
  st.undo.push(st.lines.slice());
  if (st.undo.length > 120) st.undo.shift();
  st.redo.length = 0;
}

function recordUndo(side) {
  /* 又要改了 —— 「最近一次操作是排序」这个前提不再成立。
     不清掉的话，排序后打几个字再按 Ctrl+Z，会一次跳回排序前的状态，
     把这些字连同排序一起抹掉。 */
  S.lastSort = null;
  const st = S.sides[side];
  if (!st) return;
  snapshot(st);
  st.undoAt = 0;        // 下一步打字另起一步，别跟这次结构性编辑并在一起
}

function pushUndo(side) {
  S.lastSort = null;
  const st = S.sides[side];
  if (!st) return;
  const now = Date.now();
  if (now - st.undoAt < 700) return;
  snapshot(st);
  st.undoAt = now;
}

/** Ctrl+Z / Ctrl+Y 落在哪一侧：跟光标走；光标不在行里就跟最近动过的那一侧，
 *  再退一步用「左边优先」—— 点过工具栏之后焦点在按钮上，不能因此就什么都不做 */
function undoTarget(e) {
  const host = e.target && e.target.closest && e.target.closest('.cmp-tx');
  if (host) return sideOf(host);
  if (S.lastSide) return S.lastSide;
  if (S.sides.l.loaded) return 'l';
  if (S.sides.r.loaded) return 'r';
  return '';
}


/** 结构性编辑（换行 / 并行 / 缩进 / 撤销）之后统一走这里：重算、重画、把光标放回去。
 *  必须顺手标脏 —— 只有打字那条路径会经 flush() 标脏，换行、并行这些不经过它，
 *  漏掉的话 Ctrl+S 会认为「没有需要保存的改动」，改动直接丢掉（实测踩过）。 */
function applyEdit(side, line, col) {
  S.sides[side].dirty = true;
  S.lastSide = side;          // 光标可能随后跑到工具栏上，撤销还得知道落在哪一侧
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
  const fill = host.dataset.fill === '1';
  if (!cell && !fill) return;

  S.lastSide = side;
  pushUndo(side);
  const pos = caretPos();
  const col = pos ? pos.col : 0;
  const text = readRow(host);
  const upto = text.slice(0, col);
  const nl = upto.split('\n').length - 1;
  const baseLine = cell ? cell.no : (side === 'l' ? row.fL : row.fR);
  if (!baseLine) return;
  const targetLine = baseLine + nl;
  const targetCol = col - (upto.lastIndexOf('\n') + 1);

  S.pending = {
    host, side,
    at: baseLine - 1,
    n: cell ? Math.max(1, +host.dataset.n || 1) : 0,
    fill: !cell,
  };
  S.sides[side].dirty = true;
  updateDots();
  $('save').disabled = false;

  /* 粘贴一整段（含换行）不排队等防抖：300ms 是给逐字打字用的，而多行粘贴会
     改变行数 —— 拖到 blur 再拆，这期间行号、差异标记、行映射都和屏幕上对不上，
     点别的行还会点到旧索引上。 */
  if (text.includes('\n')) {
    clearTimeout(onInput.timer);
    flush();
    applyEdit(side, targetLine, targetCol);
    return;
  }

  clearTimeout(onInput.timer);
  onInput.timer = setTimeout(() => {
    flush();
    applyEdit(side, targetLine, targetCol);
  }, 300);
}

function insertText(side, lineIdx, col, text) {
  const st = S.sides[side];
  recordUndo(side);
  const cur = st.lines[lineIdx] || '';
  st.lines[lineIdx] = cur.slice(0, col) + text + cur.slice(col);
  applyEdit(side, lineIdx + 1, col + text.length);
}

function splitLine(side, lineIdx, col) {
  const st = S.sides[side];
  recordUndo(side);
  const cur = st.lines[lineIdx] || '';
  st.lines.splice(lineIdx, 1, cur.slice(0, col), cur.slice(col));
  applyEdit(side, lineIdx + 2, 0);
}

function mergeUp(side, lineIdx) {
  if (lineIdx <= 0) return;
  const st = S.sides[side];
  recordUndo(side);
  const prev = st.lines[lineIdx - 1] || '';
  const cur = st.lines[lineIdx] || '';
  st.lines.splice(lineIdx - 1, 2, prev + cur);
  applyEdit(side, lineIdx, prev.length);
}

function mergeDown(side, lineIdx) {
  const st = S.sides[side];
  if (lineIdx >= st.lines.length - 1) return;
  recordUndo(side);
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

/** 撤销前光标在哪：撤销/重做之后要回到原处，而不是跳回第 1 行。
 *  光标不在这一侧（焦点在工具栏或另一栏）时给第 1 行，由 focusAt 夹一次。 */
function caretAt(side) {
  const p = caretPos();
  if (!p || p.side !== side) return { line: 1, col: 0 };
  return { line: p.line, col: p.col };
}

function undo(side, redo) {
  const st = S.sides[side];
  const from = redo ? st.redo : st.undo;
  const to = redo ? st.undo : st.redo;
  if (!from.length) return;
  /* 先记光标再换内容：长文档里撤一步就跳回顶部，等于让人重新找回位置 */
  const at = caretAt(side);
  to.push(st.lines.slice());
  st.lines = from.pop();
  st.dirty = true;
  applyEdit(side, at.line, at.col);
}

/* ---------------- 按字典序排序 ---------------- */

/**
 * 把有内容的一侧（或两侧）按字典序重排，空行沉到末尾，行数不变。
 *
 * 排序会改内容，所以只读态下点它先开编辑 —— 「内容变了但保存按钮是灰的」
 * 是个更难解释的状态。没有变化时不记快照、不重算，只回一句提示。
 */
function sortSides() {
  const targets = ['l', 'r'].filter((k) => S.sides[k].loaded);
  if (!targets.length) return false;

  const snap = {};
  for (const k of targets) {
    const st = S.sides[k];
    if (isSorted(st.lines, S.opt)) continue;
    snap[k] = st.lines.slice();
    snapshot(st);             // 排序是整侧替换，一次算一步
    st.lines = sortLines(st.lines, S.opt);
    st.dirty = true;
  }
  if (!Object.keys(snap).length) {
    toast(tt('已经是字典序了'));
    return false;
  }

  /* 快照在改模型之后、重算之前记；setEdit 会重算一次，所以放它前面也没差别 */
  S.lastSort = snap;
  if (!S.edit) setEdit(true);
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  updateDots();
  $('save').disabled = false;
  toast(tt('已按字典序排序，Ctrl+Z 可撤销'));
  return true;
}

/** Ctrl+Z：最近一次动的是排序就两侧一起还原 —— 只还原一侧会留下
 *  「一边排好一边没排」的中间态，比不撤销还难懂。 */
function undoSort() {
  const snap = S.lastSort;
  if (!snap) return false;
  S.lastSort = null;
  const keep = caretPos();          // 焦点在按钮上时是 null：那就不动焦点
  for (const k of Object.keys(snap)) {
    const st = S.sides[k];
    st.redo.push(st.lines.slice());
    st.lines = snap[k];
    st.dirty = true;
  }
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  $('save').disabled = false;
  if (keep) focusAt(keep.side, keep.line, keep.col);
  return true;
}

function onKey(e) {
  if (!S.edit) return;
  const host = e.target.closest && e.target.closest('.cmp-tx');
  if (!host) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();

  if (mod && k === 's') { e.preventDefault(); save(); return; }
  /* 撤销/重做不在这里做：这个监听挂在两块画布上，点过工具栏之后焦点在按钮上，
     事件根本到不了这里。统一交给 document 上的处理（见 init 末尾）。 */

  const side = sideOf(host);
  if (e.key === 'Tab') {
    e.preventDefault();
    const p = caretPos();
    if (p && p.fill) return;        // 占位行还没有这一行，缩进无从谈起
    flush();
    if (p) insertText(side, p.line - 1, p.col, '    ');
    return;
  }

  /* 选了一段内容时，按键的语义是「删掉它」，不是「合并行」。
     必须在行首/行尾的判断之前拦下来 —— 三击一行的锚点就在行首。 */
  const span = selectionSpan();
  if (span && (e.key === 'Backspace' || e.key === 'Delete')) {
    // 落在同一行里：交给浏览器默认删除，input 会经 onInput 写回模型，
    // 原生的输入法状态与撤销粒度也就保住了
    if (span.same) return;
    e.preventDefault();
    if (!span.side) return;           // 跨两侧：没有一条连续文本可删
    flush();                          // 先把防抖中的那一行并回模型，再按行号删
    deleteSpan(selectionSpan() || span);
    return;
  }

  const pos = caretPos();
  if (!pos) return;
  const lineIdx = pos.line - 1;

  /* 占位行：这一侧在这个对齐位置还没有行。结构性按键必须先把已经写下的字
     落进模型，否则 splitLine / mergeUp 拿到的是一个还不存在的行号。 */
  if (pos.fill) {
    const atEnd = pos.col >= host.innerText.replace(/\r|\n/g, '').length;
    const structural = e.key === 'Enter'
      || (e.key === 'Backspace' && pos.col === 0)
      || (e.key === 'Delete' && atEnd)
      || e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (!structural) return;        // 行内删字/打字交给浏览器
    e.preventDefault();
    const written = flush();
    S.ver++;
    recompute();
    render(true);
    if (!written) {                 // 空位没写过东西：按键没有可作用的那一行
      focusRowIdx(side, pos.i, 0);
      return;
    }
    if (e.key === 'ArrowUp') { moveVert(side, written.line, -1, pos.col); return; }
    if (e.key === 'ArrowDown') { moveVert(side, written.line, 1, pos.col); return; }
    if (e.key === 'Enter') { splitLine(side, written.line - 1, pos.col); return; }
    if (e.key === 'Backspace') { mergeUp(side, written.line - 1); return; }
    mergeDown(side, written.line - 1);
    return;
  }

  if (e.key === 'Enter') { e.preventDefault(); flush(); splitLine(side, lineIdx, pos.col); return; }
  if (e.key === 'Backspace' && pos.col === 0) { e.preventDefault(); flush(); mergeUp(side, lineIdx); return; }
  if (e.key === 'Delete' && pos.col === host.innerText.replace(/\r|\n/g, '').length) {
    e.preventDefault(); flush(); mergeDown(side, lineIdx); return;
  }
  if (e.key === 'ArrowUp') { e.preventDefault(); flush(); moveVert(side, pos.line, -1, pos.col); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); flush(); moveVert(side, pos.line, 1, pos.col); return; }
}

/* ---------------- 关窗守卫 ----------------
 * 以前改完不保存就直接关窗，改动静默消失：对比窗口是独立窗口，用户按
 * Alt+F4 时不会想到「这里还有东西没存」。拦截点是 onCloseRequested，
 * 不是「点 × 的时候」—— 后者只管一个入口。 */
let forceClosing = false;

function dirtySides() {
  return ['l', 'r'].filter((k) => S.sides[k].loaded && S.sides[k].dirty);
}

function showCloseConfirm() {
  const dirty = dirtySides();
  const files = dirty.filter((k) => S.sides[k].path).length;
  $('confirmText').textContent = files
    ? tt('{n} 个文件有未保存的改动，关闭后会丢失。', { n: files })
    : tt('粘贴进来的文本改动还没保存，关闭后会丢失。');
  /* 粘进来的文本没有磁盘目标，没有「保存」这条出路 —— 别给一个按了也没用的按钮 */
  $('confirmSave').hidden = !files;
  $('confirm').hidden = false;
  $('confirmCancel').focus();
}

async function closeForReal() {
  forceClosing = true;
  $('confirm').hidden = true;
  const w = (() => { try { return getCurrentWindow(); } catch { return null; } })();
  if (!w) return;
  try { await w.close(); } catch { forceClosing = false; }
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
      st.base = st.lines.slice();
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
    /* 关闭统一走 close()，由 onCloseRequested 判一次脏 —— 右上角 ×、Alt+F4、
       任务栏关闭都从同一个口过，不靠「点按钮时才检查」。 */
    $('wclose').onclick = () => w.close();
    if (typeof w.onCloseRequested === 'function') {
      w.onCloseRequested((e) => {
        if (forceClosing) return;                    // 已经确认过，放行
        if (S.pending) { flush(); S.ver++; recompute(); }
        if (!dirtySides().length) return;            // 没有未保存的东西，直接关
        e.preventDefault();
        showCloseConfirm();
      }).catch(() => {});
    }
  }

  $('confirmCancel').onclick = () => { $('confirm').hidden = true; };
  $('confirmDrop').onclick = () => { void closeForReal(); };
  $('confirmSave').onclick = async () => {
    await save();
    /* 还有没落盘的（保存失败、或者粘贴文本本来就没有目标文件）：留在原地，
       别把确认条也收掉 —— 那条是用户唯一的出口。 */
    if (dirtySides().length) return;
    await closeForReal();
  };

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

  /* 差异清单 */
  $('listBtn').onclick = () => toggleList();
  $('listX').onclick = () => toggleList(false);
  $('warnX').onclick = () => showWarn('');
  for (const b of document.querySelectorAll('.cmp-list-sort')) {
    b.dataset.k = b.textContent;      // 记住译文，排序箭头是拼在后面的
    b.onclick = () => {
      const s = b.dataset.sort;
      if (S.list.sort === s) S.list.dir = -S.list.dir;
      else { S.list.sort = s; S.list.dir = 1; }
      renderList();
    };
  }
  for (const b of $('listFilter').querySelectorAll('button')) {
    b.onclick = () => { S.list.filter = b.dataset.f; renderList(); };
  }
  $('listBody').addEventListener('click', (e) => {
    const it = e.target.closest('.cmp-li');
    if (it) gotoBlock(+it.dataset.i);
  });

  /* 编辑开关抽成函数：空状态「直接粘贴文本」也要进同一个状态机。
     两侧都空时点「编辑」，直接当成「我要粘两段文本」处理 —— 比弹一句
     「先选文件」有用得多 */
  $('toggleEdit').onclick = () => {
    if (!S.sides.l.loaded && !S.sides.r.loaded) { startPairText(); return; }
    setEdit(!S.edit);
    toast(S.edit ? tt('编辑已打开：直接改字，Ctrl+S 写回磁盘') : tt('编辑已关闭'));
  };
  $('pastePair').onclick = startPairText;
  $('sortBtn').onclick = () => sortSides();
  /* 工具栏上的后悔药：跟 Ctrl+Z / Ctrl+Y 走同一套逻辑，不是第二套实现 */
  $('undoBtn').onclick = () => doUndo(false);
  $('redoBtn').onclick = () => doUndo(true);

  for (const side of ['l', 'r']) {
    bindScroll(side);
    const cv = el(side, 'canvas');
    cv.addEventListener('input', onInput);
    cv.addEventListener('keydown', onKey);
    cv.addEventListener('blur', () => {
      if (!S.pending) return;
      /* 只把内容并回模型，**不重画**。
         这行代码以前是 flush() 之后紧跟 render(true)：blur 发生在浏览器「即将把
         焦点交给被点的那一行」之前，此刻同步重建 DOM 会把那一行从文档里摘掉，
         浏览器随后的聚焦就落空了 —— 表现是「点别处光标不动，接着打的字还进原来
         那一行」，而且只有先打过字（有 pending）才复现。
         视图与模型的对齐交给下一次 render：那一定发生在这次点击/拖选结束之后，
         既不会吃掉点击，也不会打断拖选。 */
      flush();
      S.ver++;
      recompute();
    }, true);
    /* 行号与行尾空白也要能把光标放进去。
       行号列不是可编辑单元，点它以前什么都不会发生；写上字之后的空白同理。
       规矩跟代码编辑器一致：点行号 = 行首，点行尾/下方空白 = 那一行的末尾。 */
    cv.addEventListener('mousedown', (e) => {
      if (!S.edit) return;
      if (e.target.closest && e.target.closest('.cmp-tx')) return;   // 行内交给浏览器
      const box = cv.getBoundingClientRect();
      const row = e.target.closest && e.target.closest('.cmp-row');
      const inner = row && row.querySelector('.cmp-tx');
      let i = inner ? +inner.dataset.i : NaN;
      if (!Number.isFinite(i)) {
        // 行下方的空白：按坐标算离得最近的那一行
        i = Math.max(0, Math.min(S.rows.length - 1, Math.floor((e.clientY - box.top) / ROW_H)));
      }
      const tx = cv.querySelector(`.cmp-tx[data-i="${i}"]`);
      if (!tx) return;
      e.preventDefault();
      const onNo = !!(e.target.closest && e.target.closest('.cmp-ln'));
      const lnText = tx.closest('.cmp-row').querySelector('.cmp-ln').textContent;
      /* 占位行没有本侧行号（行号列是空的）。以前这里 `+'' === 0`，focusAt
         把它夹成第 1 行 —— 点第 3 行、字却进了第 1 行。占位行按对齐索引聚焦。 */
      if (!lnText.trim()) { focusRowIdx(side, i, 0); return; }
      const line = +lnText;
      const col = onNo ? 0 : (S.sides[side].lines[line - 1] || '').length;
      focusAt(side, line, col);
    });
    // 只读态下不允许输入，避免 caret 跑进去
    cv.addEventListener('beforeinput', (e) => { if (!S.edit) e.preventDefault(); });
  }

  const ruler = $('ruler');
  const rulerTip = $('rulerTip');
  ruler.addEventListener('pointerdown', (e) => {
    const r = rulerRatio(e);
    if (r === null) return;          // 轨道下方的空白不响应
    rulerDrag = true;
    rulerTip.hidden = true;
    try { ruler.setPointerCapture(e.pointerId); } catch {}
    jumpToRatio(r);
  });
  ruler.addEventListener('pointermove', (e) => {
    if (rulerDrag) { jumpToRatio(rulerRatio(e)); return; }
    rulerHover(e);
  });
  const endDrag = (e) => {
    rulerDrag = false;
    try { ruler.releasePointerCapture(e.pointerId); } catch {}
  };
  ruler.addEventListener('pointerup', endDrag);
  ruler.addEventListener('pointercancel', endDrag);
  ruler.addEventListener('pointerleave', () => { rulerTip.hidden = true; });
  ruler.addEventListener('wheel', (e) => {
    const sc = el('l', 'scroll');
    sc.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    /* 撤销/重做放在 document 上，比「挂在两个画布上」宽一层：
       点过排序、编辑开关之后焦点就在按钮上，挂在画布上的监听收不到，
       用户看到的现象就是「Ctrl+Z 没反应」。*/
    const mod = e.ctrlKey || e.metaKey;
    const lk = (e.key || '').toLowerCase();
    if (mod && (lk === 'z' || lk === 'y') && S.edit) {
      e.preventDefault();
      flush();
      const side = undoTarget(e);
      if (!side) return;
      if (lk === 'y') { undo(side, true); return; }
      if (!e.shiftKey && undoSort()) return;   // 排序是整侧替换，先按整体撤
      undo(side, e.shiftKey);
      return;
    }
    if (e.defaultPrevented) return;
    const k = e.key;
    if (k === 'Escape' && S.list.open) { e.preventDefault(); toggleList(false); return; }
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
    queueFit();          // 工具栏要么展开回文字，要么再降一级
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
    if (p) { showWarn(''); await loadSide(side, p); }
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
  /* 字体没就绪时量出来的宽度偏窄，会把工具栏误判成「放得下」——
     等一次 fonts.ready 再量，之后只在 resize / 统计文字变化时重算 */
  queueFit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);

  listen('compare:load', (ev) => {
    const p = ev && ev.payload ? ev.payload : {};
    loadPair(p.left || null, p.right || null);
  });

  let req = null;
  try { req = await invoke('take_compare_request'); } catch { req = null; }
  if (req && (req.left || req.right)) await loadPair(req.left, req.right);
  else updateEmpty();
})();
