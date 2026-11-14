// ============================================================
// frontmatter.js —— YAML 头（属性区）与 #标签 的解析
//
// 只做「读」，不写回：属性在 P0 是只读的，改 YAML 仍然在源码模式里改。
// 这一层存在的意义是**别把 YAML 当正文渲染**——`---` 落在第一行时，
// 旧的解析会把它当分割线，于是打开一篇 Obsidian 笔记看到的是
// 一条横线 + 几行 key: value + 又一条横线。
//
// 规则对齐 Obsidian（它的属性模型是事实标准）：
//   属性类型 text / list / number / checkbox / date / tags
//   标签允许 字母 数字 _ - /（含 Unicode），至少含一个非数字字符，
//   不含空格；`#1984` 不是标签，`#y1984` 是。
// ============================================================

/** 打开围栏：必须从第 0 个字符开始，且后面紧跟换行 */
const OPEN_RE = /^---[ \t]*\r?\n/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*\r?$/;

/**
 * 把一段文本拆成「头 + 正文」。
 *
 * ⚠️ 认错了比不认更糟：一篇以 `---` 开头、两百行后才又出现 `---` 的散文，
 * 如果整段被当成 YAML，正文就在编辑器里凭空消失了。所以除了围栏成对，
 * 还要求中间那一段**看起来像 YAML**（至少一行是 `key: value`，且首行不是标题/引用）。
 * 不像就原样返回，让 `---` 继续当分割线。
 *
 * @returns {{has:boolean, yaml:string, body:string, raw:string}} raw 是原样的头部文本
 */
export function splitFrontmatter(text) {
  const src = String(text ?? '');
  const none = { has: false, yaml: '', body: src, raw: '' };
  if (!OPEN_RE.test(src)) return none;

  const lines = src.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_RE.test(lines[i])) { close = i; break; }
  }
  if (close < 0) return none;

  const yaml = lines.slice(1, close).join('\n');
  if (!looksLikeYaml(yaml)) return none;
  /* 头部一直吃到正文第一个非空行为止：块模型不表示「文档开头的空行」
     （空行只作块间分隔），留在 body 里就会在来回切模式时被吞掉一行。 */
  let start = close + 1;
  while (start < lines.length && !lines[start].trim()) start++;
  const head = lines.slice(0, start).join('\n');
  /* raw 带上紧跟其后的那个换行，于是恒有 raw + body === 原文。
     少了这一个字符，来回切一次模式文件就多/少一个空行 */
  return {
    has: true,
    yaml,
    body: lines.slice(start).join('\n'),
    raw: start < lines.length ? head + '\n' : head,
  };
}

/** 头部块是否像 YAML。宁可漏认，不能把正文吞掉 */
function looksLikeYaml(yaml) {
  const me = yaml.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!me.length) return true;                        // 空属性区是合法的
  if (/^(#{1,6}\s|>|\||```|~~~)/.test(me[0])) return false;
  return me.some((l) => /^[^\s:#][^:]*:(\s|$)/.test(l) || /^-\s/.test(l));
}

/** 去掉包裹的引号（YAML 里 `"[[链接]]"` 很常见） */
function unquote(v) {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/** 内联列表 `[a, b, "c"]` —— 只按逗号切，不处理嵌套含义（够用且可预测） */
function splitInlineList(body) {
  const out = [];
  let cur = '';
  let quote = '';
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

/** 按值本身判类型。Obsidian 把类型存在库里，我们每次现推——文件才是唯一真相 */
function classify(key, value, isList) {
  if (isList) return 'list';
  if (/^(true|false)$/i.test(value)) return 'checkbox';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) return 'date';
  if (/^\[\[.+\]\]$/.test(value)) return 'link';
  return 'text';
}

/**
 * 解析 YAML 头。只支持属性会用到的那一小撮语法：
 *   key: value / key: [a, b] / key:\n  - a\n  - b / 注释 / 折叠的续行。
 * 遇到不认识的行不抛错，塞进 extra —— 一条怪属性不该让整篇文档打不开。
 *
 * @returns {{entries: Array<{key:string,kind:string,value:string,items:string[]}>, extra: string[]}}
 */
export function parseFrontmatter(yaml) {
  const entries = [];
  const extra = [];
  const lines = String(yaml ?? '').split('\n');
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;

    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && cur) {
      if (cur.kind !== 'list') { cur.kind = 'list'; cur.items = []; }
      cur.items.push(unquote(item[1]));
      cur.value = '';
      continue;
    }

    const kv = line.match(/^([^\s:#][^:]*?)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const rest = kv[2].trim();
      cur = { key, kind: 'text', value: '', items: [], raw: line.trim() };
      entries.push(cur);
      if (!rest) continue;                             // 后面可能跟块列表
      if (rest.startsWith('[') && rest.endsWith(']')) {
        cur.kind = 'list';
        cur.items = splitInlineList(rest.slice(1, -1));
      } else {
        cur.value = unquote(rest);
        cur.kind = classify(key, cur.value, false);
      }
      continue;
    }

    // 续行（YAML 折叠标量）：接在上一项的后面，空一格
    if (cur && cur.kind !== 'list') {
      cur.value = (cur.value ? cur.value + ' ' : '') + line.trim();
      cur.kind = classify(cur.key, cur.value, false);
      continue;
    }
    extra.push(line);
  }

  // tags 是唯一有特殊含义的键：值永远当标签列表
  for (const e of entries) {
    if (/^tags?$/i.test(e.key)) {
      if (e.kind !== 'list') {
        const v = e.value || '';
        e.kind = 'list';
        e.items = v ? v.split(/[,\s]+/).map(unquote).filter(Boolean) : [];
      }
      e.items = e.items.map((t) => String(t).replace(/^#/, '')).filter(Boolean);
      e.value = '';
    }
  }
  return { entries, extra };
}

/** 属性区里的全部标签（用于和行内标签合并） */
export function frontmatterTags(entries) {
  const out = [];
  for (const e of entries || []) {
    if (e.kind === 'list' && /^tags?$/i.test(e.key)) out.push(...e.items);
  }
  return out;
}

/* ------------------------------------------------------------
   行内标签
   ------------------------------------------------------------ */

/* 前面不能是字母/数字/_/-/#/&——挡掉 C#、##、&#123;；标签体只允许
   Obsidian 认可的那几种字符（\p{L} 覆盖中文，emoji 不认，够用） */
const TAG_RE = /(?<![\p{L}\p{N}_\-/&#])#([\p{L}\p{N}_/-]+)/gu;

/**
 * 提取正文里的行内标签。围栏代码块与行内代码里的不算（`#include` 不是标签）。
 * 纯数字的也不算：`#1984` 在 Obsidian 里不是标签。
 */
export function inlineTags(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const clean = line.replace(/`[^`]*`/g, ' ');
    for (const m of clean.matchAll(TAG_RE)) {
      const t = m[1].replace(/\/+$/, '');
      if (!t || !/[^\d]/.test(t)) continue;
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 正文 + 属性区合并去重，保持出现顺序 */
export function allTags(text, entries) {
  const out = [];
  for (const t of [...frontmatterTags(entries), ...inlineTags(splitFrontmatter(text).body)]) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
