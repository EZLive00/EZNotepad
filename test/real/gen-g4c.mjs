// 小实验：替换按钮的点击坐标到底有没有命中
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4c', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear(); p.type('苹果 abc 苹果'); p.sleep(400); p.save();
  p.dump('before');

  p.combo('ctrl+h'); p.sleep(600);
  p.type('苹果'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.type('梨'); p.sleep(350);
  p.dump('typed');

  /* 点「替换」按钮 */
  p.click(827, 129); p.sleep(900);
  p.shot('btn-replace');
  p.dump('after_btn');
  p.save();
  p.dump('after_save');
});
