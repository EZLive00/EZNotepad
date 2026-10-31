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

const MAX_INDENT = 6;
const ZWSP = '\u200b';

/** 撤销历史的总字节上限。条数上限（200）对小文档够用，长文档得靠这个兜底 */
const HISTORY_BYTES = 8 * 1024 * 1024;

/** 字符串占的字节数（V8 里 1 个 UTF-16 码元 = 2 字节，这里只用于比较量级） */
const bytesOf = (s) => (s ? s.length * 2 : 0);

/** 当前文档所在目录：图片的相对路径要按它展开成可加载的绝对地址 */
let docDir = '';

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

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
      const shown = resolveDocImg(s, docDir);
      /* 尺寸写在 alt 里（`![说明|300](a.png)`），渲染成 width / height，
         所见即所得里立刻就能看到缩过的样子 */
      const { text, width, height } = splitImgAlt(alt);
      const dim = (width ? ` width="${width}"` : '') + (height ? ` height="${height}"` : '');
      /* draggable=否：浏览器默认的图片拖拽会和右下角改宽抢同一串指针事件 */
      return `<img class="w-img" draggable="false" src="${escapeAttr(shown)}" data-src="${escapeAttr(s)}" alt="${escapeAttr(text)}"${dim}>`;
    });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, txt, href) => `<a href="${escapeAttr(href)}">${txt}</a>`);
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|\W)__([^_]+)__(?!_)/g, '$1<strong>$2</strong>');
  t = t.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
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
  const bar = document.createElement('div');
  bar.className = 'w-codebar';
  bar.contentEditable = 'false';
  bar.innerHTML = `<span>${escapeHtml(lang || 'code')}</span>`;
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
      frag.appendChild(mkHeading(h[1].length, h[2]));
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

/** 代码块里的文本：<br> 还原成换行（textContent 会丢掉 <br>） */
function codeToText(el) {
  if (el.childNodes.length === 1 && el.firstChild.nodeName === 'BR') return '';
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) s += n.nodeValue.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    else if (n.nodeName === 'BR') s += '\n';
    else if (n.nodeType === 1) s += codeToText(n);
  });
  return s;
}

/** 编辑视图 DOM -> Markdown */
export function blocksToMarkdown(root) {
  const chunks = [];
  // 列表缩进按 CommonMark 的「列」算：子项要缩进到父项正文所在的列
  // （"- " 占 2 列、"1. " 占 3 列、" - [ ] " 占 6 列），这样交给任何渲染器都不会散架
  const cols = [];

  for (const el of root.children) {
    const type = el.dataset.type || 'p';

    if (type === 'hr') { chunks.push({ type, lines: ['---'] }); cols.length = 0; continue; }

    if (type === 'table') { chunks.push({ type, lines: tableToMarkdown(el) }); cols.length = 0; continue; }

    if (type === 'code') {
      const text = codeToText(el.querySelector('.w-code') || el);
      chunks.push({ type, lines: ['```' + (el.dataset.lang || ''), text, '```'] });
      cols.length = 0;
      continue;
    }

    if (type === 'math') {
      // $$ 由这里补回去：块里只存裸 TeX，粘贴/编辑都不会把定界符弄丢
      const text = codeToText(el.querySelector('.w-tex') || el);
      if (el.dataset.mathInline === '1' && !text.includes('\n')) {
        chunks.push({ type, lines: ['$$' + text + '$$'] });
      } else {
        chunks.push({ type, lines: ['$$', text, '$$'] });
      }
      cols.length = 0;
      continue;
    }

    const t = el.querySelector('.w-text') || el;
    const text = inlineToMd(t);

    if (/^h[1-6]$/.test(type)) {
      chunks.push({ type, lines: ['#'.repeat(+type[1]) + ' ' + text] });
      cols.length = 0;
    } else if (type === 'li') {
      const kind = el.dataset.list || 'ul';
      const lvl = Math.min(+el.dataset.indent || 0, MAX_INDENT);
      cols.length = lvl + 1;
      const base = lvl === 0 ? 0 : (cols[lvl - 1] ?? lvl * 2);
      const marker = kind === 'ol'
        ? `${el.dataset.num || 1}. `
        : kind === 'task'
          ? `- [${el.dataset.checked === '1' ? 'x' : ' '}] `
          : '- ';
      chunks.push({ type, lines: [' '.repeat(base) + marker + text] });
      cols[lvl] = base + marker.length;
    } else if (type === 'bq') {
      const depth = (+el.dataset.indent || 0) + 1;
      const prefix = '> '.repeat(depth);
      const co = el.dataset.callout || '';
      if (co) {
        // 标记行 + 正文行：> [!info] 标题 / > 正文
        const title = el.dataset.calloutTitle || '';
        const lines = [prefix + `[!${co}]` + (title ? ` ${title}` : '')];
        if (text.trim()) lines.push(prefix + text);
        chunks.push({ type, lines, co: true });
      } else {
        chunks.push({ type, lines: [prefix + text], bqStart: !!el.dataset.bqStart });
      }
      cols.length = 0;
    } else {
      chunks.push({ type, lines: [text] });
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
 * DOM / 光标工具
 * ============================================================ */

const textEl = (block) => block.querySelector('.w-text') || block;

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

function setCaretOffset(el, offset) {
  let left = Math.max(0, offset);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let last = null;
  while (node) {
    const len = node.nodeValue.length;
    if (left <= len) { placeCaret(node, left); return; }
    left -= len;
    last = node;
    node = walker.nextNode();
  }
  if (last) placeCaret(last, last.nodeValue.length);
  else {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
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

    root.addEventListener('input', () => this.onInput());
    root.addEventListener('keydown', (e) => this.handleKey(e));
    root.addEventListener('compositionstart', () => { this.composing = true; });
    root.addEventListener('compositionend', () => { this.composing = false; this.onInput(); });
    root.addEventListener('paste', (e) => this.handlePaste(e));
    root.addEventListener('blur', () => this.flush());
    root.addEventListener('click', (e) => this.handleClick(e));
    root.addEventListener('pointerdown', (e) => this.handlePointerDown(e));
    root.addEventListener('pointermove', (e) => this.hoverImgCorner(e));
    // 块尾插入指示线：鼠标移到最后一个块下方的空白处时出现，点击插入一行。
    // 线挂在滚动容器（root 父层，自带 position:relative）上 —— 不能挂进 root，
    // 块遍历/序列化都假定 root 的孩子全是 .w-block
    this.insertLine = document.createElement('div');
    this.insertLine.className = 'w-insert-line';
    (root.parentElement || root).appendChild(this.insertLine);
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
    this._onSelChange = () => this.collapseHashes();
    document.addEventListener('selectionchange', this._onSelChange);
  }

  /* ---------------- 公共 API ---------------- */

  /** 文档换了目录，图片相对路径要跟着换基准（渲染前调用） */
  setDocDir(dir) { docDir = dir || ''; }

  render(md, restore) {
    this._render(md, restore);
    const snap = this.toMarkdown();
    this.history = [{ md: snap, caret: null }];
    this.hBytes = bytesOf(snap);
    this.hIndex = 0;
    this.hLast = 0;
    this.hCoalesce = false;
  }

  _render(md, restore) {
    /* 记下原文有没有结尾换行：序列化只吐「行」，补不补最后那个 \n 得看原来的样子。
       不记的话每次编辑都会把文件的结尾换行吃掉，git 立刻给你一行
       "\ No newline at end of file"。
       空文档不改这个标记 —— 用户清空重写时不该顺手把文件的换行习惯改掉。 */
    if (md) this.trailingNewline = md.endsWith('\n');
    this.silent = true;
    this.root.innerHTML = '';
    this.lastBlock = null;
    this.lastCell = null;
    this.root.appendChild(parseMarkdown(md));
    this.silent = false;
    this.normalize(true);      // 载入时也过一遍：空标题退回正文、清掉游离节点
    this.renumber();
    if (restore) this.restoreCaret(restore);
  }

  toMarkdown() {
    const md = blocksToMarkdown(this.root);
    if (this.trailingNewline && md && !md.endsWith('\n')) return md + '\n';
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
    const block = this.root.children[state.blockIndex];
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
    if (last && last.md === md) { this.hLast = now; return; }
    const snap = { md, caret: this.caretState() };
    if (last && this.hCoalesce && now - this.hLast < 700) {
      if (this.history[this.hIndex]) this.hBytes -= bytesOf(this.history[this.hIndex].md);
      this.history[this.hIndex] = snap;
      this.hBytes += bytesOf(md);
    } else {
      this.history = this.history.slice(0, this.hIndex + 1);
      this.history.push(snap);
      this.hBytes += bytesOf(md);
      if (this.history.length > 200) this.hBytes -= bytesOf(this.history.shift().md);
      /* 条数上限 200 是按小文档定的。600 段的文档每份快照 60 KB，
         200 条就是 12 MB 常驻。所以再按总字节封一道顶，超了丢最旧的：
         长文档的撤销深度换内存，短文档完全不受影响。 */
      while (this.hBytes > HISTORY_BYTES && this.history.length > 2) {
        this.hBytes -= bytesOf(this.history.shift().md);
      }
      this.hIndex = this.history.length - 1;
    }
    this.hLast = now;
  }

  undo() {
    if (this.hIndex <= 0) return false;
    this.hIndex--;
    const s = this.history[this.hIndex];
    this._render(s.md, s.caret);
    this.onChange(s.md);
    this.hCoalesce = false;
    return true;
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return false;
    this.hIndex++;
    const s = this.history[this.hIndex];
    this._render(s.md, s.caret);
    this.onChange(s.md);
    this.hCoalesce = false;
    return true;
  }

  /* ---------------- 基础定位 ---------------- */

  /* 不要写 [...this.root.children].indexOf()：每次调用都会把 600 个块复制成数组，
     而它在每次击键的 caretState 里都要跑一次。 */
  indexOf(block) {
    const kids = this.root.children;
    for (let i = 0; i < kids.length; i++) if (kids[i] === block) return i;
    return -1;
  }

  /**
   * 按锚点找标题块（目录里的 [标题](#slug) 靠它跳转）。
   * slug 用和渲染时同一个函数现算，不预先存在 DOM 上 ——
   * 改标题文字之后不用重新标注，算出来自然就变了。
   */
  findHeadingBySlug(slug) {
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

  isCaretAtStart(block) { return offsetIn(textEl(block)) === 0; }
  isCaretAtEnd(block) {
    const t = textEl(block);
    return offsetIn(t) >= t.textContent.length;
  }

  /* 光标是否停在「空末行」：isCaretAtEnd 且最后一个 <br> 之后没有可见文字
     （零宽空格不算 —— codeNewline 垫的那个正是它的藏身处）。
     代码/公式块用它决定 Enter 是换行还是出块 */
  caretOnEmptyLastLine(block) {
    if (!this.isCaretAtEnd(block)) return false;
    const kids = textEl(block).childNodes;
    let lastBr = -1;
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i].nodeName === 'BR') { lastBr = i; break; }
    }
    let txt = '';
    for (let j = lastBr + 1; j < kids.length; j++) txt += kids[j].textContent || '';
    return txt.replace(/\u200b/g, '').trim() === '';
  }

  isEmptyBlock(block) { return isEmptyText(textEl(block)); }

  /* ---------------- 输入主流程 ---------------- */

  onInput() {
    if (this.silent || this.composing) return;
    this.normalize(false, true);   // 只扫光标附近，见 normalize 的说明
    if (this.applyBlockRule()) return;
    this.applyInlineRule();
    this.renumber();
    this.hCoalesce = true;
    this.flush();
  }

  flush() {
    if (this.silent) return;
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
    if (e.isComposing) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = this.currentBlock();
    const cell = this.currentCell();

    // 撤销 / 重做 / 行内格式
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
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
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return this.handleArrow(e, block, cell);
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
      // 块内回车 = 换行；只有停在「空末行」时回车才是离开块（Typora 约定：
      // 连按两次 Enter —— 第一下开空行，第二下出块）。↓ 方向键也可出块。
      // 之前「末尾回车直接出块」是错的：写完一行想换行就被弹出去
      if (this.caretOnEmptyLastLine(block)) {
        const p = this.insertEmptyAfter(block);
        this.placeCaretStart(p);
        this.flush();
        return;
      }
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
    if (prev.dataset.type === 'table' || prev.dataset.type === 'code') { this.placeCaretEnd(prev); return; }
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

    // 前一个字符是零宽空格（行首垫片）：删掉它并接回上一行
    if (off > 0 && v[off - 1] === ZWSP) {
      const atLineStart = off === 1 && (!v.slice(0, off - 1).length);
      node.nodeValue = v.slice(0, off - 1) + v.slice(off);
      const br = atLineStart ? node.previousSibling : null;
      if (atLineStart && br && br.nodeName === 'BR') {
        br.remove();
        if (!node.nodeValue) node.remove();
        this.caretToPrevLine(node.previousSibling, r.startContainer);
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
   * 表格 / 代码块边缘的方向键逃生口：
   * 最后一格末尾 ↓ 跳到表格下方，第一格开头 ↑ 跳到上方，代码块底 ↓ 出块。
   * 没有这条路的话，这些块只能靠鼠标点击才能离开。
   */
  handleArrow(e, block, cell) {
    if (cell) {
      const info = this.tableInfo();
      if (!info) return;
      const row = cell.parentElement;
      if (e.key === 'ArrowDown'
        && info.rowIdx === info.rows.length - 1
        && info.colIdx === row.children.length - 1
        && this.isCaretAtEnd(cell)) {
        e.preventDefault();
        const p = this.insertEmptyAfter(info.block);
        this.placeCaretStart(p);
        this.flush();
      }
      return;
    }
    if (e.key !== 'ArrowDown' || !block) return;
    const type = block.dataset.type;
    if (type !== 'code' && type !== 'math') return;
    if (!this.isCaretAtEnd(block)) return;
    e.preventDefault();
    const next = block.nextElementSibling;
    if (next) this.placeCaretStart(next);
    else {
      const p = this.insertEmptyAfter(block);
      this.placeCaretStart(p);
      this.flush();
    }
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
      if (block.dataset.callout === type) {
        delete block.dataset.callout;
        delete block.dataset.calloutTitle;
        block.querySelector('.w-co-head')?.remove();
      } else {
        const title = block.dataset.calloutTitle || '';
        block.dataset.callout = type;
        const old = block.querySelector('.w-co-head');
        const head = mkCalloutHead(type, title);
        if (old) old.replaceWith(head);
        else block.insertBefore(head, block.firstChild);
        if (title) block.dataset.calloutTitle = title;
      }
      this.hCoalesce = false;
      this.flush();
      this.placeCaretEnd(block);
      return;
    }
    if (block.dataset.type === 'p' || /^h[1-6]$/.test(block.dataset.type)) {
      const nb = mkQuote(textEl(block).textContent, 0, type, '');
      block.replaceWith(nb);
      this.placeCaretEnd(nb);
      this.hCoalesce = false;
      this.flush();
    }
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

  /** 回车拆分：光标前留在当前块，光标后进入新块（保留行内样式） */
  splitBlock(block) {
    const type = block.dataset.type;

    // 空列表项 / 空引用 / 空标题：退出结构（在空标题里回车 = 我要写正文）
    if (/^h[1-6]$/.test(type) && this.isEmptyBlock(block)) {
      this.toParagraph(block, 0);
      return;
    }
    if ((type === 'li' || type === 'bq') && this.isEmptyBlock(block)) {
      const ind = +block.dataset.indent || 0;
      if (type === 'li' && ind > 0) { this.setIndent(block, ind - 1); return; }
      if (type === 'bq' && ind > 0) { this.setQuoteLevel(block, ind - 1); return; }
      this.toParagraph(block, 0);
      return;
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

  /** 有序列表重新编号（每个连续 run 各自从头算，嵌套层级各自计数） */
  renumber() {
    let counters = [];
    for (const b of this.root.children) {
      if (b.dataset.type !== 'li') { counters = []; continue; }
      if (b.dataset.list !== 'ol') continue;
      const ind = +b.dataset.indent || 0;
      counters.length = ind + 1;
      if (counters[ind] == null) counters[ind] = +(b.dataset.start || 1);
      else counters[ind] += 1;
      const num = counters[ind];
      b.dataset.num = String(num);
      const m = b.querySelector('.w-li-marker');
      if (m && m.textContent !== num + '.') m.textContent = num + '.';
    }
  }

  /* ---------------- 行内格式 ---------------- */

  /** 行内切换：有选区就包一层，没有就插入零宽占位继续输入 */
  toggleInline(kind) {
    if (this.currentCell()) return;              // 表格里交给浏览器原生行为
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

    const t = textEl(block);
    const text = t.textContent;
    const li = mkLi(kind, text, 0, false, 1);
    block.replaceWith(li);
    this.placeCaretEnd(li);
    this.renumber();
    this.hCoalesce = false;
    this.flush();
  }

  /** 标题级别：0 = 正文 */
  toggleHeading(level) {
    const block = this.currentBlock();
    if (!block) return;
    const cur = block.dataset.type;
    if (level === 0 || cur === 'h' + level) { this.toParagraph(block, null); return; }
    if (cur === 'table' || cur === 'hr') return;
    const text = textEl(block).textContent;
    const nb = mkHeading(level, text);
    block.replaceWith(nb);
    this.placeCaretEnd(nb);
    this.hCoalesce = false;
    this.flush();
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
      if (block && (block.dataset.type === 'p' || /^h[1-6]$/.test(block.dataset.type))) {
        const nb = mkQuote(textEl(block).textContent, 0);
        // 紧跟着另一条引用转出来的 = 新的独立引用，不是上一条的续行
        const pb = block.previousElementSibling;
        if (pb && pb.dataset && pb.dataset.type === 'bq') nb.dataset.bqStart = '1';
        block.replaceWith(nb);
        this.placeCaretEnd(nb);
        this.hCoalesce = false;
        this.flush();
      }
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
    const cell = this.currentCell();
    if (cell) {
      // 单元格里只取第一行，避免把表格结构塞进单元格
      document.execCommand('insertText', false, text.replace(/\r?\n/g, ' '));
      return;
    }

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) {
      document.execCommand('insertText', false, lines[0]);
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

  handleClick(e) {
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
    // 点正文空白：落在最后一个块下方（指示线区域）= 插入一个空段落当新行；
    // 落在块旁（块没占满行宽）= 聚焦到最后一个块。最后一块若是代码/表格/
    // 公式/分割线，光标放进里面也没法打字 —— 在它下方开个空段落当落脚点
    if (e.target === this.root) {
      this.root.focus();
      const last = this.root.lastElementChild;
      if (!last) return;
      const lastRect = last.getBoundingClientRect();
      if (e.clientY > lastRect.bottom + 2) {
        this.hideInsertLine();
        const p = this.insertEmptyAfter(last);
        this.placeCaretStart(p);
        this.flush();
        return;
      }
      const lt = last.dataset.type;
      if (lt === 'code' || lt === 'table' || lt === 'math' || lt === 'hr') {
        const p = this.insertEmptyAfter(last);
        this.placeCaretStart(p);
        this.flush();
      } else {
        this.placeCaretEnd(last);
      }
    }
  }

  /* ---------------- 块尾插入指示线 ---------------- */
  /* 鼠标在最后一个块下方的空白里移动时，显示一条插入位置线；
     点击即在该处插入空段落。对所有块类型一致 —— 不用先想想
     「这块能不能点进去」 */
  hoverInsertLine(e) {
    const ind = this.insertLine;
    const last = this.root.lastElementChild;
    if (!last) { this.hideInsertLine(); return; }
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

