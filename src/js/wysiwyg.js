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

const MAX_INDENT = 6;
const ZWSP = '\u200b';

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
  t = escapeHtml(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, s) => `<img class="w-img" src="${escapeAttr(s)}" alt="${escapeAttr(alt)}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, txt, href) => `<a href="${escapeAttr(href)}">${txt}</a>`);
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|\W)__([^_]+)__(?!_)/g, '$1<strong>$2</strong>');
  t = t.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return t;
}

/** DOM -> 行内 Markdown。这是「不丢样式」的关键：逐个节点还原标记 */
export function inlineToMd(node) {
  let s = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/\u00a0/g, ' ').replace(/\u200b/g, ''); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') return;
    if (tag === 'img') { s += `![${n.getAttribute('alt') || ''}](${n.getAttribute('src') || ''})`; return; }
    const inner = inlineToMd(n);
    switch (tag) {
      case 'strong': case 'b': s += inner.trim() ? `**${inner}**` : inner; break;
      case 'em': case 'i': s += inner.trim() ? `_${inner}_` : inner; break;
      case 'del': case 's': case 'strike': s += inner.trim() ? `~~${inner}~~` : inner; break;
      case 'code': s += n.textContent ? '`' + n.textContent + '`' : ''; break;
      case 'a': s += inner ? `[${inner}](${n.getAttribute('href') || ''})` : ''; break;
      default: s += inner;
    }
  });
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

export function mkQuote(text = '', level = 0) {
  const b = blockEl('bq', 'w-bq');
  b.dataset.indent = String(level);
  b.style.setProperty('--bq-indent', String(level));
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

export function mkHr() {
  const b = blockEl('hr', 'w-hr');
  b.contentEditable = 'false';
  b.innerHTML = '<hr>';
  return b;
}

function mkCell(tag, text, align) {
  const c = document.createElement(tag);
  if (align) { c.dataset.align = align; c.style.textAlign = align; }
  if (text) c.innerHTML = inlineHtml(text);
  else c.innerHTML = '<br>';
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

    // 引用（支持 > > 嵌套）
    const q = line.match(RE_QUOTE);
    if (q) {
      const level = Math.min(MAX_INDENT, q[1].replace(/\s/g, '').length - 1);
      levelOf.reset();
      frag.appendChild(mkQuote(q[2], Math.max(0, level)));
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
  const cellText = (c) => inlineToMd(c).replace(/\|/g, '\\|');
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
      chunks.push({ type, lines: ['> '.repeat(depth) + text] });
      cols.length = 0;
    } else {
      chunks.push({ type, lines: [text] });
      cols.length = 0;
    }
  }

  // 块之间要不要空行：列表项之间、连续引用之间必须紧凑（空行会变成 loose list、
  // 或者把一段引用拆成两段），其余块之间补一个空行 —— Markdown 靠它断块。
  const tight = (a, b) => (a === 'li' && b === 'li') || (a === 'bq' && b === 'bq');
  const lines = [];
  let prev = null;
  for (const c of chunks) {
    // 空段落本身就是一行空行，别再额外补一行（否则两个空行越攒越多）
    const isBlankBlock = c.lines.length === 1 && c.lines[0] === '';
    if (lines.length && prev && !tight(prev, c.type) && !isBlankBlock) lines.push('');
    lines.push(...c.lines);
    prev = c.type;
  }
  // 末尾空行在 Markdown 里没有意义，顺手去掉（编辑器里仍可留空段落当落脚点）
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
    this.silent = false;
    this.composing = false;
    this.history = [];
    this.hIndex = -1;
    this.hLast = 0;
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
    root.addEventListener('dragover', (e) => e.preventDefault());
    root.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) return;
      e.preventDefault();
    });
  }

  /* ---------------- 公共 API ---------------- */

  render(md, restore) {
    this._render(md, restore);
    this.history = [{ md: this.toMarkdown(), caret: null }];
    this.hIndex = 0;
    this.hLast = 0;
    this.hCoalesce = false;
  }

  _render(md, restore) {
    this.silent = true;
    this.root.innerHTML = '';
    this.lastBlock = null;
    this.lastCell = null;
    this.root.appendChild(parseMarkdown(md));
    this.silent = false;
    this.renumber();
    if (restore) this.restoreCaret(restore);
  }

  toMarkdown() {
    return blocksToMarkdown(this.root);
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
      this.history[this.hIndex] = snap;
    } else {
      this.history = this.history.slice(0, this.hIndex + 1);
      this.history.push(snap);
      if (this.history.length > 200) this.history.shift();
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

  indexOf(block) { return [...this.root.children].indexOf(block); }

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

  isCaretAtStart(block) { return offsetIn(textEl(block)) === 0; }
  isCaretAtEnd(block) {
    const t = textEl(block);
    return offsetIn(t) >= t.textContent.length;
  }

  isEmptyBlock(block) { return isEmptyText(textEl(block)); }

  /* ---------------- 输入主流程 ---------------- */

  onInput() {
    if (this.silent || this.composing) return;
    this.normalize();
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

  normalize() {
    // 顶层游离节点（浏览器偶尔会造出 div/br/text）→ 包成段落
    for (const n of [...this.root.childNodes]) {
      if (n.nodeType === 1 && n.classList.contains('w-block')) continue;
      if (n.nodeType === 3 && !n.nodeValue.trim()) { n.remove(); continue; }
      const p = mkPara('');
      const pt = textEl(p);
      pt.innerHTML = '';
      if (n.nodeType === 3) pt.textContent = n.nodeValue;
      else while (n.firstChild) pt.appendChild(n.firstChild);
      n.replaceWith(p);
    }

    for (const b of this.root.children) {
      const type = b.dataset.type;
      if (type === 'table' || type === 'hr') continue;
      let t = b.querySelector('.w-text');
      if (!t) {
        t = mkText('');
        b.appendChild(t);
      }
      // 清掉空的行内包裹（删字后常见的 <strong></strong>）
      t.querySelectorAll('strong,em,code,del,b,i,strike,a').forEach((el) => {
        if (!el.textContent && !el.querySelector('img')) el.remove();
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
    }

    if (!this.root.firstElementChild) this.root.appendChild(mkPara(''));
  }

  /* ---------------- 输入即转换（Markdown 语法糖） ---------------- */

  /** 段首输入 "# " / "- " / "1. " / "> " / "```" / "- [ ] " 立刻转成对应块 */
  applyBlockRule() {
    const block = this.currentBlock();
    if (!block || block.dataset.type !== 'p') return false;
    const t = textEl(block);
    const text = t.textContent;
    if (!text || text.length > 32) return false;
    if (!this.isCaretAtEnd(block)) return false;

    // --- / *** / ___ → 分割线（后面自动补一个空段落，否则没处落脚）
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
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
      [/^```([\w#+.-]*)\s?$/, (m) => mkCode('', m[1] || '')],
      [/^>\s$/, () => mkQuote('')],
      [/^([-*+])\s\[([ xX])\]\s$/, (m) => mkLi('task', '', 0, m[2].toLowerCase() === 'x')],
      [/^([-*+])\s$/, () => mkLi('ul', '')],
      [/^(\d{1,9})[.)]\s$/, (m) => mkLi('ol', '', 0, false, parseInt(m[1], 10) || 1)],
    ];

    for (const [re, build] of rules) {
      const m = text.match(re);
      if (!m) continue;
      const nb = build(m);
      block.replaceWith(nb);
      this.placeCaretStart(nb);
      this.hCoalesce = false;
      this.renumber();
      this.flush();
      return true;
    }
    return false;
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
    if (!textWrap || textWrap.classList.contains('w-code')) return false;

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
        el.setAttribute('src', m[2]);
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
    if (cell) { e.preventDefault(); this.cellEnter(); return; }
    if (!block) return;
    const type = block.dataset.type;
    if (type === 'hr' || type === 'table') { e.preventDefault(); return; }
    e.preventDefault();
    if (type === 'code') { this.codeNewline(); return; }
    this.splitBlock(block);
  }

  handleBackspace(e, block, cell) {
    const sel = window.getSelection();
    if (!sel.isCollapsed) return;      // 有选区：交给浏览器删
    if (cell) return;                  // 单元格内正常删字
    if (!block) return;
    const type = block.dataset.type;

    if (type === 'code') {
      if (this.isEmptyBlock(block) && this.root.children.length > 1) {
        e.preventDefault();
        this.removeBlock(block);
      }
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
      else this.toParagraph(block, 0);
      return;
    }

    // 空标题：先退回正文，再按一次才并到上一块（否则删空标题后打字还是标题）
    if (/^h[1-6]$/.test(type) && this.isEmptyBlock(block)) {
      e.preventDefault();
      this.toParagraph(block, 0);
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

    // 空列表项 / 空引用：退出结构
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
    if (type === 'code') {
      const nb = mkCode('', '');
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

  /* ---------------- 粘贴 / 点击 ---------------- */

  handlePaste(e) {
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
    // 点正文空白：聚焦到最后一个块
    if (e.target === this.root) {
      const last = this.root.lastElementChild;
      if (last) { this.root.focus(); this.placeCaretEnd(last); }
    }
  }
}

