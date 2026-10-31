// 对比窗口：先探一次窗口尺寸与首屏样子，坐标定了再写交互用例
import { plan, b64, TMP } from './plan.mjs';

const C = 'D:/tmp/ez-real/cmp/';
const TITLE = '文本对比';

plan('cmp1', (p) => {
  p.raw('startcmp ' + b64(TITLE) + ' ' + b64(C + 'L.md') + ' ' + b64(C + 'R.md'));
  p.sleep(2200);
  p.raw('wins');
  p.shot('cmp-1');
  p.raw('fullshot ' + TMP + '/cmp-full.png');
  p.sleep(300);
});
