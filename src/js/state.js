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

export const settings = Object.assign(
  {
    theme: 'auto',        // auto | light | dark
    fontSize: 13.5,
    layout: 'split',      // split | single
    outlineVisible: true,
    showToolbar: true,
    showWinTitle: true,   // 标题栏中间是否显示文件名
    lastMode: {},
    lastNewExt: 'md',     // 「新建」上次选的扩展名
  },
  LS.get('settings', {})
);

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
