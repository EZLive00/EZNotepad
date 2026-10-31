// 探针：命令面板（键盘路径）+ 复选框精确坐标 + 设置面板
// 菜单条用坐标点会命中左邻项（点 x=65 开出「文件」），右键菜单同理不可信，
// 后续凡是能用命令面板的都走命令面板。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gk', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* 复选框：318 命中的是左边的「⋮⋮」把手，往右挪 */
  p.clear();
  p.type('- [ ] 待办'); p.sleep(500); p.save();
  p.click(330, 118); p.sleep(500); p.save();
  p.check('K11a', '- [x] 待办\n');
  p.shot('t2-check');
  p.click(336, 118); p.sleep(500); p.save();
  p.check('K11b', '- [ ] 待办\n');

  /* 命令面板 */
  p.combo('ctrl+shift+p');
  p.sleep(900);
  p.shot('k-palette');
  p.type('主题'); p.sleep(800);
  p.shot('k-palette-filter');
  p.key('escape'); p.sleep(400);
  p.shot('k-palette-esc');

  /* 设置面板 */
  p.combo('ctrl+comma');
  p.sleep(900);
  p.shot('k-settings');
  p.key('escape'); p.sleep(400);
  p.shot('k-settings-esc');
});
