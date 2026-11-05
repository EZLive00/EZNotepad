// ============================================================
// highlight.js —— 轻量语法高亮（正则版，覆盖常见语言）
// 输出 HTML 字符串，需配合 styles.css 中的 .tok-* 类
// ============================================================
import { escapeHtml } from './markdown.js';

const KW = {
  js: 'const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of this async await yield delete void static get set null undefined true false',
  ts: 'const let var function return if else for while do switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of this async await yield delete void static get set null undefined true false interface type enum implements namespace declare readonly public private protected abstract as satisfies',
  jsx: 'const let var function return if else for while switch case break continue new class extends super import export from default try catch finally throw typeof instanceof in of this async await yield delete void static null undefined true false',
  py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self print',
  rust: 'fn let mut const struct enum impl trait pub use mod match if else for while loop return break continue where async await move ref self Self crate super dyn unsafe extern type as in Some None Ok Err true false',
  go: 'package import func var const type struct interface map chan go defer return if else for range switch case break continue select nil true false string int bool error byte rune',
  java: 'public private protected class interface extends implements static final void int long double float boolean char String if else for while switch case break continue return new import package try catch finally throw throws this super null true false',
  c: 'int char float double void long short unsigned signed const static struct union enum typedef return if else for while do switch case break continue goto sizeof extern inline',
  cpp: 'int char float double void long short unsigned signed const static struct class union enum typedef return if else for while do switch case break continue goto sizeof extern inline namespace template typename public private protected virtual override new delete nullptr bool true false using',
  css: '',
  sh: 'if then else fi for in do done while case esac function return export local echo cd exit set unset',
  sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES INDEX DISTINCT UNION ALL',
};

/** 高亮语言别名归一 */
export function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase();
  const map = {
    javascript: 'js', js: 'js', mjs: 'js', cjs: 'js', node: 'js',
    typescript: 'ts', ts: 'ts', tsx: 'tsx',
    jsx: 'jsx', react: 'jsx',
    python: 'py', py: 'py', python3: 'py',
    rust: 'rust', rs: 'rust',
    golang: 'go', go: 'go',
    java: 'java', kotlin: 'java', kt: 'java', cs: 'java', csharp: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', xml: 'html', svg: 'html', vue: 'html',
    bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'sh', ps1: 'sh',
    sql: 'sql', mysql: 'sql',
    json: 'json', jsonc: 'json',
    yaml: 'yaml', yml: 'yaml',
    toml: 'ini', ini: 'ini', conf: 'ini',
    md: 'md', markdown: 'md',
  };
  return map[l] || l;
}

/* ---------------- 语言自动识别 ----------------
 * 代码块没标语言（``` 后面空着）时用它决定怎么上色。做法是给每种语言记一组
 * 特征正则，命中就加权累加，取最高分且过门槛的那个 —— 顺序有意义：更专门的
 * 语言排在前面，同分时先到先得（cpp 必须排在 c 前面，`#include` 两边都命中）。
 *
 * 门槛是必须的：散文里也会出现 `const`、`#`、`:`，没有门槛就会给随手一段文字
 * 套上高亮，比不高亮更难看。这里也不追求「识别得多准」，只要求「贴一段 JSON /
 * 脚本进来能认出来」，认不出就老实不高亮。
 */
const HINTS = {
  json: [
    [/^\s*[[{][\s\S]*[\]}]\s*$/, 2],
    [/"[^"\n]*"\s*:/, 3],
    [/:\s*(?:"|-?\d|true\b|false\b|null\b|\{|\[)/, 2],
  ],
  html: [
    [/<!doctype\s+html/i, 6],
    [/<\/?(?:html|head|body|div|span|p|ul|ol|li|a|table|section|h[1-6]|script|style)\b[^>]*>/i, 3],
    [/<\/[a-z][\w-]*>/i, 2],
    [/&(?:amp|lt|gt|quot|nbsp|#\d+);/, 1],
  ],
  css: [
    [/@(?:media|import|keyframes|font-face|supports)\b/, 3],
    [/[.#]?[a-z][\w-]*(?:\s*[,>+~]\s*[.#]?[a-z][\w-]*)*\s*\{/, 2],
    [/[\w-]+\s*:\s*[^;{}\n]+;/, 2],
    [/\b\d+(?:px|em|rem|vh|vw|s|ms|%)\b/, 1],
  ],
  sh: [
    [/^#!.*\b(?:ba|z|k)?sh\b/m, 6],
    [/^\s*(?:sudo|apt|apt-get|yum|dnf|brew|npm|pnpm|yarn|npx|git|docker|kubectl|systemctl|chmod|mkdir|rm|cp|mv|curl|wget|tar|ssh)\s+[\w.@/-]+/m, 3],
    [/^\s*\$\s+\S/m, 3],
    [/\|\s*(?:grep|awk|sed|sort|uniq|head|tail|xargs|tee)\b/, 2],
    [/\b(?:echo|export|set\s+-e)\b/, 1],
  ],
  py: [
    [/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->[^:]+)?:\s*$/m, 5],
    [/^\s*(?:import|from)\s+[\w.]+\s+import\s+/m, 3],
    [/^\s*(?:if|elif|else|for|while|try|except|finally|with|class)\b[^;{]*:\s*$/m, 2],
    [/\b(?:None|True|False)\b/, 2],
    [/\bself\b/, 2],
    [/\bprint\s*\(/, 1],
  ],
  ts: [
    [/^\s*interface\s+\w+\s*\{/m, 4],
    [/^\s*(?:type|enum)\s+\w+\s*[={]/m, 3],
    [/:\s*(?:string|number|boolean|void|any|unknown|never)\b/, 2],
    [/\b(?:public|private|protected|readonly)\s+\w+/, 2],
  ],
  go: [
    [/^\s*package\s+\w+\s*$/m, 5],
    [/^\s*func\s+(?:\([^)]*\)\s*)?\w+\s*[<(]/m, 3],
    [/:=/, 2],
    [/\bfmt\.\w+\(/, 2],
    [/\b(?:chan|goroutine|defer)\b/, 1],
  ],
  rust: [
    [/^\s*fn\s+\w+\s*[<(]/m, 4],
    [/\blet\s+mut\s+/, 3],
    [/^\s*impl\s+\w+/m, 3],
    [/\b(?:println|format|vec|write)!\s*[\(\[]/, 2],
    [/\b(?:Some|None|Ok|Err)\s*\(/, 1],
  ],
  java: [
    [/^\s*public\s+(?:final\s+|abstract\s+)?(?:class|interface|enum)\s+\w+/m, 4],
    [/\bSystem\.(?:out|err)\.print/, 3],
    [/@Override\b/, 2],
    [/\b(?:private|protected)\s+\w+\s+\w+\s*[;=]/, 2],
  ],
  cpp: [
    [/#include\s*<(?:iostream|vector|string|map|memory|algorithm)>/, 5],
    [/\bstd::\w+/, 3],
    [/\btemplate\s*</, 3],
    [/\b(?:cout|cin|cerr)\s*<</, 2],
  ],
  c: [
    [/#include\s*<\w+\.h>/, 4],
    [/\bint\s+main\s*\(/, 4],
    [/\b(?:printf|scanf|malloc|free|sizeof)\b/, 2],
    [/\b(?:struct|typedef)\s+\w+/, 1],
  ],
  sql: [
    [/\bselect\b[\s\S]{0,400}?\bfrom\b/i, 4],
    [/\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table)\b/i, 3],
    [/\bwhere\b[\s\S]{0,200}?(?:=|>|<|like\b)/i, 1],
  ],
  yaml: [
    [/^---\s*$/m, 2],
    [/^\s*[\w.$-]+:\s*(?:$|[^;{])/m, 2],
    [/^\s*-\s+\S/m, 1],
    [/^\s*#/m, 1],
  ],
  ini: [
    [/^\s*\[[\w.-]+\]\s*$/m, 3],
    [/^\s*[\w.-]+\s*=\s*\S/m, 2],
  ],
  js: [
    [/\b(?:const|let|var)\s+\w+\s*=/, 3],
    [/\bfunction\s*\w*\s*\(/, 2],
    [/=>/, 2],
    [/\bconsole\.\w+\(/, 2],
    [/\b(?:require|import)\s*\(/, 2],
    [/===|!==/, 1],
    [/\b(?:document|window)\.\w+/, 1],
  ],
};

/** 过了这个分才认 —— 低于它宁可不高亮，也别给散文套色 */
const DETECT_MIN = 3;

/**
 * 猜一段代码是什么语言，返回归一后的名字（`''` = 没把握）。
 * @param {string} code
 * @returns {string}
 */
export function detectLang(code) {
  const s = String(code || '');
  if (!s.trim()) return '';
  /* JSON 是唯一能「验算」的：解析通过就不必再看别的语言脸色 */
  const head = s.trim();
  if (head[0] === '{' || head[0] === '[') {
    try { JSON.parse(head); return 'json'; } catch { /* 不是合法 JSON，继续打分 */ }
  }
  let best = '';
  let bestScore = 0;
  for (const [lang, rules] of Object.entries(HINTS)) {
    let score = 0;
    for (const [re, w] of rules) if (re.test(s)) score += w;
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return bestScore >= DETECT_MIN ? best : '';
}


/**
 * 高亮代码
 * @returns {string} HTML（已转义）
 */
export function highlight(code, lang) {
  const L = normalizeLang(lang);
  switch (L) {
    case 'json': return hlJson(code);
    case 'html': return hlHtml(code);
    case 'css': return hlCss(code);
    case 'yaml': return hlYaml(code);
    case 'md': return hlMd(code);
    case 'ini': return hlIni(code);
    default: {
      const kws = KW[L];
      if (!kws) return escapeHtml(code);
      return hlCode(code, L, kws);
    }
  }
}

function wrap(cls, txt) {
  return `<span class="tok-${cls}">${escapeHtml(txt)}</span>`;
}

/** 通用代码高亮：注释、字符串、数字、关键字、函数调用 */
function hlCode(code, lang, kws) {
  const kwSet = new Set(kws.split(/\s+/).filter(Boolean));
  const out = [];
  let i = 0;
  const n = code.length;
  const identStart = /[A-Za-z_$\u4e00-\u9fa5]/;

  while (i < n) {
    const ch = code[i];
    const rest = code.slice(i, i + 3);

    // 行注释
    const lineCmt = ['py', 'sh', 'yaml', 'ini'].includes(lang) ? rest.startsWith('#') : rest.startsWith('//');
    if (lineCmt) {
      let j = code.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(wrap('comment', code.slice(i, j)));
      i = j;
      continue;
    }
    // 块注释 /* */
    if (rest.startsWith('/*')) {
      let j = code.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out.push(wrap('comment', code.slice(i, j)));
      i = j;
      continue;
    }
    // Python 三引号
    if (lang === 'py' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
      const q = rest.slice(0, 3);
      let j = code.indexOf(q, i + 3);
      j = j < 0 ? n : j + 3;
      out.push(wrap('str', code.slice(i, j)));
      i = j;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && code[j] !== ch) {
        if (code[j] === '\\') j++;
        if (code[j] === '\n' && ch !== '`') break;
        j++;
      }
      j = Math.min(j + 1, n);
      out.push(wrap('str', code.slice(i, j)));
      i = j;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch) && !identStart.test(code[i - 1] || '')) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._eE+-]/.test(code[j])) {
        if ((code[j] === '+' || code[j] === '-') && !/[eE]/.test(code[j - 1])) break;
        j++;
      }
      out.push(wrap('num', code.slice(i, j)));
      i = j;
      continue;
    }
    // 标识符
    if (identStart.test(ch)) {
      let j = i;
      while (j < n && /[\w$\u4e00-\u9fa5]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (kwSet.has(word)) out.push(wrap('key', word));
      else if (code[j] === '(') out.push(wrap('fn', word));
      else out.push(escapeHtml(word));
      i = j;
      continue;
    }
    // 标点
    if (/[{}()[\];,.:=+\-*/%<>!&|^~?]/.test(ch)) {
      out.push(wrap('punc', ch));
      i++;
      continue;
    }
    out.push(escapeHtml(ch));
    i++;
  }
  return out.join('');
}

/** JSON：键名、值分色 */
function hlJson(code) {
  const out = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])|(\s+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(escapeHtml(code.slice(last, m.index)));
    if (m[1] !== undefined) {
      if (m[2]) out.push(wrap('attr', m[1]) + wrap('punc', m[2]));
      else out.push(wrap('str', m[1]));
    } else if (m[3] !== undefined) out.push(wrap('num', m[3]));
    else if (m[4] !== undefined) out.push(wrap('key', m[4]));
    else if (m[5] !== undefined) out.push(wrap('punc', m[5]));
    else out.push(m[6]);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(escapeHtml(code.slice(last)));
  return out.join('');
}

/** HTML/XML */
function hlHtml(code) {
  const out = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?)([\w:-]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\s*\/?>)|([^<]+)/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]) out.push(wrap('comment', m[1]));
    else if (m[2]) {
      out.push(wrap('punc', m[2]) + wrap('tag', m[3]));
      if (m[4]) {
        out.push(
          m[4].replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g, (_, a, eq, v) =>
            wrap('attr', a) + wrap('punc', eq) + (v ? wrap('str', v) : ''))
        );
      }
      out.push(wrap('punc', m[5]));
    } else out.push(escapeHtml(m[6]));
  }
  return out.join('');
}

/** CSS */
function hlCss(code) {
  return escapeHtml(code)
    .replace(/(\/\*[\s\S]*?\*\/)/g, (m) => `<span class="tok-comment">${m}</span>`)
    .replace(/([.#][\w-]+|\b[a-z-]+)(\s*\{)/g, (m, a, b) => `<span class="tok-tag">${a}</span>${b}`)
    .replace(/([\w-]+)(\s*:\s*)([^;{}\n]+)/g, (m, a, b, c) =>
      `<span class="tok-attr">${a}</span>${b}<span class="tok-str">${c}</span>`);
}

/** YAML */
function hlYaml(code) {
  return code.split('\n').map((line) => {
    if (/^\s*#/.test(line)) return wrap('comment', line);
    const m = line.match(/^(\s*)([\w.\-"' ]+)(:)(.*)$/);
    if (m) return m[1] + wrap('attr', m[2]) + wrap('punc', m[3]) + wrap('str', m[4]);
    return escapeHtml(line);
  }).join('\n');
}

/** INI/TOML */
function hlIni(code) {
  return code.split('\n').map((line) => {
    if (/^\s*[#;]/.test(line)) return wrap('comment', line);
    if (/^\s*\[.*\]\s*$/.test(line)) return wrap('tag', line);
    const m = line.match(/^(\s*)([\w.\-]+)(\s*=\s*)(.*)$/);
    if (m) return m[1] + wrap('attr', m[2]) + wrap('punc', m[3]) + wrap('str', m[4]);
    return escapeHtml(line);
  }).join('\n');
}

/** Markdown 源码高亮 */
function hlMd(code) {
  return code.split('\n').map((line) => {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return `<span class="tok-key">${escapeHtml(line)}</span>`;
    if (/^\s*```/.test(line)) return wrap('comment', line);
    if (/^\s*>/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`;
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      return line.replace(/^(\s*([-*+]|\d+[.)]))(\s)/, (m, a, b, c) => `<span class="tok-punc">${escapeHtml(a)}</span>${c}`)
        .replace(/\*\*(.+?)\*\*/g, '<span class="tok-attr">**$1**</span>')
        .replace(/`([^`]+)`/g, '<span class="tok-str">`$1`</span>');
    }
    return escapeHtml(line)
      .replace(/^(#{1,6}\s.*)$/, '<span class="tok-key">$1</span>')
      .replace(/\*\*(.+?)\*\*/g, '<span class="tok-attr">$1</span>')
      .replace(/`([^`]+)`/g, '<span class="tok-str">$1</span>')
      .replace(/(\[[^\]]*\]\([^)]*\))/g, '<span class="tok-fn">$1</span>');
  }).join('\n');
}
