// 主窗口入口（工具→文本对比…）+ 深色主题下的对比窗口
import { plan, b64, WORK } from './plan.mjs';
plan('cmp7', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(600);
  p.menu('视图', '主题：深色');
  p.sleep(800);
  p.menu('工具', '文本对比…');
  p.sleep(3200);
  p.raw('win ' + b64('文本对比'));
  p.sleep(600);
  p.shot('cmp-7a');
  p.raw('wins');
});
