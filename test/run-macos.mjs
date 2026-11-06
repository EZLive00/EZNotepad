// ============================================================
// run-macos.mjs —— platform/macos 分支自检
//
// 本机是 Windows，编不了 apple-darwin 目标，macOS-only 的 Rust 分支也不会
// 被 rustc 类型检查。真正能验构建的是 .github/workflows/macos-check.yml；
// 这个脚本只保证「配置与平台分支没缺件」，防止改一处漏一处。
// 它不证明 macOS 能编译，别拿它的绿条当编译通过。
// ============================================================
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); }
};
const has = (text, needle, msg) => ok(text.includes(needle), msg);

// ---- 打包配置 ----
let conf;
try { conf = JSON.parse(read('src-tauri/tauri.conf.json')); }
catch (e) { console.log('  FAIL tauri.conf.json 不是合法 JSON：' + e.message); process.exit(1); }
const win = conf.app?.windows?.[0] || {};
const bundle = conf.bundle || {};

ok(JSON.stringify(bundle.targets).includes('dmg'), 'bundle.targets 含 dmg');
ok(JSON.stringify(bundle.targets).includes('app'), 'bundle.targets 含 app');
ok(!JSON.stringify(bundle.targets).includes('nsis'), 'bundle.targets 不再含 nsis');
ok(win.decorations === true, '主窗口 decorations=true（Overlay 的前提）');
ok(win.titleBarStyle === 'Overlay', '主窗口 titleBarStyle=Overlay');
ok(win.hiddenTitle === true, '主窗口 hiddenTitle=true');
has(win.additionalBrowserArgs || '', '--disable-gpu-sandbox',
  '保留 WebView2 沙箱参数（Windows 回归环境需要，macOS 上 wry 忽略）');
ok(bundle.macOS?.minimumSystemVersion === '11.0', 'macOS 最低版本 11.0');
ok(!bundle.windows, '已移除 Windows NSIS 打包段');

// ---- Rust：平台分支要成对，命令要注册 ----
const rs = read('src-tauri/src/lib.rs');
for (const [name, marker] of [
  ['delete_file_impl', 'trash::delete'],
  ['fallback_decode', 'WINDOWS_1252'],
  ['illegal_name_char', "c == ':'"],
]) {
  ok((rs.match(new RegExp(`fn ${name}\\(`, 'g')) || []).length === 2, `${name} 有 windows / 非 windows 两份`);
  has(rs, marker, `${name} 的非 Windows 实现用到 ${marker}`);
}
has(rs, 'RunEvent::Opened', '接住了 Finder 的 Opened 事件');
has(rs, 'RunEvent::ExitRequested', '拦住了应用级退出（⌘Q）');
has(rs, 'enable_macos_default_menu(false)', '关掉了 macOS 默认系统菜单');
has(rs, '.manage(OpenedFiles::default())', 'OpenedFiles 状态已挂');
has(rs, 'fn confirm_app_exit', '退出放行命令已定义');
has(rs, '            confirm_app_exit,', '退出放行命令已注册到 invoke_handler');
has(rs, 'pdf.unsupported', '导出 PDF 明确返回「不支持」，没有伪造成功');
has(rs, 'printOperation', 'PDF 桩里写清了真正对齐要走的 NSPrintOperation 路径');

// ---- 前端 ----
const i18n = read('src/js/i18n.js');
for (const n of ['IS_MAC', 'kbdToCombo', 'kbdLabel', 'localizeShortcuts']) {
  has(i18n, `export ${n === 'IS_MAC' ? 'const' : 'function'} ${n}`, `i18n.js 导出 ${n}`);
}
has(i18n, "document.documentElement.dataset.os = 'mac'", 'mac 平台标记挂到了 html 上');

const app = read('src/js/app.js');
has(app, "listen('app-exit-request'", '前端接住了 ⌘Q 请求');
has(app, 'guardedQuit(() => win.closeWindow())', '窗口关闭与 ⌘Q 共用同一套守卫');
has(app, 'WINDOWS-1252', '编码选项含 windows-1252');

has(read('src/js/backend.js'), 'confirm_app_exit', 'backend.js 暴露 confirmAppExit');
has(read('src/js/markdown.js'), "src.startsWith('/')", 'resolveDocImg 认 POSIX 绝对路径');
has(read('src/js/errors.js'), "'recycle.failed': '移入回收站失败（{detail}）'", '回收站错误模板统一为 {detail}');

const css = read('src/styles.css');
has(css, 'html[data-os="mac"] .win-ctrl', 'mac 下隐藏自绘窗口按钮');
has(css, 'html[data-os="mac"] .titlebar', 'mac 下给交通灯留位');

// ---- 构建与 CI ----
const pack = read('打包-macOS.command');
has(pack, 'EZ_ARCH', '打包脚本支持架构选择');
has(pack, 'rustup target add', '打包脚本会装 Rust target');
has(pack, '--bundles app,dmg', '打包脚本显式指定产物');

const check = read('.github/workflows/macos-check.yml');
has(check, 'macos-latest', '分支 CI 跑在 macos-latest');
has(check, '--bundles app', '分支 CI 真编 .app');
const release = read('.github/workflows/release.yml');
ok(!release.includes('windows-latest'), '发版 CI 不再构建 Windows');
has(release, 'universal-apple-darwin', '发版 CI 出通用包');

console.log(`${pass}/${pass + fail} macOS 分支自检通过`);
if (fail) process.exit(1);
