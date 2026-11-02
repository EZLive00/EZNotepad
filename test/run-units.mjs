// ============================================================
// test/run-units.mjs —— 纯逻辑单测（不开浏览器，几毫秒跑完）
//
//   node test/run-units.mjs
//
// 只放「输入数据、输出数据」的东西：不需要 DOM、不需要 Tauri 的模块。
// 浏览器相关的行为归 run.mjs（md 引擎）、run-editor.mjs（编辑区）、
// run-menu.mjs（菜单）。
// ============================================================
import { freeUntitledName, moveById } from '../src/js/taborder.js';
import { slugify, headingSlugs, inline, renderMarkdown } from '../src/js/markdown.js';
import { extractOutline } from '../src/js/preview.js';

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

/* ---------- 汇总 ---------- */
const fail = out.filter((r) => !r.ok);
out.forEach((r) => {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
});
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
