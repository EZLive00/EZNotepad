// C4.7 分割线 / C4.8 提示块 / C5 行内样式 / C6 表格
// 期望值取「规范形式」：斜体统一序列化为 _x_，表格按列宽补空格 —— 语义等价，
// 属于已知的规范化行为，不算失真。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

const TABLE_EMPTY = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n';
const TABLE_AB = '| 甲 | 乙 |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n';

plan('g3', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.clear(); p.type('---'); p.key('enter'); p.sleep(400); p.shot('c4-7'); p.save();
  p.check('C4.7', '---\n');

  p.clear(); p.type('> [!info] 提示标题'); p.sleep(450); p.shot('c4-8'); p.save();
  p.check('C4.8', '> [!info] 提示标题\n');

  p.clear(); p.type('**粗体**'); p.sleep(350); p.shot('c5-1'); p.save();
  p.check('C5.1', '**粗体**\n');

  p.clear(); p.type('*斜体*'); p.sleep(350); p.shot('c5-3'); p.save();
  p.check('C5.3', '_斜体_\n');

  p.clear(); p.type('`代码`'); p.sleep(350); p.save();
  p.check('C5.4', '`代码`\n');

  p.clear(); p.type('~~删除~~'); p.sleep(350); p.save();
  p.check('C5.5', '~~删除~~\n');

  p.clear(); p.type('[文字](https://a.com)'); p.sleep(400); p.shot('c5-6'); p.save();
  p.check('C5.6', '[文字](https://a.com)\n');

  p.clear(); p.type('$a^2+b^2=c^2$'); p.sleep(400); p.save();
  p.check('C5.8', '$a^2+b^2=c^2$\n');

  p.clear(); p.combo('ctrl+shift+t'); p.sleep(700); p.shot('c6-1'); p.save();
  p.check('C6.1', TABLE_EMPTY);

  p.type('甲'); p.key('tab'); p.type('乙'); p.sleep(400); p.shot('c6-2'); p.save();
  p.check('C6.2', TABLE_AB);
});
