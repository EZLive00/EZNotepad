// ============================================================
// live-editor.js —— 「所见即所得」模式的编辑器（CM6 live preview）
//
// 对外接口刻意和旧的 WysiwygEditor 同名同签名：app.js 只换一行实例化，
// 其余几十处调用原样不动。语义上最大的差别是——
//   · 旧内核的「块」是 DOM 元素（.w-block），要序列化回 md
//   · 这里的「块」就是**文档里的行**，块元素只是它当前的渲染壳
// 所以块操作全部退化成「对文本做行级变换」：加 `# `、加 `> `、删整行。
// 这比操作 DOM 简单，也不会出现「DOM 改了但文件没改」。
// ============================================================
import {
  EditorView, syntaxTree, StateEffect, StateField, Decoration,
} from '../../vendor/cm6.js';
import { PlainEditor } from './plain-editor.js';
import { outlineFromMarkdown } from '../markdown.js';

/* ---------------- 查找高亮 ----------------
   旧内核用 CSS Custom Highlight（不动 DOM 是因为 contenteditable 里插 <mark>
   会毁掉光标）。CM6 里目录装饰本来就是「不动文档」的，而且天然只渲染视口 ——
   整篇几千处匹配也只是几个 Decoration，不用再按可见窗口重算一遍。 */
const setFindHits = StateEffect.define();

const findHitField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? Decoration.none : value;
    /* 位置一律夹回当前文档长度之内：查找表是「上一次算出来的偏移」，只要中途
       有一次编辑（连输入法组字都算）它就可能已经越界，而越界的 range 会让
       RangeSet 当场抛 TypeError —— 表现是整篇高亮连同主线程一起炸掉 */
    const len = tr.state.doc.length;
    for (const e of tr.effects) {
      if (!e.is(setFindHits)) continue;
      const { ranges, cur } = e.value;
      if (!ranges || !ranges.length) { next = Decoration.none; continue; }
      const items = [];
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (!r || !Number.isFinite(r.from) || !Number.isFinite(r.to)) continue;
        const from = Math.max(0, Math.min(len, r.from));
        const to = Math.max(0, Math.min(len, r.to));
        if (to <= from) continue;
        items.push(Decoration.mark({ class: i === cur ? 'cm-find-cur' : 'cm-find' }).range(from, to));
      }
      next = items.length ? Decoration.set(items, true) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ---------------- 小工具 ---------------- */

const RE_FENCE = /^\s*(```|~~~)/;
const RE_HEAD = /^(\s{0,3})(#{1,6})\s+/;
const RE_UL = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/;
const RE_OL = /^(\s*)(\d+)[.)]\s+/;
const RE_QUOTE = /^(\s*)(>\s?)+/;

/** 表格分隔行：`| --- | :-: |` */
const isSep = (s) => /\|/.test(s) && /^[\s|:-]+$/.test(s) && /-/.test(s);

/** 会「包住若干行」的块级节点名。块类型判定和块级删除共用一份，
 *  免得两处各记一套、改一处漏一处 */
const BLOCK_NODE_NAMES = [
  'FencedCode', 'CodeBlock', 'Table', 'Blockquote', 'ListItem',
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3',
  'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
];

/** 删除时要整块拿掉的节点：表格 / 代码 / 引用组。
 *  列表项与标题不在内 —— 它们删的是「这一行」，标题的 # 在行内、列表项的
 *  兄弟行是各自独立的块，一起删会把用户没选中的内容也带走 */
const DELETE_NODE_NAMES = ['FencedCode', 'CodeBlock', 'Table', 'Blockquote'];

export class LiveEditor {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.ownerTabId = null;
    this.pe = new PlainEditor(host, {
      language: 'md',
      value: '',
      livePreview: true,
      wrap: opts.wrap !== false,
      docDir: opts.docDir || '',
      extraExt: [findHitField],
      onChange: () => this.opts.onChange?.(this.value),
      onPasteImage: (f) => this.opts.onPasteImage?.(f),
      onCursor: () => this.opts.onCursor?.(),
      /* 滚动量在 CM6 的 scrollDOM 上：外面那层 #wysiwyg 只是挂载点，永远不会滚。
         大纲跟随滚动靠的就是这一条（不接的话只有光标移动才会重算高亮） */
      onScroll: () => this.opts.onScroll?.(),
    });
    /* 重复行用的是 PlainEditor 里那套（纯装饰、文档一改就作废），
       不在这里再挂一份 —— 同一个 view 挂两层会互相覆盖。 */
    this.view = this.pe.view;
  }

  /* ---------------- 对外基本契约 ---------------- */

  /** 旧的 wys.root：容器本身。`firstElementChild` 仍是「第一行」 */
  get root() { return this.view.contentDOM; }

  /** app 用它决定「要不要走模型分支」：CM6 只渲染视口，DOM 里永远不是全文 */
  get virtual() { return true; }

  get loading() { return false; }

  get value() { return this.pe.value; }

  toMarkdown() { return this.pe.value; }

  /* 文档是即时落账的，没有「挂起」这回事；这两个方法留着只为接口对齐 */
  pending() { return false; }
  flush() { return true; }
  markCommitted() {}

  /** 载入一份文档。内容没变就不重建 —— 重建会清掉撤销历史 */
  render(md, caret) {
    const text = String(md ?? '');
    if (this.pe.value !== text) {
      const top = this.pe.scrollTop;
      this.pe.load(text, 'md');
      this.pe.scrollTop = top;
    }
    if (caret != null && Number.isFinite(caret)) {
      this.pe.setSelection(Math.min(caret, this.pe.value.length));
    }
  }

  setDocDir(dir) {
    if (this.pe.lp) this.pe.lp.setDocDir(this.view, dir || '');
  }

  focus() { this.pe.focus(); }
  get hasFocus() { return this.pe.hasFocus; }

  /** 自动换行开关：所见即所得也是 CM6，换行靠同一个 Compartment 摘挂。
   *  ⛔ 别指望 body[data-nowrap] 的 CSS 兜住这一边 —— 那些规则写的是旧内核的
   *  .wysiwyg / .w-code，新内核里 `.cm-content` 自带 white-space，CSS 改不动它
   *  （实测：`不换行` 下 scrollWidth 仍等于 clientWidth，长行照样折着显示）。 */
  setWrap(on) { this.pe.setWrap(on); }

  get scrollTop() { return this.pe.scrollTop; }
  set scrollTop(v) { this.pe.scrollTop = v; }
  get scrollHeight() { return this.pe.scrollHeight; }
  get clientHeight() { return this.view.scrollDOM.clientHeight; }

  /** 滚到底了吗（大纲「最后一条标题」的判据） */
  atScrollEnd() {
    const el = this.view.scrollDOM;
    return el.scrollHeight > el.clientHeight + 4
      && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  }

  /* ---------------- 光标 ---------------- */

  get head() { return this.view.state.selection.main.head; }

  setSelection(from, to = from) {
    this.pe.setSelection(from, to);
  }

  /** 光标所在行的起点 / 整行文本（斜杠面板按行内偏移判断） */
  get lineStart() { return this.view.state.doc.lineAt(this.head).from; }
  get lineText() { return this.view.state.doc.lineAt(this.head).text; }

  caretState() {
    const r = this.view.state.selection.main;
    return { pos: r.head, from: r.from, to: r.to, scrollTop: this.scrollTop };
  }

  restoreCaret(s) {
    if (!s) return;
    const len = this.view.state.doc.length;
    /* 两种形状都收：
       · {from,to} / {pos}  —— 字符偏移，caretState() 给的就是这个
       · {blockIndex,offset} —— 「第几块的第几个字」。新内核里块就是行，
         所以 blockIndex 直接当行号用（0 基）。旧内核的「块」和行不是一一
         对应（代码块、引用组算一块），调用方只拿它做「第一块 / 最后一块」
         这种粗定位，按行算反而更准。 */
    let a;
    if (s.from != null || s.pos != null) a = s.from ?? s.pos;
    else if (s.blockIndex != null) {
      const doc = this.view.state.doc;
      const n = Math.max(1, Math.min(doc.lines, s.blockIndex + 1));
      a = doc.line(n).from + (s.offset || 0);
    } else a = 0;
    a = Math.max(0, Math.min(len, a));
    const b = Math.max(a, Math.min(len, s.to ?? a));
    this.view.dispatch({ selection: { anchor: a, head: b } });
    this.scrollTop = s.scrollTop || 0;
  }

  /** 光标是否落在这一块的最后（Ctrl+Enter「块末尾」的判据） */
  isCaretAtEnd(block) {
    const pos = block ? this._posOfLineEl(block) : this.head;
    if (pos < 0) return null;
    const r = this.view.state.selection.main;
    return r.empty && r.head === this.view.state.doc.lineAt(pos).to;
  }

  /** 把光标放到某一块的开头 */
  placeCaretStart(block) { this.focusBlock(block, false); }

  /* ---------------- 块 ---------------- */

  /** 光标所在的「行元素」。CM6 的行元素就是块，没有内层 .w-text */
  currentBlock() {
    const el = this._lineElAt(this.head);
    if (!el) return null;
    el.dataset.type = this.blockTypeAt(this.head);
    const callout = this.calloutAt(this.head);
    if (callout != null) el.dataset.callout = callout;
    return el;
  }

  /** 从 pos 往上找最近的块级语法节点（只在 names 里挑）。
   *
   *  ⛔ `resolveInner(pos, side)` 的 side 决定「pos 正好落在节点起点」时往哪边
   *  落：`side < 0` 是「往结束于 pos 的那个节点里找」，光标停在行首（尤其位置 0）
   *  时会一路退到 Document，外层 Blockquote / ListItem 一个都找不到 —— 表现是
   *  `blockTypeAt(0)` 把引用组判成普通段落、`deleteBlock` 只删掉第一行。
   *  两个方向都要试，先用 side=1（含起点）。 */
  _blockNodeAt(pos, names) {
    const tree = syntaxTree(this.view.state);
    for (const side of [1, -1]) {
      let n = tree.resolveInner(pos, side);
      for (; n && n.name !== 'Document'; n = n.parent) {
        if (names.includes(n.name)) return n;
      }
    }
    return null;
  }

  /** 光标所在块的类型：p / h1..h6 / li / bq / code / table / hr */
  blockTypeAt(pos = this.head) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    const text = doc.sliceString(line.from, line.to);

    /* 先看语法树里有没有包住它的块节点：表格、代码块这些多行块最准 */
    const node = this._blockNodeAt(pos, BLOCK_NODE_NAMES);
    if (node) {
      switch (node.name) {
        case 'FencedCode': case 'CodeBlock': return 'code';
        case 'Table': return 'table';
        case 'Blockquote': return 'bq';
        case 'ListItem': return 'li';
        case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
        case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
          return 'h' + node.name.slice(-1);
        default: break;
      }
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(text)) return 'hr';
    const h = text.match(RE_HEAD);
    if (h) return 'h' + h[2].length;
    return 'p';
  }

  /** 光标所在行的引用类型：'' = 普通引用，'info' 等 = 提示块；不是引用返回 null */
  calloutAt(pos = this.head) {
    const doc = this.view.state.doc;
    /* 引用组的第一行才带 `[!type]`：往上找到组的开头 */
    let n = doc.lineAt(pos).number;
    while (n > 1 && /^\s*>/.test(doc.line(n - 1).text)) n--;
    const text = doc.line(n).text.replace(/^\s*>\s?/, '');
    const m = text.match(/^\[!(\w+)\]/);
    return m ? m[1].toLowerCase() : '';
  }

  /** 标题级别：0 = 正文，1..6 = 标题，-2 = 列表/引用/代码/表格 */
  headingLevel() {
    const t = this.blockTypeAt();
    if (/^h[1-6]$/.test(t)) return Number(t.slice(1));
    if (t === 'p') return 0;
    return -2;
  }

  _lineElAt(pos) {
    const d = this.view.domAtPos(Math.max(0, Math.min(pos, this.view.state.doc.length)));
    let el = d.node.nodeType === 1 ? d.node : d.node.parentElement;
    return el ? el.closest('.cm-line') : null;
  }

  _posOfLineEl(el) {
    if (!el || !el.isConnected) return -1;
    try { return this.view.posAtDOM(el, 0); } catch { return -1; }
  }

  /** 聚焦某一行（块） */
  focusBlock(block, atEnd = false) {
    const pos = this._posOfLineEl(block);
    if (pos < 0) { this.focus(); return; }
    const line = this.view.state.doc.lineAt(pos);
    this.view.dispatch({ selection: { anchor: atEnd ? line.to : line.from } });
    this.focus();
  }

  /** 在当前块后面插入一个空行，返回新块的元素 */
  insertEmptyAfter(block) {
    const pos = this._posOfLineEl(block);
    if (pos < 0) return this.currentBlock();
    const line = this.view.state.doc.lineAt(pos);
    const at = line.to;
    this.view.dispatch({
      changes: { from: at, insert: '\n' },
      selection: { anchor: at + 1 },
      scrollIntoView: true,
    });
    return this._lineElAt(at + 1);
  }

  focusFirstBlock() {
    this.pe.setSelection(0);
    this.focus();
  }

  /** 最后一行（速记「接着往下写」用）。视口外的行没有 DOM，返回 null 由调用方兜底 */
  lastBlock() {
    return this._lineElAt(this.view.state.doc.length);
  }

  /** 语言切换后重建视图：提示块的默认标题是装饰层按当前语言取的 */
  relabel() {
    this.pe.load(this.pe.value, 'md');
  }

  /** 光标所在块的引用类型：null = 不是引用；'' = 普通引用；'info' 等 = 提示块 */
  calloutOf() {
    return this.blockTypeAt() === 'bq' ? this.calloutAt() : null;
  }

  /* 旧内核的块选中态在这里没有对应物 */
  clearBlockSel() {}
  clearSelMatchNow() {}

  /** 引用整组：返回这一组连续引用行的元素（手柄只认首个） */
  bqGroupOf(block) {
    const pos = this._posOfLineEl(block);
    if (pos < 0) return [block];
    const doc = this.view.state.doc;
    let n = doc.lineAt(pos).number;
    let first = n;
    while (first > 1 && /^\s*>/.test(doc.line(first - 1).text)) first--;
    let last = n;
    while (last < doc.lines && /^\s*>/.test(doc.line(last + 1).text)) last++;
    const out = [];
    for (let i = first; i <= last; i++) {
      const el = this._lineElAt(doc.line(i).from);
      if (el) out.push(el);
    }
    return out.length ? out : [block];
  }

  /* ---------------- 撤销 ---------------- */

  undo() { this.pe.undo(); }
  redo() { this.pe.redo(); }
  canUndo() { return this.pe.canUndo(); }
  canRedo() { return this.pe.canRedo(); }

  /* ---------------- 行级变换：所有块命令的地基 ----------------
     一个改动只派发一次 changes，撤销是一步 —— 和用户的心智一致。 */

  _lineInfo(pos = this.head) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    return { doc, line, text: line.text };
  }

  /** 把当前行整行替换成 next（保留行尾） */
  _replaceLine(line, text, caretOffset) {
    const at = caretOffset == null ? null : line.from + Math.max(0, Math.min(text.length, caretOffset));
    this.view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: at == null ? undefined : { anchor: at },
    });
  }

  /** 在光标所在行前插入若干整行 */
  _insertLines(pos, lines) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    const at = line.from;
    const insert = lines.join('\n') + '\n';
    this.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  }

  /* 标题 / 列表：都是 convertBlock 的特例（同类型再点一次 = 退回正文），
     留着这两个薄壳只为接口对齐 */
  toggleHeading(level) { this.convertBlock(level === 0 ? 'p' : 'h' + level); }

  toggleList(kind) { this.convertBlock(kind); }

  setIndent(block, n) {
    const pos = this._posOfLineEl(block);
    if (pos < 0) return;
    const { line, text } = this._lineInfo(pos);
    const m = text.match(RE_UL) || text.match(RE_OL) || text.match(RE_QUOTE);
    const rest = m ? text.slice(m[0].length) : text;
    const pad = ' '.repeat(Math.max(0, Math.min(8, n)) * 2);
    this._replaceLine(line, pad + rest, pad.length + rest.length);
  }

  /** 调整引用层级（> 的个数） */
  setQuoteLevel(block, n) {
    const pos = this._posOfLineEl(block);
    if (pos < 0) return;
    const { line, text } = this._lineInfo(pos);
    const body = text.replace(/^(\s*)(>\s?)+/, '$1');
    const pad = '> '.repeat(Math.max(0, Math.min(6, n)));
    /* 0 层 = 退成普通段落 */
    const next = n > 0 ? pad + body.trimStart() : body.trimStart();
    this._replaceLine(line, next, next.length);
  }

  /* ---------------- 块类型转换 ----------------
     旧内核的 convertBlock：把「这一块」换成另一种块，**内容跟着走**，
     不另起一块、也不留围栏残渣。文本内核里这件事就是「把这几行换成另外几行」，
     所以先算出「这一块是哪几行、内容是什么」（_blockShape），再渲染成目标形态。

     各块形态的边界（决定 first/last）：
       · 代码块 = 整段围栏；内容不含围栏行，info string 跟着搬
       · 引用 = 连续 `>` 行；内容剥掉 `> `，首行的 `[!type]` 单独记下
       · 标题 / 列表项 = 单行
       · 普通段落 = 连续非空行（markdown 的段落就是这几行）
       · 表格 = 不参与转换（没有可搬的一行文本，硬转会丢列结构） */

  /** 这一块的形态：{ kind, first, last, body, info, callout }（行号 1 基） */
  _blockShape(pos = this.head) {
    const doc = this.view.state.doc;
    const n = doc.lineAt(pos).number;
    const text = (i) => doc.line(i).text;

    if (this._blockNodeAt(pos, ['Table'])) {
      return { kind: 'table', first: n, last: n, body: [text(n)] };
    }

    const fence = this._blockNodeAt(pos, ['FencedCode', 'CodeBlock']);
    if (fence) {
      const first = doc.lineAt(fence.from).number;
      const last = doc.lineAt(Math.max(fence.from, fence.to - 1)).number;
      const body = [];
      for (let i = first + 1; i < last; i++) body.push(text(i));
      const info = (text(first).match(/^\s*(?:```|~~~)\s*(\S*)/) || ['', ''])[1];
      return { kind: 'code', first, last, body, info };
    }

    if (/^\s*>/.test(text(n))) {
      let first = n;
      let last = n;
      while (first > 1 && /^\s*>/.test(text(first - 1))) first--;
      while (last < doc.lines && /^\s*>/.test(text(last + 1))) last++;
      const body = [];
      for (let i = first; i <= last; i++) body.push(text(i).replace(/^(\s*)(>\s?)+/, ''));
      const cm = body[0].match(/^\[!(\w+)\]\s*/);
      const callout = cm ? cm[1].toLowerCase() : '';
      if (cm) body[0] = body[0].slice(cm[0].length);
      return { kind: 'quote', first, last, body, callout };
    }

    const head = text(n).match(RE_HEAD);
    if (head) return { kind: 'h' + head[2].length, first: n, last: n, body: [text(n).replace(RE_HEAD, '')] };

    const ul = text(n).match(RE_UL);
    if (ul) return { kind: ul[2] ? 'task' : 'ul', first: n, last: n, body: [text(n).slice(ul[0].length)] };

    const ol = text(n).match(RE_OL);
    if (ol) return { kind: 'ol', first: n, last: n, body: [text(n).slice(ol[0].length)] };

    let first = n;
    let last = n;
    while (first > 1 && !this._startsBlock(text(first - 1))) first--;
    while (last < doc.lines && !this._startsBlock(text(last + 1))) last++;
    const body = [];
    for (let i = first; i <= last; i++) body.push(text(i));
    return { kind: 'p', first, last, body };
  }

  /** 这一行是否开了新的一块（段落一遇到它就断） */
  _startsBlock(s) {
    return !s.trim() || /^\s*>/.test(s) || RE_HEAD.test(s) || RE_UL.test(s)
      || RE_OL.test(s) || RE_FENCE.test(s) || /^\s*\|/.test(s)
      || /^\s*([-*_])\s*(\1\s*){2,}$/.test(s);
  }

  /** 把 body 渲染成目标形态的若干行 */
  _renderBlock(kind, body, info) {
    const lines = body.length ? body : [''];
    switch (kind) {
      case 'h1': case 'h2': case 'h3':
      case 'h4': case 'h5': case 'h6': {
        /* 标题只有一行：段落里的软换行并成空格，不丢字 */
        return [kind[1] === '1' ? '# ' + lines.join(' ')
          : '#'.repeat(Number(kind[1])) + ' ' + lines.join(' ')];
      }
      case 'ul': return lines.map((l) => '- ' + l);
      case 'ol': return lines.map((l, i) => `${i + 1}. ` + l);
      case 'task': return lines.map((l) => '- [ ] ' + l);
      case 'quote': return lines.map((l) => '> ' + l);
      case 'callout': {
        const type = (info || 'note');
        return lines.map((l, i) => (i === 0 ? `> [!${type}] ` : '> ') + l);
      }
      case 'code': {
        const tag = info ? String(info) : '';
        return ['```' + tag, ...lines, '```'];
      }
      case 'math': return ['$$', ...lines, '$$'];
      case 'p': default: return lines;
    }
  }

  /**
   * 把光标所在的块换成 kind（'p' | 'h1'~'h6' | 'ul' | 'ol' | 'task' |
   * 'quote' | 'code' | 'math' | 'callout:<type>' | 'callout'）。
   * 目标就是当前类型 = 再点一次取消，退回正文段落 —— 和菜单里打勾的项一致。
   */
  convertBlock(kind) {
    const sp = this._blockShape();
    if (sp.kind === 'table') return;
    /* 从引用切成提示块、提示块切成普通引用：都是「引用这一族」内部的换装，
       不该走「再点一次取消」那条路 */
    const cur = sp.kind === 'quote' ? 'quote' : sp.kind;
    let target = kind;
    const sameFamily = cur === 'quote' && (kind === 'quote' || kind === 'callout');
    if (cur === kind && !kind.startsWith('callout:')) target = 'p';
    if (sameFamily) {
      target = kind === 'quote' ? 'p' : kind;
    }
    const info = target === 'code' ? sp.info : (target === 'callout' ? 'note' : '');
    const calloutType = kind.startsWith('callout:') ? kind.slice(8) : '';
    const lines = this._renderBlock(
      calloutType ? 'callout' : target,
      sp.body,
      calloutType || info,
    );
    this._replaceSpan(sp.first, sp.last, lines);
  }

  /** 用 lines 替换 doc 里 first..last 这几行，光标落到首行内容起点 */
  _replaceSpan(first, last, lines) {
    const doc = this.view.state.doc;
    const from = doc.line(first).from;
    const to = doc.line(last).to;
    const text = lines.join('\n');
    /* 光标跳过前缀标记：`> [!warning] ` 这种长前缀也要能一跳就到了正文 */
    const m = text.match(/^\s*(?:#{1,6}\s|>\s*(?:\[!\w+\]\s*)?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s|```\S*)?/);
    const at = from + (m ? m[0].length : 0);
    /* 换出来的内容和原来一模一样（比如在段落上点「正文段落」）就别动文档：
       一次空 dispatch 也是一条撤销记录，用户按 Ctrl+Z 会以为撤销了什么 */
    if (text === doc.sliceString(from, to)) {
      this.view.dispatch({ selection: { anchor: Math.min(at, to) }, scrollIntoView: true });
      return;
    }
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: at }, scrollIntoView: true });
  }

  insertBlock(kind) {
    const { line } = this._lineInfo();
    const text = line.text;

    if (kind === 'code') {
      /* 光标落在两个围栏之间的空行上，直接就能打字 */
      const at = line.to;
      const insert = (text ? '\n\n' : '\n') + '```\n\n```';
      this.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - 4 } });
      return;
    }
    if (kind === 'math') {
      const at = line.to;
      const insert = (text ? '\n\n' : '\n') + '$$\n\n$$';
      this.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - 3 } });
      return;
    }
    if (kind === 'hr') {
      const at = line.to;
      this.view.dispatch({ changes: { from: at, insert: (text ? '\n\n' : '\n') + '---' }, selection: { anchor: at + 5 } });
    }
  }

  /** 提示块：`> [!note] 标题` —— 换装而不是叠一层，整组引用一起跟着走 */
  setCallout(type) { this.convertBlock('callout:' + type); }

  clearCallout(block) {
    const pos = block ? this._posOfLineEl(block) : this.head;
    if (pos < 0) return;
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    const text = line.text.replace(/\[!\w+\]\s*/, '');
    this._replaceLine(line, text, 2 + Math.max(0, text.length - 2));
  }

  /** 删除整块：表格 / 代码块 / 引用组一起删，普通行删一行 */
  deleteBlock(block) {
    const pos = block ? this._posOfLineEl(block) : this.head;
    if (pos < 0) return;
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);

    let first = line.number;
    let last = line.number;
    const node = this._blockNodeAt(pos, DELETE_NODE_NAMES);
    if (node) {
      first = doc.lineAt(node.from).number;
      last = doc.lineAt(Math.max(node.from, node.to - 1)).number;
    }

    const from = doc.line(first).from;
    const to = last < doc.lines ? doc.line(last + 1).from : doc.line(last).to;
    this.view.dispatch({ changes: { from, to }, selection: { anchor: Math.max(0, from) } });
  }

  /* ---------------- 表格 ---------------- */

  /** 光标所在表格的信息：{ table, colIdx, rowIdx, aligns }；不在表格里返回 null */
  tableInfo() {
    const pos = this.head;
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    if (!line.text.includes('|')) return null;

    /* 往上找表头：第一行 + 下一行是分隔行 */
    let head = line.number;
    while (head > 1 && doc.line(head - 1).text.includes('|') && !isSep(doc.line(head).text)) head--;
    if (!isSep(doc.line(head + 1 <= doc.lines ? head + 1 : head).text)) return null;

    const sep = doc.line(head + 1);
    const aligns = sep.text.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
      .map((c) => { const t = c.trim(); const l = t.startsWith(':'); const r = t.endsWith(':'); return l && r ? 'center' : r ? 'right' : l ? 'left' : ''; });

    const colIdx = (line.text.slice(0, pos - line.from).match(/\|/g) || []).length
      - (line.text.trimStart().startsWith('|') ? 1 : 0);

    /* app 的 colAlign 读 table.dataset.aligns —— 给它当前渲染的那张表 */
    const el = this.host.querySelector('.cm-lp-table');
    if (el) el.dataset.aligns = aligns.join(',');

    return { table: el || { dataset: { aligns: aligns.join(',') } }, colIdx: Math.max(0, colIdx), rowIdx: line.number - head, aligns };
  }

  isInTable() { return !!this.tableInfo(); }

  currentCell() { return null; }

  /** 改列对齐：改分隔行里那一段 */
  setColAlign(align) {
    const info = this.tableInfo();
    if (!info) return;
    const doc = this.view.state.doc;
    const line = doc.lineAt(this.head);
    let head = line.number;
    while (head > 1 && doc.line(head - 1).text.includes('|') && !isSep(doc.line(head).text)) head--;
    const sep = doc.line(head + 1);
    const parts = sep.text.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    const k = Math.min(parts.length - 1, Math.max(0, info.colIdx));
    parts[k] = align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---';
    const lead = sep.text.trimStart().startsWith('|') ? '| ' : '';
    const tail = sep.text.trimEnd().endsWith('|') ? ' |' : '';
    this._replaceLine(sep, lead + parts.map((p) => p.trim()).join(' | ') + tail);
  }

  tableCommand(cmd) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(this.head);
    if (!line.text.includes('|')) return;

    let head = line.number;
    while (head > 1 && doc.line(head - 1).text.includes('|') && !isSep(doc.line(head).text)) head--;
    let last = head + 1;
    while (last < doc.lines && doc.line(last + 1).text.includes('|')) last++;

    const rowsText = [];
    for (let i = head; i <= last; i++) rowsText.push(doc.line(i).text);
    const cols = Math.max(1, rowsText[0].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').length);
    const info = this.tableInfo();
    const col = info ? info.colIdx : 0;

    const padRow = (cells) => '| ' + cells.join(' | ') + ' |';
    const emptyRow = () => padRow(Array.from({ length: cols }, () => '   '));
    const at = (i) => rowsText[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');

    if (cmd === 'rowAbove' || cmd === 'rowBelow') {
      const i = cmd === 'rowAbove' ? head : Math.max(head + 1, line.number);
      rowsText.splice(i, 0, emptyRow());
    } else if (cmd === 'delRow') {
      if (line.number <= head + 1) return;          // 表头行不动
      rowsText.splice(line.number - head, 1);
    } else if (cmd === 'colBefore' || cmd === 'colAfter') {
      const k = cmd === 'colBefore' ? col : col + 1;
      for (let i = 0; i < rowsText.length; i++) {
        const cells = at(i);
        cells.splice(Math.min(k, cells.length), 0, isSep(rowsText[i]) ? '---' : '   ');
        rowsText[i] = padRow(cells.map((c) => c.trim()));
      }
    } else if (cmd === 'delCol') {
      if (cols <= 1) return;
      for (let i = 0; i < rowsText.length; i++) {
        const cells = at(i);
        cells.splice(Math.min(col, cells.length - 1), 1);
        rowsText[i] = padRow(cells.map((c) => c.trim()));
      }
    } else if (cmd === 'delTable') {
      this.deleteBlock();
      return;
    } else {
      return;
    }

    const from = doc.line(head).from;
    const to = last < doc.lines ? doc.line(last + 1).from : doc.line(last).to;
    this.view.dispatch({ changes: { from, to, insert: rowsText.join('\n') + (last < doc.lines ? '\n' : '') } });
  }

  insertTable(rows = 3, cols = 3) {
    const n = Math.max(1, Math.min(12, cols));
    const r = Math.max(1, Math.min(30, rows));
    const lines = [
      '| ' + Array.from({ length: n }, (_, i) => `列 ${i + 1}`).join(' | ') + ' |',
      '| ' + Array.from({ length: n }, () => '---').join(' | ') + ' |',
    ];
    for (let i = 1; i < r; i++) lines.push('| ' + Array.from({ length: n }, () => '   ').join(' | ') + ' |');

    const doc = this.view.state.doc;
    const line = doc.lineAt(this.head);
    const at = line.to;
    const insert = (line.text ? '\n\n' : '\n') + lines.join('\n');
    this.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  }

  /* ---------------- 行内 ---------------- */

  get selection() {
    const r = this.view.state.selection.main;
    return { from: r.from, to: r.to };
  }

  /** 选中文字两边加标记；没有选区就插一对，光标停在中间 */
  wrap(marker) {
    const { from, to } = this.selection;
    const sel = this.view.state.sliceDoc(from, to);
    if (from === to) {
      this.view.dispatch({
        changes: { from, insert: marker + marker },
        selection: { anchor: from + marker.length },
      });
      return;
    }
    /* 已经包过就脱掉：选中 `**粗**` 再点加粗 = 取消 */
    const before = this.view.state.sliceDoc(Math.max(0, from - marker.length), from);
    const after = this.view.state.sliceDoc(to, Math.min(this.view.state.doc.length, to + marker.length));
    if (before === marker && after === marker) {
      this.view.dispatch({
        changes: [{ from: from - marker.length, to: from }, { from: to, to: to + marker.length }],
        selection: { anchor: from - marker.length, head: to - marker.length },
      });
      return;
    }
    this.view.dispatch({
      changes: [{ from, insert: marker }, { from: to, insert: marker }],
      /* 变更后的坐标：被包住的那段从 from+len 开始 */
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }

  wrapInline(marker) { this.wrap(marker); }

  /** `==高亮==` 的开关。返回 'on' / 'off' 给 toast 用 */
  toggleMark() {
    const { from, to } = this.selection;
    const len = this.view.state.doc.length;
    /* `==` 有 2 个字符：判断「外面已经包了」要允许选区正好贴着文档开头 */
    const before = from >= 2 ? this.view.state.sliceDoc(from - 2, from) : '';
    const after = to + 2 <= len ? this.view.state.sliceDoc(to, to + 2) : '';
    if (before === '==' && after === '==') {
      this.view.dispatch({
        changes: [{ from: from - 2, to: from }, { from: to, to: to + 2 }],
        selection: { anchor: from - 2, head: to - 2 },
      });
      return 'off';
    }
    this.wrap('==');
    return 'on';
  }

  /** 选区变成链接；没有选区就插入 `[]()` 并把光标放中括号里 */
  applyLink(url) {
    const { from, to } = this.selection;
    const sel = this.view.state.sliceDoc(from, to) || '链接文字';
    const insert = `[${sel}](${url})`;
    this.view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + 1, head: from + 1 + sel.length },
    });
    this.focus();
  }

  insertImage(src, alt = '') {
    const { from, to } = this.selection;
    const insert = `![${alt}](${src})`;
    this.view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    this.focus();
  }

  /** 插入一段 Markdown（模板、目录）：光标处另起一块 */
  insertMarkdown(md, before = false) {
    const doc = this.view.state.doc;
    const line = doc.lineAt(this.head);
    const at = before ? line.from : line.to;
    const body = String(md);
    const lead = before ? '' : (line.text ? '\n\n' : '\n');
    const insert = lead + body + (before ? '\n\n' : '');
    this.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + lead.length + body.length } });
  }

  /* 在指定偏移插入文本（斜杠面板还字符用）。
     caret=false 时不动光标 —— 用户已经点到别处去了，抢回来只会打断他。 */
  insertTextAt(pos, text, caret = true) {
    const len = this.view.state.doc.length;
    const at = Math.max(0, Math.min(len, pos));
    this.view.dispatch({
      changes: { from: at, insert: text },
      ...(caret ? { selection: { anchor: at + text.length } } : {}),
    });
  }

  /* ---------------- 查找 ---------------- */

  /** 按正则扫全文，返回 [{block(1起行号), start, end}]。视口外也算 —— 这是它比 DOM 查找强的地方 */
  findMatches(re) {
    const doc = this.view.state.doc;
    const text = doc.toString();
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out.push({ block: doc.lineAt(m.index).number, start: m.index, end: m.index + m[0].length });
      if (out.length > 5000) break;
    }
    return out;
  }

  /** 把一批匹配画成装饰（当前那一处用实色）。ranges 就是上面 findMatches 的
   *  输出形状 `{block,start,end}`，start/end 是文档偏移 —— 和 replaceRange /
   *  replaceRanges 读的是同一份字段，别在这里换名字（换过一次：读 r.from 拿到
   *  undefined，夹成 NaN 塞进 RangeSet，整篇高亮连同渲染进程一起抛异常）。 */
  markFind(ranges, cur) {
    const list = (ranges || []).map((r) => ({ from: r.start, to: r.end }));
    this.view.dispatch({ effects: setFindHits.of({ ranges: list, cur }) });
  }

  clearFind() {
    this.view.dispatch({ effects: setFindHits.of({ ranges: [], cur: -1 }) });
  }

  /** 第 n 个标题所在行（0 起） */
  _headLines() {
    return outlineFromMarkdown(this.pe.value);
  }

  /** 按字符偏移替换一处（查找替换用）。格式天然保住 —— 它改的是源码里的字 */
  replaceRange(from, to, text) {
    const len = this.view.state.doc.length;
    const a = Math.max(0, Math.min(len, from));
    const b = Math.max(a, Math.min(len, to));
    this.view.dispatch({ changes: { from: a, to: b, insert: text } });
  }

  /** 一次替换多处：合成一个事务，撤销是一步而不是 N 步 */
  replaceRanges(list, text) {
    if (!list || !list.length) return 0;
    const len = this.view.state.doc.length;
    const changes = list
      .map((m) => ({ from: Math.max(0, Math.min(len, m.start)), to: Math.max(0, Math.min(len, m.end)), insert: text }))
      .sort((a, b) => a.from - b.from);
    this.view.dispatch({ changes });
    return changes.length;
  }

  scrollToBlockIndex(n, center = false) {
    const doc = this.view.state.doc;
    const num = Math.max(1, Math.min(doc.lines, n));
    const pos = doc.line(num).from;
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: center ? 'center' : 'start' }),
    });
  }

  scrollToLine(line) {
    this.scrollToBlockIndex(line + 1, false);
  }

  scrollToHeadingIndex(idx) {
    const heads = this._headLines();
    const h = heads[idx];
    if (!h) return;
    const doc = this.view.state.doc;
    const pos = doc.line(h.line + 1).from;
    /* 标题顶贴基准线：和高亮判定用同一个 yMargin，点谁谁亮 */
    const top = this.view.scrollDOM.getBoundingClientRect().top;
    const target = top + Math.min(96, this.view.scrollDOM.clientHeight * 0.3) - 8;
    const fix = () => {
      this.view.scrollDOM.scrollTop += this.view.documentTop + this.view.lineBlockAt(pos).top - target;
    };
    fix();
    requestAnimationFrame(fix);
    this.view.dispatch({ selection: { anchor: pos } });
  }

  /** 当前读到第几个标题（0 起，-1 = 还在第一个标题之前） */
  headingIndexAt() {
    const heads = this._headLines();
    if (!heads.length) return -1;
    const doc = this.view.state.doc;
    const y = this.view.scrollDOM.getBoundingClientRect().top + Math.min(96, this.view.scrollDOM.clientHeight * 0.3);
    let pos = 0;
    try { pos = this.view.posAtCoords({ x: this.view.scrollDOM.getBoundingClientRect().left + 40, y }); } catch { pos = this.view.viewport.from; }
    if (pos == null) pos = this.view.viewport.from;
    const lineNo = doc.lineAt(pos).number - 1;
    let found = -1;
    for (let i = 0; i < heads.length; i++) if (heads[i].line <= lineNo) found = i;
    return found;
  }

  /** 按 slug 找标题块（目录点击用） */
  findHeadingBySlug(slug) {
    const doc = this.view.state.doc;
    const heads = this._headLines();
    const hit = heads.find((h) => {
      const s = String(h.text || '').toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '');
      return s === slug;
    });
    if (!hit) return null;
    return this._lineElAt(doc.line(hit.line + 1).from);
  }

  /* ---------------- 重复行 ----------------

     `dupOn` 必须是**从状态推出来的**，不能自己记一个布尔：整篇重渲
     （切模式回来、重新载入同内容以外的东西）会把装饰连同 state 一起换掉，
     自己记的标记却还亮着 —— app.js 的 dupPainted() 于是认为「已经标着」，
     第一次点击执行的是「取消」，用户看到的就是「点一下没反应」。 */

  get dupOn() { return this.pe.hasDupHighlight; }

  paintDuplicates() {
    const doc = this.view.state.doc;
    const seen = new Map();
    const nums = new Set();
    for (let i = 1; i <= doc.lines; i++) {
      const t = doc.line(i).text.trim();
      if (!t) continue;
      if (seen.has(t)) { nums.add(i); nums.add(seen.get(t)); } else seen.set(t, i);
    }
    this.pe.setDupLines([...nums]);
    return nums.size;
  }

  clearDuplicates() {
    this.pe.clearDupLines();
  }

  /* ---------------- 其他 ---------------- */

  setReadOnly(v) { this.pe.setReadOnly(v); }
  setWrap(on) { this.pe.setWrap(on); }

  destroy() { this.pe.destroy(); }
}
