// 坐标扫描：找出「替换 / 全部」按钮的真实命中位置
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4d', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear(); p.type('甲 甲 甲'); p.sleep(400); p.save();
  p.dump('base');

  p.combo('ctrl+h'); p.sleep(600);
  p.type('甲'); p.sleep(450);
  p.click(730, 129); p.sleep(250);      // 替换框
  p.type('乙'); p.sleep(350);
  p.dump('t1');

  p.click(827, 129); p.sleep(700); p.dump('x827'); p.shot('scan-827');
  p.click(850, 129); p.sleep(700); p.dump('x850'); p.shot('scan-850');
  p.click(870, 129); p.sleep(700); p.dump('x870'); p.shot('scan-870');
  p.click(890, 129); p.sleep(700); p.dump('x890'); p.shot('scan-890');
});
