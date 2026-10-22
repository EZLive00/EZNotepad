// ============================================================
// markdown.js —— 自研轻量 Markdown 渲染器（零依赖）
// 支持：标题 / 粗斜体 / 删除线 / 行内码 / 围栏代码块 / 列表(含任务)
//       / 引用 / 链接 / 图片 / 表格 / 分割线 / 段落 / 硬换行 / HTML 转义
// ============================================================

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** 行内元素渲染 */
export function inline(text) {
  // 先保护行内代码，避免其中的 * _ 被误解析
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  // 图片 ![alt](src "title")
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, src, title) =>
      `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''}>`);

  // 链接 [text](href)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, txt, href) => `<a href="${href}" target="_blank" rel="noreferrer">${txt}</a>`);

  // 自动链接 <http://...> 已被转义处理，这里跳过
  // 粗斜体 / 粗体 / 斜体 / 删除线
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|\W)__([^_]+)__(?!_)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 还原行内代码
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isTableSep = (line) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/**
 * 渲染整篇 Markdown。
 * @param {string} md
 * @param {{codeHighlight?: (code:string, lang:string)=>string}} opts
 */
export function renderMarkdown(md, opts = {}) {
  const hl = opts.codeHighlight || ((c) => escapeHtml(c));
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const flushList = (buf) => {
    if (!buf.items.length) return;
    const tag = buf.ordered ? 'ol' : 'ul';
    const task = buf.items.some((it) => it.task !== null);
    const cls = task ? ' class="task-list"' : '';
    out.push(`<${tag}${cls}>`);
    for (const it of buf.items) {
      if (task && it.task !== null) {
        out.push(`<li><input type="checkbox" disabled${it.task ? ' checked' : ''}>${it.text}</li>`);
      } else {
        out.push(`<li>${it.text}</li>`);
      }
    }
    out.push(`</${tag}>`);
    buf.items = [];
    buf.ordered = false;
  };

  const listBuf = { items: [], ordered: false };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*(```|~~~)\s*([\w#+-]*)\s*$/);
    if (fence) {
      flushList(listBuf);
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      const code = body.join('\n');
      out.push(`<pre><code class="lang-${escapeAttr(lang)}">${hl(code, lang)}</code></pre>`);
      continue;
    }

    // 空行
    if (/^\s*$/.test(line)) {
      flushList(listBuf);
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushList(listBuf);
      out.push('<hr>');
      i++;
      continue;
    }

    // ATX 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushList(listBuf);
      const lv = h[1].length;
      out.push(`<h${lv} id="h-${i}">${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList(listBuf);
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) {
        out.push('<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    // 引用（含嵌套内容，简单实现：连续 > 行合并）
    if (/^\s*>\s?/.test(line)) {
      flushList(listBuf);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // 无序列表 / 任务列表
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      if (listBuf.ordered) flushList(listBuf);
      let text = ul[2];
      let task = null;
      const t = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (t) {
        task = t[1].toLowerCase() === 'x';
        text = t[2];
      }
      listBuf.items.push({ text: inline(text), task });
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (!listBuf.ordered && listBuf.items.length) flushList(listBuf);
      listBuf.ordered = true;
      listBuf.items.push({ text: inline(ol[1]), task: null });
      i++;
      continue;
    }

    // 段落（连续非空行合并，行尾两个空格 = 硬换行）
    flushList(listBuf);
    const para = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
    ) {
      const l = lines[i];
      para.push(l.endsWith('  ') ? inline(l.trimEnd()) + '<br>' : inline(l));
      i++;
    }
    if (para.length) out.push(`<p>${para.join('\n')}</p>`);
  }
  flushList(listBuf);
  return `<div class="md">${out.join('\n')}</div>`;
}

/** 提取大纲：Markdown 标题 */
export function outlineFromMarkdown(md) {
  const res = [];
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) res.push({ level: m[1].length, text: m[2].replace(/[*_`~]/g, ''), line: idx });
  });
  return res;
}
