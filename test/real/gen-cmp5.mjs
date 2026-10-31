// 对比窗口第五轮：最大化 + 预览条点击定位 + F7/F8
import { plan, b64, TMP } from './plan.mjs';
const C = 'D:/tmp/ez-real/cmp/';
plan('cmp5', (p) => {
  p.raw('startcmp ' + b64('文本对比') + ' ' + b64(C + 'big-l.txt') + ' ' + b64(C + 'big-r.txt'));
  p.sleep(2800);
  p.shot('cmp-5a');
  p.raw('relbr 12 200');   // 预览条靠下一点
  p.sleep(900);
  p.shot('cmp-5b');
  p.raw('key f8'); p.sleep(700);
  p.raw('key f8'); p.sleep(700);
  p.shot('cmp-5c');
  p.raw('key f7'); p.sleep(700);
  p.shot('cmp-5d');
  p.raw('fullshot ' + TMP + '/cmp-full5.png');
});
