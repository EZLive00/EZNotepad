// D 组重跑（上一轮被草稿恢复弹窗挡住，拍到的都是弹窗后面的旧文档）
// 加 M6：自动保存（停手 1 秒应自己落盘，不按 Ctrl+S）
import { plan } from './plan.mjs';

const W = 'D:/tmp/ez-real/work/';

plan('gd2', (p) => {
  /* D5 JSON */
  p.launch(W + 't.json');
  p.sleep(1000);
  p.shot('d2-json');
  p.combo('ctrl+1'); p.sleep(900);
  p.shot('d2-json-wys');
  p.key('esc'); p.sleep(400);

  /* D6 Python */
  p.launch(W + 't.py');
  p.sleep(1000);
  p.shot('d2-py');

  /* M6 自动保存：不按 Ctrl+S，停手后磁盘应自己变 */
  p.raw('relclick 520 120');
  p.sleep(300);
  p.combo('ctrl+a');
  p.key('delete');
  p.sleep(200);
  p.type('自动保存测试');
  p.sleep(2200);
  p.dump('M6');

  /* D7 shell */
  p.launch(W + 't.sh');
  p.sleep(1000);
  p.shot('d2-sh');
});
