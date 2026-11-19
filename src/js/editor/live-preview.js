// ============================================================
// live-preview.js —— 行内所见即所得（live preview）的装饰层
//
// 和旧 wysiwyg.js 的根本区别：**缓冲区就是 Markdown 原文**。
//   · 旧内核：渲染成 DOM 当真相，存盘时再序列化回 md —— 标记不在 DOM 里，
//     光标够不到边界，于是要零宽垫片、贴边转义、相邻码合并一堆补丁。
//   · 这里：`**粗**` 的两个星号是文档里真实的字符，装饰只是「这几格先不画」。
//     光标一进去就画出来，移开再收起 —— 和 Typora 的 smart hiding 同一个模型。
//
// 装饰全部来自语法树（lezer markdown + GFM），不扫正则：
//   HeaderMark / EmphasisMark / CodeMark / StrikethroughMark / LinkMark / QuoteMark
// 都是独立节点，位置精确到字符。
//
// 铁律一：**光标碰到的节点不隐藏**。光标停在 `**` 里（或紧贴边界）时，
// 标记必须显形，否则用户既看不见边界、也改不了定界符。
//
// 铁律二：**块级装饰只能由 StateField 提供**。行装饰和整块 replace 会改变
// 布局高度，ViewPlugin 在渲染后期给不出来 —— 硬塞进去会抛错，整层装饰静默
// 失效，症状就是「文档明明有内容，DOM 里只有一行空白」。行内装饰（mark /
// inline replace）不影响布局，才走 ViewPlugin 按视口算。
// ============================================================
import {
  EditorView, Decoration, WidgetType, ViewPlugin, StateField, StateEffect, syntaxTree,
} from '../../vendor/cm6.js';
import { CALLOUT_TYPES, RE_CALLOUT, normalizeCallout, resolveDocImg, inline as mdInline } from '../markdown.js';
import { writeClipboard } from '../clipboard.js';
import { tt } from '../i18n.js';
import { tokenRanges, guessLang, TOKEN_MAX_CHARS } from '../codehilite.js';

/* ---------------- 工具 ---------------- */

/** 光标（或选区任一端）是否碰到了 [from, to] —— 触摸边界也算碰到。
 *  边界必须算：光标停在 `**粗**` 的右星号后面时，那个星号得看得见，
 *  否则 Backspace 删掉的是什么完全不可预期。 */
function touched(ranges, from, to) {
  for (const r of ranges) {
    if (r.empty) {
      if (r.from >= from && r.from <= to) return true;
    } else if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** 整块的范围：从行首到「末行之后那一行的行首」。
 *  块 widget 不覆盖到下一行行首的话，CM6 会在块后留一个空行。 */
function blockSpan(doc, from, to) {
  const a = doc.lineAt(from).from;
  const end = Math.max(a, to);
  const last = doc.lineAt(Math.max(a, end - (end > a ? 1 : 0)));
  const next = last.number < doc.lines ? doc.line(last.number + 1).from : last.to;
  return { from: a, to: Math.max(a, next), lastLine: last.number };
}

/* ---------------- 行内 widget ---------------- */

/** 任务框：[ ] / [x] → 可点的方框。改文档而不是改 DOM —— 文档才是真相。 */
class TaskWidget extends WidgetType {
  constructor(checked, pos) { super(); this.checked = checked; this.pos = pos; }
  eq(o) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-lp-task' + (this.checked ? ' is-on' : '');
    b.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    b.tabIndex = -1;
    b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<path class="box" d="M3.6 3.6h8.8v8.8H3.6z"/>'
      + '<path class="tick" d="M5.4 8.3l1.7 1.8 3.6-4"/>'
      + '</svg>';
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      /* 位置可能已经过期：重新按偏移读一次，不是 `[ ]` 就不动 */
      const text = view.state.sliceDoc(this.pos, this.pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({
        changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return b;
  }
  ignoreEvent() { return false; }
}

/** 行内图片：![alt](src) → 真图。点一下把光标放回源码（该行显形后就能改）。 */
class ImageWidget extends WidgetType {
  constructor(src, alt, docDir, from) { super(); this.src = src; this.alt = alt; this.docDir = docDir; this.from = from; }
  eq(o) { return o.src === this.src && o.alt === this.alt && o.docDir === this.docDir && o.from === this.from; }
  toDOM(view) {
    const box = document.createElement('span');
    box.className = 'cm-lp-img';
    const img = document.createElement('img');
    img.src = resolveDocImg(this.src, this.docDir);
    img.alt = this.alt || '';
    img.draggable = false;
    img.addEventListener('error', () => {
      box.classList.add('is-broken');
      box.textContent = this.alt || this.src;
    });
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    box.appendChild(img);
    return box;
  }
}

/** 水平线：点一下把光标放到 `---` 那一行（随后按源码显示，能改能删）。
 *  不接 mousedown 的话，CM6 在 widget 上找不到落点，这一下会被整个吞掉 ——
 *  用户看到的是「点了分割线没反应」，也就没法把它改成别的块。 */
class HrWidget extends WidgetType {
  constructor(from) { super(); this.from = from; }
  eq(o) { return o.from === this.from; }
  toDOM(view) {
    const d = document.createElement('div');
    d.className = 'cm-lp-hr';
    d.innerHTML = '<hr>';
    d.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });
    return d;
  }
  ignoreEvent() { return true; }
}

/** 无序列表的圆点：`- ` / `* ` / `+ ` 换成一颗点。
 *  为什么不直接把 `-` 留在源码里：Typora 口径是「块级标记始终隐藏」——
 *  子弹符本身就是那个符号，再让用户看 `- ` 就是两套符号并存。
 *  圆点按缩进深度换字形，一眼能看出层级。 */
class BulletWidget extends WidgetType {
  constructor(depth) { super(); this.depth = depth; }
  eq(o) { return o.depth === this.depth; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lp-bullet';
    s.textContent = ['•', '◦', '▪'][this.depth % 3];
    return s;
  }
}

/** 代码块左上角那条：语言名 + 复制。
 *  旧内核把这条做在 contenteditable 的块外壳上；新内核里它必须是块级 widget ——
 *  正文是文本，没有「块外壳」可以挂 DOM。 */
class CodeBarWidget extends WidgetType {
  constructor(lang, code) { super(); this.lang = lang; this.code = code; }
  eq(o) { return o.lang === this.lang && o.code === this.code; }
  toDOM() {
    const bar = document.createElement('div');
    bar.className = 'cm-lp-codebar';
    bar.contentEditable = 'false';
    const name = document.createElement('span');
    name.className = 'cm-lp-lang';
    /* 没标语言时写「代码」：一条空白条会让人以为坏了 */
    name.textContent = this.lang || tt('代码');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-lp-copy';
    btn.tabIndex = -1;                 // Tab 在编辑器里有含义，别让它落进按钮
    btn.title = tt('复制代码');
    btn.setAttribute('aria-label', tt('复制代码'));
    btn.innerHTML = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-copy"/></svg>'
      + '<svg class="ico ico-done" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-check"/></svg>';
    /* mousedown 而不是 click：click 之前 CM6 会先把光标挪走、把选区清掉，
       用户「选了一段再想复制整块」的那段选区就没了 */
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!writeClipboard(this.code)) return;
      btn.classList.add('done');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.classList.remove('done'); btn._t = 0; }, 1200);
    });
    bar.append(name, btn);
    return bar;
  }
  /* true = 编辑器别管这块 DOM：条上的点击归按钮自己处理，别顺手把光标搬走 */
  ignoreEvent() { return true; }
}

/** 引用块头部的 `[!note] 标题`：换成「图标 + 标题」 */
class CalloutHeadWidget extends WidgetType {
  constructor(kind, title) { super(); this.kind = kind; this.title = title; }
  eq(o) { return o.kind === this.kind && o.title === this.title; }
  toDOM() {
    const def = CALLOUT_TYPES[this.kind] || CALLOUT_TYPES.note;
    const d = document.createElement('span');
    d.className = 'cm-lp-cohead';
    d.innerHTML = `<svg class="cm-lp-coico" aria-hidden="true"><use href="#i-${def.icon}"/></svg>`;
    const t = document.createElement('span');
    t.textContent = this.title || def.label;
    d.appendChild(t);
    return d;
  }
}

/** 表格：只读渲染。点一下把光标放进表内 → 该表转为源码，可以直接编辑。
 *  为什么不做 contenteditable 单元格：widget 一旦文档变化就会重建，
 *  单元格输入时焦点必丢（CM6 的 widget 没有「部分更新」）。 */
class TableWidget extends WidgetType {
  constructor(spec) { super(); this.spec = spec; }
  eq(o) {
    const a = this.spec, b = o.spec;
    if (a.from !== b.from || a.rows.length !== b.rows.length) return false;
    for (let i = 0; i < a.rows.length; i++) {
      if (a.rows[i].join('\u0001') !== b.rows[i].join('\u0001')) return false;
    }
    return a.aligns.join() === b.aligns.join();
  }
  toDOM(view) {
    const { rows, aligns, from } = this.spec;
    const table = document.createElement('table');
    table.className = 'cm-lp-table';
    const head = rows[0] || [];
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);

    const mkRow = (cells, tag, host) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < head.length; c++) {
        const cell = document.createElement(tag);
        const al = aligns[c];
        if (al) cell.style.textAlign = al;
        /* 单元格里的 <br> 是换行约定，和 renderMarkdown 一致 */
        cell.innerHTML = cellHtml(cells[c] || '');
        tr.appendChild(cell);
      }
      host.appendChild(tr);
    };
    mkRow(head, 'th', thead);
    for (let r = 1; r < rows.length; r++) mkRow(rows[r], 'td', tbody);

    table.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: from + 2 }, scrollIntoView: true });
      view.focus();
    });
    return table;
  }
  ignoreEvent() { return true; }
}

/** 单元格内的行内语法走 markdown.js 的 inline()，和预览/导出一致 */
function cellHtml(s) {
  return mdInline(String(s).replace(/<br\s*\/?>/gi, '\u0001BR\u0001'))
    .replace(/\u0001BR\u0001/g, '<br>');
}

/* ---------------- 共用 ---------------- */

const HEAD_LV = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3,
  ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
};

/** YAML frontmatter 的结束行号（1 起）；没有就返回 -1。
 *  只允许出现在文档最前面，最多找 200 行 —— 属性区不可能更长，
 *  而全文扫描在每次按键时都要跑一遍。 */
function frontmatterEnd(doc) {
  if (doc.lines < 2) return -1;
  if (doc.line(1).text.trim() !== '---') return -1;
  const lim = Math.min(doc.lines, 200);
  for (let i = 2; i <= lim; i++) {
    if (doc.line(i).text.trim() === '---') return i;
  }
  return -1;
}

/** 从 Table 节点整理出渲染需要的东西：每行每格的文本 + 对齐 */
function parseTable(doc, node) {
  const text = doc.sliceString(node.from, node.to);
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const splitCells = (line) => {
    let s = String(line == null ? '' : line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const aligns = splitCells(lines[1]).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = [splitCells(lines[0])];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    rows.push(splitCells(lines[i]));
  }
  return { from: node.from, rows, aligns };
}

/* ---------------- 块级装饰（StateField） ----------------
   不按视口裁剪：块装饰决定文档总高度，必须整篇都在。
   代价是每次文档/选区变化都要走一遍语法树 —— lezer 是增量的，很小。 */
function buildBlockDeco(state) {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const tree = syntaxTree(state);
  const items = [];

  /* frontmatter：文档开头那一段 `---` 包起来的 YAML。整段零高，正文只留属性条 */
  const fmLast = frontmatterEnd(doc);
  const fmTo = fmLast > 0 ? (fmLast < doc.lines ? doc.line(fmLast + 1).from : doc.line(fmLast).to) : -1;
  /* 无条件隐藏：属性区的官方入口是顶部属性条，正文再显示一遍 YAML 只是噪音。
     要改原始 YAML 的复杂写法，切「编辑」模式。 */
  if (fmTo > 0) {
    items.push({ from: 0, to: fmTo, deco: Decoration.replace({ block: true }) });
  }

  const line = (pos, cls, attrs) => {
    const l = doc.lineAt(pos);
    /* 类名特意沿用旧内核的 w-h / w-bq / w-li / w-code / w-table：
       app.js 的大纲、块手柄、右键药丸都在按这些类名找块。 */
    items.push({
      from: l.from, to: l.from,
      deco: Decoration.line(attrs ? { class: cls, attributes: attrs } : { class: cls }),
    });
  };

  tree.iterate({
    enter(n) {
      /* frontmatter 整段不参与渲染：属性已经在顶部属性条里，正文再来一遍
         就是两份。光标进去（要改 YAML）时除外。
         ⚠️ 判据必须是「整个节点都在 fm 内」：Document 的 from 也是 0，
         用 n.from < fmTo 会把根节点一并跳过，整篇一个装饰都出不来。 */
      if (fmTo > 0 && n.to <= fmTo) return false;

      const active = touched(ranges, n.from, n.to);
      const lv = HEAD_LV[n.name];

      if (lv) { line(n.from, 'w-h cm-lp-h cm-lp-h' + lv, { 'data-type': 'h' + lv }); return undefined; }

      if (n.name === 'HorizontalRule') {
        if (!active) {
          const sp = blockSpan(doc, n.from, n.to);
          items.push({ from: sp.from, to: sp.to, deco: Decoration.replace({ widget: new HrWidget(sp.from), block: true }) });
          return false;
        }
        line(n.from, 'cm-lp-hr-src', { 'data-type': 'hr' });
        return undefined;
      }

      if (n.name === 'FencedCode' || n.name === 'CodeBlock') {
        const sp = blockSpan(doc, n.from, n.to);
        const firstLn = doc.lineAt(sp.from).number;
        const isFence = (ln) => /^\s*(```|~~~)/.test(doc.sliceString(doc.line(ln).from, doc.line(ln).to));
        const fenceLns = [];
        let bodyLines = 0;
        for (let ln = firstLn; ln <= sp.lastLine; ln++) {
          if (isFence(ln)) { fenceLns.push(ln); continue; }
          bodyLines++;
          line(doc.line(ln).from, 'w-code cm-lp-code', { 'data-type': 'code' });
        }
        /* 空代码块（```js 紧跟 ```）没有任何内容行，再把围栏藏掉就整块消失了 ——
           用户看不到它、点不进去，只能靠撤销。这种块一律按「光标在里面」处理：
           连围栏一起按源码显示，至少是可见可点的 */
        if (!bodyLines || touched(ranges, sp.from, sp.to)) {
          for (const ln of fenceLns) {
            line(doc.line(ln).from, 'w-code cm-lp-code cm-lp-fence', { 'data-type': 'code' });
          }
          return false;
        }
        /* 围栏行藏掉：内容换零宽 + 行高由 CSS（.cm-lp-fence-off）压到 0。
           ⛔ 别改回「整行 block replace 到下一行行首」那种写法：那样紧跟围栏的
           那一行，行装饰会被 CM6 静默丢掉 —— 实测代码块第一行没有 w-code、
           引用组第一行没有 w-bq，而且只是「样式少了一层」，极难看出来。
           零高行是可量的（CM6 按 getBoundingClientRect 量行高），
           所以不能改成 display:none，那会让整篇的坐标表错位。 */
        /* 语言条：贴在第一条围栏的位置上，属于块级 widget（正文是文本，
           没有块外壳可以挂）。语言名取 info string —— 高亮用的就是它，
           两边取同一处才不会出现「条上写 json，着色按纯文本」。 */
        if (fenceLns.length) {
          const f0 = doc.line(fenceLns[0]);
          const info = doc.sliceString(f0.from, f0.to).match(/^\s*(?:```|~~~)\s*([^\s`]+)?/);
          const body = [];
          for (let ln = firstLn; ln <= sp.lastLine; ln++) {
            if (isFence(ln)) continue;
            body.push(doc.line(ln).text);
          }
          items.push({
            from: f0.from, to: f0.from,
            deco: Decoration.widget({
              widget: new CodeBarWidget(info && info[1] ? info[1] : '', body.join('\n')),
              block: true, side: -1,
            }),
          });
        }
        for (const ln of fenceLns) {
          const L = doc.line(ln);
          line(L.from, 'cm-lp-fence-off');
          items.push({ from: L.from, to: L.to, deco: Decoration.replace({}) });
        }
        return false;
      }

      if (n.name === 'Table') {
        if (!active) {
          const spec = parseTable(doc, n.node);
          if (spec) {
            const sp = blockSpan(doc, n.from, n.to);
            items.push({ from: sp.from, to: sp.to, deco: Decoration.replace({ widget: new TableWidget(spec), block: true }) });
          }
        } else {
          const sp = blockSpan(doc, n.from, n.to);
          for (let ln = doc.lineAt(sp.from).number; ln <= sp.lastLine; ln++) {
            line(doc.line(ln).from, 'w-table cm-lp-table-src', { 'data-type': 'table' });
          }
        }
        return false;
      }

      if (n.name === 'Blockquote') {
        const sp = blockSpan(doc, n.from, n.to);
        const first = doc.lineAt(sp.from);
        const head = doc.sliceString(first.from, first.to).replace(/^\s*>\s?/, '');
        const m = head.match(RE_CALLOUT);
        const kind = m ? normalizeCallout(m[1]) : '';
        for (let ln = first.number; ln <= sp.lastLine; ln++) {
          line(doc.line(ln).from, 'w-bq cm-lp-bq' + (kind ? ' cm-lp-co-' + kind : ''), {
            'data-type': 'bq',
            ...(kind ? { 'data-callout': kind } : {}),
          });
        }
        return undefined;
      }

      if (n.name === 'ListItem') { line(doc.lineAt(n.from).from, 'cm-lp-li', { 'data-type': 'li' }); return undefined; }

      return undefined;
    },
  });

  return Decoration.set(items.map((it) => it.deco.range(it.from, it.to)), true);
}

const blockDeco = StateField.define({
  create: (state) => {
    try { return buildBlockDeco(state); } catch { return Decoration.none; }
  },
  update(value, tr) {
    /* selection 变了也要重算：光标进出表格 / 代码块时，同一块要在
       「widget」和「源码」之间切换 */
    if (tr.docChanged || tr.selection) {
      try { return buildBlockDeco(tr.state); } catch { return Decoration.none; }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ---------------- 代码块词法着色（行内层） ----------------
   为什么放行内层而不是块级：颜色不改变布局高度，可以**按视口**算 —— 视口里
   通常只有一两个代码块，每次重算只分词那一两块。放进块级（整篇）就会在
   上万行的文档里每敲一个字把所有代码块重新分词一遍。

   ⛔ 别在这里另写一份正则分词。`tokenRanges()` 用的就是预览 / 导出那一套
   highlight.js 输出（见 codehilite.js 末尾那段注释）：同一段代码在编辑、
   预览、导出里必须是同一套颜色。 */
const tokCache = new Map();      // `${lang}\0${code}` → 区间
const langOf = new Map();        // code → 自动识别出来的语言
const pendingGuess = new Map();  // code → view（排着队等识别）
const REFRESH = StateEffect.define();
let guessTimer = null;

/* 自动识别要跑几十门语法（2 KB 约 150 ms），只能延后 + 缓存：
   停手 500 ms 之后才认，认出来再派发一次「重画」。不这么做就是每敲一个字
   卡一下，而且卡在输入路径上。 */
function scheduleGuess(code, view) {
  if (code.length > 2000 || pendingGuess.size >= 3) return;
  pendingGuess.set(code, view);
  if (guessTimer) return;
  guessTimer = setTimeout(() => {
    guessTimer = null;
    const todo = [...pendingGuess.keys()];
    const v = pendingGuess.values().next().value;
    pendingGuess.clear();
    for (const c of todo) langOf.set(c, guessLang(c));
    /* 这张表按整段代码当键，不设上限会随编辑一直涨 */
    if (langOf.size > 300) {
      const kept = [...langOf.entries()].slice(-150);
      langOf.clear();
      for (const [k, val] of kept) langOf.set(k, val);
    }
    if (v && !v.destroyed) v.dispatch({ effects: REFRESH.of(null) });
  }, 500);
}

function langFor(code, declared, view) {
  const d = (declared || '').trim();
  if (d) return d;
  if (langOf.has(code)) return langOf.get(code);
  scheduleGuess(code, view);
  return '';
}

/** 围栏块的第一条 / 最后一条围栏行号（没有收尾围栏时 close = 0） */
function fenceLines(doc, firstLn, lastLn) {
  const isF = (ln) => /^\s*(```|~~~)/.test(doc.line(ln).text);
  if (!isF(firstLn)) return null;
  for (let ln = lastLn; ln > firstLn; ln--) if (isF(ln)) return { open: firstLn, close: ln };
  return { open: firstLn, close: 0 };
}

/** 把代码文本的 token 区间摊到文档坐标上（跨行的 token 按行切开） */
function codeTokens(doc, bodyFrom, bodyTo, declared, view, push) {
  const code = doc.sliceString(bodyFrom, bodyTo);
  if (!code || code.length > TOKEN_MAX_CHARS) return;
  const lang = langFor(code, declared, view);
  if (!lang) return;
  const key = lang + '\u0000' + code;
  let ranges = tokCache.get(key);
  if (!ranges) {
    ranges = tokenRanges(code, lang);
    if (tokCache.size > 200) tokCache.clear();
    tokCache.set(key, ranges);
  }
  if (!ranges.length) return;

  /* 行起点表 + 两个指针单趟走完：O(行数 + token 数)。
     ⛔ 别写成「每个 token 扫一遍所有行」—— 四百行的块就是几十万次比较，
     挂在每次按键上必然卡。 */
  const starts = [];
  let acc = 0;
  for (let pos = bodyFrom; pos <= bodyTo; ) {
    const line = doc.lineAt(pos);
    starts.push({ codeOff: acc, docFrom: line.from, len: line.length });
    acc += line.length + 1;
    if (line.to >= bodyTo) break;
    pos = line.to + 1;
  }
  let li = 0;
  for (const r of ranges) {
    while (li < starts.length && starts[li].codeOff + starts[li].len < r.start) li++;
    for (let k = li; k < starts.length && starts[k].codeOff < r.end; k++) {
      const s = starts[k];
      const a = Math.max(r.start, s.codeOff);
      const b = Math.min(r.end, s.codeOff + s.len);
      if (b > a) push(s.docFrom + (a - s.codeOff), s.docFrom + (b - s.codeOff), r.cls);
    }
    if (li > 0) li--;
  }
}

/* ---------------- 行内装饰（ViewPlugin） ----------------
   标记隐藏、粗斜删码、链接、任务框、图片 —— 都是 inline 级，
   不影响布局高度，可以按视口算。 */
function buildInlineDeco(view) {
  const { state } = view;
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const docDir = (view.lpOpts && view.lpOpts.docDir) || '';
  const vp = view.viewport;
  const tree = syntaxTree(state);
  const items = [];

  const hide = (from, to) => { if (to > from) items.push({ from, to, deco: Decoration.replace({}) }); };

  /* 围栏内部的 CodeMark 归块级管，行内要跳过。顺带在这一趟里给代码块上色：
     视口里能看到的围栏才有意义，所以按视口算不浪费。 */
  const fences = [];
  tree.iterate({
    from: vp.from, to: vp.to,
    enter(n) {
      if (n.name !== 'FencedCode' && n.name !== 'CodeBlock') return undefined;
      fences.push([n.from, n.to]);
      /* 光标在块里 = 源码态：那时正文是原样的 Markdown，涂色反而看不清
         自己在改哪个字符 */
      if (n.name !== 'FencedCode' || touched(ranges, n.from, n.to)) return false;
      const firstLn = doc.lineAt(n.from).number;
      const lastLn = doc.lineAt(Math.max(n.from, n.to - 1)).number;
      const f = fenceLines(doc, firstLn, lastLn);
      if (!f) return false;
      const bodyFrom = doc.line(f.open).to + 1;
      const bodyTo = f.close ? doc.line(f.close).from - 1 : doc.line(lastLn).to;
      if (bodyTo <= bodyFrom) return false;
      const declared = (doc.line(f.open).text.match(/^\s*(?:```|~~~)\s*([^\s`]*)/) || [])[1] || '';
      try {
        codeTokens(doc, bodyFrom, bodyTo, declared, view, (from, to, cls) => {
          items.push({ from, to, deco: Decoration.mark({ class: 'tok-' + cls }) });
        });
      } catch { /* 着色失败不该带走整层装饰 */ }
      return false;
    },
  });
  const inFence = (pos) => fences.some(([a, b]) => pos >= a && pos < b);

  tree.iterate({
    from: vp.from, to: vp.to,
    enter(n) {
      const active = touched(ranges, n.from, n.to);

      /* 提示块的 `[!note] 标题` 换成图标头（在第一行内，属于行内替换） */
      if (n.name === 'Blockquote') {
        const first = doc.lineAt(n.from);
        const raw = doc.sliceString(first.from, first.to);
        const qm = raw.match(/^(\s*>\s?)/);
        const inner = raw.slice(qm ? qm[0].length : 0);
        const m = inner.match(RE_CALLOUT);
        if (m && !active) {
          const base = first.from + (qm ? qm[0].length : 0);
          const end = base + inner.indexOf(']') + 1;
          const label = (m[2] || '').trim();
          if (end > base) {
            items.push({
              from: base, to: end,
              deco: Decoration.replace({ widget: new CalloutHeadWidget(normalizeCallout(m[1]), label) }),
            });
            if (label) hide(end, first.to);
          }
        }
        return undefined;
      }

      switch (n.name) {
        case 'CodeMark':
          if (inFence(n.from)) return undefined;
          if (!active) hide(n.from, n.to);
          return undefined;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!active) hide(n.from, n.to);
          return undefined;
        /* 块级标记（# 与 >）**始终**隐藏，连光标所在行也不露 —— 这是 Typora 的
           口径：标题就是标题，引用就是引用，改级别走工具栏/快捷键。
           行内标记才随光标显形，因为那是「改定界符」的唯一入口。 */
        case 'HeaderMark':
        case 'QuoteMark': {
          const after = doc.sliceString(n.to, Math.min(n.to + 1, doc.length));
          hide(n.from, after === ' ' ? n.to + 1 : n.to);
          return undefined;
        }
        /* 任务列表的 `- ` 要去掉：方框本身就是符号，再挂一个项目符号是重复的 */
        case 'ListMark': {
          const line = doc.lineAt(n.from);
          const after = doc.sliceString(n.to, Math.min(n.to + 1, doc.length));
          const end = after === ' ' ? n.to + 1 : n.to;
          if (/^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) { hide(n.from, end); return undefined; }
          /* 无序项：标记换成圆点（块级标记始终隐藏，和 # / > 同一口径）。
             有序项的 `1.` 留着 —— 数字是内容的一部分，换成 widget 反而难核对。 */
          if (/^[-*+]$/.test(doc.sliceString(n.from, n.to))) {
            const indent = line.text.length - line.text.replace(/^\s+/, '').length;
            items.push({ from: n.from, to: end, deco: Decoration.replace({ widget: new BulletWidget(Math.floor(indent / 2)) }) });
          }
          return undefined;
        }
        case 'InlineCode': {
          let first = null, last = null;
          for (let c = n.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'CodeMark') { if (!first) first = c; last = c; }
          }
          if (first && last && last.from > first.to) {
            items.push({ from: first.to, to: last.from, deco: Decoration.mark({ class: 'cm-lp-codemark' }) });
          }
          return undefined;
        }
        case 'StrongEmphasis':
          items.push({ from: n.from, to: n.to, deco: Decoration.mark({ class: 'cm-lp-strong' }) });
          return undefined;
        case 'Emphasis':
          items.push({ from: n.from, to: n.to, deco: Decoration.mark({ class: 'cm-lp-em' }) });
          return undefined;
        case 'Strikethrough':
          items.push({ from: n.from, to: n.to, deco: Decoration.mark({ class: 'cm-lp-del' }) });
          return undefined;
        case 'Link': {
          const marks = [];
          for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
          if (marks.length >= 4 && !active) {
            /* `[文字](url)` 只留文字：隐藏开头的 `[`，再把 `](url)` 整段藏掉。
               只藏那四个 LinkMark 是不够的 —— 括号没了，URL 还留在正文里，
               一行链接变两行，读起来像 bug */
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, n.to);
            items.push({ from: marks[0].to, to: marks[1].from, deco: Decoration.mark({ class: 'cm-lp-link' }) });
          }
          return undefined;
        }
        case 'TaskMarker':
          if (!active) {
            items.push({
              from: n.from, to: n.to,
              deco: Decoration.replace({
                widget: new TaskWidget(/[xX]/.test(doc.sliceString(n.from, n.to)), n.from),
              }),
            });
          }
          return undefined;
        case 'Image':
          if (!active) {
            let alt = '', url = '';
            for (let c = n.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'URL') url = doc.sliceString(c.from, c.to);
              else if (c.name !== 'LinkMark') alt += doc.sliceString(c.from, c.to);
            }
            if (url) {
              items.push({
                from: n.from, to: n.to,
                deco: Decoration.replace({ widget: new ImageWidget(url, alt.trim(), docDir, n.from) }),
              });
            }
          }
          return undefined;
        default:
          return undefined;
      }
    },
  });

  /* `==高亮==` 是本项目自己的语法，lezer 不认（它只认 CommonMark + GFM）。
     按行扫一遍：两个定界符藏起来、中间加底色。和行内码同一个规矩 ——
     光标碰着就把标记露出来，否则用户没法删掉它。 */
  for (let pos = vp.from; pos <= Math.min(vp.to, doc.length); ) {
    const line = doc.lineAt(pos);
    if (!inFence(line.from)) {
      const re = /==(?!\s)([^=\n]+?)==/g;
      let m;
      while ((m = re.exec(line.text))) {
        const a = line.from + m.index;
        const b = a + m[0].length;
        if (!touched(ranges, a, b)) {
          hide(a, a + 2);
          hide(b - 2, b);
          items.push({ from: a + 2, to: b - 2, deco: Decoration.mark({ class: 'cm-lp-mark' }) });
        }
      }
    }
    if (line.to >= vp.to || line.number >= doc.lines) break;
    pos = line.to + 1;
  }

  return Decoration.set(items.map((it) => it.deco.range(it.from, it.to)), true);
}

/* ---------------- 扩展 ---------------- */

/* 阅读版式的底子：正文栏宽居中、行高放宽、光标用强调色。
   具体的标题字号、引用底色等在 styles.css 的 `.cm-lp-*` 里，和主题令牌共用一套。 */
const LP_THEME = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--fs-3)',
    fontFamily: 'var(--font-read)',
    color: 'var(--fg)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-read)',
    lineHeight: '1.78',
    overflowY: 'auto',
    /* 不换行时靠它横向滚：写成 hidden 的话长行撑出了宽度却没有滚动条 */
    overflowX: 'auto',
  },
  '.cm-content': {
    padding: '26px var(--read-gutter) 40vh',
    maxWidth: 'calc(var(--read-measure) + var(--read-gutter) * 2)',
    margin: '0 auto',
    caretColor: 'var(--accent)',
    width: '100%',
    boxSizing: 'border-box',
  },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--fg-faint)' },
});

export function livePreview(opts = {}) {
  const options = { docDir: opts.docDir || '' };
  const inlinePlugin = ViewPlugin.fromClass(class {
    constructor(view) {
      view.lpOpts = options;
      /* 一处语法怪例不该把整层装饰打崩（ViewPlugin 构造抛错 = 整篇变源码）。
         降级成「这一帧不装饰」，下一次更新会重算。 */
      try { this.decorations = buildInlineDeco(view); } catch { this.decorations = Decoration.none; }
    }
    update(u) {
      u.view.lpOpts = options;
      /* REFRESH：代码块的语言是延后识别出来的，识别结果回来之后没有任何
         文档/选区变化，不认这个信号就永远不会重画（表现：颜色一直不出来） */
      const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(REFRESH)));
      if (u.docChanged || u.selectionSet || u.viewportChanged || refresh) {
        try { this.decorations = buildInlineDeco(u.view); } catch { this.decorations = Decoration.none; }
      }
    }
  }, { decorations: (v) => v.decorations });

  return {
    /* ⛔ 别在这里加 EditorView.lineWrapping：换行开关是 plain-editor 的
       wrapComp 管的（setWrap 要能把它摘掉，让长行横向滚）。这里硬塞一份，
       重配 compartment 也摘不掉它 —— 表现是「切到不换行，正文照样折着」。 */
    extensions: [LP_THEME, blockDeco, inlinePlugin],
    setDocDir(view, dir) {
      /* 只换变量，不派发事务：改目录一定伴随一次文档载入（切换标签时 render），
         那次 docChanged 会把装饰连同新的图片路径一起重算。 */
      options.docDir = dir || '';
    },
    attach(view) { view.lpOpts = options; },
  };
}
