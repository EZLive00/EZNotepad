// 对比窗口里直接改字并写回磁盘（打字改一行 + 行首 Backspace 并掉一行）
import fs from 'node:fs';
import { plan, b64 } from './plan.mjs';
const C = 'D:/tmp/ez-real/cmp/';
const L = C + 'L.md';
const R = C + 'R.md';
const E1 = '# 项目说明\n\n第一段，保持不变。\n这一行会被改动：新的文本内容改\n这一行只存在于右边\n末尾保持一致。\n';
const E2 = '# 项目说明\n\n第一段，保持不变。\n这一行会被改动：新的文本内容改这一行只存在于右边\n末尾保持一致。\n';

// 夹具自己重建：上一步会把 R.md 改掉，用例重跑时必须回到同一个起点
fs.mkdirSync(C, { recursive: true });
fs.writeFileSync(L, '# 项目说明\n\n第一段，保持不变。\n这一行会被改动：原始文本\n这一行只存在于左边\n末尾保持一致。\n', 'utf8');
fs.writeFileSync(R, '# 项目说明\n\n第一段，保持不变。\n这一行会被改动：新的文本内容\n这一行只存在于右边\n末尾保持一致。\n', 'utf8');

plan('cmp8', (p) => {
  p.raw('startcmp ' + b64('文本对比') + ' ' + b64(L) + ' ' + b64(R));
  p.sleep(2600);
  p.click(1695, 53);          // 「编辑」
  p.sleep(500);
  p.shot('cmp-8a');
  p.click(1100, 168);         // 右栏第 4 行
  p.sleep(250);
  p.key('end');
  p.type('改');
  p.sleep(800);
  p.save();
  p.sleep(500);
  p.raw('check E1 ' + b64(E1) + ' ' + R);
  p.shot('cmp-8b');
  p.click(1100, 188);         // 右栏第 5 行
  p.sleep(250);
  p.key('home');
  p.key('backspace');
  p.sleep(800);
  p.save();
  p.sleep(500);
  p.raw('check E2 ' + b64(E2) + ' ' + R);
  p.shot('cmp-8c');
});
