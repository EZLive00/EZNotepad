// F10 替换：全部替换 / 替换当前
import { plan, initFile } from './plan.mjs';

const BASE = '苹果 香蕉 苹果\n';

initFile('init\n');

plan('g4b', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* 全部替换 */
  p.clear(); p.type('苹果 香蕉 苹果'); p.sleep(400); p.save();
  p.check('F0', BASE);

  p.combo('ctrl+h'); p.sleep(600);
  p.type('苹果'); p.sleep(450);
  p.click(730, 129); p.sleep(250);         // 替换为 输入框
  p.type('梨'); p.sleep(300);
  p.shot('f10-before');
  p.key('tab'); p.sleep(200);              // 焦点：替换 → 全部
  p.key('tab'); p.sleep(200);
  p.key('enter'); p.sleep(1000);
  p.shot('f10-after');
  p.save();
  p.check('F10a', '梨 香蕉 梨\n');

  /* 替换当前（只换第一处） */
  p.clear(); p.type('苹果 香蕉 苹果'); p.sleep(400); p.save();
  p.combo('ctrl+h'); p.sleep(600);
  p.type('苹果'); p.sleep(450);
  p.click(730, 129); p.sleep(250);
  p.type('梨'); p.sleep(300);
  p.key('enter'); p.sleep(1000);           // 替换框里回车 = 替换当前
  p.shot('f10b-one');
  p.save();
  p.check('F10b', '梨 香蕉 苹果\n');

  /* F6 区分大小写开关：切 Aa 后查大写应无命中 */
  p.clear(); p.type('abc ABC'); p.sleep(400); p.save();
  p.combo('ctrl+f'); p.sleep(500);
  p.type('abc'); p.sleep(500);
  p.shot('f6-caseoff');
  p.click(830, 98); p.sleep(600);          // Aa
  p.shot('f6-caseon');
});
