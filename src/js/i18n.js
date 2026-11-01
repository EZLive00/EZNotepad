// ============================================================
// i18n.js —— 界面多语言
//
// 词条表的键就是**简体中文原文**（gettext 那套做法）：源码里写 t('保存')，
// 而不是 t('menu.save')。好处是改文案时不用同步两份、也不会出现
// 「键叫 save 但值写着删除」的漂移；代价是原文改动时要在词条表里跟着改，
// test/run-i18n.mjs 会把「源码用了但表里没有」的键全部揪出来。
//
// 取译文的函数叫 tt 而不是惯用的 t：app.js 里 t 是「当前标签」这个局部变量，
// 出现在几百处（t.path / closeTab(t.id)），用 t 会被局部变量遮住，而且
// t('关闭') 这种写法会被读成「把标签对象当函数调用」。
//
// 每种语言在表里存 8 个译文，顺序固定，简体中文即键本身，不占位：
//   [繁體, English, 日本語, 한국어, Français, Deutsch, Español, Português]
// ============================================================

/** 支持的语言。name 用各自的语言自称 —— 语言菜单不做二次翻译 */
export const LANGS = [
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
];

/** 语言码 → 译文在词条数组里的下标；简体中文是键本身，所以是 -1 */
const COL = { 'zh-CN': -1, 'zh-TW': 0, en: 1, ja: 2, ko: 3, fr: 4, de: 5, es: 6, pt: 7 };

const FALLBACK = 'en';

/* 词条表单独一个文件，纯数据、几百行，放在这里会把逻辑淹掉 */
import { DICT } from './i18n-dict.js';
export { DICT };

let lang = 'zh-CN';

/** 把系统语言（navigator.languages，依次尝试）归一到我们支持的语言 */
export function detectLang() {
  // node 里跑测试没有 navigator，直接给回退值，别让 import 就炸
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const list = (nav && Array.isArray(nav.languages) && nav.languages.length)
    ? nav.languages
    : [nav ? nav.language : ''];
  for (const raw of list) {
    const s = String(raw || '').toLowerCase();
    if (!s) continue;
    // 繁体：地区码优先（TW/HK/MO），其次看显式写了 Hant
    if (s.startsWith('zh')) return /-(tw|hk|mo)\b|hant/.test(s) ? 'zh-TW' : 'zh-CN';
    for (const code of ['ja', 'ko', 'fr', 'de', 'es', 'pt', 'en']) {
      if (s === code || s.startsWith(code + '-')) return code;
    }
  }
  return FALLBACK;
}

/** settings.lang 是 'auto' 时跟随系统，否则就是明确选定的语言码 */
export function resolveLang(pref) {
  if (!pref || pref === 'auto') return detectLang();
  return COL[pref] === undefined ? detectLang() : pref;
}

export const getLang = () => lang;

export function setLang(code) {
  lang = COL[code] === undefined ? 'zh-CN' : code;
  // html lang 影响断行规则（中文/日文不按空格断）、字体回退和屏幕阅读器
  // node 里跑测试没有 document，跳过这一步（其余逻辑纯数据）
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}

/**
 * 取译文。第二参数填占位符：tt('保存到 {path}', { path })
 * 缺译时退回英文，再缺就退回中文原文 —— 永远不会显示成空白或键名。
 */
export function tt(text, vars) {
  const row = DICT[text];
  let out = text;
  if (row) {
    const col = COL[lang];
    if (col >= 0) out = row[col] || row[COL[FALLBACK]] || text;
  }
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
  }
  return out;
}

/* 中文/日文用全角冒号，西文要「冒号 + 空格」 */
const FULLWIDTH_COLON = new Set(['zh-CN', 'zh-TW', 'ja']);

/**
 * 后端（Rust）回来的错误文案在这里过一道。
 * 后端不认识界面语言，只会给中文；但它的消息只有两种形状：
 *   ① 整条固定文案（"文件过大"）      → 直接查表
 *   ② 「前缀：系统细节」（"保存失败：拒绝访问"）→ 只翻前缀
 * 细节那半是 Windows 自己给的错误文本，本来就跟随系统语言，翻它反而会错。
 */
export function ttBackend(msg) {
  if (!msg) return msg;
  const s = String(msg);
  if (DICT[s]) return tt(s);
  const i = s.search(/[：:]/);
  if (i > 0) {
    const head = s.slice(0, i);
    if (DICT[head]) {
      const tail = s.slice(i + 1).replace(/^[\s：:]+/, '');
      return tt(head) + (FULLWIDTH_COLON.has(lang) ? '：' : ': ') + tail;
    }
  }
  return s;
}

/** 给静态 HTML 用：data-i18n / data-i18n-title / data-i18n-ph / data-i18n-aria */export function applyDom(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = tt(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = tt(n.dataset.i18nTitle);
  for (const n of root.querySelectorAll('[data-i18n-ph]')) n.placeholder = tt(n.dataset.i18nPh);
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', tt(n.dataset.i18nAria));
}
