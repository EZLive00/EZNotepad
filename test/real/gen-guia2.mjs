// 菜单展开后的可访问名清单：把「项 + 快捷键」的真实拼接方式摸清楚，
// 后面所有菜单项都用 uia 精确点名调用，不再算坐标。
import { plan, initFile, b64 } from './plan.mjs';

initFile('init\n');

plan('guia2', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.raw('uia ' + b64('文件'));
  p.sleep(600);
  p.raw('uianames 60');
  p.raw('uia ' + b64('文件'));
  p.sleep(400);

  p.raw('uia ' + b64('视图'));
  p.sleep(600);
  p.raw('uianames 60');
  p.raw('uia ' + b64('视图'));
  p.sleep(400);

  p.raw('uia ' + b64('工具'));
  p.sleep(600);
  p.raw('uianames 60');
});
