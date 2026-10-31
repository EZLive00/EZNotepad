// 综合探针：鼠标点击是否有效（最大化按钮）+ Alt+A / Alt+C 是否生效
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4g', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* 探针 1：最大化按钮（若点击有效，窗口会变大，截图明显不同） */
  p.click(1154, 17); p.sleep(800); p.shot('d-max');
  p.click(1154, 17); p.sleep(800); p.shot('d-restore');

  /* 探针 2：Alt+A 全部替换 */
  p.clear(); p.type('甲 甲 甲'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('甲'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.sleep(150);
  p.type('乙'); p.sleep(400);
  p.dump('t1');
  p.combo('alt+a'); p.sleep(1000);
  p.shot('d-alta');
  p.dump('alt_a');

  /* 探针 3：Alt+C 切大小写 */
  p.combo('alt+c'); p.sleep(500);
  p.shot('d-altc');
});
