// ============================================================
// app-icon.mjs —— 品牌标 / 应用图标的**唯一几何源**
//
// 用法：
//   node scripts/app-icon.mjs            生成 app-icon.svg、注入 index.html、
//                                       再用 tauri icon 重建整套位图
//   node scripts/app-icon.mjs --check    只校验两份产物是否与本文件一致（测试用）
//
// 为什么要有这份文件：标题栏左上角那枚（.brand-mark + #i-brand）和任务栏 /
// 资源管理器 / 快捷方式用的 icon.ico 曾经是两份手写几何 —— 一份纯色橙底、
// 白纸小、留白多，一份渐变橙底、白纸大、圆角小。改色时只重建了后者，
// 于是「同一个程序两个图标」。现在两边都从这里出：
//
//   * 几何只有一组，写在 24 单位坐标系里（就是 #i-brand 的 viewBox）；
//   * index.html 直接把这一组放进 <symbol id="i-brand" viewBox="0 0 24 24">；
//   * app-icon.svg 用 1024 画布，先画 .brand-mark 那块橙底，再用一个
//     translate+scale 把**同一组** path 放到与 16px 图标 / 22px 底块相同的位置。
//     不重算坐标、不做「小尺寸补偿」，所以放大缩小都是同一张图。
//   * 橙底取 --accent-solid = --tm-9 = #e54d2e（亮色与深色主题同值），
//     标题栏那块底也是它，两种主题下都一致。
//
// 改图标只改这里，然后 `pnpm icons:app`；别手改 index.html 或 app-icon.svg。
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const htmlPath = join(root, 'src/index.html');
const svgPath = join(root, 'src-tauri/icons/app-icon.svg');
const iconDir = join(root, 'src-tauri/icons');
const cliPath = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const tmpDir = join(root, 'node_modules/.tmp/app-icon-out');

const START = '  <!-- brand-sprite:start (由 scripts/app-icon.mjs 生成，请勿手改) -->';
const END = '  <!-- brand-sprite:end -->';

// —— 唯一一组几何（24 单位坐标系）——
const PAPER = 'M5 2h9l7 7v11.4a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6V3.6A1.6 1.6 0 0 1 5 2z';
const FOLD = 'M14 2l7 7h-5.4A1.6 1.6 0 0 1 14 7.4z';
const LINES = [
  { x: '5.4', y: '9', w: '9.2', h: '2', r: '1' },
  { x: '5.4', y: '12.4', w: '12.6', h: '1.7', r: '.85' },
  { x: '5.4', y: '15.4', w: '8.2', h: '1.7', r: '.85' },
];
const COLOR = { paper: '#fbfaf7', fold: '#ece2d4', ink: '#1f232c', bg: '#e54d2e' };

// —— 标题栏那枚底块的尺寸（src/styles.css 的 .brand-mark）——
const BOX = 1024;      // 应用图标画布
const MARK = 22;       // .brand-mark 边长 px
const INNER = 16;      // .brand-mark .ico 边长 px
const RADIUS = 8;      // --r-2，底块圆角 px

function brandBody(indent) {
  const p = indent + '  ';
  return [
    `${p}<path d="${PAPER}" fill="${COLOR.paper}" />`,
    `${p}<path d="${FOLD}" fill="${COLOR.fold}" />`,
    `${p}<g fill="${COLOR.ink}">`,
    ...LINES.map((l) => `${p}  <rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.r}" />`),
    `${p}</g>`,
  ].join('\n');
}

export function brandSprite() {
  return [
    START,
    '  <svg class="icon-sprite" aria-hidden="true" focusable="false">',
    '    <symbol id="i-brand" viewBox="0 0 24 24">',
    brandBody('    '),
    '    </symbol>',
    '  </svg>',
    END,
  ].join('\n');
}

export function appIconSvg() {
  const n = (v) => Number(v.toFixed(4));
  const pad = n(BOX * (MARK - INNER) / (2 * MARK));
  const scale = n((BOX * INNER / MARK) / 24);
  const radius = n(BOX * RADIUS / MARK);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '  <!-- 由 scripts/app-icon.mjs 生成，请勿手改。几何与 #i-brand 同一组。 -->',
    `  <rect width="${BOX}" height="${BOX}" rx="${radius}" fill="${COLOR.bg}" />`,
    `  <g transform="translate(${pad} ${pad}) scale(${scale})">`,
    brandBody('  '),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

// tauri icon 会顺带产出 android/ / ios/ 两棵目录；本项目只发布桌面端，
// 按白名单把桌面需要的位图搬过去，其余留在临时目录，不污染仓库。
const BITMAPS = [
  '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png',
  'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
  'Square89x89Logo.png', 'Square107x107Logo.png', 'Square142x142Logo.png',
  'Square150x150Logo.png', 'Square284x284Logo.png', 'Square310x310Logo.png',
  'StoreLogo.png', 'icon.png', 'icon.ico', 'icon.icns',
];

const lf = (s) => s.replace(/\r\n/g, '\n');

function check() {
  const problems = [];
  if (lf(readFileSync(svgPath, 'utf8')) !== appIconSvg()) {
    problems.push('src-tauri/icons/app-icon.svg 与 scripts/app-icon.mjs 不一致');
  }
  if (!lf(readFileSync(htmlPath, 'utf8')).includes(brandSprite())) {
    problems.push('src/index.html 的 #i-brand 与 scripts/app-icon.mjs 不一致');
  }
  for (const f of BITMAPS) {
    if (!existsSync(join(iconDir, f))) problems.push(`缺少图标产物 ${f}`);
  }
  if (problems.length) {
    console.error('icons:app --check 失败：\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log(`icons:app --check OK（1 份源、2 份文本产物、${BITMAPS.length} 份位图）`);
}

function build() {
  writeFileSync(svgPath, appIconSvg());
  const html = lf(readFileSync(htmlPath, 'utf8'));
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    console.error('index.html 里找不到 brand-sprite 标记区，拒绝注入');
    process.exit(1);
  }
  const next = html.slice(0, from) + brandSprite() + html.slice(to + END.length);
  writeFileSync(htmlPath, next);
  console.log('已写入 src-tauri/icons/app-icon.svg 与 src/index.html 的 #i-brand');

  mkdirSync(tmpDir, { recursive: true });
  const r = spawnSync(process.execPath, [cliPath, 'icon', svgPath, '-o', tmpDir], {
    cwd: root, encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error('tauri icon 失败：\n' + (r.stderr || r.stdout || '').slice(-2000));
    process.exit(1);
  }
  for (const f of BITMAPS) copyFileSync(join(tmpDir, f), join(iconDir, f));
  console.log(`已重建 ${BITMAPS.length} 份图标产物 → src-tauri/icons/`);
}

const invokedDirectly = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (process.argv.includes('--check')) check();
else if (invokedDirectly) build();
