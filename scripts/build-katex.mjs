// ============================================================
// build-katex.mjs —— 把 KaTeX 裁成一个能塞进 vendor 的最小包
// 用法： node scripts/build-katex.mjs
//
// 为什么要裁：
//   npm 包解压 4 MB，其中大头是「同一套字体的 woff / woff2 / ttf 三份副本」
//   加几十个示例页。WebView2 是 Chromium，只认 woff2 就够，
//   把 woff/ttf 去掉能省掉一半多体积。
//
// 产出（约 600 KB，全部入库）：
//   src/vendor/katex/katex.min.js          KaTeX 本体
//   src/vendor/katex/auto-render.min.js    自动扫 DOM 里的 $...$ / $$...$$
//   src/vendor/katex/katex.min.css         样式（字体引用改成只留 woff2）
//   src/vendor/katex/fonts/*.woff2         数学字体
//
// 前端不直接 import 这些文件：math.js 在第一次真的遇到公式时才 insert
// <link> / <script>，所以不写公式的文档一分钱都不付。
// ============================================================
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'node_modules/katex/dist');
const out = join(root, 'src/vendor/katex');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'fonts'), { recursive: true });

copyFileSync(join(src, 'katex.min.js'), join(out, 'katex.min.js'));
copyFileSync(join(src, 'contrib/auto-render.min.js'), join(out, 'auto-render.min.js'));

// 只留 woff2：把 url(fonts/X.woff) 和 url(fonts/X.ttf) 连同它们的 format(...) 一起去掉
const css = readFileSync(join(src, 'katex.min.css'), 'utf8')
  .replace(/,\s*url\(fonts\/[^)]+\.woff\)\s*format\("woff"\)/g, '')
  .replace(/,\s*url\(fonts\/[^)]+\.ttf\)\s*format\("truetype"\)/g, '');
writeFileSync(join(out, 'katex.min.css'), css);

const woff2 = readdirSync(join(src, 'fonts')).filter((f) => f.endsWith('.woff2'));
for (const f of woff2) copyFileSync(join(src, 'fonts', f), join(out, 'fonts', f));

const kb = (p) => Math.round(readFileSync(p).length / 1024);
const fontKb = woff2.reduce((n, f) => n + readFileSync(join(out, 'fonts', f)).length, 0) / 1024;
console.log(`katex   ${kb(join(out, 'katex.min.js'))} KB`);
console.log(`render  ${kb(join(out, 'auto-render.min.js'))} KB`);
console.log(`css     ${kb(join(out, 'katex.min.css'))} KB`);
console.log(`fonts   ${Math.round(fontKb)} KB (${woff2.length} 个 woff2)`);
console.log(`合计    ${Math.round((kb(join(out, 'katex.min.js')) + kb(join(out, 'auto-render.min.js')) + kb(join(out, 'katex.min.css')) + fontKb))} KB`);
