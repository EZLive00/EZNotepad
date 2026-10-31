// 预览条点击定位 + F7/F8 逐处跳转。
// 预览条贴在窗口最右边，宽 16px，所以用 relbr（距右下角）定位，横竖都不会点空。
import { plan, b64, TMP } from './plan.mjs';

const C = 'D:/tmp/ez-real/cmp/';
const TITLE = '文本对比';

plan('cmp3', (p) => {
  p.raw('startcmp ' + b64(TITLE) + ' ' + b64(C + 'big-l.txt') + ' ' + b64(C + 'big-r.txt'));
  p.sleep(2400);
  p.shot('cmp-3a');
  // 点预览条下半部分：应当跳到文档后段
  p.raw('relbr 23 500');
  p.sleep(900);
  p.shot('cmp-3b');
  // 键盘跳下一处 / 上一处
  p.raw('key f8'); p.sleep(700);
  p.raw('key f8'); p.sleep(700);
  p.shot('cmp-3c');
  p.raw('key f7'); p.sleep(700);
  p.shot('cmp-3d');
  p.raw('fullshot ' + TMP + '/cmp-full3.png');
});
