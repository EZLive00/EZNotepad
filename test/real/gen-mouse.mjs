// 鼠标探针 v2：逐点点不同目标，每个点完立刻截图，用图片字节判断有没有反应。
// 目标：侧栏「文件」页签（大按钮）、「编辑」菜单、工具栏「保存」图标。
// 上一轮点「文件」菜单前后截图完全一致，需要分清是「点击没到」还是「菜单不开」。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gm', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.shot('m0');
  /* M1 侧栏换页签：大纲 → 文件 */
  p.click(72, 92);
  p.sleep(600);
  p.shot('m1');

  /* M2 点「编辑」菜单 */
  p.click(65, 21);
  p.sleep(600);
  p.shot('m2');
  p.key('escape');
  p.sleep(300);

  /* M3 点工具栏「保存」图标 */
  p.click(1015, 57);
  p.sleep(700);
  p.shot('m3');

  /* M4 再点「文件」菜单（这时窗口肯定已激活、也点过一次菜单了）*/
  p.click(35, 21);
  p.sleep(600);
  p.shot('m4');
  p.key('escape');
  p.sleep(300);
  p.shot('m5');
});
