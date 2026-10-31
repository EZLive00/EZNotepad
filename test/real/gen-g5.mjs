// H 大纲 / J 视图与设置 / K 命令面板 —— 以截图判定为主
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g5', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* 造一篇有标题的文档，用来看大纲 */
  p.clear();
  p.type('# 章节一\n正文内容\n## 小节一\n细节\n# 章节二\n结尾');
  p.sleep(700);
  p.save();
  p.shot('h1-outline');

  /* J1 双栏 */
  p.combo('ctrl+shift+l');
  p.sleep(700);
  p.shot('j1-split');
  p.combo('ctrl+shift+l');
  p.sleep(600);

  /* J2 专注模式 */
  p.key('f9');
  p.sleep(700);
  p.shot('j2-zen');
  p.key('esc');
  p.sleep(700);
  p.shot('j2-back');

  /* J4 字号放大 */
  p.combo('ctrl+=');
  p.combo('ctrl+=');
  p.sleep(500);
  p.shot('j4-zoom');
  p.combo('ctrl+0');
  p.sleep(400);

  /* K1 命令面板 */
  p.combo('ctrl+shift+p');
  p.sleep(600);
  p.shot('k1-palette');
  p.type('深色');
  p.sleep(500);
  p.shot('k2-filter');
  p.key('enter');
  p.sleep(900);
  p.shot('k3-dark');

  /* J6 设置面板 */
  p.combo('ctrl+,');
  p.sleep(700);
  p.shot('j6-settings');
});
