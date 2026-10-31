// G2 探针：文件夹打开后点一行文件，看标签栏有没有跟着变
import { plan, initFile, b64 } from './plan.mjs';

const FOLDER = 'D:\\tmp\\ez-real\\work';
initFile('init\n');

plan('gg2', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);

  p.menu('文件', '打开文件夹');
  p.sleep(2500);
  p.raw('dlgnames 20');
  p.raw('dlgpick ' + b64(FOLDER));
  p.sleep(2000);
  p.raw('uianames 45');

  p.uia('a.md');
  p.sleep(1200);
  p.raw('uianames 45');
  p.shot('g2-open');

  p.uia('子目录');
  p.sleep(900);
  p.raw('uianames 45');
});
