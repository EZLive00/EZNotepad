// ============================================================
// preview.js —— 右侧预览渲染（按文件类型分流，绝不糅合）
//  md      -> 渲染后的 Markdown
//  json    -> 校验 + 高亮（出错时顶部给出 行/列）
//  code    -> 语法高亮 + 行号
//  txt/log -> 等宽只读
// ============================================================
import { renderMarkdown, resolveDocImg } from './markdown.js';
import { highlight, normalizeLang } from './highlight.js';
import { jsonErrorPosition } from './format.js';
import { renderMathIn } from './math.js';

export function renderPreview(kind, text, lang, target, docDir = '') {
  if (kind === 'md') {
    target.innerHTML = renderMarkdown(text, {
      codeHighlight: (code, l) => highlight(code, l),
      imgResolver: (src) => resolveDocImg(src, docDir),
    });
    // 公式在渲染完才扫描：先有 DOM 再让 KaTeX 接手，没公式的话这一步直接返回
    renderMathIn(target);
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
  return `<pre class="plainview">${t || '<span style="color:var(--fg-faint)">（空文件）</span>'}</pre>`;
}

function renderCode(text, lang) {
  const lines = text.split('\n');
  const html = lines.map((l, i) => {
    // 逐行高亮：保证代码块语言状态不串行（对多行注释/字符串有轻微差异，可接受）
    const body = highlight(l, lang) || '&nbsp;';
    return `<div class="codeline"><span class="ln">${i + 1}</span><span class="lc">${body || ' '}</span></div>`;
  });
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
    const loc = err.line ? `第 ${err.line} 行${err.col ? ` 第 ${err.col} 列` : ''}：` : '';
    head = `<div class="json-err">JSON 语法错误 · ${loc}${escape(err.message)}</div>`;
  } else {
    head = `<div class="json-err" style="background:var(--add-bg);color:var(--add-fg);border-left-color:var(--add-fg)">JSON 格式有效 · ${countJsonKeys(text)} 个键</div>`;
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
      if (m) items.push({ level: m[1].length, text: m[2].replace(/[*_`~]/g, '').trim() || '(空标题)', line: i });
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
  // 纯文本 / 日志：按「看起来像标题」的行给出大纲（上限 60 条）
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    if (/^(=+|-{3,}|#{2,}\s+)/.test(t) || /^【.+】/.test(t) || (t.length < 40 && i < 2000 && /^[0-9]+[.、]\s*\S/.test(t))) {
      items.push({ level: 1, text: t.replace(/^[=#]+\s*/, '').slice(0, 60), line: i });
    }
  });
  return items.slice(0, 60);
}
