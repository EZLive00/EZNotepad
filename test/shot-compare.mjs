// 改版前后对照：node test/shot-compare.mjs
// 旧样式从 git HEAD 取，写到 node_modules/.tmp/styles-old.css（由外部命令生成）
import { runPage, shot, SHOT_DIR } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = SHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });

const cases = [
  { tag: 'before', css: '/node_modules/.tmp/styles-old.css' },
  { tag: 'after', css: '/src/styles.css' },
];

let port = 8821;
let cdpPort = 9461;
for (const theme of ['light', 'dark']) {
  for (const c of cases) {
    const { ev, send, close } = await runPage({
      page: `/test/ui-preview.html?css=${encodeURIComponent(c.css)}`,
      theme,
      port: port++,
      cdpPort: cdpPort++,
      width: 1180,
      height: 700,
    });
    await ev('new Promise(r => setTimeout(r, 400))');
    const file = path.join(OUT, `cmp-${theme}-${c.tag}.png`);
    await shot(send, file);
    console.log(theme, c.tag, '->', file);
    close();
  }
}
