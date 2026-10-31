// 探针：菜单为什么点不动。启动 -> 截图 -> 点菜单 -> 再截图 + 全名清单
import { plan, b64, WORK } from './plan.mjs';
plan('dlg0', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(800);
  p.shot('dlg-0a');                     // 启动后的真实画面
  p.raw('uianames 25');                 // 此时 UIA 能看到什么
  p.menu('工具', '文件夹对比…');
  p.sleep(900);
  p.shot('dlg-0b');                     // 点完菜单后的画面
  p.raw('uianames 25');
});
