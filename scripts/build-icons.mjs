// ============================================================
// build-icons.mjs —— 把 Lucide 图标子集编译成内联 SVG 精灵图
// 用法： node scripts/build-icons.mjs
// 原理：读取 src/vendor/icons/lucide/*.svg（原样 vendored 的官方文件），
//       抽出 <svg> 内部路径，生成 <symbol id="i-名称">，写入 index.html 的标记区。
//       路径数据完全不改动，图标本身仍由 Lucide 维护。
// ============================================================
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const iconDir = join(root, 'src/vendor/icons/lucide');
const htmlPath = join(root, 'src/index.html');

const START = '<!-- icon-sprite:start (由 scripts/build-icons.mjs 生成，请勿手改) -->';
const END = '<!-- icon-sprite:end -->';

const files = readdirSync(iconDir).filter((f) => f.endsWith('.svg')).sort();

const symbols = files.map((f) => {
  const raw = readFileSync(join(iconDir, f), 'utf8');
  const inner = raw
    .slice(raw.indexOf('>', raw.indexOf('<svg')) + 1, raw.lastIndexOf('</svg>'))
    .replace(/<!--[\s\S]*?-->/g, '')   // 去掉 license 注释（LICENSE 已单独保留）
    .trim()
    .split('\n')
    .map((l) => '      ' + l.trim())
    .join('\n');
  const id = 'i-' + basename(f, '.svg');
  return `    <symbol id="${id}" viewBox="0 0 24 24">\n${inner}\n    </symbol>`;
});

const sprite = [
  START,
  '  <svg class="icon-sprite" aria-hidden="true" focusable="false">',
  ...symbols,
  '  </svg>',
  '  ' + END,
].join('\n');

let html = readFileSync(htmlPath, 'utf8');
if (html.includes(START) && html.includes(END)) {
  const from = html.indexOf(START);
  const to = html.indexOf(END) + END.length;
  html = html.slice(0, from) + sprite + html.slice(to);
} else {
  // 首次注入：放在 <body ...> 之后
  html = html.replace(/(<body[^>]*>\n)/, `$1${sprite}\n`);
}
writeFileSync(htmlPath, html);

console.log(`已注入 ${symbols.length} 个图标到 src/index.html`);
console.log(symbols.map((s) => '  ' + s.match(/id="([^"]+)"/)[1]).join('\n'));
