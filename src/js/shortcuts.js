// ============================================================
// shortcuts.js —— 快捷键一览（帮助菜单）
// ============================================================
import { dialog } from './ui.js';
import { tt } from './i18n.js';

const list = () => [
  [tt('新建标签'), 'Ctrl / ⌘ + N'],
  [tt('打开文件'), 'Ctrl / ⌘ + O'],
  [tt('保存'), 'Ctrl / ⌘ + S'],
  [tt('另存为'), 'Ctrl / ⌘ + Shift + S'],
  [tt('关闭标签'), 'Ctrl / ⌘ + W'],
  [tt('切换标签'), 'Ctrl + Tab'],
  [tt('撤销 / 重做'), 'Ctrl + Z / Ctrl + Y'],
  [tt('查找'), 'Ctrl / ⌘ + F'],
  [tt('替换'), 'Ctrl / ⌘ + H'],
  [tt('一键格式化'), 'Ctrl / ⌘ + Shift + F'],
  [tt('跳转到行'), 'Ctrl / ⌘ + G'],
  [tt('文本对比'), 'Ctrl / ⌘ + D'],
  [tt('下一处 / 上一处差异'), 'F8 / F7'],
  [tt('所见即所得 / 编辑 / 预览'), 'Ctrl + 1 / 2 / 3'],
  [tt('单栏 / 双栏'), 'Ctrl / ⌘ + Shift + L'],
  [tt('显示 / 隐藏大纲'), 'Ctrl / ⌘ + Shift + O'],
  [tt('专注模式（Esc 退出）'), 'F9'],
  [tt('插入目录'), tt('菜单：插入 → 目录')],
  [tt('跳文档内锚点'), tt('Ctrl / ⌘ + 点击目录里的条目')],
  [tt('加粗 / 斜体'), 'Ctrl / ⌘ + B / I'],
  [tt('删除线 / 插入链接'), 'Ctrl / ⌘ + Shift + X ／ Ctrl / ⌘ + K'],
  [tt('正文 / 一~三级标题'), 'Ctrl + Alt + 0 / 1 / 2 / 3'],
  [tt('无序 / 有序 / 任务列表'), 'Ctrl + Shift + 8 / 7 / 9'],
  [tt('引用 / 代码块'), 'Ctrl + Shift + Q / K'],
  [tt('插入表格'), 'Ctrl + Shift + T'],
  [tt('列表缩进 / 退回'), 'Tab / Shift + Tab'],
  [tt('放大 / 缩小 / 重置字号'), 'Ctrl + = / - / 0'],
  [tt('导出 PDF'), 'Ctrl / ⌘ + P'],
  [tt('设置'), 'Ctrl / ⌘ + ,'],
  [tt('关闭查找条'), 'Esc'],
];

export function showShortcuts() {
  dialog({
    title: tt('快捷键一览'),
    body: `<table class="kbd-table">${list().map(([k, v]) => `<tr><td>${v}</td><td>${k}</td></tr>`).join('')}</table>`,
  });
}
