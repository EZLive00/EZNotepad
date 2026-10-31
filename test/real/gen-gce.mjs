// C3.10 / C3.11 复测（任务列表渲染 + 点复选框）+ E 预览组
// C3.10 上一轮只断言了落盘字节，渲染层其实是个圆点挂着字面 "[ ]"，
// 逐字输入 "- [ ] " 走的是「先转无序项、再升级」这条路，已修，这里真机确认。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gce', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* C3.10 逐字输入任务列表 */
  p.clear();
  p.type('- [ ] 待办'); p.sleep(500);
  p.save();
  p.shot('t-task');
  p.check('C3.10', '- [ ] 待办\n');

  /* C3.11 点复选框勾上 */
  p.click(318, 118);
  p.sleep(600);
  p.shot('t-check');
  p.save();
  p.check('C3.11', '- [x] 待办\n');

  /* 再点一次取消 */
  p.click(318, 118);
  p.sleep(600);
  p.save();
  p.check('C3.11b', '- [ ] 待办\n');

  /* E1/E3 预览：三种块一起看渲染 */
  p.clear();
  p.type('# 标题'); p.key('enter');
  p.type('正文 **粗** 与 `码`'); p.key('enter');
  p.type('- 项一'); p.key('enter');
  p.type('项二'); p.key('enter'); p.key('enter');
  p.type('> 引用'); p.key('enter'); p.key('enter');
  p.type('```js'); p.key('enter');
  p.type('const a = 1;');
  p.sleep(700);
  p.save();
  p.combo('ctrl+3');
  p.sleep(900);
  p.shot('e-preview');
  p.save();

  /* E4 预览里点正文不该进入编辑态：点完直接打字，文字不该进文档 */
  p.click(520, 200);
  p.sleep(300);
  p.type('XXX');
  p.sleep(400);
  p.shot('e-click');
  p.save();
  p.dump('E4');

  /* E2 公式：$$ 块级 + 行内 */
  p.combo('ctrl+1');
  p.sleep(600);
  p.clear();
  p.type('$$'); p.key('enter');
  p.type('\\frac{a}{b} = c^2');
  p.sleep(600);
  p.combo('ctrl+3');
  p.sleep(1000);
  p.shot('e-katex');
  p.combo('ctrl+1');
  p.sleep(500);
  p.dump('E2');
});
