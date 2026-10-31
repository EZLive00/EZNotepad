// I2 坏 JSON 的报错弹窗（走菜单，避开首键丢失）
// M1/M2 草稿恢复：不保存直接换进程，新实例应提示恢复
import { plan, b64 } from './plan.mjs';

const W = 'D:/tmp/ez-real/work/';
plan('gm2', (p) => {
  p.launch(W + 'bad.json');
  p.sleep(1000);
  p.menu('工具', '一键格式化');
  p.sleep(900);
  p.shot('m2-badjson');
  p.key('esc');
  p.sleep(400);

  /* M1：打点内容不保存 */
  p.launch(W + 'w.md');
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);
  p.type('草稿内容甲');
  p.sleep(2500);
  p.shot('m1-dirty');

  /* M2：换进程，草稿应提示恢复 */
  p.launch(W + 'w.md');
  p.sleep(1800);
  p.shot('m2-draft');
  p.raw('uianames 40');
  p.uia('恢复');
  p.sleep(1200);
  p.shot('m2-restored');
  p.dump('M2');
});
