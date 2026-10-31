// D1：文件夹选择器。工具→文件夹对比…，左右各选一个目录，选完浮层路径就位。
// 每条断言都来自 DLGPICK 的返回值（对话框真正关闭才算 ok）。
import { plan, b64, WORK } from './plan.mjs';
plan('dlg1', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(600);
  p.menu('工具', '文件夹对比…');
  p.sleep(900);
  p.raw('uiainvoke ' + b64('选择文件夹') + ' 0');          // 左侧
  p.sleep(1400);
  p.raw('dlgpick ' + b64('D:/tmp/ez-real/cmp'));
  p.sleep(1200);
  p.raw('uiainvoke ' + b64('选择文件夹') + ' 1');          // 右侧
  p.sleep(1400);
  p.raw('dlgpick ' + b64('D:/tmp/ez-real'));
  p.sleep(1500);
  p.shot('dlg-1a');
  p.raw('uianames 50');                                    // 快照里应有两条路径
});
