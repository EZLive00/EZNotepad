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
import { LANGS, normalizeLang } from '../langs.js';

/* ---------------- 工具 ---------------- */

/** 光标（或选区任一端）是否碰到了 [from, to] —— 触摸边界也算碰到。
 *  用于**块级**判断：光标在表格 / 分割线 / 代码块里，这一块就退回源码。
 *  块级必须用闭区间：光标停在块的最后一行末尾时，那块仍然是「当前块」。 */
function touched(ranges, from, to) {
  for (const r of ranges) {
    if (r.empty) {
      if (r.from >= from && r.from <= to) return true;
    } else if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** 行内标记要不要显形。和 touched 的关键差别：**光标紧贴标记不算**。
 *
 *  为什么不能沿用 touched：用户打完 `` `code` `` 时光标正好停在第二个反引号
 *  后面（pos = CodeMark.to），打完 `**粗**` 停在右星号后面 —— 闭区间判定于是
 *  认为「碰到标记」，两个反引号一直亮着。用户的读数就是「根本没渲染，动一下
 *  光标才变」。
 *
 *  正确的口径（Typora 同款）：标记只在
 *    · 有选区且选区压到它，或
 *    · 光标真的落在它内部（多字符标记才有内部）
 *  时显形。单字符标记（`` ` `` / `*` / `~`）只能靠选中，这也正是用户想改
 *  定界符时会做的动作；而「输入中途」永远看得见 —— 那时它还不是标记节点。
 */
function markActive(ranges, from, to) {
  for (const r of ranges) {
    if (r.empty) {
      if (r.from > from && r.from < to) return true;
    } else if (r.from < to && r.to > from) return true;
  }
  return false;
}

/** 光标是不是**严格落在** [from, to] 里面（两端都不算）。
 *
 *  表格用这一条判断「要不要退回源码」：光标停在表格前后都不算「在表内」，
 *  否则 insertTable、Esc 退出编辑、点表格上方这些动作都会把整张表塌成源码 ——
 *  而它们恰恰是用户最常做的。真正需要看源码的场景（查找跳进某一格、
 *  右键「编辑源码」）落点必然在中间，用这条判据仍然成立。 */
function strictInside(ranges, from, to) {
  for (const r of ranges) {
    if (r.empty) {
      if (r.from > from && r.from < to) return true;
    } else if (r.from < to && r.to > from) return true;
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

/** 代码块左上角那条：语言名（可点开改）+ 复制。
 *  旧内核把这条做在 contenteditable 的块外壳上；新内核里它必须是块级 widget ——
 *  正文是文本，没有「块外壳」可以挂 DOM。 */
class CodeBarWidget extends WidgetType {
  constructor(lang, code, infoFrom, infoTo) {
    super();
    this.lang = lang;
    this.code = code;
    this.infoFrom = infoFrom;
    this.infoTo = infoTo;
  }
  eq(o) {
    return o.lang === this.lang && o.code === this.code
      && o.infoFrom === this.infoFrom && o.infoTo === this.infoTo;
  }
  toDOM(view) {
    const bar = document.createElement('div');
    bar.className = 'cm-lp-codebar';
    bar.contentEditable = 'false';
    /* 语言名做成下拉：围栏行现在是零高的、光标到不了，没有这个入口
       ` ```js ` 就只能一开始写对。用原生 <select> 而不是自绘菜单 ——
       自绘要处理点外关闭、键盘、滚动跟随，而这里只需要一个值改变事件。 */
    const name = document.createElement('select');
    name.className = 'cm-lp-lang';
    name.tabIndex = -1;                 // Tab 在编辑器里有含义，别让它落进控件
    name.title = tt('代码');
    name.setAttribute('aria-label', tt('代码'));
    const addOpt = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      name.appendChild(o);
    };
    const cur = (this.lang || '').trim();
    const id = normalizeLang(cur);
    /* 认不出来的写法（`text`、`console`…）原样列一条，别把用户写的东西吃掉 */
    if (cur && (!id || id !== cur)) addOpt(cur, cur);
    addOpt('', tt('代码'));
    for (const [key, def] of Object.entries(LANGS)) {
      if (!def.hljs) continue;          // 没有语法可高亮的语言不列，选了也没颜色
      addOpt(key, def.label);
    }
    name.value = cur;
    if (name.value !== cur && cur) name.value = cur;
    name.addEventListener('change', () => {
      const doc = view.state.doc;
      const from = Math.max(0, Math.min(this.infoFrom, doc.length));
      const to = Math.max(from, Math.min(this.infoTo, doc.length));
      /* 位置过期（这一帧里文档被改过）就不写：写到别的字上比不写更难查 */
      if (doc.sliceString(from, to) !== cur) return;
      view.dispatch({ changes: { from, to, insert: name.value } });
      view.focus();
    });
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
  /* true = 编辑器别管这块 DOM。⛔ 必须返回 true：返回 false 时 CM6 会把
     mousedown 收走（焦点被它塞回 .cm-content），原生 <select> 根本展不开 ——
     实测点下去之后 activeElement 是 .cm-content，下拉毫无反应。
     复制按钮自己 preventDefault，不受影响。 */
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

/** 表格：渲染成真表格，**点格子就地改**。
 *
 *  CM6 里这张表是块级 widget —— 整块被替换掉了，文档里那段 `| a | b |` 在
 *  视口里没有 DOM，光标根本进不去。所以「点格子里直接打字」只有一条路：
 *  在格子上盖一个真输入框，把改动写回**那一格的字符区间**。
 *
 *  为什么不直接把 `<input>` 放进 `<td>` 里：widget 在文档一变就被整体重建，
 *  输入框连同焦点、输入法组字状态一起没了。输入框必须浮在 widget **外面**
 *  （挂在 view.dom 上），由我们自己开关（见下面的 openCell）。
 *
 *  ⛔ 别改成「点一下整表塌成源码」那种旧行为：那是 1.3.0+1 的形态，用户
 *  的原话是「这种交互不是我想要的，Typora 并不是这样的」。 */
class TableWidget extends WidgetType {
  constructor(spec) { super(); this.spec = spec; }
  eq(o) {
    /* 比对原文而不是逐格文本：只改空格（`| a |` → `|  a  |`）时逐格文本
       一模一样，但每格的偏移已经变了 —— 那会让写回落在错的位置 */
    const a = this.spec, b = o.spec;
    return a.from === b.from && a.to === b.to && a.raw === b.raw;
  }
  toDOM(view) {
    const { rows, aligns, from, cols, cells } = this.spec;
    const table = document.createElement('table');
    table.className = 'cm-lp-table';
    /* 给「提交之后重新打开下一格」用：文档一变 widget 就换了一个 DOM，
       只能靠这个标号把新表找回来 */
    table.dataset.from = String(from);
    table.dataset.aligns = aligns.join(',');
    table._cmTable = this;
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);

    const mkRow = (r, tag, host) => {
      const tr = document.createElement('tr');
      const cs = cells[r] || [];
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement(tag);
        const al = aligns[c];
        if (al) cell.style.textAlign = al;
        const src = cs[c];
        /* 单元格里的 <br> 是换行约定，和 renderMarkdown 一致 */
        cell.innerHTML = cellHtml(src ? src.text : '');
        /* 只有源码里真有这一格才可编辑：短行（GFM 允许少写几格）没有对应的
           字符区间，硬开输入框等于凭空造一格，写回时会把整行结构搞乱 */
        if (src) {
          cell.dataset.row = String(r);
          cell.dataset.col = String(c);
        }
        tr.appendChild(cell);
      }
      host.appendChild(tr);
    };
    mkRow(0, 'th', thead);
    for (let r = 1; r < rows.length; r++) mkRow(r, 'td', tbody);

    table.addEventListener('mousedown', (e) => {
      const td = e.target && e.target.closest ? e.target.closest('[data-row]') : null;
      if (!td || !table.contains(td)) return;
      const row = Number(td.dataset.row);
      const col = Number(td.dataset.col);
      if (e.button !== 0) {
        /* 右键：不能在这里 preventDefault —— 那会把 contextmenu 一起吞掉，
           右键菜单就再也出不来了。只把「现在说的是哪一格」记下来，
           菜单里的行列增删、对齐都靠它定位。 */
        commitCell();
        markCell(this.spec, row, col);
        return;
      }
      e.preventDefault();
      openCell(view, table, this, row, col, false);
    });
    return table;
  }
  /* 事件归我们自己的监听器处理，CM6 不用管（但也不阻止默认行为：
     右键要靠它冒泡到 app 的 contextmenu） */
  ignoreEvent() { return true; }
  destroy(dom) {
    /* widget 被替换（文档被别处改了、切换标签）时把浮层收掉 —— 锚点已经
       不在文档里，留着就是一块飘在正文上的白框 */
    if (cellEdit && cellEdit.tableEl === dom) closeCell();
  }
}

/** 单元格内的行内语法走 markdown.js 的 inline()，和预览/导出一致 */
function cellHtml(s) {
  return mdInline(String(s).replace(/<br\s*\/?>/gi, '\u0001BR\u0001'))
    .replace(/\u0001BR\u0001/g, '<br>');
}

/* ---------------- 表格：浮在格子上的那个输入框 ----------------

   状态只有两份：
     · cellEdit —— 输入框开着，焦点在它身上
     · cellMark —— 最近落点的格子；输入框关掉之后仍然留着，因为右键菜单里的
       行列增删 / 对齐是在**焦点已经离开输入框**之后才执行的，那时还得知道
       「刚才说的是哪一格」。它会在这些时刻作废：用户在正文里重新点了光标、
       文档被别处改了、换了标签。

   写回只替换**这一格**的字符区间（`| a | b |` 里的 `b`），不重排整表：
   Obsidian 会把整表按列宽重排，好处是好看，代价是每改一格都会改写其他行的
   空白，git diff 里一片红。我们的口径是「用户没碰的地方一个字节都不动」。

   ⛔ 输入框不能放进 `<td>` 里：widget 在文档一变就整体重建，输入框会连着
   焦点、输入法组字状态一起消失（表现是「打一半的字没了」）。它必须挂在
   view.dom 上，由我们自己开关。 */

const CELL_CLS = 'cm-lp-cell';
let cellEdit = null;
let cellMark = null;
/* 我们自己派发的事务计数：用来区分「文档被我改了」和「文档被别处改了」。
   后者意味着格子偏移已经不可信，正在编辑的那一格必须收手 */
let selfChange = 0;

/** 记下「现在说的是哪一格」（右键用，不打开输入框） */
function markCell(spec, row, col) {
  const cell = (spec.cells[row] || [])[col];
  if (!cell) return;
  cellMark = {
    tableFrom: spec.from, tableTo: spec.to, row, col,
    from: cell.from, to: cell.to, text: cell.text,
    aligns: spec.aligns, cols: spec.cols, rows: spec.rows.length,
  };
}

/** 把输入框摆到格子上。位置每次现算：滚动、窗口缩放、字号变化都不用另接监听 */
function placeCell() {
  const s = cellEdit;
  if (!s) return false;
  const { view, input, cellEl } = s;
  if (!cellEl.isConnected) { closeCell(); return false; }
  const r = cellEl.getBoundingClientRect();
  const sc = view.scrollDOM.getBoundingClientRect();
  /* 整格滚出可视区就落账收起来：浮层不在滚动容器里，不会跟着滚走，
     留着会变成悬在别的正文上的一块白框 */
  if (r.bottom <= sc.top || r.top >= sc.bottom) { commitCell(); return false; }
  const base = view.dom.getBoundingClientRect();
  input.style.left = `${Math.round(r.left - base.left)}px`;
  input.style.top = `${Math.round(r.top - base.top)}px`;
  input.style.width = `${Math.round(r.width)}px`;
  input.style.height = `${Math.round(r.height)}px`;
  /* 字号 / 行高 / 内边距 / 对齐照抄这一格算出来的值。
     ⛔ 别在 CSS 里写死 em：表格的字号是 .96em，但它的 em 基数是
     `--fs-editor`（13.5），而输入框挂在 .cm-editor 上，基数是 `--fs-3`（15）
     —— 同一个 `.96em` 量出来是 12.96 和 14.4，字会明显大一圈、基线也偏。 */
  const cs = getComputedStyle(cellEl);
  input.style.fontSize = cs.fontSize;
  input.style.lineHeight = cs.lineHeight;
  input.style.fontFamily = cs.fontFamily;
  input.style.fontWeight = cs.fontWeight;
  input.style.padding = cs.padding;
  input.style.textAlign = cs.textAlign;
  /* 内容和格子一样高时不要滚动条：行高 23.07px 配 23px 内容盒会溢出
     零点几像素，浏览器就画一条竖滚动条（看着像输入框坏了）。
     留 2px 余量：真多行（格子里有 <br>）才给滚动条。 */
  input.style.overflowY = input.scrollHeight > input.clientHeight + 2 ? 'auto' : 'hidden';
  return true;
}

/** 单元格里写的裸 `|` 会把一格切成两格；换行在表格里是 `<br>`。
 *  已经转义过的不再动（lookbehind），否则反复编辑同一格会越加越多反斜杠。 */
function escapeCellText(t) {
  return String(t)
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
    .replace(/(?<!\\)\|/g, '\\|');
}

function closeCell() {
  const s = cellEdit;
  if (!s) return;
  cellEdit = null;
  s.input._dead = true;
  try { s.cellEl.classList.remove('is-editing'); } catch { /* 节点已经换掉 */ }
  try { s.view.scrollDOM.removeEventListener('scroll', s.onScroll); } catch { /* view 已销毁 */ }
  window.removeEventListener('resize', s.onScroll);
  s.input.remove();
}

/** 落账：把输入框里的字写回那一格。
 *  文档在编辑期间被别处改过（偏移对不上）时**放弃写入** —— 宁可不写，
 *  也不能写到别的字上。 */
function commitCell() {
  const s = cellEdit;
  if (!s) return;
  const { view, ctx, input } = s;
  const text = input.value;
  closeCell();
  if (text === ctx.text) return;
  const doc = view.state.doc;
  if (ctx.to > doc.length || doc.sliceString(ctx.from, ctx.to) !== ctx.text) return;
  /* 空格子写进内容时两边各补一个空格：`|     |` 直接写会变成 `|新     |`，
     虽然合法但看着像把分隔符吃了 */
  const insert = ctx.text === ''
    ? (text ? ` ${escapeCellText(text)} ` : '')
    : escapeCellText(text);
  const delta = insert.length - (ctx.to - ctx.from);
  selfChange++;
  try {
    view.dispatch({ changes: { from: ctx.from, to: ctx.to, insert } });
  } finally { selfChange--; }
  /* 位置跟着挪：同一行后面的格子、以及表格末尾都会平移这么多 */
  cellMark = { ...ctx, to: ctx.from + insert.length, text, tableTo: ctx.tableTo + delta };
}

/** 放弃这一格（Esc）：改动不写回，焦点还给编辑区 */
function cancelCell() {
  const s = cellEdit;
  if (!s) return;
  const view = s.view;
  closeCell();
  cellMark = null;
  view.focus();
}

/** 找当前渲染出来的某张表（按块的起点认，同一屏可能有好几张表） */
function tableElOf(view, tableFrom) {
  const list = view.dom.querySelectorAll('.cm-lp-table');
  for (const el of list) if (Number(el.dataset.from) === tableFrom) return el;
  return null;
}

function openCellAt(view, tableFrom, row, col, selectAll) {
  const table = tableElOf(view, tableFrom);
  if (!table || !table._cmTable) return false;
  return openCell(view, table, table._cmTable, row, col, selectAll);
}

/** 打开某一格。selectAll：Tab 进来时选中原文，直接打字就是覆盖 */
function openCell(view, tableEl, widget, row, col, selectAll) {
  const spec = widget.spec;
  const cell = (spec.cells[row] || [])[col];
  if (!cell) return false;
  if (cellEdit && cellEdit.view === view && cellEdit.ctx.row === row && cellEdit.ctx.col === col) {
    /* 同一格又点了一次：只把焦点还回去，别把正在输入的内容重置成原文 */
    cellEdit.input.focus();
    if (selectAll) cellEdit.input.select();
    return true;
  }
  /* ⚠️ 先落账再开新的：中间不能有 dispatch 之外的等待，否则上一格的字会丢 */
  commitCell();
  const cellEl = tableEl.querySelector(`[data-row="${row}"][data-col="${col}"]`);
  if (!cellEl) return false;
  cellEl.classList.add('is-editing');
  const input = document.createElement('textarea');
  input.className = CELL_CLS;
  input.rows = 1;
  input.value = cell.text;
  input.spellcheck = false;
  input.setAttribute('aria-label', tt('编辑'));
  view.dom.appendChild(input);
  const ctx = {
    tableFrom: spec.from, tableTo: spec.to, row, col,
    from: cell.from, to: cell.to, text: cell.text,
    aligns: spec.aligns, cols: spec.cols, rows: spec.rows.length,
  };
  const onScroll = () => { placeCell(); };
  cellEdit = { view, ctx, input, cellEl, tableEl, spec, onScroll };
  cellMark = ctx;
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  /* 窗口缩放会改排版：格子的 rect 变了，浮层得跟着挪（不然会脱开格子） */
  window.addEventListener('resize', onScroll);
  input.addEventListener('keydown', onCellKey);
  input.addEventListener('blur', onCellBlur);
  placeCell();
  input.focus();
  if (selectAll) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

function onCellBlur(e) {
  const s = cellEdit;
  if (!s || e.target !== s.input || s.input._dead) return;
  commitCell();
}

/** 光标落到表格后面那一行：Enter 结束编辑时的落点。
 *  不这么做的话光标留在「进表格之前」的位置（可能整篇开头），
 *  用户按下 Enter 会觉得「跳到别处去了」。 */
function caretAfterTable(view, tableFrom) {
  const doc = view.state.doc;
  const first = doc.lineAt(Math.min(Math.max(0, tableFrom), doc.length)).number;
  let last = first;
  while (last < doc.lines && doc.line(last + 1).text.includes('|')) last++;
  const at = last < doc.lines ? doc.line(last + 1).from : doc.line(last).to;
  view.dispatch({ selection: { anchor: at } });
  view.focus();
}

function onCellKey(e) {
  const s = cellEdit;
  if (!s || e.target !== s.input) return;
  /* 输入法组字期间的 Enter / Tab 是「选字」，不是命令 —— 这一条漏了，
     中文用户只要按空格选词就会把格子关掉 */
  if (e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelCell(); return; }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const tableFrom = s.ctx.tableFrom;
    commitCell();
    caretAfterTable(s.view, tableFrom);
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); moveCell(e.shiftKey ? -1 : 1); return; }
  /* Ctrl+Z 不拦：textarea 自己有原生撤销栈，用户想撤的是「这一格里刚打的字」 */
}

/** 在表格末尾补一行空行，返回新行的下标（行下标里表头是 0，分隔行不算） */
function appendRow(view, tableFrom, cols) {
  const doc = view.state.doc;
  const first = doc.lineAt(Math.min(Math.max(0, tableFrom), doc.length)).number;
  let last = first;
  while (last < doc.lines && doc.line(last + 1).text.includes('|')) last++;
  const row = '\n| ' + Array.from({ length: cols }, () => '   ').join(' | ') + ' |';
  selfChange++;
  try { view.dispatch({ changes: { from: doc.line(last).to, insert: row } }); } finally { selfChange--; }
  /* 表格这几行里有一行是分隔行，它不占行下标 —— 所以要减 1 */
  return last - first;
}

/** Tab / Shift+Tab：落账后跳到相邻那一格；最后一格再按 Tab 补一行 */
function moveCell(delta) {
  const s = cellEdit;
  if (!s) return;
  const { view, ctx, spec } = s;
  const cols = spec.cols;
  const rowsN = spec.rows.length;
  const idx = ctx.row * cols + ctx.col + delta;
  if (idx < 0) { commitCell(); return; }
  if (idx >= rowsN * cols) {
    commitCell();
    const newRow = appendRow(view, ctx.tableFrom, cols);
    requestAnimationFrame(() => openCellAt(view, ctx.tableFrom, newRow, 0, true));
    return;
  }
  const nr = Math.floor(idx / cols);
  const nc = idx % cols;
  commitCell();
  /* 换格要等这一帧渲染完：提交会重建整张表，DOM 得先换新的 */
  requestAnimationFrame(() => openCellAt(view, ctx.tableFrom, nr, nc, true));
}

/** 当前「在说哪一格」：优先输入框里那一格，其次是最近点过的。
 *  LiveEditor.tableInfo() 靠它把行列命令接到正确的表格上 —— 光标永远进不了
 *  表格（整块是 widget），没有这一份，那些命令会静默失效。 */
export function currentTableCell() {
  return cellEdit ? cellEdit.ctx : cellMark;
}

/** 命令要改表格结构之前必须先把这一格落账（列数一变，格子偏移全变）。
 *  只落账、**不清**「说的是哪一格」—— 后面紧接着要用它定位行号列号 */
export function commitTableCell() { commitCell(); }

/** 这一格说完了：关掉输入框，连「哪一格」一起作废（结构改完之后调） */
export function clearTableCell() { closeCell(); cellMark = null; }

/** 换文档 / 换视图时清干净：偏移是另一份文档的，留着会写到别人身上 */
function resetTableState(view) {
  if (cellEdit && cellEdit.view !== view) closeCell();
  cellMark = null;
}

/* ---------------- 表格：源码 ↔ 渲染 ---------------- */

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

/** 按**未转义**的 `|` 切一行，返回带文档偏移的格子。
 *
 *  偏移是写回的锚点：改一格只替换那一格的字符区间，不重排整表。
 *  首尾竖线可有可无（GFM 允许），但**收尾竖线不能算出一格空单元格** ——
 *  按「切完把最后一个空段丢掉」那种写法，`| a | b |` 和 `|   |   |`
 *  会得到不同结果：后者最后一格真是空的，丢掉就把列数算少一格。
 *  所以先把收尾竖线剥掉，再在剩下的区间里切。 */
function splitCells(doc, lineNo) {
  const line = doc.line(lineNo);
  const s = line.text;
  let end = s.length;
  while (end > 0 && /\s/.test(s[end - 1])) end--;
  let body = end;
  let closed = false;
  if (body > 0 && s[body - 1] === '|' && !(body > 1 && s[body - 2] === '\\')) {
    body--;
    closed = true;
  }
  let i = 0;
  while (i < body && /\s/.test(s[i])) i++;
  if (i < body && s[i] === '|') i++;
  const out = [];
  let start = i;
  const push = (a, b) => {
    let x = a;
    let y = b;
    while (x < y && /\s/.test(s[x])) x++;
    while (y > x && /\s/.test(s[y - 1])) y--;
    /* 整格都是空格：落点放回分隔符后面那一格的开头。否则 from/to 会被两端
       一起推到格尾，写回去的字贴着右边那个空格，渲染成 `|     新|` */
    if (x >= y) { x = a; y = a; }
    out.push({ from: line.from + x, to: line.from + y, text: s.slice(x, y) });
  };
  for (; i < body; i++) {
    if (s[i] === '\\') { i++; continue; }   // `\|` 是正文里的竖线，不是分隔
    if (s[i] === '|') { push(start, i); start = i + 1; }
  }
  /* 收尾竖线后面没有内容：那一格不存在 */
  if (!(closed && start >= body)) push(start, body);
  return out;
}

/** 从 Table 节点整理出渲染 + 写回所需的一切：每行的格子（含偏移）、对齐、原文 */
function tableModel(doc, node) {
  const first = doc.lineAt(node.from).number;
  const lastNo = doc.lineAt(Math.max(node.from, Math.min(node.to - 1, doc.length))).number;
  if (lastNo <= first) return null;
  const sep = splitCells(doc, first + 1);
  if (!sep.length) return null;
  /* 第 2 行必须是分隔行；不是的话这张「表」其实是普通段落里的几根竖线 */
  if (!sep.every((c) => /^:?-+:?$/.test(c.text.replace(/\s+/g, '')))) return null;
  const cols = sep.length;
  const aligns = sep.map((c) => {
    const t = c.text.replace(/\s+/g, '');
    const l = t.startsWith(':');
    const r = t.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const cells = [splitCells(doc, first)];
  for (let ln = first + 2; ln <= lastNo; ln++) cells.push(splitCells(doc, ln));
  return {
    from: doc.line(first).from,
    to: doc.line(lastNo).to,
    /* 比对原文而不是逐格文本：只改空格时逐格文本一样，偏移却变了 */
    raw: doc.sliceString(doc.line(first).from, doc.line(lastNo).to),
    rows: cells.map((cs) => cs.map((c) => c.text)),
    aligns,
    cells,
    cols,
  };
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
           用户看不到它、点不进去，只能靠撤销。这种块一律把围栏露出来，
           至少是可见可点的 */
        if (!bodyLines) {
          for (const ln of fenceLns) {
            line(doc.line(ln).from, 'w-code cm-lp-code cm-lp-fence', { 'data-type': 'code' });
          }
          return false;
        }
        /* 光标是不是压在这一行围栏上。⛔ 判据必须是**单行**，不能是「任一围栏
           命中就整块转源码」：用户打完收尾 ``` 时光标正好停在那一行，整块
           （连同上面对代码的着色）会一起跳成源码态 —— 实测读数就是
           「代码块渲染坏了 / 慢一步」。现在只露被压住的那一行围栏，
           正文永远保持渲染。 */
        const fenceHit = (ln) => {
          const L = doc.line(ln);
          return touched(ranges, L.from, L.to);
        };
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
          const m = doc.sliceString(f0.from, f0.to).match(/^\s*(?:```|~~~)\s*([^\s`]+)?/);
          const info = m && m[1] ? m[1] : '';
          /* info string 的字符区间：语言下拉选完之后就替换这一段 */
          const infoEnd = f0.from + (m ? m[0].length : 3);
          const infoStart = infoEnd - info.length;
          const body = [];
          for (let ln = firstLn; ln <= sp.lastLine; ln++) {
            if (isFence(ln)) continue;
            body.push(doc.line(ln).text);
          }
          items.push({
            from: f0.from, to: f0.from,
            deco: Decoration.widget({
              widget: new CodeBarWidget(info, body.join('\n'), infoStart, infoEnd),
              block: true, side: -1,
            }),
          });
        }
        for (const ln of fenceLns) {
          const L = doc.line(ln);
          if (fenceHit(ln)) {
            /* 只有被光标压住的那一行露出来（用户正在改它） */
            line(L.from, 'w-code cm-lp-code cm-lp-fence', { 'data-type': 'code' });
            continue;
          }
          line(L.from, 'cm-lp-fence-off');
          items.push({ from: L.from, to: L.to, deco: Decoration.replace({}) });
        }
        return false;
      }

      if (n.name === 'Table') {
        const spec = tableModel(doc, n.node);
        if (spec) {
          const sp = blockSpan(doc, n.from, n.to);
          /* 只在「光标严格落在表内」时退回源码 —— 查找跳进某一格、右键
             「编辑源码」属于这一类。点在格子上不会动光标（widget 自己拦了），
             所以日常看到的永远是表格。
             ⛔ 别改回 touched()：它两端都算命中，insertTable 之后光标正好停在
             表格末尾，整张表会当场塌成源码。 */
          if (strictInside(ranges, n.from, n.to)) {
            for (let ln = doc.lineAt(sp.from).number; ln <= sp.lastLine; ln++) {
              line(doc.line(ln).from, 'w-table cm-lp-table-src', { 'data-type': 'table' });
            }
          } else {
            items.push({
              from: sp.from, to: sp.to,
              deco: Decoration.replace({ widget: new TableWidget(spec), block: true }),
            });
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
      /* 正文永远着色：块级那边已经把「整块转源码」换成了「只露被压住的那一行
         围栏」，正文一直是渲染态，所以这里没有「在编辑中所以不涂色」这回事。
         ⛔ 别再按光标位置整块关掉着色 —— 用户插完代码块会一直在里面打字，
         那样他看到的永远是纯色原文。 */
      if (n.name !== 'FencedCode') return false;
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
        /* 这三个是行内定界符：用 markActive（光标紧贴不算）而不是 touched。
           用 touched 的后果实测过：打完 `` `code` `` 光标停在第二个反引号后面，
           反引号常亮 —— 用户读数就是「没渲染」。 */
        case 'CodeMark':
          if (inFence(n.from)) return undefined;
          if (!markActive(ranges, n.from, n.to)) hide(n.from, n.to);
          return undefined;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!markActive(ranges, n.from, n.to)) hide(n.from, n.to);
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
          /* 只看 `](url)` 那一段要不要露出来。
             以前用整条 Link 的 touched：光标在**文字**里就整条变源码（`[文字](url)`
             全露），点进链接想改个字都像回到源码模式。现在文字里就是链接的样子，
             想把 URL 调出来，把光标往右挪进 `](` 之后即可。 */
          if (marks.length >= 4 && !markActive(ranges, marks[1].from, n.to)) {
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
      /* 换了一份文档（切标签、重建 state）：上一份文档里的格子偏移在这里
         已经是别的字的位置了，必须作废 */
      resetTableState(view);
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
    extensions: [LP_THEME, blockDeco, inlinePlugin,
      /* 表格那一格的生死簿：文档被别处改了 / 光标被挪走了，都得把状态收掉。
         这两件事都不该由调用方逐个记 —— 漏一处的表现是「命令打在了别处的
         表格上」，查起来极难。 */
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !selfChange) {
          const s = cellEdit;
          if (s) {
            const doc = u.state.doc;
            if (s.ctx.to > doc.length || doc.sliceString(s.ctx.from, s.ctx.to) !== s.ctx.text) {
              closeCell();
              cellMark = null;
            }
          }
        }
        if (u.selectionSet && !cellEdit) cellMark = null;
      }),
    ],
    setDocDir(view, dir) {
      /* 只换变量，不派发事务：改目录一定伴随一次文档载入（切换标签时 render），
         那次 docChanged 会把装饰连同新的图片路径一起重算。 */
      options.docDir = dir || '';
    },
    attach(view) { view.lpOpts = options; },
  };
}
