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
  syntaxHighlighting, indentOnInput, indentUnit, bracketMatching, foldGutter, foldKeymap,
  javascript, python, rust, go, json, css, html, sql, yaml, markdown,
} from '../../vendor/cm6.js';
import { cmTheme, cmHighlight } from './theme.js';
import { normalizeLang } from '../highlight.js';

/**
 * 扩展名（经 normalizeLang 归一）→ CM6 语言工厂。
 * 表里没有的（java / c / cpp / sh / ini …）退回纯文本，不报错。
 * CM6 官方的语言包就这些，加新语言要同时装包、改 cm6-entry.js、再重新打包。
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

    const state = EditorState.create({
      doc: opts.value || '',
      extensions: this._exts(),
    });

    this.view = new EditorView({ state, parent: host });
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
      EditorView.lineWrapping,          // 记事本的默认行为：长行折着显示
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
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

  setVisible(v) { this.host.classList.toggle('hidden', !v); }

  /** 选中某个偏移并把这一行滚到视野中间 */
  revealOffset(pos, end = pos) {
    const from = this._clamp(pos);
    this.view.dispatch({
      selection: { anchor: from, head: this._clamp(end) },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    this.view.focus();
  }

  /** 滚到某行（1 起），不改变选区 */
  scrollToLine(line) {
    const st = this.view.state;
    const n = Math.max(1, Math.min(st.doc.lines, line));
    const pos = st.doc.line(n).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
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

  /* ---------------- 编辑命令 ---------------- */

  undo() { return cmUndo(this.view); }
  redo() { return cmRedo(this.view); }
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
