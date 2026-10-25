// 样式截图：node test/shot-ui.mjs   →  .workbuddy/../shot-ui-{light,dark}.png
// 只用于看视觉效果，不参与断言。（.workbuddy 不可写，落到 node_modules/.tmp）
import { runPage, shot } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('node_modules/.tmp');
fs.mkdirSync(OUT, { recursive: true });

for (const theme of ['light', 'dark']) {
  const { ev, send, close } = await runPage({
    page: '/test/ui-preview.html',
    theme,
    port: theme === 'light' ? 8811 : 8812,
    cdpPort: theme === 'light' ? 9451 : 9452,
    width: 1180,
    height: 760,
  });
  await ev('new Promise(r => setTimeout(r, 350))');
  const file = path.join(OUT, `ui-${theme}.png`);
  await shot(send, file);
  console.log(theme, '->', file);

  // 单栏（只看编辑区）：检查宽窗口下正文是否居中收窄
  await ev(`document.querySelector('#previewPane').classList.add('hidden')`);
  await ev('new Promise(r => setTimeout(r, 200))');
  const file2 = path.join(OUT, `ui-${theme}-single.png`);
  await shot(send, file2);
  console.log(theme, 'single ->', file2);
  close();
}
