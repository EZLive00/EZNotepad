// 探针：查找条上的按钮到底能不能点（箭头 / 关闭）
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4f', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear(); p.type('甲 甲 甲'); p.sleep(400); p.save();

  p.combo('ctrl+f'); p.sleep(600);
  p.shot('p0-collapsed');

  p.click(640, 98); p.sleep(700); p.shot('p1-arrow');
  p.click(632, 98); p.sleep(500); p.shot('p2-arrow2');

  p.click(1038, 131); p.sleep(700); p.shot('p3-close');
  p.click(1038, 98); p.sleep(500); p.shot('p4-close2');
});
