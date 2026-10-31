// 只验一件事：从主窗口菜单打开对比窗口，窗口有没有铺满整个屏幕工作区。
// 同时抓窗口图和整屏图 —— WebView2 的合成层有时 PrintWindow 抓出来是白的，
// 整屏 BitBlt 才是「眼睛实际看到的」，两个一起看才敢下结论。
import { plan, b64, WORK } from './plan.mjs';
plan('cmp9', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(600);
  p.menu('工具', '文本对比…');
  p.sleep(3600);
  p.raw('wins');
  p.sleep(300);
  p.raw('win ' + b64('文本对比'));
  p.sleep(300);
  p.raw('shot D:/tmp/ez-real/cmp-9a.png');
  p.raw('fullshot D:/tmp/ez-real/cmp-9b.png');
});
