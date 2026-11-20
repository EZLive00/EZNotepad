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
export { EditorState, Compartment, EditorSelection, StateEffect, StateField } from '@codemirror/state';

/* ---- 视图 ---- */
export {
  EditorView,
  Decoration,
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
  /* 工具栏要显示「还能不能退」，CM6 只能问这两个：view.state 里翻不出深度 */
  undoDepth,
  redo,
  redoDepth,
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

/* ---- 选区匹配：选中一段文字时，把文档里相同的文字一并标出来 ----
   只取这一个扩展，不引官方查找面板的快捷键表 —— 查找条是项目自己实现的，
   两套快捷键会打架。 */
export { highlightSelectionMatches } from '@codemirror/search';

export { tags } from '@lezer/highlight';

/* ---- 具体语言（lezer 语法，增量解析） ---- */
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
export { less } from '@codemirror/lang-less';
export { sass } from '@codemirror/lang-sass';
export { vue } from '@codemirror/lang-vue';
export { php } from '@codemirror/lang-php';

/* ---- 老 CodeMirror 的 stream 语法（官方没出 lezer 版本的） ---- */
export { shell } from '@codemirror/legacy-modes/mode/shell';
export { properties } from '@codemirror/legacy-modes/mode/properties';
export { xml } from '@codemirror/legacy-modes/mode/xml';
export { toml } from '@codemirror/legacy-modes/mode/toml';
export { ruby } from '@codemirror/legacy-modes/mode/ruby';
export { lua } from '@codemirror/legacy-modes/mode/lua';
export { swift } from '@codemirror/legacy-modes/mode/swift';
export { perl } from '@codemirror/legacy-modes/mode/perl';
export { powerShell } from '@codemirror/legacy-modes/mode/powershell';
export { dockerFile as dockerfile } from '@codemirror/legacy-modes/mode/dockerfile';
export { diff } from '@codemirror/legacy-modes/mode/diff';
export { r } from '@codemirror/legacy-modes/mode/r';
export { julia } from '@codemirror/legacy-modes/mode/julia';
export { haskell } from '@codemirror/legacy-modes/mode/haskell';
export { clojure } from '@codemirror/legacy-modes/mode/clojure';
export { erlang } from '@codemirror/legacy-modes/mode/erlang';
export { groovy } from '@codemirror/legacy-modes/mode/groovy';
export { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
export { cmake } from '@codemirror/legacy-modes/mode/cmake';
export { nginx } from '@codemirror/legacy-modes/mode/nginx';
export { vb } from '@codemirror/legacy-modes/mode/vb';
export { verilog } from '@codemirror/legacy-modes/mode/verilog';
export { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
export { fortran } from '@codemirror/legacy-modes/mode/fortran';
export { pascal } from '@codemirror/legacy-modes/mode/pascal';
export { stex } from '@codemirror/legacy-modes/mode/stex';
export { http } from '@codemirror/legacy-modes/mode/http';

/* clike 家族：kotlin / csharp / scala / dart / objc 都由同一个工厂导出，
   它们自带关键字与注释规则，拿来即用 */
export { kotlin, csharp, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike';
