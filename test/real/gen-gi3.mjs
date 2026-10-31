// I1 定位：快捷键与菜单分别试一次，判断是「键没到」还是「命令没跑」
import { plan } from './plan.mjs';
const W = 'D:/tmp/ez-real/work/';
plan('gi3', (p) => {
  p.launch(W + 'fmt.json');
  p.sleep(1000);
  p.raw('relclick 520 120');
  p.sleep(400);
  p.combo('ctrl+shift+f');
  p.sleep(900);
  p.shot('i3-key');
  p.save(); p.sleep(400);
  p.dump('I1key');

  p.menu('工具', '一键格式化');
  p.sleep(900);
  p.shot('i3-menu');
  p.save(); p.sleep(400);
  p.dump('I1menu');
});
