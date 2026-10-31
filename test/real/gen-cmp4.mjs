// 窗口按钮：无边框窗口没有系统最大化，这一对「最大化 / 还原」是 Rust 侧切两个矩形。
// 按钮坐标按 3 倍放大截图量出来的：铺满时 最大化在屏幕 x=1794，窗口原点 x=-7，
// 所以窗口内坐标 1801；还原成 1294 宽之后同一个按钮落在窗口内 x=1221。
import { plan, b64, TMP } from './plan.mjs';
const C = 'D:/tmp/ez-real/cmp/';
plan('cmp4', (p) => {
  p.raw('startcmp ' + b64('文本对比') + ' ' + b64(C + 'L.md') + ' ' + b64(C + 'R.md'));
  p.sleep(2600);
  p.raw('wins');                 // 打开时应当已是工作区尺寸
  p.shot('cmp-4a');
  p.click(1801, 18);             // 最大化按钮 -> 还原成居中常规尺寸
  p.sleep(1200);
  p.raw('wins');
  p.shot('cmp-4b');
  p.click(1221, 18);             // 再点一次 -> 回到铺满
  p.sleep(1200);
  p.raw('wins');
  p.raw('fullshot ' + TMP + '/cmp-full4.png');
});
