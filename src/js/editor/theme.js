// ============================================================
// theme.js —— CodeMirror 的外观
//
// 设计原则：**颜色全部走 CSS 变量，不在这里写死任何色值**。
// 于是明暗切换、字号调整都只是 body 上换个 data-theme / 改个变量，
// CM6 侧一次 reconfigure 都不用做 —— 也就不会闪、不会丢光标。
//
// 配色变量定义在 styles.css 的 body[data-theme] 里，和预览模式的
// .tok-* 是同一组。改一处，两个渲染器同时变。
// ============================================================
import { EditorView, HighlightStyle, tags } from '../../vendor/cm6.js';

/** 编辑器外壳：字体、行高、行号槽、选区、光标 */
export const cmTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--fg)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },

  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-editor)',
    lineHeight: '1.65',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '14px 0 40vh 0',   // 底部留白：最后一行也能滚到视野中间
    caretColor: 'var(--accent)',
  },
  '.cm-line': { padding: '0 16px 0 4px' },

  /* 行号槽：透明底、右对齐、淡色，和原来的 .linegutter 观感一致 */
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--fg-faint)',
    border: 'none',
    paddingLeft: '10px',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 0',
    minWidth: '26px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--fg-soft)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)',
  },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-faint)', padding: '0 2px' },

  /* 选区与光标 */
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel-bg)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
  },

  /* 括号匹配 */
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: 'none',
  },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--del-fg)' },

  /* 不可见字符（空格、制表符）的记号 */
  '.cm-specialChar': { color: 'var(--tok-tag)' },
}, { dark: false });

/**
 * 语法着色。
 * tag 的覆盖范围按「常见语言里真的会出现」来挑，没有把 @lezer/highlight
 * 的一百多个 tag 全列一遍 —— 漏掉的会退回正文色，不会难看。
 */
export const cmHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword,
          tags.definitionKeyword, tags.modifier, tags.self], color: 'var(--tok-key)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character,
          tags.docString], color: 'var(--tok-str)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--tok-num)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName),
          tags.function(tags.definition(tags.variableName)), tags.labelName],
    color: 'var(--tok-fn)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)],
    color: 'var(--tok-type)' },
  { tag: [tags.tagName, tags.angleBracket, tags.annotation], color: 'var(--tok-tag)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--tok-attr)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket, tags.separator,
          tags.derefOperator], color: 'var(--tok-punc)' },
  { tag: [tags.meta, tags.processingInstruction], color: 'var(--fg-soft)' },
  { tag: tags.invalid, color: 'var(--del-fg)', textDecoration: 'underline wavy' },

  /* Markdown：编辑模式里也要能一眼看出结构 */
  { tag: [tags.heading1, tags.heading2, tags.heading3], color: 'var(--fg)', fontWeight: '600' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--fg)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.monospace, color: 'var(--tok-str)' },
  { tag: tags.quote, color: 'var(--fg-soft)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--tok-punc)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);
