// ============================================================
// test/run-i18n.mjs —— 多语言回归（不开浏览器，几十毫秒）
//
//   node test/run-i18n.mjs
//
// 查四件事：
//   1. 词条表结构：每行 8 列、不缺不缺、都不为空
//   2. 覆盖率：源码里 tt('…') 与 data-i18n* 用到的键，表里全都有
//   3. 取词行为：9 种语言逐个走一遍占位符替换、缺键回退
//   4. 边界：detectLang 认地区码、setLang 拒绝未知码、后端错误码全链路
// 词条表的产物是脚本生成的（build-i18n-dict.py），所以这里只验结果不重算。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, DICT, tt, setLang, getLang, resolveLang } from '../src/js/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const eq = (name, got, want) => out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, v) => out.push({ name, ok: !!v, got: v, want: true });

/* ---------- 1. 表结构 ---------- */
const COLS = 8;
const badLen = Object.entries(DICT).filter(([, row]) => !Array.isArray(row) || row.length !== COLS);
eq('每行都是 8 列', badLen.slice(0, 5).map(([k]) => k), []);
const empty = Object.entries(DICT).filter(([, row]) => row.some((x) => !x || !String(x).trim()));
eq('没有空译文', empty.slice(0, 5).map(([k]) => k), []);
ok('词条数量够用', Object.keys(DICT).length > 500);

/* key 里不该混进 HTML 外壳 —— 那是 2026-11-02 包装脚本翻过的车。
   行内标记（<b> / <br> / <code>）是对话正文的一部分，允许；
   结构标签（<div> / <td> / <button>）出现就说明整段 DOM 被包进了词条 */
const shellKeys = Object.keys(DICT).filter((k) => /<(div|td|tr|table|button|input|label)[\s>]/i.test(k));
eq('词条里没有 DOM 外壳', shellKeys.slice(0, 5), []);

/* ---------- 2. 覆盖率：源码用到的键必须都在表里 ---------- */
const files = [
  ...fs.readdirSync(path.join(ROOT, 'src/js')).filter((f) => f.endsWith('.js') && !f.startsWith('i18n'))
    .map((f) => path.join('src/js', f)),
  'src/index.html',
  'src/compare.html',
];
/* 源码里的 '\n' 是转义序列，实际键里是换行符，比对前要先还原 */
const unescape = (s) => s.replace(/\\(n|t|r)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r' }[c]))
  .replace(/\\(['"\\])/g, '$1');

const used = new Map();
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of text.matchAll(/\btt\(\s*(['"])((?:[^'"\\]|\\.)*)\1/g)) {
    used.set(unescape(m[2]), rel);
  }
  /* data-i18n="${l}" 这种是模板里拼出来的（设置面板的分段按钮），跳过 */
  for (const m of text.matchAll(/data-i18n(?:-title|-ph|-aria)?="([^"]*)"/g)) {
    if (!m[1].includes('${')) used.set(m[1], rel);
  }
}
const missing = [...used.keys()].filter((k) => !DICT[k]).map((k) => `${k}  <- ${used.get(k)}`);
eq('源码里的键全都收进表了', missing.slice(0, 8), []);
ok('扫到足够多的键（防止扫描本身失效）', used.size > 400);

/* ---------- 3. 取词行为 ---------- */
setLang('zh-CN');
eq('简体就是键本身', tt('保存'), '保存');
eq('占位符替换', tt('主题：{name}', { name: '深色' }), '主题：深色');
eq('缺变量时保留原样', tt('主题：{name}'), '主题：{name}');
eq('表里没有的键原样返回', tt('这条没收录'), '这条没收录');

const seen = new Set();
for (const { code } of LANGS) {
  setLang(code);
  eq(`[${code}] getLang 生效`, getLang(), code);
  const s = tt('保存');
  ok(`[${code}] 「保存」有译文且非空`, s && s.trim());
  seen.add(s);
}
ok('九种语言不是同一个词（至少三种写法）', seen.size >= 3);
setLang('en');
eq('英文占位符', tt('行 {line}，列 {col}', { line: 3, col: 7 }), 'Ln 3, Col 7');

/* 未知语言码不该让界面变成空白 */
eq('未知码退回简体', setLang('xx-YY'), 'zh-CN');

/* ---------- 4. 边界 ---------- */
eq('resolveLang: auto 时不炸', typeof resolveLang('auto'), 'string');
eq('resolveLang: 明确指定就照办', resolveLang('de'), 'de');
eq('resolveLang: 非法值走检测', typeof resolveLang('klingon'), 'string');
ok('getLang 与 setLang 一致', (setLang('ja'), getLang() === 'ja'));

/* 后端错误现在只回 { code, vars, detail }（见 src-tauri/src/error.rs），
   文案由 errors.js 按界面语言拼，这里按语言各验一条完整链路 */
{
  const { localizeError, errText, ERR_TEXT } = await import('../src/js/errors.js');

  eq('ERR_TEXT 的每个模板都必须在词条表里',
    Object.keys(ERR_TEXT).filter((c) => !DICT[ERR_TEXT[c]]), []);

  setLang('zh-CN');
  const zh = localizeError({ code: 'io.read', detail: '拒绝访问。' });
  eq('zh-CN: 带 detail 的错误', zh.message, '无法读取文件：拒绝访问。');

  setLang('de');
  const de = localizeError({ code: 'entry.exists', vars: { name: 'a.md' } });
  eq('de: 带模板参数的错误', de.message, DICT['「{name}」已经存在'][5].replace('{name}', 'a.md'));
  eq('de: 翻过的错误带回错误码', de.code, 'entry.exists');

  /* 二次翻译防线：localizeError 出来的 Error 一定带 message → isBackend 为假 → 原样返回 */
  const again = localizeError(zh);
  eq('不二次翻译', again, zh);

  eq('errText: 后端对象只回一句话', errText({ code: 'file.too_large' }), DICT['文件过大'][5]);
  eq('errText: 普通 Error 原样取 message', errText(new Error('前端自己的错')), '前端自己的错');
  eq('errText: 字符串原样', errText('裸字符串'), '裸字符串');
  setLang('zh-CN');

  /* 没收录的码要露出去（宁可看到码，不要静默吞） */
  eq('未知错误码露出码本身', errText({ code: 'io.foo', detail: 'boom' }), '[io.foo] boom');

  /* 后端回的码必须前后端对得上：Rust 源里的 code 字符串都要能查到模板 */
  const rs = (await import('node:fs')).readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const rsCodes = [...new Set([...rs.matchAll(/AppError::\w+\(\s*"([a-z_.]+)"/g)].map((m) => m[1]))];
  eq('Rust 侧每个错误码前端都有模板', rsCodes.filter((c) => !ERR_TEXT[c]), []);
}

/* ---------- 汇总 ---------- */
const fail = out.filter((r) => !r.ok);
out.forEach((r) => {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
});
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
