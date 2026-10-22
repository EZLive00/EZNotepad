// ============================================================
// format.js —— 按文件类型的「一键格式化」与行列处理
// 原则：不丢内容、可撤销、语法错误时不改动原文
// ============================================================

/** 由扩展名判断格式类型 */
export function detectKind(fileName = '') {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!fileName.includes('.')) return 'txt';
  const md = ['md', 'markdown', 'mdown', 'mkd'];
  const code = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'cc', 'hpp',
    'cs', 'css', 'scss', 'less', 'html', 'xml', 'svg', 'vue', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'yaml', 'yml',
    'toml', 'ini', 'conf', 'php', 'rb', 'swift', 'dart', 'lua', 'bat', 'psm1', 'gradle', 'props'];
  if (md.includes(ext)) return 'md';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (code.includes(ext)) return 'code';
  if (['log', 'csv', 'tsv', 'txt', 'text', 'dat', 'srt', 'ass', 'nfo'].includes(ext)) {
    return ['csv', 'tsv'].includes(ext) ? 'data' : 'txt';
  }
  return 'txt';
}

export function kindLabel(kind) {
  return { md: 'Markdown', json: 'JSON', code: '代码', txt: '纯文本', data: '表格文本' }[kind] || '文本';
}

/** 该类型支持哪些模式 */
export function modesFor(kind) {
  if (kind === 'md') return ['wysiwyg', 'edit', 'preview'];
  return ['edit', 'preview'];
}

const trimTrailing = (s) => s.replace(/[ \t]+$/gm, '');

/** 找到 JSON 语法错误的行列（基于 V8 报错信息） */
export function jsonErrorPosition(text, err) {
  const msg = String((err && err.message) || err);
  const mLineCol = msg.match(/line (\d+) column (\d+)/);
  if (mLineCol) return { line: +mLineCol[1], col: +mLineCol[2], message: msg };
  const mPos = msg.match(/position (\d+)/);
  if (mPos) {
    const before = text.slice(0, +mPos[1]);
    const lines = before.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1, message: msg };
  }
  // 兜底：用宽松扫描定位第一个非法结构（如多余的 } 或缺失的逗号）
  const p = scanJsonError(text);
  if (p) return { line: p.line, col: p.col, message: msg };
  return { line: 0, col: 0, message: msg };
}

/** 逐字符扫描，返回第一个明显的结构错误位置 */
function scanJsonError(text) {
  const stack = [];
  let inStr = false, esc = false, line = 1, col = 0;
  const at = () => ({ line, col });
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '\n') { line++; col = 0; continue; }
    col++;
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === '\\') { esc = true; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); }
    else if (c === '}' || c === ']') {
      const top = stack.pop();
      const ok = (c === '}' && top === '{') || (c === ']' && top === '[');
      if (!ok) return at();
      if (c === '}' && top === '{' && /[:,]\s*$/.test(text.slice(0, i))) return at();
    }
  }
  if (inStr) return at();
  if (stack.length) return at();
  return null;
}

/** JSON 一键格式化 */
export function formatJSON(text, indent = 2) {
  let src = text.replace(/^\uFEFF/, '');
  const fixes = [];
  // 常见错误自动修复（仅在全角标点、尾逗号、单引号上做保守处理）
  const note = (n) => { if (!fixes.includes(n)) fixes.push(n); };
  let fixed = src
    .replace(/[\u201c\u201d]/g, () => { note('全角引号已改为半角'); return '"'; })
    .replace(/\uff1a/g, () => { note('全角冒号已改为半角'); return ':'; })
    .replace(/,\s*([}\]])/g, (m, c) => { note('已移除多余逗号'); return c; })
    .replace(/\/\/[^\n"]*$/gm, () => { note('已移除行注释'); return ''; })
    .replace(/\/\*[\s\S]*?\*\//g, () => { note('已移除块注释'); return ''; });

  const attempt = (s) => {
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch (e) {
      return { ok: false, err: e };
    }
  };

  let r = attempt(fixed);
  if (!r.ok && fixed !== src) {
    r = attempt(src);
    fixed = src;
    fixes.length = 0;
  }
  if (!r.ok) {
    const p = jsonErrorPosition(fixed, r.err);
    const e = new Error(p.message);
    e.line = p.line;
    e.col = p.col;
    throw e;
  }
  const out = JSON.stringify(r.value, null, indent);
  return { text: out + '\n', notes: fixes };
}

/** Markdown 规范化 */
export function formatMarkdown(text) {
  let s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  s = trimTrailing(s);
  const lines = s.split('\n');
  const out = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) { out.push(line); continue; }

    // 标题：确保 # 后有一个空格，且标题前后有空行
    const h = line.match(/^\s*(#{1,6})([^#\s].*)$/);
    if (h) line = `${h[1]} ${h[2].trim()}`;
    const isHeading = /^#{1,6}\s/.test(line);

    if (isHeading && out.length && out[out.length - 1].trim() !== '') out.push('');

    // 列表符号统一为 -
    if (/^\s*[*+]\s+/.test(line)) line = line.replace(/^(\s*)[*+](\s+)/, '$1-$2');

    out.push(line);
    if (isHeading && i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
  }

  // 连续空行压缩为一行；文末仅留一个换行
  const res = [];
  for (const l of out) {
    if (l.trim() === '' && res.length && res[res.length - 1].trim() === '') continue;
    res.push(l);
  }
  while (res.length && res[res.length - 1].trim() === '') res.pop();
  return { text: res.join('\n') + '\n', notes: [] };
}

/** 纯文本 / 日志 / 代码：保守清理 */
export function formatPlain(text, kind) {
  let s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  s = trimTrailing(s);
  const lines = s.split('\n');
  const out = [];
  for (const l of lines) {
    if (l === '' && out.length && out[out.length - 1] === '') continue; // 压缩连续空行
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const notes = kind === 'code' ? ['统一 LF 换行', '去除行尾空格', '压缩连续空行'] : ['去除行尾空格', '压缩连续空行'];
  return { text: out.join('\n') + '\n', notes };
}

/** 统一入口 */
export function formatByKind(kind, text) {
  switch (kind) {
    case 'json': return formatJSON(text);
    case 'md': return formatMarkdown(text);
    default: return formatPlain(text, kind);
  }
}

/* ---------------- 行列处理 ---------------- */

export const lineOps = {
  sortAsc: (t) => t.split('\n').sort((a, b) => a.localeCompare(b, 'zh-CN')).join('\n'),
  sortDesc: (t) => t.split('\n').sort((a, b) => b.localeCompare(a, 'zh-CN')).join('\n'),
  sortNum: (t) => t.split('\n').sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0)).join('\n'),
  dedupe: (t) => [...new Set(t.split('\n'))].join('\n'),
  removeEmpty: (t) => t.split('\n').filter((l) => l.trim() !== '').join('\n'),
  trimLines: (t) => t.split('\n').map((l) => l.trim()).join('\n'),
  reverse: (t) => t.split('\n').reverse().join('\n'),
};

export const caseOps = {
  upper: (t) => t.toUpperCase(),
  lower: (t) => t.toLowerCase(),
  title: (t) => t.replace(/\b\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
};

/** 全角转半角（仅作用于标点，保留中文汉字） */
export function toHalfWidth(text) {
  return text.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}
