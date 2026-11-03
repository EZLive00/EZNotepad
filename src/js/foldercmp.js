// ============================================================
// foldercmp.js —— 文件夹对比独立窗口
//
// 为什么单独一扇窗：主窗口的浮层只有一栏「状态 / 路径 / 大小」，看不出
// 左右两侧各自是什么，也点不进两侧目录。这里左右各列自己那一侧的文件，
// 同一行就是同一对，一行行看过去就是「谁多了、谁少了、谁改过」。
//
// 刻意做得简单：不做批量同步、不做三栏合并 —— 那些需求真要来的时候，
// 用户会去用专门的工具。这个窗口只回答一个问题：两个目录差在哪儿。
// ============================================================
import * as be from './backend.js';
import { toast } from './ui.js';
import { tt, setLang, resolveLang, applyDom } from './i18n.js';
import { settings } from './state.js';
import { getCurrentWindow } from '../vendor/api/window.js';
import { listen } from '../vendor/api/event.js';
import { errText } from './errors.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 一屏之外的行还是一次性铺出来 —— 目录对比动辄几千个文件，铺 2 万行 DOM 会
   卡住半秒以上。超过上限就截断并明说，别让人以为「就这么多」 */
const MAX_ROWS = 4000;

const S = {
  sides: {
    l: { path: '', files: null },
    r: { path: '', files: null },
  },
  items: [],
  onlyDiff: true,
  truncated: false,
  busy: false,
};

/* ---------------- 主题 / 语言 ---------------- */
function applyTheme() {
  let t = settings.theme || 'auto';
  if (t === 'auto') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.dataset.theme = t;
}

/* ---------------- 小工具 ---------------- */
const fmtSize = (n) => {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
};

/** 相对路径：两侧都按各自根目录算，键才对得上（否则 A\src\x 和 B\src\x 永不相等） */
function rel(root, p) {
  const r = root.replace(/[\\/]+$/, '');
  let s = p.startsWith(r) ? p.slice(r.length) : p;
  s = s.replace(/^[\\/]/, '');
  return s.split('\\').join('/');
}

const baseName = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/* ---------------- 扫描 ---------------- */
async function scan() {
  const L = S.sides.l, R = S.sides.r;
  if (S.busy) return;
  if (!L.path || !R.path) {
    S.items = [];
    render();
    return;
  }
  S.busy = true;
  $('stat').textContent = tt('正在扫描…');
  try {
    const [a, b] = await Promise.all([be.listDir(L.path), be.listDir(R.path)]);
    L.files = a;
    R.files = b;
    const mapA = new Map(a.map((x) => [rel(L.path, x.path), x]));
    const mapB = new Map(b.map((x) => [rel(R.path, x.path), x]));
    const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    S.items = keys.map((k) => {
      const x = mapA.get(k), y = mapB.get(k);
      let kind;
      if (x && !y) kind = 'left';
      else if (!x && y) kind = 'right';
      /* 大小一样还定不了：字数相同的一次修改（「一」→「二」、3 → 5）字节数
         一模一样，只看大小就会把改过的文件报成「相同」，而「只看差异」默认
         勾着 —— 等于把差异藏起来。所以等大的还要读一遍内容 */
      else kind = x.size === y.size ? 'maybe' : 'mod';
      return { k, kind, x, y };
    });

    // 内容比对整批发一次，别一个文件一次 IPC
    const unsure = [];
    S.items.forEach((it, i) => { if (it.kind === 'maybe') unsure.push(i); });
    if (unsure.length) {
      let flags = null;
      try {
        flags = await be.compareFilePairs(unsure.map((i) => [S.items[i].x.path, S.items[i].y.path]));
      } catch { /* 读不了就按「已修改」报：宁可多报，不能把改过的说成一样 */ }
      unsure.forEach((i, n) => { S.items[i].kind = flags && flags[n] ? 'same' : 'mod'; });
    }
    S.truncated = S.items.length > MAX_ROWS;
  } catch (e) {
    S.items = [];
    $('stat').textContent = tt('扫描失败：{msg}', { msg: errText(e) });
  } finally {
    S.busy = false;
    render();
  }
}

/* ---------------- 渲染 ---------------- */
/* 行里只存索引：路径里有 & < " 这类字符，塞进 data-* 属性要转义好几层，
   索引是唯一不会出错的做法 */
let shown = [];

function cellHtml(x, side) {
  if (!x) return '<div class="fcmp-c void"></div>';
  const r = rel(S.sides[side].path, x.path);
  const i = r.lastIndexOf('/');
  const dir = i >= 0 ? r.slice(0, i + 1) : '';
  const name = i >= 0 ? r.slice(i + 1) : r;
  const tip = `${x.path}\n${new Date(x.mtime).toLocaleString()}`;
  return `<div class="fcmp-c" title="${esc(tip)}">
    <span class="fcmp-nm">${dir ? `<span class="fcmp-dir">${esc(dir)}</span>` : ''}${esc(name)}</span>
    <span class="fcmp-sz">${fmtSize(x.size)}</span>
  </div>`;
}

function render() {
  const headL = $('headL'), headR = $('headR');
  headL.textContent = S.sides.l.path
    ? `${baseName(S.sides.l.path)} · ${tt('{n} 个文件', { n: (S.sides.l.files || []).length })}`
    : tt('左侧');
  headR.textContent = S.sides.r.path
    ? `${baseName(S.sides.r.path)} · ${tt('{n} 个文件', { n: (S.sides.r.files || []).length })}`
    : tt('右侧');
  headL.title = S.sides.l.path || '';
  headR.title = S.sides.r.path || '';

  const cnt = { left: 0, right: 0, mod: 0, same: 0 };
  S.items.forEach((i) => { cnt[i.kind]++; });
  const show = S.onlyDiff ? S.items.filter((i) => i.kind !== 'same') : S.items;
  shown = show.length > MAX_ROWS ? show.slice(0, MAX_ROWS) : show;

  const empty = $('empty');
  const rows = $('rows');
  if (!S.sides.l.path || !S.sides.r.path) {
    rows.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = tt('选左右两个文件夹开始对比');
    $('stat').textContent = tt('选左右两个文件夹开始对比');
    return;
  }
  if (!show.length) {
    rows.innerHTML = '';
    empty.classList.remove('hidden');
    empty.textContent = tt('没有差异（或该目录为空）');
    $('stat').textContent = tt('共 {n} 个文件 · 仅左 {l} · 仅右 {r} · 已修改 {m} · 相同 {s}',
      { n: S.items.length, l: cnt.left, r: cnt.right, m: cnt.mod, s: cnt.same });
    return;
  }
  empty.classList.add('hidden');

  rows.innerHTML = shown.map((i, idx) => {
    const clickable = !!(i.x || i.y);
    return `<div class="fcmp-row k-${i.kind}${clickable ? ' clickable' : ''}" data-i="${idx}">`
      + cellHtml(i.x, 'l') + cellHtml(i.y, 'r') + '</div>';
  }).join('');

  rows.querySelectorAll('.fcmp-row').forEach((row) => {
    row.onclick = () => {
      const it = shown[Number(row.dataset.i)];
      if (!it) return;
      const l = it.x && it.x.path, r = it.y && it.y.path;
      if (l && r) be.openCompareWindow(l, r).catch((e) => toast(tt('打不开对比窗口：') + e));
      else if (l || r) be.openInMain(l || r).catch((e) => toast(tt('打不开文件：') + errText(e)));
    };
  });

  const cutNote = S.truncated || show.length > MAX_ROWS
    ? ` · ${tt('只显示前 {n} 条', { n: MAX_ROWS })}`
    : '';
  $('stat').textContent = tt('共 {n} 个文件 · 仅左 {l} · 仅右 {r} · 已修改 {m} · 相同 {s}',
    { n: S.items.length, l: cnt.left, r: cnt.right, m: cnt.mod, s: cnt.same }) + cutNote;
}

/* ---------------- 两侧文件夹 ---------------- */
function paintSlots() {
  const set = (id, path, placeholder) => {
    const n = $(id);
    n.textContent = path || placeholder;
    n.title = path || '';
    n.classList.toggle('faint', !path);
  };
  set('nameL', S.sides.l.path, tt('左侧未选择'));
  set('nameR', S.sides.r.path, tt('右侧未选择'));
}

async function pickSide(side) {
  const p = await be.pickFolder(side === 'l' ? tt('选择左侧文件夹') : tt('选择右侧文件夹'));
  if (!p) return;
  S.sides[side].path = p;
  S.sides[side].files = null;
  paintSlots();
  await scan();
}

/* ---------------- 启动 ---------------- */
function bindWindow() {
  const w = (() => { try { return getCurrentWindow(); } catch { return null; } })();
  if (!w) return;
  /* 出生就铺满工作区，所以按钮初始显示「还原」。图标与提示一起切 */
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
    be.setToolFill('foldercmp', filled).catch(() => { filled = was; syncFillBtn(); });
  };
  $('wclose').onclick = () => w.close();
}

async function loadPair(left, right) {
  if (left) { S.sides.l.path = left; S.sides.l.files = null; }
  if (right) { S.sides.r.path = right; S.sides.r.files = null; }
  paintSlots();
  await scan();
}

async function boot() {
  setLang(resolveLang(settings.lang));
  applyTheme();
  applyDom();

  $('slotL').onclick = () => pickSide('l');
  $('slotR').onclick = () => pickSide('r');
  $('swap').onclick = async () => {
    const l = S.sides.l;
    S.sides.l = S.sides.r;
    S.sides.r = l;
    paintSlots();
    await scan();
  };
  $('optDiff').onchange = (e) => { S.onlyDiff = e.target.checked; render(); };
  $('rescan').onclick = () => scan();

  bindWindow();

  /* 主窗口把两个目录推过来（已经开着这扇窗时走事件，否则走一次性请求） */
  try {
    const req = await be.takeFolderCompareRequest();
    if (req && (req.left || req.right)) await loadPair(req.left, req.right);
    else {
      paintSlots();
      render();
    }
  } catch (e) {
    paintSlots();
    render();
  }

  try {
    await listen('foldercmp:load', (e) => {
      const p = e.payload || {};
      loadPair(p.left, p.right);
    });
  } catch {}

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

boot();
