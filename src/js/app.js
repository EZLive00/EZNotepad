// ============================================================
// app.js —— 应用主控：标签、视图、模式、命令、快捷键
// 各业务能力（渲染 / 对比 / 合并 / 格式化）独立成模块，这里只做编排
// ============================================================
import { createTab, tabs, settings, saveSettings, LS, isDirty, activeTab, setActive, removeTab } from './state.js';
import * as be from './backend.js';
import { detectKind, kindLabel, modesFor, formatByKind, lineOps, caseOps } from './format.js';
import { renderPreview, extractOutline } from './preview.js';
import { WysiwygEditor } from './wysiwyg.js';
import { toast, dialog, confirmBox, contextMenu } from './ui.js';
import { DiffPanel } from './diffpanel.js';
import { MergeWizard } from './mergewizard.js';
import { showShortcuts } from './shortcuts.js';
import { exportPdf, printTab } from './pdf.js';
import { iconHTML, setIcon } from './icons.js';
import { createAppMenu } from './appmenu.js';
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
  gutter: $('lineGutter'),
  editorPane: $('editorPane'),
  modeLabel: $('modeLabel'),
  modeIcon: $('modeIcon'),
  modeMenu: $('modeMenu'),
  modeNote: $('modeNote'),
  fmtBadge: $('fmtBadge'),
  layoutLabel: $('layoutLabel'),
  layoutIcon: $('layoutIcon'),
  themeIcon: $('themeIcon'),
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
};

const MODE_META = {
  wysiwyg: { label: '所见即所得', icon: 'type' },
  edit: { label: '编辑模式', icon: 'code' },
  preview: { label: '预览模式', icon: 'eye' },
};

let currentLang = '';

/* ---------------- 主题 ---------------- */
function applyTheme() {
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && sysDark);
  document.body.dataset.theme = dark ? 'dark' : 'light';
  // 按钮显示「点了会变成什么」，深色下给太阳、浅色下给月亮
  setIcon(el.themeIcon, dark ? 'sun' : 'moon');
  const btn = $('btnTheme');
  if (btn) btn.title = dark ? '切换到浅色' : '切换到深色';
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
      updateStatus();
    }
  },
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
  const docTitle = t ? `${dirty ? '• ' : ''}${name} — 简单记事本` : '简单记事本';
  if (document.title !== docTitle) document.title = docTitle;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => win.setTitle(docTitle), 300);
}

function renderTabs() {
  el.tabs.innerHTML = '';
  const act = activeTab();
  for (const t of tabs) {
    const b = document.createElement('div');
    b.className = 'tab' + (act && t.id === act.id ? ' active' : '');
    b.title = t.path || t.name;
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
  el.editor.value = '';
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

  el.modeLabel.textContent = MODE_META[mode].label;
  setIcon(el.modeIcon, MODE_META[mode].icon);

  const split = settings.layout === 'split';
  const showEditor = mode !== 'preview';
  const showWys = mode === 'wysiwyg';
  const showPreview = split || mode === 'preview';

  el.editor.classList.toggle('hidden', !showEditor || showWys);
  el.wysiwyg.classList.toggle('hidden', !showWys);
  el.gutter.classList.toggle('hidden', !showEditor || showWys);
  el.previewPane.classList.remove('hidden');
  el.previewPane.classList.toggle('hidden', !showPreview);
  el.mid.classList.toggle('hidden', !(showEditor && showPreview));
  el.editorPane.style.flex = '1';
  el.previewPane.style.flex = split ? '1' : '1';
  el.previewHead.textContent = split ? '预览' : '预览（只读）';

  if (showWys) wys.render(t.content);
  else if (showEditor) { el.editor.value = t.content; }
  if (showPreview) renderPreview(kind, t.content, currentLang, el.preview);

  updateModeMenu(kind, allowed);
  updateOutline();
  refreshStats();
  if (mode === 'preview') el.preview.scrollTop = t.scrollTop || 0;
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
  el.layoutLabel.textContent = layout === 'split' ? '双栏' : '单栏';
  setIcon(el.layoutIcon, layout === 'split' ? 'columns-2' : 'square');
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
    renderPreview(detectKind(t.name), t.content, currentLang, el.preview);
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
  el.editor.focus();
  el.editor.setSelectionRange(off, off + (lines[line] || '').length);
  const lh = parseFloat(getComputedStyle(el.editor).lineHeight) || 22;
  el.editor.scrollTop = Math.max(0, line * lh - el.editor.clientHeight / 2);
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
  if (!el.gutter.classList.contains('hidden')) {
    // 行号只渲染到实际行数，超出部分留白（与编辑器行高严格对齐）
    const lh = parseFloat(getComputedStyle(el.editor).lineHeight) || 22;
    const visible = Math.ceil(el.editor.clientHeight / lh) + 1;
    const total = lines;
    const start = Math.floor(el.editor.scrollTop / lh);
    const end = Math.min(total + 1, start + visible);
    const arr = [];
    for (let i = start; i < end; i++) {
      arr.push(i < total ? `<div>${i + 1}</div>` : '<div>&nbsp;</div>');
    }
    el.gutter.innerHTML = arr.join('');
    el.gutter.style.transform = `translateY(${-(el.editor.scrollTop % lh)}px)`;
  }
}

function updateStatus() {
  const t = activeTab();
  if (!t) return;
  el.stEOL.textContent = t.eol;
  el.stEncoding.textContent = t.encoding;
  el.fmtBadge.textContent = kindLabel(detectKind(t.name));
  if (t.mode === 'wysiwyg') {
    el.stPos.textContent = '—';
  } else {
    const pos = el.editor.selectionStart || 0;
    const before = t.content.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    el.stPos.textContent = `行 ${line}, 列 ${col}`;
  }
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

/* ---------------- 文件操作 ---------------- */
export async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) { activate(existing.id); return; }
  try {
    const r = await be.readText(path);
    newTab(r.name, r.content, r.path, { encoding: r.encoding, bom: r.bom, eol: r.eol });
    addRecent(path);
  } catch (e) {
    dialog({ title: '无法打开', body: String(e) });
  }
}

async function openFileDialog() {
  const p = await be.pickFile();
  if (p) openPath(p);
}

async function saveTab(t = activeTab(), saveAs = false) {
  if (!t) return false;
  if (!t.path || saveAs) {
    const p = await be.pickSavePath(t.path || t.name);
    if (!p) return false;
    t.path = p;
    t.name = be.baseName(p);
    t.external = false;
    currentLang = (t.name.split('.').pop() || '').toLowerCase();
  }
  try {
    t.content = readEditor(t);
    const content = t.eol === 'CRLF' ? t.content.replace(/\r?\n/g, '\r\n') : t.content.replace(/\r\n?/g, '\n');
    await be.saveText({ path: t.path, content, encoding: t.encoding, bom: t.bom });
    t.savedContent = t.content;
    LS.del('draft');
    addRecent(t.path);
    updateStatus();
    toast(`已保存 ${t.name}`);
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
  if (!tabs.length) { newTab('未命名.md', ''); return; }
  activate(wasActive ? activeTab().id : (activeTab() || tabs[tabs.length - 1]).id);
}

function addRecent(path) {
  const list = LS.get('recent', []).filter((p) => p !== path);
  list.unshift(path);
  LS.set('recent', list.slice(0, 12));
}

/* ---------------- 内容读写 ---------------- */
/** 从当前视图读回内容（保证不丢编辑） */
function readEditor(t) {
  if (!t) return '';
  if (t.mode === 'wysiwyg') return wys.toMarkdown();
  if (t.mode === 'edit') return el.editor.value;
  return t.content;
}

function setContent(text, opts = {}) {
  const t = activeTab();
  if (!t) return;
  t.content = text;
  if (t.mode === 'wysiwyg') wys.render(text, opts.caret);
  else el.editor.value = text;
  schedulePreview();
  refreshStats();
  updateOutline();
  scheduleDraft();
  updateStatus();
}

function onEditorInput() {
  const t = activeTab();
  if (!t) return;
  t.content = el.editor.value;
  schedulePreview();
  refreshStats();
  updateOutline();
  scheduleDraft();
  updateStatus();
}

function surround(marker) {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'wysiwyg') { wys.wrapInline(marker); return; }
  if (t.mode !== 'edit') { toast('预览模式下不能编辑'); return; }
  const s = el.editor.selectionStart;
  const e = el.editor.selectionEnd;
  const sel = t.content.slice(s, e);
  const next = t.content.slice(0, s) + marker + sel + marker + t.content.slice(e);
  setContent(next);
  el.editor.focus();
  el.editor.setSelectionRange(s + marker.length, s + marker.length + sel.length);
  onEditorInput();
}

function requireEditMode() {
  const t = activeTab();
  if (!t) return false;
  if (t.mode === 'preview') { toast('预览模式下不能编辑，请切换到编辑模式'); return false; }
  return true;
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
  const s = el.editor.selectionStart;
  const e = el.editor.selectionEnd;
  const hasSel = e > s;
  const target = hasSel ? t.content.slice(s, e) : t.content;
  const backup = t.content;
  const out = fn(target);
  const next = hasSel ? t.content.slice(0, s) + out + t.content.slice(e) : out;
  if (next === backup) { toast('内容没有变化'); return; }
  setContent(next);
  if (hasSel) el.editor.setSelectionRange(s, s + out.length);
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
  const sel = el.editor.value.slice(el.editor.selectionStart, el.editor.selectionEnd);
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
  const pos = el.editor.selectionStart || 0;
  const idx = find.matches.findIndex(([a]) => a >= pos);
  find.index = idx < 0 ? 0 : idx;
  $('findCount').textContent = `${find.matches.length ? find.index + 1 : 0}/${find.matches.length}`;
  if (find.matches.length) locateMatch();
}

function locateMatch() {
  const t = activeTab();
  const [a, b] = find.matches[find.index] || [];
  if (a == null || !t) return;
  el.editor.focus();
  el.editor.setSelectionRange(a, b);
  const lh = parseFloat(getComputedStyle(el.editor).lineHeight) || 22;
  const line = t.content.slice(0, a).split('\n').length;
  el.editor.scrollTop = Math.max(0, (line - 1) * lh - el.editor.clientHeight / 2);
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

/* ---------------- 拖拽 / 分栏 ---------------- */
function setupDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault();
  });
  import('../vendor/api/webview.js').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent(async (ev) => {
      if (ev.payload && ev.payload.type === 'drop') {
        for (const p of ev.payload.paths) await openPath(p);
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
  el.editor.style.fontSize = s + 'px';
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
/** 当前可编辑元素：所见即所得是 contenteditable，其余是 textarea */
function editTarget() {
  const t = activeTab();
  if (t && t.mode === 'wysiwyg') return el.wysiwyg;
  return el.editor;
}

/** 走 execCommand 的编辑命令（菜单点击会抢焦点，这里先还原焦点） */
function editCmd(cmd) {
  const target = editTarget();
  if (!target) return;
  target.focus();
  try { document.execCommand(cmd); } catch {}
  if (target === el.editor) onEditorInput();
}

async function pasteFromClipboard() {
  const target = editTarget();
  target.focus();
  try {
    const text = await navigator.clipboard.readText();
    if (text) { document.execCommand('insertText', false, text); if (target === el.editor) onEditorInput(); return; }
  } catch {}
  toast('请按 Ctrl+V 粘贴');
}

function setTheme(mode) {
  settings.theme = mode;
  saveSettings();
  applyTheme();
}

/* ---------------- 命令表 ---------------- */
const commands = {
  new: () => newTab('未命名.md', ''),
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

const MENU_TREE = [
  {
    label: '文件',
    items: [
      { id: 'new', label: '新建', kbd: 'Ctrl+N' },
      { id: 'open', label: '打开…', kbd: 'Ctrl+O' },
      { sep: true },
      { id: 'save', label: '保存', kbd: 'Ctrl+S', disabled: () => !hasTab() },
      { id: 'saveAs', label: '另存为…', kbd: 'Ctrl+Shift+S', disabled: () => !hasTab() },
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
      { id: 'toggleToolbar', label: '显示工具栏', checked: () => settings.showToolbar !== false },
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

  on('btnNew', commands.new);
  on('btnOpen', commands.open);
  on('btnSave', commands.save);
  on('tabAdd', commands.new);
  on('btnLayout', commands.toggleLayout);
  on('btnOutlineToggle', commands.toggleOutline);
  on('btnFind', () => openFind(false));
  on('btnFormat', commands.format);
  on('btnCompare', () => diff.openHub());
  on('btnTheme', commands.toggleTheme);

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

  el.editor.addEventListener('input', onEditorInput);
  el.editor.addEventListener('scroll', () => { el.gutter.scrollTop = el.editor.scrollTop; refreshStats(); });
  el.editor.addEventListener('click', updateStatus);
  el.editor.addEventListener('keyup', updateStatus);
  el.editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
      onEditorInput();
    }
  });
  el.editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: '剪切', action: () => document.execCommand('cut') },
      { label: '复制', action: () => document.execCommand('copy') },
      { label: '粘贴', action: () => document.execCommand('paste') },
      { label: '全选', action: () => el.editor.select() },
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
      contextMenu(e.clientX, e.clientY, [
        { label: '加粗', shortcut: 'Ctrl+B', action: () => commands.bold() },
        { label: '斜体', shortcut: 'Ctrl+I', action: () => commands.italic() },
        { label: '行内代码', action: () => commands.inlineCode() },
        { sep: true },
        { label: '全选', action: () => document.execCommand('selectAll') },
        { label: '查找替换…', shortcut: 'Ctrl+F', action: () => openFind(false) },
      ]);
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
  el.layoutLabel.textContent = settings.layout === 'split' ? '双栏' : '单栏';
  setIcon(el.layoutIcon, settings.layout === 'split' ? 'columns-2' : 'square');
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
    if (k === 'n' && shift) diff.openText();
    else if (k === 'n') commands.new();
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
    else if (k === 'o' && shift) commands.toggleOutline();
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
  else if (t.mode === 'edit') t.content = el.editor.value;
  if (el.previewPane && !el.previewPane.classList.contains('hidden')) t.scrollTop = el.preview.scrollTop;
}

/* ---------------- 启动 ---------------- */
const WELCOME = `# 欢迎使用 简单记事本

一个安装包不到 10MB、免安装、不联网的小工具，把 **Markdown 写作**、**文本读写**、**文件对比** 的常用功能收在一起。

## 三种模式

- **所见即所得**：输入 \`# \` 立刻变标题，\`**粗体**\` 立刻加粗
- **编辑模式**：显示原始 Markdown，带行号
- **预览模式**：只读渲染

在工具栏「模式」下拉切换，或按 \`Ctrl+1 / Ctrl+2 / Ctrl+3\`。

## 常用快捷键

| 操作 | 快捷键 |
|---|---|
| 新建 / 打开 / 保存 | \`Ctrl+N\` / \`Ctrl+O\` / \`Ctrl+S\` |
| 查找 / 替换 | \`Ctrl+F\` / \`Ctrl+H\` |
| 一键格式化 | \`Ctrl+Shift+F\` |
| 文本对比 | \`Ctrl+D\` |
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
