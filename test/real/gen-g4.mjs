// F 查找替换：先探测界面位置与键盘可达行为，再固化断言。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g4', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear();
  p.type('苹果 香蕉 苹果');
  p.sleep(350);
  p.save();
  p.dump('base');

  /* F1 Ctrl+F 只开查找（折叠态） */
  p.combo('ctrl+f');
  p.sleep(500);
  p.shot('f1-collapsed');

  /* F4 输入后跳到下一处 */
  p.type('苹果');
  p.sleep(500);
  p.shot('f2-typed');
  p.key('enter');
  p.sleep(400);
  p.shot('f3-enter');

  /* F9 Ctrl+Enter 在查询框里插换行 */
  p.combo('ctrl+enter');
  p.sleep(350);
  p.shot('f4-newline');

  /* 关掉再开 Ctrl+H，看替换行是否直接展开 */
  p.key('esc');
  p.sleep(300);
  p.combo('ctrl+h');
  p.sleep(500);
  p.type('苹果');
  p.sleep(450);
  p.shot('f5-replace-open');
});
