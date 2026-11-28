// ============================================================
// build-xterm.mjs —— 把 xterm.js 打成单文件 ESM + 抄出它的样式表
//
//   node scripts/build-xterm.mjs
//
// 产物（都要提交）：
//   src/vendor/xterm.js    ESM，动态 import，进终端时才算解析
//   src/vendor/xterm.css   xterm 自己的样式（终端格子、滚动条、选区）
//
// 为什么样式单独抄一份而不用 import '.../xterm.css'：项目是裸 ESM 无打包器，
// JS 里 import CSS 浏览器不认。xterm 的样式表是纯静态的，直接复制最省事，
// 也方便在 styles.css 里针对深浅色做覆盖。
//
// 只在升级 xterm 版本时需要重跑。
// ============================================================
import { build } from 'esbuild';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outJs = resolve(root, 'src/vendor/xterm.js');
const outCss = resolve(root, 'src/vendor/xterm.css');
const srcCss = resolve(root, 'node_modules/@xterm/xterm/css/xterm.css');

await build({
  entryPoints: [resolve(root, 'src/js/vendor-entry/xterm.js')],
  outfile: outJs,
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(outCss, readFileSync(srcCss, 'utf8'));

const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log(`src/vendor/xterm.js   ${kb(outJs)} KB`);
console.log(`src/vendor/xterm.css  ${kb(outCss)} KB`);
