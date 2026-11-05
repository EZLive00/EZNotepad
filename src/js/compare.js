// ============================================================
// compare.js —— 独立对比窗口
//
// 一屏两栏 + 右侧预览条，像编辑器那样看差异：
//   · 差异只把**字**标红：增删行整行红，改行只红差异片段（<mark>，无底色）；
//     不铺行底、不画色块、不加删除线 —— 满屏底色反而看不出哪几个字变了
//   · 两侧同步滚动，任一栏滚动另一栏跟着走
//   · 预览条按「全局高度」画差异位置：一行一条 1px 细红线，点一下 / 拖着走就能跳过去
//   · 「编辑」打开后两栏直接改写，改完 Ctrl+S 落盘
//
// 大文件靠虚拟滚动：只渲染可视区 ±6 行。行高不是固定的 —— 自动换行时
// 一行可以折成好几行（高度写进行内 style），所以行位一律查前缀和
// （rowTop/rowH/rowAtY/totalHeight），⛔ 不要再用「行号 × 行高」算位置。
// ============================================================
import * as be from './backend.js';
import { buildSideBySide, diffStats, inlineDiff } from './diff.js';
import { blockItems, arrange, rangeText } from './difflist.js';
import { sortLines, isSorted } from './linesort.js';
import { toast, contextMenu } from './ui.js';
import { invoke } from '../vendor/api/core.js';
import { listen } from '../vendor/api/event.js';
import { getCurrentWindow } from '../vendor/api/window.js';
import { PhysicalPosition, PhysicalSize } from '../vendor/api/dpi.js';
import { tt, setLang, resolveLang, applyDom } from './i18n.js';
import { settings, saveSettings } from './state.js';

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
  opt: { ignoreWS: true, ignoreCase: false, collapse: true },
  /* 行显示模式：true = 自动换行（soft wrap），false = 不换行、横向滚动。
     默认值与主窗口共用 settings.wrap（见 applyWrap），对比窗口跟着同一个偏好。 */
  wrap: true,
  /* 行位几何（见 layout）：y 是每行顶边，hh 是每行高度，uL/uR 是每行左右
     两侧的显示宽度（半角单元数，全角算 2）。换行时行高 = 折行数 × ROW_H，
     所以这两个数组必须和 S.rows 同长。 */
  y: null,
  hh: null,
  uL: null,
  uR: null,
  rows: [],
  blocks: [],
  items: [],           // 差异清单的数据（recompute 时折好）
  /* 屏幕上真正摆出来的行（值是 S.rows 的下标）。
     不折叠时它就是 0..n-1；折叠时只留差异行和它前后各 CTX 行。
     所有「哪一行有多高」的地方都必须走 S.view，不能再拿 S.rows 的下标当
     行位 —— 折叠之后两者不是一回事。 */
  view: [],
  foldCtx: 3,
  /* 光标所在的那条对齐行（模型下标）。折叠时它一定要留着：
     把左边改成和右边一样，这一行就从「修改」变成「相同」，随即被折叠掉 ——
     光标当场消失，给人「键盘不管用了」的感觉。钉住它就不动。 */
  pin: -1,
  lineRow: { l: new Map(), r: new Map() },
  inline: new Map(),   // 行内字符级 diff 缓存，滚动时不重算
  cur: 0,
  edit: false,
  ver: 0,
  units: { l: 0, r: 0 },
  sig: { l: '', r: '' },
  /* 每一栏当前摆在 DOM 里的屏幕行范围，以及「是不是摆了全部行」。
     虚拟滚动只摆一屏；但拖动选区、Ctrl+A 需要屏幕外的行也存在，
     否则选区到屏幕边缘就断了（见 ensureAllRows）。 */
  range: { l: [0, -1], r: [0, -1] },
  full: { l: false, r: false },
  /* 正在拖选区/全选：行只往两端补、不重建（重建会把选区摘掉）。
     与 full 分开：拖一小段时行不必全量，补到够用就行。 */
  hold: { l: false, r: false },
  pending: null,       // 还没合并进模型的那一行（输入防抖）
  lastSort: null,      // 上一次「按字典排序」前的快照（两侧一起，Ctrl+Z 一次还原）
  lastSide: '',        // 最近一次改动落在哪一侧：光标不在行里时 Ctrl+Z 按它来
  /* 最后一次真实的光标位置。点工具栏的撤销/重做按钮时焦点已经交给按钮，
     那一刻的 window.getSelection() 可能已经空了 —— 只能靠这份备份，
     否则撤销会退回第 1 行，屏幕一跳到底（见 caretAt）。 */
  lastCaret: null,     // { side, line, col }
  list: { open: false, sort: 'pos', dir: 1, filter: 'all', sig: '' },
  /* 查找：hits 是全文扫描的结果，map 只用来给已渲染的行上色 ——
     虚拟滚动下不可能给全部命中挂 DOM，所以「行级高亮」是唯一可靠的画法。 */
  find: { on: false, q: '', hits: [], cur: -1, map: new Set() },
  warn: '',            // 上限提示文案，空串表示没有
};

/* 全选期间被摘掉 contenteditable 的那些行（见 selectAllSide）。
   浏览器只要还认着某个「正在编辑的宿主」，跨行选区就会被掐回那一行；把
   contenteditable 摘掉，文本照样可选，但 Blink 不再拿某一行当 editing host。
   用户下一次点回正文、或者关掉编辑态时恢复。 */
let strippedHosts = [];

/* 一次「跨行选区上等着的粘贴」：Ctrl+V 先把选区记在这里、恢复可写，然后放行
   按键，等浏览器派发 paste 时再从 clipboardData 取文本落到模型（见 crossSelKey
   与 paste 监听）。不这样绕就没有别的读法 —— 异步剪贴板 API 在 WebView2 里
   既不授权也不拒绝，Promise 永远挂着。 */
let pendingPaste = null;

function restoreEditables() {
  for (const h of strippedHosts) {
    if (h.isConnected) h.setAttribute('contenteditable', 'plaintext-only');
  }
  strippedHosts = [];
}

/** 把这一侧临时变成「不可写」。全选和拖选都靠它绕开编辑宿主的边界限制。 */
function stripSide(side) {
  for (const h of el(side, 'rows').querySelectorAll('.cmp-tx[contenteditable]')) {
    strippedHosts.push(h);
    h.removeAttribute('contenteditable');
  }
}

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

/**
 * 行显示模式：自动换行 / 不换行。
 *
 * 和主窗口共用 settings.wrap 这一份偏好（两个窗口读同一份 localStorage），
 * 在哪儿改都是改同一个开关 —— 「我明明在对比窗口关掉了折行，回编辑器又折回来」
 * 是两个开关才会有的问题。
 *
 * 换行会改变每行的高度（见 layout），所以几何缓存（预览条、行位）一起作废。
 */
function setWrap(on) {
  const v = on !== false;
  document.body.toggleAttribute('data-nowrap', !v);
  if ($('optWrap')) {
    $('optWrap').checked = v;
    /* 提示语跟着状态走：开着的时候说「会折行」，关掉时说「会横向滚」，
       不然用户只能靠试。 */
    const lab = $('optWrap').closest('label');
    if (lab) lab.title = tt(v ? '长行折到下一行显示' : '长行不折行，横向滚动查看');
  }
  if (v === S.wrap) return;
  S.wrap = v;
  settings.wrap = v;
  saveSettings();
  /* 行高整体变了，scrollTop 那个数字的含义也跟着变：留在原处的话，正在读
     第 300 行的人会被甩到第 90 行。记下「视口顶部是哪一行」，重排之后再滚回去 ——
     换成不换行时同理，否则一按就往回跳一大截。 */
  const sc = el('l', 'scroll');
  const keep = S.view.length ? rowAtY(sc.scrollTop) : 0;
  layoutKey = '';
  rulerCache = null;
  markCache = null;
  if (S.view.length) {
    render(true);
    sc.scrollTop = clamp(rowTop(keep), 0, Math.max(0, totalHeight() - sc.clientHeight));
    syncFrom('l', sc.scrollTop, sc.scrollLeft);
    renderRows('l', true);
    renderRows('r', true);
    drawRuler();
    syncGutter();
  }
}

function applyTheme() {
  let t = settings.theme || 'auto';  if (t === 'auto') {
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
    S.view = [];
    S.cur = 0;
    S.units = { l: 0, r: 0 };
    S.uL = new Uint32Array(0);
    S.uR = new Uint32Array(0);
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
  /* 每行的显示宽度要留着算折行数（见 layout）。算一次存下来：
     recompute 本来就要遍历全部行取最大值，顺手存进两个数组，
     后面每次重排只读数组，不再重算字符宽度。 */
  S.uL = new Uint32Array(S.rows.length);
  S.uR = new Uint32Array(S.rows.length);
  S.rows.forEach((row, i) => {
    if (row.l) { const u = unitsOf(row.l.text); S.uL[i] = u; if (u > ul) ul = u; }
    if (row.r) { const u = unitsOf(row.r.text); S.uR[i] = u; if (u > ur) ur = u; }
  });
  // 单侧打开时，另一侧按同一宽度排，滚动条不会左右跳
  if (!hasR) ur = ul;
  if (!hasL) ul = ur;
  S.units = { l: ul, r: ur };
  if (S.cur >= S.blocks.length) S.cur = 0;
  /* 差异清单在这里一次性折好：render 会被滚动和导航频繁调用，不能每次都
     把几万行重扫一遍。rev 变化时清单才重建 DOM。 */
  S.items = blockItems(S.rows, S.blocks);
  S.list.rev = (S.list.rev || 0) + 1;
  /* 内容变了，命中位置要跟着重算 —— 但不能在这里跳转或重画（recompute
     的调用方自己会 render），否则改一个字就把视口甩到别处 */
  rescanFindQuiet();
  buildView();
}

/** 折叠时要不要留这一行：差异行本身，以及它前后各 `S.foldCtx` 行。
 *  上下文是必须的 —— 只留差异行等于把「改了哪一句」从「改在什么上下文里」
 *  里剥出来，读的人反而要去猜。 */
function buildView() {
  const total = S.rows.length;
  /* 没有差异可比、或者用户关掉了开关：全部展开。
     编辑态也照样折叠 —— 「看一眼差异然后改」是主要用法，收起来才有用。
     想改相同行的人把开关关掉即可，那比拖着一屏相同行翻找要快。 */
  if (!S.opt.collapse || !S.blocks.length) {
    S.view = new Array(total);
    for (let i = 0; i < total; i++) S.view[i] = i;
    return;
  }
  const keep = new Uint8Array(total);
  const ctx = S.foldCtx;
  for (let i = 0; i < total; i++) {
    if (S.rows[i].kind === 'same') continue;
    const a = Math.max(0, i - ctx), b = Math.min(total - 1, i + ctx);
    for (let j = a; j <= b; j++) keep[j] = 1;
  }
  if (S.edit && S.pin >= 0 && S.pin < total) keep[S.pin] = 1;
  /* 查找跳到的那一行即使在「相同行」里也要露出来：否则按了「下一个」，
     屏幕只滚到一片接缝，命中行本身还藏着 */
  const c = S.find.hits[S.find.cur];
  if (S.find.on && c && c.mi >= 0 && c.mi < total) keep[c.mi] = 1;
  const out = [];
  for (let i = 0; i < total; i++) if (keep[i]) out.push(i);
  S.view = out;
  /* 视图换了（折叠/展开/查找露出），行位几何必然作废 —— 但不必在这里重算：
     多数调用方紧接着就 render。作废只需把 key 清掉，下次 layout 自然重算。 */
  layoutKey = '';
}

/** 模型行下标 → 屏幕行位；找不到（被折叠掉了）返回 -1。
 *  不折叠时是恒等映射，直接返回，省掉每次点击一次二分。 */
function vposOf(i) {
  const v = S.view;
  if (!v.length || i < 0) return -1;
  if (v.length === S.rows.length) return i;
  let lo = 0, hi = v.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] === i) return mid;
    if (v[mid] < i) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/* ---------------- 行位几何：换行之后每行不一样高 ----------------
 *
 * 不换行时每行就是 ROW_H，「第 v 行在第几像素」= v × ROW_H（原来的做法）。
 * 打开自动换行后，一行可能折成三行，高度不再相同 —— 所有换算都得走 S.y：
 * 它是**每行顶部**的 y 偏移，长度 = 视图行数 + 1（最后一项是总高）。
 *
 * 折几行是**算**出来的，不是量出来的：对比窗口是等宽字体，一个半角字符
 * 固定 CHAR_W 宽，一行能放多少字符 = 可用宽度 / CHAR_W；CSS 那边再配
 * `word-break: break-all` + `line-break: anywhere`，断点就严格按字符走，
 * 于是「算出来的行数」与浏览器排出来的高度一致。量的话每行要读一次布局，
 * 两万行就是两万次强制重排，滚动直接卡死。
 *
 * 单位不是字符数而是**半角单元**（全角算 2，见 unitsOf）：中文一折就错位，
 * 那是这个窗口最主要的用途。
 */
let LAYOUT_VER = 0;      // 几何版本：换行开关 / 列宽 / 行数一变就 +1，预览条缓存靠它作废

/** 一行能放几个半角单元。两栏宽度可能差一两像素，取小的那边 —— 行高按
 *  较窄的一侧算，较宽的一侧只会更空，不会把字挤出格子。
 *
 *  行号列宽读 CSS 变量而不是量 DOM：第一帧画布还是空的，量不到 `.cmp-ln`，
 *  退回默认值会让首屏行高算错一截（滚动一下才自愈）。 */
function wrapCols() {
  const lnW = parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-ln-w')) || 54;
  let cols = 0;
  for (const side of ['l', 'r']) {
    const cv = el(side, 'canvas');
    const sc = el(side, 'scroll');
    const avail = (cv.clientWidth || sc.clientWidth || 0) - lnW - 14;   // 14 = .cmp-tx 的 padding-right
    const c = Math.floor(avail / CHAR_W);
    if (c > 0 && (cols === 0 || c < cols)) cols = c;
  }
  return Math.max(8, cols || 80);
}

/** 重算 S.y / S.hh。调用点只有 render() 和需要「先知道行位再滚动」的地方。
 *  key 没变就直接返回：5 万行的前缀和不算贵，但每帧都算一遍就白费了。 */
let layoutKey = '';

function layout() {
  const n = S.view.length;
  const cols = S.wrap ? wrapCols() : 0;
  const key = `${n}:${S.ver}:${cols}:${ROW_H}`;
  if (key === layoutKey && S.y && S.y.length === n + 1) return;
  layoutKey = key;

  const y = new Float64Array(n + 1);
  const hh = new Float64Array(n);
  if (!S.wrap) {
    for (let i = 0; i < n; i++) { y[i] = i * ROW_H; hh[i] = ROW_H; }
    y[n] = n * ROW_H;
  } else {
    let acc = 0;
    for (let vi = 0; vi < n; vi++) {
      y[vi] = acc;
      const mi = S.view[vi];
      const row = S.rows[mi];
      /* 一条对齐行两栏都有内容时取高的那一侧：两栏共用同一个行位，
         矮的那侧多出来的空白比「错行」好受得多 */
      let lines = 1;
      if (row && row.l) lines = Math.max(lines, Math.ceil(S.uL[mi] / cols));
      if (row && row.r) lines = Math.max(lines, Math.ceil(S.uR[mi] / cols));
      hh[vi] = lines * ROW_H;
      acc += hh[vi];
    }
    y[n] = acc;
  }
  S.y = y;
  S.hh = hh;
  LAYOUT_VER++;
}

/** 内容总高（像素） */
function totalHeight() {
  const y = S.y;
  return y && y.length ? y[y.length - 1] : S.view.length * ROW_H;
}

/** 第 vi 条视图行的顶边 / 高度 */
const rowTop = (vi) => (S.y && vi < S.y.length ? S.y[vi] : vi * ROW_H);
const rowH = (vi) => (S.hh && vi < S.hh.length ? S.hh[vi] : ROW_H);

/** 内容坐标 y 落在第几条视图行（二分；返回 0..n-1） */
function rowAtY(y) {
  const n = S.view.length;
  if (!n) return 0;
  const Y = S.y;
  if (!Y || Y.length < n + 1) return clamp(Math.floor(y / ROW_H), 0, n - 1);
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Y[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
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
  /* 类型要单独一个类：只改字的话，红字范围得区分「整行都是新增/删除」
     和「这一行只有几个字不一样」，光一个 .diff 分不出来 */
  if (row.kind !== 'same') cls.push('k-' + row.kind);
  return cls.join(' ');
}

function rowHtml(row, i, side, vi) {
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
  /* 折叠掉的那些行在视觉上没有任何位置，只能在上方画一条缝告诉读者
     「行号在这里跳过了一段」—— 不然行号从 12 直接跳到 47，看着像丢内容 */
  const gap = vi > 0 && S.view[vi - 1] !== i - 1 ? ' gap' : '';
  /* 查找命中的行：整行淡蓝，当前这一条再压一条左侧竖线。
     不做字符级 mark —— 差异行的 inner 是 inlineDiff 生成的高亮 HTML，
     再往里插 <mark> 会把两边的高亮互相踩掉。 */
  let hit = '';
  if (S.find.on) {
    if (S.find.map.has(side + ':' + i)) hit += ' hit';
    const c = S.find.hits[S.find.cur];
    if (c && c.side === side && c.mi === i) hit += ' hit-cur';
  }
  return `<div class="${rowClass(row, i, side)}${gap}${hit}" style="top:${rowTop(vi)}px;height:${rowH(vi)}px">`
    + `<span class="cmp-ln">${cell ? cell.no : ''}</span>`
    + `<span class="cmp-tx" data-i="${i}" data-side="${side}" data-n="1"${fill}${editable}>${inner}</span>`
    + '</div>';
}

function renderRows(side, force = false) {
  const sc = el(side, 'scroll');
  const cv = el(side, 'canvas');
  const total = S.view.length;
  const vh = sc.clientHeight || 400;

  /* 换行之后一屏里行的条数不固定：上界按坐标反查，再各留 6 行余量。
     -6 / +6 是「滚动一点点不必重画」的缓冲，和原来一致。 */
  const first = Math.max(0, rowAtY(sc.scrollTop) - 6);
  const last = Math.min(total - 1, rowAtY(sc.scrollTop + vh) + 6);

  /* 拖动选区 / 全选期间（S.hold）：只往两端补，绝不重建。
     重建会把正在进行的那段选区连同选中节点一起摘掉；而屏幕外面还没有的行
     又必须补进来，否则滚过去是一片空白。下一次强制重画（打字、跳转）才收回。 */
  if (S.hold[side] && !force) {
    growRows(side, first, last);
    S.sig[side] = `${first}:${last}:${S.ver}:${S.cur}`;
    return;
  }
  if (S.hold[side]) { S.hold[side] = false; S.full[side] = false; }

  const sig = `${first}:${last}:${S.ver}:${S.cur}`;
  if (!force && S.sig[side] === sig) return;

  // 正在这一栏里打字时不要重建 DOM：重建会把光标弄丢。
  // 但滚动到光标行之外还是要重建，否则会看着一屏旧内容。
  const active = document.activeElement;
  if (S.edit && !force && active && cv.contains(active)) {
    const ai = vposOf(+active.dataset.i);
    if (ai >= first && ai <= last) return;
  }

  S.sig[side] = sig;
  const out = [];
  for (let vi = first; vi <= last; vi++) {
    const i = S.view[vi];
    out.push(rowHtml(S.rows[i], i, side, vi));
  }
  el(side, 'rows').innerHTML = out.join('');
  strippedHosts = strippedHosts.filter((h) => h.isConnected);
  S.range[side] = [first, last];
}

function rowRangeHtml(side, from, to) {
  const out = [];
  for (let vi = from; vi <= to; vi++) out.push(rowHtml(S.rows[S.view[vi]], S.view[vi], side, vi));
  return out.join('');
}

/** 把屏幕上需要的行补进 DOM，**已有的节点一个都不动**。
 *  重建（innerHTML）会把正在拖的那段选区摘掉；append 不会。 */
function growRows(side, first, last) {
  const rowsEl = el(side, 'rows');
  const total = S.view.length;
  const [h0, h1] = S.range[side] || [0, -1];
  if (h1 < 0) return;
  if (first < h0) rowsEl.insertAdjacentHTML('afterbegin', rowRangeHtml(side, Math.max(0, first), h0 - 1));
  if (last > h1) rowsEl.insertAdjacentHTML('beforeend', rowRangeHtml(side, h1 + 1, Math.min(total - 1, last)));
  S.range[side] = [Math.min(first, h0), Math.max(last, h1)];
}

/** 把一栏补成「全部行都在 DOM 里」。
 *
 *  虚拟滚动只摆一屏的行，于是选区到了屏幕边缘就没有下一行了 —— 鼠标拖到
 *  底边什么也不会发生（实测：选区停在第 26 行，滚动量 0）。Ctrl+A 更糟：
 *  浏览器只认得 DOM 里的那些行，选中的是「一屏」而不是「全文」。
 *
 *  只在两端追加，**已有节点原地不动** —— 否则正在进行的那次拖选会随着
 *  innerHTML 一起被拆掉，鼠标还按着，选区已经没了。 */
function ensureAllRows(side) {
  if (S.full[side]) return;
  const total = S.view.length;
  if (!total) return;
  S.hold[side] = true;
  growRows(side, 0, total - 1);
  const [a, b] = S.range[side] || [0, -1];
  S.full[side] = a <= 0 && b >= total - 1;
}

/** 选中这一侧的全文。
 *
 *  浏览器默认的「全选」在这里是错的：DOM 里同时摆着左右两栏、行号和悬浮层，
 *  全选会把两边文字连同界面元素一起框进去，复制出来左右交错。对比窗口的
 *  一趟复制只可能针对一侧，所以明确只选这一侧。 */
function selectAllSide(side) {
  if (!side || !S.view.length) return;
  /* 「只看差异」把相同行折起来了，那些行根本不在视图里 —— 此时「全选」只能
     选到露出来的那几十行，复制出去是一份悄悄缺行的文档。全选就是全文：
     先把折叠关掉（复选框跟着变，用户看得见），再选。 */
  if (S.opt.collapse && S.blocks.length) {
    S.opt.collapse = false;
    $('optFold').checked = false;
    buildView();
    S.ver++;
    render(true);
  }
  ensureAllRows(side);
  const hosts = el(side, 'rows').querySelectorAll('.cmp-tx');
  if (!hosts.length) return;
  const a = hosts[0];
  const b = hosts[hosts.length - 1];
  const r = document.createRange();
  r.setStart(a, 0);
  r.setEnd(b, b.childNodes.length);
  /* 每一行都是独立的 contenteditable。只要浏览器还认着某个「正在编辑的宿主」，
     跨行选区就会被掐回那一行（实测：设 201 行，读回来只剩焦点那一行的 17 个字）。
     全选期间先把 contenteditable 摘掉，Blink 不再拿某一行当 editing host；
     用户下一次点回正文时恢复（restoreEditables）。 */
  if (S.edit) stripSide(side);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  S.lastSide = side;
}

/* ---------------- 拖选：跨出行之后由我们自己接管 ----------------
 * 同一个编辑宿主限制在拖选上的表现是「选区到行尾就停」：按住从第 2 行拖到
 * 第 20 行，选区始终只有按下的那一行的几个字。指针一旦离开按下的那一行，
 * 就把这一侧摘成不可写（跟全选同一招），之后每次移动都按「按下的位置 →
 * 指针位置」重建选区 —— 跨宿主选区才会真的成立。
 */

let drag = null;          // { side, rowEl, node, off, x, y, took, raf }

/** 指针下的那个字符位置。落点不在这一侧的正文里时返回 null（行号、空白、
 *  另一栏都不算），这样拖到窗口边上选区不会突然跳到别处。 */
function caretNodeAt(x, y, side) {
  const r = document.caretRangeFromPoint(x, y);
  if (!r) return null;
  const e = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  const host = e && e.closest ? e.closest('.cmp-tx') : null;
  if (!host || sideOf(host) !== side) return null;
  return { node: r.startContainer, off: r.startOffset };
}

/** 从锚点到指针位置建选区。两个方向都要能选，而且**锚点必须留在按下那一端**：
 *  用 `setBaseAndExtent` 而不是手工 setStart/setEnd —— 后者只能让选区正向，
 *  向上取的那一段会把锚点悄悄换到点击处，接着 Shift+点击就扩不动了。 */
function setSelBetween(a, b) {
  const sel = window.getSelection();
  try {
    sel.setBaseAndExtent(a.node, a.off, b.node, b.off);
  } catch { /* 节点已脱离（拖动期间重建过）：这一帧不动它 */ }
}

/** 每次指针一动/滚动一格都要重拉选区：内容在脚下动了，落点就变了 */
function dragExtend() {
  if (!drag || !drag.took || !drag.node) return;
  const sc = el(drag.side, 'scroll');
  const r = sc.getBoundingClientRect();
  const y = clamp(drag.y, r.top + 1, r.bottom - 1);
  const p = caretNodeAt(drag.x, y, drag.side);
  if (p) setSelBetween({ node: drag.node, off: drag.off }, p);
}

/** 拖动期间的每一帧：把屏幕上的行补够，再按指针重拉一遍选区。
 *  补行不能等滚动事件 —— 指针停在滚动条上时它就不来了。 */
function dragTick() {
  if (!drag || !drag.took) return;
  const sc = el(drag.side, 'scroll');
  const r = sc.getBoundingClientRect();
  const E = 26;
  let dy = 0;
  if (drag.y > r.bottom - E) dy = Math.min(20, 3 + Math.round((drag.y - (r.bottom - E)) / 3));
  else if (drag.y < r.top + E) dy = -Math.min(20, 3 + Math.round(((r.top + E) - drag.y) / 3));
  /* 指针贴在边上时浏览器自己也会滚（选区拖动自带自动滚动）。它已经在滚就
     别再叠一份，速度会翻倍。 */
  if (dy && Math.abs(sc.scrollTop - (drag.top ?? sc.scrollTop)) < 1) sc.scrollTop += dy;
  drag.top = sc.scrollTop;
  const vh = sc.clientHeight || 400;
  const total = S.view.length;
  const first = Math.max(0, rowAtY(sc.scrollTop) - 8);
  const last = Math.min(total - 1, rowAtY(sc.scrollTop + vh) + 8);
  growRows(drag.side, first, last);
  dragExtend();
  drag.raf = requestAnimationFrame(dragTick);
}

/** `anchor`：Shift+点击时沿用「已有选区的那一端」，为空则是一次普通按下 */
function dragBegin(e, anchor) {
  const host = e.target.closest('.cmp-tx');
  drag = { side: sideOf(host), rowEl: e.target.closest('.cmp-row'),
           node: null, off: 0, x: e.clientX, y: e.clientY, took: false, raf: 0 };
  /* Shift+点击 = 「从已有锚点扩到这儿」。浏览器原生做不到：选区一跨出行，
     Blink 就把它掐回那一行（和拖选的老毛病同源），所以直接接管成一次
     到位的拖选 —— 和拖选共用 stripSide / dragExtend，行为完全一致。 */
  if (!e.shiftKey || !anchor || anchor.side !== drag.side) return;
  e.preventDefault();          // 别让浏览器把选区收成一个光标
  drag.node = anchor.node;
  drag.off = anchor.off;
  stripSide(drag.side);
  S.hold[drag.side] = true;
  drag.took = true;
  dragExtend();
}

function dragMove(e) {
  if (!drag) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.took) {
    /* 还在按下的那一行里：原生选区是好的（同一个宿主内不分叉），不动它 */
    const rb = drag.rowEl && drag.rowEl.isConnected ? drag.rowEl.getBoundingClientRect() : null;
    if (rb && e.clientY >= rb.top && e.clientY <= rb.bottom) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    /* 锚点就是按下的那一点：拖动之后浏览器把 focus 挪走了，anchor 仍留在原处 */
    drag.node = sel.anchorNode;
    drag.off = sel.anchorOffset;
    if (!drag.node) return;
    stripSide(drag.side);
    S.hold[drag.side] = true;      // 拖动期间这一栏只补行、不重建
    drag.took = true;
    drag.raf = requestAnimationFrame(dragTick);
  }
  dragExtend();
}

/** 松手。跨了行就保持「不可写」（写回模型的那条路自己算，见 crossSelKey），
 *  还在同一行里就恢复可写，让浏览器接着管打字。 */
function dragEnd() {
  if (!drag) return;
  const took = drag.took;
  if (drag.raf) cancelAnimationFrame(drag.raf);
  drag = null;
  if (!took) return;
  const span = selectionSpan();
  if (!span || span.same) {
    restoreEditables();
    S.hold.l = S.hold.r = false;
  }
}

/** 选区的某一端落在哪一行哪一列（跨行选区用；`end` 为 true 时取另一端） */
function spanPos(span, end) {
  if (!span || !span.side) return null;
  const i = end ? span.bI : span.aI;
  const row = S.rows[i];
  const cell = row && (span.side === 'l' ? row.l : row.r);
  if (!cell) return null;
  return { side: span.side, line: cell.no, col: end ? span.bCol : span.aCol };
}

/** 当前选区「按下的那一端」—— Shift+点击要接着它往下扩。
 *  必须在恢复 contenteditable **之前**取：一旦这一侧重新可写，Blink 会把跨行
 *  选区掐回一行，锚点跟着消失。
 *
 *  光标（选区已收起）同样算数：普通点击之后 Shift+点击是「从刚才那一点扩到
 *  这儿」，这正是最常见的用法，collapsed 时不返回会让它根本扩不起来。 */
function currentAnchor() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const n = sel.anchorNode;
  if (!n) return null;
  const e2 = n.nodeType === 1 ? n : n.parentElement;
  const host = e2 && e2.closest ? e2.closest('.cmp-tx') : null;
  if (!host) return null;
  return { node: n, off: sel.anchorOffset, side: sideOf(host) };
}

/** 选中的是一整段、而这一侧此刻不可写时，按键得自己落到模型上。
 *
 *  为什么不能交给浏览器：contenteditable 被摘掉之后，页面里没有编辑上下文，
 *  浏览器既不触发 beforeinput 也不会替我们删掉选中的内容 —— 全选之后打字
 *  没反应，就是这么来的。返回 true 表示这个按键已经处理完。 */
function crossSelKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const lk = (e.key || '').toLowerCase();
  /* 剪贴板两头也得自己接：没有编辑宿主，浏览器的粘贴/剪切无从下手。
     复制不用管 —— 选区是真的，Ctrl+C 照常进剪贴板。 */
  if (mod && lk === 'x') {
    const span = selectionSpan();
    if (!span || !span.side || span.same) return false;
    e.preventDefault();
    flush();
    /* 复制这一步交给浏览器：选区是真的，`execCommand('copy')` 不需要编辑宿主。
       `navigator.clipboard.writeText` 在 WebView2 里会 NotAllowedError（实测） */
    try { document.execCommand('copy'); } catch {}
    replaceSpan(span, '');
    return true;
  }
  if (mod && lk === 'v') {
    const span = selectionSpan();
    if (!span || !span.side || span.same) return false;
    /* 跨行选区的粘贴只能靠 paste 事件 —— 那是唯一不依赖权限的读法。
       但没有编辑宿主时浏览器根本不派发 paste（实测整条链只剩一个 keydown），
       所以先把这一侧恢复可写、把光标摆到选区起点，再**放行**这次按键；
       真正的替换在 paste 监听里做（见 pendingPaste）。

       不要试 `navigator.clipboard.readText()`：在 WebView2 里它既不 resolve 也不
       reject，实测 1.2 秒后仍在等 —— 用户看到的是一点反应都没有。 */
    flush();
    pendingPaste = span;
    restoreEditables();
    const at = spanPos(span, false);
    if (at) focusAt(at.side, at.line, at.col, { keepScroll: true });
    return false;          // 拦了就没有 paste 事件了
  }
  /* Ctrl+Z / Alt+← 这些不涉及「往选区里打字」，照旧走原来的路 */
  if (mod || e.altKey) return false;
  const k = e.key || '';
  const kill = k === 'Backspace' || k === 'Delete';
  /* 输入法开始组字时拿到的是 key='Process'：把选中的内容先删掉、再恢复可写，
     让组字在空出来的位置上继续（组出来的是什么字，只有输入法知道）。 */
  const ime = k === 'Process';
  const typing = k.length === 1 || k === 'Enter';
  if (ime) {
    const span = selectionSpan();
    if (!span || !span.side || span.same) return false;
    flush();
    replaceSpan(span, '');
    return false;
  }
  if (!kill && !typing) {
    /* 其余按键（方向键、Esc、Home/End…）：先把选区收成光标，再把可写恢复回来。
       不收的话，恢复可写那一刻 Blink 会把跨行选区掐成第一行里的一小段。 */
    const span = selectionSpan();
    flush();
    restoreEditables();
    if (!span) return false;
    const at = spanPos(span, k === 'ArrowDown' || k === 'ArrowRight');
    if (!at) return false;
    e.preventDefault();
    if (k === 'ArrowUp' || k === 'ArrowDown') { moveVert(at.side, at.line, k === 'ArrowUp' ? -1 : 1, at.col); return true; }
    focusAt(at.side, at.line, at.col);
    return true;
  }
  flush();
  const cur = selectionSpan();
  if (!cur || !cur.side) { e.preventDefault(); return true; }   // 跨了两栏：没有一条文本可删
  /* 同一行里：恢复可写，这一下删除/敲字让浏览器自己做（原生撤销粒度也保住了） */
  if (cur.same) { restoreEditables(); return false; }
  /* 跨行：直接改模型。敲的字也一起落进去 —— 没有编辑宿主，浏览器不会替我们
     插入那一个字符，等它等于什么都不会发生。 */
  e.preventDefault();
  replaceSpan(cur, kill ? '' : (k === 'Enter' ? '\n' : k));
  return true;
}

function render(force = false) {
  /* 先定宽度，再算行位（换行时行高取决于一行能放多少字符），最后才铺高。
     顺序反过来的话，第一帧会按上一轮的列宽排版，滚动时看起来在抖。 */
  for (const side of ['l', 'r']) {
    const cv = el(side, 'canvas');
    const sc = el(side, 'scroll');
    const viewW = sc.clientWidth || 0;
    if (S.wrap) {
      /* 换行：内容永远不超过一栏宽，不需要横向滚动，宽度交给 CSS 的
         `.cmp-cv { min-width: 100% }` —— 自己按 clientWidth 写一个值反而更糟：
         纵向滚动条一出现 clientWidth 少 11px，写死的宽度就成了横向滚动条。 */
      cv.style.width = '';
    } else {
      /* 宽度 **至少** 铺满可视区。只按内容算的话，贴上两段短文本时 canvas
         只有内容那么宽，行右侧那一大片「看起来还是正文」的空白其实不属于任何行；
         点上去落在 .cmp-sc 上，光标不动 —— 用户看到的就是「点了没反应」。
         内容更宽时仍然按内容算，横向滚动照旧。 */
      cv.style.width = Math.max(Math.round(S.units[side] * CHAR_W + 54 + 40), viewW) + 'px';
    }
  }
  layout();
  const h = totalHeight();
  for (const side of ['l', 'r']) {
    el(side, 'canvas').style.height = Math.max(h, 1) + 'px';
    renderRows(side, force);
  }
  /* 预览条本身只占内容那么高：短文档时它就是一小截，不会拉满整列 */
  const viewH = el('l', 'scroll').clientHeight || 0;
  $('ruler').style.height = Math.max(1, Math.min(viewH || h, h || 1)) + 'px';
  rulerCache = null;               // 高度/行数都可能刚变过，几何缓存作废
  updateStats();
  updateMeta();
  syncGutter();
  drawRuler();
  renderList();
}

function updateStats() {
  /* 两侧都还是空的：说清楚下一步做什么，别报「完全一致」——
     那是「比过了，一样」，而这里根本还没有内容可比 */
  if (isBlankSide('l') && isBlankSide('r')) {
    $('stat').textContent = tt('把两段文本分别粘到左右两侧，或者点上面的文件名打开文件');
    $('curInfo').textContent = '';
    $('prev').disabled = true;
    $('next').disabled = true;
    $('report').disabled = true;
    $('listBtn').disabled = true;
    if (S.list.open) toggleList(false);
    return;
  }
  const st = diffStats(S.rows);
  const same = st.add + st.del + st.chg === 0;
  /* 「按当前口径一致」不等于「逐字一致」：勾了忽略空白/大小写之后，
     两份文件可能真的每行都有差别。这时还写「完全一致」就是在报告一个
     比事实更强的结论，用户会拿它当依据。 */
  let hidden = 0;
  if (same && (S.opt.ignoreWS || S.opt.ignoreCase)) {
    const raw = diffStats(buildSideBySide(S.sides.l.lines, S.sides.r.lines, {}).rows);
    hidden = raw.add + raw.del + raw.chg;
  }
  $('stat').textContent = same
    ? (hidden ? tt('忽略空白/大小写后一致，逐字并不相同') : tt('两侧内容完全一致'))
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
/** 这一侧是不是「空白文本」：没有对应文件，也没写过内容 */
const isBlankSide = (k) => {
  const st = S.sides[k];
  return !st.path && st.lines.length === 1 && st.lines[0] === '';
};

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
  undoEither(side, redo);
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
      /* 空白的一侧不报「1 行 · 未保存」：一个字都没写，「未保存」既不是事实
         也没有下一步可做，只是噪声 */
      if (isBlankSide(side)) {
        metaEl.textContent = '';
        continue;
      }
      const n = st.lines.length;
      metaEl.textContent = tt('{n} 行', { n }) + (st.path ? ' · ' + st.enc + (st.eol === '\r\n' ? ' · CRLF' : '') : '');
      /* 文本侧（无文件）永远存不进磁盘，标脏时也只是提醒「还没落盘过」 */
      if (st.dirty) metaEl.textContent += ' · ' + tt('未保存');
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
  syncTitle();
}

/* 任务栏上只写「文本对比」，同时开两个就分不清谁是谁了。
   标题带上两侧的文件名，是最省事也最有用的一处提示。 */
let titleWin = null;
let lastTitle = '';
function syncTitle() {
  if (!titleWin) {
    try { titleWin = getCurrentWindow(); } catch { return; }
  }
  const one = (k) => {
    const st = S.sides[k];
    if (!st.loaded) return '';
    return st.path ? st.name : tt(k === 'l' ? '左侧文本' : '右侧文本');
  };
  const l = one('l'), r = one('r');
  const pair = l && r ? `${l} ⇄ ${r}` : (l || r);
  const title = pair ? `${pair} · ${tt('文本对比')}` : tt('文本对比');
  if (title === lastTitle) return;
  lastTitle = title;
  titleWin.setTitle(title).catch(() => {});
}

function updateDots() {
  $('dotL').classList.toggle('on', S.sides.l.dirty);
  $('dotR').classList.toggle('on', S.sides.r.dirty);
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
  /* 提示条会挤占正文（它在 flex 列里占一行），预览条高度要跟着重算 */
  if (was !== !!S.warn) requestAnimationFrame(() => render(true));
}

/* ---------------- 预览条 ----------------
 * 只有两种颜色：
 *   红   = 这一行有差异（唯一的「内容」信号）
 *   灰框 = 你正看着的这一屏
 * 「当前是第几处」不在这条上另开一个颜色：导航结果就在正文里，
 * 再给一处蓝，读者要花力气分辨「蓝点和蓝框是不是一回事」。
 */
let RED = '#d92b2b';
let SOFT = '#8a8a8a';          // --fg-soft：视口框的中性色

function cacheColors() {
  const cs = getComputedStyle(document.body);
  RED = (cs.getPropertyValue('--cmp-red') || '#d92b2b').trim();
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
  const total = S.view.length;
  /* 内容总高：换行时不是 total × 行高，得问几何（见 contentH） */
  const ch = totalHeight();
  const viewH = sc.clientHeight || box.clientHeight || 1;
  const top = Math.max(0, Math.round(sb.top - rb.top));
  const h = Math.max(1, Math.round(Math.min(viewH, ch || 1)));
  rulerCache = { box, cv: $('rulerC'), rb, top, h, contentH: ch, viewH, total };
  return rulerCache;
}

/* 预览条上的差异标记。每一行一条：轨道是 1:1 时逐行 1px；文档长到一行
   分不到 2.5px 时，行与行之间已经挤不下缝，只能按段并成一条（仍然是细的）。
   结果按「版本 / 几何 / 总行数 / 轨道高」缓存 —— 滚动时几何不变，
   每帧重算几万条会让滚动发黏。
   `per` 只是**平均**每行像素，用来判断「还画不画得开」；具体位置一律按
   S.y 换算 —— 换行之后一行能有 3 行高，按平均画会整体错位。 */
let markCache = null;

function diffMarks(total, per, h, ch) {
  const key = `${S.ver}:${LAYOUT_VER}:${total}:${h}`;
  if (markCache && markCache.key === key) return markCache.marks;

  /* 整份文件都不一样时逐行画既没意义也画不动：>4000 条就退回按块 */
  let lines = 0;
  for (const it of S.items) {
    const a = vposOf(it.start), b = vposOf(it.end);
    if (a >= 0 && b >= 0) lines += b - a + 1;
    if (lines > 4000) break;
  }
  const perLine = per >= 2.5 && lines <= 4000;

  const Y = S.y;
  const span = ch || 1;
  const yAt = (v) => (Y && v < Y.length ? (Y[v] / span) * h : v * per);

  const marks = [];
  for (const it of S.items) {
    const vs = vposOf(it.start);
    const ve = vposOf(it.end);
    if (vs < 0 || ve < 0) continue;
    if (perLine) {
      for (let v = vs; v <= ve; v++) {
        /* 逐行 1px —— 不是「这一行有多高」。折行之后一行能有 80px，
           按高度画就成了粗柱子，又把「这是几行」糊掉了。 */
        marks.push({ y: Math.round(yAt(v)), h: 1 });
      }
    } else {
      marks.push({ y: yAt(vs), h: Math.max(1, yAt(ve + 1) - yAt(vs)) });
    }
  }
  markCache = { key, marks };
  return marks;
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

  /* 轨道。宽度是这条预览条好用与否的第一件事：原先 22px 的栏里塞一条
     10px 的槽，还要在上面同时画差异段、当前段和视口框 —— 三样东西抢
     十来个像素，点起来也像是瞄准游戏。现在栏 34px、槽 22px，三段各有
     自己的位置。 */
  const tw = Math.max(10, Math.min(22, w - 12));
  const tx = Math.round((w - tw) / 2);
  g.fillStyle = 'rgba(127,127,127,.12)';
  roundRect(g, tx, top, tw, h, 4);
  g.fill();

  const per = h / total;
  const sc = el('l', 'scroll');

  /* 差异：一行一条细线。
     原先按「差异块」画粗红段 —— 一段 20 行就是一根 20px 高的柱子，看着像
     滚动条的影子，也分不清是哪几行。改成逐行 1px 之后，「有多少行不一样、
     密不密」能直接数出来，色块感没了。 */
  /* 细线：只占轨道中间 10px，1px 高。铺满 22px 时，连续几行差异会粘成
     一根短红柱，看着像滚动条的影子 —— 越密越糊，反而看不出是「几行」。
     收窄之后，同一处差异依旧连成一条线，但每行的边界还在。 */
  const mw = 10;
  const mx = Math.round(tx + (tw - mw) / 2);
  for (const mk of diffMarks(total, per, h, contentH)) {
    g.fillStyle = RED;
    g.fillRect(mx, top + mk.y, mw, mk.h);
  }

  /* 视口框：内容装得下一屏时不画 —— 那时整条轨道就是视口，
     画一个比容器还高的框既不准确也没有信息量（原先短文档就是这样）。
     装下九成以上也不画：框几乎顶满整条槽，剩下的只是把轨道整条染灰。
     用中性灰：它回答「我在文件的哪一段」，跟「哪里不一样」不是一件事。 */
  if (contentH <= viewH * 1.12) return;
  const y = top + (sc.scrollTop / contentH) * h;
  const vh = clamp((viewH / contentH) * h, 14, h);
  g.fillStyle = SOFT;
  g.globalAlpha = .12;
  roundRect(g, tx - 2, y, tw + 4, vh, 4);
  g.fill();
  g.globalAlpha = .5;
  g.strokeStyle = SOFT;
  g.lineWidth = 1;
  roundRect(g, tx - 1.5, Math.round(y) + .5, tw + 3, Math.max(12, vh - 1), 4);
  g.stroke();
  g.globalAlpha = 1;
  /* 视口上沿一条实线：滚动时它比半透明框本身更容易被眼睛抓住 */
  g.fillStyle = SOFT;
  g.globalAlpha = .75;
  g.fillRect(tx - 2, Math.round(y), tw + 4, 1);
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
  const total = S.view.length;
  if (!total || ratio === null) return;
  const sc = el('l', 'scroll');
  const h = totalHeight();
  const y = ratio * h;
  sc.scrollTop = clamp(y - sc.clientHeight / 2, 0, Math.max(0, h - sc.clientHeight));
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
  /* 按 y 反查行，不能按「第几格」均分：换行之后每行高度不同，
     均分出来的行号会越往下偏得越多 */
  const rowIdx = rowAtY((y / gg.h) * gg.contentH);
  const r = S.rows[S.view[rowIdx]];
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

/** 手动滚动时「当前是第几处」要跟着走。
 *  不然滚到第 5 处，状态栏还写着「第 1 / 22 处」，按 F8 又跳回第 2 处 ——
 *  用户看到的就是「导航不认我滚到哪」。只改 curInfo 和那个框，不走
 *  updateStats：后者要重扫全篇统计行数，每帧跑一次 5 万行就卡了。 */
function followScroll() {
  const n = S.blocks.length;
  if (!n || !S.view.length) return;
  const sc = el('l', 'scroll');
  const center = rowAtY(sc.scrollTop + sc.clientHeight / 2);
  const vi = clamp(center, 0, S.view.length - 1);
  const mi = S.view[vi];
  let lo = 0, hi = n - 1, best = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (S.blocks[m] <= mi) { best = m; lo = m + 1; } else hi = m - 1;
  }
  if (best === S.cur) return;
  S.cur = best;
  $('curInfo').textContent = tt('第 {i} / {n} 处', { i: S.cur + 1, n });
  renderList();
}

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
    followScroll();          // 先定「当前是第几处」，预览条上的蓝段才不会落后一帧
    drawRuler();
    syncGutter();            // 箭头跟着当前这一处走，滚动时也要跟
  }, { passive: true });
}

/* ---------------- 导航 ---------------- */
function gotoBlock(i) {
  if (!S.blocks.length) { toast(tt('两侧没有差异')); return; }
  S.cur = ((i % S.blocks.length) + S.blocks.length) % S.blocks.length;
  /* 块的位置是模型下标，滚动要按屏幕行位算（折叠时两者差着被折掉的行数） */
  const vi = Math.max(0, vposOf(S.blocks[S.cur]));
  const sc = el('l', 'scroll');
  sc.scrollTop = clamp(rowTop(vi) - sc.clientHeight / 2 + rowH(vi), 0,
    Math.max(0, totalHeight() - sc.clientHeight));
  syncFrom('l', sc.scrollTop, sc.scrollLeft);
  S.ver++;
  render(true);
}

/* ---------------- 查找 ----------------
 * 对比工具里「在这两份文件里找 me 这个词」是最常用的动作之一，而它和普通
 * 编辑器的查找有一处不同：命中的是**两栏**，同一条对齐行可能两边都有。
 * 所以 hits 按对齐行去重 —— 否则「下一个」会在左右两栏之间原地打转。
 */
function scanHits() {
  const q = S.find.q;
  S.find.hits = [];
  S.find.map.clear();
  if (!q) return;
  const needle = S.opt.ignoreCase ? q.toLowerCase() : q;
  const seen = new Set();
  for (const side of ['l', 'r']) {
    const st = S.sides[side];
    if (!st.loaded) continue;
    for (let i = 0; i < st.lines.length; i++) {
      const raw = st.lines[i];
      const hay = S.opt.ignoreCase ? raw.toLowerCase() : raw;
      let at = hay.indexOf(needle);
      while (at >= 0) {
        const mi = S.lineRow[side].get(i + 1);
        if (mi != null) {
          S.find.map.add(side + ':' + mi);
          if (!seen.has(mi)) { seen.add(mi); S.find.hits.push({ side, mi }); }
        }
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
    }
  }
}

function syncFindN() {
  const n = S.find.hits.length;
  const box = $('findN');
  if (!S.find.q) { box.textContent = ''; box.classList.remove('none'); return; }
  box.textContent = n ? `${S.find.cur + 1} / ${n}` : tt('没有匹配');
  box.classList.toggle('none', !n);
}

/** 只填数据，不重画：recompute 在内容变化后要静默地更新命中，不能再触发一轮渲染 */
function rescanFindQuiet() {
  if (!S.find.on || !S.find.q) return;
  scanHits();
  if (S.find.cur >= S.find.hits.length) S.find.cur = S.find.hits.length - 1;
}

function findJump() {
  const h = S.find.hits[S.find.cur];
  if (!h) { syncFindN(); return; }
  /* 命中行可能刚被折叠掉（相同行），buildView 会把「当前命中」留出来 */
  buildView();
  S.ver++;
  layout();          // 视图刚换过，行位要立刻跟上才能算滚动量
  const vi = vposOf(h.mi);
  if (vi >= 0) {
    const sc = el('l', 'scroll');
    const y = rowTop(vi);
    if (y < sc.scrollTop || y + rowH(vi) > sc.scrollTop + sc.clientHeight) {
      sc.scrollTop = clamp(y - sc.clientHeight / 2, 0, Math.max(0, totalHeight() - sc.clientHeight));
      syncFrom('l', sc.scrollTop, sc.scrollLeft);
    }
  }
  render(true);
  syncFindN();
}

function findGo(dir) {
  const n = S.find.hits.length;
  if (!n) return;
  if (S.find.cur < 0) S.find.cur = 0;
  else S.find.cur = ((S.find.cur + dir) % n + n) % n;
  findJump();
}

function applyFind() {
  S.find.q = $('findInput').value;
  scanHits();
  S.find.cur = S.find.hits.length ? 0 : -1;
  S.ver++;
  findJump();
}

function openFind() {
  $('findBar').hidden = false;
  S.find.on = true;
  const inp = $('findInput');
  inp.focus();
  inp.select();
  S.ver++;
  render(true);
}

function closeFind() {
  const was = S.find.on;
  $('findBar').hidden = true;
  S.find.on = false;
  S.find.q = '';
  S.find.hits = [];
  S.find.map.clear();
  S.find.cur = -1;
  $('findInput').value = '';
  syncFindN();
  if (!was) return;
  S.ver++;
  buildView();
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

  /* 读不进来时这一侧留成**空白的可写区**，不留上一轮的内容、也不留一块
     点不动的死区：原因已经在提示条里说了，能继续写才有下一步可做 */
  const failed = (msg) => {
    showWarn(msg);
    toast(msg);
    if (opts.reset) blankSide(side);
    if (!opts.defer) {
      S.pending = null;
      S.ver++;
      recompute();
      render(true);
      updateMeta();
    }
    return false;
  };

  /* 先问大小再读：几百 MB 的文件读进内存再放弃，代价比一次 metadata 大得多 */
  let size = 0;
  try { size = await be.fileSize(path); } catch { size = 0; }
  if (size > MAX_BYTES) {
    return failed(tt('{name} 太大：{size}，上限 {limit}。请拆分后再比较。', {
      name, size: fmtSize(size), limit: fmtSize(MAX_BYTES),
    }));
  }

  try {
    const r = await be.readText(path);
    const lines = String(r.content).replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MAX_LINES) {
      return failed(tt('{name} 行数太多：{n} 行，上限 {max} 行。请拆分后再比较。', {
        name, n: lines.length, max: MAX_LINES,
      }));
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
    return failed(tt('读取失败：') + e);
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
    /* 只给了一个文件时，另一侧补成空白文本：两侧永远都是可写的编辑区，
       想拿另一份文件比就点槽位、想贴一段就 Ctrl+V。留一半「未选择」的话，
       用户还得先找到入口才能开始 —— 那正是要消掉的二次选择。
       读失败时也一样：把那一侧留成空白的可写区，比留一句错误、一块
       点不动的死区更有用（原因已经在提示条里说过了）。 */
    for (const side of ['l', 'r']) if (!S.sides[side].loaded) blankSide(side);
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
}

/** 把一侧设成「空白文本」：loaded 但不属于任何文件，也永远存不进磁盘 */
function blankSide(side) {
  const st = S.sides[side];
  st.path = '';
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
}

/**
 * 没有文件也能比：把一侧开成空白文本，进编辑模式并把光标落进去，
 * 用户随后 Ctrl+V 粘进来就行（多行粘贴由 onInput 按行拆开并进模型）。
 * 这一侧已经有文件时只切编辑，不冲掉内容。
 */
function startText(side) {
  if (S.sides[side].path) { setEdit(true); focusAt(side, 1, 0); return; }
  blankSide(side);
  S.pending = null;
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  setEdit(true);
  focusAt(side, 1, 0);
}

/** 打开窗口的默认状态：两侧都是空白编辑区，光标落在左侧，直接粘就行 */
function startPairText() {
  blankSide('l');
  blankSide('r');
  S.pending = null;
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  setEdit(true);
  focusAt('l', 1, 0);
}

/** 开/关编辑态。按钮与「直接粘贴文本」两条入口共用，避免两套状态切换 */
function setEdit(on) {
  restoreEditables();
  if (S.pending) { flush(); S.ver++; recompute(); }
  S.edit = !!on;
  $('toggleEdit').classList.toggle('on', S.edit);
  /* 只读态撤销/重做按钮跟着灰掉：键盘在只读态也不吃 Ctrl+Z，
     按钮亮着却点不动，比直接灰着更让人困惑 */
  syncHist();
  $('paneL').classList.toggle('editing', S.edit);
  $('paneR').classList.toggle('editing', S.edit);
  S.ver++;
  /* 进出编辑态都要重算可见行：只读态下光标钉住的那一行不该继续占位 */
  buildView();
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
  replaceSpan(span, '');
}

/** 把跨行选区换成一段文字（`text` 为空 = 删掉）。
 *
 *  这是「全选/拖选之后往里打字、粘贴、删除」唯一的落点。浏览器在这里帮不上
 *  忙：选区跨了好几个 contenteditable 宿主，它连删都删不了，更不会替换。 */
function replaceSpan(span, text) {
  const st = S.sides[span.side];
  const rowA = S.rows[span.aI];
  const rowB = S.rows[span.bI];
  if (!st || !rowA || !rowB) return;
  const cellA = span.side === 'l' ? rowA.l : rowA.r;
  const cellB = span.side === 'l' ? rowB.l : rowB.r;
  if (!cellA || !cellB) return;
  const from = cellA.no - 1;
  const to = cellB.no - 1;
  if (from > to) return;
  recordUndo(span.side);
  const head = st.lines[from] || '';
  const tail = st.lines[to] || '';
  const joined = head.slice(0, span.aCol) + text + tail.slice(span.bCol);
  const parts = joined.split('\n');
  st.lines.splice(from, to - from + 1, ...parts);
  st.dirty = true;
  /* 光标落在插入内容的末尾：单行就是 aCol + 文本长度，多行就到最后一行 */
  const line = from + parts.length;
  const col = parts.length === 1 ? span.aCol + text.length : parts[parts.length - 1].length;
  applyEdit(span.side, line, col);
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

/** 离 `i` 最近的一条可见行：优先往前找（行被折叠掉时，上方那条还在屏幕上） */
function nearestVisible(i) {
  const v = S.view;
  if (!v.length) return -1;
  let lo = 0, hi = v.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= i) { best = v[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? best : v[0];
}

function focusAt(side, line, col, opts) {
  /* 行号列号一律夹到当前内容里：撤销之后文档可能变短，调用方给的
     「原来那一行」就不存在了。不夹的话 lineRow.get() 返回 undefined，
     这个函数会直接 return —— 重画后 DOM 已换新，焦点就掉到 body 上，
     界面上表现为「撤完以后键盘没反应了」。 */
  const lines = S.sides[side].lines;
  line = Math.min(Math.max(1, line | 0), Math.max(1, lines.length));
  col = Math.min(Math.max(0, col | 0), (lines[line - 1] || '').length);
  let i = S.lineRow[side].get(line);
  if (i == null) return;
  /* 折叠时这一行可能刚好不在屏幕上（撤销把内容还原成和对面一样，它就从
     「修改」变成了「相同」，随即被收起）。退到最近的一条可见行 —— 宁可
     光标差一行，也不能让它掉到 body 上：那样键盘就彻底没反应了。 */
  if (vposOf(i) < 0) i = nearestVisible(i);
  focusRowIdx(side, i, col, opts);
}

/** 按「对齐行索引」聚焦。占位行没有本侧行号，只有索引 —— 点它时只能走这条
 *
 *  `opts.keepScroll`：光标放回去但**不主动滚动**。撤销/重做用它 ——
 *  用户可能正看着文档别处，撤一下就把视线拽走（更别说跳回顶部）是打断。 */
function focusRowIdx(side, i, col, opts) {
  if (i == null || i < 0 || i >= S.rows.length) return;
  let vi = vposOf(i);
  if (vi < 0) return;         // 这一行被折叠掉了，没有位置可放
  const sc = el(side, 'scroll');
  const keepScroll = !!(opts && opts.keepScroll);
  /* 不动视口时，目标行可能根本不在屏幕上（用户滚到别处才按的撤销）。
     此时把光标夹到视口正中那一条可见行：视口不动，但焦点必须留在正文里 ——
     掉到 body 上，用户下一次按键就是「没反应」，那比光标差几行严重得多。 */
  if (keepScroll
      && (rowTop(vi) + rowH(vi) <= sc.scrollTop || rowTop(vi) >= sc.scrollTop + sc.clientHeight)) {
    vi = rowAtY(sc.scrollTop + sc.clientHeight / 2);
    i = S.view[vi];
  }
  S.pin = i;                  // 光标落在这里，折叠时别把它收走
  const y = rowTop(vi);
  if (!keepScroll && (y < sc.scrollTop || y + rowH(vi) > sc.scrollTop + sc.clientHeight)) {
    sc.scrollTop = Math.max(0, y - sc.clientHeight / 2);
    syncFrom(side, sc.scrollTop, sc.scrollLeft);
  }
  render(true);
  const host = el(side, 'canvas').querySelector(`.cmp-tx[data-i="${i}"]`);
  if (!host) return;
  /* focus() 默认会把目标滚进视野 —— 上面好不容易不动的视口会在这里被拽走。
     preventScroll 只在「不主动滚」的调用里给（见 keepScroll 的注释）。 */
  host.focus({ preventScroll: keepScroll });
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

/** 当前「在哪一侧」：事件目标 → 文档里的选区 → 上一次落过的栏 → 有内容的那一侧。
 *  选区这一层不能省：点工具栏按钮时事件目标是按钮，但光标还在原来那一行里，
 *  用户心里的「当前侧」就是那一行（Beyond Compare 的按钮文字也是这么翻的）。 */
function activeSide(node) {
  const host = node && node.closest && node.closest('.cmp-tx');
  if (host) return sideOf(host);
  const sel = window.getSelection();
  const n = sel && sel.anchorNode;
  const holder = n && (n.nodeType === 1 ? n : n.parentElement);
  const tx = holder && holder.closest && holder.closest('.cmp-tx');
  if (tx) return sideOf(tx);
  if (S.lastSide) return S.lastSide;
  if (S.sides.l.loaded) return 'l';
  if (S.sides.r.loaded) return 'r';
  return '';
}

/** Ctrl+Z / Ctrl+Y 落在哪一侧：跟光标走，光标不在行里才用兜底 */
function undoTarget(e) {
  return activeSide(e && e.target);
}

/** 结构性编辑（换行 / 并行 / 缩进 / 撤销）之后统一走这里：重算、重画、把光标放回去。
 *  必须顺手标脏 —— 只有打字那条路径会经 flush() 标脏，换行、并行这些不经过它，
 *  漏掉的话 Ctrl+S 会认为「没有需要保存的改动」，改动直接丢掉（实测踩过）。 */
function applyEdit(side, line, col, opts) {
  S.sides[side].dirty = true;
  S.lastSide = side;          // 光标可能随后跑到工具栏上，撤销还得知道落在哪一侧
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  focusAt(side, line, col, opts);
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
  S.pin = i;                 // 正在写的这一行，折叠时留着
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
 *
 *  两级来源：先读实时选区（键盘 Ctrl+Z 时焦点还在行里，最准）；
 *  读不到就退回 lastCaret —— 点工具栏按钮时焦点已经给了按钮，
 *  这时 getSelection() 常常是空的。没有这一级，line 会退回 1，
 *  focusAt(1) 把屏幕滚到顶部：用户看到的就是「撤销一下跳回开头」。
 *  某一侧从没落过光标时才给第 1 行，由 focusAt 夹一次。 */
function caretAt(side) {
  const p = caretPos();
  if (p && p.side === side) return { line: p.line, col: p.col };
  const lc = S.lastCaret;
  if (lc && lc.side === side) return { line: lc.line, col: lc.col };
  return { line: 1, col: 0 };
}

function undo(side, redo) {
  const st = S.sides[side];
  const from = redo ? st.redo : st.undo;
  const to = redo ? st.undo : st.redo;
  if (!from.length) return false;
  /* 先记光标再换内容：长文档里撤一步就跳回顶部，等于让人重新找回位置 */
  const at = caretAt(side);
  to.push(st.lines.slice());
  st.lines = from.pop();
  st.dirty = true;
  /* keepScroll：撤/重做只把光标放回原处，不主动把视口拖走。用户可能正看着
     文档另一段，操作一下画面就跳过去是打断。 */
  applyEdit(side, at.line, at.col, { keepScroll: true });
  return true;
}

/** 撤销/重做：先试当前侧，没历史就落到另一侧。
 *  「同步到另一边」改的是**另一侧**，而光标还留在原处 —— 不兜这一下，
 *  用户按 Ctrl+Z 会觉得「刚做的事撤不掉」。 */
function undoEither(side, redo) {
  if (undo(side, redo)) return true;
  return undo(side === 'l' ? 'r' : 'l', redo);
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

/* ---------------- 把一处差异整段同步到另一边 ----------------
 * 这是所有对比工具共有的那个动词，也是以前唯一缺的那个：改完左边，右边只能
 * 手抄。粒度取「一处差异」—— Beyond Compare 的 Copy to Other Side 复制的是
 * 选中的行或当前段，WinMerge 的 Alt+←/→ 复制的是 difference，Meld 中栏的箭头
 * 也是整块 replace。方向跟着光标在哪一侧（BC 的按钮文字就是这么翻的）。
 */

/** 一处差异两侧各占哪些行：1 基行号、行数、原文 */
function blockParts(i) {
  const [s, e] = blockRange(i);
  if (s < 0) return null;
  const out = { s, e, l: { first: 0, n: 0, texts: [] }, r: { first: 0, n: 0, texts: [] } };
  for (let k = s; k <= e; k++) {
    const row = S.rows[k];
    for (const side of ['l', 'r']) {
      const cell = side === 'l' ? row.l : row.r;
      if (!cell) continue;
      const b = out[side];
      if (!b.n) b.first = cell.no;
      b.n++;
      b.texts.push(cell.text);
    }
  }
  return out;
}

/**
 * 把当前这一处差异整段推到 `dst` 侧（`dst` 是**目标**侧，和快捷键方向一致）。
 * @param {boolean} advance 推完是否跟到下一处（连续合并的主循环）
 */
function pushBlock(dst, advance = false) {
  if (!S.edit) { toast(tt('先打开「编辑」才能改内容')); return; }
  if (!(S.sides.l.loaded && S.sides.r.loaded)) return;
  /* 防抖里那一行还没进模型：不先并回去，取到的「这一处原文」就是旧的 */
  if (S.pending) { flush(); S.ver++; recompute(); }
  const parts = blockParts(S.cur);
  if (!parts) { toast(tt('两侧没有差异')); return; }
  const src = dst === 'l' ? 'r' : 'l';
  const from = parts[src];
  const to = parts[dst];
  if (!from.n && !to.n) return;
  /* 目标侧在这一处没有行时，插入位置 = 前面最后一个本侧行号 + 1
     （recompute 已经把 fL / fR 算好了，和占位行写字的落点同一套） */
  const anchor = S.rows[parts.s];
  const at = to.n ? to.first - 1 : (dst === 'l' ? anchor.fL : anchor.fR) - 1;
  if (!Number.isFinite(at) || at < 0) return;

  recordUndo(dst);                      // 整段替换算一步撤销
  S.sides[dst].lines.splice(at, to.n, ...from.texts);
  S.sides[dst].dirty = true;
  /* 不把 lastSide 改成目标侧：连着推好几处是最常见的用法（一路 Alt+→ 推下去），
     每推一次就把方向翻过来，用户得反复找按钮 */
  S.ver++;
  recompute();
  render(true);
  updateMeta();
  if (!S.blocks.length) { toast(tt('这一处已同步，两侧现在完全一致')); return; }
  if (advance) gotoBlock(Math.min(S.cur, S.blocks.length - 1));
}

/**
 * 中间那对箭头：只在「两侧都有内容、开着编辑、且确实有差异」时出现。
 * 纵向跟着**当前这一处**差异走 —— 它就在读者眼睛附近，不用把鼠标从正文
 * 拖回工具栏。当前块滚出视口时夹在可见范围里，仍然能点。
 * （原来它是工具栏上的一个按钮，文字还得随光标所在侧在「复制到左/右」之间
 * 翻转，一个按钮说两件事，两边都不清楚。）
 */
function syncGutter() {
  const pair = $('gutPair');
  if (!pair) return;
  const show = S.edit && S.sides.l.loaded && S.sides.r.loaded && S.blocks.length > 0;
  pair.hidden = !show;
  if (!show) return;

  const main = $('main');
  const sc = el('l', 'scroll');
  const headTop = Math.max(0, Math.round(sc.getBoundingClientRect().top - main.getBoundingClientRect().top));
  const boxH = pair.offsetHeight || 38;
  const [cs, ce] = blockRange(S.cur);
  const vs = cs < 0 ? -1 : vposOf(cs);
  const ve = cs < 0 ? -1 : vposOf(ce);
  let center = headTop + sc.clientHeight / 2;       // 当前块看不见时落在正中
  if (vs >= 0 && ve >= 0) {
    /* 块的首行顶到末行底的中线。换行之后一行能有几行高，
       按「条数 × 行高」算会把箭头拽得太靠下 */
    const mid = (rowTop(vs) + rowTop(Math.max(vs, ve)) + rowH(Math.max(vs, ve))) / 2;
    center = headTop + mid - sc.scrollTop;
  }
  const top = clamp(center - boxH / 2, headTop + 2,
    Math.max(headTop + 2, headTop + sc.clientHeight - boxH - 2));
  pair.style.top = Math.round(top) + 'px';
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
mark{background:rgba(217,43,43,.2);color:inherit}mark.rem{background:rgba(217,43,43,.32)}
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
    /* 打开时就是铺满的（见 lib.rs），所以按钮初始显示「还原」。
       图标和 title 一起切：光换图标不换提示，悬停时说的还是上一步的话。 */
    let filled = true;
    const syncFillBtn = () => {
      const b = $('wmax');
      b.classList.toggle('restored', filled);
      const label = filled ? tt('还原') : tt('最大化');
      b.title = label;
      b.setAttribute('data-i18n-title', label);
      b.setAttribute('aria-label', label);
    };
    syncFillBtn();
    $('wmin').onclick = () => w.minimize();
    $('wmax').onclick = () => {
      const was = filled;
      filled = !filled;
      syncFillBtn();
      be.setToolFill('compare', filled).catch(() => { filled = was; syncFillBtn(); });
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
  $('optWrap').onchange = (e) => setWrap(e.target.checked);
  /* 折叠不改变 diff 结果，不需要重算差异 —— 只要重排可见行 */
  $('optFold').onchange = (e) => {
    S.opt.collapse = e.target.checked;
    buildView();
    S.ver++;
    render(true);
  };

  $('prev').onclick = () => gotoBlock(S.cur - 1);
  $('next').onclick = () => gotoBlock(S.cur + 1);
  /* 缝里的两个箭头：箭头指向哪一侧，就把这一处推到哪一侧。
     不做「跟光标方向」那套 —— 箭头本身已经把方向说清楚了。 */
  $('pushLeft').onclick = () => pushBlock('l');
  $('pushRight').onclick = () => pushBlock('r');
  /* 点进哪一栏，就把「当前侧」记成哪一栏：撤销要按它找历史 */
  document.addEventListener('focusin', (e) => {
    const host = e.target && e.target.closest && e.target.closest('.cmp-tx');
    if (host) S.lastSide = sideOf(host);
  });
  $('save').onclick = save;

  /* 右键：换行开关要在任何状态下都点得到（只读也常想「这行太长，折一下」）。
     复制/全选跟着编辑态走 —— 只读时没有剪切粘贴可言。 */
  for (const side of ['l', 'r']) {
    el(side, 'scroll').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hasSel = !!String(window.getSelection() || '');
      const clip = (cmd) => { try { document.execCommand(cmd); } catch {} };
      const items = S.edit
        ? [
            { label: tt('剪切'), shortcut: 'Ctrl+X', disabled: !hasSel, action: () => clip('cut') },
            { label: tt('复制'), shortcut: 'Ctrl+C', disabled: !hasSel, action: () => clip('copy') },
            { label: tt('粘贴'), shortcut: 'Ctrl+V', action: () => clip('paste') },
            { label: tt('全选'), shortcut: 'Ctrl+A', action: () => selectAllSide(side) },
            { sep: true },
          ]
        : [
            { label: tt('复制'), shortcut: 'Ctrl+C', disabled: !hasSel, action: () => clip('copy') },
            { label: tt('全选'), shortcut: 'Ctrl+A', action: () => selectAllSide(side) },
            { sep: true },
          ];
      items.push({ lead: tt('换行'), row: [
        { label: tt('自动换行'), hint: tt('长行折到下一行显示'), checked: () => S.wrap, action: () => setWrap(true) },
        { label: tt('不换行'), hint: tt('长行不折行，横向滚动查看'), checked: () => !S.wrap, action: () => setWrap(false) },
      ] });
      contextMenu(e.clientX, e.clientY, items);
    });
  }
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

  /* 编辑开关抽成函数，别处也要进同一个状态机 */
  $('toggleEdit').onclick = () => {
    setEdit(!S.edit);
    toast(S.edit ? tt('编辑已打开：直接改字，Ctrl+S 写回磁盘') : tt('编辑已关闭'));
  };
  $('sortBtn').onclick = () => sortSides();
  /* 工具栏上的后悔药：跟 Ctrl+Z / Ctrl+Y 走同一套逻辑，不是第二套实现 */
  $('undoBtn').onclick = () => doUndo(false);
  $('redoBtn').onclick = () => doUndo(true);

  /* 查找：输入即定位，Enter / Shift+Enter 前后走 */
  let scanTimer = 0;
  $('findBtn').onclick = openFind;
  $('findInput').addEventListener('input', () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(applyFind, 140);
  });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findGo(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('findPrev').onclick = () => findGo(-1);
  $('findNext').onclick = () => findGo(1);
  $('findClose').onclick = closeFind;

  for (const side of ['l', 'r']) {
    bindScroll(side);
    const cv = el(side, 'canvas');
    cv.addEventListener('input', onInput);
    cv.addEventListener('keydown', onKey);
    /* 别让浏览器把「按住正文往下拖」当成拖放：文本一旦被选中，Blink 会起一个
       OS 级拖动会话，之后的 mousemove 全被它吞掉（实测：拖选接管之后指针再也
       收不到移动，选区就停在按下的那一行），松手还可能把文字挪到另一行。 */
    cv.addEventListener('dragstart', (e) => e.preventDefault());
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
      /* 锚点要在恢复可写**之前**取：restoreEditables 一恢复 contenteditable，
         跨行选区立刻被掐回一行，Shift+点击就无从接着扩了。 */
      const anchor = e.shiftKey ? currentAnchor() : null;
      /* 全选后点回正文：先把可写恢复，这一步必须在浏览器放置光标之前，
         否则这一下点不进任何一行（点到哪儿都只是收掉选区）。 */
      if (strippedHosts.length) restoreEditables();
      if (!S.edit) return;
      if (e.target.closest && e.target.closest('.cmp-tx')) { dragBegin(e, anchor); return; }   // 行内：光标与双击/三击交给浏览器
      drag = null;
      const box = cv.getBoundingClientRect();
      const row = e.target.closest && e.target.closest('.cmp-row');
      const inner = row && row.querySelector('.cmp-tx');
      let i = inner ? +inner.dataset.i : NaN;
      if (!Number.isFinite(i)) {
        // 行下方的空白：按坐标算离得最近的那一行（坐标是行位，换回模型下标）
        // 行下方的空白：按坐标算离得最近的那一行（坐标是行位，换回模型下标）
        const vi = clamp(rowAtY(e.clientY - box.top), 0, S.view.length - 1);
        i = S.view[vi];
        if (i == null) return;
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
    /* 拖着选区往视口外走：那里还没有行，先补上。
       补的时机放在「指针接近上下边缘」这一刻而不是按下时 —— 一屏之内选几个字
       是常态，不该为此把几万行都摆出来。
       指针跨出按下的那一行之后，选区由 dragMove 自己接管。 */
    cv.addEventListener('mousemove', (e) => {
      if (!e.buttons) return;
      if (drag && drag.side === side) dragMove(e);
      const r = el(side, 'scroll').getBoundingClientRect();
      const M = 40;
      if (e.clientY < r.top + M || e.clientY > r.bottom - M) ensureAllRows(side);
    });
    // 只读态下不允许输入，避免 caret 跑进去
    cv.addEventListener('beforeinput', (e) => { if (!S.edit) e.preventDefault(); });
  }

  /* 拖到边缘时指针可能已经在正文区外面（滚动条、窗口外），画布收不到事件 ——
     拖选和松手都挂在 document 上。松手落在滚动条上时连 document 也收不到
     mouseup（那是原生控件），所以再用「下一次移动时按键已经松开」兜一次。 */
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (!e.buttons) { dragEnd(); return; }
    dragMove(e);
  });
  document.addEventListener('mouseup', () => dragEnd());

  /* 跨行选区上的粘贴落点。crossSelKey 已经把选区记进 pendingPaste、并把这一侧
     恢复成可写（否则浏览器不会派发 paste 事件），这里拦住浏览器的默认插入 ——
     它只会写进光标所在那一行，把「选中了一整段」当没选 —— 改由 replaceSpan
     落到模型上。单行粘贴不设 pendingPaste，这里直接放行。 */
  document.addEventListener('paste', (e) => {
    const span = pendingPaste;
    pendingPaste = null;
    if (!span) return;
    e.preventDefault();
    if (!S.edit) return;
    const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    flush();
    replaceSpan(span, String(t || '').replace(/\r\n/g, '\n'));
  });

  /* 光标每动一次就记一份：撤销要在「焦点已经不在正文」的情况下也找得到位置
     （点工具栏按钮那一刻 getSelection() 常常是空的，见 caretAt）。 */
  document.addEventListener('selectionchange', () => {
    const p = caretPos();
    if (p) S.lastCaret = { side: p.side, line: p.line, col: p.col };
  });

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
    /* 输入框里的按键归它自己管。这个监听挂在 document 上（为了点过工具栏
       之后 Ctrl+Z 还能用），不挡一下的话，在查找框里敲 F8、Alt+← 都会
       被当成正文快捷键，窗口跟着乱跳。 */
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    /* 撤销/重做放在 document 上，比「挂在两个画布上」宽一层：
       点过排序、编辑开关之后焦点就在按钮上，挂在画布上的监听收不到，
       用户看到的现象就是「Ctrl+Z 没反应」。*/
    const mod = e.ctrlKey || e.metaKey;
    const lk = (e.key || '').toLowerCase();
    /* 全选只选这一侧全文：浏览器默认的全选会把两栏、行号、悬浮层一起框进来 */
    if (mod && lk === 'a') { e.preventDefault(); selectAllSide(activeSide(null)); return; }
    if (mod && lk === 'f') { e.preventDefault(); openFind(); return; }
    if (mod && (lk === 'z' || lk === 'y') && S.edit) {
      e.preventDefault();
      flush();
      const side = undoTarget(e);
      if (!side) return;
      if (lk === 'y') { undoEither(side, true); return; }
      if (!e.shiftKey && undoSort()) return;   // 排序是整侧替换，先按整体撤
      undoEither(side, e.shiftKey);
      return;
    }
    if (e.defaultPrevented) return;
    /* 全选 / 拖选之后这一侧是「不可写」的（摘掉 contenteditable 才选得起来），
       往选区里打字、按删除都得自己落到模型上 */
    if (S.edit && strippedHosts.length && crossSelKey(e)) return;
    if (e.defaultPrevented) return;
    const k = e.key;
    /* Alt+← / Alt+→ 把这一处整段推到那一侧（WinMerge 与 Beyond Compare 的默认绑定）；
       再加 Ctrl 就是「推完接着看下一处」，连续合并靠的就是这一条。 */
    if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      e.preventDefault();
      if (!S.edit) return;
      pushBlock(k === 'ArrowRight' ? 'r' : 'l', mod);
      return;
    }
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      gotoBlock(S.cur + (k === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (k === 'Escape' && S.find.on) { e.preventDefault(); closeFind(); return; }
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
    /* reset：选中的文件读不进来时，这一侧要清空成空白，不能留着上一个文件
       继续和新文件比 —— 那种「看起来正常」的结论比报错危险得多 */
    if (p) { showWarn(''); await loadSide(side, p, { reset: true }); }
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
  /* 行显示模式：跟着主窗口那份偏好（默认自动换行）。必须在第一次 render
     之前定下来，否则首帧按错误的高度排版，接着又整体重排一次。
     setWrap 在「值没变」时会提前返回，但属性、勾选、提示语已经全部设好。 */
  S.wrap = settings.wrap !== false;
  setWrap(S.wrap);
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
  /* 没带文件打开时直接给两个空白编辑区：对比窗口最常用的用法是「贴两段文本
     比一比」，先摆一屏「选择左侧文件 / 选择右侧文件」等于让人先点两次才开始。
     带了文件（工具栏 / 右键 / --compare）才展示文件内容。 */
  if (req && (req.left || req.right)) await loadPair(req.left, req.right);
  else startPairText();
})();
