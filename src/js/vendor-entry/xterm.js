// ============================================================
// vendor-entry/xterm.js —— 内嵌终端的打包入口（构建期文件）
//
// 产物 src/vendor/xterm.js，由 src/js/term.js 动态 import —— 终端没有
// 打开过的用户不为它付解析代价（和 mermaid / prettier 同一个策略）。
//
// 只装两个包：
//   @xterm/xterm    —— 渲染与 VT 解析
//   @xterm/addon-fit —— 按容器尺寸算行列数（面板拖高、窗口缩放都要用）
//
// CSS 不在这里：xterm 的样式表由 build-xterm.mjs 直接抄成
// src/vendor/xterm.css，main 里按需 link（见 term.js::ensureStyle）。
// ============================================================
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export { Terminal, FitAddon };
