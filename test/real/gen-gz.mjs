// 收尾组：代码块语言、撤销重做、导出网页、历史版本、文本对比
import { plan, initFile, b64 } from './plan.mjs';

const OUT = 'D:\\tmp\\ez-real\\out\\export.html';

initFile('init\n');

plan('gz', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* C4.4 代码块：```js + 回车，语言名不该丢 */
  p.clear();
  p.type('```js');
  p.key('enter');
  p.sleep(500);
  p.type('const a = 1;');
  p.sleep(400);
  p.save();
  p.check('C4.4', '```js\nconst a = 1;\n```\n');
  p.shot('z-code');

  /* C7.1 / C7.2 撤销与重做 */
  p.clear();
  p.type('abc');
  p.sleep(300);
  p.save();
  p.check('C7a', 'abc\n');
  p.type('d');
  p.sleep(300);
  p.combo('ctrl+z');
  p.sleep(400);
  p.save();
  p.check('C7b', 'abc\n');
  p.combo('ctrl+y');
  p.sleep(400);
  p.save();
  p.check('C7c', 'abcd\n');

  /* L1/L2 历史版本 */
  p.menu('文件', '历史版本');
  p.sleep(1500);
  p.shot('z-history');
  p.raw('uianames 45');
  p.key('esc');
  p.sleep(500);

  /* L4 导出网页 */
  p.menu('文件', '导出网页');
  p.sleep(1800);
  p.raw('dlgnames 25');
  p.raw('dlgpick ' + b64(OUT));
  p.sleep(2000);
  p.raw('dump L4 D:/tmp/ez-real/out/export.html');

  /* L5 文本对比 */
  p.combo('ctrl+d');
  p.sleep(1600);
  p.shot('z-compare');
  p.key('esc');
  p.sleep(400);
});
