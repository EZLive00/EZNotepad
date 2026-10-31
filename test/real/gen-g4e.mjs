// 用 Tab 走焦点，确认按钮是否可被键盘激活（绕开鼠标坐标问题）
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4e', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear(); p.type('甲 甲 甲'); p.sleep(400); p.save();

  p.combo('ctrl+h'); p.sleep(600);
  p.type('甲'); p.sleep(450);
  p.click(730, 129); p.sleep(250);      // 替换框
  p.type('乙'); p.sleep(350);

  p.click(827, 129); p.sleep(900); p.shot('mouse-btn'); p.dump('mouse');

  p.key('tab'); p.sleep(300);
  p.key('tab'); p.sleep(300); p.shot('focused');
  p.key('enter'); p.sleep(900); p.shot('enter-btn'); p.dump('enter');
});
