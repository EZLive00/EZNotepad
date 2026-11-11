// ============================================================
// format-loose.js —— 语法错误时的兜底排版（只重排空白）
//
// 一键格式化在 prettier 与所有宽松 parser 都解析失败时走这里。它不是
// 格式化器：不解析语法、不猜语言、不补括号、不改引号，只做一件事——
// 按括号深度重排缩进，在结构边界处换行。**输出里增删的只能是 ASCII
// 空白，一个非空白字符都不许变。**
//
// 为什么敢在没有语法树的情况下动排版：出口有一道硬校验
// （去掉空白后必须与原文逐字符相同），任何词法判断失误最多让排版
// 难看，绝不会像「自动修全角引号」那样静默改坏用户的数据。字符串、
// 模板串、注释内部的空白原样保留，连行尾空格都不碰。
//
// 只给「本来就有 prettier parser」的语言兜底：Python / Go / SQL 这类
// 靠缩进定语法或没有格式化器的语言不会走到这里（它们仍走 formatPlain
// 的保守清理）。
// ============================================================

const MAX_LEN = 300000;
const INDENT = '  ';

const isWs = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const stripWs = (s) => s.replace(/[ \t\r\n]/g, '');
const PAIR = { '}': '{', ']': '[', ')': '(' };
/* 闭括号后跟着这些字符时不再拆行，免得把 `},` / `])` / `}(...)` 撕开。
   末尾依次是左括号与反引号（模板串的续接，写 \u0060 免得在注释里闭合代码引用）。 */
const NO_BREAK_AFTER = ',;)]}.:(\u0060';

/**
 * 兜底排版。
 * @param {string} text 原文
 * @returns {string} 重排后的文本；超大文本或校验不过时原样返回
 */
export function formatLoose(text) {
  const src = String(text ?? '');
  if (!src || src.length > MAX_LEN) return src;

  let out = '';
  let bol = true;          // 当前在行首（这一行还没写过字符）
  let rawLine = false;     // 当前行是字符串/注释内部，不能插缩进
  let pending = false;     // code 态遇到过空白，等下一个字符再决定留不留一个空格
  let mode = 'code';       // code | sq | dq | tpl | line | block
  let esc = false;
  let suppressNl = false;  // 刚因结构符自动换过行；紧邻的原文换行要吃掉，否则 CRLF 文件会冒空行
  const stack = [];        // 括号类型栈；长度就是缩进深度

  const ensure = () => {
    if (!bol) return;
    bol = false;
    if (!rawLine) out += INDENT.repeat(stack.length);
  };

  /** code 态输出一个字符：兑现待留的空格、按需补缩进 */
  const put = (c) => {
    suppressNl = false;                       // 已经写了内容，不再是「紧邻的原文换行」
    if (pending) {
      pending = false;
      if (!bol && out && !/[ \t]$/.test(out)) out += ' ';
    }
    ensure();
    out += c;
  };

  /** 字符串 / 注释内部：原样输出，绝不插缩进、绝不 trim */
  const raw = (c) => {
    if (bol) { bol = false; rawLine = true; }
    out += c;
  };

  /** code 态换行：只清掉自己生成的行尾空格，压缩连续空行 */
  const nl = () => {
    out = out.replace(/[ \t]+$/, '');
    if (out.endsWith('\n\n')) { bol = true; rawLine = false; pending = false; return; }
    out += '\n';
    bol = true;
    rawLine = false;
    pending = false;
  };

  /** 结构符触发的换行：紧邻的原文换行随后会被吃掉，避免重复空行 */
  const autoNl = () => { nl(); suppressNl = true; };

  /** 字面量内部的换行：原样写出，不 trim、不改下一行缩进 */
  const rawNl = (c) => {
    raw(c);
    bol = true;
    rawLine = true;
    pending = false;
  };

  /** 跳过空白看下一个字符，用来判断 `{}`、`[]` 是否为空、`}` 后要不要换行 */
  const peek = (from) => {
    let j = from + 1;
    while (j < src.length && isWs(src[j])) j++;
    return src[j] || '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1] || '';

    /* ---------- 字面量内部：整段原样，只有结束符会改状态 ---------- */
    if (mode === 'line') {
      if (c === '\n') {
        /* 行注释到此结束：换行原样留着（不 trim 注释里的尾空格），
           但下一行回到 code 态，要照常按深度缩进 —— 别沿用 rawLine。 */
        raw(c);
        bol = true;
        rawLine = false;
        pending = false;
        mode = 'code';
      } else raw(c);                          // 注释里的 \r 也是内容，原样留着
      continue;
    }
    if (mode === 'block') {
      if (c === '\n') { rawNl(c); continue; }
      raw(c);
      if (c === '*' && n === '/') { raw(n); i++; mode = 'code'; }
      continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'tpl') {
      if (c === '\n') { rawNl(c); continue; }
      raw(c);                                  // 字符串内的 \r 不能丢
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')
        || (mode === 'tpl' && c === '`')) mode = 'code';
      continue;
    }

    /* ---------- code 态 ---------- */
    if (c === '/' && n === '/') { mode = 'line'; put(c); continue; }
    if (c === '/' && n === '*') { mode = 'block'; put(c); continue; }
    if (c === '"' || c === "'" || c === '`') {
      mode = c === '"' ? 'dq' : c === "'" ? 'sq' : 'tpl';
      esc = false;
      put(c);
      continue;
    }

    if (c === '\r') continue;                 // 统一 LF
    if (c === '\n') {
      if (suppressNl) { suppressNl = false; pending = false; continue; }
      nl();
      continue;
    }
    if (c === ' ' || c === '\t') { pending = true; continue; }

    if (c === '{' || c === '[' || c === '(') {
      put(c);
      stack.push(c);
      /* 空 {} / [] 不拆行；函数参数列表不拆行 */
      if (c !== '(' && peek(i) !== PAIR_CLOSE(c)) autoNl();
      continue;
    }

    if (c === '}' || c === ']' || c === ')') {
      if (stack.length && stack[stack.length - 1] === PAIR[c]) stack.pop();
      if (c !== ')' && !bol) nl();            // 闭 } / ] 另起一行，按弹出后的深度缩进
      put(c);
      const nx = peek(i);
      /* 后面还跟着分隔符/调用链时不拆，免得把 `},` 或 `])` 撕成两行 */
      if (c !== ')' && !NO_BREAK_AFTER.includes(nx)) autoNl();
      continue;
    }

    put(c);
    if ((c === ';' || c === ',') && stack[stack.length - 1] !== '(') autoNl();
  }

  if (out && !out.endsWith('\n')) out += '\n';

  /* 硬不变量：非空白字符序列必须一字不差。做不到就宁可不排版。 */
  return stripWs(out) === stripWs(src) ? out : src;
}

function PAIR_CLOSE(c) {
  return c === '{' ? '}' : c === '[' ? ']' : ')';
}
