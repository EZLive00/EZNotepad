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

/**
 * 图片地址落地：Markdown 里存相对路径（assets/x.png）才方便整个文件夹拷走，
 * 但 WebView 只能加载 http(s) / asset: 这类地址，相对路径会被当成
 * http://tauri.localhost/assets/x.png 去要内嵌资源 —— 必然 404。
 * 所以显示时把相对路径拼成绝对路径再转成 asset 协议；序列化时仍写回相对路径
 * （img 上的 data-src 保存原值）。
 */
export function resolveDocImg(src, docDir) {
  if (!src || !docDir) return src;
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(src)) return src;
  if (/^[a-z]:[\\/]/i.test(src) || src.startsWith('//')) return src;   // 已经是绝对路径
  const abs = docDir.replace(/[\\/]+$/, '') + '/' + src.replace(/^\.\//, '');
  try {
    const conv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.convertFileSrc;
    return conv ? conv(abs, 'asset') : src;
  } catch { return src; }
}

/**
 * 标题锚点用的 slug（GitHub 风格，但对中文友好：中日韩字符原样保留）。
 * 目录跳转靠它，所以规则必须稳定 —— 改这里等于让旧目录里的链接失效。
 */
/**
 * 图片 alt 里可以带尺寸：`![示意图|300](a.png)`、`![示意图|300x200](a.png)`。
 * 用 alt 承载而不是另发明一套语法，是因为 alt 本来就是「图片的描述」，
 * 换成 <img width> 之后任何 Markdown 阅读器都能原样接受。
 */
export function splitImgAlt(alt) {
  const m = /^(.*?)\s*\|\s*(\d{1,4})(?:\s*x\s*(\d{1,4}))?\s*$/.exec(alt || '');
  if (!m) return { text: alt || '', width: 0, height: 0 };
  return { text: m[1], width: Number(m[2]) || 0, height: Number(m[3]) || 0 };
}

export function slugify(text) {
  const s = String(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接 / 图片只取文字
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

/** 行内元素渲染 */
export function inline(text, imgResolver) {
  // 先保护行内代码，避免其中的 * _ 被误解析
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  /* 再保护公式，同样是为了不被强调语法吃掉：$x_1 * y$ 里的 _ 和 * 是下标与乘号，
     不是斜体。必须赶在 escapeHtml 之前取原文 —— 转义后 KaTeX 拿到的是 &lt; 而不是 <。 */
  const maths = [];
  const hold = (tex, display) => {
    maths.push({ tex, display });
    return `\u0001M${maths.length - 1}\u0001`;
  };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => hold(t, true));
  s = s.replace(/\$(?=[^\s$])([^$\n]*?[^\s$])\$/g, (_, t) => hold(t, false));

  s = escapeHtml(s);

  // 图片 ![alt](src "title")，alt 里可以带尺寸：![说明|300](a.png) 或 |300x200
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    (_, alt, src, title) => {
      const { text, width, height } = splitImgAlt(alt);
      const shown = imgResolver ? imgResolver(src) : src;
      const dim = (width ? ` width="${width}"` : '') + (height ? ` height="${height}"` : '');
      return `<img src="${shown}" alt="${text}"${dim}${title ? ` title="${title}"` : ''}>`;
    });

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

  /* 还原公式：内容重新转义一次，让 DOM 里的文本正好是原始 TeX，
     auto-render 读的就是这段文本（页面上仍是 $…$，等它来渲染）。 */
  s = s.replace(/\u0001M(\d+)\u0001/g, (_, i) => {
    const { tex, display } = maths[+i];
    const t = escapeHtml(tex);
    return display ? `$$${t}$$` : `$${t}$`;
  });
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

/** 同名标题依次加 -1 -2：目录里两条「## 说明」得各自有地方落 */
function nextSlug(seen, text) {
  const base = slugify(text);
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/**
 * 一批标题的锚点。生成目录时用它，和渲染时用的是同一套规则 ——
 * 两边但凡差一点，目录里的链接就跳不过去。
 */
export function headingSlugs(texts) {
  const seen = new Map();
  return texts.map((t) => nextSlug(seen, t));
}

function uniqueSlug(text, opts) {
  const seen = opts.__slugs || (opts.__slugs = new Map());
  return nextSlug(seen, text);
}

/**
 * 提示块（callout / alert，Obsidian 与 GitHub alerts 同款语法）：
 *   > [!info]  可选标题
 *   > 正文……
 * 键是语法标记（小写），value 的 label 是中文默认标题、icon 对应图标精灵里的 id。
 * note/tip/important/caution 是 GitHub alerts 的命名，收编为别名。
 */
export const CALLOUT_TYPES = {
  info:    { label: '信息', icon: 'info' },
  warning: { label: '警告', icon: 'triangle-alert' },
  danger:  { label: '危险', icon: 'octagon-alert' },
  success: { label: '成功', icon: 'circle-check' },
  note:      { label: '信息', icon: 'info', aliasOf: 'info' },
  tip:       { label: '成功', icon: 'circle-check', aliasOf: 'success' },
  important: { label: '警告', icon: 'triangle-alert', aliasOf: 'warning' },
  caution:   { label: '危险', icon: 'octagon-alert', aliasOf: 'danger' },
};

export const RE_CALLOUT = /^\[!(info|warning|danger|success|note|tip|important|caution)\]\s*(.*)$/i;

/** `[!NOTE]` → 'info'（大小写与别名归一） */
export function normalizeCallout(name) {
  const key = String(name).toLowerCase();
  return CALLOUT_TYPES[key]?.aliasOf || (CALLOUT_TYPES[key] ? key : '');
}

/**
 * 渲染整篇 Markdown。
 * @param {string} md
 * @param {{codeHighlight?: (code:string, lang:string)=>string}} opts
 */
export function renderMarkdown(md, opts = {}) {
  const hl = opts.codeHighlight || ((c) => escapeHtml(c));
  const resolveImg = opts.imgResolver || null;   // 相对图片路径 -> 可加载的绝对地址
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

    // 块级公式 $$ … $$（允许跨行：矩阵、多行推导没人挤在一行里写）
    if (/^\s*\$\$/.test(line)) {
      flushList();
      const rest = line.replace(/^\s*\$\$/, '');
      const same = rest.match(/^([\s\S]*?)\$\$\s*$/);
      if (same) {
        out.push(`<div class="math-block">$$${escapeHtml(same[1])}$$</div>`);
        i++;
        continue;
      }
      const buf = [rest];
      i++;
      while (i < lines.length) {
        const m = lines[i].match(/^([\s\S]*?)\$\$\s*$/);
        if (m) { buf.push(m[1]); i++; break; }
        buf.push(lines[i]);
        i++;
      }
      out.push(`<div class="math-block">$$${escapeHtml(buf.join('\n').trim())}$$</div>`);
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
      out.push(`<h${lv} id="${escapeAttr(uniqueSlug(h[2], opts))}">${inline(h[2], resolveImg)}</h${lv}>`);
      i++;
      continue;
    }

    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(tableAlign);
      const sty = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      /* 单元格换行约定：<br> 字面文本 → 真换行（与编辑器的 mkCell 对称）。
         占位符躲过 escapeHtml，inline 之后再还原 */
      const cellInline = (c) => inline(String(c).replace(/<br\s*\/?>/gi, '\u0001BR\u0001'), resolveImg)
        .replace(/\u0001BR\u0001/g, '<br>');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map((c, k) => `<th${sty(k)}>${cellInline(c)}</th>`).join('') + '</tr></thead><tbody>');
      for (const r of rows) {
        out.push('<tr>' + head.map((_, k) => `<td${sty(k)}>${cellInline(r[k] || '')}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    // 引用（含嵌套内容，简单实现：连续 > 行合并）。
    // 首行带 [!info] 这类标记时升级为提示块（callout）：染色 + 图标标题行。
    if (/^\s*>\s?/.test(line)) {
      flushList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      let co = '';
      let coTitle = '';
      const cm = buf[0] && buf[0].match(RE_CALLOUT);
      if (cm) {
        co = normalizeCallout(cm[1]);
        coTitle = cm[2].trim();
        buf.shift();
      }
      if (co) {
        const def = CALLOUT_TYPES[co];
        const label = coTitle || def.label;
        const body = buf.length ? renderMarkdown(buf.join('\n'), opts) : '';
        out.push(
          `<blockquote class="md-callout md-callout-${co}">`
          + `<div class="co-head"><svg class="co-ico"><use href="#i-${def.icon}"/></svg>${inline(label, resolveImg)}</div>`
          + `${body}</blockquote>`
        );
      } else {
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      }
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
        text: inline(text, resolveImg),
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
        text: inline(ol[2], resolveImg),
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
      para.push(l.endsWith('  ') ? inline(l.trimEnd(), resolveImg) + '<br>' : inline(l, resolveImg));
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
