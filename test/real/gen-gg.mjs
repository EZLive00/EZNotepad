// G 侧栏文件树：打开文件夹 → 目录树 → 点文件 → 右键菜单 → 搜索
// 文件夹选择器是独立原生窗口，键盘输入不一定落在路径框里，
// 这里改用对话框自己的无障碍树填值并点确认。
import { plan, initFile, b64 } from './plan.mjs';

const FOLDER = 'D:\\tmp\\ez-real\\work';

initFile('init\n');

plan('gg', (p) => {
  p.launch();
  p.combo('ctrl+1');
  p.sleep(900);
  p.raw('relclick 520 320');
  p.sleep(300);

  /* G1 打开文件夹 */
  p.menu('文件', '打开文件夹');
  p.sleep(1800);
  p.raw('dlgshot D:/tmp/ez-real/g-dialog.png');
  p.raw('dlgnames 25');
  p.raw('dlgpick ' + b64(FOLDER));
  p.sleep(1600);
  p.shot('g-tree');
  p.raw('uianames 80');

  /* G2 点文件打开 */
  p.uia('a.md');
  p.sleep(1000);
  p.shot('g-open');

  /* 展开子目录 → 点里面那个文件 */
  p.uia('子目录');
  p.sleep(800);
  p.shot('g-expand');

  /* G3 右键菜单（只看不改） */
  p.raw('uirclick ' + b64('b.md'));
  p.sleep(900);
  p.shot('g-ctx');
  p.key('esc');
  p.sleep(500);

  /* G8 搜索：先点搜索框 */
  p.uia('在这个文件夹里搜内容');
  p.sleep(500);
  p.type('init');
  p.sleep(1600);
  p.shot('g-search');
});
