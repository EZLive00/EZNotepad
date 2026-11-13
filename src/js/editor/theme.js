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

  /* 行号槽：和编辑区同一张纸面（--bg-panel），右对齐、淡色。
     ⚠️ 不能透明：CM6 把它做成 sticky + zIndex 200，不换行横向滚动时长行会从
     它底下经过，透明底就把文字透出来，看着像正文跑到行号左边去了。用不透明
     纸面盖住这一条，明暗主题跟着 CSS 变量自动切，不写死色值。 */
  '.cm-gutters': {
    backgroundColor: 'var(--bg-panel)',
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
  /* 当前行只是「光标在哪」，不是状态、也不该抢注意：走极淡的中性灰。
     以前用 7% 强调色，深色主题里 accent 是亮橙，一条橙红横杠压在纸面上很重。 */
  '.cm-activeLine': {
    backgroundColor: 'var(--active-line-bg)',
  },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-faint)', padding: '0 2px' },

  /* 选区与光标。
     ⛔ 选区底色必须对齐 CM6 默认主题的**完整选择器**：默认是
     `&light.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
     （编辑器类 + 4 个类 = 五级特异性）。写成 `.cm-selectionBackground` 这种
     一级类赢不了它 —— 深色下还会露出 CM6 认为的「浅色」默认淡紫 #d7d4f0，
     又亮又刺眼（darkTheme 没设，CM6 永远按浅色配）。 */
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & .cm-content ::selection': {
    backgroundColor: 'var(--sel-bg)',
    color: 'inherit',
  },
  /* 选中一段文字时，文档里相同的文字也标出来。和所见即所得的
     ::highlight(sn-same) 共用同一个灰阶，两种模式看起来是一套。
     同样要带 & 前缀：默认规则是 `&light .cm-selectionMatch` 两级类。 */
  '& .cm-selectionMatch': {
    backgroundColor: 'var(--sel-match-bg)',
  },
  /* 非 Markdown 文件的「高亮」：== 不是这些文件的语法，写进去就是脏字符。
     所以只给选区挂一层视图装饰，和 md 的 <mark> 同色，但不落盘。 */
  '.cm-view-mark': {
    backgroundColor: 'var(--mark-bg)',
    borderRadius: '2px',
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
