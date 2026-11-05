// ============================================================
// build-mermaid.mjs —— 把 mermaid 打成单文件 ESM
//
//   node scripts/build-mermaid.mjs
//
// 产物：src/vendor/mermaid.js（约 5.4 MB，已入库，必须提交）
//
// 为什么能接受 5.4 MB：
//   · 它是**懒加载**的 —— 只有文档里真的出现 ```mermaid 时才 import，
//     没有图的文档启动路径上一个字节都不读。
//   · Tauri 会把前端资源压进 exe，bro 压缩后安装包大约 +1 MB。
//   · 换掉它就得自己写布局引擎（dagre/ELK 那套），那是几万行的活。
//
// 为什么不用 splitting：mermaid 内部按图类型拆了 100 多个 chunk，
// 全部落成文件会让仓库里多出一百个 minified 文件，而收益只是「没用到的
// 图类型不加载」—— 单个文件里没被用到的部分 V8 也不会全部编译。
// ============================================================
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'src/vendor/mermaid.js');

await build({
  entryPoints: [resolve(root, 'src/js/vendor-entry/mermaid.js')],
  outfile: out,
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome110'],
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(`src/vendor/mermaid.js  ${(statSync(out).size / 1048576).toFixed(2)} MB`);
