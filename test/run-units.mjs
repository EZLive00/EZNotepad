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

const out = [];
const eq = (name, got, want) => out.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

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

/* ---------- 汇总 ---------- */
const fail = out.filter((r) => !r.ok);
out.forEach((r) => {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
});
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
