// C1 段落与换行 / C2 标题
import { plan, initFile } from './plan.mjs';

initFile('init\n');

plan('g1', (p) => {
  p.launch();
  p.combo('ctrl+1');            // 切到所见即所得
  p.sleep(800);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* ---- C1 段落与换行 ---- */
  p.clear(); p.type('第一段'); p.sleep(350); p.shot('c1-1'); p.save();
  p.check('C1.1', '第一段\n');

  p.key('enter'); p.type('第二段'); p.sleep(350); p.save();
  p.check('C1.2', '第一段\n\n第二段\n');

  p.key('enter'); p.sleep(250); p.save();
  p.check('C1.3', '第一段\n\n第二段\n');

  p.clear(); p.type('甲'); p.key('enter'); p.type('乙'); p.sleep(300);
  p.key('left'); p.key('backspace'); p.save();
  p.check('C1.4', '甲乙\n');

  p.clear(); p.type('甲'); p.key('enter'); p.type('乙'); p.sleep(300);
  p.key('up'); p.key('delete'); p.save();
  p.check('C1.5', '甲乙\n');

  /* ---- C2 标题 ---- */
  p.clear(); p.type('# '); p.sleep(250); p.type('标题一'); p.sleep(350);
  p.shot('c2-1'); p.save();
  p.check('C2.1', '# 标题一\n');

  p.clear(); p.type('标题二'); p.key('home'); p.type('## '); p.sleep(350); p.save();
  p.check('C2.2', '## 标题二\n');

  p.clear(); p.type('# '); p.sleep(220); p.type('标题一'); p.sleep(320);
  p.key('home'); p.key('backspace'); p.sleep(320); p.shot('c2-3'); p.save();
  p.check('C2.3', '# 标题一\n');

  p.key('backspace'); p.sleep(320); p.save();
  p.check('C2.4', '标题一\n');

  p.clear(); p.type('# '); p.sleep(220); p.type('标题'); p.key('enter'); p.type('正文');
  p.sleep(320); p.save();
  p.check('C2.5', '# 标题\n\n正文\n');

  p.clear(); p.type('正文块'); p.sleep(280);
  p.combo('ctrl+alt+2'); p.save();
  p.check('C2.6a', '## 正文块\n');
  p.combo('ctrl+alt+2'); p.save();
  p.check('C2.6b', '正文块\n');

  p.clear(); p.type('#话题'); p.sleep(320); p.save();
  p.check('C2.7', '#话题\n');
});
