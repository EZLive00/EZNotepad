// ============================================================
// format.js —— 文件类型判定 + 一键格式化
//
// 格式化本身交给 **prettier**（src/vendor/format.js，首次用时才加载）：
// 缩进、折行、引号、尾逗号、Markdown 块间距这些规则一条都不在本项目里，
// 也不再自己写「自动修复全角引号 / 尾逗号」那类正则补丁 —— 那种补丁只在
// 它见过的那几种坏法上有效，修错了还会静默改坏用户的数据。
//
// prettier 不管的语言（Python / Go / Rust / SQL …）保持原来的保守清理：
// 统一换行、去行尾空格、压缩连续空行。**不动缩进、不动语法**，
// 因为这几门语言在浏览器侧没有成熟格式化器，硬凑一个必然出错。
// ============================================================
import { tt } from './i18n.js';
import { errText } from './errors.js';
import { LANGS, langForFile, langInfo } from './langs.js';

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

/** prettier 的 parser 名 → 出错时给人看的语言名（对话框里那句「无法格式化」） */
function engineLabel(id) {
  const def = langInfo(id);
  return def ? def.label : id;
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
 * 一键格式化。
 *
 * @param {string} kind      detectKind() 的结果
 * @param {string} text      全文
 * @param {string} fileName  用来认语言（不传就按 kind 猜 md / json）
 * @returns {Promise<{text: string, notes: string[]}>}
 * @throws 语法错误时抛出带 line / col 的 Error（原文件保持不变）
 */
export async function formatByKind(kind, text, fileName = '') {
  const id = langForFile(fileName) || (kind === 'md' ? 'md' : kind === 'json' ? 'json' : '');
  const def = id ? LANGS[id] : null;

  if (def && def.fmt) {
    const { formatText } = await loadFormatter();
    try {
      const out = await formatText(String(text), def.fmt, FORMAT_OPTIONS);
      return { text: out, notes: [] };
    } catch (e) {
      /* prettier 的错误消息自带行列（e.loc.start），原样带着走，
         上层据此弹「第几行第几列」并把光标送过去 */
      const msg = errText(e).replace(/^\[error\]\s*/i, '');
      const err = new Error(msg);
      const loc = e && e.loc && e.loc.start;
      if (loc) { err.line = loc.line; err.col = loc.column; }
      err.engine = engineLabel(id);
      throw err;
    }
  }

  return formatPlain(text, kind);
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
