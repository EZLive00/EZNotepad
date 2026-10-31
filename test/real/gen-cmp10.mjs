// 清理后的冒烟：① 工具→文件夹对比… 浮层还能正常打开（旧的文本对比页已删）
// ② 工具→文本对比… 仍然弹独立窗口。①关掉再开②，顺带验证浮层关闭不残留。
import { plan, b64, WORK } from './plan.mjs';
plan('cmp10', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(600);
  p.menu('工具', '文件夹对比…');
  p.sleep(900);
  p.shot('cmp-10a');
  p.key('escape');
  p.sleep(500);
  p.menu('工具', '文本对比…');
  p.sleep(3200);
  p.raw('wins');
  p.raw('fullshot D:/tmp/ez-real/cmp-10b.png');
});
