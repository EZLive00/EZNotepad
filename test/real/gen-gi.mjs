// I 工具组：排序 / 去重 / 空行 / 空白 / 大小写 / 字数 / 换行符 / 编码
// 全部在编辑模式（CodeMirror）里做，工具处理的是原始 markdown 文本行。
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('gi', (p) => {
  const clear = () => {
    p.raw('relclick 520 320'); p.sleep(200);
    p.combo('ctrl+a'); p.key('delete'); p.sleep(200);
  };

  p.launch();
  p.combo('ctrl+2');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* I4 排序 */
  clear();
  p.type('b'); p.key('enter'); p.type('a'); p.key('enter'); p.type('c');
  p.sleep(400); p.save();
  p.check('I4a', 'b\na\nc');
  p.menu('工具', '按行升序排序');
  p.save();
  p.check('I4b', 'a\nb\nc');
  p.menu('工具', '按行降序排序');
  p.save();
  p.check('I4c', 'c\nb\na');

  /* I4d 数字排序：10 不该排在 9 前面 */
  clear();
  p.type('10'); p.key('enter'); p.type('9'); p.key('enter'); p.type('2');
  p.sleep(400); p.save();
  p.menu('工具', '按数字排序');
  p.save();
  p.check('I4d', '2\n9\n10');

  /* I5 去重 / 删空行 / 去首尾空白 */
  clear();
  p.type('a'); p.key('enter'); p.type('a'); p.key('enter'); p.type('b');
  p.sleep(400); p.save();
  p.menu('工具', '去除重复行');
  p.save();
  p.check('I5a', 'a\nb');

  clear();
  p.type('a'); p.key('enter'); p.key('enter'); p.key('enter'); p.type('b');
  p.sleep(400); p.save();
  p.menu('工具', '删除空行');
  p.save();
  p.check('I5b', 'a\nb');

  clear();
  p.type('  a  '); p.key('enter'); p.type('   b');
  p.sleep(400); p.save();
  p.menu('工具', '去除首尾空白');
  p.save();
  p.check('I5c', 'a\nb');

  /* I6 大小写 */
  clear();
  p.type('abC');
  p.sleep(300); p.save();
  p.menu('工具', '转大写');
  p.save();
  p.check('I6a', 'ABC');

  clear();
  p.type('ABc');
  p.sleep(300); p.save();
  p.menu('工具', '转小写');
  p.save();
  p.check('I6b', 'abc');

  clear();
  p.type('hello world');
  p.sleep(300); p.save();
  p.menu('工具', '首字母大写');
  p.save();
  p.dump('I6c');

  /* I7 字数统计 */
  clear();
  p.type('中文两个词'); p.sleep(300); p.save();
  p.menu('工具', '字数统计');
  p.shot('i-wordcount');
  p.key('esc');
  p.sleep(300);

  /* I8 换行符：换成 CRLF 后落盘应是 \r\n */
  clear();
  p.type('x'); p.key('enter'); p.type('y');
  p.sleep(300); p.save();
  p.dump('I8-lf');
  p.menu('工具', '切换换行符');
  p.save();
  p.dump('I8-crlf');
  p.shot('i-eol');

  /* I8b 编码对话框 */
  p.menu('工具', '文件编码');
  p.shot('i-encoding');
  p.key('esc');
  p.sleep(300);
});
