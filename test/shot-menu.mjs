// 菜单排版截图：node test/shot-menu.mjs  →  node_modules/.tmp/menu-*.png
import { runPage, shot } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('node_modules/.tmp');
fs.mkdirSync(OUT, { recursive: true });

const cases = [
  { tag: 'file-light', theme: 'light', menu: 'file' },
  { tag: 'format-light', theme: 'light', menu: 'format' },
  { tag: 'format-dark', theme: 'dark', menu: 'format' },
  { tag: 'insert-light', theme: 'light', menu: 'insert' },
  { tag: 'insert-table-light', theme: 'light', menu: 'insert-table' },
];

let port = 8851;
let cdpPort = 9491;
for (const c of cases) {
  const { ev, send, close } = await runPage({
    page: `/test/menu-preview.html?theme=${c.theme}&menu=${c.menu}`,
    theme: c.theme,
    port: port++,
    cdpPort: cdpPort++,
    width: 1060,
    height: 720,
  });
  await ev('new Promise(r => setTimeout(r, 350))');
  const file = path.join(OUT, `menu-${c.tag}.png`);
  await shot(send, file);
  console.log(c.tag, '->', file);
  close();
}
