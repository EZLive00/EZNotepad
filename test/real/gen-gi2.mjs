// I1/I2 JSON 一键格式化：正常文件应重排缩进，坏文件应报错且不动文件
import { plan } from './plan.mjs';

const W = 'D:/tmp/ez-real/work/';

plan('gi2', (p) => {
  p.launch(W + 'fmt.json');
  p.sleep(1000);
  p.combo('ctrl+shift+f');
  p.sleep(900);
  p.save();
  p.sleep(400);
  p.dump('I1');
  p.shot('i1-json');

  p.launch(W + 'bad.json');
  p.sleep(1000);
  p.combo('ctrl+shift+f');
  p.sleep(900);
  p.shot('i2-bad');
  p.dump('I2');
});
