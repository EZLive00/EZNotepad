// ============================================================
// build-syntax.mjs —— 把 highlight.js 与 prettier 打成单文件 ESM
//
//   node scripts/build-syntax.mjs
//
// 产物（都入库，运行时零依赖）：
//   src/vendor/syntax.js  highlight.js + 50 门语言，给预览 / 导出 / 代码块用
//   src/vendor/format.js  prettier + 打印器插件，给「格式化」用
//
// 与 build-cm6.mjs 同一套理由：项目是裸 ESM、没有打包器，而这些库
// 都是几十个模块互相 import 的 npm 包，浏览器直接加载必 404。
// 升级版本或增删语言时重跑本脚本。
// ============================================================
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { entry: 'src/js/vendor-entry/syntax.js', out: 'src/vendor/syntax.js' },
  { entry: 'src/js/vendor-entry/prettier.js', out: 'src/vendor/format.js' },
];

for (const t of targets) {
  const out = resolve(root, t.out);
  await build({
    entryPoints: [resolve(root, t.entry)],
    outfile: out,
    bundle: true,
    format: 'esm',
    minify: true,
    target: ['chrome110'],   // Tauri 的 WebView2 远高于此
    legalComments: 'none',
    logLevel: 'warning',
  });
  const kb = (statSync(out).size / 1024).toFixed(0);
  console.log(`${t.out}  ${kb} KB`);
}
