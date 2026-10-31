// 诊断：把 maximize 的结果写进窗口标题，用 wins 读回来
import { plan, b64 } from './plan.mjs';
const C = 'D:/tmp/ez-real/cmp/';
plan('cmp6', (p) => {
  p.raw('startcmp ' + b64('文本对比') + ' ' + b64(C + 'L.md') + ' ' + b64(C + 'R.md'));
  p.sleep(2600);
  p.raw('wins');
  p.shot('cmp-6a');
});
