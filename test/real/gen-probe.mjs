// 探针：鼠标合成点击到底能不能触发 click？
// 做法：点「文件」菜单，前后各截一张，字节不同 = 菜单开了 = click 生效。
// 顺带重跑 F7（正则）——上一轮期望值写错了：a.c 里的 . 也匹配 d，
// 三处 abc/axc/adc 应全部命中，期望是 "Z Z Z"。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gprobe', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* P1 菜单点击探针 */
  p.shot('p-menu0');
  p.click(35, 21);
  p.sleep(500);
  p.shot('p-menu1');
  p.key('escape');
  p.sleep(400);

  /* P2 正文内点击探针：列表任务复选框（C3.11）*/
  p.clear();
  p.type('- [ ] 待办'); p.sleep(500); p.save();
  p.shot('p-task0');
  p.click(300, 118);
  p.sleep(600);
  p.shot('p-task1');
  p.save();
  p.check('P2', '- [x] 待办\n');

  /* F7 正则重测 */
  p.combo('ctrl+h'); p.sleep(600);
  p.combo('alt+r'); p.sleep(400);
  p.clear(); p.type('abc axc adc'); p.sleep(400); p.save();
  p.type('a.c'); p.sleep(500);
  p.click(730, 129); p.sleep(250);
  p.combo('ctrl+a'); p.type('Z'); p.sleep(350);
  p.combo('alt+a'); p.sleep(1200);
  p.save(); p.sleep(900);
  p.check('F7', 'Z Z Z\n');
  p.combo('alt+r'); p.sleep(300);
  p.combo('ctrl+h'); p.sleep(300);
});
