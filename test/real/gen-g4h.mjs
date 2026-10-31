// F 查找替换正式断言：全部只用键盘路径（鼠标合成在本环境不产生 click）
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4h', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* F10a 全部替换：Alt+A */
  p.clear(); p.type('苹果 abc 苹果'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('苹果'); p.sleep(450);
  p.click(730, 129); p.sleep(250);        // 替换框
  p.combo('ctrl+a'); p.type('梨'); p.sleep(350);
  p.combo('alt+a'); p.sleep(1000);
  p.shot('r-all');
  p.save();
  p.check('F10a', '梨 abc 梨\n');

  /* F10b 替换当前：替换框回车，只换第一处 */
  p.clear(); p.type('苹果 abc 苹果'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('苹果'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('梨'); p.sleep(350);
  p.key('enter'); p.sleep(1000);
  p.shot('r-one');
  p.save();
  p.check('F10b', '梨 abc 苹果\n');

  /* F6a 默认不区分大小写：两处都换 */
  p.clear(); p.type('abc ABC'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('abc'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('X'); p.sleep(350);
  p.combo('alt+a'); p.sleep(900); p.save();
  p.check('F6a', 'X X\n');

  /* F6b 打开 Aa（Alt+C）：只换小写那处 */
  p.combo('alt+c'); p.sleep(500);
  p.clear(); p.type('abc ABC'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('abc'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('Y'); p.sleep(350);
  p.combo('alt+a'); p.sleep(900);
  p.shot('r-case');
  p.save();
  p.check('F6b', 'Y ABC\n');
  p.combo('alt+c'); p.sleep(400);          // 关回去

  /* F7 正则（Alt+R）：a.c 命中 abc / axc */
  p.combo('alt+r'); p.sleep(400);
  p.clear(); p.type('abc axc adc'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('a.c'); p.sleep(500);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('Z'); p.sleep(350);
  p.combo('alt+a'); p.sleep(900);
  p.shot('r-regex');
  p.save();
  p.check('F7', 'Z Z adc\n');
  p.combo('alt+r'); p.sleep(400);          // 关正则

  /* F8 整词（Alt+W）：abc 不该命中 abcd */
  p.combo('alt+w'); p.sleep(400);
  p.clear(); p.type('abc abcd'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('abc'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('W'); p.sleep(350);
  p.combo('alt+a'); p.sleep(900);
  p.shot('r-word');
  p.save();
  p.check('F8', 'W abcd\n');
});
