// 判断 ctrl+shift+F 是被谁吃掉的：同一条分发的其它 shift 组合先试一遍
import { plan } from './plan.mjs';
const W = 'D:/tmp/ez-real/work/';
plan('gi4', (p) => {
  p.launch(W + 'fmt.json');
  p.sleep(1000);
  p.raw('relclick 520 120');
  p.sleep(400);
  p.combo('ctrl+shift+l');     // 单栏 -> 双栏
  p.sleep(700);
  p.shot('i4-layout');
  p.combo('ctrl+shift+l');     // 切回来
  p.sleep(600);
  p.combo('ctrl+shift+o');     // 大纲开关
  p.sleep(700);
  p.shot('i4-outline');
  p.combo('ctrl+shift+o');
  p.sleep(500);
  p.combo('ctrl+shift+f');     // 再来一次格式化
  p.sleep(900);
  p.dump('I4f');
});
