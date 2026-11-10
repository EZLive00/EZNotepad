// ============================================================
// preview.js —— 右侧预览渲染（按文件类型分流，绝不糅合）
//  md      -> 渲染后的 Markdown
//  json    -> 校验 + 高亮（出错时顶部给出 行/列）
//  code    -> 语法高亮 + 行号
//  txt/log -> 等宽只读
// ============================================================
import { renderMarkdown, resolveDocImg } from './markdown.js';
import { highlight, highlightLines } from './highlight.js';
import { jsonErrorPosition } from './format.js';
import { renderMathIn } from './math.js';
import { renderDiagrams } from './diagram.js';
import { tt } from './i18n.js';

export function renderPreview(kind, text, lang, target, docDir = '') {
  /* 同一份内容不重复渲染：切模式、切双栏、改设置都会再调一次，
     而 600 段的文档重渲一次要 100 ms 上下，用户看到的是整块闪一下。
     签名挂在容器上；谁把容器清空了，谁负责把 __pvText 置空
     （app.js 的「没有打开的文件」分支就是这么做的）。 */
  if (target.__pvText === text && target.__pvKind === kind
      && target.__pvLang === lang && target.__pvDir === docDir) return;
  target.__pvText = text;
  target.__pvKind = kind;
  target.__pvLang = lang;
  target.__pvDir = docDir;

  if (kind === 'md') {
    target.innerHTML = renderMarkdown(text, {
      codeHighlight: (code, l) => highlight(code, l),
      imgResolver: (src) => resolveDocImg(src, docDir),
    });
    // 公式在渲染完才扫描：先有 DOM 再让 KaTeX 接手，没公式的话这一步直接返回
    renderMathIn(target);
    /* ```mermaid 同理，只是它更慢（要加载引擎 + 布局），所以不 await：
       预览先按源码显示，图算好了再原地换掉。没有 mermaid 块时这一步立即返回，
       连引擎都不会 import。
       留在容器上的 promise 是给「导 PDF / 导 HTML」用的 —— 它们必须等图画完
       再序列化，否则导出的是一段没人渲染的源码 */
    target.__pvDiagrams = renderDiagrams(target);
    return;
  }
  if (kind === 'json') {
    renderJson(text, target);
    return;
  }
  if (kind === 'code') {
    target.innerHTML = renderCode(text, lang || '');
    return;
  }
  target.innerHTML = renderPlain(text);
}

function renderPlain(text) {
  const t = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<pre class="plainview">' + (t || '<span style="color:var(--fg-faint)">' + tt('（空文件）') + '</span>') + '</pre>';
}

function renderCode(text, lang) {
  /* 整段一次交给 highlight.js：逐行喂会把多行注释 / 模板字符串的状态切断，
     颜色从第二行起就是错的。行号与 <div class="codeline"> 由 highlightLines
     切出来（它在换行处自己收尾、下一行重开 span）。 */
  const bodies = highlightLines(text, lang);
  const html = bodies.map((b, i) =>
    `<div class="codeline"><span class="ln">${i + 1}</span><span class="lc">${b || '&nbsp;'}</span></div>`);
  return `<pre class="plainview codeview" style="font-family:var(--font-mono)">${html.join('')}</pre>`;
}

function renderJson(text, target) {
  let err = null;
  try {
    JSON.parse(text);
  } catch (e) {
    err = jsonErrorPosition(text, e);
  }
  let head = '';
  if (err) {
    /* 冒号也进词条：西文要 ": "（带空格），中文是全角「：」，拼在外面就翻译不了 */
    const loc = err.line
      ? tt(err.col ? '第 {line} 行第 {col} 列：' : '第 {line} 行：', { line: err.line, col: err.col })
      : '';
    head = '<div class="json-err">' + tt('JSON 语法错误：{loc}{msg}', { loc, msg: escape(err.message) }) + '</div>';
  } else {
    head = '<div class="json-err ok">' + tt('JSON 有效：{n} 个键', { n: countJsonKeys(text) }) + '</div>';
  }
  // 预览额外提供「已格式化」视图：缩进 2 空格
  let pretty = text;
  if (!err) pretty = JSON.stringify(JSON.parse(text), null, 2);
  target.innerHTML = head + renderCode(pretty, 'json');
}

function countJsonKeys(t) {
  const m = t.match(/"[^"\n]*"\s*:/g);
  return m ? m.length : 0;
}

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 大纲提取：按文件类型给出结构化的大纲条目 */
export function extractOutline(kind, text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const items = [];
  if (kind === 'md') {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      if (fence) return;
      const m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (m) items.push({ level: m[1].length, text: m[2].replace(/[*_`~]/g, '').trim() || tt('(空标题)'), line: i });
    });
    return items;
  }
  if (kind === 'json') {
    let depth = 0;
    lines.forEach((l, i) => {
      const m = l.match(/^\s*"([^"]+)"\s*:\s*(\{|\[)?/);
      if (m) {
        const d = Math.min(3, Math.max(1, Math.floor((l.match(/^\s*/)[0].length || 0) / 2) + 1));
        items.push({ level: d, text: m[1], line: i });
      }
    });
    return items;
  }
  if (kind === 'code') {
    const fnRe = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class|fn|func|pub\s+fn|public\s+\w+|private\s+\w+|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface)\s+([A-Za-z_$][\w$]*)/;
    lines.forEach((l, i) => {
      const m = l.match(fnRe);
      if (m) {
        const name = m[1] || m[2];
        const isClass = /class|interface/.test(l);
        items.push({ level: isClass ? 1 : 2, text: (isClass ? '◇ ' : 'ƒ ') + name, line: i });
      }
    });
    return items.slice(0, 300);
  }
  /* csv / tsv 一行一条记录，不是章节。硬凑出来的「大纲」等于把前 60 行抄一遍，
     点进去毫无导航价值，所以这里干脆不提取（大纲面板会说明原因）。 */
  if (kind === 'data') return items;
  return plainOutline(lines);
}

const PLAIN_MAX = 300;

/** 中文章节单位的层级：章/篇/部 > 节 > 条/款 */
const CN_LEVEL = { 章: 1, 篇: 1, 部: 1, 节: 2, 条: 3, 款: 3 };

/** 纯文本 / 日志的大纲：只认「确实在声明结构」的标记，不猜
 *
 *  以前这条分支是「像标题的行」启发式：`1.` `2.` `3.` 这种连续编号的每一行都
 *  收进来，于是随手一份清单或带序号的日志，效果就是**每行都是大纲**；而且统统
 *  记成同一级 —— 1 / 1.1 / 1.1.1 本来写好的层级被抹平，看着像结构，其实只是把
 *  正文抄了一遍。分隔线更糟：`====` 自己成了标题，文本还是空的。
 *
 *  现在的规则：
 *    · `# 标题`（把 txt 当 Markdown 写的人）、`===` / `---` 下划线式（Setext，
 *      文字在上一行）
 *    · 行首 `【章节】`、`第X章` / `第X节` / `第X条`、`一、…`
 *    · 编号行：全文出现过多级编号（1.1）时才把编号当章节，并按点号段数给层级；
 *      只有单级编号时，要求它**孤零零成一条**（空行断组后组内只有它），连续排成
 *      一串的就是列表 —— 一条都不收
 *  收完再做一次「不许跳级」的归一化：h3 上面没有 h1/h2，缩进会悬空。
 */
function plainOutline(lines) {
  const clip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);
  /* 全文只要有任意一处 1.1 式编号，编号就承担了章节的语义 */
  const nested = lines.some((l) => /^\s*\d{1,3}(?:\.\d{1,3}){1,3}[.、)]?\s+\S/.test(l));
  const numRe = /^(\d{1,3}(?:\.\d{1,3}){0,3})[.、)]?\s+(\S.*)$/;
  const numHit = lines.map((l) => numRe.exec(l.trim()));
  /* 单级编号的「孤独度」：空行断组，组里只有一条才算章节标题。
     只看前后空行不行 —— 文件首尾的行天然缺一侧邻居，那份列表会掐头去尾各收一条。 */
  const solo = new Set();
  if (!nested) {
    let group = [];
    const flush = () => { if (group.length === 1) solo.add(group[0]); group = []; };
    lines.forEach((l, i) => {
      if (!l.trim()) flush();
      else if (numHit[i] && !numHit[i][1].includes('.')) group.push(i);
    });
    flush();
  }

  const items = [];
  const taken = new Set();
  const push = (level, text, line) => {
    if (!text || taken.has(line)) return;     // 同一行只记一次（Setext 会回看上一行）
    taken.add(line);
    items.push({ level, text, line });
  };
  lines.forEach((raw, i) => {
    const s = raw.trim();
    if (!s) return;

    /* 下划线式标题：本行全是 = 或 -，真正的文字在上面一行。
       上面那行自己也是符号/空行时不算 —— 否则 `====` 下面的 `----` 会拿 `====` 当标题。 */
    if (/^={2,}$/.test(s) || /^-{3,}$/.test(s)) {
      const up = (lines[i - 1] || '').trim();
      if (up && !/^[=\-_*~#\s]{2,}$/.test(up)) push(s[0] === '=' ? 1 : 2, clip(up), i - 1);
      return;
    }
    const atx = s.match(/^#{1,6}\s+(.+)$/);
    if (atx) { push(atx[1].length, clip(atx[1].replace(/\s*#+$/, '')), i); return; }
    /* 行首的【…】常常后面还跟着标题文字（`【一】概述`），保留原样 */
    if (/^【[^】]{1,40}】/.test(s) && s.length <= 60) { push(1, clip(s), i); return; }
    /* 章 / 节 / 条本身就是三级，别一律压成一级 */
    const cn = s.match(/^第[一二三四五六七八九十百零〇\d]+([章节条款篇部])/);
    if (cn) { push(CN_LEVEL[cn[1]] || 1, clip(s), i); return; }
    if (/^[一二三四五六七八九十]+、\s*\S/.test(s)) { push(1, clip(s), i); return; }

    if (numHit[i]) {
      if (nested) push(numHit[i][1].split('.').length, clip(s), i);
      else if (solo.has(i)) push(1, clip(s), i);
    }
  });

  let prev = 0;
  for (const it of items) { it.level = Math.min(it.level, prev + 1); prev = it.level; }
  return items.slice(0, PLAIN_MAX);
}
