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

/** 表格行的对齐方式 */
function tableAlign(cell) {
  const c = String(cell).trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return '';
}

/**
 * 把收集到的列表项（带缩进层级）渲染成真正嵌套的 <ul>/<ol>。
 * 纯字符串拼接，不依赖 DOM，方便在无 document 的环境里复用。
 */
function listToHtml(items) {
  /** 层级栈：{ indent, tag, liOpen } */
  const stack = [];
  let html = '';

  const closeList = () => {
    const lv = stack.pop();
    if (lv.liOpen) html += '</li>';
    html += `</${lv.tag}>`;
  };

  for (const it of items) {
    const tag = it.ordered ? 'ol' : 'ul';

    // 1. 缩进回退 → 关掉更深的层
    while (stack.length && it.indent < stack[stack.length - 1].indent) closeList();

    let top = stack[stack.length - 1];
    // 2. 同层但换了列表类型 → 关掉当前列表，另起一个
    if (top && it.indent === top.indent && top.tag !== tag) {
      closeList();
      top = stack[stack.length - 1];
    }

    const needNew = !top || it.indent > top.indent || top.tag !== tag;
    if (needNew) {
      const cls = it.task !== null ? ' class="task-list"' : '';
      const start = it.ordered && it.start > 1 ? ` start="${it.start}"` : '';
      html += `<${tag}${cls}${start}>`; // 父层的 <li> 保持打开，形成嵌套
      stack.push({ indent: it.indent, tag, liOpen: false });
    } else if (top.liOpen) {
      html += '</li>';
    }

    const body = it.task !== null
      ? `<input type="checkbox" disabled${it.task ? ' checked' : ''}> ${it.text}`
      : it.text;
    html += `<li>${body}`;
    stack[stack.length - 1].liOpen = true;
  }

  while (stack.length) closeList();
  return html;
}

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

  const listItems = [];
  const colStack = [];

  const flushList = () => {
    if (!listItems.length) return;
    out.push(listToHtml(listItems));
    listItems.length = 0;
    colStack.length = 0;
  };

  /** 列表缩进同理：按「列」判断层级，2 / 3 / 4 空格都能读对 */
  const levelOf = (col) => {
    while (colStack.length && col < colStack[colStack.length - 1]) colStack.pop();
    if (!colStack.length) colStack.push(col);
    else if (col > colStack[colStack.length - 1]) colStack.push(col);
    return colStack.length - 1;
  };

  const colsOf = (ws) => {
    let n = 0;
    for (const ch of ws) n += ch === '\t' ? 4 : 1;
    return n;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*(```|~~~)\s*([\w#+-]*)\s*$/);
    if (fence) {
      flushList();
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
      flushList();
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }

    // ATX 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushList();
      const lv = h[1].length;
      out.push(`<h${lv} id="h-${i}">${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(tableAlign);
      const sty = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c, k) => `<th${sty(k)}>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) {
        out.push('<tr>' + head.map((_, k) => `<td${sty(k)}>${inline(r[k] || '')}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    // 引用（含嵌套内容，简单实现：连续 > 行合并）
    if (/^\s*>\s?/.test(line)) {
      flushList();
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
      let text = ul[2];
      let task = null;
      const t = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (t) {
        task = t[1].toLowerCase() === 'x';
        text = t[2];
      }
      listItems.push({
        indent: levelOf(colsOf(ul[1])),
        ordered: false,
        start: 1,
        text: inline(text),
        task,
      });
      i++;
      continue;
    }

    // 有序列表
    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ol) {
      listItems.push({
        indent: levelOf(colsOf(ol[1])),
        ordered: true,
        start: +(line.match(/\d+/)?.[0] || 1),
        text: inline(ol[2]),
        task: null,
      });
      i++;
      continue;
    }

    // 段落（连续非空行合并，行尾两个空格 = 硬换行）
    flushList();
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
  flushList();
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
