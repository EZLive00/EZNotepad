// ============================================================
// test/run-units.mjs —— 纯逻辑单测（不开浏览器，几毫秒跑完）
//
//   node test/run-units.mjs
//
// 只放「输入数据、输出数据」的东西：不需要 DOM、不需要 Tauri 的模块。
// 浏览器相关的行为归 run.mjs（md 引擎）、run-editor.mjs（编辑区）、
// run-menu.mjs（菜单）。
// ============================================================
import fs from 'node:fs';
import { freeUntitledName, moveById } from '../src/js/taborder.js';
import { slugify, headingSlugs, inline, renderMarkdown } from '../src/js/markdown.js';
import { extractOutline } from '../src/js/preview.js';
import { diffLines, buildSideBySide, diffStats } from '../src/js/diff.js';
import { blockItems, arrange, rangeText } from '../src/js/difflist.js';
import { sortLines, sortKey, isSorted } from '../src/js/linesort.js';
import { detectLang } from '../src/js/highlight.js';
import { normalizeLang, langForFile, newDocTypes } from '../src/js/langs.js';

const out = [];
const eq = (name, got, want) => out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, v) => out.push({ name, ok: !!v, got: v, want: true });

/* ---------- 未命名自动编号 ---------- */
eq('第一个未命名', freeUntitledName([], 'md'), '未命名.md');
eq('第二个加序号', freeUntitledName(['未命名.md'], 'md'), '未命名 2.md');
eq('第三个接着排', freeUntitledName(['未命名.md', '未命名 2.md'], 'md'), '未命名 3.md');
eq('中间空出来的先补上', freeUntitledName(['未命名.md', '未命名 3.md'], 'md'), '未命名 2.md');
eq('不挡别的扩展名', freeUntitledName(['未命名.md'], 'txt'), '未命名.txt');
eq('已保存的文件不参与编号', freeUntitledName(['笔记.md'], 'md'), '未命名.md');

/* ---------- 标签拖拽排序 ---------- */
const ids = (l) => l.map((t) => t.id);
const L = [{ id: 1 }, { id: 2 }, { id: 3 }];
eq('拖到最前面', ids(moveById(L, 3, 1, false)), [3, 1, 2]);
// 1 拖到 2 的左半边 = 本来就该在的位置，顺序不变（不是 bug，是落点恰好是原位）
eq('落在自己的原位', ids(moveById(L, 1, 2, false)), [1, 2, 3]);
eq('落在右侧才换位', ids(moveById(L, 1, 2, true)), [2, 1, 3]);
eq('向前插一格', ids(moveById(L, 3, 2, false)), [1, 3, 2]);
eq('拖到最后一个之后', ids(moveById(L, 1, 3, true)), [2, 3, 1]);
eq('原地不动', ids(moveById(L, 2, 2, false)), [1, 2, 3]);
eq('拖到不存在的目标 → 落到末尾', ids(moveById(L, 1, 99, false)), [2, 3, 1]);
eq('源不存在 → 原样返回', moveById(L, 99, 1, false), L);
eq('不改原数组', (moveById(L, 3, 1, false), ids(L)), [1, 2, 3]);

/* ---------- 标题锚点（目录靠它跳转，改规则等于让旧目录里的链接失效） ---------- */
eq('中文标题原样保留', slugify('快速开始'), '快速开始');
eq('空格变连字符', slugify('Quick Start'), 'quick-start');
eq('去掉标点', slugify('Hello, World!'), 'hello-world');
eq('去掉强调标记', slugify('**加粗**的标题'), '加粗的标题');
eq('链接只取文字', slugify('[文档](https://a.com)'), '文档');
eq('同名标题依次编号', headingSlugs(['说明', '说明', '说明']), ['说明', '说明-1', '说明-2']);
eq('全是符号时兜底', slugify('***'), 'section');

/* ---------- 公式保护：_ 和 * 是下标与乘号，不是斜体 ---------- */
ok('公式里的下划线不当斜体', !inline('$x_1 * y$').includes('<em>'));
ok('公式原样留给 KaTeX', inline('$x_1$').includes('$x_1$'));
ok('公式里的 < 转成实体，DOM 文本仍是原文', inline('$a<b$').includes('$a&lt;b$'));
ok('块级公式两端保留', inline('$$\\frac{a}{b}$$').includes('$$\\frac{a}{b}$$'));

/* ---------- ==高亮==：中文紧贴也认，行内代码里的不算 ---------- */
eq('==文字== 变成 mark', inline('==重点=='), '<mark>重点</mark>');
eq('紧贴中文也认', inline('记住==重点==就好'), '记住<mark>重点</mark>就好');
eq('行内代码里的 == 原样', inline('`a == b`'), '<code>a == b</code>');
eq('没成对的不动', inline('a == b'), 'a == b');

/* ---------- 整篇渲染：标题 id 用 slug、块级公式跨越成 div ---------- */
const html = renderMarkdown('# 快速开始\n\n行内 $x_1$ 结束\n\n$$\na + b\n$$\n');
ok('标题用 slug 当 id', html.includes('id="快速开始"'));
ok('块级公式独占一行渲染', html.includes('<div class="math-block">$$a + b$$</div>'));
ok('行内公式原样留着', html.includes('$x_1$'));
const dupHtml = renderMarkdown('## 说明\n\n## 说明\n');
ok('重复标题各自有 id', dupHtml.includes('id="说明"') && dupHtml.includes('id="说明-1"'));

/* ---------- 提示块（callout）：> [!info] 的预览渲染 ---------- */
const co = renderMarkdown('> [!warning] 注意事项\n> 正文一行\n');
ok('提示块带类型 class', /md-callout md-callout-warning/.test(co));
ok('提示块标题行渲染自定义标题', co.includes('注意事项'));
ok('提示块图标走精灵图', co.includes('#i-triangle-alert'));
ok('提示块正文照常渲染', co.includes('正文一行'));
ok('标记本身不进正文', !co.includes('[!warning]'));
ok('无标题用默认中文标签', renderMarkdown('> [!danger]').includes('危险'));
ok('无正文不产生空标签', !/<p>\s*<\/p>/.test(renderMarkdown('> [!info]')));
ok('GitHub 别名归一（NOTE → info）', /md-callout md-callout-info/.test(renderMarkdown('> [!NOTE] 一点说明')));
ok('别名显示成功标签（tip → success）', renderMarkdown('> [!tip]').includes('成功'));
ok('未知标记保持普通引用', !/md-callout/.test(renderMarkdown('> [!foo] 未知')));
ok('普通引用不受影响', !/md-callout/.test(renderMarkdown('> 普通引用')));
ok('标记行必须顶格在引用内', !/md-callout/.test(renderMarkdown('正文里的 [!info] 标记')));

/* ---------- 大纲提取：纯文本不能把每一行都当标题 ----------
   老实现把 `1.` `2.` `3.` 逐行收进来、且全是同一级，于是随手一份清单的效果是
   「每行都是大纲」；`====` 这类分隔线自己还会变成一条空标题。 */
const ol = (kind, md) => extractOutline(kind, md).map((x) => `${x.level}:${x.text}`);
eq('散文不产生大纲', ol('txt', '今天开会。\n讨论了三个问题。\n明天再议。'), []);
eq('连续编号是列表，不是章节', ol('txt', '1. 买菜\n2. 做饭\n3. 洗碗'), []);
eq('空行分隔的编号算章节', ol('txt', '1. 引言\n\n正文\n\n2. 方法'), ['1:1. 引言', '1:2. 方法']);
eq('多级编号按深度展开', ol('txt', '1. 总论\n1.1 背景\n1.1.1 细节\n2. 方法'), ['1:1. 总论', '2:1.1 背景', '3:1.1.1 细节', '1:2. 方法']);
eq('分隔线取上一行当标题', ol('txt', '第一章\n=====\n正文\n\n第二章\n-----'), ['1:第一章', '1:第二章']);
eq('分隔线自身不当标题', ol('txt', '=====\n-----\n正文'), []);
eq('【】标题保留原文', ol('txt', '【一】概述\n内容'), ['1:【一】概述']);
eq('中文章节三级', ol('txt', '第一章 总论\n第一节 背景\n第一条 目的'), ['1:第一章 总论', '2:第一节 背景', '3:第一条 目的']);
eq('把 txt 当 Markdown 写也认', ol('txt', '# 一\n## 一点一'), ['1:一', '2:一点一']);
eq('csv 不提取大纲', ol('data', 'name,age\nTom,3'), []);
eq('跨级编号压平到不跳级', extractOutline('txt', '1.1.1 深').map((x) => x.level), [1]);

/* ---------- 行级差异：大文件不许退化成「假相同」 ----------
   旧实现在 n*m > 4M 时走一条「无公共行」的捷径，把不匹配的行标成 same 且 b=-1：
   两个 2000 行的文件一比较，右栏整页空白、所有新增堆到文末。下面几条盯住它。 */
const bigA = Array.from({ length: 2100 }, (_, i) => `第 ${i} 行的正文内容`);
const bigB = bigA.slice();
for (const i of [10, 210, 777, 1200, 1999]) bigB[i] = `第 ${i} 行改过的正文内容`;
bigB.splice(1500, 0, '插入的第一行', '插入的第二行');
const rowsBig = buildSideBySide(bigA, bigB, { ignoreWS: true }).rows;
const stBig = diffStats(rowsBig);
ok('大文件：没有空文本行（旧实现的 b=-1）', rowsBig.every((r) => r.l && r.r ? r.l.text !== undefined && r.r.text !== undefined : true));
ok('大文件：行号都落在文件范围内', rowsBig.every((r) => (!r.l || (r.l.no >= 1 && r.l.no <= bigA.length))
  && (!r.r || (r.r.no >= 1 && r.r.no <= bigB.length))));
eq('大文件：五处修改成对成行', stBig.chg, 5);
eq('大文件：两行插入各自成行', stBig.add, 2);
eq('大文件：没有多余删除', stBig.del, 0);

/* 大文件 + 纯空白：默认忽略，关掉开关才报 */
const wsA = Array.from({ length: 2050 }, (_, i) => `行 ${i}`);
const wsB = wsA.map((s, i) => ([7, 800, 1600].includes(i) ? '   ' + s : s));
eq('大文件：忽略空白时缩进变化不算差异', diffStats(buildSideBySide(wsA, wsB, { ignoreWS: true }).rows).chg, 0);
eq('大文件：关掉忽略空白后缩进变化报三处', diffStats(buildSideBySide(wsA, wsB, { ignoreWS: false }).rows).chg, 3);

/* 完全无关的两份大文件：宁可整段替换，也不许冒出「相同」 */
const unA = Array.from({ length: 2100 }, (_, i) => `甲 ${i} ${(i * 13) % 997}`);
const unB = Array.from({ length: 2100 }, (_, i) => `乙 ${i} ${(i * 17) % 991}`);
const stUn = diffStats(buildSideBySide(unA, unB, { ignoreWS: true }).rows);
eq('大文件：完全无关时不产生相同行', stUn.same, 0);
eq('大文件：完全无关时整段替换', stUn.chg, 2100);

/* 小文件保持原样：仍然是 del 后接 add */
eq('小文件：修改拆成删除加新增', diffLines(['a', 'b', 'c'], ['a', 'x', 'c']).map((o) => o.type), ['same', 'del', 'add', 'same']);

/* ---------- 差异清单：折行、排序、筛选 ---------- */
/* 三段刻意隔开：b→B 是修改、e f 是纯删除、末尾 x y z 是纯新增 */
const listA = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const listB = ['a', 'B', 'c', 'd', 'g', 'h', 'x', 'y', 'z'];
const built = buildSideBySide(listA, listB, { ignoreWS: true });
const items = blockItems(built.rows, built.blocks);

eq('清单：差异块数量与 blocks 一致', items.length, built.blocks.length);
eq('清单：三块分别是修改 / 仅左 / 仅右', items.map((i) => i.kind), ['chg', 'del', 'add']);
eq('清单：第一处两侧都有行号', [items[0].lFrom, items[0].rFrom], [2, 2]);
eq('清单：整块删除的行号区间', [items[1].lFrom, items[1].lTo], [5, 6]);
eq('清单：整块新增的行号区间', [items[2].rFrom, items[2].rTo], [7, 9]);
ok('清单：块尾不会吞掉后面的相同行', built.rows[items[1].end + 1].kind === 'same');
eq('清单：行数统计含两侧', [items[0].lines, items[1].lines, items[2].lines], [2, 2, 3]);

/* 排序：位置可升可降；类型优先、同类型内按位置升序；行数只作主键 */
eq('排序：位置升序', arrange(items, { sort: 'pos', dir: 1 }).map((i) => i.index), [0, 1, 2]);
eq('排序：位置降序', arrange(items, { sort: 'pos', dir: -1 }).map((i) => i.index), [2, 1, 0]);
eq('排序：类型升序（修改→仅左→仅右）', arrange(items, { sort: 'kind', dir: 1 }).map((i) => i.kind), ['chg', 'del', 'add']);
eq('排序：类型降序', arrange(items, { sort: 'kind', dir: -1 }).map((i) => i.kind), ['add', 'del', 'chg']);
eq('排序：按行数降序，同尺寸仍按位置', arrange(items, { sort: 'size', dir: -1 }).map((i) => i.index), [2, 0, 1]);
eq('筛选：只看仅右', arrange(items, { filter: 'add' }).map((i) => i.kind), ['add']);
eq('筛选：只看仅左', arrange(items, { filter: 'del' }).map((i) => i.kind), ['del']);
ok('排序不改原数组', items.map((i) => i.index).join(',') === '0,1,2');

eq('行号区间：单行', rangeText(5, 5), '5');
eq('行号区间：多行', rangeText(5, 9), '5–9');
eq('行号区间：缺失', rangeText(0, 0), '');

/* 空对比不炸 */
eq('清单：空对比得到空清单', blockItems([], []), []);

/* ---------- 按字典序排序 ---------- */
eq('排序：中文按拼音', sortLines(['张三', '李四', '王五', '赵六']), ['李四', '王五', '张三', '赵六']);
eq('排序：带编号的按数值', sortLines(['a10', 'a9', 'a1']), ['a1', 'a9', 'a10']);
eq('排序：空行沉到末尾', sortLines(['b', '', 'a', '', 'c']), ['a', 'b', 'c', '', '']);
eq('排序：全是空行就原样', sortLines(['', '  ']), ['', '  ']);
eq('排序：同键保持原顺序', sortLines(['b1', 'a', 'b2', 'a']), ['a', 'a', 'b1', 'b2']);
eq('排序：是置换，行数不变', sortLines(['c', 'a', 'b']).length, 3);
eq('排序：不改原数组', (() => { const x = ['b', 'a']; sortLines(x); return x; })(), ['b', 'a']);
eq('排序：默认忽略行首空白', sortLines([' b', 'a']), ['a', ' b']);
eq('排序：关掉忽略空白按原始字符', sortLines([' b', 'a'], { ignoreWS: false }), [' b', 'a']);
eq('排序：空数组不炸', sortLines([]), []);
eq('排序键：去首尾空白', sortKey('  Ab '), 'Ab');
eq('排序键：去空白并转小写', sortKey('  Ab ', { ignoreCase: true }), 'ab');
ok('已经是字典序时 isSorted 为真', isSorted(['a', 'b', 'c']));
ok('乱序时 isSorted 为假', !isSorted(['b', 'a']));

/* ---------- 代码块语言自动识别 ----------
   没标语言的代码块（``` 后面空着）靠它决定怎么上色，底层是 highlight.js 的
   highlightAuto。判据两条：**真代码要认出来**、**不够长就老实不认**
   —— 短片段按关键字打分本来就不可靠，涂错颜色比不上色难查得多。 */
eq('识别：JSON', detectLang('{"a": 1, "b": [2, 3]}'), 'json');
eq('识别：python', detectLang('import os\nimport json\nfrom typing import Any\n\ndef load(path: str) -> dict[str, Any]:\n    if not os.path.exists(path):\n        raise FileNotFoundError(path)\n    with open(path, encoding="utf-8") as f:\n        data = json.load(f)\n    return data\n'), 'py');
eq('识别：js', detectLang('import fs from "node:fs";\n\nconst cache = new Map();\n\nexport function read(key) {\n  if (cache.has(key)) {\n    return cache.get(key);\n  }\n  const value = fs.readFileSync(key, "utf8");\n  cache.set(key, value);\n  return value;\n}\n'), 'js');
eq('识别：go', detectLang('package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tf, err := os.Open("a.txt")\n\tif err != nil {\n\t\tfmt.Println(err)\n\t\treturn\n\t}\n\tdefer f.Close()\n\tfmt.Println(f.Name())\n}\n'), 'go');
eq('识别：rust', detectLang('use std::collections::HashMap;\n\npub fn count(m: &HashMap<String, u32>) -> u32 {\n    let mut n = 0;\n    for v in m.values() {\n        n += v;\n    }\n    n\n}\n'), 'rs');
eq('识别：html', detectLang('<!doctype html>\n<html>\n  <body>\n    <div class="a">hi</div>\n    <p>text</p>\n  </body>\n</html>'), 'html');
eq('识别：shell 脚本', detectLang('set -e\nfor f in *.txt; do\n  echo "processing $f"\n  grep -v "^#" "$f" >> out.txt\ndone\necho done'), 'sh');
eq('识别：cpp 不会被 c 抢走', detectLang('#include <iostream>\n#include <vector>\n\nint main() {\n    std::vector<int> v{1, 2, 3};\n    for (auto x : v) std::cout << x;\n    return 0;\n}'), 'cpp');
eq('识别：短片段宁可不认（打分不可靠）', detectLang('interface Foo {\n  a: string;\n}'), '');
eq('识别：散文保持原样', detectLang('这是一段普通的中文说明，没有任何代码。'), '');
eq('识别：空白串不猜', detectLang('   \n  '), '');
eq('识别：坏的 JSON 不硬认成 json', detectLang('{ 这不是 json'), '');

/* ---------- 语言注册表是唯一真源 ---------- */
eq('语言表：jsonl 有名字', normalizeLang('jsonl'), 'jsonl');
eq('语言表：按扩展名认', langForFile('a.kt'), 'kt');
eq('语言表：无扩展名按整名认', langForFile('Dockerfile'), 'docker');
eq('语言表：认不出返回空', langForFile('a.zzz'), '');
ok('语言表：新建类型够多', newDocTypes().length >= 24);

/* ---------- boot 顺序：外面推进来的文件，监听必须比恢复流程先挂 ----------
   恢复草稿是个模态框（「是否恢复」），用户不点，boot 就停在 await 上。
   `open-files` 要是注册在这之后，这段时间从第二个实例 / 工具窗推进来的路径
   就被丢掉，界面表现成「点了没反应」—— 而且只在真攒着未保存内容的那次出现，
   手工测根本碰不到。这条守的就是那个顺序，改回去就红。 */
{
  const APP = fs.readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
  const at = (needle) => {
    const i = APP.indexOf(needle);
    return i < 0 ? Infinity : i;
  };
  const iListen = at("listen('open-files'");
  const iRestore = at('await restoreDrafts()');
  ok('open-files 的监听注册在恢复草稿之前', iListen < iRestore, { iListen, iRestore });
  ok('启动期收到的文件先排队，不直接开',
    at('earlyOpen.push') < iRestore && APP.includes('for (const p of earlyOpen) openPath(p)'));
}

/* ---------- 汇总 ---------- */
const fail = out.filter((r) => !r.ok);
out.forEach((r) => {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
});
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
