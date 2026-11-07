// ============================================================
// run-macos.mjs —— platform/macos 分支自检
//
// 本机是 Windows，链接不出 apple-darwin 产物，也跑不了真机探针；但装好
// aarch64-apple-darwin 的 rust-std 后，可以用 DOCS_RS=1 cargo check --target
// 做类型检查（见 docs/macOS-开发.md）。完整编译靠 .github/workflows/macos-check.yml。
// 这个脚本只保证「配置与平台分支没缺件」，防止改一处漏一处。
// 它不证明 macOS 能编译，别拿它的绿条当编译通过。
// ============================================================
import { readFileSync } from 'node:fs';

// 统一行尾：core.autocrlf=true 时工作区是 CRLF，而断言里的多行片段是 LF，
// 内容一致也会判红。读进来先归一化，Linux / CI 上不受影响。
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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

// ---- 从 main 同步的 1.2.0 ----
// 这个分支永远不会合并回 main，也不会再从 main 自动合过来。共用功能移植完要靠
// 自检钉住：哪天有人按 Windows 版改配置却漏了这几处，本机立刻红，不用等 Mac 真机。
const fmt = read('src/js/format.js');
has(fmt, 'export function externalFileKind', 'PDF 只读格式判定在 format.js');
const be = read('src/js/backend.js');
has(be, 'export const openExternal', 'backend.js 暴露「交给系统默认程序」');
has(be, "{ name: 'PDF', extensions: ['pdf'] }", '打开对话框能选到 PDF');
has(read('src/js/markdown.js'), 'get label() { return tt(', '提示块标题运行时取词，不在加载时固化');
has(read('src/js/wysiwyg.js'), 'export function relabelCallouts', '切语言能就地刷新提示块默认标题');
has(app, 'relabelCallouts(el.wysiwyg)', 'applyLang 真的调用了 relabelCallouts');
has(app, 'if (externalFileKind(path))', 'openPath 里拦下 PDF，不建标签、不按文本读');
has(css, 'overflow: visible !important', '打印媒体不再锁死视口高度');
has(css, 'display: block !important', '打印媒体撤掉 flex 列布局（三条要一起撤）');
has(read('src/js/i18n-dict-src.js'), '已用系统默认程序打开 PDF：{name}', 'PDF 分流提示词条进了源表');

// 四处版本号必须一致：发版时漏改一个，本机就能发现。
const pkv = JSON.parse(read('package.json')).version;
const cfv = JSON.parse(read('src-tauri/tauri.conf.json')).version;
ok(/^\d+\.\d+\.\d+$/.test(pkv) && cfv === pkv, 'package.json 与 tauri.conf.json 版本一致');
has(read('src-tauri/Cargo.toml'), `version = "${pkv}"`, 'Cargo.toml 版本与前端一致');
has(read('src-tauri/Cargo.lock'), `name = "simple-notepad"\nversion = "${pkv}"`,
  'Cargo.lock 里 simple-notepad 版本与前端一致');

// ---- 构建与 CI ----
const pack = read('打包-macOS.command');
has(pack, 'EZ_ARCH', '打包脚本支持架构选择');
has(pack, 'rustup target add', '打包脚本会装 Rust target');
has(pack, '--bundles app,dmg', '打包脚本显式指定产物');

const check = read('.github/workflows/macos-check.yml');
has(check, 'macos-15-intel', '分支 CI 默认用 14GB 的 Intel runner（LTO 更稳、队列不同）');
has(check, 'inputs.runner', '分支 CI 允许手动重跑时切换 runner 队列');
has(check, '--bundles app', '分支 CI 真编 .app');
ok(!check.includes('--target aarch64-apple-darwin'),
  '分支 CI 不写死 arm64 target（用 runner 原生 target）');
has(check, 'target/release/bundle/macos/EZNotepad.app', '分支 CI 校验原生 target 的产物路径');
const release = read('.github/workflows/release.yml');
ok(!release.includes('windows-latest'), '发版 CI 不再构建 Windows');
has(release, 'universal-apple-darwin', '发版 CI 出通用包');
has(release, 'macos-15-intel', '发版 CI 也用 14GB 的 Intel runner');

console.log(`${pass}/${pass + fail} macOS 分支自检通过`);
if (fail) process.exit(1);
