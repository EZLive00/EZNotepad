// C3 列表 / C4 引用与代码块
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g2', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* ---- C3.1 无序列表 ---- */
  p.clear(); p.type('- '); p.sleep(220); p.type('项目一'); p.sleep(300); p.save();
  p.check('C3.1', '- 项目一\n');

  /* C3.2 回车自动续项 */
  p.key('enter'); p.type('项目二'); p.sleep(300); p.save();
  p.check('C3.2', '- 项目一\n- 项目二\n');

  /* C3.3 空列表项上回车退出列表（第一次回车建空项，第二次才退出） */
  p.key('enter'); p.sleep(220); p.key('enter'); p.sleep(320); p.type('正文'); p.sleep(300); p.save();
  p.check('C3.3', '- 项目一\n- 项目二\n\n正文\n');

  /* C3.4 Tab 缩进成子项 */
  p.clear(); p.type('- '); p.sleep(200); p.type('父项'); p.key('enter'); p.type('子项');
  p.sleep(250); p.key('tab'); p.sleep(300); p.shot('c3-4'); p.save();
  p.check('C3.4', '- 父项\n  - 子项\n');

  /* C3.5 Shift+Tab 退回一级 */
  p.combo('shift+tab'); p.save();
  p.check('C3.5', '- 父项\n- 子项\n');

  /* C3.6 列表项行首退格降级为正文 */
  p.clear(); p.type('- '); p.sleep(200); p.type('项目'); p.sleep(250);
  p.key('home'); p.key('backspace'); p.sleep(300); p.save();
  p.check('C3.6', '项目\n');

  /* C3.8 有序列表自动编号 */
  p.clear(); p.type('1. '); p.sleep(220); p.type('一'); p.key('enter'); p.type('二');
  p.key('enter'); p.type('三'); p.sleep(300); p.shot('c3-8'); p.save();
  p.check('C3.8', '1. 一\n2. 二\n3. 三\n');

  /* C3.9 第二项末尾回车插入，后续序号重排 */
  p.key('up'); p.key('end'); p.key('enter'); p.type('新'); p.sleep(350); p.save();
  p.check('C3.9', '1. 一\n2. 二\n3. 新\n4. 三\n');

  /* C3.10 任务列表 */
  p.clear(); p.type('- [ ] '); p.sleep(300); p.type('待办'); p.sleep(300); p.shot('c3-10'); p.save();
  p.check('C3.10', '- [ ] 待办\n');

  /* ---- C4.1 引用 ---- */
  p.clear(); p.type('> '); p.sleep(250); p.type('引用内容'); p.sleep(300); p.save();
  p.check('C4.1', '> 引用内容\n');

  /* C4.2 引用行回车继续引用 */
  p.key('enter'); p.type('第二行'); p.sleep(300); p.save();
  p.check('C4.2a', '> 引用内容\n> 第二行\n');

  /* C4.2b 空引用行回车退出 */
  p.key('enter'); p.key('enter'); p.sleep(300); p.type('正文'); p.sleep(300); p.save();
  p.check('C4.2b', '> 引用内容\n> 第二行\n\n正文\n');

  /* C4.4 代码块（``` 一输入就变成块，不需要再回车） */
  p.clear(); p.type('```'); p.sleep(400); p.type('code'); p.sleep(300);
  p.shot('c4-4'); p.save();
  p.check('C4.4', '```\ncode\n```\n');

  /* C4.5 代码块内回车不跳出 */
  p.key('enter'); p.type('code2'); p.sleep(300); p.save();
  p.check('C4.5', '```\ncode\ncode2\n```\n');
});
