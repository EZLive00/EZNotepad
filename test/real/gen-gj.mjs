// J 视图与设置 + K 命令面板补齐
// 菜单项一律走无障碍树（p.menu），坐标点击在菜单条上会命中左邻项。
import { plan, initFile, b64 } from './plan.mjs';

initFile('# 一\n\n正文\n\n## 二\n\n更多正文\n');

plan('gj', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);
  p.shot('j0');

  /* J1 双栏 / 单栏 */
  p.menu('视图', '双栏');
  p.shot('j-split');
  p.menu('视图', '单栏');
  p.shot('j-single');

  /* J2 专注模式 F9，Esc 退出 */
  p.combo('F9');
  p.sleep(800);
  p.shot('j-zen');
  p.key('esc');
  p.sleep(700);
  p.shot('j-zen-off');

  /* J3 全屏 F11 */
  p.combo('F11');
  p.sleep(900);
  p.shot('j-full');
  p.combo('F11');
  p.sleep(700);
  p.shot('j-unfull');

  /* J4 字号 */
  p.combo('ctrl+plus'); p.sleep(400);
  p.combo('ctrl+plus'); p.sleep(400);
  p.shot('j-zoom');
  p.combo('ctrl+0'); p.sleep(500);
  p.shot('j-zoom-reset');

  /* J5 主题 */
  p.menu('视图', '主题：深色');
  p.shot('j-dark');
  p.menu('视图', '主题：浅色');
  p.shot('j-light');

  /* J7 标题栏显示文件名 */
  p.menu('视图', '标题栏显示文件名');
  p.shot('j-notitle');
  p.menu('视图', '标题栏显示文件名');
  p.shot('j-title-back');

  /* H4 大纲显示开关 */
  p.menu('视图', '显示侧栏');
  p.shot('j-outline-off');
  p.menu('视图', '显示侧栏');
  p.shot('j-outline-on');

  /* J6 设置面板 */
  p.combo('ctrl+comma');
  p.sleep(900);
  p.shot('j-settings');
  p.key('esc');
  p.sleep(600);
  p.shot('j-settings-off');

  /* K1~K3 命令面板 */
  p.combo('ctrl+shift+p');
  p.sleep(800);
  p.shot('k-pal');
  p.type('保存'); p.sleep(700);
  p.shot('k-pal-filter');
  p.key('enter');
  p.sleep(700);
  p.shot('k-pal-run');
});
