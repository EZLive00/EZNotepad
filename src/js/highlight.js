// ============================================================
// highlight.js —— 语法着色的对外包装（底层是 highlight.js 11）
//
// 这里只做三件事，一句分词规则都没有：
//   1. 把项目里的语言名（扩展名 / 别名）翻成 highlight.js 的语言名；
//   2. 调 hljs.highlight()，把它输出的 `hljs-*` 类名换成我们主题里的
//      `tok-*`（颜色在 styles.css 的 --tok-* 上，两个渲染器共用一份）；
//   3. 没写语言时用 hljs.highlightAuto() 猜（自带的相关度门槛）。
//
// 想支持新语言：不要在下面加 case/正则，去 src/js/langs.js 加一条，
// 再到 src/js/vendor-entry/syntax.js 注册语法，跑 scripts/build-syntax.mjs。
// ============================================================
import hljs from '../vendor/syntax.js';
import { normalizeLang, LANGS } from './langs.js';

export { normalizeLang };

/* ---------------- hljs 作用域 → 主题类 ---------------- */

/**
 * highlight.js 的 scope 名 → styles.css 里的 .tok-*。
 * 只用主题里真有颜色的 9 个类（多出来的 scope 归到最接近的那一档，
 * 别为了「精确」再造十个变量：深色/浅色两套都要维护，迟早对不上）。
 */
const TOK = {
  keyword: 'key', literal: 'key', built_in: 'key', symbol: 'key',
  'variable.language': 'key', 'variable.constant': 'key', 'meta-keyword': 'key',

  string: 'str', 'char.escape': 'str', regexp: 'str', subst: 'attr',

  number: 'num',

  comment: 'comment', quote: 'comment', doctag: 'comment', meta: 'comment',

  title: 'fn', 'title.function': 'fn', function: 'fn', section: 'fn',
  'title.class': 'type', type: 'type', class: 'type',

  tag: 'tag', name: 'tag', 'selector-tag': 'tag', 'selector-class': 'tag', 'selector-id': 'tag',

  attr: 'attr', attribute: 'attr', property: 'attr', variable: 'attr',
  params: 'attr', 'selector-attr': 'attr', 'selector-pseudo': 'attr',

  punctuation: 'punc', operator: 'punc', bracket: 'punc',
};

/** 未知 scope：给标点色。比「整段不上色」好读，也不会跳出主题 */
const TOK_FALLBACK = 'punc';

/**
 * `class="hljs-title function_"` → `title.function`。
 * hljs 11 用下划线表示子作用域，这里翻回点号再查表。
 */
function tokOf(cls) {
  const parts = String(cls || '').trim().split(/\s+/)
    .map((p) => p.replace(/^hljs-/, '').replace(/_$/, ''))
    .filter(Boolean);
  if (!parts.length) return '';
  const scope = parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0];
  return TOK[scope] || TOK[parts[0]] || TOK_FALLBACK;
}

/** 把 hljs 的 HTML 产物改写成我们的类名（只替换 class 属性，不碰文本） */
function retag(html) {
  return html.replace(/class="([^"]*)"/g, (m, cls) => {
    if (!/^hljs-/.test(cls)) return m;
    /* 一段文本只留最内层的一个类：嵌套时外层颜色由内层决定，多写反而打架 */
    return `class="tok-${tokOf(cls)}"`;
  });
}

/* ---------------- 对外 API ---------------- */

/** 注册表里的语言名 → hljs 的语言名（没登记过就原样丢给 hljs 试） */
function hljsName(id) {
  const def = LANGS[id];
  return (def && def.hljs) || id;
}

/**
 * 高亮一段代码，返回 HTML（已转义，类名是 tok-*）。
 * @param {string} code
 * @param {string} lang 扩展名 / 别名 / 规范名都行；空或认不出就走自动识别
 * @returns {string}
 */
export function highlight(code, lang) {
  const text = String(code ?? '');
  if (!text) return '';
  const id = normalizeLang(lang);
  if (id && hljs.getLanguage(hljsName(id))) {
    try {
      return retag(hljs.highlight(text, { language: hljsName(id), ignoreIllegals: true }).value);
    } catch { /* 语法不认这段文本时退回自动识别，绝不整段丢色 */ }
  }
  const guess = detectLang(text);
  if (guess && hljs.getLanguage(hljsName(guess))) {
    try {
      return retag(hljs.highlight(text, { language: hljsName(guess), ignoreIllegals: true }).value);
    } catch { /* 落到纯文本 */ }
  }
  return escapeHtml(text);
}

/** 只做转义（预览里语言不认识时用） */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 猜一段代码是什么语言：先用 JSON.parse 验一遍，再交给 hljs.highlightAuto 打分。
 *
 * 两条硬约束，都是实测出来的：
 *   1. **候选集要收窄**。CSS 的「属性: 值;」模式几乎能匹配任何带冒号的代码，
 *      dart / kotlin / csharp / scala / objc 又都属于 C 家族、长得几乎一样。
 *      把它们放进候选集，`interface Foo { a: string }` 会被判成 CSS，
 *      Python 会被判成 dart。这些语言要么几乎不会出现在无标注的代码块里，
 *      要么彼此本来就分不清 —— 从候选集里拿掉，剩下的判定质量明显更高。
 *   2. **门槛要够高**。highlightAuto 按关键字命中数打分，三四行的片段
 *      常年在 2~7 分之间乱跳。所以 8 分以下一律不上色：宁可没颜色，
 *      也不要涂错颜色（错色比无色更难发现，还会让语言条显示错名字）。
 *      十几行以上的真实代码一般能到 15 分以上，识别稳定。
 */
const DETECT_MIN = 8;
let DETECT_SUBSET = null;

/* highlightAuto 的代价是「语言数 × 文本长度」：实测 4 KB 约 300 ms、70 KB 约 1.1 s。
   它挂在打字后的防抖回调里，所以只喂开头一小段 —— 认语言这事看前 2000 个字符
   和看全文的结论一样，没必要为后半段付钱。 */
const DETECT_SAMPLE = 2000;

function detectSubset() {
  if (!DETECT_SUBSET) {
    const EX = new Set([
      'plaintext', 'css', 'scss', 'less',
      'dart', 'kotlin', 'csharp', 'scala', 'objectivec', 'vbnet',
    ]);
    DETECT_SUBSET = hljs.listLanguages().filter((l) => !EX.has(l));
  }
  return DETECT_SUBSET;
}

/**
 * @param {string} code
 * @returns {string} 规范名（`js` / `py` …）；没把握返回 ''
 */
export function detectLang(code) {
  const s = String(code || '');
  const head = s.trim();
  if (head.length < 8) return '';

  /* JSON 是唯一能「验算」的：解析通过就是 JSON，不看 highlightAuto 脸色 */
  if (head[0] === '{' || head[0] === '[') {
    try { JSON.parse(head); return 'json'; } catch { /* 不是合法 JSON，继续打分 */ }
  }

  let best;
  try {
    best = hljs.highlightAuto(s.length > DETECT_SAMPLE ? s.slice(0, DETECT_SAMPLE) : s, detectSubset());
  } catch {
    return '';
  }
  if (!best || !best.language || best.language === 'plaintext') return '';
  if (best.relevance < DETECT_MIN) return '';
  /* hljs 的 `xml` 同时表示 HTML 和 XML：自动识别时按 HTML 处理，
     用户显式声明 ```xml 或 .xml 文件仍走 xml 分支 */
  const name = best.language === 'xml' ? 'html' : best.language;
  return normalizeLang(name) || '';
}

/** 语言标签（状态栏 / 代码块语言条用）：认不出就给空串 */
export function langLabel(id) {
  const def = LANGS[normalizeLang(id)];
  return def ? def.label : '';
}

/**
 * 按行切开展示的高亮结果（预览里带行号的代码视图用）。
 *
 * 为什么要自己切：hljs 的输出是整段的 HTML，`<span>` 会跨行
 * （多行注释、模板字符串），直接按 `\n` 切字符串会把标签劈成两半。
 * 这里一边扫标签一边记「当前开着哪些 class」，换行处收尾、下一行重开，
 * 于是每一行都是自洽的 HTML，颜色也不会串到下一行去。
 *
 * @param {string} code
 * @param {string} lang
 * @returns {string[]} 每行一个 HTML 片段，行数 === code.split('\n').length
 */
export function highlightLines(code, lang) {
  const text = String(code ?? '');
  const html = highlight(text, lang);
  const lines = [];
  const open = [];          // 当前开着的 class 栈
  let buf = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      const tag = end < 0 ? html.slice(i) : html.slice(i, end + 1);
      i = end < 0 ? html.length : end + 1;
      if (/^<span/i.test(tag)) {
        const m = /class="([^"]*)"/.exec(tag);
        open.push(m ? m[1] : '');
        buf += tag;
      } else if (/^<\/span/i.test(tag)) {
        open.pop();
        buf += tag;
      } else {
        buf += tag;          // 其它标签（正常不会有）原样留着
      }
      continue;
    }
    if (ch === '\n') {
      lines.push(buf + '</span>'.repeat(open.length));
      buf = open.map((c) => `<span class="${c}">`).join('');
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  lines.push(buf);
  return lines;
}

