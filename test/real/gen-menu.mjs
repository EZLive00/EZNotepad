// 菜单命中探针：每个 x 点一次，各自截图，看实际打开的是哪个菜单。
// 上一轮点「编辑」(65,21) 打开的是「文件」，需要先搞清菜单条的命中映射，
// 否则后面文件树的右键菜单、工具菜单都没法用坐标驱动。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gmenu', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.shot('k0');
  for (const [i, x] of [[1, 35], [2, 65], [3, 105], [4, 150], [5, 215], [6, 265]]) {
    p.click(x, 21);
    p.sleep(500);
    p.shot('k' + i);
    p.key('escape');
    p.sleep(350);
    p.shot('k' + i + 'c');
  }
});
