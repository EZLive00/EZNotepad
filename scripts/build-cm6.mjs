// ============================================================
// build-cm6.mjs —— 把 CodeMirror 6 打成单文件 ESM
//
//   node scripts/build-cm6.mjs
//
// 产物：src/vendor/cm6.js（已入库，不进 .gitignore）
//
// 为什么需要这一步：项目是「裸 ESM、无打包器」，而 CM6 拆成几十个 npm
// 包互相 import，浏览器直接加载会 404。这里在开发机上预先打成一个文件，
// 运行时就还是普通的 ESM —— 构建期多一步，运行期零依赖。
//
// 只在升级 CM6 版本或增删语言时才需要重跑。产物要提交。
// ============================================================
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src/vendor/cm6.js');

await build({
  entryPoints: [resolve(root, 'src/js/editor/cm6-entry.js')],
  outfile: out,
  bundle: true,
  format: 'esm',          // 和项目其余 vendor 文件一致，浏览器原生 import
  minify: true,
  target: ['chrome110'],  // Tauri 的 WebView2 远高于此，可放心用新语法
  legalComments: 'none',
  logLevel: 'warning',
});

const kb = (statSync(out).size / 1024).toFixed(0);
console.log(`src/vendor/cm6.js  ${kb} KB`);
