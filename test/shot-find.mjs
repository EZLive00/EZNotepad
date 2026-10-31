// 查找条截图：node test/shot-find.mjs  →  SHOT_DIR/find-{light,dark}-{collapsed,expanded}.png
// 只用于看视觉效果，不参与断言。骨架来自 ui-preview.html（不含 app.js），
// 所以这里的展开 / 勾选状态是脚本手动摆的，和 setFindExpanded 保持一致。
import { runPage, shot, SHOT_DIR } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = SHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });

const SETUP = `
  const bar = document.querySelector('#findbar');
  bar.classList.remove('hidden');
  document.querySelector('#findInput').value = '第一章';
  document.querySelector('#replaceInput').value = '第二章';
  document.querySelector('#findCount').textContent = '3/12';
  document.querySelector('#findCase').checked = true;
  document.querySelector('#findRegex').checked = true;
  document.querySelector('#findScope').disabled = true;
`;

for (const theme of ['light', 'dark']) {
  const { ev, send, close } = await runPage({
    page: '/test/ui-preview.html',
    theme,
    port: theme === 'light' ? 8821 : 8822,
    cdpPort: theme === 'light' ? 9461 : 9462,
    width: 1180,
    height: 420,
  });
  await ev('new Promise(r => setTimeout(r, 350))');
  await ev(SETUP);
  // 2 倍像素密度：查找条本身才 30px 高，1 倍看不清开关的激活态
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1180, height: 420, deviceScaleFactor: 2, mobile: false,
  });

  // 折叠：只有查找
  const a = path.join(OUT, `find-${theme}-collapsed.png`);
  await shot(send, a);
  console.log(theme, 'collapsed ->', a);

  // 展开：多一行替换
  await ev(`document.querySelector('#findbar').classList.add('expanded');
            document.querySelector('#findReplaceRow').classList.remove('hidden')`);
  await ev('new Promise(r => setTimeout(r, 120))');
  const b = path.join(OUT, `find-${theme}-expanded.png`);
  await shot(send, b);
  console.log(theme, 'expanded ->', b);

  close();
}
