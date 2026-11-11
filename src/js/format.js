// ============================================================
// format.js —— 文件类型判定 + 一键格式化
//
// 格式化本身交给 **prettier**（src/vendor/format.js，首次用时才加载）：
// 缩进、折行、引号、尾逗号、Markdown 块间距这些规则一条都不在本项目里，
// 也不再自己写「自动修复全角引号 / 尾逗号」那类正则补丁 —— 那种补丁只在
// 它见过的那几种坏法上有效，修错了还会静默改坏用户的数据。
//
// 「不标准」的文本不再被一句「无法格式化」挡回去，而是三级尽力而为：
//   ① 语言表指定的严格 parser；
//   ② 同族更宽松的 parser（JSON 注释用 json、JS 残缺试 babel-ts …）；
//   ③ 全都解析不了 → formatLoose() 只重排空白，一个非空白字符都不动。
// 语法错误不再是「拒绝操作」，只是「换一条更保守的路径」，结果仍可撤销。
//
// prettier 不管的语言（Python / Go / Rust / SQL …）保持原来的保守清理：
// 统一换行、去行尾空格、压缩连续空行。**不动缩进、不动语法** ——
// 靠缩进定语法的语言重排缩进会改语义，不能为了「看起来整齐」去赌。
// ============================================================
import { tt } from './i18n.js';
import { errText } from './errors.js';
import { LANGS, langForFile, langInfo } from './langs.js';
import { formatLoose } from './format-loose.js';

/** 由文件名判断格式类型（语言表是唯一真源） */
export function detectKind(fileName = '') {
  const id = langForFile(fileName);
  return id ? LANGS[id].kind : 'txt';
}

/** 不能按文本打开的只读格式（目前只有 PDF）。
 *
 *  为什么不当成一个新 kind 塞进编辑器：PDF 是二进制，t.content 里没有文本，
 *  而标签模型会把 content 写进草稿 / localStorage、参与保存、格式化、查找、
 *  外部改动重载 —— 每一条都得为它开特例，改动面大且容易串档。成本最低又
 *  不撒谎的做法是：在点开文件的那个入口就转给系统默认阅读器，本程序不建标签。
 *  白名单只在这一处定义，文件树 / 拖放 / 命令行 / 最近打开都走 openPath()。 */
export function externalFileKind(fileName = '') {
  return /\.pdf$/i.test(String(fileName)) ? 'pdf' : '';
}

export function kindLabel(kind) {
  return { md: 'Markdown', json: 'JSON', code: tt('代码'), txt: tt('纯文本'), data: tt('表格文本') }[kind] || tt('文本');
}

/** 该类型支持哪些模式 */
export function modesFor(kind) {
  if (kind === 'md') return ['wysiwyg', 'edit', 'preview'];
  return ['edit', 'preview'];
}

/* ---------------- prettier 懒加载 ---------------- */

/** 2 MB 的格式化引擎不该进启动路径：按下第一次「格式化」才拉进来 */
let fmtMod = null;
function loadFormatter() {
  if (!fmtMod) fmtMod = import('../vendor/format.js');
  return fmtMod;
}

/**
 * 传给 prettier 的选项。
 * printWidth 100 而不是默认 80：这个应用是「看文件」的，不是写库的，
 * 80 列会把本来一行放得下的配置折成三行。
 * proseWrap: preserve —— 中文段落按用户自己的换行，别重排。
 */
const FORMAT_OPTIONS = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  proseWrap: 'preserve',
  endOfLine: 'lf',
};

/**
 * 严格 parser 解析不了时依次尝试的更宽松 parser。
 * key / value 都必须在 vendor-entry/prettier.js 的 PLUGIN_SETS 里登记过，
 * 否则 formatText() 会直接 reject（写的不是插件导出的 parser 名）。
 * 只列「同族、解析结果仍是可信的同一份数据」的候选：不会拿 Markdown
 * parser 去凑 JSON，也不会为了通过而改写用户的内容。
 */
const LOOSE_CHAIN = {
  'json-stringify': ['json', 'jsonc', 'json5'],
  babel: ['babel-ts'],
  typescript: ['babel-ts'],
};

/** 缩进承载语义的语言：连兜底都不能重排缩进（四空格在 Markdown 是代码块、
 *  在 YAML 是层级），只能退到 formatPlain 的保守清理。其它有 parser 的语言
 *  空白不承载语义，兜底排版才安全。 */
const INDENT_SENSITIVE = new Set(['yaml', 'markdown']);

/** prettier 的 parser 名 → 出错时给人看的语言名 */
function engineLabel(id) {
  const def = langInfo(id);
  return def ? def.label : id;
}

/** 把 prettier 的错误留给提示用：行列 + 语言名，不再拿它拦住格式化 */
function formatError(e, id) {
  const loc = e && e.loc && e.loc.start;
  return {
    message: errText(e).replace(/^\[error\]\s*/i, ''),
    line: loc ? loc.line : 0,
    col: loc ? loc.column : 0,
    engine: engineLabel(id),
  };
}

/* ---------------- 保守清理（prettier 不管的类型） ---------------- */

const trimTrailing = (s) => s.replace(/[ \t]+$/gm, '');

/** 纯文本 / 日志 / 代码：统一换行、去行尾空格、压缩连续空行 */
export function formatPlain(text, kind) {
  const s = trimTrailing(String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
  const out = [];
  for (const l of s.split('\n')) {
    if (l === '' && out.length && out[out.length - 1] === '') continue; // 压缩连续空行
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const notes = kind === 'code'
    ? ['统一 LF 换行', '去除行尾空格', '压缩连续空行']
    : ['去除行尾空格', '压缩连续空行'];
  return { text: out.join('\n') + '\n', notes };
}

/**
 * 一键格式化：严格 → 宽松 → 只重排空白，三级尽力而为，**不因语法错误抛错**。
 *
 * @param {string} kind      detectKind() 的结果
 * @param {string} text      全文
 * @param {string} fileName  用来认语言（不传就按 kind 猜 md / json）
 * @returns {Promise<{text: string, notes: string[], loose?: boolean,
 *                    forced?: boolean, error?: {message:string,line:number,col:number,engine:string}|null}>}
 *          loose  = 宽松 parser 接住了；forced = 所有 parser 都失败、走了空白兜底
 * @throws 只在「格式化引擎本身加载失败」时抛出，那是真故障，不是文本的问题
 */
export async function formatByKind(kind, text, fileName = '') {
  const id = langForFile(fileName) || (kind === 'md' ? 'md' : kind === 'json' ? 'json' : '');
  const def = id ? LANGS[id] : null;
  if (!def || !def.fmt) return formatPlain(text, kind);

  const { formatText } = await loadFormatter();
  const parsers = [def.fmt, ...(LOOSE_CHAIN[def.fmt] || [])];
  let firstError = null;

  for (let i = 0; i < parsers.length; i++) {
    try {
      const out = await formatText(String(text), parsers[i], FORMAT_OPTIONS);
      return {
        text: out,
        notes: i > 0 ? [tt('已按宽松规则')] : [],
        loose: i > 0,
        forced: false,
        error: null,
      };
    } catch (e) {
      if (!firstError) firstError = e;
    }
  }

  /* 全部解析失败：仍按规则排版，但只动空白。错误行列带回去给用户看，
     不弹「无法格式化」把人挡在门外。缩进敏感的语言只做保守清理。 */
  const fallback = INDENT_SENSITIVE.has(def.fmt)
    ? formatPlain(text, kind).text
    : formatLoose(text);
  return {
    text: fallback,
    notes: [tt('原文有语法错误，仅调整空白')],
    loose: false,
    forced: true,
    error: firstError ? formatError(firstError, id) : null,
  };
}

/* ---------------- JSON 出错定位（预览用，非格式化） ---------------- */

/** 找到 JSON 语法错误的行列（基于 V8 报错信息，兜底才自己扫） */
export function jsonErrorPosition(text, err) {
  const msg = errText(err);
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

/* ---------------- 行列处理（与语言无关，保留） ---------------- */

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
