// ============================================================
// state.js —— 全局状态、标签模型、本地持久化（草稿 / 设置）
// ============================================================

export const LS = {
  get(k, d) {
    try { const v = localStorage.getItem('snp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('snp.' + k, JSON.stringify(v)); } catch {}
  },
  del(k) { try { localStorage.removeItem('snp.' + k); } catch {} },
};

const DEFAULTS = {
  theme: 'auto',        // auto | light | dark
  fontSize: 13.5,
  layout: 'single',     // single | split（2026-10-25 起默认单栏）
  outlineVisible: true,
  showToolbar: true,
  showWinTitle: true,   // 标题栏中间是否显示文件名
  lastMode: {},
  lastNewExt: 'md',     // 「新建」上次选的扩展名
  autoSave: true,       // 自动保存（只对已存在于磁盘上的文件生效）
  folder: '',           // 侧栏「文件」页打开的文件夹
  side: 'outline',      // 侧栏当前页：outline | files
  zen: false,           // 专注模式：只留标题栏和正文
  watchFiles: true,     // 监听磁盘上的改动（别的程序改了文件实时提示）
  keymap: {},           // 自定义快捷键：{ 'mod+shift+k': 'commandId' }，优先于默认键位
  __v: 2,               // 设置版本：默认值变更时 +1，触发下面的迁移
};

export const settings = Object.assign({}, DEFAULTS, LS.get('settings', {}));

/* 一次性迁移：老用户的 localStorage 里存着上一版的默认值（layout:split / autoSave:false），
   光改 DEFAULTS 对他们无效。bump __v 后按新默认覆盖一次；
   测试脚本等需要钉死设置的地方，在写入的 settings 里带上当前 __v 即可跳过。 */
if (LS.get('settings', {}).__v !== DEFAULTS.__v) {
  settings.layout = 'single';
  settings.autoSave = true;
  saveSettings();
}

export function saveSettings() { LS.set('settings', settings); }

let tabSeq = 0;
export function createTab(name = '未命名.md', content = '', path = null) {
  return {
    id: ++tabSeq,
    path,                       // 绝对路径，未保存为 null
    name,
    content,                    // Markdown / 纯文本源
    savedContent: content,
    encoding: 'UTF-8',
    bom: false,
    eol: 'LF',
    mode: null,                 // 当前模式（按类型自动决定）
    scrollTop: 0,
    caret: 0,
    readonly: false,
    external: false,            // 是否为外部生成（对比结果 / 合并结果）
    mtime: null,                // 上次读/写这个文件时的修改时间（毫秒），用于发现外部改动
  };
}

export const tabs = [];
export let activeId = null;

export function setActive(id) { activeId = id; }
export const activeTab = () => tabs.find((t) => t.id === activeId) || null;

export function removeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i >= 0) tabs.splice(i, 1);
  if (activeId === id) activeId = tabs[Math.min(i, tabs.length - 1)] ? tabs[Math.min(i, tabs.length - 1)].id : null;
}

export function isDirty(tab) { return tab && tab.content !== tab.savedContent; }
