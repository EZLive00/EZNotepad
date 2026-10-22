// ============================================================
// shortcuts.js —— 快捷键一览（帮助菜单）
// ============================================================
import { dialog } from './ui.js';

const LIST = [
  ['新建标签', 'Ctrl / ⌘ + N'],
  ['打开文件', 'Ctrl / ⌘ + O'],
  ['保存', 'Ctrl / ⌘ + S'],
  ['另存为', 'Ctrl / ⌘ + Shift + S'],
  ['关闭标签', 'Ctrl / ⌘ + W'],
  ['切换标签', 'Ctrl + Tab'],
  ['撤销 / 重做', 'Ctrl + Z / Ctrl + Y'],
  ['查找', 'Ctrl / ⌘ + F'],
  ['替换', 'Ctrl / ⌘ + H'],
  ['一键格式化', 'Ctrl / ⌘ + Shift + F'],
  ['跳转到行', 'Ctrl / ⌘ + G'],
  ['文本对比', 'Ctrl / ⌘ + D'],
  ['下一处 / 上一处差异', 'F8 / F7'],
  ['所见即所得 / 编辑 / 预览', 'Ctrl + 1 / 2 / 3'],
  ['单栏 / 双栏', 'Ctrl / ⌘ + Shift + L'],
  ['显示 / 隐藏大纲', 'Ctrl / ⌘ + Shift + O'],
  ['加粗 / 斜体', 'Ctrl / ⌘ + B / I'],
  ['放大 / 缩小 / 重置字号', 'Ctrl + = / - / 0'],
  ['导出 PDF', 'Ctrl / ⌘ + P'],
  ['关闭查找条', 'Esc'],
];

export function showShortcuts() {
  dialog({
    title: '快捷键一览',
    body: `<table class="kbd-table">${LIST.map(([k, v]) => `<tr><td>${v}</td><td>${k}</td></tr>`).join('')}</table>`,
  });
}
