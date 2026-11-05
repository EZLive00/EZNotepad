// ============================================================
// plain-editor.js —— 纯文本编辑区（CodeMirror 6 的唯一封装点）
//
// 架构约定（重要）：
//   · 整个项目里只有这个文件 import ../../vendor/cm6.js，
//     app.js 一行 CM6 的 API 都不碰。将来换编辑器只改这一层。
//   · 对外接口全部是「文本 + 字符偏移」的语义，没有 DOM 细节，
//     也没有 CM6 的 Position/Selection 类型泄漏出去。
//   · 唯一真源仍是 tab.content：外面读 value / 写 value 即可。
//
// 和旧 textarea 的对应关系：
//     el.editor.value            → .value
//     el.editor.selectionStart   → .selection.from
//     el.editor.setSelectionRange(a,b) → .setSelection(a, b)
//     el.editor.scrollTop        → .scrollTop
//     execCommand('undo')        → .undo()
//     Tab 缩进 / 回车继承缩进     → CM6 的 defaultKeymap 自带
// ============================================================
import {
  EditorState, EditorView, Compartment,
  lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, keymap,
  rectangularSelection, crosshairCursor,
  history, defaultKeymap, historyKeymap, indentWithTab,
  indentMore, indentLess, undo as cmUndo, redo as cmRedo, selectAll as cmSelectAll,
  undoDepth, redoDepth,
  syntaxHighlighting, indentOnInput, indentUnit, bracketMatching, foldGutter, foldKeymap,
  closeBrackets, closeBracketsKeymap, StreamLanguage,
  javascript, python, rust, go, json, css, html, sql, yaml, markdown, java, cpp,
  shell, properties,
} from '../../vendor/cm6.js';
import { cmTheme, cmHighlight } from './theme.js';
import { normalizeLang } from '../highlight.js';

/**
 * 扩展名（经 normalizeLang 归一）→ CM6 语言工厂。
 * sh / ini 官方没出 lezer 语法，用 legacy-modes 的 stream 版本包一层照样高亮；
 * c 和 cpp 共用一个语法（C 本来就是 C++ 的子集，高亮层面没有差别）。
 */
const LANGS = {
  js: () => javascript(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  jsx: () => javascript({ jsx: true }),
  py: () => python(),
  rust: () => rust(),
  go: () => go(),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  sql: () => sql(),
  yaml: () => yaml(),
  md: () => markdown(),
  java: () => java(),
  c: () => cpp(),
  cpp: () => cpp(),
  sh: () => StreamLanguage.define(shell),
  ini: () => StreamLanguage.define(properties),
};

export class PlainEditor {
  /**
   * @param {HTMLElement} host 挂载容器（#editor）
   * @param {object} opts
   *   language   扩展名，如 'js' / 'py' / 'md'
   *   value      初始文本
   *   readOnly   是否只读
   *   onChange   () => void          文档内容变了（不区分来源，载入时不触发）
   *   onCursor   () => void          光标或选区变了
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.silent = false;        // 程序化写入期间压住 onChange
    this.readOnly = !!opts.readOnly;
    this.langKey = normalizeLang(opts.language);

    this.langComp = new Compartment();
    this.readOnlyComp = new Compartment();
    /* 自动换行是 Compartment：切换时不重建 state，撤销历史和选区都还在。
       一个 Compartment 只能装「一个扩展」或扩展数组，所以「不换行」时塞空数组。 */
    this.wrapComp = new Compartment();
    this.wrap = opts.wrap !== false;

    const state = EditorState.create({
      doc: opts.value || '',
      extensions: this._exts(),
    });

    this.view = new EditorView({ state, parent: host });
    /* 滚动回调：大纲要跟着滚（谁滚谁负责通知，外部不必知道滚动容器是谁） */
    this.view.scrollDOM.addEventListener('scroll', () => this.opts.onScroll?.(), { passive: true });
  }

  /* ---------------- 内部 ---------------- */

  _exts() {
    return [
      foldGutter(),                     // 折叠箭头在最左，然后是行号，和 VS Code 同序
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      /* Alt + 拖动 = 竖着选一列（改对齐的表格、批量加前缀时用得上）；
         Alt 按住时光标变十字，提示这个模式存在 */
      rectangularSelection(),
      crosshairCursor(),
      indentOnInput(),
      indentUnit.of('    '),            // 默认是 2 空格，这里跟原来 textarea 的 Tab 宽度保持一致
      bracketMatching(),
      /* 打 ( 自动补 )：写代码和写 Markdown 链接都用得上。
         光标放在一对括号中间时，再打右括号是「跳过去」而不是插入一个 */
      closeBrackets(),
      /* 长行折着显示是记事本的默认行为；关掉之后长行横向滚（见 setWrap）。
         放在 Compartment 里而不是写死，切换时撤销历史和选区都不会丢 */
      this.wrapComp.of(this.wrap ? EditorView.lineWrapping : []),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      cmTheme,
      syntaxHighlighting(cmHighlight),
      this.langComp.of(this._langExt(this.langKey)),
      this.readOnlyComp.of(this._roExt(this.readOnly)),
      /* 剪贴板里是图片：拦下来交给外层落盘，否则 CM6 会安静地什么都不做 */
      EditorView.domEventHandlers({
        paste: (e) => {
          const files = [...((e.clipboardData && e.clipboardData.files) || [])];
          const img = files.find((f) => f && /^image\//.test(f.type));
          if (!img || !this.opts.onPasteImage) return false;
          e.preventDefault();
          this.opts.onPasteImage(img);
          return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !this.silent) this.opts.onChange?.();
        if (u.selectionSet || u.docChanged) this.opts.onCursor?.();
      }),
    ];
  }

  _langExt(key) {
    const make = LANGS[key];
    return make ? make() : [];
  }

  _roExt(v) {
    return v ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
  }

  /** 偏移钳到文档范围内：上层算错位置时宁可落到末尾，也不要抛异常炸掉整次操作 */
  _clamp(n) {
    const len = this.view.state.doc.length;
    return Math.max(0, Math.min(len, Number.isFinite(n) ? n : 0));
  }

  /* ---------------- 内容 ---------------- */

  get value() { return this.view.state.doc.toString(); }

  /**
   * 同一文档内替换内容：保留撤销历史（格式化、转大写、插入链接都走这里）。
   * 切换文档请用 load()。
   */
  set value(text) {
    const cur = this.view.state.doc.toString();
    if (cur === text) return;
    this.silent = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: cur.length, insert: text } });
    } finally {
      this.silent = false;
    }
  }

  /** 换一份文档：重建 state，旧文档的撤销历史不串到新文档上 */
  load(text, language) {
    if (language !== undefined) this.langKey = normalizeLang(language);
    const prevScroll = this.view.scrollDOM.scrollTop;
    this.silent = true;
    try {
      this.view.setState(EditorState.create({ doc: text || '', extensions: this._exts() }));
      this.view.scrollDOM.scrollTop = prevScroll;
    } finally {
      this.silent = false;
    }
  }

  get lineCount() { return this.view.state.doc.lines; }

  /* ---------------- 选区 ---------------- */

  get selection() {
    const r = this.view.state.selection.main;
    return { from: r.from, to: r.to };
  }

  get selectedText() {
    const { from, to } = this.selection;
    return this.view.state.sliceDoc(from, to);
  }

  /** 光标所在行列（都是 1 起）；状态栏用，比切字符串算快 */
  get cursor() {
    const st = this.view.state;
    const pos = st.selection.main.head;
    const line = st.doc.lineAt(pos);
    return { line: line.number, col: pos - line.from + 1, pos };
  }

  setSelection(from, to = from) {
    const a = this._clamp(from);
    this.view.dispatch({ selection: { anchor: a, head: this._clamp(to) } });
  }

  /* ---------------- 视图 ---------------- */

  get element() { return this.host; }

  focus() { this.view.focus(); }

  get hasFocus() { return this.view.hasFocus; }

  get scrollTop() { return this.view.scrollDOM.scrollTop; }
  set scrollTop(v) { this.view.scrollDOM.scrollTop = v; }

  get scrollHeight() { return this.view.scrollDOM.scrollHeight; }

  /** 滚动容器在窗口里的纵坐标（大纲高亮与点击跳转都要用它换算基准线） */
  get rectTop() { return this.view.scrollDOM.getBoundingClientRect().top; }

  setVisible(v) { this.host.classList.toggle('hidden', !v); }

  /**
   * 选中某个偏移并把这一行滚到视野中间。
   * opt.atTop 为真时改为「行顶贴在 yMargin 像素处」（相对滚动容器顶）——大纲点击用。
   * 不走 scrollIntoView 的 yMargin（它对齐的是光标矩形，差半行距），自己按窗口坐标增量补差。
   * 目标点略高于基准线 8px：高亮判据是「基准线落在哪个行块里」，正好压线会取到上一块。
   */
  revealOffset(pos, end = pos, opt = {}) {
    const from = this._clamp(pos);
    this.view.dispatch({ selection: { anchor: from, head: this._clamp(end) } });
    if (opt.atTop) {
      const view = this.view;
      const curY = view.documentTop + view.lineBlockAt(from).top;   // 行顶的窗口坐标
      const target = this.rectTop + (opt.yMargin ?? 96) - 8;
      view.scrollDOM.scrollTop += curY - target;
    } else {
      this.view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    }
    this.view.focus();
  }

  /** 滚到某行（1 起），不改变选区 */
  scrollToLine(line) {
    const st = this.view.state;
    const n = Math.max(1, Math.min(st.doc.lines, line));
    const pos = st.doc.line(n).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  }

  /**
   * 视口内某一点的纵坐标（相对可视区顶部）落在第几行（1 起）。
   * 大纲跟随滚动用：算「现在读到哪一行」，不用自己累加行高（折行会算错）。
   */
  lineAtViewportY(viewportY = 0) {
    const view = this.view;
    // CM6 的高度是「文档坐标」（从文档顶端算起），documentTop 是文档顶端在视口里的位置
    const docY = viewportY - view.documentTop;
    const block = view.lineBlockAtHeight(Math.max(0, docY));
    return view.state.doc.lineAt(block.from).number;
  }

  /* ---------------- 配置 ---------------- */

  setLanguage(language) {
    const key = normalizeLang(language);
    if (key === this.langKey) return;
    this.langKey = key;
    this.view.dispatch({ effects: this.langComp.reconfigure(this._langExt(key)) });
  }

  setReadOnly(v) {
    if (v === this.readOnly) return;
    this.readOnly = v;
    this.view.dispatch({ effects: this.readOnlyComp.reconfigure(this._roExt(v)) });
  }

  /** 自动换行开关。横向滚动的状态由 CM6 自己管：关掉之后 scrollDOM 会
      出现横向滚动条，`lineWrapping` 一加回来宽度立刻回收。 */
  setWrap(on) {
    const v = on !== false;
    if (v === this.wrap) return;
    this.wrap = v;
    this.view.dispatch({ effects: this.wrapComp.reconfigure(v ? EditorView.lineWrapping : []) });
  }

  /* ---------------- 编辑命令 ---------------- */

  undo() { return cmUndo(this.view); }
  redo() { return cmRedo(this.view); }
  /* 工具栏/菜单的可用状态：CM6 的撤销深度只能问这两个函数，
     view.state 里翻不出来（historyField 没导出） */
  canUndo() { return undoDepth(this.view.state) > 0; }
  canRedo() { return redoDepth(this.view.state) > 0; }
  selectAll() { cmSelectAll(this.view); }

  /** 用文本替换当前选区（粘贴、插入片段） */
  insertText(str) {
    this.view.dispatch(this.view.state.replaceSelection(str));
    this.view.focus();
  }

  /** 替换指定区间，可选替换后选中新区间 */
  replaceRange(from, to, insert, { select = false } = {}) {
    const a = this._clamp(from);
    this.view.dispatch({
      changes: { from: a, to: this._clamp(to), insert },
      selection: select ? { anchor: a, head: a + insert.length } : undefined,
      scrollIntoView: true,
    });
  }

  /** ⇥ / ⇧⇥：有选区缩进整段，没选区缩进当前行 */
  indent(dedent = false) {
    return dedent ? indentLess(this.view) : indentMore(this.view);
  }

  destroy() {
    this.view.destroy();
    this.host.innerHTML = '';
  }
}
