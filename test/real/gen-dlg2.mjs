// D2：另存为选择器。全新启动（不与文件夹对比共用会话，避免浮层残留干扰），
// 不碰编辑内容 —— 被测对象是「保存对话框能把指定路径送回应用并落盘」。
// 输出文件名带时间戳：本机 safe-delete 钩子拦 Remove-Item，删旧文件走不通，
// 唯一文件名让「上一轮的陈旧字节造成假 PASS」在结构上不可能发生。
import { plan, b64, WORK } from './plan.mjs';
const OUT = `D:/tmp/ez-real/dlg-out-${Date.now()}.md`;
plan('dlg2', (p) => {
  p.launch(WORK + '/w.md');
  p.sleep(600);
  p.combo('ctrl+shift+s');
  p.sleep(1500);
  p.raw('dlgpick ' + b64(OUT));
  p.sleep(1500);
  p.raw('check saveas ' + b64('init草稿内容甲\n') + ' ' + OUT);
  p.raw('dump dumpsave ' + OUT);
});
