// ============================================================
// test/run-i18n.mjs —— 多语言回归（不开浏览器，几十毫秒）
//
//   node test/run-i18n.mjs
//
// 查四件事：
//   1. 词条表结构：每行 8 列、不缺不缺、都不为空
//   2. 覆盖率：源码里 tt('…') 与 data-i18n* 用到的键，表里全都有
//   3. 取词行为：9 种语言逐个走一遍占位符替换、缺键回退
//   4. 边界：detectLang 认地区码、setLang 拒绝未知码、ttBackend 拆前缀
// 词条表的产物是脚本生成的（build-i18n-dict.py），所以这里只验结果不重算。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, DICT, tt, setLang, getLang, resolveLang, ttBackend } from '../src/js/i18n.js';

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

setLang('de');
eq('ttBackend 整条命中', ttBackend('文件过大'), DICT['文件过大'][5]);
eq('ttBackend 拆前缀（西文冒号带空格）', ttBackend('保存失败：拒绝访问'), DICT['保存失败'][5] + ': 拒绝访问');
setLang('zh-CN');
eq('ttBackend 拆前缀（中文全角冒号）', ttBackend('保存失败：拒绝访问'), '保存失败：拒绝访问');
eq('ttBackend 不认识的原文不动', ttBackend('某个没收录的错误'), '某个没收录的错误');
eq('ttBackend 空值安全', ttBackend(''), '');

/* ---------- 汇总 ---------- */
const fail = out.filter((r) => !r.ok);
out.forEach((r) => {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
});
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
