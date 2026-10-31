// ============================================================
// cm6-entry.js —— CodeMirror 6 的打包入口（构建期文件）
//
// 这个文件不会被浏览器直接加载，只被 scripts/build-cm6.mjs 读，
// 由 esbuild 打成一个单文件 ESM 产物 src/vendor/cm6.js。
//
// 只 re-export 真正用到的东西：esbuild 按 import 裁剪，多写一行
// 没用的导出就是多几 KB，所以这里保持精简。
//
// 项目没有打包器、前端是裸 ESM，所以 CM6 这种「几十个包互相 import」
// 的库必须预打包。运行时只认 src/vendor/cm6.js 那一个文件。
// ============================================================

/* ---- 状态 ---- */
export { EditorState, Compartment, EditorSelection } from '@codemirror/state';

/* ---- 视图 ---- */
export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from '@codemirror/view';

/* ---- 命令 ---- */
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  indentMore,
  indentLess,
  undo,
  redo,
  selectAll,
} from '@codemirror/commands';

/* ---- 语言基础设施 ---- */
export {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  bracketMatching,
  foldGutter,
  foldKeymap,
  StreamLanguage,
} from '@codemirror/language';

/* ---- 自动补全括号 / 引号 ---- */
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

export { tags } from '@lezer/highlight';

/* ---- 具体语言 ---- */
export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { rust } from '@codemirror/lang-rust';
export { go } from '@codemirror/lang-go';
export { json } from '@codemirror/lang-json';
export { css } from '@codemirror/lang-css';
export { html } from '@codemirror/lang-html';
export { sql } from '@codemirror/lang-sql';
export { yaml } from '@codemirror/lang-yaml';
export { markdown } from '@codemirror/lang-markdown';
export { java } from '@codemirror/lang-java';
export { cpp } from '@codemirror/lang-cpp';

/* ---- 只做了 stream 版本的老语言（shell / ini），包一层照样有高亮 ---- */
export { shell } from '@codemirror/legacy-modes/mode/shell';
export { properties } from '@codemirror/legacy-modes/mode/properties';
