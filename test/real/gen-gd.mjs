// D 编辑模式 + E2 公式预览
// 不同文件类型必须分别启动（命令行只接受文件参数），所以这里是三次 launch。
import { plan } from './plan.mjs';

const W = 'D:/tmp/ez-real/work/';

plan('gd', (p) => {
  /* --- E2 公式：预览里的 KaTeX --- */
  p.launch(W + 'math.md');
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);
  p.shot('d-md');
  p.combo('ctrl+3');
  p.sleep(1200);
  p.shot('e2-katex');
  p.combo('ctrl+1');
  p.sleep(600);

  /* --- D5 JSON：语法着色 + 所见即所得不可用 --- */
  p.launch(W + 't.json');
  p.sleep(900);
  p.shot('d-json');
  p.combo('ctrl+1'); p.sleep(900);      // 想切所见即所得，JSON 应被拒绝
  p.shot('d-json-wys');
  p.combo('ctrl+2'); p.sleep(500);

  /* --- D3/D4 括号自动补全与跳过 --- */
  p.launch(W + 't.py');
  p.sleep(900);
  p.raw('relclick 520 120');
  p.sleep(300);
  p.combo('ctrl+a');
  p.key('delete');
  p.sleep(200);
  p.type('f');
  p.type('(');
  p.sleep(300);
  p.dump('D3');                          // 期望 "f()"
  p.type('a');
  p.type(')');
  p.sleep(300);
  p.save();
  p.dump('D4');                          // 期望 "f(a)"，不是 "f(a))"

  /* --- D2 Tab 缩进 --- */
  p.combo('ctrl+a'); p.key('delete'); p.sleep(200);
  p.type('x'); p.key('enter'); p.type('y');
  p.sleep(300);
  p.key('tab');
  p.sleep(300);
  p.save();
  p.dump('D2');

  /* --- D1 行号与着色截图 --- */
  p.shot('d-py');

  /* --- D6/D7 其它语言着色 --- */
  p.launch(W + 't.sh');
  p.sleep(1000);
  p.shot('d-sh');
});
