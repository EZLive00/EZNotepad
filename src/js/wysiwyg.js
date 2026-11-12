// ============================================================
// wysiwyg.js —— Markdown 所见即所得编辑视图
//
// 模型：一行 = 一个 .w-block（段落 / 标题 / 列表项 / 引用 / 代码块 / 表格 / 分割线）。
// 块内即时渲染行内样式（粗体、斜体、行内码、链接、图片），DOM 改动立刻序列化回 Markdown。
//
// 两条铁律：
//   1) 结构操作（回车拆分、退格合并、Tab 缩进、列表编号、表格行列）全部自己接管，
//      不依赖浏览器默认行为 —— 默认行为在 contenteditable 里不可预测，而且会和
//      Markdown 数据结构对不上。
//   2) 序列化必须走 DOM 树，不能用 textContent —— 否则 <strong> 之类的行内样式
//      在下次编辑时会被抹平成纯文本（** 丢了）。
// ============================================================

import { resolveDocImg, headingSlugs, CALLOUT_TYPES, RE_CALLOUT, normalizeCallout, splitImgAlt } from './markdown.js';
import { tt } from './i18n.js';
import { codeText, refreshCode } from './codehilite.js';
import { updateSelMatch, clearSelMatch } from './selmatch.js';
import { writeClipboard } from './clipboard.js';

const MAX_INDENT = 6;
const ZWSP = '\u200b';

/** 撤销历史的总字节上限。条数上限（200）对小文档够用，长文档得靠这个兜底 */
const HISTORY_BYTES = 8 * 1024 * 1024;
/* 超过这个块数的文档按「大文档」对待：分块插入 + 跳过载入期全量扫描。
   阈值取 5000 块（约几千行），常规文档完全走不到这条路径。 */
const BIG_DOC_BLOCKS = 5000;
/* 超过这个字符数走渐进载入：首段先上屏、其余 bulk 插入。
   parse 是载入期最大的单笔阻塞（~0.4ms/千字符），1MB 起感知明显。 */
const BIG_DOC_CHARS = 1000 * 1000;
/* .wysiwyg 的 CSS padding-top（绝对偏移的零点） */
const PAD_TOP = 32;
/* 拖选期间窗口只增不减的上限（块）。4 屏约百来块，2000 块够拖十几屏；
   再往上 DOM 成本就压过收益了，此时退回正常搬家（选区会断，和以前一样） */
const MAX_DRAG_WIN = 2000;

/** 字符串占的字节数（V8 里 1 个 UTF-16 码元 = 2 字节，这里只用于比较量级） */
const bytesOf = (s) => (s ? s.length * 2 : 0);
/* 视口模式的撤销快照是「记录数组的浅拷贝」：块对象由 _syncWindow 写时复制
   （内容没变就保持同一个对象），所以一份 8 万块的快照只占 620 KB 指针。
   条数按同样的字节预算折算，10MB 文档能留十几步，而不是原先的一步。 */
const snapSize = (e) => (e.recs ? e.recs.length * 8 + 64 : bytesOf(e.md));
const sameRecs = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 当前文档所在目录：图片的相对路径要按它展开成可加载的绝对地址 */
let docDir = '';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/* escapeHtml 的逆运算，**必须按转义的逆序**（先 > < 再 &）：
   escapeHtml 是 & → < → > 依次跑的，若先解 &amp; 会把 `&amp;lt;` 拆成 `&lt;`
   再被当成转义序列解成 `<` —— 源文件里手写的实体就被吃掉了。
   inlineHtml 先把整段（含语法）转义，之后从这段已转义文本里抽 href / src，
   所以抽出来的必须先反解一层，否则属性会被重复转义（`&amp;` → `&amp;amp;`，
   存回 md 就多一层，打开再保存即污染文件）。 */
const unescapeHtml = (s) => String(s)
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/* ============================================================
 * 行内：Markdown <-> HTML
 * ============================================================ */

/** 行内 Markdown -> HTML（编辑视图里的即时样式） */
export function inlineHtml(src) {
  const codes = [];
  let t = String(src).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0001${codes.length - 1}\u0001`;
  });

  /* 公式：只染色，不渲染。
     真把 KaTeX 的 DOM 塞进 contenteditable，退格删不掉、光标会卡住，
     序列化还得为它单开一套。这里包一层 span，但**存的是含 $ 的完整原文** ——
     inlineToMd 走默认分支把里面的文字原样吐出来，所以存回去一字不差。
     存内层 tex 而丢掉定界符就糟了：切回编辑模式时公式会退化成普通文字。 */
  const maths = [];
  t = t.replace(/\$\$[\s\S]+?\$\$/g, (m) => { maths.push(m); return `\u0002${maths.length - 1}\u0002`; });
  t = t.replace(/\$(?=[^\s$])[^$\n]*?[^\s$]\$/g, (m) => { maths.push(m); return `\u0002${maths.length - 1}\u0002`; });

  t = escapeHtml(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, s) => {
      /* t 已经过 escapeHtml，这里抽出的是转义态：拆 alt、算路径、写属性都得用原文 */
      const shown = resolveDocImg(unescapeHtml(s), docDir);
      /* 尺寸写在 alt 里（`![说明|300](a.png)`），渲染成 width / height，
         所见即所得里立刻就能看到缩过的样子 */
      const { text, width, height } = splitImgAlt(unescapeHtml(alt));
      const dim = (width ? ` width="${width}"` : '') + (height ? ` height="${height}"` : '');
      /* draggable=否：浏览器默认的图片拖拽会和右下角改宽抢同一串指针事件 */
      return `<img class="w-img" draggable="false" src="${escapeAttr(shown)}" data-src="${escapeAttr(unescapeHtml(s))}" alt="${escapeAttr(text)}"${dim}>`;
    });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, txt, href) => `<a href="${escapeAttr(unescapeHtml(href))}">${txt}</a>`);
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|\W)__([^_]+)__(?!_)/g, '$1<strong>$2</strong>');
  t = t.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  t = t.replace(/\u0002(\d+)\u0002/g, (_, i) => `<span class="w-math">${escapeHtml(maths[+i])}</span>`);
  return t;
}

/** DOM -> 行内 Markdown。这是「不丢样式」的关键：逐个节点还原标记 */
export function inlineToMd(node, brText = '') {
  let s = '';
  const kids = node.childNodes;
  /* 用下标循环而不是 forEach：这个函数在每次击键时都要把整篇文档跑一遍，
     闭包分配和迭代器开销在大文档里是实打实的。字符串拼接前先判断再替换，
     因为绝大多数文本节点既没有 nbsp 也没有零宽空格。 */
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 3) {
      const v = n.nodeValue;
      s += (v.indexOf('\u00a0') < 0 && v.indexOf('\u200b') < 0)
        ? v
        : v.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;             // 直接比大写，省掉每次 toLowerCase
    if (tag === 'BR') { s += brText; continue; }   // brText: 表格单元格里换行写 <br>，正文里丢弃
    // 图片：写回 Markdown 时用 data-src 里的原始地址（相对路径），
    // 不能用 src —— 那是展开成 asset:// 之后的显示用地址，存进去就搬不动了
    if (tag === 'IMG') {
      /* 尺寸存回 alt 后缀，和 mdToHtml 里的拆解规则对称：
         width 有值就写 `|宽`，宽高都有就写 `|宽x高` */
      const w = parseInt(n.getAttribute('width') || '', 10) || 0;
      const h = parseInt(n.getAttribute('height') || '', 10) || 0;
      const alt = n.getAttribute('alt') || '';
      const dim = w && h ? `${w}x${h}` : (w ? String(w) : (h ? `x${h}` : ''));
      const suffix = dim ? `|${dim}` : '';
      s += `![${alt}${suffix}](${n.getAttribute('data-src') || n.getAttribute('src') || ''})`;
      continue;
    }
    const inner = inlineToMd(n);
    switch (tag) {
      case 'STRONG': case 'B': s += inner.trim() ? `**${inner}**` : inner; break;
      case 'EM': case 'I': s += inner.trim() ? `_${inner}_` : inner; break;
      case 'DEL': case 'S': case 'STRIKE': s += inner.trim() ? `~~${inner}~~` : inner; break;
      case 'MARK': s += inner.trim() ? `==${inner}==` : inner; break;
      case 'CODE': s += n.textContent ? '`' + n.textContent + '`' : ''; break;
      case 'A': s += inner ? `[${inner}](${n.getAttribute('href') || ''})` : ''; break;
      default: s += inner;
    }
  }
  return s;
}

/* ============================================================
 * 块构造
 * ============================================================ */

function blockEl(type, cls) {
  const b = document.createElement('div');
  b.className = 'w-block' + (cls ? ' ' + cls : '');
  b.dataset.type = type;
  return b;
}

function mkText(text, cls) {
  const s = document.createElement('span');
  s.className = 'w-text' + (cls ? ' ' + cls : '');
  if (text) s.innerHTML = inlineHtml(text);
  else s.innerHTML = '<br>';
  return s;
}

export function mkPara(text = '') {
  const b = blockEl('p', 'w-p');
  b.appendChild(mkText(text));
  return b;
}

export function mkHeading(level, text = '') {
  const b = blockEl('h' + level, 'w-h');
  b.appendChild(mkText(text));
  return b;
}

/**
 * 列表项。缩进用 data-indent 表示层级（0 起），渲染时靠 CSS 变量缩进；
 * 有序列表的序号在 renumber() 里统一重排，DOM 里存 data-num 供序列化用。
 */
export function mkLi(kind, text = '', indent = 0, checked = false, start = 1) {
  const b = blockEl('li', 'w-li');
  b.dataset.list = kind;
  b.dataset.indent = String(indent);
  b.style.setProperty('--li-indent', String(indent));
  if (kind === 'task') {
    b.classList.add('w-task');
    if (checked) b.dataset.checked = '1';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'w-check';
    cb.checked = !!checked;
    cb.tabIndex = -1;
    cb.contentEditable = 'false';
    b.appendChild(cb);
  } else {
    const m = document.createElement('span');
    m.className = 'w-li-marker';
    m.contentEditable = 'false';
    m.textContent = kind === 'ol' ? `${start}.` : '•';
    b.appendChild(m);
  }
  b.appendChild(mkText(text));
  if (kind === 'ol') b.dataset.start = String(start);
  return b;
}

/** 提示块标题行：非可编辑，和 .w-codebar / .w-hash 同一套路 —— 视觉层不进 .w-text */
function mkCalloutHead(callout, title = '') {
  const def = CALLOUT_TYPES[callout];
  const head = document.createElement('div');
  head.className = 'w-co-head';
  head.contentEditable = 'false';
  head.innerHTML = `<svg class="co-ico"><use href="#i-${def.icon}"/></svg><span>${escapeHtml(title || def.label)}</span>`;
  return head;
}

/** 切换界面语言后，把**已经画在屏幕上**的提示块默认标题一起翻掉。
 *  预览会在 applyLang() 里重渲染，所见即所得却不能整篇重画 —— 那会丢光标
 *  和撤销栈，所以只改这一处文本节点。用户自己写的标题存在
 *  data-callout-title 里，是正文不是界面文案，不能碰。 */
export function relabelCallouts(root) {
  if (!root) return;
  for (const b of root.querySelectorAll('.w-block[data-callout]')) {
    if (b.dataset.calloutTitle) continue;
    const span = b.querySelector('.w-co-head > span');
    const def = CALLOUT_TYPES[b.dataset.callout];
    if (span && def) span.textContent = def.label;
  }
}

export function mkQuote(text = '', level = 0, callout = '', title = '') {
  const b = blockEl('bq', 'w-bq');
  b.dataset.indent = String(level);
  b.style.setProperty('--bq-indent', String(level));
  if (callout) {
    b.dataset.callout = callout;
    if (title) b.dataset.calloutTitle = title;
    b.appendChild(mkCalloutHead(callout, title));
  }
  b.appendChild(mkText(text));
  return b;
}

export function mkCode(text = '', lang = '') {
  const b = blockEl('code', 'w-codeblock');
  b.dataset.lang = lang || '';
  /* 语言条：左边是语言名（没标语言时由高亮模块填识别结果），右边是「复制」
     图标按钮。整条不可编辑、也不进 .w-text —— 序列化只认 .w-code 里的字，
     这条栏里加多少东西都不影响存盘。 */
  const bar = document.createElement('div');
  bar.className = 'w-codebar';
  bar.contentEditable = 'false';
  const name = document.createElement('span');
  name.className = 'cc-lang';
  name.textContent = lang || 'code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'cc-copy';
  copy.contentEditable = 'false';
  copy.tabIndex = -1;                       // Tab 在编辑器里有自己的含义，别让它落进按钮
  copy.title = tt('复制代码');
  copy.setAttribute('aria-label', tt('复制代码'));
  /* 图标统一挂 .ico：绘制属性（fill:none / stroke:currentColor）在样式表里
     一处给，symbol 里只留路径。不挂的话 svg 会用默认的黑色实心 —— 深色主题
     下就是一团黑块，而且完全看不出是复制。 */
  copy.innerHTML = '<svg class="ico cc-ico-copy"><use href="#i-copy"/></svg>'
    + '<svg class="ico cc-ico-done"><use href="#i-check"/></svg>';
  bar.append(name, copy);
  const s = document.createElement('span');
  s.className = 'w-text w-code';
  s.textContent = text;
  if (!text) s.innerHTML = '<br>';
  b.append(bar, s);
  return b;
}

/**
 * 块级公式：一个整体块，内容是裸 TeX（不带 $$）。
 * 不这么做的话 `$$` / 公式 / `$$` 会被当成三个普通段落，在富文本里走一趟
 * 就会在它们之间塞满空行 —— 内容没丢，但存盘时全文格式已经变了。
 * `$$` 用 CSS 伪元素画出来，不进 DOM，序列化只取 .w-text，天然不会多也不会少。
 */
export function mkMath(tex = '', inline = false) {
  const b = blockEl('math', 'w-mathblock');
  // 记下原文是 `$$x$$` 一行写完还是三行块。不记的话单行公式一过手就变三行，
  // 打开文档立刻被标脏，按一次保存就把用户的文件改了。
  if (inline) b.dataset.mathInline = '1';
  const s = document.createElement('span');
  s.className = 'w-text w-tex';
  s.textContent = tex;
  if (!tex) s.innerHTML = '<br>';
  b.append(s);
  return b;
}

export function mkHr() {
  const b = blockEl('hr', 'w-hr');
  b.contentEditable = 'false';
  b.innerHTML = '<hr>';
  return b;
}

function mkCell(tag, text, align) {
  const c = document.createElement(tag);
  if (align) { c.dataset.align = align; c.style.textAlign = align; }
  if (text) {
    /* 单元格里的换行约定存成 <br>（Markdown 表格格不了多行，GitHub/Typora 同款）。
       先换成占位符躲过 inlineHtml 的转义，再还原成真 <br> 元素 */
    let k = 0;
    c.innerHTML = inlineHtml(String(text).replace(/<br\s*\/?>/gi, () => `\u0001B${k++}\u0001`))
      .replace(/\u0001B(\d+)\u0001/g, '<br>');
  } else c.innerHTML = '<br>';
  return c;
}

/** 从数据建表格：head 为表头单元格文本，rows 为二维数组 */
export function mkTableFromData(head, aligns = [], rows = []) {
  const b = blockEl('table', 'w-table');
  const t = document.createElement('table');
  const colCount = Math.max(head.length, 1);
  t.dataset.aligns = Array.from({ length: colCount }, (_, i) => aligns[i] || '').join(',');

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (let i = 0; i < colCount; i++) htr.appendChild(mkCell('th', head[i] || '', aligns[i] || ''));
  thead.appendChild(htr);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (let i = 0; i < colCount; i++) tr.appendChild(mkCell('td', r[i] || '', aligns[i] || ''));
    tbody.appendChild(tr);
  }
  t.append(thead, tbody);
  b.appendChild(t);
  return b;
}

function mkTable(rows = 3, cols = 3) {
  const head = Array.from({ length: cols }, () => '');
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => Array.from({ length: cols }, () => ''));
  return mkTableFromData(head, [], body);
}

/* ============================================================
 * Markdown -> 块
 * ============================================================ */

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const RE_HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_QUOTE = /^\s*((?:>\s?)+)(.*)$/;
const RE_UL = /^(\s*)[-*+]\s+(.*)$/;
const RE_OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const RE_TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * 缩进层级：按「列」而不是「固定空格数」判断。
 * 这样无论原文用 2 空格、3 空格还是 4 空格缩进，嵌套结构都读得对
 * （序列化时会统一成规范列宽，见 blocksToMarkdown）。
 */
function makeLevelTracker() {
  const cols = [];
  const fn = (col) => {
    while (cols.length && col < cols[cols.length - 1]) cols.pop();
    if (!cols.length) cols.push(col);
    else if (col > cols[cols.length - 1]) cols.push(col);
    return Math.min(MAX_INDENT, cols.length - 1);
  };
  fn.reset = () => { cols.length = 0; };
  return fn;
}

const leadingCols = (ws) => {
  let n = 0;
  for (const ch of ws) n += ch === '\t' ? 4 : 1;
  return n;
};

/** 拆表格行：支持 \| 转义 */
export function splitRow(line) {
  let t = String(line).trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(cell) {
  const c = String(cell).trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return '';
}

/** 等一帧真正画完。rAF 在窗口被遮挡时不会触发，挂个 setTimeout 兜底。 */
function nextFrame() {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 64);
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

/** 把长文档按空行切成可独立 parse 的段（渐进载入用，每段约 target 字符）。
 *  正确性只依赖三条切割禁令 —— 跨段就会改变语义的构造一律不切：
 *  1. 围栏代码块（``` / ~~~）内不切：正文会被当成代码或反之；
 *  2. $$ 块级公式内不切：公式体会被拆碎；
 *  3. 空行后紧跟列表项不切（松散列表被拆成两段）、空行前是引用行不切
 *     （callout 的 coFollow 染色跨组生效）。连续多个空行也不切
 *     （「连着的第二个空行」在 parse 里会合成空段落块，切开后会丢）。 */
export function splitParseChunks(md, target = 512 * 1024) {
  if (md.length <= target + (target >> 1)) return [md];
  const lines = md.split('\n');
  const chunks = [];
  let segStart = 0;
  let segChars = 0;
  let fence = null;        // { ch, n } 当前开启的围栏
  let inMath = false;      // $$ 块级公式是否开启
  let lastBlank = -1;      // 段内最近一个空行的下标
  let blankRun = 0;
  let prevQuote = false;   // 上一非空行是否引用行
  const isListLine = (l) => RE_TASK.test(l) || RE_UL.test(l) || RE_OL.test(l);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.n) fence = null;
      continue;
    }
    if (inMath) {
      if (/\$\$\s*$/.test(line)) inMath = false;
      continue;
    }
    const fo = line.match(RE_FENCE);
    if (fo) { fence = { ch: fo[1][0], n: fo[1].length }; lastBlank = -1; continue; }
    if (/^\s*\$\$/.test(line)) {
      if (!/\$\$\s*$/.test(line.replace(/^\s*\$\$/, '')) || line.replace(/^\s*\$\$/, '').trim() === '') inMath = true;
      lastBlank = -1; continue;
    }
    if (/^\s*$/.test(line)) { blankRun++; lastBlank = i; segChars++; continue; }
    /* 站上空行后的第一个非空行：这里是唯一合法的切点 */
    if (segChars >= target && blankRun === 1 && lastBlank > segStart && !isListLine(line) && !prevQuote) {
      chunks.push(lines.slice(segStart, lastBlank).join('\n'));
      segStart = lastBlank;
      segChars = 0;
    }
    blankRun = 0;
    prevQuote = RE_QUOTE.test(line);
    segChars += line.length + 1;
  }
  chunks.push(lines.slice(segStart).join('\n'));
  return chunks;
}

/** 解析整篇 Markdown 为块节点，返回 DocumentFragment */
export function parseMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const frag = document.createDocumentFragment();
  const levelOf = makeLevelTracker();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(RE_FENCE);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !(new RegExp(`^\\s*${marker}{3,}\\s*$`)).test(lines[i])) body.push(lines[i++]);
      i++;
      levelOf.reset();
      frag.appendChild(mkCode(body.join('\n'), lang));
      continue;
    }

    // 块级公式 $$ … $$：吃成**一个块**。拆成三个普通段落的话，
    // 在富文本里过一遍再存盘，$$ 和公式之间就会多出空行。
    if (/^\s*\$\$/.test(line)) {
      levelOf.reset();
      const rest = line.replace(/^\s*\$\$/, '');
      const same = rest.match(/^([\s\S]*?)\$\$\s*$/);
      if (same) {
        frag.appendChild(mkMath(same[1], true));
        i++;
        continue;
      }
      const buf = [rest];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^([\s\S]*?)\$\$\s*$/);
        if (m) { buf.push(m[1]); i++; break; }
        buf.push(lines[i]);
        i++;
      }
      frag.appendChild(mkMath(buf.join('\n').trim()));
      continue;
    }

    // 空行：只作块间分隔，不生成空段落。
    // 原来每个空行都造一个空段落块，于是标题和分割线之间凭空多一行，
    // 在那一行按退格又会并进上面的标题（光标留在标题里，越删越乱）。
    // 现在只有「连着的第二个及以后」的空行才合成一个空段落——那是用户真按了两次回车。
    if (/^\s*$/.test(line)) {
      levelOf.reset();
      let n = 0;
      while (i < lines.length && /^\s*$/.test(lines[i])) { n++; i++; }
      for (let k = 1; k < n && frag.childNodes.length; k++) frag.appendChild(mkPara(''));
      continue;
    }

    // 分割线
    if (RE_HR.test(line)) {
      levelOf.reset();
      frag.appendChild(mkHr());
      i++;
      continue;
    }

    // 标题
    const h = line.match(RE_HEADING);
    if (h) {
      levelOf.reset();
      /* 空标题原地降级为正文（原先是载入后 normalize(true) 统一做的；
         跳过全量扫描后这职责挪到 parse —— 构造出规范 DOM 才敢跳过扫描） */
      frag.appendChild(h[2].trim() === '' ? mkPara('') : mkHeading(h[1].length, h[2]));
      i++;
      continue;
    }

    // 表格：本行含 |，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(parseAlign);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      levelOf.reset();
      frag.appendChild(mkTableFromData(head, aligns, rows));
      i = j;
      continue;
    }

    // 引用（支持 > > 嵌套）；首行 [!info] 标记升级为提示块
    const q = line.match(RE_QUOTE);
    if (q) {
      const level = Math.min(MAX_INDENT, q[1].replace(/\s/g, '').length - 1);
      let rest = q[2];
      let callout = '';
      let coTitle = '';
      const cm = rest.match(RE_CALLOUT);
      if (cm) {
        callout = normalizeCallout(cm[1]);
        coTitle = cm[2].trim();
        rest = '';
      }
      levelOf.reset();
      const qb = mkQuote(rest, Math.max(0, level), callout, coTitle);
      // 空行断组：上一块是引用、但紧邻的上一行不是引用行 → 这是新的独立引用，
      // 打 bqStart。没有它，两条独立引用在 DOM 里和一条引用的续行无法区分，
      // 视觉上连成一框，存盘还会并成一段
      const lastEl = frag.lastElementChild;
      if (lastEl && lastEl.dataset && lastEl.dataset.type === 'bq'
        && !(i > 0 && RE_QUOTE.test(lines[i - 1]))) qb.dataset.bqStart = '1';
      frag.appendChild(qb);
      i++;
      continue;
    }

    // 任务列表
    const task = line.match(RE_TASK);
    if (task) {
      frag.appendChild(mkLi('task', task[3], levelOf(leadingCols(task[1])), task[2].toLowerCase() === 'x'));
      i++;
      continue;
    }

    // 无序列表
    const ul = line.match(RE_UL);
    if (ul) {
      frag.appendChild(mkLi('ul', ul[2], levelOf(leadingCols(ul[1]))));
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(RE_OL);
    if (ol) {
      frag.appendChild(mkLi('ol', ol[3], levelOf(leadingCols(ol[1])), false, parseInt(ol[2], 10) || 1));
      i++;
      continue;
    }

    // 普通段落
    levelOf.reset();
    frag.appendChild(mkPara(line.replace(/\s+$/, '')));
    i++;
  }

  if (!frag.firstElementChild) frag.appendChild(mkPara(''));

  // 提示块的续行：callout 头行后面连着的普通引用行 = 同一个框的正文。
  // 打上 coFollow 标记（纯视觉染色），序列化只认 data-callout，不会写重 [!x]
  const kids = [...frag.children];
  for (let k = 0; k < kids.length; k++) {
    const el = kids[k];
    if (!el.dataset || el.dataset.type !== 'bq' || !el.dataset.callout) continue;
    for (let m = k + 1; m < kids.length; m++) {
      const s = kids[m];
      if (!s.dataset || s.dataset.type !== 'bq' || s.dataset.callout) break;
      s.dataset.coFollow = el.dataset.callout;
    }
  }
  return frag;
}

/* ============================================================
 * 块 -> Markdown
 * ============================================================ */

function tableToMarkdown(block) {
  const table = block.querySelector('table');
  if (!table) return [];
  const rows = [...table.querySelectorAll('tr')];
  const cols = rows.length ? rows[0].children.length : 0;
  const aligns = (table.dataset.aligns || '').split(',').slice(0, cols);
  /* 空单元格里的 <br> 是光标占位，不是内容 —— 只有格子里真有文字才写 <br> */
  const cellText = (c) => {
    const hasText = (c.textContent || '').replace(/[\u200b\s]/g, '') !== '';
    return (hasText ? inlineToMd(c, '<br>') : '').replace(/\|/g, '\\|');
  };
  const line = (cells) => '| ' + cells.join(' | ') + ' |';

  const out = [];
  out.push(line([...rows[0].children].map(cellText)));
  out.push('| ' + Array.from({ length: cols }, (_, i) => {
    const a = aligns[i] || '';
    if (a === 'center') return ':---:';
    if (a === 'right') return '---:';
    if (a === 'left') return ':---';
    return '---';
  }).join(' | ') + ' |');
  for (const r of rows.slice(1)) out.push(line([...r.children].map(cellText)));
  return out;
}

/* 代码块里的文本：<br> 还原成换行（textContent 会丢掉 <br>）。
   真正的实现搬到 codehilite.js —— 高亮分词要按「同一份文本」算偏移，
   两处各写一遍迟早漂移。这里留个别名，调用点不用改。 */
const codeToText = codeText;

/* 写剪贴板统一走 clipboard.js（离屏 textarea + execCommand('copy')）。
   以前这里有一份同样的实现，另一处在标签右键；两份迟早漂移，而且标签右键那份
   用的是 WebView2 里会抛错的 navigator.clipboard.writeText。 */

/**
 * 换块类型时要搬的那段文字 —— 取 **Markdown 源**，不是 textContent。
 * 用 textContent 会把 `**加粗**` 退成纯字、把 `[链接](url)` 退成标题，
 * 换一次类型等于把行内格式悄悄削掉一层。
 * 代码块与公式里的换行由 <br> 表示，交给 codeToText 还原成 \n。
 */
function blockMarkdownText(el) {
  const type = el.dataset.type || 'p';
  if (type === 'code') return codeToText(el.querySelector('.w-code') || el);
  if (type === 'math') return codeToText(el.querySelector('.w-tex') || el);
  const body = inlineToMd(el.querySelector('.w-text') || el);
  /* 提示块的标题存在 data-callout-title 里、不在正文，换类型时得一起搬走，
     否则「> [!info] 我的标题」转成代码块会变成一个空块 —— 用户写的字就没了 */
  const title = type === 'bq' ? el.dataset.calloutTitle || '' : '';
  if (!title) return body;
  return body ? title + '\n' + body : title;
}

/**
 * 单个块的「原始序列化」：只依赖块自身（文本 + data-*），不含列表标记/缩进
 * 列宽（那要跟着前文走）、也不含块间空行（那要看邻居类型）。
 * 这两样在 assemble 阶段现算 —— 所以缓存可以放心按块失效。
 */
function rawBlock(el) {
  const type = el.dataset.type || 'p';

  if (type === 'hr') return { type, lines: ['---'] };
  if (type === 'table') return { type, lines: tableToMarkdown(el) };

  if (type === 'code') {
    const text = codeToText(el.querySelector('.w-code') || el);
    return { type, lines: ['```' + (el.dataset.lang || ''), text, '```'] };
  }

  if (type === 'math') {
    // $$ 由这里补回去：块里只存裸 TeX，粘贴/编辑都不会把定界符弄丢
    const text = codeToText(el.querySelector('.w-tex') || el);
    if (el.dataset.mathInline === '1' && !text.includes('\n')) {
      return { type, lines: ['$$' + text + '$$'] };
    }
    return { type, lines: ['$$', text, '$$'] };
  }

  const t = el.querySelector('.w-text') || el;
  const text = inlineToMd(t);

  if (/^h[1-6]$/.test(type)) {
    return { type, lines: ['#'.repeat(+type[1]) + ' ' + text] };
  }
  if (type === 'li') {
    // 标记与缩进列宽依赖前文（cols），组装时再拼
    return { type, text };
  }
  if (type === 'bq') {
    const depth = (+el.dataset.indent || 0) + 1;
    const prefix = '> '.repeat(depth);
    const co = el.dataset.callout || '';
    if (co) {
      // 标记行 + 正文行：> [!info] 标题 / > 正文
      const title = el.dataset.calloutTitle || '';
      const lines = [prefix + `[!${co}]` + (title ? ` ${title}` : '')];
      if (text.trim()) lines.push(prefix + text);
      return { type, lines, co: true };
    }
    return { type, lines: [prefix + text], bqStart: !!el.dataset.bqStart };
  }
  return { type, lines: [text] };
}

/**
 * 块的序列化指纹：覆盖序列化会读取的全部输入。
 * - dataset：type/indent/num/list/checked/start/lang/callout/calloutTitle/
 *   bqStart/mathInline —— 前缀、标记全从这里来（aligns 在内层 table 上，单取）
 * - textContent：正文文字
 * - 行内标签结构：<code>/<strong>/<em>/<del>/<a>/<img>/<br> 的数量与图片
 *   地址、alt —— **粗** 和 \`码\` 的 textContent 完全相同，只看文字会漏
 * 组装时逐块校验，不符就重算该块 —— 这是增量缓存的唯一正确性依据。
 * 成本：每块一次 querySelectorAll（C++ 子树遍历），整篇相当于一次全文扫描；
 * 纯文本块（段落/标题的常态，万块级文档里占绝大多数）走 childNodes 快路径跳过它。
 */
const SIG_TAGS = 'code,strong,em,del,mark,b,i,strike,a,img,br';

function blockSig(el) {
  const ds = el.dataset;
  let s = (ds.type || '') + '|' + (ds.indent || '') + '|' + (ds.num || '') + '|'
    + (ds.list || '') + '|' + (ds.checked || '') + '|' + (ds.start || '') + '|'
    + (ds.lang || '') + '|' + (ds.callout || '') + '|' + (ds.calloutTitle || '') + '|'
    + (ds.bqStart || '') + '|' + (ds.mathInline || '');
  if (ds.type === 'table') {
    const table = el.querySelector('table');
    s += '|al' + (table ? table.dataset.aligns || '' : '');
  }
  const t = el.querySelector('.w-text') || el;
  if (t !== el) s += '|wt' + t.childNodes.length;
  // 快路径：正文里只有纯文本节点 → 不存在任何行内标签/图片，直接出签名
  let simple = true;
  for (const n of t.childNodes) { if (n.nodeType !== 3) { simple = false; break; } }
  if (simple) return s + '\u0001' + el.textContent;
  const counts = {};
  for (const n of t.querySelectorAll(SIG_TAGS)) {
    const k = n.tagName;
    counts[k] = (counts[k] || 0) + 1;
    if (k === 'IMG') s += '|' + (n.getAttribute('data-src') || '') + '#' + (n.getAttribute('alt') || '') + '@' + (n.getAttribute('width') || '');
  }
  for (const k in counts) s += '|' + k + counts[k];
  return s + '\u0001' + el.textContent;
}

/**
 * 编辑视图 DOM -> Markdown。
 *
 * cache（WeakMap，块 -> { sig, ...raw }）是编辑器的增量通道：组装时逐块
 * 校验签名，只有变过的块重新序列化。不传 cache 就全量现算 —— 行为与
 * 逐块现算完全一致，只是省掉重复劳动。
 *
 * 组装（块间空行、列表缩进列宽、首尾空行修剪）永远全量现算：
 * 这些依赖邻居与上下文，成本只是逐块读类型，量级远小于序列化本身。
 */
export function blocksToMarkdown(root, cache = null) {
  const chunks = [];
  // 列表缩进按 CommonMark 的「列」算：子项要缩进到父项正文所在的列
  // （"- " 占 2 列、"1. " 占 3 列、" - [ ] " 占 6 列），这样交给任何渲染器都不会散架
  const cols = [];

  for (const el of root.children) {
    const sig = blockSig(el);
    let entry = cache ? cache.get(el) : null;
    if (!entry || entry.sig !== sig) {
      entry = rawBlock(el);
      entry.sig = sig;
      if (cache) cache.set(el, entry);
    }
    const c = entry;
    const type = c.type;

    if (type === 'li') {
      const kind = el.dataset.list || 'ul';
      const lvl = Math.min(+el.dataset.indent || 0, MAX_INDENT);
      cols.length = lvl + 1;
      const base = lvl === 0 ? 0 : (cols[lvl - 1] ?? lvl * 2);
      const marker = kind === 'ol'
        ? `${el.dataset.num || 1}. `
        : kind === 'task'
          ? `- [${el.dataset.checked === '1' ? 'x' : ' '}] `
          : '- ';
      chunks.push({ type, lines: [' '.repeat(base) + marker + c.text] });
      cols[lvl] = base + marker.length;
    } else {
      chunks.push(c);
      cols.length = 0;
    }
  }

  // 块之间要不要空行：列表项之间、连续引用之间必须紧凑（空行会变成 loose list、
  // 或者把一段引用拆成两段），其余块之间补一个空行 —— Markdown 靠它断块。
  // 例外：引用后面跟的是**提示块**时必须断开 —— 不然两个 [!xx] 标记会进同一段
  // 引用，预览里第二个标记变成普通文字，往返一次就丢了类型；
  // 带 bqStart 的引用是空行断出来的独立条目，也要断开
  const tight = (a, c) => (a === 'li' && c.type === 'li')
    || (a === 'bq' && c.type === 'bq' && !c.co && !c.bqStart);
  const lines = [];
  let prev = null;
  for (const c of chunks) {
    // 空段落本身就是一行空行，别再额外补一行（否则两个空行越攒越多）
    const isBlankBlock = c.lines.length === 1 && c.lines[0] === '';
    if (lines.length && prev && !tight(prev, c) && !isBlankBlock) lines.push('');
    lines.push(...c.lines);
    prev = c.type;
  }
  // 首尾空行在 Markdown 里没有意义，顺手去掉（编辑器里仍可留空段落当落脚点）。
  // 开头那个空段落尤其要清掉：把标题文字删光后它会留在最前面，存盘就多出两行空行。
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

/* ============================================================
 * 大文档：块记录（模型）+ 视口渲染
 *
 * 10MB 级文档一次建 7.8 万个 DOM 块，代价并不在插入（bulk 148ms），而在
 * 「parse 时逐块 createElement + innerHTML」和「整树样式结算」。所以大文档
 * 不再整篇进 DOM：先扫成轻量记录（只存原文切片），DOM 里永远只保留视口
 * 附近几十个块，滚动时窗口搬家、用 padding 顶出剩余高度。
 *
 * 记录里的 md 就是**原文切片**，不重写用户的文件：载入 → 序列化往返
 * 天然逐字节一致，省掉整篇重新拼装的时间。
 * ============================================================ */

/** 块的估计高度（未实测时用）。只影响滚动条长度与跳转定位，
 *  真正渲染过之后会被实测值替代。 */
function estimateH(r) {
  const nl = r.nl || 0;
  if (r.type === 'code') return 22 * (nl + 1) + 44;
  if (r.type === 'table') return 34 * (nl + 1);
  if (r.type === 'hr') return 30;
  if (r.type === 'math') return 24 * (nl + 1) + 16;
  const len = r.type === 'li' ? ((r.li && r.li.text) || '').length : (r.md ? r.md.length : 0);
  const wraps = Math.max(1, Math.ceil(len / 44));
  return wraps * 26 + 12;
}

/** 围栏收尾行：同字符、≥3 个、整行只有它 */
const isFenceClose = (l, ch) => {
  const t = l.trim();
  if (!t || t.charCodeAt(0) !== ch.charCodeAt(0)) return false;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) !== ch.charCodeAt(0)) return false;
  return t.length >= 3;
};

/**
 * Markdown -> 块记录数组（不建 DOM）。
 * 扫描顺序与 parseMarkdown 完全一致：围栏 → $$ → hr → 标题 → 表格 → 引用
 * → 任务/无序/有序 → 段落；空行只累计成块间隔。
 * 每行先做一次首字符判定再进正则 —— 18 万行 × 8 条正则的级联是载入期
 * 最贵的一笔开销，绝大多数行一条都不该跑。
 */
function parseRecords(md) {
  const src = String(md).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const recs = [];
  const levelOf = makeLevelTracker();
  let i = 0;
  let gap = 0;                      // 距上一块的空行数

  const push = (rec, lineNo) => {
    if (recs.length) recs[recs.length - 1].gap = gap;
    gap = 0;
    rec.line = lineNo;
    rec.nl = 0;
    if (rec.type !== 'li') levelOf.reset();
    recs.push(rec);
  };

  while (i < lines.length) {
    const raw = lines[i];
    /* 空行：只记账。行首空白用码点判断，省掉一次 trim() 分配 */
    let k = 0;
    const len = raw.length;
    while (k < len) { const ch = raw.charCodeAt(k); if (ch !== 32 && ch !== 9) break; k++; }
    if (k === len) { gap++; i++; continue; }

    const c = raw.charCodeAt(k);
    const lineNo = i;

    /* ``` / ~~~ 围栏代码块 */
    if (c === 96 || c === 126) {
      const f = raw.match(RE_FENCE);
      if (f) {
        const from = i;
        const marker = f[1][0];
        i++;
        while (i < lines.length && !isFenceClose(lines[i], marker)) i++;
        if (i < lines.length) i++;
        const rec = { type: 'code', md: lines.slice(from, i).join('\n'), lang: f[2] || '' };
        rec.nl = i - from - 1;
        push(rec, lineNo);
        continue;
      }
    }

    /* $$ 块级公式：吃成一个块，和 parseMarkdown 一致 */
    if (c === 36 && raw.startsWith('$$', k)) {
      const from = i;
      const rest = raw.slice(k + 2);
      if (/^([\s\S]*?)\$\$\s*$/.test(rest)) {
        i++;
      } else {
        i++;
        while (i < lines.length) {
          if (/^([\s\S]*?)\$\$\s*$/.test(lines[i])) { i++; break; }
          i++;
        }
      }
      const rec = { type: 'math', md: lines.slice(from, i).join('\n') };
      rec.nl = i - from - 1;
      push(rec, lineNo);
      continue;
    }

    /* 分割线（必须先于列表判定：`---` 也是主题目里最容易被误判的一行） */
    if ((c === 45 || c === 42 || c === 95) && RE_HR.test(raw)) {
      push({ type: 'hr', md: raw.replace(/\s+$/, '') }, lineNo);
      i++;
      continue;
    }

    /* 标题 */
    if (c === 35) {
      const h = raw.match(RE_HEADING);
      if (h) {
        /* 空标题原地降级为正文（与 parseMarkdown 同规则） */
        const empty = h[2].trim() === '';
        push({ type: empty ? 'p' : 'h' + h[1].length, md: empty ? '' : raw.replace(/\s+$/, '') }, lineNo);
        i++;
        continue;
      }
    }

    /* 表格：本行含 |，下一行是分隔行 */
    if (raw.indexOf('|') >= 0 && i + 1 < lines.length && lines[i + 1].indexOf('-') >= 0
      && RE_TABLE_SEP.test(lines[i + 1])) {
      const from = i;
      let j = i + 2;
      while (j < lines.length && lines[j].indexOf('|') >= 0 && !/^\s*$/.test(lines[j])) j++;
      i = j;
      const rec = { type: 'table', md: lines.slice(from, i).join('\n') };
      rec.nl = i - from - 1;
      push(rec, lineNo);
      continue;
    }

    /* 引用 / 提示块 */
    if (c === 62) {
      const q = raw.match(RE_QUOTE);
      if (q) {
        const level = Math.min(MAX_INDENT, q[1].replace(/\s/g, '').length - 1);
        const rest = q[2];
        const cm = rest.match(RE_CALLOUT);
        const rec = { type: 'bq', md: raw.replace(/\s+$/, ''), indent: Math.max(0, level) };
        if (cm) {
          rec.callout = normalizeCallout(cm[1]);
          rec.calloutTitle = cm[2].trim();
        }
        /* 空行断组的独立引用才打 bqStart —— 判据与 parseMarkdown 相同 */
        const prev = recs[recs.length - 1];
        if (prev && prev.type === 'bq' && !(i > 0 && RE_QUOTE.test(lines[i - 1]))) rec.bqStart = 1;
        push(rec, lineNo);
        i++;
        continue;
      }
    }

    /* 任务列表 / 无序 / 有序 */
    if (c === 45 || c === 42 || c === 43 || (c >= 48 && c <= 57)) {
      const task = raw.match(RE_TASK);
      if (task) {
        push({
          type: 'li', md: raw.replace(/\s+$/, ''),
          li: { kind: 'task', indent: levelOf(leadingCols(task[1])), checked: task[2].toLowerCase() === 'x', text: task[3], num: 1 },
        }, lineNo);
        i++;
        continue;
      }
      const ul = raw.match(RE_UL);
      if (ul) {
        push({
          type: 'li', md: raw.replace(/\s+$/, ''),
          li: { kind: 'ul', indent: levelOf(leadingCols(ul[1])), text: ul[2], num: 1 },
        }, lineNo);
        i++;
        continue;
      }
      const ol = raw.match(RE_OL);
      if (ol) {
        push({
          type: 'li', md: raw.replace(/\s+$/, ''),
          li: { kind: 'ol', indent: levelOf(leadingCols(ol[1])), text: ol[3], num: parseInt(ol[2], 10) || 1, start: parseInt(ol[2], 10) || 1 },
        }, lineNo);
        i++;
        continue;
      }
    }

    /* 普通段落：一行一块 */
    push({ type: 'p', md: raw.replace(/\s+$/, '') }, lineNo);
    i++;
  }

  if (!recs.length) recs.push({ type: 'p', md: '', gap: 0, line: 0, nl: 0 });
  /* 提示块续行：callout 头行后面紧跟的普通引用行属于同一个框（纯视觉染色）。
     规则与 parseMarkdown 尾部那段一致：遇非引用块或下一个 callout 就断。 */
  let co = '';
  for (const r of recs) {
    if (r.type !== 'bq') { co = ''; continue; }
    if (r.callout) { co = r.callout; continue; }
    if (co) r.coFollow = co;
  }
  return recs;
}

/** 记录数组 -> Markdown（列表缩进列宽与前文相关，逐块推进） */
function recordsToMd(recs) {
  const out = [];
  const cols = [];
  for (const r of recs) {
    if (r.type === 'li' && r.li) {
      const lvl = Math.min(r.li.indent || 0, MAX_INDENT);
      cols.length = lvl + 1;
      const base = lvl === 0 ? 0 : (cols[lvl - 1] ?? lvl * 2);
      const marker = r.li.kind === 'ol'
        ? `${r.li.num || 1}. `
        : r.li.kind === 'task'
          ? `- [${r.li.checked ? 'x' : ' '}] `
          : '- ';
      out.push(' '.repeat(base) + marker + r.li.text);
      cols[lvl] = base + marker.length;
    } else {
      out.push(r.md || '');
      cols.length = 0;
    }
    for (let g = 0; g < (r.gap || 0); g++) out.push('');
  }
  return out.join('\n');
}

/** 记录数组 → markdown 原文（trail：原文结尾有没有换行，见 _render 的说明） */
function serializeRecs(recs, trail) {
  let md = recordsToMd(recs);
  if (trail && md && !md.endsWith('\n')) md += '\n';
  return md;
}

/** 相邻两块之间要不要空行（同列表项、同组引用不空） */
const sameLi = (a, b) => a === b || (!!a && !!b && a.kind === b.kind
  && a.indent === b.indent && a.num === b.num && a.start === b.start
  && a.checked === b.checked && a.text === b.text);
/** 两条记录的逻辑内容是否相同（高度缓存 h、DOM 引用不参与） */
const sameRec = (a, b) => a.md === b.md && a.type === b.type && a.nl === b.nl
  && a.gap === b.gap && a.callout === b.callout
  && a.bqStart === b.bqStart && a.coFollow === b.coFollow && sameLi(a.li, b.li);

const gapBetween = (a, b) => ((a.type === 'li' && b.type === 'li')
  || (a.type === 'bq' && b.type === 'bq' && !b.callout && !b.bqStart)) ? 0 : 1;

/** 列表项的 md 切片（物化时喂给 parseMarkdown；缩进按层级写足） */
const liMd = (li) => ' '.repeat(Math.max(0, Math.min(li.indent || 0, MAX_INDENT)) * 2)
  + (li.kind === 'ol' ? `${li.num || 1}. ` : li.kind === 'task' ? `- [${li.checked ? 'x' : ' '}] ` : '- ')
  + (li.text || '');

/* ============================================================
 * DOM / 光标工具
 * ============================================================ */

const textEl = (block) => block.querySelector('.w-text') || block;

/**
 * 元素内第一个 / 最后一个文本节点。
 * 选区的边界要落在**文本节点**上，不能落在元素上：元素边界（`(el, 0)`）看起来
 * 是同一个位置，但 Chromium 在「已选中一个内联元素」之后再执行全选会把选区
 * 整块吃掉（见 handleKey 里 Ctrl+A 的实测记录）。
 */
function firstTextNode(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return w.nextNode();
}

function lastTextNode(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  let n;
  while ((n = w.nextNode())) last = n;
  return last;
}


function placeCaret(node, offset = 0) {
  const sel = window.getSelection();
  const r = document.createRange();
  try { r.setStart(node, offset); } catch { r.selectNodeContents(node); }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function offsetIn(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.endContainer)) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

/**
 * 字符偏移 → (文本节点, 节点内偏移)。`setCaretOffset` 和「按视觉 x 落到某一行」
 * 都要这个换算，只许有一份实现：两处各写一份 walker，迟早有一处漏掉零宽空格
 * 或 `<br>` 占位，光标就偏一个字符。返回 null 表示宿主里一个文本节点都没有。
 */
function caretPoint(el, offset) {
  let left = Math.max(0, offset);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let last = null;
  while (node) {
    const len = node.nodeValue.length;
    if (left <= len) return { node, offset: left };
    left -= len;
    last = node;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.nodeValue.length } : null;
}

function setCaretOffset(el, offset) {
  const p = caretPoint(el, offset);
  if (p) { placeCaret(p.node, p.offset); return; }
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

const isEmptyText = (el) => el.textContent.replace(/\u200b/g, '').trim() === '';

function ensurePlaceholder(el) {
  if (isEmptyText(el) && !el.querySelector('img')) el.innerHTML = '<br>';
}

/* ============================================================
 * 编辑器
 * ============================================================ */

export class WysiwygEditor {
  constructor(root, opts = {}) {
    this.root = root;
    this.onChange = opts.onChange || (() => {});
    /* 剪贴板里是图片时交给外层落盘（wysiwyg 不碰磁盘，也不认识 Tauri）。
       返回 Promise，完成后自己把图片插进来，所以这里只管转交。 */
    this.onPasteImage = opts.onPasteImage || null;
    /* Ctrl/⌘ + 点击链接：打开它。不按修饰键时仍然是「把光标放进去好改文字」 */
    this.openLink = opts.openLink || null;
    this.silent = false;
    this.composing = false;
    // 新文档默认按「以换行结尾」存（POSIX 惯例），载入文件时再按实际内容修正
    this.trailingNewline = true;
    this.history = [];
    this.hIndex = -1;
    this.hLast = 0;
    this.hBytes = 0;
    this.hCoalesce = true;
    // 菜单/工具栏点击时焦点可能暂时离开编辑区，记住最后所在块以保持命令有目标
    this.lastBlock = null;
    this.lastCell = null;

    /* ---- 增量序列化 ----
       每次击键都要把整篇 DOM 写回 Markdown，大文档（万行级）下这是卡顿的
       最大来源。方案：块内容序列化按块缓存（WeakMap，块 -> { sig, ...raw }），
       sig 是序列化全部输入的廉价指纹（dataset + textContent + br/img 计数）。
       组装时逐块校验签名，不符就地重算 —— 正确性只依赖这个校验，
       不依赖任何事件回调（MutationObserver 在实测中会漏记录，不可信）。 */
    this.mdCache = new WeakMap();
    this.loading = false;     // 大文档分块插入期间为 true，输入一律不响应
    this.onProgress = opts.onProgress || null;
    this._flushTimer = 0;     // 输入路径的延迟序列化（见 queueFlush）
    /* 这块 DOM 归哪个标签。切标签后迟到的 flush 必须写回它自己的标签 ——
       只看 activeTab() 会把上一个文件的内容灌进刚打开的那个。 */
    this.ownerTabId = null;

    /* 「块后待插入」：带边界的块末尾按 → / ↓ 出块时，方向键**不改文档**，
       只把「这一块后面还缺一行」记在这里。等用户真的按回车或开始输入，
       才把那个空段落建出来（见 materializeGap）。一次性：任何光标移动、
       快捷键、失焦、重渲染都把它清掉，绝不残留到别的操作上。
       读写一律走 setGapAfter() / clearGapAfter()，好让那条「插入指示线」
       和状态同生共死 —— 以前是散落的赋值，漏一处线就会赖在屏幕上。 */
    this.gapAfter = null;
    this.gapHint = null;

    /* ---- 视口渲染（仅超大文档启用，见 _render 的分流） ----
       records 是块的唯一真相（每项存 md 原文切片），root.children 只是
       视口附近那一小段窗口。滚动时窗口搬家，剩余高度用 padding 顶出来。 */
    this.virtual = false;
    this.records = null;
    this.winStart = 0;
    this.winCount = 0;
    this.cum = null;          // 记录高度的前缀和（滚动定位用）
    this._cumDirty = true;    // 块高被实测修正/结构增删后置脏，见 _rebuildCum
    this.padTop = 0;
    this._vLock = false;      // 防止「调整 scrollTop → 再触发滚动」自激
    /* 视口模式下的「逻辑全选」：Ctrl+A 的语义是整篇文档，但 DOM 里只有窗口
       那几十块 —— 让浏览器原生全选就等于「只选了窗口」，随后打字会把窗口外的
       内容当成「未选中」删掉（实测 10MB 文档一次丢 47 块）。所以这里自己标记
       全文已选，编辑动作改由模型层整篇替换。 */
    this._selAll = false;

    /* 拖选期间（按下左键到松开）窗口只许变长、不许搬家：搬家会 replaceChildren
       掉锚点所在的节点，浏览器随即丢掉整个选区 —— 跨屏拖选等于白拖。 */
    this._drag = false;
    root.addEventListener('pointerdown', (e) => { if (e.button === 0) this._drag = true; }, true);
    const endDrag = () => { this._drag = false; };
    document.addEventListener('pointerup', endDrag, true);
    document.addEventListener('pointercancel', endDrag, true);
    window.addEventListener('blur', endDrag);

    /* 出块期间那条常驻插入线钉在块的底边上，滚动后要跟着走；块被窗口化
       重铺掉时 syncGapHint() 自己会把它藏起来。 */
    root.addEventListener('scroll', () => { this._onVirtualScroll(); this.syncGapHint(); }, { passive: true });
    root.addEventListener('input', () => this.onInput());
    root.addEventListener('keydown', (e) => this.handleKey(e));
    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));
    root.addEventListener('compositionstart', () => {
      this.composing = true;
      /* 中文输入法起手也是「要输入了」：先把块后那一行建出来，组字文本
         才会落在它里面，而不是写进下一块的正文。 */
      if (this.gapAfter) this.materializeGap();
    });
    root.addEventListener('compositionend', () => { this.composing = false; this.onInput(); });
    root.addEventListener('paste', (e) => this.handlePaste(e));
    /* 失焦只在真有未落账的编辑时才 flush。没编辑过也 flush 的话，序列化的
       规范化写法（* → - 之类）会经 onChange 写进 tab.content —— 用户一个字
       没动，标签却亮脏标记，只能靠保存一次才消掉。 */
    root.addEventListener('blur', () => { this.clearGapAfter(); if (this.pending()) this.flush(); });
    root.addEventListener('click', (e) => this.handleClick(e));
    root.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    root.addEventListener('pointermove', (e) => this.hoverImgCorner(e));
    // 块尾插入指示线：鼠标移到最后一个块下方的空白处时出现，点击插入一行。
    // 线挂在滚动容器（root 父层，自带 position:relative）上 —— 不能挂进 root，
    // 块遍历/序列化都假定 root 的孩子全是 .w-block
    this.insertLine = document.createElement('div');
    this.insertLine.className = 'w-insert-line';
    (root.parentElement || root).appendChild(this.insertLine);
    /* 「块后待插入」的常驻提示：和 hover 插入线**必须**是两个元素。
       hoverInsertLine() 每次 pointermove 都可能 hideInsertLine()，共用一条线
       的话，用户出块后随手挪一下鼠标，提示就被擦掉了。 */
    this.gapHint = document.createElement('div');
    this.gapHint.className = 'w-gap-hint';
    const hintLine = document.createElement('span');
    hintLine.className = 'w-gap-hint-line';
    const hintLabel = document.createElement('span');
    hintLabel.className = 'w-gap-hint-label';
    hintLabel.dataset.i18n = '按 Enter 在此插入一行';
    hintLabel.textContent = tt('按 Enter 在此插入一行');
    this.gapHint.append(hintLine, hintLabel);
    (root.parentElement || root).appendChild(this.gapHint);
    root.addEventListener('pointermove', (e) => this.hoverInsertLine(e));
    root.addEventListener('mouseleave', () => this.hideInsertLine());
    root.addEventListener('dragstart', (e) => {
      // 图片别被浏览器原生拖走（拖出去会变成「把图拖到别的程序」），
      // 右下角改宽用的是自己的指针逻辑
      if (e.target && e.target.tagName === 'IMG') e.preventDefault();
    });
    root.addEventListener('dragover', (e) => e.preventDefault());
    root.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) return;
      e.preventDefault();
    });
    // 光标离开某个标题时，把它亮出来的 ### 收回去
    this._selMatchRaf = 0;
    this._onSelChange = () => { this.collapseHashes(); this.scheduleSelMatch(); };
    document.addEventListener('selectionchange', this._onSelChange);
    /* 代码块高亮：只在 DOM 真的变了才重算。输入、粘贴、撤销、render、
       视口搬家都会落到这里 —— 比在每个出口各挂一次可靠（少一处就少一次
       「有的路径高亮不刷新」的怪象）。它不碰 DOM，所以不会自激。 */
    this._codeObs = new MutationObserver(() => this.scheduleCodeHilite());
    this._codeObs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  /* 选中一段文字时，把文档里相同的文字一并标亮（selmatch.js，纯视图）。
     selectionchange 在拖选期间每帧都来，用 rAF 合并成一帧一次；整篇重渲染
     之后旧 Range 指向的节点已经被摘掉，必须当场清掉，否则灰底会残留。 */
  scheduleSelMatch() {
    if (this._selMatchRaf) return;
    this._selMatchRaf = requestAnimationFrame(() => {
      this._selMatchRaf = 0;
      updateSelMatch(this.root, window.getSelection());
    });
  }

  clearSelMatchNow() {
    if (this._selMatchRaf) { cancelAnimationFrame(this._selMatchRaf); this._selMatchRaf = 0; }
    clearSelMatch();
  }

  /**
   * 排一次代码块高亮重算。输入时每键都排，所以必须防抖 —— 分词 + 建 Range
   * 在长代码块上不是免费的；停手 120ms 后算一次，视觉上仍是「边打边上色」。
   * 大文档载入期间（loading）先让路，载完再来。
   */
  scheduleCodeHilite(delay = 120) {
    if (this._hlTimer) clearTimeout(this._hlTimer);
    this._hlTimer = setTimeout(() => {
      this._hlTimer = 0;
      if (this.loading) { this.scheduleCodeHilite(200); return; }
      refreshCode(this.root);
    }, delay);
  }

  /* ---------------- 公共 API ---------------- */

  /** 文档换了目录，图片相对路径要跟着换基准（渲染前调用） */
  setDocDir(dir) { docDir = dir || ''; }

  render(md, restore) {
    this.clearGapAfter();          // 整篇换掉，旧的「块后」位置已经没有意义
    this._render(md, restore);
    /* 撤销基线先用「源文本」顶上 —— 它就是盘上的真状态，不必为了基线把
       整篇 DOM 再序列化一遍（万行文档下那是秒级的无谓开销）。之后空闲时
       预热块缓存并核对一次：往返结果与源文本一致（绝大多数）就维持源文本；
       有出入（罕见的非规范写法被归一化）再换成往返结果，保证首次编辑的
       脏判定不错乱。 */
    if (this.virtual && this.records) {
      /* 视口模式的基线存记录快照：整篇文本是 8 万块的 12 MB 字符串，
         而快照只是记录数组的浅拷贝（块对象共享），620 KB 一份 */
      this.history = [{ recs: this.records.slice(), trail: this.trailingNewline, caret: null }];
      this.hBytes = snapSize(this.history[0]);
    } else {
      this.history = [{ md, caret: null }];
      this.hBytes = bytesOf(md);
    }
    this.hIndex = 0;
    this.hLast = 0;
    this.hCoalesce = false;
  }

  /* 空闲时把块序列化预热进缓存；全部热完后组装一次与源文本核对基线。 */
  _warmBaseline(srcMd) {
    clearTimeout(this._warmTimer);
    let i = 0;
    const kids = this.root.children;
    const step = () => {
      /* 用户已经动过手（或基线已被换掉）就别再抢：缓存在每次 flush 里
         本来就在增量维护，这里的预热只是锦上添花。 */
      if (this._edited || this.history[0].md !== srcMd) return;
      const end = Math.min(kids.length, i + 2000);
      for (; i < end; i++) {
        const el = kids[i];
        if (!this.mdCache.has(el)) this.mdCache.set(el, { ...rawBlock(el), sig: blockSig(el) });
      }
      if (i < kids.length) { this._warmTimer = setTimeout(step, 16); return; }
      const rt = blocksToMarkdown(this.root, this.mdCache);
      if (rt !== srcMd) {
        this.history[0] = { md: rt, caret: null };
        this.hBytes = bytesOf(rt);
      }
    };
    this._warmTimer = setTimeout(step, 300);
  }

  _render(md, restore) {
    /* render() 和撤销恢复都会走到这里，两条路都会把 root 的孩子整批换掉。
       「相同文本」的 Range 还指着被摘掉的节点，必须当场清，否则灰底残留。 */
    this.clearSelMatchNow();
    /* 记下原文有没有结尾换行：序列化只吐「行」，补不补最后那个 \n 得看原来的样子。
       不记的话每次编辑都会把文件的结尾换行吃掉，git 立刻给你一行
       "\ No newline at end of file"。
       空文档不改这个标记 —— 用户清空重写时不该顺手把文件的换行习惯改掉。 */
    if (md) this.trailingNewline = md.endsWith('\n');
    this.silent = true;
    this._edited = false;
    this._selAll = false;      // 重建后旧选区已不存在，全选标记随之作废
    clearTimeout(this._warmTimer);
    this.root.innerHTML = '';
    this._exitVirtual();
    this.lastBlock = null;
    this.lastCell = null;
    /* 大文档（>1MB）走视口渲染：块只存记录、DOM 里只留视口附近几十个。
       中小文档维持原路径（DOM 即模型），行为一字不变。 */
    if (md.length > BIG_DOC_CHARS) {
      this._renderVirtual(md, restore);
      return;
    }
    const frag = parseMarkdown(md);
    const total = frag.childNodes.length;
    this.root.appendChild(frag);
    /* 载入不再全量 normalize：parse 产出的 DOM 由构造函数保证规范
       （空标题的降级也挪进了 parse），逐块 sweep 在万行文档下纯属浪费。 */
    this.renumber();
    if (restore) this.restoreCaret(restore);
    /* 超大文档才开视口外跳渲染（cv:auto 在可编辑块上有选区副作用，见 CSS） */
    this.root.classList.toggle('cv-auto', total > BIG_DOC_BLOCKS);
    this.silent = false;
    this._warmBaseline(md);
  }

  async _renderProgressive(md, restore) {
    this.loading = true;
    /* 载入期间临时摘掉 contenteditable：编辑宿主里的每次 DOM 变异，
       Chromium 都要做选区/光标整理；摘掉后是纯 DOM 插入。
       cv-auto 同理只在非编辑宿主里生效。 */
    const ceRestore = this.root.contentEditable;
    this.root.contentEditable = 'false';
    this.root.classList.add('cv-auto');
    const gen = (this._loadGen = (this._loadGen || 0) + 1);
    try {
      const chunks = splitParseChunks(md);
      /* 首段小步快跑：parse + append + 让一帧，第一屏文字尽早可见 */
      this.root.appendChild(parseMarkdown(chunks[0]));
      if (this.onProgress) this.onProgress(0, 0);
      await nextFrame();
      if (gen !== this._loadGen) return;
      /* 其余段落：parse + bulk append，中途不让帧 —— 每让一帧就是一次
         全树样式重算（实测 200ms+），攒到最后只结一次账。
         任何一段 parse 出错都不能留下半截文档：退回整篇同步 parse。 */
      try {
        for (let k = 1; k < chunks.length; k++) {
          if (gen !== this._loadGen) return;
          this.root.appendChild(parseMarkdown(chunks[k]));
          if (this.onProgress) this.onProgress(k + 1, chunks.length);
        }
      } catch (err) {
        console.error(tt('[渐进载入] 分段 parse 失败，整篇重载'), err);
        if (gen !== this._loadGen) return;
        this.root.innerHTML = '';
        this.root.appendChild(parseMarkdown(md));
      }
      if (gen !== this._loadGen) return;
      this.renumber();
      if (restore) this.restoreCaret(restore);
    } finally {
      if (gen === this._loadGen) {                // 被新一轮载入接管时别动全局状态
        this.root.contentEditable = ceRestore;
        this.silent = false;
        this.loading = false;
        if (this.onProgress) this.onProgress(1, 1);
        this._warmBaseline(md);
      }
    }
  }

  /* ==================== 视口渲染（超大文档） ==================== */

  /** 退出视口模式：把 padding 与模型都清掉，回到「DOM 即模型」的老路径 */
  _exitVirtual() {
    this.virtual = false;
    this.records = null;
    this.cum = null;
    this.winStart = 0;
    this.winCount = 0;
    this.root.classList.remove('virtual');
    this.root.style.removeProperty('--vpad-top');
    this.root.style.removeProperty('--vpad-bot');
  }

  _renderVirtual(md, restore) {
    this.loading = true;
    this.root.classList.remove('cv-auto');
    try {
      this.records = parseRecords(md);
    } catch (err) {
      /* 记录扫描出岔子就退回渐进载入（整篇进 DOM），绝不留半截文档 */
      console.error(tt('[视口渲染] 记录扫描失败，退回整篇载入'), err);
      this.loading = false;
      this._renderProgressive(md, restore);
      return;
    }
    this.virtual = true;
    this.root.classList.add('virtual');
    this.winStart = 0;
    this.winCount = 0;
    this.cum = null;
    const startIdx = restore && restore.blockIndex != null ? Math.max(0, restore.blockIndex - 6) : 0;
    this._windowAt(startIdx, false);
    this._renumberVirtual();
    if (restore) this.restoreCaret(restore);
    this.loading = false;
    /* _render() 在开头把 silent 置真、在本体末尾复位；视口分支提前 return 了，
       必须在这里补回来。漏了它的后果不是「少一次优化」：onInput / flush 全部
       早退 → 编辑不进 tab.content、标签永不变脏、自动保存永远不写、撤销全空。 */
    this.silent = false;
  }

  /** 记录的高度前缀和（未实测的块用估计值）。
   *  纯依赖块高，窗口搬家不影响它 —— 用脏标记挡住滚动时的重复计算：
   *  十万级记录重算一次 3ms 出头，滚一下算一遍就等于白烧 20% CPU。 */
  _rebuildCum() {
    const n = this.records.length;
    if (!this.cum || this.cum.length !== n + 1) {
      this.cum = new Float64Array(n + 1);
      this._cumDirty = true;
    }
    if (!this._cumDirty) return this.cum[n];
    let s = 0;
    for (let i = 0; i < n; i++) {
      this.cum[i] = s;
      const r = this.records[i];
      s += r.h || estimateH(r);
    }
    this.cum[n] = s;
    this._cumDirty = false;
    return s;
  }

  /** 内容纵坐标 y 落在第几块（与 syncOutline 同源：单调，二分） */
  _indexAtY(y) {
    const n = this.records.length;
    let lo = 0;
    let hi = n - 1;
    let pick = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= y) { pick = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return pick;
  }

  /** 单条记录 -> DOM 块。单块 parse 看不到邻居，模型层的标注在这里补齐 */
  _materialize(rec) {
    let el = null;
    try {
      const src = rec.type === 'li' && rec.li ? liMd(rec.li) : (rec.md || '');
      el = parseMarkdown(src).firstElementChild;
    } catch {
      el = null;
    }
    if (!el) el = mkPara('');
    if (rec.type === 'li' && rec.li) {
      el.dataset.indent = String(Math.min(rec.li.indent || 0, MAX_INDENT));
      el.style.setProperty('--li-indent', el.dataset.indent);
      if (rec.li.kind === 'ol') el.dataset.num = String(rec.li.num || 1);
    }
    if (el.dataset.type === 'bq') {
      if (rec.bqStart) el.dataset.bqStart = '1'; else delete el.dataset.bqStart;
      if (rec.coFollow) el.dataset.coFollow = rec.coFollow;
      if (rec.bqTail) el.dataset.bqTail = '1'; else delete el.dataset.bqTail;
    }
    return el;
  }

  /** 视口高度。元素没被限高时 clientHeight 会等于内容高度（测试页/异常布局），
   *  拿它算窗口会把整篇都塞进 DOM —— 超出量级就退回默认值 */
  _viewportH() {
    const h = this.root.clientHeight;
    return h > 0 && h < 20000 ? h : 700;
  }

  /**
   * 把窗口搬到 startIdx：重建这一小段 DOM，实测高度，用 padding 顶出
   * 上下剩余空间。keepAnchor=true 时调整 scrollTop，保证视口里的画面不动。
   */
  _windowAt(startIdx, keepAnchor) {
    const n = this.records.length;
    const vh = this._viewportH();
    startIdx = Math.max(0, Math.min(startIdx, n - 1));
    /* padding 里编码的是**绝对文档偏移**（32 + 窗口前所有块的高度），
       所以同一个文档位置对应的 scrollTop 天生不变。只有一种情况会让画面
       跳动：窗口上方的块这次被实测、高度估计值被修正 → 前缀和变了。
       记下修正前的偏移，搬完再补这笔差。 */
    this._rebuildCum();
    const offBefore = this.cum[startIdx];

    /* 覆盖 4 屏：滚动时窗口不必每屏都搬家，且编辑到窗口边界附近时
       前后兄弟仍然在 DOM 里（合并/拆分要用）。上限 600 块兜底，
       防止极端行高下窗口无限膨胀 */
    const targetH = vh * 4;
    const MAX_WIN = 600;
    let end = startIdx;
    let h = 0;
    while (end < n && (h < targetH || end === startIdx) && end - startIdx < MAX_WIN) {
      h += this.records[end].h || estimateH(this.records[end]);
      end++;
    }

    const focused = this.root.contains(document.activeElement);
    const caret = focused ? this.caretState() : null;

    const nodes = new Array(end - startIdx);
    for (let i = startIdx, k = 0; i < end; i++, k++) {
      const rec = this.records[i];
      nodes[k] = this._materialize(rec);
    }
    this.winStart = startIdx;
    this.winCount = end - startIdx;
    this.root.replaceChildren(...nodes);
    this._measureWindow();
    this._applyPadding();
    /* 光标还在新窗口里才恢复 —— 在窗口外说明用户滚到别处看，别把他拽回去 */
    if (caret && caret.blockIndex >= startIdx && caret.blockIndex < end) {
      this.restoreCaret(caret);
      if (focused) this.root.focus({ preventScroll: true });
    }
    if (keepAnchor) {
      const delta = this.cum[startIdx] - offBefore;
      if (delta) {
        this._vLock = true;
        this.root.scrollTop += delta;
        this._vLock = false;
      }
    }
  }

  /** 实测量一遍窗口内块的高度（只读，不写样式，一次布局内完成） */
  _measureWindow() {
    this._measureFrom(0);
  }

  /** 只量窗口里从第 from 个孩子往后的块（续长窗口时只量新加的） */
  _measureFrom(from) {
    const kids = this.root.children;
    let changed = false;
    for (let i = from; i < kids.length; i++) {
      const r = this.records[this.winStart + i];
      if (!r) continue;
      const box = kids[i].getBoundingClientRect();
      /* 只在真变了才置脏：窗口里绝大多数块每趟实测都是同一个值，
         每次搬家都无条件作废前缀和等于把脏标记白写一遍 */
      if (box.height > 0 && box.height !== r.h) {
        r.h = box.height;
        changed = true;
      }
    }
    if (changed) this._cumDirty = true;
  }

  /** 用两个伪元素顶出窗口之外的内容高度。
   *  为什么不用 padding：clientHeight 含 padding，几百万像素的 padding 会把
   *  滚动容器本身撑高（box-sizing 一变就完全失效）；伪元素不参与
   *  root.children，块下标、firstElementChild 这些假定都还成立。 */
  _applyPadding() {
    this._rebuildCum();
    const n = this.records.length;
    const vh = this._viewportH();
    this.padTop = PAD_TOP + this.cum[this.winStart];
    const below = this.cum[n] - this.cum[this.winStart + this.winCount];
    this.root.style.setProperty('--vpad-top', Math.round(this.cum[this.winStart]) + 'px');
    this.root.style.setProperty('--vpad-bot', Math.round(below + vh * 0.4 + 24) + 'px');
  }

  _onVirtualScroll() {
    if (!this.virtual || this.loading || this._vLock || !this.records) return;
    if (this.root.classList.contains('hidden')) return;
    const vh = this._viewportH();
    this._rebuildCum();
    const y = this.root.scrollTop - PAD_TOP;
    const top = this._indexAtY(Math.max(0, y - vh * 0.3));
    const bot = this._indexAtY(Math.max(0, y + vh * 1.5));
    /* 视口仍稳稳落在窗口里就不动 —— 搬家本身要 parse 几十块（10ms 级），
       但会打断选区与滚动惯性，能少搬就少搬。
       判据是「窗口是否完整盖住 [top, bot]」：顶端不能要求 top > winStart，
       文档最顶上 top 恒等于 winStart（0），那样写会白搬好几次才稳住。 */
    /* 拖选中：朝选区推进的方向续长窗口，节点因此不会被摘掉，选区可以一直
       延下去（自动滚屏也会跟着走）。续不动了（到文末/到上限）再退回搬家。 */
    if (this._drag && this._hasRange()) {
      if (top < this.winStart + 1 && this._growWindow(-1)) return;
      if (bot > this.winStart + this.winCount - 2 && this._growWindow(1)) return;
    }
    if (top >= this.winStart && bot <= this.winStart + this.winCount - 2) return;
    this._windowAt(Math.max(0, top - 1), true);
  }

  /** 当前是否有落在编辑器里的非折叠选区 */
  _hasRange() {
    const sel = window.getSelection();
    return !!(sel && sel.rangeCount && !sel.isCollapsed && this.root.contains(sel.anchorNode));
  }

  /**
   * 把窗口朝 dir 续长一块（只增不减，约一屏）。给拖选用：内容必须在 DOM 里，
   * 选区才延得下去。返回 false 表示续不动（到文首/文末，或触到 MAX_DRAG_WIN）。
   */
  _growWindow(dir) {
    const n = this.records.length;
    if (this.winCount >= MAX_DRAG_WIN) return false;
    const vh = this._viewportH();
    if (dir > 0) {
      const from = this.winStart + this.winCount;
      if (from >= n) return false;
      const room = Math.min(n, from + 300, this.winStart + MAX_DRAG_WIN);
      let end = from;
      let h = 0;
      while (end < room && h < vh) {
        h += this.records[end].h || estimateH(this.records[end]);
        end++;
      }
      const nodes = new Array(end - from);
      for (let i = from, k = 0; i < end; i++, k++) nodes[k] = this._materialize(this.records[i]);
      this.root.append(...nodes);
      this.winCount = end - this.winStart;
      this._measureFrom(from - this.winStart);
      this._applyPadding();
      return true;
    }
    const to = this.winStart;
    if (to <= 0) return false;
    const room = Math.max(0, to - 300, this.winStart + this.winCount - MAX_DRAG_WIN);
    let from = to;
    let h = 0;
    while (from > room && h < vh) {
      h += this.records[from - 1].h || estimateH(this.records[from - 1]);
      from--;
    }
    const add = to - from;
    const nodes = new Array(add);
    for (let i = from, k = 0; i < to; i++, k++) nodes[k] = this._materialize(this.records[i]);
    this.root.prepend(...nodes);
    this.winStart = from;
    this.winCount += add;
    /* 上面的补偿量要用真实高度：估计值和实测差几十像素，画面就会跳一下 */
    const kids = this.root.children;
    let added = 0;
    for (let i = 0; i < add; i++) {
      const box = kids[i].getBoundingClientRect();
      if (box.height > 0) { this.records[from + i].h = box.height; added += box.height; }
    }
    if (added) this._cumDirty = true;
    this._applyPadding();
    /* 上方的占位少了「新长出来这些块」的高度，视口会整体上移同样的量 —— 补回来 */
    if (added) {
      this._vLock = true;
      this.root.scrollTop = Math.max(0, this.root.scrollTop - added);
      this._vLock = false;
    }
    return true;
  }

  /** 把窗口里被编辑过的块并回模型（结构变了就同步增删记录） */
  _syncWindow() {
    if (!this.virtual || !this.records) return;
    const kids = this.root.children;
    const n = kids.length;
    const start = this.winStart;
    let resized = false;
    if (n !== this.winCount) {
      const add = n - this.winCount;
      if (add > 0) {
        this.records.splice(start + this.winCount, 0,
          ...Array.from({ length: add }, () => ({ type: 'p', md: '', gap: 1, line: 0, nl: 0 })));
      } else {
        this.records.splice(start + n, -add);
      }
      this.winCount = n;
      this.cum = null;
      resized = true;
    }
    /* 只记「类型真的变了」的块：内容改了不需要动间距（改个字不该把段落之间的
       紧凑写法拆开）；只有块类型变了，间距规则才跟着变 */
    let typeFrom = -1;
    let typeTo = -1;
    for (let i = 0; i < n; i++) {
      const el = kids[i];
      const r = this.records[start + i];
      if (!r) continue;
      const type = el.dataset.type || 'p';
      let next;
      if (type === 'li') {
        const prev = r.li || {};
        const li = {
          kind: el.dataset.list || 'ul',
          indent: Math.min(+(el.dataset.indent || 0), MAX_INDENT),
          num: +(el.dataset.num || 1),
          start: prev.start || prev.num || 1,
          checked: el.dataset.checked === '1',
          text: inlineToMd(textEl(el)),
        };
        next = { ...r, md: liMd(li), type: 'li', nl: 0, li, callout: '', bqStart: 0, coFollow: '' };
      } else {
        const rb = rawBlock(el);
        next = {
          ...r,
          md: rb.lines.join('\n'),
          nl: rb.lines.length - 1,
          type,
          li: null,
          callout: el.dataset.callout || '',
          bqStart: el.dataset.bqStart ? 1 : 0,
          coFollow: el.dataset.coFollow || '',
        };
      }
      /* 记录是只读的：撤销快照就是记录数组的浅拷贝，原地改字段会把历史里的
         旧状态一起改掉（那就撤不回去了）。因此内容有变才换新对象 —— 没变的块
         保持同一个引用，快照之间共享，内存几乎不涨。 */
      if (!sameRec(r, next)) this.records[start + i] = next;
      if (r.type !== type) {
        if (typeFrom < 0 || i < typeFrom) typeFrom = i;
        if (i > typeTo) typeTo = i;
      }
    }
    if (resized) {
      /* 结构变了：整段重算间隔（新块没有原始间距可用） */
      for (let i = 0; i < n - 1; i++) this._setGap(start + i);
    } else if (typeFrom >= 0) {
      /* 只动变类型块的左右邻：块间隔只跟相邻两块的类型有关 */
      const lo = Math.max(0, typeFrom - 1);
      const hi = Math.min(n - 1, typeTo + 1);
      for (let i = lo; i < hi; i++) this._setGap(start + i);
    }
  }

  /** 重算第 i 块与其后一块的间距（同样写时复制，见 _syncWindow 的说明） */
  _setGap(i) {
    const a = this.records[i];
    const b = this.records[i + 1];
    if (!a || !b) return;
    const g = gapBetween(a, b);
    if (a.gap !== g) this.records[i] = { ...a, gap: g };
  }

  /** 模型层编号：整篇算一遍，只把结果套到窗口 DOM 上 */
  _renumberVirtual() {
    if (!this.records) return;
    this._syncWindow();
    const recs = this.records;
    const counters = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 'li' && r.li) {
        if (r.li.kind !== 'ol') continue;
        const ind = Math.min(r.li.indent || 0, MAX_INDENT);
        counters.length = ind + 1;
        if (counters[ind] == null) counters[ind] = r.li.start || 1;
        else counters[ind] += 1;
        r.li.num = counters[ind];
      } else if (r.type !== 'li') {
        counters.length = 0;
      }
      if (r.type === 'bq') {
        const nx = recs[i + 1];
        r.bqTail = !!(nx && nx.type === 'bq' && !nx.bqStart);
      }
    }
    const kids = this.root.children;
    for (let i = 0; i < kids.length; i++) {
      const r = recs[this.winStart + i];
      if (!r) continue;
      const el = kids[i];
      if (r.type === 'li' && r.li) {
        el.dataset.indent = String(Math.min(r.li.indent || 0, MAX_INDENT));
        el.style.setProperty('--li-indent', el.dataset.indent);
        if (r.li.kind === 'ol') el.dataset.num = String(r.li.num || 1);
      }
      if (r.type === 'bq') {
        if (r.bqTail) el.dataset.bqTail = '1'; else delete el.dataset.bqTail;
      }
    }
  }

  /** 滚到第 idx 块（大纲点击 / 查找跳转 / 行号跳转都走它） */
  scrollToBlockIndex(idx, center = false) {
    if (!this.records) return;
    const n = this.records.length;
    idx = Math.max(0, Math.min(idx, n - 1));
    if (!this.virtual) {
      const el = this.root.children[idx];
      if (el) el.scrollIntoView({ block: center ? 'center' : 'start' });
      return;
    }
    const vh = this._viewportH();
    this._windowAt(Math.max(0, idx - 4), false);
    /* 先强制一次布局：padding 刚改过，浏览器的 scrollHeight 还是旧值，
       直接写 scrollTop 会被夹到旧的最大值上，跳转就落空 */
    void this.root.scrollHeight;
    /* 绝对位置 = 顶部留白 + 该块之前的全部高度（padTop 里已经含窗口起点，
       不能再加，否则重复计一次） */
    this._vLock = true;
    this.root.scrollTop = Math.max(0, Math.round(
      PAD_TOP + this.cum[idx] - (center ? vh / 2 : Math.min(96, vh * 0.3)),
    ));
    this._vLock = false;
  }

  /** 第 n 个标题块（大纲点第 n 项） */
  scrollToHeadingIndex(n) {
    if (!this.virtual || !this.records) return;
    let seen = 0;
    for (let i = 0; i < this.records.length; i++) {
      if (/^h[1-6]$/.test(this.records[i].type)) {
        if (seen === n) { this.scrollToBlockIndex(i); return; }
        seen++;
      }
    }
  }

  /** 当前视口顶部上方最后一个标题在大纲里的序号（-1 = 还没有标题） */
  headingIndexAt() {
    if (!this.virtual || !this.records) return -1;
    this._rebuildCum();
    const y = Math.max(0, this.root.scrollTop - PAD_TOP + Math.min(96, this._viewportH() * 0.3));
    const at = this._indexAtY(y);
    let seen = -1;
    for (let i = 0; i <= at && i < this.records.length; i++) {
      if (/^h[1-6]$/.test(this.records[i].type)) seen++;
    }
    return seen;
  }

  /** 行号（Markdown 源行，0 起）-> 块下标 */
  scrollToLine(line) {
    if (!this.virtual || !this.records) return;
    let idx = 0;
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].line <= line) idx = i; else break;
    }
    this.scrollToBlockIndex(idx, true);
  }

  /** 全文查找（返回匹配所在块的下标；实际匹配由调用方在窗口 DOM 里再定位） */
  findMatches(re) {
    if (!this.virtual || !this.records) return null;
    this._syncWindow();
    const recs = this.records;
    const starts = new Array(recs.length);
    let text = '';
    for (let i = 0; i < recs.length; i++) {
      starts[i] = text.length;
      text += (recs[i].md || '') + '\n';
    }
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const off = m.index;
      let lo = 0;
      let hi = recs.length - 1;
      let pick = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= off) { pick = mid; lo = mid + 1; } else hi = mid - 1;
      }
      out.push({ block: pick, off });
      if (out.length >= 2000) break;
    }
    return out;
  }

  /** 这块 DOM 还有没有没落账的编辑（切走前要不要读回来的唯一判据） */
  pending() { return !!(this._edited || this._flushTimer); }

  /** 编辑已落账到属于它的标签：清掉挂起标记与待触发的 flush。
      不清的话，标签刚切走时那次迟到的 blur 会把旧 DOM 序列化一遍，
      经 onChange 写进「此刻的 activeTab」——也就是刚打开的下一个文件。 */
  markCommitted() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = 0; }
    this._edited = false;
  }

  toMarkdown() {
    if (this.virtual) {
      /* 窗口里的块可能刚被改过：先把这几个块的 DOM 并回模型，再拼整篇。
         成本与窗口大小成正比（几十块），与文档大小无关 —— 这就是大文档
         序列化从 ~700ms 降到 1ms 级的原因。 */
      this._syncWindow();
      return this._serializeRecords();
    }
    let md = blocksToMarkdown(this.root, this.mdCache);
    if (this.trailingNewline && md && !md.endsWith('\n')) md += '\n';
    return md;
  }

  caretState() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const cell = this.currentCell();
    if (cell) {
      const block = cell.closest('.w-block');
      return { blockIndex: this.indexOf(block), cell: this.cellIndex(cell), offset: offsetIn(cell) };
    }
    const block = this.currentBlock();
    if (!block) return null;
    return { blockIndex: this.indexOf(block), offset: offsetIn(textEl(block)) };
  }

  restoreCaret(state) {
    if (!state) return;
    let block = null;
    if (this.virtual) {
      /* 记录里的下标是全文下标，窗口里只放了一小段：不在窗口就先搬家 */
      let local = state.blockIndex - this.winStart;
      if (local < 0 || local >= this.root.children.length) {
        this._windowAt(Math.max(0, state.blockIndex - 4), false);
        local = state.blockIndex - this.winStart;
      }
      block = this.root.children[local];
    } else {
      block = this.root.children[state.blockIndex];
    }
    if (!block) return;
    if (state.cell) {
      const table = block.querySelector('table');
      const cell = table && table.querySelectorAll('th,td')[state.cell];
      if (cell) { setCaretOffset(cell, state.offset || 0); return; }
    }
    setCaretOffset(textEl(block), state.offset || 0);
  }

  /* ---------------- 历史（撤销 / 重做） ---------------- */

  pushHistory(md) {
    const now = Date.now();
    const last = this.history[this.hIndex];
    const recs = !!(this.virtual && this.records);
    /* 没有真改动就别占一条历史。记录快照按对象引用判等：内容没变的块始终是
       同一个对象（_syncWindow 写时复制），所以这个比较是几万次指针比较，零成本 */
    const same = recs && last && last.recs
      ? sameRecs(last.recs, this.records)
      : (!!last && last.md === md);
    if (same) { this.hLast = now; return; }
    const snap = recs
      ? { recs: this.records.slice(), trail: this.trailingNewline, caret: this.caretState() }
      : { md, caret: this.caretState() };
    if (last && this.hCoalesce && now - this.hLast < 700) {
      this.hBytes -= snapSize(this.history[this.hIndex]);
      this.history[this.hIndex] = snap;
      this.hBytes += snapSize(snap);
    } else {
      this.history = this.history.slice(0, this.hIndex + 1);
      this.history.push(snap);
      this.hBytes += snapSize(snap);
      if (this.history.length > 200) this.hBytes -= snapSize(this.history.shift());
      /* 条数上限 200 是按小文档定的。600 段的文档每份快照 60 KB，
         200 条就是 12 MB 常驻。所以再按总字节封一道顶，超了丢最旧的：
         长文档的撤销深度换内存，短文档完全不受影响。
         视口文档的一份快照按 8 万块 × 8 字节 = 620 KB 折算，同一道顶
         能留十几步 —— 而不是整篇文本快照下的 1 步。 */
      while (this.hBytes > HISTORY_BYTES && this.history.length > 2) {
        this.hBytes -= snapSize(this.history.shift());
      }
      this.hIndex = this.history.length - 1;
    }
    this.hLast = now;
  }

  /** 工具栏 / 菜单用它决定能不能点：到栈底了就该是灰的，点了没反应更糟 */
  canUndo() { return this.hIndex > 0; }
  canRedo() { return this.hIndex < this.history.length - 1; }

  undo() {
    // 停手 400ms 内按撤销：先把挂起的输入落成快照，不然这几下会丢
    if (this._flushTimer) this.flush();
    if (this.hIndex <= 0) return false;
    this.hIndex--;
    this._applyHistory(this.history[this.hIndex]);
    this.hCoalesce = false;
    return true;
  }

  redo() {
    // 有挂起输入说明撤销后又打了字，redo 本就该失效 —— flush 顺带把 redo 分支截掉
    if (this._flushTimer) this.flush();
    if (this.hIndex >= this.history.length - 1) return false;
    this.hIndex++;
    this._applyHistory(this.history[this.hIndex]);
    this.hCoalesce = false;
    return true;
  }

  /**
   * 应用一条历史。记录快照只换数组 + 重建窗口（几十毫秒），
   * 文本快照才走整篇渲染（只有小文档/降级路径才会用到）。
   */
  _applyHistory(s) {
    if (s.recs && this.virtual) {
      this._restoreRecords(s);
      this.onChange(this._serializeRecords());
      return;
    }
    /* 记录快照遇上非视口模式（替换整篇后文档变小这类）：先序列化再整篇渲染 */
    const md = s.recs ? serializeRecs(s.recs, s.trail) : s.md;
    this._render(md, s.caret);
    this.onChange(md);
  }

  /** 用快照里的记录重建视图（不重新解析原文） */
  _restoreRecords(s) {
    this.records = s.recs.slice();
    this.trailingNewline = !!s.trail;
    this.silent = true;
    this._selAll = false;
    this.lastBlock = null;
    this.lastCell = null;
    this.cum = null;
    this._cumDirty = true;
    this.winStart = 0;
    this.winCount = 0;
    const n = this.records.length;
    const idx = s.caret && s.caret.blockIndex != null ? s.caret.blockIndex : 0;
    this.root.innerHTML = '';
    this._windowAt(Math.max(0, Math.min(idx - 2, n - 1)), false);
    this._renumberVirtual();
    if (s.caret) this.restoreCaret(s.caret);
    this.silent = false;
    this._edited = true;
  }

  /** 记录 → markdown（视口模式的唯一序列化出口，结尾换行规则与 toMarkdown 一致） */
  _serializeRecords() {
    return serializeRecs(this.records, this.trailingNewline);
  }

  /* ---------------- 基础定位 ---------------- */

  /* 不要写 [...this.root.children].indexOf()：每次调用都会把 600 个块复制成数组，
     而它在每次击键的 caretState 里都要跑一次。 */
  indexOf(block) {
    const kids = this.root.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === block) return this.virtual ? i + this.winStart : i;
    }
    return -1;
  }

  /**
   * 按锚点找标题块（目录里的 [标题](#slug) 靠它跳转）。
   * slug 用和渲染时同一个函数现算，不预先存在 DOM 上 ——
   * 改标题文字之后不用重新标注，算出来自然就变了。
   */
  findHeadingBySlug(slug) {
    if (this.virtual && this.records) {
      /* 窗口里可能一个标题都没有：在记录上算 slug（与渲染共用同一函数），
         命中后把窗口搬过去。返回 null 之外调用方只做滚动，不摸 DOM。 */
      const idx = [];
      const texts = [];
      for (let i = 0; i < this.records.length; i++) {
        const t = this.records[i].type;
        if (/^h[1-6]$/.test(t)) {
          idx.push(i);
          texts.push((this.records[i].md || '').replace(/^#{1,6}\s*/, '').replace(/\s*#+\s*$/, ''));
        }
      }
      const k = headingSlugs(texts).indexOf(String(slug));
      if (k < 0) return null;
      this.scrollToBlockIndex(idx[k]);
      return this.root.children[idx[k] - this.winStart] || null;
    }
    const heads = [...this.root.querySelectorAll('.w-h')];
    const texts = heads.map((b) => (b.querySelector('.w-text') || b).textContent || '');
    const i = headingSlugs(texts).indexOf(String(slug));
    return i >= 0 ? heads[i] : null;
  }

  currentBlock() {
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const b = el ? el.closest('.w-block') : null;
      if (b && this.root.contains(b)) { this.lastBlock = b; return b; }
      // 选区已经在编辑器里但不在任何块上 → 老老实实返回 null
      if (el && this.root.contains(el)) return null;
    }
    return this.lastBlock && this.root.contains(this.lastBlock) ? this.lastBlock : null;
  }

  currentCell() {
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const c = el ? el.closest('th,td') : null;
      if (c && this.root.contains(c)) { this.lastCell = c; return c; }
      // 光标从表格移回正文时要立刻失效，否则「表格命令」会打在旧表格上
      if (el && this.root.contains(el)) { this.lastCell = null; return null; }
    }
    return this.lastCell && this.root.contains(this.lastCell) ? this.lastCell : null;
  }

  placeCaretStart(block) {
    const t = textEl(block);
    if (t.firstChild && t.firstChild.nodeName === 'BR') return placeCaret(t, 0);
    setCaretOffset(t, 0);
  }

  placeCaretEnd(block) {
    const t = textEl(block);
    setCaretOffset(t, t.textContent.length);
  }

  /** 把光标放到指定块的首位或末尾（行首手柄用：菜单点完要回到原来那一行） */
  focusBlock(block, atEnd = false) {
    if (!block || !block.isConnected) return;
    this.root.focus();
    if (atEnd) this.placeCaretEnd(block);
    else this.placeCaretStart(block);
  }

  /** 在指定块之后插一个空段落并返回它（行首「+」插入新块用） */
  insertEmptyAfter(block) {
    const p = mkPara('');
    if (block && block.isConnected) block.after(p);
    else this.root.appendChild(p);
    return p;
  }

  /** 在指定块之前插一个空段落并返回它（出块要「插在块与下一块中间」） */
  insertEmptyBefore(block) {
    const p = mkPara('');
    block.before(p);
    return p;
  }

  isCaretAtStart(block) { return offsetIn(textEl(block)) === 0; }

  /**
   * 「看得见的最后一个字符之后」的字符偏移，以及末尾是不是藏着一条
   * **不生成可点击行**的裸 `\n`。出口（↓/→）与入口（↑）共用这一份判据。
   *
   * 尾部垫的零宽空格不算内容：代码块末行、空单元格都会垫一个当落脚点，
   * 若按 `textContent.length` 判，光标停在「abc」之后时 offset 是 3、长度是 4，
   * 判定为「还没到头」—— 于是 → 交给浏览器，它只是跨过那个看不见的字符，
   * 用户看到的是「按一下没反应，得按两下才出块」。
   *
   * code / math 的正文是带真换行的文本（white-space: pre-wrap）。末尾那个
   * `\n` 不生成可点击的行：光标最多停在它前面，浏览器也只肯把行尾点击
   * 映射到那里。1.2.7 修出块时在这里剥掉它；↑ 从块后一行往回进块时，
   * 浏览器找不到这条「上一行」的落点，会**整块跳过**落到更前面一块 ——
   * 同一个根因，两个方向都要读这份判据。
   *
   * 只忽略一个：再往前的每个 \n 都对应一条看得见的空行，光标能站上去，
   * 全剥掉会让用户在倒数第二行按 → 也出块。表格 / 引用 / 列表的换行是
   * `<br>` 或单元格边界，textContent 里没有裸 \n，不受影响。
   */
  visibleEnd(block) {
    const host = textEl(block);
    const raw = host.textContent;
    let end = raw.length;
    while (end > 0 && raw[end - 1] === ZWSP) end--;
    const type = block.dataset.type;
    const invisibleNL = (type === 'code' || type === 'math')
      && end > 0 && raw[end - 1] === '\n';
    if (invisibleNL) end--;
    return { host, end, invisibleNL };
  }

  /** 光标是不是停在**看得见的最后一个字符之后**（判据见 visibleEnd） */
  isCaretAtEnd(block) {
    const { host, end } = this.visibleEnd(block);
    return offsetIn(host) >= end;
  }

  isEmptyBlock(block) { return isEmptyText(textEl(block)); }

  /* ---------------- 输入主流程 ---------------- */

  onInput() {
    if (this.silent || this.loading || this.composing) return;
    this.normalize(false, true);   // 只扫光标附近，见 normalize 的说明
    if (this.applyBlockRule()) { this.renumber(); this.queueFlush(); return; }   // 接管 = 结构变化，全量重排一次
    this.applyInlineRule();
    // 纯打字不 renumber：编号只随结构变化，结构路径都显式全量重排。
    // 万块级文档上全量扫一遍是每键几十毫秒，打字路径背不起。
    this.hCoalesce = true;
    this.queueFlush();
  }

  /**
   * 输入路径的 flush 延后到停手再执行。
   * 全量序列化（含 78k 块的签名校验）实测热缓存仍要 ~750ms，逐键执行必然卡顿；
   * 而它的三个用途（撤销快照、tab.content、自动保存）都只关心「最终内容」，
   * 停手 400ms 后同步一次即可。回车 / 格式命令等动作型入口仍走 flush()
   * 立即序列化，撤销粒度不受影响。
   */
  queueFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => { this._flushTimer = 0; this.flush(); }, 400);
  }

  /* ---------------- 视口模式的全选 ----------------
   * DOM 里只放窗口那几十块，所以浏览器原生 Ctrl+A 只能选到窗口 —— 用户随后
   * 打字，就等于「只留下窗口内容」，窗口外的几万块被当成未选中而删掉。
   * 这里把「全选」提升成模型层的概念：选区铺满窗口（看得见），真动作由
   * beforeinput / copy / cut 接管，按整篇文档处理。
   */

  /**
   * 当前选区是不是**已经盖住**这个元素的内容。Ctrl+A 在代码块里分两步走
   * （先选块、再选全篇），靠它判断「已经走到第几步」——判据是选区本身，
   * 不记状态，用户中途点别处、切标签都不会残留。
   *
   * 用「覆盖」而不是「边界完全相同」：`selectNodeContents` 把边界放在元素上、
   * 我们手动选的时候放在文本节点上，(el, 0) 与 (firstText, 0) 在 DOM 里是
   * 同一个位置，但用 `=== 0` 比容易因为容器不同而判错（判错的表现是第二次
   * Ctrl+A 又选了一遍块，永远扩不到全文）。
   */
  _isWholeRange(el) {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return false;
    const first = firstTextNode(el);
    const last = lastTextNode(el);
    if (!first || !last) return false;
    const a = document.createRange();
    a.setStart(first, 0);
    a.collapse(true);
    const b = document.createRange();
    b.setStart(last, last.nodeValue.length);
    b.collapse(true);
    const r = sel.getRangeAt(0);
    return r.compareBoundaryPoints(Range.START_TO_START, a) <= 0
      && r.compareBoundaryPoints(Range.END_TO_END, b) >= 0;
  }

  /** 整篇全选（非视口模式）。不交给浏览器，理由见 handleKey 里 Ctrl+A 的注释 */
  _selectAllDom() {
    const kids = this.root.children;
    if (!kids.length) return;
    const r = document.createRange();
    /* 顺序有讲究：selectNodeContents 会重置整个 range，先圈末块再拉回起点 */
    r.selectNodeContents(kids[kids.length - 1]);
    r.setStart(textEl(kids[0]), 0);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 选区是否仍然覆盖「整个窗口」（用户一旦点别处 / 收窄选区就作废） */
  _selAllHeld() {
    if (!this.virtual || !this.records) return false;
    const kids = this.root.children;
    if (!kids.length) return false;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return false;
    const a = document.createRange();
    a.setStart(textEl(kids[0]), 0);
    a.collapse(true);
    const b = document.createRange();
    b.selectNodeContents(kids[kids.length - 1]);
    b.collapse(false);
    const r = sel.getRangeAt(0);
    /* START_TO_START ≤ 0：选区起点不晚于首块开头；END_TO_END ≥ 0：终点不早于末块末尾 */
    return r.compareBoundaryPoints(Range.START_TO_START, a) <= 0
      && r.compareBoundaryPoints(Range.END_TO_END, b) >= 0;
  }

  _selectAllVirtual() {
    const kids = this.root.children;
    if (!kids.length) return;
    const r = document.createRange();
    /* 顺序有讲究：selectNodeContents 会**重置整个 range**（起点也跟着变成该节点开头），
       所以必须先圈住末块，再把起点往回拉到首块开头。反过来写，选区就只剩最后一块。 */
    r.selectNodeContents(kids[kids.length - 1]);
    r.setStart(textEl(kids[0]), 0);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    this._selAll = true;
    this.root.focus({ preventScroll: true });
  }

  /** 整篇替换：重建文档，并让撤销一步回到替换前 */
  _replaceWholeDoc(text) {
    this._selAll = false;
    const prev = this.toMarkdown();
    /* 替换前的状态要先按当前模式存好快照 —— render 之后旧记录就没了 */
    const before = this.virtual && this.records
      ? { recs: this.records.slice(), trail: this.trailingNewline, caret: null }
      : { md: prev, caret: null };
    this.lastBlock = null;
    this.render(text, { blockIndex: 0, offset: 0 });
    if (prev !== text) {
      const after = this.virtual && this.records
        ? { recs: this.records.slice(), trail: this.trailingNewline, caret: null }
        : { md: text, caret: null };
      this.history = [before, after];
      this.hIndex = 1;
      this.hBytes = snapSize(before) + snapSize(after);
    }
    this._edited = true;
    this.flush();
  }

  onBeforeInput(e) {
    /* beforeinput 是「真的要写入了」的最后一道口子：IME 组字、粘贴、
       以及不经过 keydown 的输入都从这里进。此时才把块后那一行建出来。 */
    if (this.gapAfter) {
      const t = e.inputType || '';
      if (t === 'insertParagraph' || t === 'insertLineBreak') {
        e.preventDefault();
        this.materializeGap();
        return;
      }
      if (t.startsWith('insert')) this.materializeGap();
      else this.clearGapAfter();
    }
    if (!this._selAll) return;
    if (!this._selAllHeld()) { this._selAll = false; return; }
    const t = e.inputType || '';
    if (t === 'insertText' || t === 'insertReplacementText') {
      e.preventDefault();
      this._replaceWholeDoc(e.data || '');
      return;
    }
    if (t === 'insertFromPaste' || t === 'insertFromDrop') {
      e.preventDefault();
      const dt = e.dataTransfer;
      this._replaceWholeDoc(dt ? dt.getData('text/plain') : '');
      return;
    }
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      this._replaceWholeDoc('\n');
      return;
    }
    if (t.indexOf('delete') === 0) {
      e.preventDefault();
      this._replaceWholeDoc('');
    }
  }

  onCopy(e, isCut) {
    if (!this._selAll) return;
    if (!this._selAllHeld()) { this._selAll = false; return; }
    /* 拿不到剪贴板就别放行：剪切会退化成「只删窗口」，那是丢数据的第二种走法 */
    if (!e.clipboardData) { e.preventDefault(); return; }
    const md = this.toMarkdown();
    e.clipboardData.setData('text/plain', md);
    e.preventDefault();
    this._selAll = false;
    if (isCut) this._replaceWholeDoc('');
  }

  flush() {
    if (this.silent || this.loading) return;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = 0; }
    /* 文档变了，重复块的标记就作废（再标也不对：块已经不是一个字的了）。
       放在 flush 里而不是 input 里，是因为所有改动路径最后都走这里。 */
    this.clearDuplicates();
    this._edited = true;
    const md = this.toMarkdown();
    this.pushHistory(md);
    this.onChange(md);
  }

  /* ---------------- DOM 规范化 ---------------- */

  /**
   * 块里除了 .w-text，偶尔会多出浏览器自己塞的节点。最常见的是**选中整行文字
   * 后按删除**：Chromium 会把内容清空，却在 .w-text 外面留一个孤立的 <br>。
   * 那个 <br> 会撑出一整行高度，于是标题下面那条装饰线看起来"凭空往下移了一行"。
   * 这里把它扫掉；万一游离节点里真有文字，就并回 .w-text，不丢内容。
   */
  sweepBlock(b, t) {
    const keep = (n) => n.nodeType === 1
      && (n.classList.contains('w-li-marker')
        || n.classList.contains('w-codebar')
        || n.classList.contains('w-hash')
        || n.classList.contains('w-co-head')
        || n.tagName === 'INPUT');
    const before = [];
    const after = [];
    let seen = false;
    for (const n of [...b.childNodes]) {
      if (n === t) { seen = true; continue; }
      if (keep(n)) continue;
      (seen ? after : before).push(n);
    }
    if (!before.length && !after.length) return;

    const absorb = (list, atStart) => {
      // 从后往前插，保证多节点时顺序不乱
      for (const n of atStart ? [...list].reverse() : list) {
        if (n.nodeType === 1 && n.tagName === 'BR') { n.remove(); continue; }
        if (n.nodeType === 3) {
          if (!n.nodeValue || !n.nodeValue.trim()) { n.remove(); continue; }
          t.insertBefore(n, atStart ? t.firstChild : null);
          continue;
        }
        if (n.nodeType !== 1) { n.remove(); continue; }
        // 有内容的容器：把孩子搬进去，容器本身丢掉
        while (n.firstChild) t.insertBefore(n.firstChild, atStart ? t.firstChild : null);
        n.remove();
      }
    };
    absorb(before, true);
    absorb(after, false);
  }

  /**
   * 规范化 DOM。
   *
   * @param all   true = 连「光标不在的空标题」也降级（载入文档时用）
   * @param local true = 只扫光标块与左右邻块。击键路径必须传 true：
   *   浏览器塞的游离节点、重复的 .w-text 只会在刚编辑过的地方冒出来，
   *   而全量扫一遍 600 个块 + 每块 sweepBlock，是单次击键最大的一块开销。
   *   远处的问题留给下一次全量（载入 / 粘贴 / 换块）。
   */
  normalize(all = false, local = false) {
    const caret = this.currentBlock();
    const near = caret
      ? [caret.previousElementSibling, caret, caret.nextElementSibling].filter(Boolean)
      : null;
    const scope = local && near ? near : [...this.root.childNodes];

    // 顶层游离节点（浏览器偶尔会造出 div/br/text）→ 包成段落
    for (const n of scope) {
      if (n.nodeType === 1 && n.classList.contains('w-block')) continue;
      if (n.nodeType === 3 && !n.nodeValue.trim()) { n.remove(); continue; }
      const p = mkPara('');
      const pt = textEl(p);
      pt.innerHTML = '';
      if (n.nodeType === 3) pt.textContent = n.nodeValue;
      else while (n.firstChild) pt.appendChild(n.firstChild);
      n.replaceWith(p);
    }

    const blocks = local && near
      ? near.filter((b) => b.nodeType === 1 && b.classList.contains('w-block'))
      : [...this.root.children];

    for (const b of blocks) {
      const type = b.dataset.type;
      if (type === 'table' || type === 'hr') continue;
      let t = b.querySelector('.w-text');
      if (!t) {
        t = mkText('');
        b.appendChild(t);
      }
      this.sweepBlock(b, t);
      // 空标题立刻退回正文。留着它有两个坏处：标题下方那条装饰线会变成一条
      // 没有文字的横线（像凭空多出来的分割线），而且接着打字还是标题。
      // 只降级「光标所在的那个块」（以及整体载入时的所有块）：刚用菜单把空行设成
      // 标题、还没开始打字的情况下，别的地方敲一个字就把这个标题悄悄吃掉。
      if (/^h[1-6]$/.test(type) && !this.hashEl(b) && isEmptyText(t) && !t.querySelector('img') && (all || b === caret)) {
        this.degradeHeading(b);
      }
      // 清掉空的行内包裹（删字后常见的 <strong></strong>）。
      // 判空必须忽略零宽空格 —— contenteditable 会往空元素里塞 \u200b 当落脚点，
      // 有它在 textContent 就不为空，于是这个 <strong> 活下来，
      // 接下来打的字全被它包成粗体（表现为「删光重打还是粗的」）。
      const blankInline = (el) => !el.textContent.replace(/\u200b/g, '') && !el.querySelector('img');
      const r0 = window.getSelection();
      const caret0 = r0 && r0.rangeCount ? r0.getRangeAt(0) : null;
      let caretInBlank = false;
      t.querySelectorAll('strong,em,code,del,b,i,strike,a').forEach((el) => {
        if (!blankInline(el)) return;
        if (caret0 && el.contains(caret0.startContainer)) caretInBlank = true;
        el.remove();
      });
      // 相邻同标签合并，避免 **a****b**
      for (const el of [...t.children]) {
        const prev = el.previousElementSibling;
        if (!prev || prev.nodeName !== el.nodeName) continue;
        if (!['STRONG', 'EM', 'DEL', 'B', 'I', 'STRIKE'].includes(el.nodeName)) continue;
        while (el.firstChild) prev.appendChild(el.firstChild);
        el.remove();
      }
      if (type === 'code') {
        if (!t.textContent) t.innerHTML = '<br>';
      } else {
        ensurePlaceholder(t);
      }
      // 删掉的那个空元素如果正夹着光标，光标现在悬空了，放回块里
      if (caretInBlank) setCaretOffset(t, 0);
    }

    if (!this.root.firstElementChild) this.root.appendChild(mkPara(''));
  }

  /* ---------------- 输入即转换（Markdown 语法糖） ---------------- */

  /**
   * 段首输入 "# " / "- " / "1. " / "> " / "```" / "- [ ] " 立刻转成对应块。
   *
   * 判据是「光标之前这一小段文字」（mark），不是整行 —— 光标可以停在已有文字
   * 的正前方，只敲标记，标记后面的文字原样留在新块里。于是「先写内容再补 #」
   * 和「先打 # 再写内容」是同一件事。
   * 搬运后半段用 Range 取 DOM 片段而不是 textContent，行内样式（**粗体**、
   * 链接、行内码）才不会被抹平。
   */
  applyBlockRule() {
    const block = this.currentBlock();
    if (!block) return false;
    if (block.dataset.type === 'bq') {
      /* 引用行里直接敲 [!info] 空格：本行升级为提示块，光标后的文字当标题
         （GitHub 习惯写法 > [!info] 标题）。只对引用行放行，其余块维持原路 */
      const sel0 = window.getSelection();
      if (!sel0.rangeCount || !sel0.isCollapsed) return this.upgradeTaskItem(block);
      const bt = textEl(block);
      if (!bt.contains(sel0.getRangeAt(0).startContainer)) return this.upgradeTaskItem(block);
      const mark = (bt.textContent || '').slice(0, offsetIn(bt));
      const m = mark.match(/^\[!(info|warning|danger|success|note|tip|important|caution)\]\s$/i);
      if (!m) return this.upgradeTaskItem(block);
      const r = sel0.getRangeAt(0);
      const tail = document.createRange();
      tail.setStart(r.endContainer, r.endOffset);
      tail.setEnd(bt, bt.childNodes.length);
      const title = tail.toString().replace(/\u200b/g, '').trim();
      const nb = mkQuote('', +block.dataset.indent || 0, normalizeCallout(m[1]), title);
      block.replaceWith(nb);
      this.placeCaretStart(nb);
      this.hCoalesce = false;
      this.flush();
      return true;
    }
    if (block.dataset.type !== 'p') return this.upgradeTaskItem(block);
    const t = textEl(block);
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const here = sel.getRangeAt(0);
    if (!t.contains(here.startContainer)) return false;
    const text = t.textContent;
    if (!text) return false;
    const off = offsetIn(t);
    const mark = text.slice(0, off);
    if (!mark || mark.length > 16) return false;

    /** 光标之后的文字搬进新块，光标落在它前面 */
    const takeover = (nb) => {
      const r = document.createRange();
      r.setStart(here.startContainer, here.startOffset);
      r.setEnd(t, t.childNodes.length);
      if (!r.collapsed) {
        const frag = r.extractContents();
        // 空段落里那个占位 <br> 不能跟着搬 —— 新块自己会补一个，
        // 多出来的一行高会把后续的回车拆分算歪。
        for (const n of [...frag.childNodes]) {
          if (n.nodeType === 1 && n.tagName === 'BR') n.remove();
        }
        const hasContent = [...frag.childNodes].some((n) => n.nodeType === 1
          || (n.nodeValue || '').replace(/[\s\u200b]/g, ''));
        if (hasContent) {
          const nt = textEl(nb);
          nt.innerHTML = '';
          nt.appendChild(frag);
        }
      }
      block.replaceWith(nb);
      // 紧跟着上一条引用敲 "> " 转出来的 = 新的独立引用。不打标记的话
      // .w-bq + .w-bq 的紧凑规则会把它粘进上面的框（视觉连体、序列化并段）
      if (nb.dataset.type === 'bq') {
        const pb = nb.previousElementSibling;
        if (pb && pb.dataset && pb.dataset.type === 'bq') nb.dataset.bqStart = '1';
      }
      this.placeCaretStart(nb);
      this.hCoalesce = false;
      this.renumber();
      this.flush();
      return true;
    };

    // --- / *** / ___ → 分割线（只有整行就这些字符时才触发，后面自动补一个空段落）
    if (mark === text && /^(-{3,}|\*{3,}|_{3,})$/.test(mark)) {
      const hr = mkHr();
      const p = mkPara('');
      block.replaceWith(hr);
      hr.after(p);
      this.hCoalesce = false;
      this.flush();
      this.root.focus();
      setCaretOffset(textEl(p), 0);
      return true;
    }

    const rules = [
      [/^(#{1,6})\s$/, (m) => mkHeading(m[1].length)],
      /* 空格才是触发条件，单看 ``` 就转的话语言名会被吃掉：
         打到第三个反引号时块已经变成代码块，紧接着敲的 js 只能落在正文里。
         不带空格的写法（```js + 回车）由 handleEnter 接住。 */
      [/^```([\w#+.-]*)\s$/, (m) => mkCode('', m[1] || '')],
      [/^>\s$/, () => mkQuote('')],
      /* [!info] 这类标记 + 空格 → 提示块。> 开头的走上面那条，所以这里不用带 >；
         文件里来的 > [!info] 由 parseMarkdown 认 */
      [/^\[!(info|warning|danger|success|note|tip|important|caution)\]\s$/i,
        (m) => mkQuote('', 0, normalizeCallout(m[1]), '')],
      [/^([-*+])\s\[([ xX])\]\s$/, (m) => mkLi('task', '', 0, m[2].toLowerCase() === 'x')],
      [/^([-*+])\s$/, () => mkLi('ul', '')],
      [/^(\d{1,9})[.)]\s$/, (m) => mkLi('ol', '', 0, false, parseInt(m[1], 10) || 1)],
    ];

    for (const [re, build] of rules) {
      const m = mark.match(re);
      if (!m) continue;
      return takeover(build(m));
    }
    return false;
  }

  /**
   * 无序项里接着打 "[ ] "（或 "[x] "）就升级成任务项。
   *
   * 逐字输入时 "- " 会先把段落变成无序列表，后面那截 "[ ] " 就再也碰不到
   * 段首规则了（此时块已经不是 p）—— 表现为一个圆点后面跟着字面的 "[ ]"，
   * 任务列表只能靠「粘贴整行」或格式菜单才做得出来。
   */
  upgradeTaskItem(block) {
    if (block.dataset.type !== 'li' || block.dataset.list !== 'ul') return false;
    const t = textEl(block);
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const here = sel.getRangeAt(0);
    if (!t.contains(here.startContainer)) return false;
    const off = offsetIn(t);
    const m = t.textContent.slice(0, off).match(/^\[([ xX])\]\s$/);
    if (!m) return false;

    const nb = mkLi('task', '', Number(block.dataset.indent) || 0, m[1].toLowerCase() === 'x');
    const nt = textEl(nb);
    const r = document.createRange();
    r.setStart(here.startContainer, here.startOffset);
    r.setEnd(t, t.childNodes.length);
    if (!r.collapsed) {
      const frag = r.extractContents();
      // 空项里那个占位 <br> 别搬过去，否则任务项开头多一个空行
      for (const n of [...frag.childNodes]) {
        if (n.nodeType === 1 && n.tagName === 'BR') n.remove();
      }
      if ([...frag.childNodes].some((n) => n.nodeType === 1
        || (n.nodeValue || '').replace(/[\s\u200b]/g, ''))) {
        nt.innerHTML = '';
        nt.appendChild(frag);
      }
    }
    block.replaceWith(nb);
    this.placeCaretStart(nb);
    this.hCoalesce = false;
    this.renumber();
    this.flush();
    return true;
  }

  /** 行内标记：输入到收尾符时立刻变成真正的样式 */
  applyInlineRule() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const off = range.startOffset;
    if (node.nodeType !== 3 || off === 0) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    const textWrap = parent.closest('.w-text');
    if (!textWrap || textWrap.classList.contains('w-code') || textWrap.classList.contains('w-tex')) return false;

    const before = node.nodeValue.slice(0, off);
    const rules = [
      { re: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
      { re: /__([^_\n]+)__$/, tag: 'strong' },
      { re: /~~([^~\n]+)~~$/, tag: 'del' },
      { re: /==([^=\n]+)==$/, tag: 'mark' },
      { re: /`([^`\n]+)`$/, tag: 'code' },
      { re: /!\[([^\]\n]*)\]\(([^)\s]+)\)$/, img: true },
      { re: /\[([^\]\n]+)\]\(([^)\s]+)\)$/, link: true },
      { re: /(?<![*\w])\*([^*\n]+)\*$/, tag: 'em' },
      { re: /(?<![_\w])_([^_\n]+)_$/, tag: 'em' },
    ];

    for (const rule of rules) {
      const m = before.match(rule.re);
      if (!m) continue;
      // 已经在该标签里就不再嵌套（比如在粗体里再打 **）
      if (rule.tag && parent.closest(rule.tag)) continue;
      if (rule.link && parent.closest('a')) continue;

      const start = off - m[0].length;
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, off);
      r.deleteContents();

      let el;
      if (rule.img) {
        el = document.createElement('img');
        el.className = 'w-img';
        el.setAttribute('data-src', m[2]);
        el.setAttribute('src', resolveDocImg(m[2], docDir));
        el.setAttribute('alt', m[1] || '');
      } else if (rule.link) {
        el = document.createElement('a');
        el.setAttribute('href', m[2]);
        el.textContent = m[1];
      } else {
        el = document.createElement(rule.tag);
        el.textContent = m[1];
      }
      r.insertNode(el);

      // 关键：在元素后面补一个空文本节点，把光标放进去。
      // 否则 Chromium 会把紧接着输入的字符继续塞进 <strong> 里（看起来就像粗体没结束），
      // 序列化出来就成了 **粗 尾**。
      const tail = document.createTextNode(ZWSP);
      el.after(tail);
      const after = document.createRange();
      after.setStart(tail, 1);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
      // 浏览器在这个 input 事件收尾时还会再修一次选区，延后一个微任务再摆一次
      queueMicrotask(() => {
        const s2 = window.getSelection();
        if (!s2.rangeCount || !tail.parentNode) return;
        s2.removeAllRanges();
        s2.addRange(after);
      });
      return true;
    }
    return false;
  }

  /* ---------------- 键盘 ---------------- */

  handleKey(e) {
    if (this.loading) { e.preventDefault(); return; }   // 大文档分块载入期间不响应
    if (e.isComposing) return;

    /* 出块时记下的「块后还缺一行」，只在用户真的要写入时才兑现。
       方向键 / 退格 / Tab / 快捷键一律让它失效 —— 移动光标不该改文档。 */
    if (this.gapAfter) {
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plain && e.key === 'Enter') {
        const p = this.materializeGap();
        if (p) { e.preventDefault(); return; }   // 这一下回车就是「插一个空行」
      } else if (plain && e.key.length === 1) {
        /* 不 preventDefault：先把空段落和光标放好，浏览器随后把这个字符
           输进刚放好的位置，不会写进下一块的正文。 */
        this.materializeGap();
      } else if (e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') {
        /* IME 起手键：状态留给 compositionstart，那里才是组字的起点 */
      } else {
        this.clearGapAfter();
      }
    }
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = this.currentBlock();
    const cell = this.currentCell();

    // 撤销 / 重做 / 行内格式
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      /* Typora 式「强制插入新行」：只在带边界块的末尾生效（见 insertLineBelow）。
         不在末尾也 preventDefault —— 不让浏览器把 Ctrl+Enter 当成一次普通换行
         写进代码块里，那会变成「按了却悄悄改了文档」。 */
      if (k === 'enter') {
        e.preventDefault();
        this.insertLineBelow();
        return;
      }
      if (k === 'a') {
        /* 代码块里 Ctrl+A = 选中**这一块自己的代码**（编辑器里的共识：想改一段
           代码时先全选它）。再按一次才扩到整篇 —— 判据是「选区是不是已经盖住
           这块」，不是记状态，所以用户中途点别处也不会残留。

           全篇这一下**自己选、不交给浏览器**：WebView2 里在「已选中某个内联块」
           之后执行 SelectAll，会把选区整块吃掉（实测 `execCommand('selectAll')`
           返回 true 而选区变空，anchor 从 SPAN 掉回 #text、collapsed）。 */
        const code = block && block.dataset.type === 'code'
          ? block.querySelector('.w-code') : null;
        const inCode = code && !this._isWholeRange(code);
        e.preventDefault();
        if (inCode) {
          /* 边界落在**文本节点**上，不是元素上：元素边界会让下一次的全选
             把自己吃掉（同上），也让「已经选满了没有」难以判断 */
          const r = document.createRange();
          const first = firstTextNode(code);
          const last = lastTextNode(code);
          if (first && last) { r.setStart(first, 0); r.setEnd(last, last.nodeValue.length); }
          else r.selectNodeContents(code);
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
        if (this.virtual && this.records) this._selectAllVirtual();
        else this._selectAllDom();
        return;
      }
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (k === 'y') { e.preventDefault(); this.redo(); return; }
      if (k === 'b') { e.preventDefault(); this.toggleInline('strong'); return; }
      if (k === 'i') { e.preventDefault(); this.toggleInline('em'); return; }
      return;
    }
    if (e.altKey || e.metaKey) return;

    if (e.key === 'Tab') return this.handleTab(e, block, cell);
    if (e.key === 'Enter') return this.handleEnter(e, block, cell);
    if (e.key === 'Backspace') return this.handleBackspace(e, block, cell);
    if (e.key === 'Delete') return this.handleDelete(e, block, cell);
    /* → 也要过这里：表格右下角和代码块末行没有它就走不出去 */
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      return this.handleArrow(e, block, cell);
    }
  }

  handleTab(e, block, cell) {
    if (cell) {
      e.preventDefault();
      this.moveCell(e.shiftKey ? -1 : 1);
      return;
    }
    if (block && block.dataset.type === 'li') {
      e.preventDefault();
      const ind = +block.dataset.indent || 0;
      if (e.shiftKey) {
        if (ind > 0) this.setIndent(block, ind - 1);
        else this.toParagraph(block, 0);
      } else if (ind < MAX_INDENT) {
        this.setIndent(block, ind + 1);
      }
      return;
    }
    if (block && block.dataset.type === 'code') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      return;
    }
    e.preventDefault();
    document.execCommand('insertText', false, '    ');
  }

  handleEnter(e, block, cell) {
    if (cell) {
      e.preventDefault();
      if (e.shiftKey) { document.execCommand('insertLineBreak'); this.flush(); return; }  // 格内换行
      this.cellEnter();
      return;
    }
    if (!block) return;
    const type = block.dataset.type;
    // 块级结构上回车：在它下方开新段落继续写。不然表格、分割线就是死路 ——
    // 进得去出不来，只能靠点别处才能脱身
    if (type === 'hr' || type === 'table') {
      e.preventDefault();
      const p = this.insertEmptyAfter(block);
      this.placeCaretStart(p);
      this.flush();
      return;
    }
    e.preventDefault();
    if (type === 'code' || type === 'math') {
      /* 块内回车**永远**是换行。曾经按 Typora 的约定「停在空末行再按一次就出块」，
         结果是：写完一行顺手回车想空一行，第二下就被弹出去，还要按退格把块收回来。
         出块已经有专门的路 —— → / ↓ 在块末把光标送到块后面（见 handleArrow）。 */
      this.codeNewline();
      return;
    }

    // 段落里整行就是 ``` 或 ```js，回车开代码块（Typora 的习惯写法）。
    // 语言名在这里才拿得到：逐字输入时不会提前把块转掉。
    if (type === 'p') {
      const ct = textEl(block);
      const fence = (ct.textContent || '').match(/^```([\w#+.-]*)$/);
      if (fence && !ct.querySelector('*')) {
        const nb = mkCode('', fence[1] || '');
        block.replaceWith(nb);
        this.placeCaretStart(nb);
        this.hCoalesce = false;
        this.renumber();
        this.flush();
        return;
      }
    }
    this.hideHashes(block);           // 回车 = 这个标题写完了，### 收起
    this.splitBlock(block);
  }

  handleBackspace(e, block, cell) {
    const sel = window.getSelection();
    if (!sel.isCollapsed) return;      // 有选区：交给浏览器删
    if (cell) return;                  // 单元格内正常删字
    if (!block) return;
    const type = block.dataset.type;

    if (type === 'code' || type === 'math') {
      if (this.isEmptyBlock(block) && this.root.children.length > 1) {
        e.preventDefault();
        this.removeBlock(block);
        return;
      }
      // 行首是「<br> + 零宽空格」垫出来的：浏览器第一次退格只会吃掉
      // 看不见的零宽空格，等于白按。识别这个形态自己删干净
      if (this.codeBackspace()) e.preventDefault();
      return;
    }
    if (type === 'table') return;
    if (!this.isCaretAtStart(block)) return;

    if (type === 'li') {
      e.preventDefault();
      const ind = +block.dataset.indent || 0;
      if (ind > 0) this.setIndent(block, ind - 1);
      else this.toParagraph(block, 0);   // 顶层列表项 ← 退回普通段落
      return;
    }
    if (type === 'bq') {
      e.preventDefault();
      const lvl = +block.dataset.indent || 0;
      if (lvl > 0) this.setQuoteLevel(block, lvl - 1);
      else {
        // 引用组的续行（含提示块正文）：行首退格并回上一行，而不是整个逃出引用。
        // 只有引用组的第一行才「退回普通段落」
        const prev = block.previousElementSibling;
        if (prev && prev.dataset.type === 'bq' && !(+prev.dataset.indent || 0)) this.mergeBack(block, prev);
        else this.toParagraph(block, 0);
      }
      return;
    }

    // 标题：行首退格不直接砍级别，先把 ### 亮出来，之后每按一次删一个 #
    if (/^h[1-6]$/.test(type)) {
      e.preventDefault();
      if (this.hashEl(block)) this.demoteHeading(block);
      else this.showHashes(block);
      return;
    }

    const prev = block.previousElementSibling;
    if (!prev) { e.preventDefault(); return; }
    e.preventDefault();
    if (prev.dataset.type === 'hr') { prev.remove(); this.hCoalesce = false; this.flush(); return; }
    if (this.needsLineBelow(prev)) {
      /* 表格 / 代码块 / 公式块后面那个空段落是给它们垫的落脚行。行首退格应该
         把它删掉、光标退回块末 —— 原来只 placeCaretEnd 不删块，那一行永远删不掉。
         非空行仍只送光标：先把字删完，再按一次才轮到删这一行。 */
      if (this.isEmptyBlock(block)) {
        block.remove();
        this.renumber();
        this.hCoalesce = false;
        this.flush();
      }
      this.placeCaretEnd(prev);
      return;
    }
    this.mergeBack(block, prev);
  }

  handleDelete(e, block, cell) {
    const sel = window.getSelection();
    if (!sel.isCollapsed || cell || !block) return;
    if (block.dataset.type === 'code' || block.dataset.type === 'table') return;
    if (!this.isCaretAtEnd(block)) return;
    const next = block.nextElementSibling;
    if (!next) return;
    e.preventDefault();
    if (next.dataset.type === 'hr') { next.remove(); this.hCoalesce = false; this.flush(); return; }
    if (next.dataset.type === 'table' || next.dataset.type === 'code') return false;
    this.mergeForward(block, next);
  }

  /**
   * 代码/公式块内的退格。codeNewline 换行时垫了「<br> + 零宽空格」，
   * 新行行首退格时浏览器会先吃掉看不见的零宽空格 —— 用户感觉按了没反应。
   * 这里识别该形态自己删：返回 true 表示已处理（调用方 preventDefault）。
   */
  codeBackspace() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== 3) return false;
    const off = r.startOffset;
    const v = node.nodeValue;

    /* 光标停在整块的末尾、前一个字符是换行：那是「末尾空行」。
       浏览器对这种位置的退格会跳过末尾的换行，直接删掉上一行最后一个字
       （实测 `line1\nline2\n` 末尾退格删掉的是 `2`）。自己删这个换行。 */
    if (off === v.length && off > 0 && v[off - 1] === '\n') {
      node.nodeValue = v.slice(0, off - 1);
      const rng = document.createRange();
      rng.setStart(node, off - 1);
      rng.collapse(true);
      sel.removeAllRanges();
      sel.addRange(rng);
      this.hCoalesce = false;
      return true;
    }

    // 前一个字符是零宽空格（行首垫片）：删掉它并接回上一行
    if (off > 0 && v[off - 1] === ZWSP) {
      const atLineStart = off === 1 && (!v.slice(0, off - 1).length);
      node.nodeValue = v.slice(0, off - 1) + v.slice(off);
      const br = atLineStart ? node.previousSibling : null;
      if (atLineStart && br && br.nodeName === 'BR') {
        /* 先把 br 之前的节点取出来再动手：两边都 remove 之后
           node.previousSibling 是 null、node.parentNode 也是 null，
           caretToPrevLine 两个分支都落空，光标会被甩到整块开头的
           「块外」位置 —— 用户看到的就是「退格一下跑上面去了」。 */
        const prevNode = br.previousSibling;
        br.remove();
        if (!node.nodeValue) node.remove();
        this.caretToPrevLine(prevNode, r.startContainer);
      } else {
        const rng = document.createRange();
        rng.setStart(node, off - 1);
        rng.collapse(true);
        sel.removeAllRanges();
        sel.addRange(rng);
      }
      this.hCoalesce = false;
      return true;
    }

    // 光标在节点最前、前一个兄弟就是 <br>：删 <br> 接行
    if (off === 0 && node.previousSibling && node.previousSibling.nodeName === 'BR') {
      const br = node.previousSibling;
      br.remove();
      this.caretToPrevLine(node.previousSibling, node);
      this.hCoalesce = false;
      return true;
    }
    return false;
  }

  /** 删掉换行后把光标放到上一行末尾（prev = 被删位置前的节点） */
  caretToPrevLine(prev, removed) {
    const sel = window.getSelection();
    const rng = document.createRange();
    if (prev && prev.nodeType === 3) rng.setStart(prev, prev.nodeValue.length);
    else if (prev) { rng.selectNodeContents(prev); rng.collapse(false); }
    else if (removed && removed.parentNode) rng.setStart(removed.parentNode, 0);
    else return;
    rng.collapse(true);
    sel.removeAllRanges();
    sel.addRange(rng);
  }

  /**
   * 带边界的块的方向键出口：光标已经在**块内最后一个可编辑位置**时，
   * ↓ 与 → 把光标送到块外（表格最后一格、代码块 / 公式块末行、引用与提示块末行、
   * 列表最后一项）。没有这条路的话，这些块只能靠鼠标点击才能离开。
   *
   * ↓ 与 → 共用同一个出口（caretAfterBlock）。**方向键绝不改文档**：块后已经有
   * 空段落就停进去，没有就只记一个一次性的「块后待插入」状态，等用户按回车
   * 或开始输入时才把空行建出来。出块就先插一行会让标签变脏、撤销栈凭空多一条，
   * 用户只是移动光标而已。
   */
  handleArrow(e, block, cell) {
    const exit = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    if (cell) {
      /* ↑↓ 在格之间是「同一列上下走」。不接管的话浏览器按**阅读顺序**跳
         （↓ 从中间格跑到右边一格），和 → 一模一样 —— 用户报的就是这个。 */
      const info = this.tableInfo();
      if (!info) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return this.arrowInCell(e, info);
      if (!exit) return;
      if (!this.atTableExit(info)) return;
      e.preventDefault();
      this.caretAfterBlock(info.block);
      return;
    }
    if (!exit) {
      /* ↑ 的「入口」：见 arrowIntoBlock。Shift+↑ 是扩选区，Ctrl/Cmd/Alt 组合
         各有含义，一律不接管；其余情况浏览器本来就对，插一手只会弄丢折行、
         滚动和按列对齐。 */
      if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.arrowIntoBlock(e, block);
      }
      return;
    }
    if (!block) return;
    if (!this.endsBounded(block)) {
      /* 紧跟着一条分割线：它本身没有光标位，光标停在上面那一行的末尾按 ↓
         就再也没有下文（分割线落在文末时尤其明显）。这里只是「穿过一条线」：
         线下面有正文就直接落进去；线在文末则保持光标不动、只记下「线后待插入」，
         等用户真的按回车才在线下开一行。 */
      const after = block.nextElementSibling;
      if (e.key === 'ArrowDown' && after && after.dataset.type === 'hr'
        && this.isCaretAtEnd(block)) {
        e.preventDefault();
        const target = after.nextElementSibling;
        if (target) this.placeCaretStart(target);
        else this.caretAfterBlock(after);
      }
      return;
    }
    if (!this.isCaretAtEnd(block)) return;
    e.preventDefault();
    this.caretAfterBlock(block);
  }

  /**
   * ↑ 从「块后一行」回到带边界的块里。
   *
   * 1.2.7 只修了出口（↓/→ 在块末出块），入口一直交给浏览器。code / math
   * 正文末尾那个裸 `\n` 不生成可点击行，浏览器从下一块往回找「上一行」时
   * 找不到落点，于是**整块跳过**，落到更前面一块 —— 用户看到的就是
   * 「光标在代码块后一行按 ↑，跑到了代码块前面那个块」。
   *
   * 只在浏览器确实会跳块的条件下接管：前一块是 code/math、末尾有不可见
   * `\n`、光标在当前块的第一视觉行。没有这个尾行时实测浏览器能正常进块
   * （见 test/wysiwyg.html 的对照组），不该抢。
   *
   * ⛔ 绝不改文档：只 preventDefault + 摆光标，和出口的「方向键零改动」
   * 契约一致；出块状态 `gapAfter` 由 handleKey 开头按非写入键清掉。
   */
  arrowIntoBlock(e, block) {
    if (!block) return false;
    const prev = block.previousElementSibling;
    if (!prev || (prev.dataset.type !== 'code' && prev.dataset.type !== 'math')) return false;
    const { host, end, invisibleNL } = this.visibleEnd(prev);
    if (!invisibleNL || !this.onFirstVisualLine(block)) return false;
    e.preventDefault();
    this.placeCaretAtColumn(prev, host, end, this.caretX(block));
    return true;
  }

  /** 光标是不是在当前块的第一视觉行（折行长段落的第二行往上不该出块） */
  onFirstVisualLine(block) {
    const sel = window.getSelection();
    const cr = sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : null;
    if (!cr) return true;      // 空段落只有 <br>，没有 rect，它本身就是第一行
    const t = textEl(block);
    const tr = t.getClientRects()[0];
    if (!tr) return true;
    const cs = getComputedStyle(t);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6 || 20;
    return cr.top - tr.top < lh * 0.6;
  }

  /** 当前光标的屏幕 x；空段落没有 rect 时退回宿主左边缘 */
  caretX(block) {
    const sel = window.getSelection();
    const cr = sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : null;
    return cr ? cr.left : textEl(block).getBoundingClientRect().left;
  }

  /**
   * 把光标放进带边界块的**最后一个可见行**，按屏幕 x 对齐（和浏览器原生 ↑
   * 的语义一致），而不是无脑丢到行尾。先量「可见末尾」那一行的中线，再用
   * caretRangeFromPoint 问浏览器这个 x 该落在哪两个字符之间；问不到或落到
   * 块外就退回可见末尾，宁可少对齐一列也不能把光标甩进别的块。
   */
  placeCaretAtColumn(block, host, end, x) {
    const p = caretPoint(host, end);
    if (!p) { this.placeCaretEnd(block); return; }
    const anchor = document.createRange();
    try { anchor.setStart(p.node, p.offset); } catch { this.placeCaretEnd(block); return; }
    anchor.collapse(true);
    const cr = anchor.getClientRects()[0] || anchor.getBoundingClientRect();
    let hit = null;
    if (cr && cr.height > 0 && typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, cr.top + cr.height / 2);
      if (r && (r.startContainer === host || host.contains(r.startContainer))) hit = r;
    }
    if (hit) {
      hit.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(hit);
    } else {
      placeCaret(p.node, p.offset);
    }
  }

  /**
   * 这一块是不是「带边界的块」的**最后一行**。带边界的块把光标包在结构里，
   * 走到最后一个可编辑位置之后，下一行已经不在块内 —— 只有它们需要出口：
   *
   *   表格（最后一格）/ 代码块 / 公式块 / 引用 / 提示块 / 列表
   *
   * 引用与提示块一行一块，组内还有下一行时交给浏览器：它知道换行折了几行、
   * 要不要顺手滚动，我们插一手只会更差。列表同理（下一项还是 li 就不管）。
   * `data-bq-tail` 正是「这一行后面还跟着同一组的引用行」，renumber() 维护。
   */
  endsBounded(block) {
    const type = block.dataset.type;
    if (type === 'code' || type === 'math') return true;
    if (type === 'bq') return !block.dataset.bqTail;
    if (type === 'li') {
      const next = block.nextElementSibling;
      return !(next && next.dataset && next.dataset.type === 'li');
    }
    /* 表格靠上面的 cell 分支处理：块本身不长光标位，这里再放行会让
       光标在表格根节点上乱跑 */
    return false;
  }

  /* ---------------- 块后待插入：状态与可见提示 ---------------- */

  /** 唯一的状态写入口：状态与那条插入指示线同生共死，不许再散落赋值 */
  setGapAfter(block) {
    this.gapAfter = block ? { block } : null;
    this.syncGapHint();
  }

  clearGapAfter() { this.setGapAfter(null); }

  /**
   * 把「按回车会在哪儿开一行」画出来。参考 Notion 的块间插入线：光标即使被
   * 送进了下一块，线仍然钉在**出块那一块的底边**，用户一眼就知道插入点在
   * 两块之间，不是在光标现在站着的那一块里。纯视图层，不进序列化、不改文档。
   */
  syncGapHint() {
    const hint = this.gapHint;
    if (!hint) return;
    const gap = this.gapAfter;
    const block = gap && gap.block;
    /* 块被窗口化重铺 / 整篇重渲染后就成了游离节点，提示必须跟着作废 */
    if (!block || !block.isConnected || block.parentElement !== this.root) {
      hint.style.display = 'none';
      return;
    }
    const host = hint.parentElement;
    if (!host) { hint.style.display = 'none'; return; }
    const r = block.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    /* 滚出视口就别把线画到容器外面；状态留着，滚回来线会自己出现 */
    if (r.bottom < h.top || r.top > h.bottom) { hint.style.display = 'none'; return; }
    const label = hint.querySelector('.w-gap-hint-label');
    if (label) label.textContent = tt('按 Enter 在此插入一行');   // 切语言后下一轮就跟上
    /* 先显示才量得到标签宽度：双栏窄编辑区里它可能比块还宽。把容器至少撑到
       「标签 + 24px」，左边的线才不会被挤没（见 styles.css 的 .w-gap-hint）。 */
    hint.style.display = 'flex';
    const labelW = label ? label.getBoundingClientRect().width : 0;
    hint.style.top = (r.bottom - h.top) + 'px';
    hint.style.left = (r.left - h.left) + 'px';
    hint.style.width = Math.max(r.width, labelW + 24) + 'px';
  }

  /**
   * Ctrl/Cmd+Enter：Typora 式「强制插入新行」，一步到位，不用先按方向键出块。
   * ⛔ **只在带边界块内最后一个可编辑位置生效**：在代码块中间按会把代码
   *    劈成两段，在普通段落里按更是无的放矢（那里按回车本来就能开行）。
   *    不满足条件时连浏览器默认行为一起拦掉，文档一个字都不改。
   * 与 gapAfter 无关：这是一条独立的、确定性的命令。
   */
  insertLineBelow() {
    const cell = this.currentCell();
    if (cell) {
      const info = this.tableInfo();
      if (!info || !this.atTableExit(info)) return false;
      return this.forceGapAfter(info.block);
    }
    const block = this.currentBlock();
    if (!block || !this.endsBounded(block) || !this.isCaretAtEnd(block)) return false;
    return this.forceGapAfter(block);
  }

  /** 保证 block 后面有一个可写的空段落：已有就复用，没有才新建并落库 */
  forceGapAfter(block) {
    const next = block.nextElementSibling;
    if (next && (next.dataset.type || 'p') === 'p' && this.isEmptyBlock(next)) {
      this.clearGapAfter();
      this.placeCaretStart(next);
      return true;
    }
    const p = this.insertEmptyAfter(block);
    this.clearGapAfter();
    this.placeCaretStart(p);
    this.flush();
    return true;
  }

  /**
   * 带范围的块（表格 / 代码块 / 公式块 / 引用 / 列表）的末尾不长光标位，
   * → / ↓ 得把人送出去。**但方向键只是移动光标，绝不改文档**：
   *
   *   1. 块后已经是空段落 —— 直接停进去，本来就有落脚点；
   *   2. 块后还有能站人的块 —— 落到它开头（光标确实离开了块），同时记下
   *      「块后还缺一行」；
   *   3. 块后什么都没有，或紧跟着没有光标位的分割线 —— 光标保持不动，
   *      同样只记下「块后还缺一行」。
   *
   * 第 2/3 条的 `gapAfter` 是一次性状态：用户按回车或开始输入时，
   * `materializeGap()` 才在块与下一块之间插入真段落。这样既保住了
   * 「出块后回车就能加一个空行」，又不会让按一下方向键就多一个空行、
   * 标签变脏、撤销栈凭空多一条。
   *
   * ⛔ 别用「临时占位块」或把 Range 悬在子节点间隙来假装有一行：前者会在
   * 窗口化重铺 / 切标签时消失，后者在 WebView2 里回车会被吞、打字会被
   * 吸回表格最后一格。要落脚点就建真段落，且只在该建的时候建。
   */
  caretAfterBlock(block) {
    const next = block.nextElementSibling;
    if (next && (next.dataset.type || 'p') === 'p' && this.isEmptyBlock(next)) {
      this.clearGapAfter();
      this.placeCaretStart(next);
      return;
    }
    this.setGapAfter(block);
    if (next && next.dataset.type !== 'hr') this.placeCaretStart(next);
  }

  /**
   * 兑现「块后待插入」：插一个真段落、把光标放进去、flush 对齐
   * records / 序列化 / 撤销 / 脏标记。只在用户真的要写入时调用。
   * 返回 null 表示状态已失效（块被重铺掉了），调用方按常规处理这次按键。
   */
  materializeGap() {
    const gap = this.gapAfter;
    this.clearGapAfter();
    if (!gap) return null;
    const block = gap.block;
    if (!block || !block.isConnected || block.parentElement !== this.root) return null;
    const p = this.insertEmptyAfter(block);
    this.placeCaretStart(p);
    this.flush();
    return p;
  }

  /* ---------------- 结构操作 ---------------- */

  setIndent(block, n) {
    block.dataset.indent = String(Math.max(0, Math.min(MAX_INDENT, n)));
    block.style.setProperty('--li-indent', block.dataset.indent);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
    this.placeCaretEnd(block);
  }

  setQuoteLevel(block, n) {
    block.dataset.indent = String(Math.max(0, Math.min(MAX_INDENT, n)));
    block.style.setProperty('--bq-indent', block.dataset.indent);
    this.hCoalesce = false;
    this.flush();
    this.placeCaretEnd(block);
  }

  /** 当前块改成指定类型的提示块；已是该类型则退回普通引用，普通引用则原地升级 */
  setCallout(type) {
    const block = this.currentBlock();
    if (!block) return;
    if (block.dataset.type === 'bq') {
      if (block.dataset.callout === type) { this.clearCallout(block); return; }
      const title = block.dataset.calloutTitle || '';
      const prevCo = block.dataset.callout || '';
      block.dataset.callout = type;
      const old = block.querySelector('.w-co-head');
      const head = mkCalloutHead(type, title);
      if (old) old.replaceWith(head);
      else block.insertBefore(head, block.firstChild);
      if (title) block.dataset.calloutTitle = title;
      /* 续行跟着换色：否则改了类型，下面的正文还染着旧色 */
      if (prevCo) this.eachCoFollow(block, prevCo, type);
      this.hCoalesce = false;
      this.flush();
      this.placeCaretEnd(block);
      return;
    }
    /* 段落/标题/列表/代码块 → 提示块，内容跟过去（convertBlock 统一按行搬） */
    this.convertBlock('bq', { callout: type });
  }

  /** 遍历紧跟在 block 之后、属于同一个提示块的续行；to 为空表示摘掉染色 */
  eachCoFollow(block, co, to) {
    let n = block.nextElementSibling;
    while (n && n.dataset && n.dataset.type === 'bq' && n.dataset.coFollow === co) {
      if (to) n.dataset.coFollow = to;
      else delete n.dataset.coFollow;
      n = n.nextElementSibling;
    }
  }

  /** 取消提示块样式，退回普通引用 —— 引用本身留着（右键「普通」走这条） */
  clearCallout(block = this.currentBlock()) {
    if (!block || block.dataset.type !== 'bq' || !block.dataset.callout) return;
    const co = block.dataset.callout;
    const title = block.dataset.calloutTitle || '';
    const body = inlineToMd(textEl(block));
    delete block.dataset.callout;
    delete block.dataset.calloutTitle;
    block.querySelector('.w-co-head')?.remove();
    this.eachCoFollow(block, co, '');
    /* 标题文字原来只存在 data-callout-title 里：摘掉提示块得把它放回正文，
       否则用户写的标题凭空消失。标题与正文并存时按两行引用留下 */
    const parts = [title, body].filter((s) => s && s.trim());
    const t = textEl(block);
    t.innerHTML = parts.length ? inlineHtml(parts[0]) : '';
    ensurePlaceholder(t);
    let anchor = block;
    for (let i = 1; i < parts.length; i++) {
      const nb = mkQuote(parts[i], 0);
      anchor.after(nb);
      anchor = nb;
    }
    this.renumber();
    this.hCoalesce = false;
    this.flush();
    this.placeCaretEnd(block);
  }

  /* ---------------- 标题的 ### 标记 ----------------
   * 在标题行首按退格，不会立刻把标题级别砍掉，而是先把 `###` 亮出来（正文一个字都不动），
   * 再按一次删掉一个 #，一级一级往回退，删光了才退回正文。这样：
   *   · 「改标题级别」从一次误操作变成可控的逐级倒退；
   *   · 手滑退格不会把整行文字和级别一起弄丢；
   *   · 标记只是视觉层，不进 .w-text、不进 Markdown，序列化天然不受影响。
   */

  /** 块里的 ### 标记（处于明文态时才有） */
  hashEl(block) {
    if (!block) return null;
    for (const n of block.children) if (n.classList && n.classList.contains('w-hash')) return n;
    return null;
  }

  hashesOf(block) {
    const h = this.hashEl(block);
    return h ? (h.textContent.match(/#/g) || []).length : 0;
  }

  /** 标题退回正文：原地改类型不换节点，光标与块下标都不受影响 */
  degradeHeading(block) {
    block.dataset.type = 'p';
    block.classList.remove('w-h');
    block.classList.add('w-p');
  }

  /** 第一次退格：把 ### 亮出来，级别与正文都不动 */
  showHashes(block) {
    if (this.hashEl(block)) return;
    const lvl = +(block.dataset.type || 'h1')[1] || 1;
    const h = document.createElement('span');
    h.className = 'w-hash';
    h.contentEditable = 'false';
    h.textContent = '#'.repeat(lvl);
    block.insertBefore(h, textEl(block));
  }

  /** 退格删掉一个 #：降一级；删光了就退回正文 */
  demoteHeading(block) {
    const h = this.hashEl(block);
    if (!h) return;
    const lvl = this.hashesOf(block);
    if (lvl > 1) {
      h.textContent = '#'.repeat(lvl - 1);
      block.dataset.type = 'h' + (lvl - 1);
      this.hCoalesce = false;
      this.flush();
      return;
    }
    h.remove();
    this.degradeHeading(block);
    this.hCoalesce = false;
    this.renumber();
    this.flush();
  }

  /** 收起标记（回车、光标离开这个块）。标记本身不是内容，所以不必 flush */
  hideHashes(block) {
    const h = this.hashEl(block);
    if (!h) return false;
    h.remove();
    // 标题被删空了就别留着一条没有文字的横线
    if (block.dataset.type !== 'p' && this.isEmptyBlock(block) && !textEl(block).querySelector('img')) {
      this.degradeHeading(block);
      return true;              // 类型变了 = Markdown 变了，调用方记得 flush
    }
    return false;
  }

  /** 光标已经不在的块：把标记全部收回去 */
  collapseHashes() {
    if (this.silent || !this.root.isConnected) return;
    const marks = this.root.querySelectorAll('.w-hash');
    if (!marks.length) return;
    const cur = this.currentBlock();
    let changed = false;
    for (const h of marks) {
      const b = h.closest('.w-block');
      if (b && b !== cur && this.hideHashes(b)) changed = true;
    }
    if (changed) {
      this.hCoalesce = false;
      this.renumber();
      this.flush();
    }
  }

  /** 把块换成段落，保留行内内容与光标位置 */
  toParagraph(block, caretOffset = null) {
    const t = textEl(block);
    const off = caretOffset == null ? offsetIn(t) : caretOffset;
    const p = mkPara('');
    const pt = textEl(p);
    pt.innerHTML = '';
    while (t.firstChild) pt.appendChild(t.firstChild);
    ensurePlaceholder(pt);
    block.replaceWith(p);
    setCaretOffset(pt, off);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  /** 回车拆分：光标前留在当前块，光标后进入新块（保留行内样式）。
      `batch` = 调用方要连着拆好几刀（批量粘贴），收尾的 renumber / flush 由它自己
      做一次 —— 逐行 flush 在万块文档上是一次几百毫秒的全量序列化。 */
  splitBlock(block, batch = false) {
    const type = block.dataset.type;

    // 空标题：在空白标题里回车 = 我要写正文
    if (/^h[1-6]$/.test(type) && this.isEmptyBlock(block)) {
      this.toParagraph(block, 0);
      return;
    }
    // 空列表项：退出列表，同理
    // 空引用 / 空提示块**不退出**：回车是在下面继续写一行引用，块本身不该
    // 静悄悄变成段落（提示块的类型、配色会跟着一起丢）。退出引用有两条现成的路：
    // 行首退格、→ 在块末出块。
    if ((type === 'li' || type === 'bq') && this.isEmptyBlock(block)) {
      const ind = +block.dataset.indent || 0;
      if (type === 'li' && ind > 0) { this.setIndent(block, ind - 1); return; }
      if (type === 'bq' && ind > 0) { this.setQuoteLevel(block, ind - 1); return; }
      if (type === 'li') { this.toParagraph(block, 0); return; }
    }

    const t = textEl(block);
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    const tail = range.cloneRange();
    tail.selectNodeContents(t);
    tail.setStart(range.endContainer, range.endOffset);
    const frag = tail.extractContents();
    if (!t.textContent && !t.querySelector('img')) t.innerHTML = '<br>';

    const nb = this.nextBlockFor(block);
    const nt = textEl(nb);
    nt.innerHTML = '';
    nt.appendChild(frag);
    ensurePlaceholder(nt);

    block.after(nb);
    // 提示块（callout）的续行：给新行染上同一色，视觉上还是同一个框。
    // 纯展示标记 —— 序列化只认 data-callout，不会把 [!x] 写重
    if (type === 'bq') {
      if (block.dataset.callout) nb.dataset.coFollow = block.dataset.callout;
      else if (block.dataset.coFollow) nb.dataset.coFollow = block.dataset.coFollow;
    }
    this.placeCaretStart(nb);
    if (batch) return;          // 连着拆：由调用方统一收尾
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  nextBlockFor(block) {
    const type = block.dataset.type;
    if (type === 'li') {
      return mkLi(block.dataset.list || 'ul', '', +block.dataset.indent || 0);
    }
    if (type === 'bq') return mkQuote('', +block.dataset.indent || 0);
    return mkPara('');
  }

  /** 退格合并：把当前块内容并入上一块，光标停在接缝处 */
  mergeBack(block, prev) {
    const pt = textEl(prev);
    const ct = textEl(block);
    while (pt.lastChild && pt.lastChild.nodeName === 'BR') pt.removeChild(pt.lastChild);
    const joinAt = pt.textContent.length;
    while (ct.firstChild) {
      const n = ct.firstChild;
      if (n.nodeName === 'BR') { ct.removeChild(n); continue; }
      pt.appendChild(n);
    }
    block.remove();
    /* 两个空段落合并时，双方的占位 <br> 都被上面的循环跳过了，pt 会一个子节点
       都不剩 —— .w-text 没有行盒就塌成 0 高。视觉上像「一次删了两行」，下一次
       退格还会因为光标无处落脚而甩进更前面那个块（标题里就表现为光标跑到标题
       前面、还亮出 ###）。空块必须留一个占位 <br> 撑住行高与落点。 */
    ensurePlaceholder(pt);
    setCaretOffset(pt, joinAt);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  /** Delete 合并：把下一块并入当前块 */
  mergeForward(block, next) {
    const ct = textEl(block);
    const nt = textEl(next);
    while (ct.lastChild && ct.lastChild.nodeName === 'BR') ct.removeChild(ct.lastChild);
    const joinAt = ct.textContent.length;
    while (nt.firstChild) {
      const n = nt.firstChild;
      if (n.nodeName === 'BR') { nt.removeChild(n); continue; }
      ct.appendChild(n);
    }
    next.remove();
    setCaretOffset(ct, joinAt);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  removeBlock(block) {
    const prev = block.previousElementSibling || block.nextElementSibling;
    block.remove();
    if (prev) this.placeCaretEnd(prev);
    else this.root.appendChild(mkPara(''));
    this.renumber();   // 删块可能改变相邻引用的 data-bq-tail（编号同理）
    this.hCoalesce = false;
    this.flush();
  }

  /**
   * 引用整组是一个逻辑块：从组首一路到下一个「空行断出的独立引用」或别的块之前。
   * 别的类型就是自己一块。bqStart 只打在独立引用上（parseMarkdown / buildRecords
   * 两处判据相同），所以「前一块是 bq 且自己没有 bqStart」就是续行。
   *
   * 一行文字仍可各自编辑，但手柄、转换、删除都拿整组当操作单元 —— 组内某一行
   * 不许再被单独改类型或删成半截引用。序列化与虚拟滚动记录保持一行一块不动。
   */
  bqGroupOf(block) {
    if (!block) return [];
    if (block.dataset.type !== 'bq' || !this.root.contains(block)) return [block];
    let first = block;
    while (!first.dataset.bqStart) {
      const p = first.previousElementSibling;
      if (!p || p.dataset.type !== 'bq') break;
      first = p;
    }
    const group = [first];
    let b = first;
    while (b.nextElementSibling && b.nextElementSibling.dataset.type === 'bq'
      && !b.nextElementSibling.dataset.bqStart) {
      b = b.nextElementSibling;
      group.push(b);
    }
    return group;
  }

  /** 块级删除：普通块删一块，引用删整组，表格 / 代码块删整块。
   *  光标落到相邻块末尾；删光了就补一个空段落并站进去。 */
  deleteBlock(block = null) {
    if (!block) block = this.currentBlock();
    if (!block || !this.root.contains(block)) return;
    const group = this.bqGroupOf(block);
    const first = group[0];
    const last = group[group.length - 1];
    const prev = first.previousElementSibling || last.nextElementSibling;
    for (const b of group) b.remove();
    if (prev && prev.isConnected) this.placeCaretEnd(prev);
    else this.placeCaretStart(this.root.appendChild(mkPara('')));
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  codeNewline() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    r.deleteContents();

    // 用 <br> 表示换行。不能往文本节点里塞 '\n'：Chromium 会在下一次输入时
    // 把行尾的 '\n' 规整掉，光标就漂到换行前面去了。序列化时把 <br> 还原成 '\n'。
    // 后面再跟一个零宽空格：否则行尾的 <br> 会被当成占位符，接着输入又跑回上一行。
    const br = document.createElement('br');
    r.insertNode(br);
    const tail = document.createTextNode(ZWSP);
    br.after(tail);
    const after = document.createRange();
    after.setStart(tail, 1);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    this.hCoalesce = false;
    this.flush();
  }

  /** 光标是否落在「只能放原文的块」里（代码块 / 公式块）—— 粘贴要区别对待。
      只看真正的正文宿主（.w-code / .w-tex）：点语言条那种 contenteditable=false
      的装饰层不算，否则会往一个不可写的地方塞节点。 */
  caretInRawBlock() {
    const block = this.currentBlock();
    if (!block) return false;
    const type = block.dataset.type;
    if (type !== 'code' && type !== 'math') return false;
    const host = textEl(block);
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const node = sel.getRangeAt(0).startContainer;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && host.contains(el));
  }

  /** 把一段原文插到光标处（代码块 / 公式块内部的粘贴）。
      换行一律用 <br>，理由同 codeNewline：往文本节点里塞 '\n'，Chromium 下一次
      输入会把行尾那个吃掉，光标漂到换行前面。末尾再垫一个零宽空格，否则以换行
      结尾的粘贴会让光标停在行尾的 <br> 上，接着打字跑回上一行。 */
  insertRawText(text) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    /* 空块里只有一个占位 <br>：先摘掉再插，否则粘进来的内容前面会多一个空行
       （序列化时那个 <br> 就是一次换行）。空块里光标只可能在开头，所以直接归位。 */
    const block = this.currentBlock();
    const host = block ? textEl(block) : null;
    if (host && host.childNodes.length === 1 && host.firstChild.nodeName === 'BR') {
      host.textContent = '';
      const atStart = document.createRange();
      atStart.selectNodeContents(host);
      atStart.collapse(true);
      sel.removeAllRanges();
      sel.addRange(atStart);
    }
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const frag = document.createDocumentFragment();
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((ln, i) => {
      if (i) frag.appendChild(document.createElement('br'));
      if (ln) frag.appendChild(document.createTextNode(ln));
    });
    const tail = document.createTextNode(ZWSP);
    frag.appendChild(tail);
    r.insertNode(frag);       // insertNode 会把 frag 的孩子搬走，tail 的引用不受影响
    const after = document.createRange();
    after.setStart(tail, tail.nodeValue.length);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    this.hCoalesce = false;
    this.flush();
  }

  /** 有序列表重新编号（每个连续 run 各自从头算，嵌套层级各自计数）。
   *  顺手维护引用组的 data-bq-tail（前行是否紧跟一条未断开的引用，
   *  CSS 拿它折叠引用框 —— 不能用 :has(+ ...)，见 styles.css 的说明）。
   *  所有结构变化路径都会调用本方法，这里注解零额外扫描成本。 */
  renumber() {
    /* 视口模式：编号在所有记录上算（窗口外的块也要正确），只把结果套回窗口 */
    if (this.virtual) { this._renumberVirtual(); return; }
    let counters = [];
    for (const b of this.root.children) {
      if (b.dataset.type === 'bq') {
        const nx = b.nextElementSibling;
        if (nx && nx.dataset.type === 'bq' && !nx.dataset.bqStart) b.dataset.bqTail = '1';
        else delete b.dataset.bqTail;
      }
      if (b.dataset.type !== 'li') { counters = []; continue; }
      if (b.dataset.list !== 'ol') continue;
      const ind = +b.dataset.indent || 0;
      counters.length = ind + 1;
      if (counters[ind] == null) counters[ind] = +(b.dataset.start || 1);
      else counters[ind] += 1;
      const num = counters[ind];
      b.dataset.num = String(num);
      /* marker 永远是首孩子（mkLi 先造它）——命中就不必 querySelector，
         万行文档 li 数以万计，这个查询在载入路径上是白扔的时间 */
      let m = b.firstElementChild;
      if (!m || !m.classList.contains('w-li-marker')) m = b.querySelector('.w-li-marker');
      if (m && m.textContent !== num + '.') m.textContent = num + '.';
    }
  }

  /* ---------------- 行内格式 ---------------- */

  /** 选区是否老老实实待在某一个单元格里。是就返回那个单元格，否则 null。
   *
   *  行内格式**可以**在单元格里套（`**张三**`、`==张三==` 在 Markdown 表格里合法，
   *  解析与序列化两头都认），但只能在**同一格**里：跨格 extractContents 会把
   *  `<td>` 一起搬进 `<mark>`，表格当场散架。以前这里一刀切全禁，结果是
   *  「表格里的字选得中、却加不了粗也高亮不了」。 */
  selInOneCell() {
    const cell = this.currentCell();
    if (!cell) return null;
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    const elOf = (n) => (n.nodeType === 1 ? n : n.parentElement);
    const from = elOf(r.startContainer);
    const to = elOf(r.endContainer);
    if (!from || !to || !cell.contains(from) || !cell.contains(to)) return null;
    return cell;
  }

  /** 行内切换：有选区就包一层，没有就插入零宽占位继续输入 */
  toggleInline(kind) {
    if (this.currentCell() && !this.selInOneCell()) return;   // 跨格不套格式
    const sel = window.getSelection();
    if (!sel.rangeCount || !this.currentBlock()) return;

    const map = { strong: 'bold', em: 'italic', del: 'strikeThrough' };
    if (map[kind]) {
      // 交给浏览器：它自带的开关语义最稳，产出 <b>/<i>/<strike>，序列化能认
      document.execCommand(map[kind]);
      this.hCoalesce = false;
      this.flush();
      return;
    }

    const range = sel.getRangeAt(0);
    const startEl = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const code = startEl && startEl.closest('code');

    if (code) {
      // 取消行内码：把 code 拆回文本
      const text = document.createTextNode(code.textContent);
      const host = code.parentElement;
      code.replaceWith(text);
      this.hCoalesce = false;
      this.flush();
      return;
    }

    if (range.collapsed) {
      const el = document.createElement('code');
      el.textContent = ZWSP;
      range.insertNode(el);
      placeCaret(el.firstChild, 1);
    } else {
      const el = document.createElement('code');
      el.appendChild(range.extractContents());
      range.insertNode(el);
      const after = document.createRange();
      after.setStartAfter(el);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    this.hCoalesce = false;
    this.flush();
  }

  /** 高亮：<mark> ↔ `==文字==`。返回 'on' / 'off' / false（没动）。
   *
   *  不走 execCommand：它只认 hiliteColor/bgColor，产出的是 <span style="background">，
   *  而我们的「文件就是纯文本 Markdown」这条底线要求能序列化回 `==文字==`。
   *  只处理同一段里的选区 —— 跨段取内容会把两段的块结构一起拆散。 */
  toggleMark() {
    /* 单元格里也能高亮，但只限单格内 —— 跨格会把表格结构拆散（同 toggleInline） */
    const cell = this.currentCell();
    if (cell && !this.selInOneCell()) return false;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const block = cell || this.currentBlock();
    if (!block) return false;
    const range = sel.getRangeAt(0);
    const elOf = (n) => (n.nodeType === 1 ? n : n.parentElement);
    const from = elOf(range.startContainer);
    const to = elOf(range.endContainer);
    if (!from || !to || !block.contains(from) || !block.contains(to)) return false;

    /* 判断「已经在 mark 里」不能只看端点落在哪个元素：拖选一个高亮词时，起点常常
       停在它前面那个文本节点的末尾，closest('mark') 是空的。改成看选中文字本身
       和 mark 的文字是否一致 —— 一致就是「整块选中」，脱掉。 */
    const mark = from.closest('mark') || to.closest('mark');
    if (mark) {
      if (mark.textContent.trim() !== String(sel).trim()) return false;  // 只选中半块：不动，免得出 ==== 
      const text = document.createTextNode(mark.textContent);
      mark.replaceWith(text);
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, text.nodeValue.length);
      sel.removeAllRanges();
      sel.addRange(r);
      this.hCoalesce = false;
      this.flush();
      return 'off';
    }
    if (range.collapsed) return false;
    const el = document.createElement('mark');
    el.appendChild(range.extractContents());
    range.insertNode(el);
    const after = document.createRange();
    after.setStartAfter(el);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    this.hCoalesce = false;
    this.flush();
    return 'on';
  }

  /* ---------------- 高亮重复行 ---------------- */

  /** 现在有没有标亮着 —— 直接问 DOM，不另存一份布尔值。
   *
   *  标记只存在于块节点上，而**所有重建都会把节点换掉**：切模式走 _render、
   *  视口搬家走 _windowAt、撤销大文档走 _restoreRecords、整篇替换（大段粘贴）
   *  也走 _render。另存一份的后果就是它跟 DOM 说两套 —— 用户看到的是
   *  「切完模式菜单勾还亮着，点第一次只是把这个勾去掉」。从 DOM 读出来就
   *  永远不会说谎，也不必在每条重建路径上记得补一句复位（漏一条就是同一个 bug）。 */
  get dupOn() { return !!this.root.querySelector('.w-dup'); }

  /** 把「内容出现不止一次」的块标出来，返回标了多少块。
   *
   *  按块算而不是按行算：代码块是「一个块十行」，行级标记在 DOM 里落不下去；
   *  而这里的「一块」正是编辑时的一行（代码块 / 表格除外）。
   *  视口渲染的大文档只标当前可见的那些块 —— 看不见的部分标了也没人看见。 */
  paintDuplicates() {
    this.clearDuplicates();
    const groups = new Map();
    for (const b of this.root.children) {
      const t = (b.textContent || '').trim();
      if (!t) continue;
      const g = groups.get(t);
      if (g) g.push(b); else groups.set(t, [b]);
    }
    let n = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const b of g) { b.classList.add('w-dup'); n++; }
    }
    return n;
  }

  clearDuplicates() {
    for (const b of this.root.querySelectorAll('.w-dup')) b.classList.remove('w-dup');
  }

  /** 保留旧接口：菜单里的「加粗/斜体」等通过标记字符串调用 */
  wrapInline(marker) {
    const map = { '**': 'strong', '_': 'em', '`': 'code', '~~': 'del' };
    this.toggleInline(map[marker] || 'strong');
  }

  /* ---------------- 块级命令 ---------------- */

  /** 在光标所在块上切换列表类型；同类型再点一次取消 */
  toggleList(kind) {
    const block = this.currentBlock();
    if (!block) return;
    if (block.dataset.type === 'li') {
      const same = (block.dataset.list || 'ul') === kind;
      if (same) { this.toParagraph(block, null); return; }
      block.dataset.list = kind;
      block.classList.toggle('w-task', kind === 'task');
      if (kind === 'task') {
        const marker = block.querySelector('.w-li-marker');
        if (marker) {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'w-check';
          cb.tabIndex = -1;
          cb.contentEditable = 'false';
          marker.replaceWith(cb);
        }
      } else {
        const cb = block.querySelector('.w-check');
        if (cb) {
          const m = document.createElement('span');
          m.className = 'w-li-marker';
          m.contentEditable = 'false';
          m.textContent = kind === 'ol' ? '1.' : '•';
          cb.replaceWith(m);
        }
      }
      this.renumber();
      this.hCoalesce = false;
      this.flush();
      this.placeCaretEnd(block);
      return;
    }

    /* 段落/标题/引用/代码块 → 列表，内容跟过去（代码块按行拆成一个条目一行） */
    this.convertBlock('li', { list: kind });
  }

  /** 标题级别：0 = 正文 */
  toggleHeading(level) {
    const block = this.currentBlock();
    if (!block) return;
    const cur = block.dataset.type;
    if (cur === 'table' || cur === 'hr') return;
    const target = level === 0 ? 'p' : 'h' + level;
    if (cur === target) {
      // 同级标题再点一次 = 退回正文（原地搬行内节点，光标位置不跳）
      if (level !== 0) this.toParagraph(block, null);
      return;
    }
    /* 代码块/公式是多行块，转标题或正文得按行拆开，压成一行等于丢内容；
       其余块统一按 Markdown 源搬家 —— 用 textContent 会把 **加粗** 这类
       行内格式削掉。退回正文这条走原地搬节点，光标位置不跳 */
    if (level === 0) {
      if (cur === 'code' || cur === 'math') this.convertBlock('p');
      else this.toParagraph(block, null);
      return;
    }
    this.convertBlock(target);
  }

  /** 在当前块之后插入一个新块并聚焦 */
  insertAfter(block, nb) {
    const anchor = block || this.root.lastElementChild;
    if (anchor) anchor.after(nb);
    else this.root.appendChild(nb);
    return nb;
  }

  /**
   * 在光标所在块前/后插入一段 Markdown（「插入目录」走这条）。
   * 用 parseMarkdown 而不是手搓 DOM：块类型、行内结构才能和正常渲染完全一致，
   * 否则插入的列表可能缺 marker、有序列表编号也不对。
   */
  insertMarkdown(md, before = false) {
    const frag = parseMarkdown(md);
    if (!frag.firstChild) return false;
    const block = this.currentBlock();
    if (!block) this.root.appendChild(frag);
    else if (before) block.before(frag);
    else block.after(frag);
    this.renumber();
    this.flush();
    return true;
  }

  /**
   * 把光标所在的块**原地**换成另一种类型，内容跟过去。
   *
   * 「换类型」和「插入一个新块」是两件事。此前：
   *   · 代码块上点「引用」—— 毫无反应（引用那条分支只认段落和标题）；
   *   · 引用上点「代码块」—— 引用原地不动，下面凭空多出一个空代码块。
   * 两个方向都不是用户要的，根子在于每个命令各写了一套「只认某几种源类型」的判断。
   * 这里统一成一条：凡是「一行文本」的块都能互转。
   *
   * 表格与分割线没有可搬的文本，返回 false 由调用方另起新块。
   * 代码块和公式是多行的，转给逐行块（段落/标题/列表/引用）时**按行拆开** ——
   * 压成一行才是真丢内容。
   */
  convertBlock(type, opts = {}) {
    const cur = this.currentBlock();
    if (!cur) return false;
    /* 引用整组是一个逻辑块：光标落在续行上也要连组首一起转，否则第二行会被
       单独改成标题、留下半截引用。别的类型 group 就只有自己，下面与原来等价。 */
    const group = this.bqGroupOf(cur);
    const block = group[0];
    const last = group[group.length - 1];
    const from = block.dataset.type || 'p';
    if (from === 'table' || from === 'hr') return false;
    if (from === type) return false;

    const src = group.map((b) => blockMarkdownText(b)).join('\n');
    /* 只有代码/公式能把多行塞进一个块；其余类型一行一块。
       末尾的空行是代码块那个"空末行"的产物，搬过去只会多出一行空白 */
    let lines;
    if (type === 'code' || type === 'math') lines = [src];
    else {
      lines = src.split('\n');
      while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    }

    const nodes = lines.map((line, i) => {
      switch (type) {
        case 'code':
          return mkCode(line, opts.lang != null ? opts.lang : (from === 'code' ? block.dataset.lang || '' : ''));
        case 'math': return mkMath(line);
        // 只有第一行顶 [!info] 头，其余是续行（见下面的 coFollow）
        case 'bq': return mkQuote(line, 0, i === 0 ? opts.callout || '' : '');
        case 'li': return mkLi(opts.list || 'ul', line, 0, false, 1);
        default: return /^h[1-6]$/.test(type) ? mkHeading(+type[1], line) : mkPara(line);
      }
    });

    /* 换掉之后邻居就找不回来了，先记下整组后面的那块（提示块续行清理要用） */
    const next0 = last.nextElementSibling;
    block.replaceWith(nodes[0]);
    for (let i = 1; i < nodes.length; i++) nodes[i - 1].after(nodes[i]);
    /* 组内其余行一起摘掉：它们是同一个逻辑块的正文，不能留下来当独立块 */
    for (let i = 1; i < group.length; i++) group[i].remove();

    /* 引用组的边界不能因为换类型就凭空消失。原来这两块之间隔着别的东西，
       转成引用后不该被紧凑规则吸进旁边的框 —— 那等于顺手改了另一块的语义。
       两个方向都要管：前一块是引用 → 自己另起一组；后一块是引用 → 把它断开 */
    if (type === 'bq') {
      const pb = nodes[0].previousElementSibling;
      if (pb && pb.dataset && pb.dataset.type === 'bq') nodes[0].dataset.bqStart = '1';
      const nx = nodes[nodes.length - 1].nextElementSibling;
      if (nx && nx.dataset && nx.dataset.type === 'bq' && !nx.dataset.bqStart) nx.dataset.bqStart = '1';
      /* 多行转提示块：后面几行是同一个框的正文续行，不该各顶一个 [!x] 头 */
      if (opts.callout) {
        for (let i = 1; i < nodes.length; i++) nodes[i].dataset.coFollow = opts.callout;
      }
    } else if (from === 'bq' && block.dataset.callout) {
      /* 提示块的头被转走了：紧跟的续行会变成「没有头的染色块」，一并摘掉 */
      const co = block.dataset.callout;
      let n = next0;
      while (n && n.dataset && n.dataset.type === 'bq' && n.dataset.coFollow === co) {
        delete n.dataset.coFollow;
        n = n.nextElementSibling;
      }
    }

    this.placeCaretEnd(nodes[nodes.length - 1]);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
    return true;
  }

  insertBlock(type) {
    const block = this.currentBlock();
    if (type === 'hr') {
      const hr = mkHr();
      this.insertAfter(block, hr);
      const p = mkPara('');
      hr.after(p);
      this.placeCaretStart(p);
      this.hCoalesce = false;
      this.flush();
      this.root.focus();
      setCaretOffset(textEl(p), 0);
      return;
    }
    if (type === 'code' || type === 'math') {
      /* 有内容的块一律原地改类型：在引用上点「代码块」，要的是这段引用变成代码，
         而不是引用不动、下面多一个空代码块。表格/分割线没有文本可搬，才另起新块 */
      if (this.convertBlock(type)) return;
      const nb = type === 'code' ? mkCode('', '') : mkMath('');
      // 空行上直接顶替，别在代码块前留一个空段落
      if (block && block.dataset.type === 'p' && this.isEmptyBlock(block)) block.replaceWith(nb);
      else this.insertAfter(block, nb);
      this.placeCaretStart(nb);
      this.hCoalesce = false;
      this.flush();
      return;
    }
    if (type === 'quote') {
      if (block && block.dataset.type === 'bq') { this.toParagraph(block, null); return; }  // 再点一次取消
      this.convertBlock('bq');
      return;
    }
  }

  /** 插入表格；rows 含表头行 */
  insertTable(rows = 3, cols = 3) {
    const block = this.currentBlock();
    const t = mkTable(rows, cols);
    // 光标停在空行上时直接顶替它，避免表格前面多出一个空段落
    if (block && block.dataset.type === 'p' && this.isEmptyBlock(block)) block.replaceWith(t);
    else this.insertAfter(block, t);
    // 表格落在文档末尾时补一个段落，否则回车/方向键没地方落脚
    if (!t.nextElementSibling) t.after(mkPara(''));
    this.renumber();
    this.hCoalesce = false;
    this.flush();
    this.focusCell(t, 0, 0);
  }

  /* ---------------- 表格 ---------------- */

  tableInfo() {
    const cell = this.currentCell();
    if (!cell) return null;
    const table = cell.closest('table');
    const block = table.closest('.w-block');
    const rows = [...table.querySelectorAll('tr')];
    const row = cell.parentElement;
    return {
      cell, table, block, rows,
      rowIdx: rows.indexOf(row),
      colIdx: [...row.children].indexOf(cell),
      cells: [...table.querySelectorAll('th,td')],
    };
  }

  cellIndex(cell) {
    const table = cell.closest('table');
    return [...table.querySelectorAll('th,td')].indexOf(cell);
  }

  /** 单元格按 `<br>` 切出的「行」区间（字符偏移，左闭右开）。
   *
   *  空单元格里的 `<br>` 是 mkCell 放的光标占位，末尾那个 `<br>` 同理 ——
   *  `tableToMarkdown()` 也是这么判的（没有文字就整格写空）。它们**不算新的一行**：
   *  算进去的话，空格子里按 ↓ 会被当成「格内还有下一行」而放行给浏览器，
   *  浏览器在表格里按阅读顺序走，于是 ↓ 变成往右跳一格。
   *
   *  偏移口径与 setCaretOffset / Range.toString() 一致：`<br>` 不占字符、
   *  零宽空位算 1 个字符。内联元素（<strong>/<mark>…）里的文本用 TreeWalker
   *  按文档顺序累加，不能只看直接子节点。 */
  cellLines(cell) {
    const lines = [];
    let start = 0;
    let end = 0;
    const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = walk.nextNode();
    while (n) {
      if (n.nodeType === 3) end += n.nodeValue.length;
      else if (n.nodeName === 'BR') { lines.push({ start, end }); start = end; }
      n = walk.nextNode();
    }
    lines.push({ start, end });
    /* 只丢最后一个空段：连续两个空段说明用户真的按过 Shift+Enter，
       得留一行给他站。整格只有一个占位 <br> 时丢完也还剩一行。 */
    const last = lines[lines.length - 1];
    if (lines.length > 1 && last.start === last.end) lines.pop();
    return lines;
  }

  /** 指定端点在格内的字符偏移。有选区时要读 focus 端（光标所在），
   *  不能用 range 的 start —— 反向选择时两者不是同一个位置。 */
  cellOffsetAt(cell, node, offset) {
    if (!node || !cell.contains(node)) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(cell);
    try { pre.setEnd(node, offset); } catch { return 0; }
    return pre.toString().length;
  }

  /** 表格右下角那一格、光标又在末尾 —— 这是「↓ / → 出表」唯一的出口 */
  atTableExit(info) {
    if (!info) return false;
    if (info.rowIdx !== info.rows.length - 1) return false;
    if (info.colIdx !== info.cell.parentElement.children.length - 1) return false;
    return this.isCaretAtEnd(info.cell);
  }

  /** 表格里的 ↑↓：**一律自己接管**，绝不交给浏览器默认行为。
   *
   *  单元格没有自己的「行」，浏览器把整张表当一溜行内盒子，↑↓ 走的是
   *  **阅读顺序**（中间格 ↓ 往右跑，和 → 一模一样）。旧版只在「格内没有
   *  下一行」时才 preventDefault，其余情况放行给浏览器做「格内行移动」——
   *  可浏览器在表格里根本不做格内行移动。再加上空单元格的占位 `<br>`
   *  被算成真换行，同一个格子光标在 `<br>` 前 / 后行为还不一样，这就是
   *  用户看到的「有时候上下、有时候左右」。
   *
   *  顺序：格内还有硬换行（Shift+Enter）先走格内那一行；走完了才到同一列的
   *  相邻表格行 —— `tableInfo().rows` 含 thead，表头是第 0 行，↑↓ 都能进出。
   *  到上下边界停住；只有右下角那一格 ↓ 出表（和 → 共用判据）。
   *  Shift+↑/↓ 也走这条纵向路径，用 setBaseAndExtent 把选区扩到目标位置。 */
  arrowInCell(e, info) {
    /* 这一下不能省、也不能只在某些分支做：浏览器默认在表格里就是横向跳。 */
    e.preventDefault();
    const down = e.key === 'ArrowDown';
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const lines = this.cellLines(info.cell);
    const off = this.cellOffsetAt(info.cell, sel.focusNode, sel.focusOffset);
    let li = lines.findIndex((l) => off < l.end);
    if (li < 0) li = lines.length - 1;
    const col = off - lines[li].start;
    const anchor = { node: sel.anchorNode, offset: sel.anchorOffset };

    let target = info.cell;
    let dst;
    if (down ? li < lines.length - 1 : li > 0) {
      dst = lines[li + (down ? 1 : -1)];               // 格内上 / 下一行
    } else {
      const row = info.rows[info.rowIdx + (down ? 1 : -1)];
      if (!row) {
        if (down && this.atTableExit(info)) this.caretAfterBlock(info.block);
        return;                                        // 上下边界：停住
      }
      target = row.children[info.colIdx];
      if (!target) return;
      const dl = this.cellLines(target);
      /* 往下进目标格落在它第一行、往上落在最后一行，行内按同一字符列对齐 */
      dst = dl[down ? 0 : dl.length - 1];
    }
    setCaretOffset(target, dst.start + Math.min(col, dst.end - dst.start));
    if (e.shiftKey && anchor.node && anchor.node.isConnected) {
      const r = sel.getRangeAt(0);
      sel.setBaseAndExtent(anchor.node, anchor.offset, r.startContainer, r.startOffset);
    }
  }

  focusCell(block, row, col) {
    const table = block.querySelector('table');
    const rows = [...table.querySelectorAll('tr')];
    const cell = rows[row] && rows[row].children[col];
    if (!cell) return;
    this.root.focus();
    setCaretOffset(cell, 0);
  }

  moveCell(dir) {
    const info = this.tableInfo();
    if (!info) return;
    const { table, cell } = info;
    let cells = [...table.querySelectorAll('th,td')];
    let idx = cells.indexOf(cell) + dir;
    if (idx >= cells.length) {
      this.addRow('end');
      cells = [...table.querySelectorAll('th,td')];
      idx = cells.indexOf(cell) + dir;
    }
    if (idx < 0) idx = 0;
    if (idx >= cells.length) idx = cells.length - 1;
    const target = cells[idx];
    if (target) setCaretOffset(target, target.textContent.length);
  }

  cellEnter() {
    const info = this.tableInfo();
    if (!info) return;
    const { table, rowIdx, colIdx, rows } = info;
    // 整行都空时回车 = 退出表格，在下方开段落（Typora 约定，和引用/列表的
    // 「空行回车退出」是同一套双击模式）。不然空行回车只会不停加行，出不来。
    const row = rows[rowIdx];
    const rowEmpty = [...row.children].every((c) => !(c.textContent || '').replace(/\u200b/g, '').trim());
    if (rowEmpty) {
      const block = table.closest('.w-block');
      const p = this.insertEmptyAfter(block);
      this.placeCaretStart(p);
      this.flush();
      return;
    }
    if (rowIdx >= rows.length - 1) this.addRow('below');
    const rows2 = [...table.querySelectorAll('tr')];
    const target = rows2[rowIdx + 1] && rows2[rowIdx + 1].children[colIdx];
    if (target) setCaretOffset(target, target.textContent.length);
  }

  /**
   * 插行。pos: 'above' | 'below' | 'end'
   * 落到表头行上时统一插进数据区（表头上方插一行没有意义）
   */
  addRow(pos = 'below') {
    const info = this.tableInfo();
    if (!info) return;
    const { table, cell } = info;
    const cols = table.querySelector('thead tr').children.length;
    const tr = document.createElement('tr');
    for (let i = 0; i < cols; i++) tr.appendChild(mkCell('td', '', this.colAlign(table, i)));

    const tbody = table.querySelector('tbody');
    const curRow = cell.parentElement;
    if (curRow.parentElement.tagName === 'THEAD') tbody.prepend(tr);
    else if (pos === 'above') curRow.before(tr);
    else if (pos === 'end') tbody.appendChild(tr);
    else curRow.after(tr);

    this.hCoalesce = false;
    this.flush();
  }

  colAlign(table, i) {
    const arr = (table.dataset.aligns || '').split(',');
    return arr[i] || '';
  }

  /** 设置当前列的对齐方式（'' / left / center / right） */
  setColAlign(align) {
    const info = this.tableInfo();
    if (!info) return;
    const { table, colIdx } = info;
    const arr = (table.dataset.aligns || '').split(',');
    while (arr.length <= colIdx) arr.push('');
    arr[colIdx] = align;
    table.dataset.aligns = arr.join(',');
    for (const tr of table.querySelectorAll('tr')) {
      const c = tr.children[colIdx];
      if (!c) continue;
      if (align) { c.dataset.align = align; c.style.textAlign = align; }
      else { delete c.dataset.align; c.style.textAlign = ''; }
    }
    this.hCoalesce = false;
    this.flush();
  }

  addCol(before = false) {
    const info = this.tableInfo();
    if (!info) return;
    const { table, colIdx } = info;
    const at = before ? colIdx : colIdx + 1;
    for (const tr of table.querySelectorAll('tr')) {
      const isHead = tr.parentElement.tagName === 'THEAD';
      const cell = mkCell(isHead ? 'th' : 'td', '', '');
      const ref = tr.children[at];
      if (ref) tr.insertBefore(cell, ref);
      else tr.appendChild(cell);
    }
    const aligns = (table.dataset.aligns || '').split(',');
    aligns.splice(at, 0, '');
    table.dataset.aligns = aligns.join(',');
    this.hCoalesce = false;
    this.flush();
  }

  delRow() {
    const info = this.tableInfo();
    if (!info) return;
    const { table, block, cell } = info;
    const tr = cell.parentElement;
    if (tr.parentElement.tagName === 'THEAD') return;          // 表头不删
    const bodyRows = [...table.querySelectorAll('tbody tr')];
    if (bodyRows.length <= 1) { this.delTable(); return; }      // 只剩一行：连表一起删
    tr.remove();
    this.hCoalesce = false;
    this.flush();
    this.focusCell(block, 0, Math.min(info.colIdx, table.querySelector('thead tr').children.length - 1));
  }

  delCol() {
    const info = this.tableInfo();
    if (!info) return;
    const { table, block, colIdx } = info;
    if (table.querySelector('thead tr').children.length <= 1) { this.delTable(); return; }
    for (const tr of table.querySelectorAll('tr')) {
      const c = tr.children[colIdx];
      if (c) c.remove();
    }
    const aligns = (table.dataset.aligns || '').split(',');
    aligns.splice(colIdx, 1);
    table.dataset.aligns = aligns.join(',');
    this.hCoalesce = false;
    this.flush();
    this.focusCell(block, 0, Math.min(colIdx, table.querySelector('thead tr').children.length - 1));
  }

  delTable() {
    const info = this.tableInfo();
    if (!info) return;
    const block = info.block;
    const prev = block.previousElementSibling;
    block.remove();
    if (prev) this.placeCaretEnd(prev);
    else { const p = mkPara(''); this.root.prepend(p); this.placeCaretStart(p); }
    this.hCoalesce = false;
    this.flush();
  }

  /** 表格菜单 / 上下文菜单统一入口 */
  tableCommand(cmd) {
    switch (cmd) {
      case 'rowAbove': this.addRow('above'); break;
      case 'rowBelow': this.addRow('below'); break;
      case 'colBefore': this.addCol(true); break;
      case 'colAfter': this.addCol(false); break;
      case 'delRow': this.delRow(); break;
      case 'delCol': this.delCol(); break;
      case 'delTable': this.delTable(); break;
      default: break;
    }
  }

  isInTable() { return !!this.currentCell(); }

  /* ---------------- 链接 ---------------- */

  applyLink(url) {
    if (!url) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = range.toString() || url;
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.textContent = text;
    range.deleteContents();
    range.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    this.root.focus();
    sel.removeAllRanges();
    sel.addRange(after);
    this.hCoalesce = false;
    this.flush();
  }

  /* ---------------- 图片 ---------------- */

  /**
   * 在光标处插一张图。src 用相对路径（assets/xxx.png）时，WebView2 会按
   * 文档所在目录解析；纯网络地址原样用。
   * 插完在图片后补一个空文本节点，否则光标进不到图后面，接着打字会叠在图上。
   */
  insertImage(src, alt = '') {
    if (!src) return;
    const block = this.currentBlock();
    if (!block) return;
    const t = textEl(block);
    const img = document.createElement('img');
    img.className = 'w-img';
    img.setAttribute('data-src', src);
    img.setAttribute('src', resolveDocImg(src, docDir));
    img.setAttribute('alt', alt);

    const sel = window.getSelection();
    if (sel.rangeCount && t.contains(sel.getRangeAt(0).startContainer)) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(img);
    } else {
      t.appendChild(img);
    }
    img.after(document.createTextNode(ZWSP));
    this.placeCaretEnd(block);
    this.hCoalesce = false;
    this.flush();
  }

  /**
   * 只写 width 属性，高度删掉交给浏览器按原比例算——两个都写死会在换图后
   * 拉变形。上限取编辑区宽度：拖过头的尺寸存进 md 也没意义，正文又是
   * max-width:100%，存 900 只会得到一张被压回去的图。
   */
  applyImgSize(img, w) {
    const maxW = Math.max(120, Math.round(this.root.clientWidth || 0));
    const px = Math.min(Math.max(24, Math.round(w)), maxW);
    img.setAttribute('width', String(px));
    img.removeAttribute('height');
    return px;
  }

  /* 图片右下角拖拽改宽。拖的时候用内联样式实时反馈，松手才落 md。 */
  startImgResize(img, startX) {
    const rect = img.getBoundingClientRect();
    const startW = rect.width || img.naturalWidth || 320;
    const move = (ev) => {
      const px = this.applyImgSize(img, startW + (ev.clientX - startX));
      img.style.width = `${px}px`;
      img.style.height = 'auto';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      img.style.width = '';
      img.style.height = '';
      img.style.cursor = '';
      img.classList.remove('w-img-resizing');
      this.resizing = false;
      this.hCoalesce = false;   // 一次拖拽 = 一步撤销，不和前面的输入合并
      this.flush();
    };
    this.resizing = true;
    img.classList.add('w-img-resizing');
    img.style.cursor = 'nwse-resize';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  handlePointerDown(e) {
    this.clearGapAfter();      // 鼠标重新摆了光标，「块后待插入」立刻作废
    /* 复制按钮按下的那一下别把编辑区的光标/选区抢走 */
    if (e.target && e.target.closest && e.target.closest('.cc-copy')) { e.preventDefault(); return; }
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('w-img')) return;
    const r = img.getBoundingClientRect();
    // 只有右下角 14px 见方算「抓手」，点在图上其它位置仍然是正常定位光标
    if (r.right - e.clientX > 14 || r.bottom - e.clientY > 14) return;
    e.preventDefault();
    this.startImgResize(img, e.clientX);
  }

  hoverImgCorner(e) {
    const img = e.target && e.target.tagName === 'IMG' ? e.target : null;
    if (this.hoverImg && this.hoverImg !== img) {
      this.hoverImg.style.cursor = '';
      this.hoverImg = null;
    }
    if (!img || this.resizing) return;
    const r = img.getBoundingClientRect();
    const corner = r.right - e.clientX < 14 && r.bottom - e.clientY < 14;
    img.style.cursor = corner ? 'nwse-resize' : '';
    this.hoverImg = corner ? img : null;
  }

  /* ---------------- 粘贴 / 点击 ---------------- */

  handlePaste(e) {
    // 先看剪贴板里有没有图片。截图后直接 Ctrl+V 是最常用的插图方式，
    // 以前这里只读 text/plain，图片会被静默丢掉，用户完全不知道为什么没反应。
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    const img = files.find((f) => f && /^image\//.test(f.type));
    if (img && this.onPasteImage) {
      e.preventDefault();
      this.onPasteImage(img);
      return;
    }
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    /* 粘贴也是「要写入了」：先把块后那一行建出来，下面按宿主分派时
       currentBlock() 才会是那个新空段落，而不是下一块的正文。 */
    if (this.gapAfter) this.materializeGap();
    const cell = this.currentCell();
    if (cell) {
      // 单元格里只取第一行，避免把表格结构塞进单元格
      document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '));
      return;
    }

    /* 代码块 / 公式块里粘贴 = 原文进块，绝不按 Markdown 解析。
       走下面那条解析路的话，粘一段 JSON 会变成五六个段落：空代码块被
       `replaceWith` 整块换掉（代码块凭空消失），非空的则把段落插到块**外面**
       （内容跑到代码块下方，块里一个字节没多）。两条都不是「粘贴」的意思。 */
    if (this.caretInRawBlock()) {
      this.insertRawText(text);
      return;
    }

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) {
      document.execCommand('insertText', false, lines[0]);
      return;
    }

    /* 列表项 / 引用行是「容器块」：多行要往容器里续，不能按段落插到块后面 ——
       那样列表被拦腰截断（`- 第二项` 后面冒出三个普通段落，还各隔一个空行）。
       续行规则和回车完全一致：li 续同 kind 同缩进，bq 续同缩进并接住提示块颜色。 */
    const hostBlock = this.currentBlock();
    if (hostBlock && (hostBlock.dataset.type === 'li' || hostBlock.dataset.type === 'bq')) {
      this.pasteLinesInContainer(hostBlock, lines);
      return;
    }

    // 多行：整段按 Markdown 解析成块，顶替当前空行或插到当前块之后。
    // 这样从别处粘一段带标题/列表的文字，结构是保留的，而不是糊成一行行纯文本。
    const block = this.currentBlock();
    const nodes = [...parseMarkdown(text).children];
    if (!nodes.length) return;
    if (block && this.isEmptyBlock(block)) block.replaceWith(...nodes);
    else if (block) block.after(...nodes);
    else this.root.append(...nodes);
    this.placeCaretEnd(nodes[nodes.length - 1]);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  /** 在容器块（列表项 / 引用行）里粘贴多行：等价于逐行按回车续行。
      整段算一次编辑 —— 期间把 `silent` 打开，别让每行都跑一遍 onInput 的
      规范化与块规则，末尾统一 renumber + flush 一次。

      空行不占一项：容器里「一行 = 一项」，空行只是排版，而空列表项在模型里
      存不住（序列化直接丢掉），真去造一个空的 li/bq 只会留下一块看不见的空位。
      代价是粘多段文本进引用会并成一个引用组 —— 比「空行把引用断成两截、后面
      几段全变正文」好解释。 */
  pasteLinesInContainer(block, lines) {
    const items = lines.filter((s) => s !== '');
    if (!items.length) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const prevSilent = this.silent;
    this.silent = true;
    try {
      let cur = block;
      sel.getRangeAt(0).deleteContents();
      document.execCommand('insertText', false, items[0]);
      for (let i = 1; i < items.length; i++) {
        /* 等于按一次回车：li 续同 kind、同缩进，bq 续同缩进并接住提示块的颜色。
           拆完光标落在新块行首，接着写下一行。 */
        this.splitBlock(cur, true);
        cur = this.currentBlock() || cur;
        document.execCommand('insertText', false, items[i]);
      }
    } finally {
      this.silent = prevSilent;
    }
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  handleClick(e) {
    this.clearGapAfter();
    if (this.loading) return;
    /* 代码块右上角的「复制」：整块代码直接进剪贴板，不需要先选中。
       必须待在选区判断之前 —— 用户常常是先选了一段、再想起来复制整块，
       而下面那句「有选区就直接返回」会把这个点击吞掉。 */
    const cc = e.target && e.target.closest && e.target.closest('.cc-copy');
    if (cc) {
      e.preventDefault();
      const blk = cc.closest('.w-block');
      const code = blk && blk.querySelector('.w-code');
      if (code && writeClipboard(codeToText(code))) {
        cc.classList.add('done');
        clearTimeout(cc._doneTimer);
        cc._doneTimer = setTimeout(() => cc.classList.remove('done'), 1200);
      }
      this.root.focus({ preventScroll: true });
      return;
    }
    /* 刚用鼠标拖选完，别再当成「点了一下」处理。
       跨块拖选之后 `click` 的 target 是**按下点与松开点的最近公共祖先** ——
       选到两行以上时它就是 root 本身，和「点了正文空白」长得一模一样。
       以前照空白处理：在文末补一个空段落、把光标搬进去，用户刚选好的一段字
       在松手那一刻就没了（「所见即所得无法选多行」的真身就是这个）。
       mousedown 已经把选区收起过，所以「点了但没选中任何东西」不受影响。 */
    const sel0 = window.getSelection();
    if (sel0 && !sel0.isCollapsed) return;
    const a = e.target.closest && e.target.closest('a');
    if (a) {
      // Ctrl/⌘ + 点击 = 打开链接；直接点仍然是定位光标（否则想改链接文字就没法下手了）
      const href = a.getAttribute('href') || '';
      if ((e.ctrlKey || e.metaKey) && href && this.openLink) {
        e.preventDefault();
        this.openLink(href);
        return;
      }
      e.preventDefault();
      const r = document.createRange();
      r.selectNodeContents(a);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    const cb = e.target.closest && e.target.closest('.w-check');
    if (cb) {
      const b = cb.closest('.w-block');
      if (cb.checked) b.dataset.checked = '1';
      else delete b.dataset.checked;
      this.hCoalesce = false;
      this.flush();
      return;
    }
    // 点正文空白：把光标送回文末能打字的地方。以前这里只要点在最后一块
    // 下方就无条件 insertEmptyAfter —— 于是每点一次空白就多一个空行，
    // 越点越长；而这个兜底本来只为「块后光标出不去」存在，不该成为加行的入口。
    if (e.target === this.root) {
      /* 再确认一次「这一下真的点在空白上」：公共祖先就是 root 只说明
         「按下点与松开点不在同一个块里」，不代表点在块外的空白处。
         按坐标问元素，命中任何块（含块里的 .w-text）就只是「点在字上」。 */
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (under && under.closest && under.closest('.w-block')) return;
      this.root.focus();
      const last = this.root.lastElementChild;
      if (!last) return;
      this.hideInsertLine();
      /* 末块本身能落脚（段落 / 标题 / 引用末行 / 列表末项 / 那个空段落），
         光标进去就够；只有代码块、公式块、表格、分割线把光标包在结构里，
         块内没有可写的尾位，才需要给它垫一行。补过一次之后那个空段落
         就是末块，再点空白只会聚焦它，不会继续长。 */
      if (!this.needsLineBelow(last)) { this.placeCaretEnd(last); return; }
      const p = this.insertEmptyAfter(last);
      this.placeCaretStart(p);
      this.flush();
    }
  }

  /**
   * 这一块下面要不要垫一行才能站人。代码块 / 公式块 / 表格 / 分割线把光标
   * 包在自己的结构里（表格还得进格子、分割线连光标位都没有），点在它们下方
   * 的空白上也没有可写的位置 —— 只有这几种块垫底时才补一个空段落。
   *
   * 引用与列表的末行本身就是可写位置，段落和标题更不用说：它们垫底时
   * 点空白只是把光标送回去，不再顺手加行。
   */
  needsLineBelow(block) {
    const type = block && block.dataset && block.dataset.type;
    return type === 'code' || type === 'math' || type === 'table' || type === 'hr';
  }

  /* ---------------- 块尾插入指示线 ---------------- */
  /* 只在「点了真的会多一行」的时候亮：末块是代码块 / 公式块 / 表格 / 分割线。
     别的块垫底时点空白只是把光标送回去（见 needsLineBelow），
     亮线会骗人 —— 用户会以为点一下能加行，点了却没有。 */
  hoverInsertLine(e) {
    const ind = this.insertLine;
    const last = this.root.lastElementChild;
    if (!last || !this.needsLineBelow(last)) { this.hideInsertLine(); return; }
    const lastRect = last.getBoundingClientRect();
    if (e.clientY <= lastRect.bottom + 2) { this.hideInsertLine(); return; }
    const rootRect = this.root.getBoundingClientRect();
    ind.style.display = 'block';
    ind.style.top = (lastRect.bottom - rootRect.top + this.root.scrollTop - 1) + 'px';
    ind.style.left = (lastRect.left - rootRect.left) + 'px';
    ind.style.width = lastRect.width + 'px';
  }

  hideInsertLine() {
    if (this.insertLine) this.insertLine.style.display = 'none';
  }
}

