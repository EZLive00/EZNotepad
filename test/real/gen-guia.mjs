// UIA 探针：先看无障碍树里有什么名字，再试按键名点「编辑」菜单。
// 坐标点击在菜单条上会命中左邻项（点 x=65 开出「文件」），侧栏却准，
// 与其反推偏移，不如直接走无障碍树按键名调用。
import { plan, initFile, b64 } from './plan.mjs';

initFile('init\n');

plan('guia', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.raw('uianames 40');
  p.raw('uia ' + b64('编辑'));
  p.sleep(700);
  p.shot('u-menu');
  p.raw('uia ' + b64('格式'));
  p.sleep(700);
  p.shot('u-menu2');
});
