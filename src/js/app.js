// ============================================================
// app.js —— 应用主控：标签、视图、模式、命令、快捷键
// 各业务能力（渲染 / 对比 / 合并 / 格式化）独立成模块，这里只做编排
// ============================================================
import { createTab, tabs, settings, saveSettings, LS, isDirty, activeTab, setActive, removeTab } from './state.js';
import * as be from './backend.js';
import { detectKind, kindLabel, modesFor, formatByKind, lineOps, caseOps } from './format.js';
import { renderPreview, extractOutline } from './preview.js';
import { WysiwygEditor } from './wysiwyg.js';
import { PlainEditor } from './editor/plain-editor.js';
import { toast, dialog, confirmBox, contextMenu } from './ui.js';
import { DiffPanel } from './diffpanel.js';
import { MergeWizard } from './mergewizard.js';
import { showShortcuts } from './shortcuts.js';
import { exportPdf, printTab } from './pdf.js';
import { iconHTML, setIcon } from './icons.js';
import { createAppMenu } from './appmenu.js';
import { freeUntitledName, moveById } from './taborder.js';
import * as win from './win.js';

const $ = (id) => document.getElementById(id);

/* ---------------- 子面板（对比中心 / 三向合并） ---------------- */
const diff = new DiffPanel({ openTab: (name, content, opts) => newTab(name, content, null, opts) });
const merge = new MergeWizard({ openTab: (name, content, opts) => newTab(name, content, null, opts) });
const el = {
  tabs: $('tabs'),
  editor: $('editor'),
  wysiwyg: $('wysiwyg'),
  preview: $('preview'),
  previewPane: $('previewPane'),
  previewHead: $('previewHeadText'),
  outlineList: $('outlineList'),
  outlinePane: $('outlinePane'),
  mid: $('midSplitter'),
  outlineSplitter: $('outlineSplitter'),
  editorPane: $('editorPane'),
  modeLabel: $('modeLabel'),
  modeIcon: $('modeIcon'),
  modeMenu: $('modeMenu'),
  modeNote: $('modeNote'),
  fmtBadge: $('fmtBadge'),
  btnSave: $('btnSave'),
  stPos: $('stPos'),
  stLines: $('stLines'),
  stWords: $('stWords'),
  stEOL: $('stEOL'),
  stEncoding: $('stEncoding'),
  stDraft: $('stDraft'),
  findbar: $('findbar'),
  workspace: $('workspace'),
  winTitle: $('winTitle'),
  menubar: $('menubar'),
  wcMax: $('wcMax'),
  wcMaxIcon: $('wcMaxIcon'),
  editWrap: $('editWrap'),
  wHandle: $('wHandle'),
  whAdd: $('whAdd'),
  whMenu: $('whMenu'),
  wBlockMenu: $('wBlockMenu'),
};

/* ---------------- 纯文本 / 代码编辑区 ----------------
 * CodeMirror 6 实例。全项目只有 js/editor/plain-editor.js 认识 CM6，
 * 这里拿到的只是一组「读写文本 + 选区偏移」的方法。
 * 全应用共用一个实例（和原来的 textarea 一样），切标签时换内容。
 */
const plain = new PlainEditor(el.editor, {
  onChange: () => onEditorInput(),
  onCursor: () => updateCursorPos(),
  onPasteImage: (file) => insertImageFromFile(file),
});

const MODE_META = {
  // short 用于工具栏/标题栏这类横向空间紧张的地方
  wysiwyg: { label: '所见即所得', short: '所见即所得', icon: 'type' },
  edit: { label: '编辑模式', short: '编辑', icon: 'code' },
  preview: { label: '预览模式', short: '预览', icon: 'eye' },
};

let currentLang = '';

/* ---------------- 主题 ---------------- */
function applyTheme() {
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && sysDark);
  document.body.dataset.theme = dark ? 'dark' : 'light';
}

/* ---------------- WYSIWYG ---------------- */
const wys = new WysiwygEditor(el.wysiwyg, {
  onChange: (md) => {
    const t = activeTab();
    if (!t) return;
    if (t.content !== md) {
      t.content = md;
      schedulePreview();
      refreshStats();
      updateOutline();
      scheduleDraft();
      scheduleAutoSave();
      updateStatus();
    }
  },
  onPasteImage: (file) => insertImageFromFile(file),
  openLink: (href) => openExternal(href),
});

/* ---------------- 标签 ---------------- */
/** 标题栏中间那行文字 + 系统窗口标题（任务栏 / Alt+Tab 用） */
let titleTimer = 0;
function refreshTitle() {
  const t = activeTab();
  const dirty = t ? isDirty(t) : false;
  const name = t ? t.name : '';
  const shown = settings.showWinTitle === false
    ? ''
    : (t ? (dirty ? '• ' + name : name) : '简单记事本');
  if (el.winTitle && el.winTitle.textContent !== shown) el.winTitle.textContent = shown;
  // 保存按钮兼作「有改动」的提示：没有工具行的其它文件操作了，这里点一下最直接
  if (el.btnSave) el.btnSave.classList.toggle('dirty', dirty);
  const docTitle = t ? `${dirty ? '• ' : ''}${name} — 简单记事本` : '简单记事本';
  if (document.title !== docTitle) document.title = docTitle;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => win.setTitle(docTitle), 300);
}

let dragTabId = null;   // 正在被拖拽的标签 id（拖拽期间只存这一个）

function renderTabs() {
  el.tabs.innerHTML = '';
  const act = activeTab();
  for (const t of tabs) {
    const b = document.createElement('div');
    b.className = 'tab' + (act && t.id === act.id ? ' active' : '');
    b.title = t.path || t.name;
    b.draggable = true;
    b.dataset.id = String(t.id);
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    b.appendChild(name);
    if (isDirty(t)) {
      const d = document.createElement('span');
      d.className = 'tab-dot';
      b.appendChild(d);
    }
    const x = document.createElement('button');
    x.className = 'tab-close';
    x.innerHTML = iconHTML('x');
    x.title = '关闭';
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    b.appendChild(x);
    b.onclick = () => activate(t.id);
    /* 中键关闭：几乎所有带标签的软件都认这个手势，缺了会一直误开新标签 */
    b.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      closeTab(t.id);
    });
    b.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

    /* 拖拽换位。dragover 里按指针落在标签的左/右半边决定插到前面还是后面，
       用一个 ::before/::after 的竖线提示落点 */
    b.addEventListener('dragstart', (e) => {
      dragTabId = t.id;
      b.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(t.id)); } catch {}
    });
    b.addEventListener('dragend', () => {
      dragTabId = null;
      el.tabs.querySelectorAll('.tab').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    b.addEventListener('dragover', (e) => {
      if (dragTabId == null || dragTabId === t.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = b.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      b.classList.toggle('drop-after', after);
      b.classList.toggle('drop-before', !after);
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-before', 'drop-after'));
    b.addEventListener('drop', (e) => {
      if (dragTabId == null) return;
      e.preventDefault();
      const r = b.getBoundingClientRect();
      moveTab(dragTabId, t.id, e.clientX > r.left + r.width / 2);
      dragTabId = null;
    });

    b.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: '关闭', shortcut: 'Ctrl+W', action: () => closeTab(t.id) },
        { label: '关闭其他', action: () => closeOthers(t.id) },
        { label: '关闭右侧', action: () => closeRight(t.id) },
        { sep: true },
        { label: '复制文件路径', disabled: !t.path, action: () => { navigator.clipboard.writeText(t.path || ''); toast('路径已复制'); } },
        { label: '在文件夹中显示', disabled: !t.path, action: () => revealInFolder(t.path) },
      ]);
    };
    el.tabs.appendChild(b);
  }
  refreshTitle();
}

/** 把 fromId 这个标签挪到 toId 之前/之后（DOM 拖拽只改变顺序，不影响内容） */
function moveTab(fromId, toId, after) {
  const next = moveById(tabs, fromId, toId, after);
  if (next === tabs) return;
  tabs.splice(0, tabs.length, ...next);   // tabs 是导出的常量数组，只能原地改
  renderTabs();
}

async function revealInFolder(p) {
  try {
    const { revealItemInDir } = await import('../vendor/plugin-opener/dist-js/index.js');
    await revealItemInDir(p);
  } catch { toast('无法打开文件位置'); }
}

function closeOthers(id) {
  [...tabs].filter((t) => t.id !== id).forEach((t) => removeTab(t.id));
  activate(id);
}
function closeRight(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  [...tabs].slice(idx + 1).forEach((t) => removeTab(t.id));
  activate(id);
}

export function newTab(name = '未命名.md', content = '', path = null, opts = {}) {
  const t = createTab(name, content, path);
  // 新标签默认从「编辑模式」开始（Markdown 可自行切到所见即所得）
  t.mode = settings.lastMode[detectKind(name)] || 'edit';
  Object.assign(t, opts);
  tabs.push(t);
  activate(t.id);
  return t;
}

function activate(id) {
  persistCurrentView();
  setActive(id);
  const t = activeTab();
  renderTabs();
  if (!t) { clearView(); return; }
  currentLang = (t.name.split('.').pop() || '').toLowerCase();
  const kind = detectKind(t.name);
  const allowed = modesFor(kind);
  let mode = t.mode;
  if (!mode || !allowed.includes(mode)) {
    const last = settings.lastMode[kind];
    mode = allowed.includes(last) ? last : (allowed.includes('edit') ? 'edit' : allowed[0]);
  }
  setMode(mode, { fromActivate: true });
  saveDraft();
}

function clearView() {
  plain.load('');
  el.wysiwyg.innerHTML = '';
  el.preview.innerHTML = '<div class="diff-empty">没有打开的文件</div>';
  el.outlineList.innerHTML = '<div class="outline-empty">新建或打开一个文件开始。</div>';
  el.fmtBadge.textContent = '—';
}

/* ---------------- 模式 / 布局 ---------------- */
function setMode(mode, opt = {}) {
  const t = activeTab();
  if (!t) return;
  const kind = detectKind(t.name);
  const allowed = modesFor(kind);
  if (!allowed.includes(mode)) {
    const fallback = allowed.includes(settings.lastMode[kind]) ? settings.lastMode[kind] : 'edit';
    toast(`${kindLabel(kind)} 不支持「${MODE_META[mode].label}」，已切到「${MODE_META[fallback].label}」`);
    mode = fallback;
  }
  const changedTab = !opt.fromActivate;
  if (t.mode !== mode) changedTab || (t.content = readEditor(t));
  t.mode = mode;
  settings.lastMode[kind] = mode;
  saveSettings();

  el.modeLabel.textContent = MODE_META[mode].short || MODE_META[mode].label;
  setIcon(el.modeIcon, MODE_META[mode].icon);

  const split = settings.layout === 'split';
  const showEditor = mode !== 'preview';
  const showWys = mode === 'wysiwyg';
  const showPreview = split || mode === 'preview';

  plain.setVisible(showEditor && !showWys);
  el.wysiwyg.classList.toggle('hidden', !showWys);
  el.previewPane.classList.remove('hidden');
  el.previewPane.classList.toggle('hidden', !showPreview);
  el.mid.classList.toggle('hidden', !(showEditor && showPreview));
  el.editorPane.style.flex = '1';
  el.previewPane.style.flex = split ? '1' : '1';
  el.previewHead.textContent = split ? '预览' : '预览（只读）';

  const docDir = t.path ? be.dirName(t.path) : '';
  if (showWys) { wys.setDocDir(docDir); wys.render(t.content); }
  else if (showEditor) { plain.load(t.content, currentLang); }
  if (showPreview) renderPreview(kind, t.content, currentLang, el.preview, docDir);

  updateModeMenu(kind, allowed);
  updateOutline();
  refreshStats();
  updateStatus();   // 切换文件/模式后格式徽标、行列数、草稿状态都要跟着变
  if (mode === 'preview') el.preview.scrollTop = t.scrollTop || 0;
  // 手柄只属于所见即所得：切到编辑/预览就收起来
  if (mode === 'wysiwyg') refreshHandle();
  else { hoverBlock = null; handleBusy = false; el.wHandle.classList.add('hidden'); closeBlockMenu(); }
}

function updateModeMenu(kind, allowed) {
  el.modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    const m = b.dataset.mode;
    b.classList.toggle('checked', activeTab() && activeTab().mode === m);
    b.classList.toggle('disabled', !allowed.includes(m));
  });
  const notes = {
    md: '支持全部三种模式',
    json: 'JSON 支持：编辑 / 预览（校验 + 高亮）',
    code: '代码支持：编辑 / 预览（语法高亮）',
    txt: '纯文本支持：编辑 / 预览（只读）',
    data: '表格文本支持：编辑 / 预览（只读）',
  };
  el.modeNote.textContent = `当前格式：${kindLabel(kind)} · ${notes[kind] || ''}`;
}

function setLayout(layout) {
  settings.layout = layout;
  saveSettings();
  const t = activeTab();
  if (t) setMode(t.mode, { fromActivate: true });
}

/* ---------------- 预览 ---------------- */
let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const t = activeTab();
    if (!t || el.previewPane.classList.contains('hidden')) return;
    const scroll = el.preview.scrollTop;
    renderPreview(detectKind(t.name), t.content, currentLang, el.preview, t.path ? be.dirName(t.path) : '');
    el.preview.scrollTop = scroll;
  }, 120);
}

function updateOutline() {
  const t = activeTab();
  if (!t) return;
  const show = settings.outlineVisible;
  el.outlinePane.classList.toggle('hidden', !show);
  el.outlineSplitter.classList.toggle('hidden', !show);
  if (!show) return;
  const kind = detectKind(t.name);
  const items = extractOutline(kind, t.content);
  if (!items.length) {
    el.outlineList.innerHTML = `<div class="outline-empty">${kind === 'md' ? '用 # 定义标题后，这里会出现大纲。' : '当前文件没有可提取的结构。'}</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const b = document.createElement('button');
    b.className = `outline-item h${Math.min(6, it.level)}`;
    b.textContent = it.text;
    b.title = it.text;
    b.onclick = () => gotoLine(it.line);
    frag.appendChild(b);
  }
  el.outlineList.innerHTML = '';
  el.outlineList.appendChild(frag);
}

function gotoLine(line) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') {
    let acc = 0;
    for (const blk of el.wysiwyg.children) {
      if (acc >= line) { blk.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      acc += blk.dataset.type === 'code' ? (blk.textContent.split('\n').length + 1) : 1;
    }
    return;
  }
  const lines = t.content.split('\n');
  let off = 0;
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  plain.revealOffset(off, off + (lines[line] || '').length);
  updateStatus();
}

/* ---------------- 状态栏 ---------------- */
function refreshStats() {
  const t = activeTab();
  if (!t) return;
  const text = t.content;
  const lines = text.split('\n').length;
  const chars = text.length;
  const words = (text.match(/[\u4e00-\u9fa5]/g) || []).length + (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
  el.stLines.textContent = `${lines} 行`;
  el.stWords.textContent = `${words} 字 · ${chars} 字符`;
}

/**
 * 只刷新状态栏的行列。
 * CM6 每次选区变化（包括按方向键）都会回调，走完整 updateStatus 会连标签栏
 * 一起重建 DOM，太亏。所以光标单独一条轻量路径。
 */
function updateCursorPos() {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'edit') {
    const c = plain.cursor;
    el.stPos.textContent = `行 ${c.line}, 列 ${c.col}`;
  } else {
    el.stPos.textContent = '—';
  }
}

function updateStatus() {
  const t = activeTab();
  if (!t) return;
  el.stEOL.textContent = t.eol;
  el.stEncoding.textContent = t.encoding;
  el.fmtBadge.textContent = kindLabel(detectKind(t.name));
  updateCursorPos();
  el.stDraft.textContent = isDirty(t) ? '未保存' : '已保存';
  el.stDraft.classList.toggle('dirty', isDirty(t));
  renderTabs();
}

/* ---------------- 草稿 ---------------- */
let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
  const t = activeTab();
  if (!t) return;
  const openTabs = tabs.map((x) => ({ path: x.path, name: x.name }));
  if (t.path && !isDirty(t)) { LS.set('session', openTabs); LS.del('draft'); return; }
  LS.set('draft', {
    path: t.path, name: t.name, content: t.content,
    encoding: t.encoding, eol: t.eol, mode: t.mode, time: Date.now(),
  });
  LS.set('session', openTabs);
}

async function restoreDraft() {
  const d = LS.get('draft', null);
  if (!d || !d.content) return false;
  if (d.path) {
    try {
      const r = await be.readText(d.path);
      if (r.content === d.content) { LS.del('draft'); return false; }
    } catch {}
  }
  const when = new Date(d.time).toLocaleString();
  const keep = await confirmBox(
    '恢复上次的草稿',
    `发现一份未保存的内容：<b>${d.name}</b>（${when}）。<br><br>是否恢复？`,
    '恢复草稿', '丢弃'
  );
  if (!keep) { LS.del('draft'); return false; }
  newTab(d.name, d.content, d.path, { encoding: d.encoding || 'UTF-8', eol: d.eol || 'LF', mode: d.mode });
  toast('草稿已恢复');
  return true;
}

/* ---------------- 自动保存 / 外部改动 ---------------- */
/* 自动保存只针对「已经存在于磁盘上的文件」：未命名文档没有路径，
   静默写盘会让人在文件管理里凭空多出一堆东西，所以仍然要手动保存。 */
let autoSaveTimer = 0;
function scheduleAutoSave() {
  if (!settings.autoSave) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    const t = activeTab();
    if (t && t.path && isDirty(t)) saveTab(t, false, { silent: true });
  }, 1200);
}

/* 窗口重新获得焦点时比对一次修改时间。别的编辑器（或生成脚本）改了同一个文件，
   我们再保存就会把对方的改动默默抹掉——这是记事本类软件最伤数据的一种 bug。 */
let extBusy = false;
async function checkExternalChange() {
  const t = activeTab();
  if (!t || !t.path || t.mtime == null || extBusy) return;
  extBusy = true;
  try {
    const m = await be.fileMtime(t.path);
    if (m == null || m === t.mtime) return;
    if (!isDirty(t)) {
      await reloadTab(t, m);
      toast('文件已在磁盘上更新，已重新载入');
      return;
    }
    const reload = await confirmBox(
      '文件已在外部修改',
      `<b>${t.name}</b> 在打开之后被其他程序改过。<br><br>重新载入会丢掉你这里的修改。`,
      '重新载入', '保留我的'
    );
    if (!reload) return;
    await reloadTab(t, m);
    toast('已重新载入');
  } catch {
    /* 读不到就算了：真正的失败留给保存时报错，别在这里弹窗打扰 */
  } finally {
    extBusy = false;
  }
}

/** 把磁盘上的最新内容装回标签（不动 mtime 就让下一次检查又弹一遍） */
async function reloadTab(t, mtime) {
  const r = await be.readText(t.path);
  t.mtime = mtime;
  t.encoding = r.encoding;
  t.eol = r.eol;
  t.bom = r.bom;
  t.content = r.content;
  t.savedContent = r.content;
  if (activeTab() && activeTab().id === t.id) setContent(r.content);
  else updateStatus();
}

/* ---------------- 文件操作 ---------------- */
export async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) { activate(existing.id); return; }
  try {
    const r = await be.readText(path);
    // 先拿到修改时间再建标签：否则「刚打开就被自己当成外部改动」
    const mtime = await be.fileMtime(path).catch(() => null);
    newTab(r.name, r.content, r.path, { encoding: r.encoding, bom: r.bom, eol: r.eol, mtime });
    addRecent(path);
  } catch (e) {
    dialog({ title: '无法打开', body: String(e) });
  }
}

async function openFileDialog() {
  const p = await be.pickFile();
  if (p) openPath(p);
}

async function saveTab(t = activeTab(), saveAs = false, opts = {}) {
  if (!t) return false;
  const silent = !!opts.silent;
  if (!t.path || saveAs) {
    const p = await be.pickSavePath(t.path || t.name);
    if (!p) return false;
    t.path = p;
    t.name = be.baseName(p);
    t.external = false;
    currentLang = (t.name.split('.').pop() || '').toLowerCase();
    plain.setLanguage(currentLang);   // 另存为可能改了扩展名，着色要跟着换
  }
  try {
    t.content = readEditor(t);
    const content = t.eol === 'CRLF' ? t.content.replace(/\r?\n/g, '\r\n') : t.content.replace(/\r\n?/g, '\n');
    /* 覆盖之前先对一眼修改时间：文件被别的程序改过还硬写，就是把对方的改动抹掉。
       自动保存（silent）同样要问——它更不该悄悄覆盖别人的东西 */
    if (!saveAs && t.mtime != null) {
      const cur = await be.fileMtime(t.path).catch(() => null);
      if (cur != null && cur !== t.mtime) {
        const overwrite = await confirmBox(
          '文件已被其他程序修改',
          `磁盘上的 <b>${t.name}</b> 在打开之后被改过，保存会覆盖那些改动。`,
          '仍然覆盖', '取消'
        );
        if (!overwrite) return false;
      }
    }
    await be.saveText({ path: t.path, content, encoding: t.encoding, bom: t.bom });
    t.savedContent = t.content;
    t.mtime = await be.fileMtime(t.path).catch(() => t.mtime);
    LS.del('draft');
    addRecent(t.path);
    updateStatus();
    if (!silent) toast(`已保存 ${t.name}`);
    return true;
  } catch (e) {
    dialog({ title: '保存失败', body: String(e) });
    return false;
  }
}

const saveTabAs = (t) => saveTab(t, true);

async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (isDirty(t)) {
    persistCurrentView();
    const r = await dialog({
      title: '未保存的修改',
      body: `<b>${t.name}</b> 有未保存的修改，要保存吗？`,
      buttons: [
        { id: 'save', label: '保存', primary: true },
        { id: 'discard', label: '不保存' },
        { id: 'cancel', label: '取消' },
      ],
    });
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveTab(t))) return;
  }
  const wasActive = activeTab() && activeTab().id === id;
  removeTab(id);
  if (!tabs.length) { newTab(untitledName('md'), ''); return; }
  activate(wasActive ? activeTab().id : (activeTab() || tabs[tabs.length - 1]).id);
}

function addRecent(path) {
  const list = LS.get('recent', []).filter((p) => p !== path);
  list.unshift(path);
  LS.set('recent', list.slice(0, 12));
}

/** 文件菜单里的「最近打开」：文件名当主文字，所在目录当右侧小字（只留末级目录名） */
function recentMenuItems() {
  const list = LS.get('recent', []).filter(Boolean).slice(0, 6);
  if (!list.length) return [];
  const items = list.map((p) => ({
    label: be.baseName(p) || p,
    hint: p,
    kbd: (be.dirName(p).split(/[\\/]/).pop() || '').slice(0, 16),
    action: () => openPath(p),
  }));
  items.push({ id: 'clearRecent', label: '清除记录' });
  return [{ sep: true }, { head: '最近打开' }, ...items];
}

/* ---------------- 内容读写 ---------------- */
/** 从当前视图读回内容（保证不丢编辑） */
function readEditor(t) {
  if (!t) return '';
  if (t.mode === 'wysiwyg') return wys.toMarkdown();
  if (t.mode === 'edit') return plain.value;
  return t.content;
}

function setContent(text, opts = {}) {
  const t = activeTab();
  if (!t) return;
  t.content = text;
  if (t.mode === 'wysiwyg') wys.render(text, opts.caret);
  else plain.value = text;
  schedulePreview();
  refreshStats();
  updateOutline();
  scheduleDraft();
  updateStatus();
}

function onEditorInput() {
  const t = activeTab();
  if (!t) return;
  t.content = plain.value;
  schedulePreview();
  refreshStats();
  updateOutline();
  scheduleDraft();
  scheduleAutoSave();
  updateStatus();
}

function surround(marker) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') { wys.wrapInline(marker); return; }
  if (t.mode !== 'edit') { toast('预览模式下不能编辑'); return; }
  const { from, to } = plain.selection;
  const sel = plain.selectedText;
  const next = plain.value.slice(0, from) + marker + sel + marker + plain.value.slice(to);
  setContent(next);
  plain.setSelection(from + marker.length, from + marker.length + sel.length);
  plain.focus();
}

function requireEditMode() {
  const t = activeTab();
  if (!t) return false;
  if (t.mode === 'preview') { toast('预览模式下不能编辑，请切换到编辑模式'); return false; }
  return true;
}

/** 块级格式命令只在「所见即所得」模式下有意义 */
function wysCmd(fn) {
  const t = activeTab();
  if (!t) return;
  if (t.mode !== 'wysiwyg') { toast('该操作请在「所见即所得」模式下使用'); return; }
  fn(wys);
}

/** 表格列对齐 */
function alignColumn(w, align) {
  if (!w.isInTable()) { toast('请先把光标放进表格'); return; }
  w.setColAlign(align);
  toast(align ? `本列已${{ left: '左对齐', center: '居中', right: '右对齐' }[align]}` : '本列已取消对齐');
}

/** 调整当前块缩进（列表改层级、引用改嵌套深度） */
function shiftIndent(delta) {
  wysCmd((w) => {
    const b = w.currentBlock();
    if (!b) return;
    const n = Math.max(0, Math.min(6, (+b.dataset.indent || 0) + delta));
    if (b.dataset.type === 'bq') w.setQuoteLevel(b, n);
    else if (b.dataset.type === 'li') w.setIndent(b, n);
  });
}

/** 自定大小的插入表格 */
function tablePrompt() {
  const t = activeTab();
  if (!t) return;
  if (t.mode !== 'wysiwyg') { toast('插入表格请在「所见即所得」模式下使用'); return; }
  const saved = saveRange();
  const box = document.createElement('div');
  box.innerHTML = '<div class="dlg-text">行数（含表头）与列数：</div>'
    + '<div class="dlg-row">'
    + '<input class="dlg-input" id="tblRows" value="3">'
    + '<span>行</span>'
    + '<input class="dlg-input" id="tblCols" value="3">'
    + '<span>列</span>'
    + '</div>';
  dialog({ title: '插入表格', body: box, buttons: [{ id: 'ok', label: '插入', primary: true }, { id: 'cancel', label: '取消' }] })
    .then((r) => {
      if (r !== 'ok') return;
      const rows = Math.max(1, Math.min(20, parseInt(document.getElementById('tblRows').value, 10) || 3));
      const cols = Math.max(1, Math.min(12, parseInt(document.getElementById('tblCols').value, 10) || 3));
      restoreRange(saved);
      wysCmd((w) => w.insertTable(rows, cols));
    });
  setTimeout(() => document.getElementById('tblRows')?.select(), 40);
}

/** 插入链接 */
function linkPrompt() {
  const t = activeTab();
  if (!t) return;
  if (t.mode !== 'wysiwyg') { toast('插入链接请在「所见即所得」模式下使用'); return; }
  const saved = saveRange();
  const box = document.createElement('div');
  box.innerHTML = '<div class="dlg-text">链接地址：</div><input class="dlg-input" id="linkInput" value="https://">';
  dialog({ title: '插入链接', body: box, buttons: [{ id: 'ok', label: '插入', primary: true }, { id: 'cancel', label: '取消' }] })
    .then((r) => {
      if (r !== 'ok') return;
      const v = document.getElementById('linkInput').value.trim();
      if (!v || v === 'https://') return;
      restoreRange(saved);
      wys.applyLink(v);
    });
  setTimeout(() => document.getElementById('linkInput')?.select(), 40);
}

/**
 * 插入图片。两条路：
 *   · 本地图片 → 复制到文档同目录 assets/，写相对路径（文档连 assets 一起拷走还能显示）
 *   · 网络地址 → 原样写进 src
 * 未保存的文档没有「同目录」，先让用户存盘，否则图片只能落成绝对路径，换台机器就断。
 */
async function imagePrompt() {
  const t = activeTab();
  if (!t) return;
  if (t.mode !== 'wysiwyg') { toast('插入图片请在「所见即所得」模式下使用'); return; }
  const saved = saveRange();
  const pick = await dialog({
    title: '插入图片',
    body: '本地图片会复制到文档同目录的 <b>assets/</b> 下，用相对路径引用；也可以直接给一个网络地址。',
    buttons: [
      { id: 'local', label: '选择本地图片…', primary: true },
      { id: 'url', label: '网络地址…' },
      { id: 'cancel', label: '取消' },
    ],
  });

  if (pick === 'local') {
    if (!t.path) { toast('请先保存文档，图片要放进它同目录的 assets/'); return; }
    const src = await be.pickImage();
    if (!src) return;
    try {
      const rel = await be.copyImageToAssets(src, t.path);
      restoreRange(saved);
      wys.insertImage(rel, '');
      toast('图片已复制到 assets/');
    } catch (e) {
      toast('插入失败：' + e);
    }
    return;
  }

  if (pick === 'url') {
    const box = document.createElement('div');
    box.innerHTML = '<div class="dlg-text">图片地址：</div><input class="dlg-input" id="imgInput" value="https://">';
    const ok = await dialog({ title: '图片地址', body: box, buttons: [{ id: 'ok', label: '插入', primary: true }, { id: 'cancel', label: '取消' }] });
    if (ok !== 'ok') return;
    const url = document.getElementById('imgInput').value.trim();
    if (!url || url === 'https://') return;
    restoreRange(saved);
    wys.insertImage(url, '');
  }
}

/** 把相对路径的图片引用插到当前光标：所见即所得插 <img>，编辑模式插 ![](…) */
function placeImageRef(rel) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') wys.insertImage(rel, '');
  else plain.insertText(`![](${rel})`);
}

/**
 * 剪贴板截图 / 拖进来的图片文件 → 落盘到文档同目录 assets/ → 按当前模式插入引用。
 * 未保存的文档没有「同目录」，直接提示先存盘：图片落成绝对路径换台机器就断。
 */
async function insertImageFromFile(file) {
  const t = activeTab();
  if (!t) return;
  if (!t.path) { toast('请先保存文档，图片要放进它同目录的 assets/'); return; }
  if (t.readonly) { toast('当前标签是只读的'); return; }
  try {
    const ext = (String(file.type || '').split('/')[1] || 'png').replace(/^jpeg$/, 'jpg');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rel = await be.saveImageBytes(t.path, bytes, ext);
    // 截图这类没有文件名，alt 留空即可（Markdown 里就是 ![](assets/x.png)）
    placeImageRef(rel);
    toast('图片已存入 assets/');
  } catch (e) {
    toast('插入图片失败：' + e);
  }
}

/** Ctrl/⌘+点击正文里的链接：外链交给系统浏览器，相对路径当文件打开 */
async function openExternal(href) {
  const u = String(href || '').trim();
  if (!u) return;
  if (/^(https?:|mailto:|tel:)/i.test(u)) {
    try {
      const { openUrl } = await import('../vendor/plugin-opener/dist-js/index.js');
      await openUrl(u);
    } catch { toast('无法打开链接'); }
    return;
  }
  if (u.startsWith('#')) { toast('文档内锚点暂不支持跳转'); return; }
  const t = activeTab();
  const base = t && t.path ? be.dirName(t.path) : '';
  const p = /^([a-zA-Z]:[\\/]|[\\/])/.test(u) ? u : `${base}/${u}`;
  try { await openPath(p); } catch { toast('打不开：' + p); }
}

/* ---------------- 新建文档：先选类型 ---------------- */
const NEW_TYPES = [
  { ext: 'md', name: 'Markdown', desc: '所见即所得写作' },
  { ext: 'txt', name: '纯文本', desc: '记事 / 日志' },
  { ext: 'json', name: 'JSON', desc: '校验 + 高亮' },
  { ext: 'csv', name: 'CSV', desc: '表格文本' },
  { ext: 'js', name: 'JavaScript', desc: '代码高亮' },
  { ext: 'ts', name: 'TypeScript' },
  { ext: 'py', name: 'Python' },
  { ext: 'html', name: 'HTML' },
  { ext: 'css', name: 'CSS' },
  { ext: 'sh', name: 'Shell 脚本' },
];

/** 新建文档的名字：连开三个不该都叫「未命名.md」——重名时依次加序号 */
function untitledName(ext) {
  return freeUntitledName(tabs.map((t) => t.name), ext);
}

/** 建一个空文档。非 Markdown 的类型只会开放编辑 / 预览两种模式（普通编辑器）。 */
function createNew(ext = 'md') {
  settings.lastNewExt = ext;
  saveSettings();
  newTab(untitledName(ext), '');
}

/** 新建入口：类型网格，点一下直接开，回车默认上次用过的类型 */
async function newFilePrompt() {
  const box = document.createElement('div');
  box.className = 'new-types';
  const last = settings.lastNewExt || 'md';
  NEW_TYPES.forEach((ty) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'new-type' + (ty.ext === last ? ' active' : '');
    b.dataset.dialogClose = ty.ext;
    b.innerHTML = `<b>${ty.name}</b><small>.${ty.ext}${ty.desc ? ' · ' + ty.desc : ''}</small>`;
    box.appendChild(b);
  });
  const picked = await dialog({
    title: '新建文档',
    body: box,
    buttons: [
      { id: last, label: `新建 ${NEW_TYPES.find((t) => t.ext === last)?.name || 'Markdown'}`, primary: true },
      { id: 'cancel', label: '取消' },
    ],
  });
  if (!picked || picked === 'cancel') return;
  createNew(picked);
}

/* 对话框会抢走焦点，动手前把编辑区选区存下来 */
function saveRange() {
  const sel = window.getSelection();
  return sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
}

function restoreRange(r) {
  if (!r) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 对全文或选区做整段替换的通用入口 */
function transformText(fn, label) {
  const t = activeTab();
  if (!t || !requireEditMode()) return;
  if (t.mode === 'wysiwyg') {
    const md = wys.toMarkdown();
    setContent(fn(md));
    wys.render(fn(md));
    toast(`${label}已应用`);
    updateStatus();
    return;
  }
  const { from: s, to: e } = plain.selection;
  const hasSel = e > s;
  const content = plain.value;
  const target = hasSel ? content.slice(s, e) : content;
  const backup = content;
  const out = fn(target);
  const next = hasSel ? content.slice(0, s) + out + content.slice(e) : out;
  if (next === backup) { toast('内容没有变化'); return; }
  setContent(next);
  if (hasSel) plain.setSelection(s, s + out.length);
  undoToast(`${label}已应用（${hasSel ? '选区' : '全文'}）`, backup);
}

function formatDoc() {
  const t = activeTab();
  if (!t || !requireEditMode()) return;
  t.content = readEditor(t);
  const kind = detectKind(t.name);
  const backup = t.content;
  try {
    const r = formatByKind(kind, t.content);
    if (r.text === t.content) { toast('已经是最佳格式，无需调整'); return; }
    setContent(r.text);
    const notes = r.notes && r.notes.length ? `（${r.notes.join('、')}）` : '';
    undoToast(`已格式化${notes}`, backup);
  } catch (e) {
    const loc = e.line ? `第 ${e.line} 行第 ${e.col} 列` : '';
    dialog({ title: '无法格式化', body: `文件中存在语法错误，已保持原样。<br><br><b>${loc}</b><br><span style="font-family:var(--font-mono);font-size:12px">${String(e.message)}</span>` });
    if (e.line) gotoLine(e.line - 1);
  }
}

function undoToast(msg, backup) {
  const wrap = document.getElementById('toasts');
  const box = document.createElement('div');
  box.className = 'toast';
  box.style.cssText = 'display:flex;align-items:center;gap:12px;pointer-events:auto';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.textContent = '撤销';
  btn.style.cssText = 'border:none;background:var(--accent);color:#fff;border-radius:12px;padding:2px 10px;font-size:11.5px;cursor:pointer';
  btn.onclick = () => { setContent(backup); box.remove(); toast('已撤销'); };
  box.append(span, btn);
  wrap.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 300); }, 6000);
}

/* ---------------- 查找替换 ---------------- */
const find = { matches: [], index: 0 };

function openFind(withReplace = false) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') {
    // WYSIWYG 下查找需要回到编辑模式，避免两套逻辑打架
    toast('已切换到编辑模式以使用查找替换');
    setMode('edit', { fromActivate: true });
  }
  el.findbar.classList.remove('hidden');
  $('replaceInput').classList.toggle('hidden', !withReplace);
  $('findReplaceOne').classList.toggle('hidden', !withReplace);
  $('findReplaceAll').classList.toggle('hidden', !withReplace);
  const sel = plain.selectedText;
  if (sel && !sel.includes('\n')) $('findInput').value = sel;
  $('findInput').focus();
  $('findInput').select();
  runFind();
}

function buildRegex() {
  const q = $('findInput').value;
  if (!q) return null;
  const flags = 'g' + ($('findCase').checked ? '' : 'i');
  if ($('findRegex').checked) {
    try { return new RegExp(q, flags); } catch { return null; }
  }
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

function runFind() {
  const t = activeTab();
  const re = buildRegex();
  find.matches = [];
  if (!t || !re) { $('findCount').textContent = '0/0'; return; }
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(t.content))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    find.matches.push([m.index, m.index + m[0].length]);
    if (find.matches.length > 5000) break;
  }
  const pos = plain.selection.from;
  const idx = find.matches.findIndex(([a]) => a >= pos);
  find.index = idx < 0 ? 0 : idx;
  $('findCount').textContent = `${find.matches.length ? find.index + 1 : 0}/${find.matches.length}`;
  if (find.matches.length) locateMatch();
}

function locateMatch() {
  const t = activeTab();
  const [a, b] = find.matches[find.index] || [];
  if (a == null || !t) return;
  plain.revealOffset(a, b);
  updateStatus();
}

function findStep(dir) {
  if (!find.matches.length) { runFind(); return; }
  find.index = (find.index + dir + find.matches.length) % find.matches.length;
  $('findCount').textContent = `${find.index + 1}/${find.matches.length}`;
  locateMatch();
}

function replaceOne() {
  const t = activeTab();
  if (!t || !find.matches.length) return;
  const [a, b] = find.matches[find.index];
  const rep = $('replaceInput').value;
  setContent(t.content.slice(0, a) + rep + t.content.slice(b));
  runFind();
}

function replaceAll() {
  const t = activeTab();
  const re = buildRegex();
  if (!t || !re) return;
  const rep = $('replaceInput').value;
  let n = 0;
  const next = t.content.replace(re, () => (n++, rep));
  if (!n) { toast('没有找到匹配项'); return; }
  setContent(next);
  toast(`已替换 ${n} 处`);
  runFind();
}

function closeFind() { el.findbar.classList.add('hidden'); }

/** 拖进来的图片文件：走「复制到 assets」那条路，和「插入图片」对话框一致 */
async function insertImageFromPath(p) {
  const t = activeTab();
  if (!t) return false;
  if (!t.path) { toast('请先保存文档，图片要放进它同目录的 assets/'); return true; }
  try {
    const rel = await be.copyImageToAssets(p, t.path);
    placeImageRef(rel);
    toast('图片已存入 assets/');
  } catch (e) {
    toast('插入图片失败：' + e);
  }
  return true;
}

/* ---------------- 拖拽 / 分栏 ---------------- */
function setupDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault();
  });
  import('../vendor/api/webview.js').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent(async (ev) => {
      if (ev.payload && ev.payload.type === 'drop') {
        // 图片拖进窗口的意图是「插到文档里」，不是「打开它」——按扩展名分流
        for (const p of ev.payload.paths) {
          if (be.isImagePath(p)) await insertImageFromPath(p);
          else await openPath(p);
        }
      }
    });
  }).catch(() => {});
}

function setupSplitters() {
  let dragging = null;
  el.mid.addEventListener('mousedown', (e) => { dragging = 'mid'; e.preventDefault(); });
  el.outlineSplitter.addEventListener('mousedown', (e) => { dragging = 'outline'; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    document.body.style.cursor = 'col-resize';
    if (dragging === 'outline') {
      el.outlinePane.style.width = Math.max(140, Math.min(420, e.clientX)) + 'px';
    } else {
      const ws = el.workspace.getBoundingClientRect();
      const w = Math.max(240, ws.right - e.clientX);
      el.previewPane.style.flex = `0 0 ${w}px`;
    }
  });
  window.addEventListener('mouseup', () => { dragging = null; document.body.style.cursor = ''; });
  el.mid.addEventListener('dblclick', () => { el.previewPane.style.flex = '1'; });
}

/* ---------------- 其它命令 ---------------- */
function zoom(d) {
  settings.fontSize = Math.max(11, Math.min(24, Math.round((settings.fontSize + d) * 2) / 2));
  saveSettings();
  applyFont();
}

function applyFont() {
  const s = settings.fontSize;
  document.documentElement.style.setProperty('--fs-editor', s + 'px');
  el.preview.style.fontSize = s + 1.5 + 'px';
  el.wysiwyg.style.fontSize = s + 1.5 + 'px';
  refreshStats();
}

function gotoLinePrompt() {
  const t = activeTab();
  if (!t) return;
  const total = t.content.split('\n').length;
  const box = document.createElement('div');
  box.innerHTML = `<div class="dlg-text">跳到第几行（1 – ${total}）：</div>
    <input class="dlg-input" id="gotoInput" value="1">`;
  dialog({ title: '跳转到行', body: box, buttons: [{ id: 'ok', label: '跳转', primary: true }, { id: 'cancel', label: '取消' }] })
    .then((r) => {
      if (r !== 'ok') return;
      const n = parseInt(document.getElementById('gotoInput').value, 10);
      if (n >= 1) gotoLine(n - 1);
    });
  setTimeout(() => document.getElementById('gotoInput')?.select(), 40);
}

function cycleEol() {
  const t = activeTab();
  if (!t) return;
  t.eol = t.eol === 'LF' ? 'CRLF' : 'LF';
  el.stEOL.textContent = t.eol;
  toast(`换行符：${t.eol}（保存时生效）`);
}

function changeEncoding() {
  const t = activeTab();
  if (!t) return;
  const box = document.createElement('div');
  box.innerHTML = `<div class="dlg-text">当前编码：<b>${t.encoding}</b>${t.bom ? '（含 BOM）' : ''}</div>
    <div class="dlg-label">以其它编码重新解读当前文件</div>
    <div class="dlg-row">${['UTF-8', 'GBK', 'UTF-16LE'].map((e) => `<button class="mini" data-reopen="${e}" ${t.path ? '' : 'disabled'}>按 ${e} 重新打开</button>`).join('')}</div>
    <div class="dlg-label">保存时使用编码</div>
    <div class="dlg-row">${['UTF-8', 'GBK', 'UTF-16LE'].map((e) => `<button class="mini${e === t.encoding ? ' primary' : ''}" data-saveenc="${e}">${e}</button>`).join('')}</div>
    <label class="chk" style="margin-top:14px;display:flex"><input type="checkbox" id="bomChk" ${t.bom ? 'checked' : ''}> 保存时写入 BOM</label>`;
  dialog({ title: '文件编码', body: box, buttons: [{ id: 'cancel', label: '关闭' }] });
  setTimeout(() => {
    $('dlgBody').querySelectorAll('[data-saveenc]').forEach((b) => {
      b.onclick = () => {
        t.encoding = b.dataset.saveenc;
        t.bom = $('bomChk').checked;
        el.stEncoding.textContent = t.encoding + (t.bom ? ' BOM' : '');
        $('dlgOverlay').classList.add('hidden');
        toast(`保存编码：${t.encoding}，保存后生效`);
      };
    });
    $('dlgBody').querySelectorAll('[data-reopen]').forEach((b) => {
      b.onclick = async () => {
        const enc = b.dataset.reopen;
        try {
          const r = await be.readTextAs(t.path, enc);
          setContent(r);
          t.encoding = enc;
          t.bom = false;
          el.stEncoding.textContent = enc;
          $('dlgOverlay').classList.add('hidden');
          toast(`已按 ${enc} 重新解读`);
        } catch (e) { toast('重新解读失败'); }
      };
    });
  }, 30);
}

async function reloadCurrent() {
  const t = activeTab();
  if (!t || !t.path) { toast('当前标签没有对应文件'); return; }
  if (isDirty(t) && !(await confirmBox('重新载入', '当前有未保存的修改，重新载入会丢弃它们。继续？'))) return;
  const r = await be.readText(t.path);
  t.encoding = r.encoding;
  t.eol = r.eol;
  t.bom = r.bom;
  setContent(r.content);
  t.savedContent = r.content;
  updateStatus();
  toast('已重新载入');
}

function showWordCount() {
  const t = activeTab();
  if (!t) return;
  const text = readEditor(t) || t.content;
  const chars = text.length;
  const noSpace = text.replace(/\s/g, '').length;
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
  const lines = text.split('\n').length;
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const minutes = Math.max(1, Math.ceil(cjk / 350 + words / 200));
  dialog({
    title: '字数统计',
    body: `<table class="kbd-table">
      <tr><td>行数</td><td>${lines}</td></tr>
      <tr><td>段落</td><td>${paras}</td></tr>
      <tr><td>字符（含空格）</td><td>${chars}</td></tr>
      <tr><td>字符（不含空格）</td><td>${noSpace}</td></tr>
      <tr><td>中文汉字</td><td>${cjk}</td></tr>
      <tr><td>英文单词</td><td>${words}</td></tr>
      <tr><td>预计阅读</td><td>约 ${minutes} 分钟</td></tr>
    </table>`,
  });
}

function showAbout() {
  dialog({
    title: '关于 简单记事本',
    body: `<div class="dlg-text">
      <p style="margin-top:0"><b>简单记事本</b> · 版本 1.0.0</p>
      <p>把 Markdown 预览、文本对比、记事本读写，做成一个 10MB 以内、免安装、不联网的小工具。</p>
      <p style="color:var(--fg-faint);font-size:12px">文件只在本机读写，不向任何服务器发送内容。</p>
    </div>`,
  });
}

/* ---------------- 自绘菜单 / 窗口按钮 ---------------- */
/** 当前可编辑元素：所见即所得是 contenteditable，纯文本是 CM6 的容器 */
function editTarget() {
  const t = activeTab();
  if (t && t.mode === 'wysiwyg') return el.wysiwyg;
  return el.editor;
}

/**
 * 编辑命令分派。
 * 所见即所得没有撤销栈，走 execCommand；纯文本走 CM6 自己的 history，
 * 它的撤销粒度比浏览器的 contenteditable 靠得住得多。
 */
function editCmd(cmd) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') {
    el.wysiwyg.focus();
    try { document.execCommand(cmd); } catch {}
    return;
  }
  if (t.mode !== 'edit') { toast('预览模式下不能编辑'); return; }
  switch (cmd) {
    case 'undo': plain.undo(); break;
    case 'redo': plain.redo(); break;
    case 'selectAll': plain.selectAll(); break;
    default:
      // cut / copy / paste 交给浏览器：CM6 的 contenteditable 会接管这些剪贴板事件
      plain.focus();
      try { document.execCommand(cmd); } catch {}
  }
}

async function pasteFromClipboard() {
  const t = activeTab();
  if (!t) return;
  const inWys = t.mode === 'wysiwyg';
  if (inWys) el.wysiwyg.focus();
  else plain.focus();
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast('剪贴板是空的'); return; }
    if (inWys) document.execCommand('insertText', false, text);
    else plain.insertText(text);
  } catch {
    toast('请按 Ctrl+V 粘贴');
  }
}

function setTheme(mode) {
  settings.theme = mode;
  saveSettings();
  applyTheme();
}

/* ---------------- 命令表 ---------------- */
const commands = {
  new: newFilePrompt,
  open: openFileDialog,
  save: () => saveTab(),
  saveAs: () => saveTabAs(activeTab()),
  closeTab: () => activeTab() && closeTab(activeTab().id),
  quit: async () => {
    persistCurrentView();
    saveDraft();
    await win.closeWindow();
  },
  undo: () => editCmd('undo'),
  redo: () => editCmd('redo'),
  cut: () => editCmd('cut'),
  copy: () => editCmd('copy'),
  paste: pasteFromClipboard,
  selectAll: () => editCmd('selectAll'),
  exportPdf,
  print: () => printTab(activeTab()),
  find: () => openFind(false),
  replace: () => openFind(true),
  gotoLine: gotoLinePrompt,
  bold: () => surround('**'),
  italic: () => surround('_'),
  inlineCode: () => surround('`'),
  strike: () => surround('~~'),
  format: formatDoc,

  /* —— 块级格式（仅所见即所得模式） —— */
  body: () => wysCmd((w) => w.toggleHeading(0)),
  h1: () => wysCmd((w) => w.toggleHeading(1)),
  h2: () => wysCmd((w) => w.toggleHeading(2)),
  h3: () => wysCmd((w) => w.toggleHeading(3)),
  ul: () => wysCmd((w) => w.toggleList('ul')),
  ol: () => wysCmd((w) => w.toggleList('ol')),
  taskList: () => wysCmd((w) => w.toggleList('task')),
  quote: () => wysCmd((w) => w.insertBlock('quote')),
  codeBlock: () => wysCmd((w) => w.insertBlock('code')),
  hr: () => wysCmd((w) => w.insertBlock('hr')),
  table: () => wysCmd((w) => w.insertTable(3, 3)),
  tablePrompt,
  image: imagePrompt,
  indentIn: () => shiftIndent(1),
  indentOut: () => shiftIndent(-1),
  link: linkPrompt,
  tableRowAbove: () => wysCmd((w) => w.tableCommand('rowAbove')),
  tableRowBelow: () => wysCmd((w) => w.tableCommand('rowBelow')),
  tableColBefore: () => wysCmd((w) => w.tableCommand('colBefore')),
  tableColAfter: () => wysCmd((w) => w.tableCommand('colAfter')),
  tableDelRow: () => wysCmd((w) => w.tableCommand('delRow')),
  tableDelCol: () => wysCmd((w) => w.tableCommand('delCol')),
  tableDel: () => wysCmd((w) => w.tableCommand('delTable')),
  tableAlignLeft: () => wysCmd((w) => alignColumn(w, 'left')),
  tableAlignCenter: () => wysCmd((w) => alignColumn(w, 'center')),
  tableAlignRight: () => wysCmd((w) => alignColumn(w, 'right')),
  tableAlignNone: () => wysCmd((w) => alignColumn(w, '')),
  toggleTheme: () => {
    settings.theme = settings.theme === 'auto' ? 'light' : settings.theme === 'light' ? 'dark' : 'auto';
    saveSettings();
    applyTheme();
    toast(`主题：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[settings.theme]}`);
  },
  themeAuto: () => setTheme('auto'),
  themeLight: () => setTheme('light'),
  themeDark: () => setTheme('dark'),
  toggleLayout: () => setLayout(settings.layout === 'split' ? 'single' : 'split'),
  layoutSingle: () => setLayout('single'),
  layoutSplit: () => setLayout('split'),
  toggleOutline: () => {
    settings.outlineVisible = !settings.outlineVisible;
    saveSettings();
    updateOutline();
  },
  toggleToolbar: () => {
    settings.showToolbar = !settings.showToolbar;
    saveSettings();
    document.getElementById('toolbar').classList.toggle('hidden', !settings.showToolbar);
  },
  toggleWinTitle: () => {
    settings.showWinTitle = settings.showWinTitle === false;
    saveSettings();
    refreshTitle();
  },
  fullscreen: async () => {
    const on = await win.toggleFullscreen();
    if (on) toast('已进入全屏，按 F11 退出');
  },
  zoomIn: () => zoom(1),
  zoomOut: () => zoom(-1),
  zoomReset: () => { settings.fontSize = 13.5; saveSettings(); applyFont(); },
  setMode,
  modeWysiwyg: () => setMode('wysiwyg', { fromActivate: true }),
  modeEdit: () => setMode('edit', { fromActivate: true }),
  modePreview: () => setMode('preview', { fromActivate: true }),
  textCompare: () => diff.openText(),
  folderCompare: () => diff.openFolder(),
  merge: () => merge.open(),
  wordCount: showWordCount,
  reload: reloadCurrent,
  autoSave: () => {
    settings.autoSave = !settings.autoSave;
    saveSettings();
    toast(settings.autoSave ? '自动保存已开启：改动停下约 1 秒就写盘' : '自动保存已关闭');
  },
  clearRecent: () => { LS.del('recent'); toast('已清除最近记录'); },
  shortcuts: showShortcuts,
  about: showAbout,
  encoding: changeEncoding,
  eol: cycleEol,
  sortAsc: () => transformText(lineOps.sortAsc, '升序排序'),
  sortDesc: () => transformText(lineOps.sortDesc, '降序排序'),
  sortNum: () => transformText(lineOps.sortNum, '按数字排序'),
  dedupe: () => transformText(lineOps.dedupe, '去重'),
  removeEmpty: () => transformText(lineOps.removeEmpty, '删除空行'),
  trimLines: () => transformText(lineOps.trimLines, '去除首尾空白'),
  upper: () => transformText(caseOps.upper, '转大写'),
  lower: () => transformText(caseOps.lower, '转小写'),
  title: () => transformText(caseOps.title, '首字母大写'),
};

/* ---------------- 菜单结构（自绘标题栏用） ---------------- */
const hasTab = () => !!activeTab();
const markMode = (m) => () => !!(activeTab() && activeTab().mode === m);
const canWys = () => !!(activeTab() && activeTab().mode === 'wysiwyg');
const inTable = () => canWys() && wys.isInTable();
const wysOnly = () => !canWys();

/** 光标所在块的标题级别：0=正文，1~3=标题；
 *  光标在列表 / 引用 / 代码块 / 表格里时返回 -2（既不是正文也不是标题，四个都不点亮）；
 *  不在所见即所得模式返回 -1 */
const headingLevel = () => {
  if (!canWys()) return -1;
  const b = wys.currentBlock();
  if (!b) return 0;
  if (b.classList.contains('w-h')) {
    return parseInt(String(b.dataset.type || 'h1').replace('h', ''), 10) || 1;
  }
  return b.dataset.type === 'p' ? 0 : -2;
};

/* 表格命令只在光标进了表格之后才需要 —— 全塞进菜单会让它常年长着一截
   用不上的灰项，所以统一用这个判断把它们藏起来（不是变灰，是根本不出现） */
const noTable = () => !inTable();

const MENU_TREE = [
  {
    label: '文件',
    /* 每次展开都重算：最近打开是动态的，固定数组会永远停在打开那一刻的样子 */
    items: () => [
      { id: 'new', label: '新建', kbd: 'Ctrl+N' },
      { id: 'open', label: '打开…', kbd: 'Ctrl+O' },
      ...recentMenuItems(),
      { sep: true },
      { id: 'save', label: '保存', kbd: 'Ctrl+S', disabled: () => !hasTab() },
      { id: 'saveAs', label: '另存为…', kbd: 'Ctrl+Shift+S', disabled: () => !hasTab() },
      { id: 'autoSave', label: '自动保存（约 1 秒）', checked: () => !!settings.autoSave },
      { sep: true },
      { id: 'exportPdf', label: '导出 PDF / 打印…', kbd: 'Ctrl+P', disabled: () => !hasTab() },
      { id: 'reload', label: '重新载入', disabled: () => !hasTab() },
      { sep: true },
      { id: 'closeTab', label: '关闭标签', kbd: 'Ctrl+W', disabled: () => !hasTab() },
      { sep: true },
      { id: 'quit', label: '退出' },
    ],
  },
  {
    label: '编辑',
    items: [
      { id: 'undo', label: '撤销', kbd: 'Ctrl+Z', disabled: () => !hasTab() },
      { id: 'redo', label: '重做', kbd: 'Ctrl+Y', disabled: () => !hasTab() },
      { sep: true },
      { id: 'cut', label: '剪切', kbd: 'Ctrl+X', disabled: () => !hasTab() },
      { id: 'copy', label: '复制', kbd: 'Ctrl+C', disabled: () => !hasTab() },
      { id: 'paste', label: '粘贴', kbd: 'Ctrl+V', disabled: () => !hasTab() },
      { id: 'selectAll', label: '全选', kbd: 'Ctrl+A', disabled: () => !hasTab() },
      { sep: true },
      { id: 'find', label: '查找…', kbd: 'Ctrl+F' },
      { id: 'replace', label: '替换…', kbd: 'Ctrl+H' },
      { id: 'gotoLine', label: '跳转到行…', kbd: 'Ctrl+G', disabled: () => !hasTab() },
    ],
  },
  {
    label: '格式',
    items: [
      /* 四级别是互斥的单选题，横排一行：比竖着占 4 行省地方，
         而且当前级别一目了然（这是竖向文字菜单做不到的） */
      { head: '标题级别' },
      { row: [
        { id: 'body', label: '正文', hint: '正文（取消标题）', kbd: 'Ctrl+Alt+0', disabled: wysOnly, checked: () => headingLevel() === 0 },
        { id: 'h1', label: 'H1', hint: '一级标题', kbd: 'Ctrl+Alt+1', disabled: wysOnly, checked: () => headingLevel() === 1 },
        { id: 'h2', label: 'H2', hint: '二级标题', kbd: 'Ctrl+Alt+2', disabled: wysOnly, checked: () => headingLevel() === 2 },
        { id: 'h3', label: 'H3', hint: '三级标题', kbd: 'Ctrl+Alt+3', disabled: wysOnly, checked: () => headingLevel() === 3 },
      ] },
      { note: '标题与列表只在所见即所得模式下可用，Ctrl + 1 切换', hidden: () => canWys() },

      { head: '文字' },
      { id: 'bold', label: '加粗', icon: 'bold', kbd: 'Ctrl+B', disabled: () => !hasTab() },
      { id: 'italic', label: '斜体', icon: 'italic', kbd: 'Ctrl+I', disabled: () => !hasTab() },
      { id: 'strike', label: '删除线', icon: 'strikethrough', kbd: 'Ctrl+Shift+X', disabled: () => !hasTab() },
      { id: 'inlineCode', label: '行内代码', icon: 'code', disabled: () => !hasTab() },

      { head: '段落' },
      { id: 'ul', label: '无序列表', icon: 'list', kbd: 'Ctrl+Shift+8', disabled: wysOnly },
      { id: 'ol', label: '有序列表', icon: 'list-ordered', kbd: 'Ctrl+Shift+7', disabled: wysOnly },
      { id: 'taskList', label: '任务列表', icon: 'list-todo', kbd: 'Ctrl+Shift+9', disabled: wysOnly },
      { id: 'quote', label: '引用', icon: 'text-quote', kbd: 'Ctrl+Shift+Q', disabled: wysOnly },
      { id: 'codeBlock', label: '代码块', icon: 'square-code', kbd: 'Ctrl+Shift+K', disabled: wysOnly },
      { id: 'indentIn', label: '增加缩进', icon: 'indent-increase', kbd: 'Tab', disabled: wysOnly },
      { id: 'indentOut', label: '减少缩进', icon: 'indent-decrease', kbd: 'Shift+Tab', disabled: wysOnly },
    ],
  },
  {
    /* 「加东西」和「改样子」本来就是两件事，混在一个菜单里 38 项谁都得找半天。
       拆出去之后：格式 15 项、插入 6 项，各自一屏看完 */
    label: '插入',
    items: [
      { id: 'link', label: '链接…', icon: 'link', kbd: 'Ctrl+K', disabled: wysOnly },
      { id: 'image', label: '图片…', icon: 'image', disabled: wysOnly },
      { sep: true },
      { id: 'table', label: '表格 3 × 3', icon: 'table', kbd: 'Ctrl+Shift+T', disabled: wysOnly },
      { id: 'tablePrompt', label: '表格（自定大小）…', icon: 'table', disabled: wysOnly },
      { id: 'hr', label: '分割线', icon: 'minus', disabled: wysOnly },
      /* 增删行列、调对齐这些「改已有表格」的操作不再占菜单位置：
         右键菜单里本来就有一整套，同一个命令没必要在两个地方各列一遍。
         这里只在光标真的进了表格时提一句，省得有人找不到 */
      { note: '光标在表格内右键，可增删行列、调整对齐', hidden: noTable },
    ],
  },
  {
    label: '视图',
    items: [
      { id: 'modeWysiwyg', label: '所见即所得', kbd: 'Ctrl+1', checked: markMode('wysiwyg'), disabled: () => !hasTab() },
      { id: 'modeEdit', label: '编辑模式', kbd: 'Ctrl+2', checked: markMode('edit'), disabled: () => !hasTab() },
      { id: 'modePreview', label: '预览模式', kbd: 'Ctrl+3', checked: markMode('preview'), disabled: () => !hasTab() },
      { sep: true },
      { id: 'layoutSingle', label: '单栏', kbd: 'Ctrl+Shift+L', checked: () => settings.layout === 'single' },
      { id: 'layoutSplit', label: '双栏', checked: () => settings.layout === 'split' },
      { sep: true },
      { id: 'toggleOutline', label: '显示大纲', kbd: 'Ctrl+Shift+O', checked: () => settings.outlineVisible },
      { id: 'toggleToolbar', label: '显示快捷按钮', checked: () => settings.showToolbar !== false },
      { id: 'toggleWinTitle', label: '标题栏显示文件名', checked: () => settings.showWinTitle !== false },
      { sep: true },
      { id: 'zoomIn', label: '放大', kbd: 'Ctrl+=' },
      { id: 'zoomOut', label: '缩小', kbd: 'Ctrl+-' },
      { id: 'zoomReset', label: '实际大小', kbd: 'Ctrl+0' },
      { sep: true },
      { id: 'themeAuto', label: '主题：跟随系统', checked: () => settings.theme === 'auto' },
      { id: 'themeLight', label: '主题：浅色', checked: () => settings.theme === 'light' },
      { id: 'themeDark', label: '主题：深色', checked: () => settings.theme === 'dark' },
      { sep: true },
      { id: 'fullscreen', label: '全屏', kbd: 'F11' },
    ],
  },
  {
    label: '工具',
    items: [
      { id: 'format', label: '一键格式化', kbd: 'Ctrl+Shift+F', disabled: () => !hasTab() },
      { sep: true },
      { id: 'sortAsc', label: '按行升序排序', disabled: () => !hasTab() },
      { id: 'sortDesc', label: '按行降序排序', disabled: () => !hasTab() },
      { id: 'sortNum', label: '按数字排序', disabled: () => !hasTab() },
      { id: 'dedupe', label: '去除重复行', disabled: () => !hasTab() },
      { id: 'removeEmpty', label: '删除空行', disabled: () => !hasTab() },
      { id: 'trimLines', label: '去除首尾空白', disabled: () => !hasTab() },
      { sep: true },
      { id: 'upper', label: '转大写', disabled: () => !hasTab() },
      { id: 'lower', label: '转小写', disabled: () => !hasTab() },
      { id: 'title', label: '首字母大写', disabled: () => !hasTab() },
      { sep: true },
      { id: 'textCompare', label: '文本对比…', kbd: 'Ctrl+D' },
      { id: 'folderCompare', label: '文件夹对比…' },
      { id: 'merge', label: '三向合并…' },
      { sep: true },
      { id: 'wordCount', label: '字数统计', disabled: () => !hasTab() },
      { id: 'encoding', label: '文件编码…', disabled: () => !hasTab() },
      { id: 'eol', label: '切换换行符', disabled: () => !hasTab() },
    ],
  },
  {
    label: '帮助',
    items: [
      { id: 'shortcuts', label: '快捷键一览' },
      { id: 'about', label: '关于 简单记事本' },
    ],
  },
];

function setupAppMenu() {
  if (!el.menubar) return;
  createAppMenu({
    bar: el.menubar,
    menus: MENU_TREE,
    run: (id) => { const fn = commands[id]; if (fn) fn(); },
  });
}

/* ---------------- 行首块手柄：+ 插入 / ⋮⋮ 换块类型 ----------------
   手柄挂在 .edit-wrap 上、在 contenteditable 之外，所以浏览器选不中它、
   退格删不到它、sweepBlock 也不会把它吸进正文。
   两张菜单都不含新逻辑：执行一律走 commands 表，和顶栏菜单同一条路。 */

const svgIco = (n) => `<svg class="ico" aria-hidden="true"><use href="#i-${n}" /></svg>`;

const BLOCK_KINDS = [
  { id: 'body', label: '正文段落', icon: 'type' },
  { id: 'h1', label: '标题 1', icon: 'type' },
  { id: 'h2', label: '标题 2', icon: 'type' },
  { id: 'h3', label: '标题 3', icon: 'type' },
  { id: 'ul', label: '无序列表', icon: 'list-tree' },
  { id: 'ol', label: '有序列表', icon: 'list-tree' },
  { id: 'taskList', label: '任务列表', icon: 'check' },
  { id: 'quote', label: '引用', icon: 'type' },
  { id: 'codeBlock', label: '代码块', icon: 'code' },
];

/** 插入类：这几件事自己知道往哪插，不用先造空块 */
const BLOCK_INSERTS = [
  { id: 'table', label: '表格（3 × 3）', icon: 'square' },
  { id: 'tablePrompt', label: '表格（自定大小）…', icon: 'square' },
  { id: 'image', label: '图片…', icon: 'image' },
  { id: 'link', label: '链接…', icon: 'arrow-left-right' },
  { id: 'hr', label: '分割线', icon: 'minus' },
];
const SELF_INSERTING = new Set(['table', 'tablePrompt', 'image', 'link', 'hr']);

let hoverBlock = null;
let handleBlock = null;
let handleBusy = false;      // 鼠标在手柄 / 菜单上，别自动收起
let handleTimer = 0;
let bmMode = 'convert';

const isWysMode = () => !!activeTab() && activeTab().mode === 'wysiwyg';

/** 块当前是什么类型，用来在「转换」菜单里打勾 */
function kindOfBlock(b) {
  const t = b.dataset.type;
  if (t === 'li') return b.dataset.list === 'task' ? 'taskList' : (b.dataset.list === 'ol' ? 'ol' : 'ul');
  if (t === 'bq') return 'quote';
  if (t === 'code') return 'codeBlock';
  if (t === 'p') return 'body';
  if (/^h[1-6]$/.test(t)) return t;         // h4~h6 没有对应菜单项，只是不点亮
  return '';
}

function placeHandle(block) {
  if (!block || !block.isConnected || !block.classList.contains('w-block')) return hideHandle();
  if (block.dataset.type === 'hr') return hideHandle();
  const host = el.editWrap.getBoundingClientRect();
  const r = block.getBoundingClientRect();
  if (r.bottom < host.top + 4 || r.top > host.bottom - 4) return hideHandle();
  handleBlock = block;
  el.wHandle.classList.remove('hidden');
  // 贴着首行：块可能是多行，手柄只对齐第一行
  el.wHandle.style.top = Math.round(Math.max(2, r.top - host.top + 2)) + 'px';
  el.wHandle.style.left = Math.round(Math.max(2, r.left - host.left - 45)) + 'px';
}

function hideHandle() {
  handleBlock = null;
  if (!handleBusy) el.wHandle.classList.add('hidden');
}

function refreshHandle() {
  if (!isWysMode()) { hideHandle(); return; }
  const target = hoverBlock || wys.currentBlock();
  if (target) placeHandle(target); else hideHandle();
}

function openBlockMenu(mode) {
  if (!handleBlock) return;
  const box = el.wBlockMenu;
  // 同一个按钮再点一次 = 收起
  if (!box.classList.contains('hidden') && bmMode === mode) { closeBlockMenu(); return; }
  bmMode = mode;
  handleBusy = true;
  box.innerHTML = '';
  box.classList.remove('hidden');

  const head = (t) => {
    const d = document.createElement('div');
    d.className = 'bm-head';
    d.textContent = t;
    box.appendChild(d);
  };
  const sep = () => {
    const d = document.createElement('div');
    d.className = 'bm-sep';
    box.appendChild(d);
  };
  const item = (it, checked) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bm-item' + (checked ? ' checked' : '');
    b.innerHTML = svgIco(it.icon || 'type') + `<span>${it.label}</span>`;
    b.addEventListener('mousedown', (e) => e.preventDefault());   // 保住编辑区选区
    b.onclick = () => bmRun(it.id);
    box.appendChild(b);
  };

  const cur = mode === 'convert' ? kindOfBlock(handleBlock) : '';
  head(mode === 'insert' ? '在下方插入' : '转换这一块');
  BLOCK_KINDS.forEach((it) => item(it, it.id === cur));
  if (mode === 'insert') {
    sep();
    head('插入');
    BLOCK_INSERTS.forEach((it) => item(it, false));
  }

  // 贴着按钮展开；右边放不下就翻到左边，下边放不下就往上收
  const hr = el.wHandle.getBoundingClientRect();
  const mw = box.offsetWidth || 198;
  const mh = box.offsetHeight || 280;
  let left = hr.right + 4;
  let top = hr.top - 5;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, hr.left - mw - 4);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
  box.style.left = Math.round(left) + 'px';
  box.style.top = Math.round(top) + 'px';
  el.whMenu.classList.add('open');
}

function closeBlockMenu() {
  el.wBlockMenu.classList.add('hidden');
  el.wBlockMenu.innerHTML = '';
  el.whMenu.classList.remove('open');
  handleBusy = false;
}

function bmRun(id) {
  const block = handleBlock;
  const mode = bmMode;
  closeBlockMenu();
  if (!block || !block.isConnected) return;
  if (mode === 'insert') {
    if (SELF_INSERTING.has(id)) {
      wys.focusBlock(block, true);
      commands[id]?.();
    } else {
      const nb = wys.insertEmptyAfter(block);
      wys.focusBlock(nb);
      if (id !== 'body') commands[id]?.();
    }
  } else {
    wys.focusBlock(block);
    commands[id]?.();
  }
  clearTimeout(handleTimer);
  handleTimer = setTimeout(() => { hoverBlock = null; refreshHandle(); }, 0);
}

function setupBlockHandle() {
  if (!el.wHandle) return;
  el.wysiwyg.addEventListener('mousemove', (e) => {
    if (!isWysMode()) return;
    if (!el.wBlockMenu.classList.contains('hidden')) closeBlockMenu();
    const b = e.target.closest ? e.target.closest('.w-block') : null;
    if (b === hoverBlock) return;
    hoverBlock = b;
    clearTimeout(handleTimer);
    refreshHandle();
  });
  el.wysiwyg.addEventListener('mouseleave', () => {
    hoverBlock = null;
    clearTimeout(handleTimer);
    handleTimer = setTimeout(() => { if (!handleBusy) hideHandle(); }, 240);
  });
  el.wysiwyg.addEventListener('scroll', () => { if (!handleBusy) refreshHandle(); }, { passive: true });

  document.addEventListener('selectionchange', () => {
    if (hoverBlock || handleBusy) return;
    clearTimeout(handleTimer);
    handleTimer = setTimeout(refreshHandle, 0);
  });

  // 鼠标移进手柄 / 菜单不算「离开编辑区」
  el.wHandle.addEventListener('mouseenter', () => { handleBusy = true; clearTimeout(handleTimer); });
  el.wHandle.addEventListener('mouseleave', () => {
    handleBusy = false;
    clearTimeout(handleTimer);
    handleTimer = setTimeout(() => {
      if (el.wBlockMenu.classList.contains('hidden')) hideHandle();
    }, 240);
  });

  for (const b of [el.whAdd, el.whMenu]) b.addEventListener('mousedown', (e) => e.preventDefault());
  el.whAdd.onclick = () => openBlockMenu('insert');
  el.whMenu.onclick = () => openBlockMenu('convert');

  document.addEventListener('mousedown', (e) => {
    if (el.wBlockMenu.classList.contains('hidden')) return;
    if (el.wBlockMenu.contains(e.target) || el.wHandle.contains(e.target)) return;
    closeBlockMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.wBlockMenu.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    closeBlockMenu();
  }, true);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  const on = (id, fn) => { const n = $(id); if (n) n.onclick = fn; };

  /* 自绘标题栏：窗口按钮 + 最大化状态同步 */
  on('wcMin', () => win.minimize());
  on('wcMax', () => win.toggleMaximize());
  on('wcClose', () => commands.quit());
  let maxState = null;
  const syncMaxState = async () => {
    const max = !!(await win.isMaximized());
    if (max === maxState) return;
    maxState = max;
    if (el.wcMaxIcon) setIcon(el.wcMaxIcon, max ? 'copy' : 'square');
    if (el.wcMax) el.wcMax.title = max ? '还原' : '最大化';
  };
  window.addEventListener('resize', syncMaxState);
  setTimeout(syncMaxState, 80);

  /* 窗口失焦时让标题与窗口按钮变淡（Win11 原生标题栏就是这个行为） */
  const setBlur = (on) => document.body.classList.toggle('win-blur', on);
  window.addEventListener('blur', () => setBlur(true));
  window.addEventListener('focus', () => { setBlur(false); syncMaxState(); });
  document.addEventListener('visibilitychange', () => setBlur(document.hidden));

  on('btnFind', () => openFind(false));
  on('btnSave', commands.save);
  on('tabAdd', commands.new);

  $('btnMode').onclick = (e) => { e.stopPropagation(); el.modeMenu.classList.toggle('open'); };
  el.modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (b.classList.contains('disabled')) { toast('当前文件类型不支持该模式'); return; }
      setMode(b.dataset.mode, { fromActivate: true });
      el.modeMenu.classList.remove('open');
    };
  });
  document.addEventListener('mousedown', (e) => {
    if (!el.modeMenu.contains(e.target) && e.target.id !== 'btnMode' && !$('btnMode').contains(e.target)) {
      el.modeMenu.classList.remove('open');
    }
  });

  // 纯文本编辑区的内容变化、光标移动都由 PlainEditor 的 updateListener
  // 回调进来（相当于原来的 input / keyup / click），Tab 缩进和回车继承缩进
  // 也已由 CM6 的 keymap 接管。这里只剩右键菜单 —— CM6 不提供 UI。
  el.editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 菜单一弹出焦点就跑了，剪贴板命令前先把焦点还给编辑区
    const clip = (cmd) => () => { plain.focus(); try { document.execCommand(cmd); } catch {} };
    contextMenu(e.clientX, e.clientY, [
      { label: '剪切', action: clip('cut') },
      { label: '复制', action: clip('copy') },
      { label: '粘贴', action: clip('paste') },
      { label: '全选', action: () => { plain.focus(); plain.selectAll(); } },
      { sep: true },
      { label: '查找…', shortcut: 'Ctrl+F', action: () => openFind(false) },
      { label: '替换…', shortcut: 'Ctrl+H', action: () => openFind(true) },
      { label: '一键格式化', shortcut: 'Ctrl+Shift+F', action: commands.format },
      { sep: true },
      { label: '转大写', action: commands.upper },
      { label: '转小写', action: commands.lower },
    ]);
  });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.wysiwyg')) {
      e.preventDefault();
      const tbl = wys.isInTable();
      const items = [
        { label: '加粗', shortcut: 'Ctrl+B', action: () => commands.bold() },
        { label: '斜体', shortcut: 'Ctrl+I', action: () => commands.italic() },
        { label: '删除线', shortcut: 'Ctrl+Shift+X', action: () => commands.strike() },
        { label: '行内代码', action: () => commands.inlineCode() },
        { label: '插入链接…', shortcut: 'Ctrl+K', action: () => commands.link() },
        { sep: true },
        { label: '正文', shortcut: 'Ctrl+Alt+0', action: () => commands.body() },
        { label: '一级标题', shortcut: 'Ctrl+Alt+1', action: () => commands.h1() },
        { label: '无序列表', shortcut: 'Ctrl+Shift+8', action: () => commands.ul() },
        { label: '有序列表', shortcut: 'Ctrl+Shift+7', action: () => commands.ol() },
        { label: '任务列表', shortcut: 'Ctrl+Shift+9', action: () => commands.taskList() },
        { sep: true },
      ];
      if (tbl) {
        items.push(
          { label: '上方插入行', action: () => commands.tableRowAbove() },
          { label: '下方插入行', action: () => commands.tableRowBelow() },
          { label: '左侧插入列', action: () => commands.tableColBefore() },
          { label: '右侧插入列', action: () => commands.tableColAfter() },
          { sep: true },
          /* 四个方向的对齐都留在这里：主菜单里已经不重复列表格操作了，
             右键是唯一入口，少一个就等于功能丢了 */
          { label: '本列左对齐', action: () => commands.tableAlignLeft() },
          { label: '本列居中', action: () => commands.tableAlignCenter() },
          { label: '本列右对齐', action: () => commands.tableAlignRight() },
          { label: '本列取消对齐', action: () => commands.tableAlignNone() },
          { sep: true },
          { label: '删除本行', action: () => commands.tableDelRow() },
          { label: '删除本列', action: () => commands.tableDelCol() },
          { label: '删除表格', action: () => commands.tableDel() },
          { sep: true },
        );
      } else {
        items.push(
          { label: '插入表格', shortcut: 'Ctrl+Shift+T', action: () => commands.table() },
          { label: '分割线', action: () => commands.hr() },
          { sep: true },
        );
      }
      items.push(
        { label: '全选', action: () => document.execCommand('selectAll') },
        { label: '查找替换…', shortcut: 'Ctrl+F', action: () => openFind(false) },
      );
      contextMenu(e.clientX, e.clientY, items);
    }
  });

  $('findInput').addEventListener('input', runFind);
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { closeFind(); }
  });
  $('replaceInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') { closeFind(); }
  });
  on('findNext', () => findStep(1));
  on('findPrev', () => findStep(-1));
  on('findReplaceOne', replaceOne);
  on('findReplaceAll', replaceAll);
  on('findClose', closeFind);
  on('findCase', runFind);
  on('findRegex', runFind);

  on('stEOL', cycleEol);
  on('stEncoding', changeEncoding);

  applyFont();
  applyTheme();
  document.getElementById('toolbar').classList.toggle('hidden', settings.showToolbar === false);
}

/* ---------------- 快捷键 ---------------- */
function setupKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (!mod) {
      if (e.key === 'F7') { diff.step(-1); return; }
      if (e.key === 'F8') { diff.step(1); return; }
      if (e.key === 'F11') { e.preventDefault(); commands.fullscreen(); return; }
      if (e.key === 'F3') { findStep(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
      if (e.key === 'Escape' && !el.findbar.classList.contains('hidden')) closeFind();
      return;
    }
    const shift = e.shiftKey;
    let handled = true;

    // —— 块级格式：Ctrl+Alt+0/1/2/3 = 正文 / 一级 / 二级 / 三级标题 ——
    if (e.altKey && /^[0-3]$/.test(k)) {
      commands[k === '0' ? 'body' : 'h' + k]();
      e.preventDefault();
      return;
    }
    // 列表用 e.code 判定：Shift+数字在不同键盘布局下 e.key 不是数字
    if (shift && e.code === 'Digit7') { commands.ol(); e.preventDefault(); return; }
    if (shift && e.code === 'Digit8') { commands.ul(); e.preventDefault(); return; }
    if (shift && e.code === 'Digit9') { commands.taskList(); e.preventDefault(); return; }

    if (k === 'n' && shift) diff.openText();
    else if (k === 'n') commands.new();
    else if (k === 'o' && shift) commands.toggleOutline();
    else if (k === 'o') commands.open();
    else if (k === 's' && shift) commands.saveAs();
    else if (k === 's') commands.save();
    else if (k === 'w') commands.closeTab();
    else if (k === 'f' && shift) commands.format();
    else if (k === 'f') openFind(false);
    else if (k === 'h') openFind(true);
    else if (k === 'd') diff.openText();
    else if (k === 'g') commands.gotoLine();
    else if (k === 'l' && shift) commands.toggleLayout();
    else if (k === 'k' && shift) commands.codeBlock();
    else if (k === 'k') commands.link();
    else if (k === 'q' && shift) commands.quote();
    else if (k === 't' && shift) commands.table();
    else if (k === 'x' && shift) commands.strike();
    else if (k === '1') setMode('wysiwyg', { fromActivate: true });
    else if (k === '2') setMode('edit', { fromActivate: true });
    else if (k === '3') setMode('preview', { fromActivate: true });
    else if (k === '=' || k === '+') commands.zoomIn();
    else if (k === '-') commands.zoomOut();
    else if (k === '0') commands.zoomReset();
    else if (k === 'tab') cycleTab(shift ? -1 : 1);
    else if (k === 'p' && shift) commands.print();
    else if (k === 'p') commands.exportPdf();
    else handled = false;
    if (handled) e.preventDefault();
  });
}

/* 菜单命令分发已经统一在自绘菜单里（setupAppMenu → commands 表），
   原生菜单的事件桥在窗口改成无边框后已无用，删除。 */

function cycleTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeTab().id);
  activate(tabs[(i + dir + tabs.length) % tabs.length].id);
}

function persistCurrentView() {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') t.content = wys.toMarkdown();
  else if (t.mode === 'edit') t.content = plain.value;
  if (el.previewPane && !el.previewPane.classList.contains('hidden')) t.scrollTop = el.preview.scrollTop;
}

/* ---------------- 启动 ---------------- */
const WELCOME = `# 欢迎使用 简单记事本

一个安装包不到 10MB、免安装、不联网的小工具，把 **Markdown 写作**、**文本读写**、**文件对比** 的常用功能收在一起。

## 三种模式

- **所见即所得**：输入 \`# \` 立刻变标题（文字写好了回行首补 \`# \` 也行），\`**粗体**\` 立刻加粗；光标哪一行，左边就浮出 \`+\` 和 \`⋮⋮\` —— 插新块、换块类型不用离开正文
- **编辑模式**：显示原始 Markdown，带行号、语法着色、括号匹配和代码折叠
- **预览模式**：只读渲染

在工具栏「模式」下拉切换，或按 \`Ctrl+1 / Ctrl+2 / Ctrl+3\`。

新建时可以先选类型：Markdown、纯文本、JSON、CSV 和常见代码。非 Markdown 的文件只开放编辑 / 预览，当普通文本编辑器用：\`Tab\` 缩进（4 空格）、\`Shift+Tab\` 反缩进、回车按上一行缩进自动续上（Python 里 \`def ...:\` 回车还会多缩一级）。

## 常用快捷键

| 操作 | 快捷键 |
|---|---|
| 新建 / 打开 / 保存 | \`Ctrl+N\` / \`Ctrl+O\` / \`Ctrl+S\` |
| 查找 / 替换 | \`Ctrl+F\` / \`Ctrl+H\` |
| 一键格式化 | \`Ctrl+Shift+F\` |
| 文本对比 | \`Ctrl+D\` |
| 标题级别 / 正文 | \`Ctrl+Alt+1~3\` / \`Ctrl+Alt+0\` |
| 无序 / 有序 / 任务列表 | \`Ctrl+Shift+8 / 7 / 9\` |
| 插入表格 / 引用 | \`Ctrl+Shift+T\` / \`Ctrl+Shift+Q\` |
| 单栏 / 双栏 | \`Ctrl+Shift+L\` |
| 跳转行 | \`Ctrl+G\` |
| 导出 PDF | \`Ctrl+P\` |

> 支持 Markdown、JSON、TXT、日志与常见代码文件，打开时自动识别类型。

\`\`\`js
// 代码块支持语法高亮
const hello = (name) => \`你好，\${name}\`;
console.log(hello('简单记事本'));
\`\`\`

- [x] 多标签页
- [x] 自动保存草稿
- [ ] 去写点什么
`;

async function boot() {
  bindEvents();
  setupKeys();
  setupAppMenu();
  setupSplitters();
  setupDrop();
  setupBlockHandle();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  const restored = await restoreDraft().catch(() => false);
  if (!restored) {
    const session = LS.get('session', null);
    const recent = LS.get('recent', []);
    const toOpen = session && session.length ? session.filter((s) => s.path && recent.slice(0, 5).includes(s.path)) : [];
    let opened = false;
    for (const s of toOpen) {
      try { await be.readText(s.path); await openPath(s.path); opened = true; } catch {}
    }
    if (!opened) newTab('欢迎.md', WELCOME);
  }
  setLayout(settings.layout);
  updateOutline();

  window.addEventListener('beforeunload', () => { persistCurrentView(); saveDraft(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { persistCurrentView(); saveDraft(); }
  });
  /* 回到窗口时看一眼文件有没有被别的程序改过（延迟一点点，避开切换动画期间的 IO 抖动） */
  window.addEventListener('focus', () => setTimeout(checkExternalChange, 250));
}

/* 供子面板回调 */
window.__snp = {
  commands,
  getActiveTab: activeTab,
  openPath,
  setContent,
  gotoLine,
  newTab,
  getEditorText: () => activeTab() && activeTab().content,
  capture: persistCurrentView,
};
window.__diff = diff;
window.__merge = merge;

boot().catch((err) => {
  console.error('[启动失败]', err);
  try { document.getElementById('preview').innerHTML = `<div class="diff-empty">启动失败：${err && err.message}</div>`; } catch {}
});
