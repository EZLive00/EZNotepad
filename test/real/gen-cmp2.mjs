// 对比窗口第二轮：确认最大化 + 长文件下的预览条
import { plan, b64, TMP } from './plan.mjs';

const C = 'D:/tmp/ez-real/cmp/';
const TITLE = '文本对比';

plan('cmp2', (p) => {
  p.raw('startcmp ' + b64(TITLE) + ' ' + b64(C + 'big-l.txt') + ' ' + b64(C + 'big-r.txt'));
  p.sleep(2400);
  p.shot('cmp-2');
  p.raw('fullshot ' + TMP + '/cmp-full2.png');
  p.sleep(200);
});
