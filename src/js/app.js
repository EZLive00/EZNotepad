// ============================================================
// app.js —— 应用主控：标签、视图、模式、命令、快捷键
// 各业务能力（渲染 / 对比 / 合并 / 格式化）独立成模块，这里只做编排
// ============================================================
import { createTab, tabs, settings, saveSettings, LS, isDirty, activeTab, setActive, removeTab, DEFAULTS } from './state.js';
import * as be from './backend.js';
import { detectKind, kindLabel, modesFor, formatByKind, lineOps, caseOps } from './format.js';
import { renderPreview, extractOutline } from './preview.js';
import { outlineFromMarkdown, headingSlugs } from './markdown.js';
import { WysiwygEditor } from './wysiwyg.js';
import { PlainEditor } from './editor/plain-editor.js';
import { toast, dialog, confirmBox, contextMenu } from './ui.js';
import { DiffPanel } from './diffpanel.js';
import { MergeWizard } from './mergewizard.js';
import { showShortcuts } from './shortcuts.js';
import { exportPdf, printTab } from './pdf.js';
import { exportHtml } from './exporthtml.js';
import { iconHTML, setIcon } from './icons.js';
import { createAppMenu } from './appmenu.js';
import * as domfind from './domfind.js';
import { FileTree } from './filetree.js';
import { showHistory } from './history.js';
import { freeUntitledName, moveById } from './taborder.js';
import { listen } from '../vendor/api/event.js';
import * as win from './win.js';
import { tt, setLang, resolveLang, getLang, applyDom, LANGS } from './i18n.js';
import { errText } from './errors.js';
import { welcomeDoc } from './welcome.js';

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
  sideOutline: $('sideOutline'),
  sideFiles: $('sideFiles'),
  sideTabs: [...document.querySelectorAll('.side-tab')],
  ftQuery: $('ftQuery'),
  ftReplaceRow: $('ftReplaceRow'),
  ftReplaceInput: $('ftReplaceInput'),
  ftReplaceAll: $('ftReplaceAll'),
  ftRegex: $('ftRegex'),
  ftCase: $('ftCase'),
  ftBody: $('ftBody'),
  ftPathText: $('ftPathText'),
  ftPick: $('ftPick'),
  ftClear: $('ftClear'),
};

/* ---------------- 纯文本 / 代码编辑区 ----------------
 * CodeMirror 6 实例。全项目只有 js/editor/plain-editor.js 认识 CM6，
 * 这里拿到的只是一组「读写文本 + 选区偏移」的方法。
 * 全应用共用一个实例（和原来的 textarea 一样），切标签时换内容。
 */
const plain = new PlainEditor(el.editor, {
  onChange: () => onEditorInput(),
  onCursor: () => updateCursorPos(),
  onScroll: () => scheduleOutlineSync(),
  onPasteImage: (file) => insertImageFromFile(file),
});

/* 模式文案每次取用时才算 —— 写成常量会在模块加载那一刻定死，
   切语言后工具栏仍是旧语言 */
const modeMeta = () => ({
  // short 用于工具栏/标题栏这类横向空间紧张的地方
  wysiwyg: { label: tt('所见即所得'), short: tt('所见即所得'), icon: 'type' },
  edit: { label: tt('编辑模式'), short: tt('编辑'), icon: 'code' },
  preview: { label: tt('预览模式'), short: tt('预览'), icon: 'eye' },
});

let currentLang = '';

/* ---------------- 主题 ---------------- */
function applyTheme() {
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && sysDark);
  document.body.dataset.theme = dark ? 'dark' : 'light';
}

/* ---------------- WYSIWYG ---------------- */
/* 输入路径上的三件事都做节流：字数统计、大纲重建、标签栏重绘。
   它们的结果不会随每一次击键变化（标题没动、脏标记第一次就亮了），
   但每算一次都是全文扫描 + 重建 DOM。600 段的文档里，这是单次击键最大的一块开销。 */
let statsTimer = 0;
function scheduleStats() {
  clearTimeout(statsTimer);
  /* 字数统计要对全文做正则扫描，超大文档下一次就是上百毫秒 —— 防抖按体量放大 */
  const big = (activeTab()?.content?.length || 0) > 1_000_000;
  statsTimer = setTimeout(refreshStats, big ? 800 : 150);
}

let outlineTimer = 0;
function scheduleOutline() {
  clearTimeout(outlineTimer);
  /* 大纲提取对全文逐行正则，超大文档下一次上百毫秒 —— 防抖按体量放大 */
  const big = (activeTab()?.content?.length || 0) > 1_000_000;
  outlineTimer = setTimeout(updateOutline, big ? 800 : 250);
}

const wys = new WysiwygEditor(el.wysiwyg, {
  /* 大文档分块载入的进度：状态栏行数位临时显示百分比。
     完成时（done === total）调度一次统计，把「载入中 x%」换回真实行数 ——
     否则最后一条进度文字会永远留在状态栏上（onChange 在载入期被抑制，
     开文档时排下的那次统计早在载入完成前就跑完了）。 */
  onProgress: (done, total) => {
    if (total === 0) { el.stLines.textContent = tt('载入中…'); return; }   // 渐进载入：首段已上屏，剩余总量未知
    if (total > 0 && done < total) el.stLines.textContent = tt('载入中 {n}%', { n: Math.round((done / total) * 100) });
    else scheduleStats();
  },
  onChange: (md) => {
    /* DOM 归谁：切标签的瞬间可能有一次迟到的 flush（失焦 → 序列化），
       那一刻 activeTab() 已经指向新标签了，直接写就是「开 A 得到 B 的内容」。
       ownerTabId 是渲染时钉下的归属，只在真的换了标签时才分流。 */
    const own = wys.ownerTabId != null ? tabs.find((x) => x.id === wys.ownerTabId) : null;
    if (own && own !== activeTab()) {
      if (own.content !== md) own.content = md;
      return;
    }
    const t = activeTab();
    if (!t) return;
    if (t.content !== md) {
      t.content = md;
      schedulePreview();
      scheduleStats();
      scheduleOutline();
      scheduleDraft();
      scheduleAutoSave();
      updateStatus();
      scheduleFindRefresh();
    }
  },
  onPasteImage: (file) => insertImageFromFile(file),
  openLink: (href) => openExternal(href),
});

/** 渲染前先把这块 DOM 钉给当前标签：迟到的 flush 只能写回它自己的标签 */
function renderWys(content, caret) {
  const t = activeTab();
  wys.ownerTabId = t ? t.id : null;
  wys.render(content, caret);
}

/* ---------------- 标签 ---------------- */
/** 标题栏中间那行文字 + 系统窗口标题（任务栏 / Alt+Tab 用） */
let titleTimer = 0;
function refreshTitle() {
  const t = activeTab();
  const dirty = t ? isDirty(t) : false;
  const name = t ? t.name : '';
  const shown = settings.showWinTitle === false
    ? ''
    : (t ? (dirty ? '• ' + name : name) : 'EZNotepad');
  if (el.winTitle && el.winTitle.textContent !== shown) el.winTitle.textContent = shown;
  // 保存按钮兼作「有改动」的提示：没有工具行的其它文件操作了，这里点一下最直接
  if (el.btnSave) el.btnSave.classList.toggle('dirty', dirty);
  const docTitle = t ? `${dirty ? '• ' : ''}${name} — EZNotepad` : 'EZNotepad';
  if (document.title !== docTitle) document.title = docTitle;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => win.setTitle(docTitle), 300);
}

let dragTabId = null;   // 正在被拖拽的标签 id（拖拽期间只存这一个）

/* 上一次画出来的标签栏。输入时 updateStatus 会走 renderTabs，
   而 tag 的名字、脏标记、顺序在连打十几个字里通常一个都没变——
   全量重建（清空 + 重建 + 重绑事件 + 重解析图标）纯属白干。 */
let tabsSig = '';

function renderTabs() {
  const act = activeTab();
  const sig = tabs.map((t) => `${t.id}|${t.name}|${t.path || ''}|${isDirty(t) ? 1 : 0}|${t.extChanged ? 1 : 0}`).join('~')
    + '#' + (act ? act.id : '');
  if (sig === tabsSig && el.tabs.children.length) return;
  tabsSig = sig;
  el.tabs.innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('div');
    b.className = 'tab' + (act && t.id === act.id ? ' active' : '');
    if (t.extChanged) b.classList.add('stale');   // 后台标签被外部改过，点开时会问
    b.title = t.path || t.name;
    b.draggable = true;
    b.dataset.id = String(t.id);
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    // data-bold 供 CSS 伪元素预留加粗宽度，渲染签名已含 t.name，名字变了会跟着重建
    name.dataset.bold = t.name;
    b.appendChild(name);
    if (isDirty(t)) {
      const d = document.createElement('span');
      d.className = 'tab-dot';
      b.appendChild(d);
    }
    const x = document.createElement('button');
    x.className = 'tab-close';
    x.innerHTML = iconHTML('x');
    x.title = tt('关闭');
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
        { label: tt('关闭'), shortcut: 'Ctrl+W', action: () => closeTab(t.id) },
        { label: tt('关闭其他'), action: () => closeOthers(t.id) },
        { label: tt('关闭右侧'), action: () => closeRight(t.id) },
        { sep: true },
        { label: tt('复制文件路径'), disabled: !t.path, action: () => { navigator.clipboard.writeText(t.path || ''); toast(tt('路径已复制')); } },
        { label: tt('在文件夹中显示'), disabled: !t.path, action: () => revealInFolder(t.path) },
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
  } catch { toast(tt('无法打开文件位置')); }
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

export function newTab(name = tt('未命名.md'), content = '', path = null, opts = {}) {
  const t = createTab(name, content, path);
  // 默认模式 = 该类型支持列表的第一项（Markdown 是所见即所得，其余是编辑模式）；
  // 用户手动切过模式后按 lastMode 记忆
  t.mode = settings.lastMode[detectKind(name)] || modesFor(detectKind(name))[0];
  Object.assign(t, opts);
  tabs.push(t);
  activate(t.id);
  syncWatches();
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
    mode = allowed.includes(last) ? last : allowed[0];
  }
  setMode(mode, { fromActivate: true });
  tree.setActive(t.path);
  saveDraft();
  /* 这个标签在后台待着的时候被外部改过？现在它上台了，正是问的时候 */
  if (t.extChanged) setTimeout(() => checkExternalChange(t), 60);
}

function clearView() {
  plain.load('');
  el.wysiwyg.innerHTML = '';
  el.preview.innerHTML = '<div class="diff-empty">' + tt('没有打开的文件') + '</div>';
  el.preview.__pvText = null;   // 容器被换掉了，预览的内容签名也要一起作废
  el.outlineList.innerHTML = '<div class="outline-empty">' + tt('新建或打开一个文件开始。') + '</div>';
  el.fmtBadge.textContent = '—';
}

/* ---------------- 模式 / 布局 ---------------- */
function setMode(mode, opt = {}) {
  const t = activeTab();
  if (!t) return;
  const kind = detectKind(t.name);
  const allowed = modesFor(kind);
  if (!allowed.includes(mode)) {
    const fallback = allowed.includes(settings.lastMode[kind]) ? settings.lastMode[kind] : allowed[0];
    toast(tt('{kind} 不支持「{mode}」，已切到「{fallback}」', { kind: kindLabel(kind), mode: modeMeta()[mode].label, fallback: modeMeta()[fallback].label }));
    mode = fallback;
  }
  /* 从所见即所得切走：先把挂起的输入落进 t.content（失焦触发的 flush 是异步的，
     下面的 plain.load 会抢在前面拿到旧内容）。只在真有未落账的编辑时才读 ——
     没编辑过就读，会把序列化的规范化写法（* → - 之类）写回去，无编辑也亮脏标记。 */
  if (t.mode === 'wysiwyg' && mode !== 'wysiwyg') {
    if (wys.pending()) t.content = wys.toMarkdown();
    /* 落账完就把挂起标记清掉：DOM 即将换成别的视图，之后那次迟到的 blur
       不能再 flush 一遍 —— 那时 onChange 眼里的「当前标签」已经是别人了。 */
    wys.markCommitted();
  }
  /* 旧代码这里有一句「changedTab || (t.content = readEditor(t))」：手动切换时
     短路跳过，activate 时则在 t.mode 不合法、被回退成 allowed[0] 的那次真的
     去读 —— 而那一刻编辑器 DOM 还是上一个标签的，读回来就是把别人的文档写进
     这个标签。wys 切走时的同步已由上面的守卫完成（edit 模式的输入本来就走
     onEditorInput 实时同步），这句只是坏兜底，整句删掉。 */
  t.mode = mode;
  /* 只记忆用户手动切换的模式。激活标签时的自动落位不算「选择」——
     否则默认模式在第一次打开文件时就被写进 lastMode 变成粘滞值，
     以后改默认永远轮不到生效 */
  if (!opt.fromActivate) { settings.lastMode[kind] = mode; saveSettings(); }

  el.modeLabel.textContent = modeMeta()[mode].short || modeMeta()[mode].label;
  setIcon(el.modeIcon, modeMeta()[mode].icon);

  const split = settings.layout === 'split';
  const showEditor = mode !== 'preview';
  const showWys = mode === 'wysiwyg';
  const showPreview = split || mode === 'preview';

  plain.setVisible(showEditor && !showWys);
  el.wysiwyg.classList.toggle('hidden', !showWys);
  /* 预览模式下把整个编辑面板收掉：只藏里面那两个视图的话，
     这块 flex:1 的空壳还在，预览只占右半边，左半边一片空白。 */
  el.editorPane.classList.toggle('hidden', !showEditor);
  el.previewPane.classList.remove('hidden');
  el.previewPane.classList.toggle('hidden', !showPreview);
  el.mid.classList.toggle('hidden', !(showEditor && showPreview));
  el.editorPane.style.flex = '1';
  el.previewPane.style.flex = split ? '1' : '1';

  const docDir = t.path ? be.dirName(t.path) : '';
  if (showWys) { wys.setDocDir(docDir); renderWys(t.content); }
  else if (showEditor) { plain.load(t.content, currentLang); }
  if (showPreview) renderPreview(kind, t.content, currentLang, el.preview, docDir);

  updateModeMenu(kind, allowed);
  updateOutline();
  refreshStats();
  updateStatus();   // 切换文件/模式后格式徽标、行列数、草稿状态都要跟着变
  if (mode === 'preview') el.preview.scrollTop = t.previewScroll || 0;
  else if (showPreview) el.preview.scrollTop = t.previewScroll || 0;
  /* 切回这个标签时把光标和滚动放回原处。只在「切标签」这条路上做，
     手动换模式（Ctrl+2）不该把视图拽走 */
  if (opt.fromActivate && showEditor && !showWys && t.caret != null) {
    const pos = Math.min(t.caret, plain.value.length);
    plain.setSelection(pos);
    plain.scrollTop = t.scrollTop || 0;
  } else if (opt.fromActivate && showWys && t.scrollTop) {
    el.wysiwyg.scrollTop = t.scrollTop;
  }
  // 手柄只属于所见即所得：切到编辑/预览就收起来
  if (mode === 'wysiwyg') { anchorBlock = null; refreshHandle(); }
  else { closeBlockMenu(); hideHandle(); }
}

function updateModeMenu(kind, allowed) {
  el.modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    const m = b.dataset.mode;
    b.classList.toggle('checked', activeTab() && activeTab().mode === m);
    b.classList.toggle('disabled', !allowed.includes(m));
  });
  const notes = {
    md: tt('支持全部三种模式'),
    json: tt('JSON 支持：编辑 / 预览（校验 + 高亮）'),
    code: tt('代码支持：编辑 / 预览（语法高亮）'),
    txt: tt('纯文本支持：编辑 / 预览（只读）'),
    data: tt('表格文本支持：编辑 / 预览（只读）'),
  };
  el.modeNote.textContent = tt('当前格式：{kind} · {note}', { kind: kindLabel(kind), note: notes[kind] || '' });
}

function setLayout(layout) {
  settings.layout = layout;
  saveSettings();
  const t = activeTab();
  if (t) setMode(t.mode, { fromActivate: true });
}

/* ---------------- 专注模式 ----------------
   标题栏必须留着：窗口是无边框的，连标题栏都没了就没法拖、没法最小化关闭，
   等于把用户关在自己写的文档里。所以只收敛标签行、侧栏、状态栏和菜单，
   标题栏退成半透明 —— 视觉上几乎只剩正文，鼠标移到顶上又都能用。 */
function applyZen() {
  document.body.dataset.zen = settings.zen ? '1' : '';
  if (settings.zen) refreshTitle();
}

/** 切一次专注模式；返回切换后的状态 */
function toggleZen(force) {
  settings.zen = force === undefined ? !settings.zen : !!force;
  saveSettings();
  applyZen();
  // 侧栏一藏，编辑容器的宽度就变了，大纲和当前光标要重新对一次
  if (!settings.zen) { updateOutline(); scheduleOutlineSync(); }
  toast(settings.zen ? tt('专注模式：Esc 退出') : tt('已退出专注模式'));
  return settings.zen;
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

/* 上一次画出来的大纲长什么样。签名里带上行号：标题文字没变、位置变了，
   点进去也得跳到新行，所以不能只比文字。 */
let outlineSig = '';
/* 与 outlineItems 一一对应的按钮节点，外加「当前亮着的那一项」。
   每次同步只动这两个节点 —— 不要遍历整个列表：四万项的大纲里逐一
   classList.toggle 等于每 70ms 制造几万次样式失效（实测把滚动帧时间
   从 17ms 顶到 178ms，视口渲染本身没问题，全被这一步拖垮）。 */
let outlineNodes = [];
let outlineActive = -1;
/* 大纲列表也窗口化：万级标题时，把三万个按钮都塞进侧栏，主文档每重排一次
   就要连带它们算一遍（实测 33k 项：滚动 17ms → 72ms）。这里只铺视口附近
   那一段，上下用 padding 占位，滚动条位置与点击跳转都不变。 */
const OUTLINE_ROW = 28;          // 行高，与 .outline-item 的 CSS 高度一致
const OUTLINE_OVER = 12;         // 上下各多铺几行，滚动时不闪白
let outlineStart = 0;
let outlineEnd = 0;
let outlineScrollRaf = 0;
let outlineScrollBound = false;
/* 侧栏可视高度单独缓存：clientHeight 把我们自己设的上下 padding 也算在内，
   而且首帧布局没稳定时它等于「内容高度」（几十万像素）—— 拿它算窗口会一次
   把整张表都铺出来，铺出来又把盒子撑高，自我锁定成非窗口态。 */
let outlineViewH = 0;
let outlineFitTries = 0;

/** 大纲为空时说明「为什么没有」：光说「没有可提取的结构」，用户会以为是 bug。
    每种格式能生成大纲的依据不一样，各说各的。
    必须写成函数 —— 里面的 tt() 要等语言确定后才取词（顶层常量会在切语言后卡在旧语言）。 */
const outlineEmptyHint = () => ({
  md: tt('用 # 定义标题后，这里会出现大纲。'),
  txt: tt('未发现章节标记（# 标题、编号或 ===）。'),
  data: tt('表格文本一行一条记录，不提取大纲。'),
  code: tt('未找到函数或类定义。'),
  json: tt('当前文件没有可提取的结构。'),
});

function updateOutline() {
  const t = activeTab();
  if (!t) return;
  const show = settings.outlineVisible;
  el.outlinePane.classList.toggle('hidden', !show);
  el.outlineSplitter.classList.toggle('hidden', !show);
  if (!show) return;
  const kind = detectKind(t.name);
  const items = extractOutline(kind, t.content);
  outlineItems = items;
  if (!items.length) {
    outlineSig = '';
    outlineNodes = [];
    outlineActive = -1;
    el.outlineList.innerHTML = '<div class="outline-empty">' + (outlineEmptyHint()[kind] || tt('当前文件没有可提取的结构。')) + '</div>';
    return;
  }
  /* 结构没变就别重建 DOM：改正文时标题几乎不动，而重建 600 个按钮
     比跑一次正则贵得多。高亮的跟随由 scheduleOutlineSync 单独负责。 */
  const sig = items.map((it) => `${it.level}:${it.line}:${it.text}`).join('\n');
  if (sig === outlineSig && outlineItems.length) return;
  outlineSig = sig;
  outlineActive = -1;
  if (!outlineScrollBound) {
    outlineScrollBound = true;
    el.outlineList.addEventListener('scroll', () => {
      if (outlineScrollRaf) return;
      outlineScrollRaf = requestAnimationFrame(() => {
        outlineScrollRaf = 0;
        renderOutlineWindow(false);
      });
    }, { passive: true });
    window.addEventListener('resize', () => {
      outlineViewH = 0;
      outlineFitTries = 0;
      renderOutlineWindow(true);
    });
  }
  renderOutlineWindow(true);
  scheduleOutlineSync();     // 重建后立刻把「当前章节」点亮，不要等下一次滚动
}

/** 按侧栏的滚动位置铺出可见的那一段（force=true 表示内容刚换，必须重建） */
function renderOutlineWindow(force) {
  const list = el.outlineList;
  const n = outlineItems.length;
  if (!n) {
    outlineNodes = [];
    outlineStart = outlineEnd = 0;
    list.replaceChildren();
    return;
  }
  if (!outlineViewH) {
    const cand = list.clientHeight;
    /* 40 ~ 4000：小于 40 说明还没布局（或侧栏被折叠），大于 4000 说明量到的
       是内容高度 —— 两种都不算数，留给下一帧重试 */
    if (cand > 40 && cand < 4000) outlineViewH = cand;
  }
  if (!outlineViewH && outlineFitTries < 3) {
    outlineFitTries++;
    requestAnimationFrame(() => { if (!outlineViewH) renderOutlineWindow(true); });
  }
  const h = outlineViewH || 600;
  const start = Math.max(0, Math.floor(list.scrollTop / OUTLINE_ROW) - OUTLINE_OVER);
  const end = Math.min(n, Math.ceil((list.scrollTop + h) / OUTLINE_ROW) + OUTLINE_OVER);
  if (!force && start === outlineStart && end === outlineEnd) return;
  outlineStart = start;
  outlineEnd = end;
  const frag = document.createDocumentFragment();
  const nodes = new Array(end - start);
  for (let i = start; i < end; i++) {
    const it = outlineItems[i];
    const b = document.createElement('button');
    b.className = `outline-item h${Math.min(6, it.level)}`;
    b.textContent = it.text;
    b.title = it.text;
    b.onclick = () => gotoLine(it.line, i);
    if (i === outlineActive) b.classList.add('active');
    nodes[i - start] = b;
    frag.appendChild(b);
  }
  outlineNodes = nodes;
  /* 未铺出来的部分用两个空 div 顶出高度（滚动条长度与位置都对得上真实条目数）。
     用 padding 顶不行：padding 算进 clientHeight，而且首帧布局未稳定时会把
     列表盒子自己撑到几十万像素高 —— 子元素不会。 */
  const top = document.createElement('div');
  top.className = 'outline-pad';
  top.style.height = start * OUTLINE_ROW + 'px';
  const bottom = document.createElement('div');
  bottom.className = 'outline-pad';
  bottom.style.height = (n - end) * OUTLINE_ROW + 'px';
  const all = document.createDocumentFragment();
  all.appendChild(top);
  all.appendChild(frag);
  all.appendChild(bottom);
  list.replaceChildren(all);
}

/** 当前章节高亮：只动「旧 → 新」两个节点，且只在它们被铺出来时动手 */
function paintOutlineActive(cur) {
  const n = outlineItems.length;
  if (cur >= n) cur = n - 1;
  if (cur === outlineActive) return;
  const prev = outlineActive;
  outlineActive = cur;
  const at = (i) => (i >= outlineStart && i < outlineEnd ? outlineNodes[i - outlineStart] : null);
  const oldNode = at(prev);
  if (oldNode) oldNode.classList.remove('active');
  const newNode = at(cur);
  if (newNode) newNode.classList.add('active');
}

/* ---------------- 大纲跟随滚动 ---------------- */
/* 三种模式的滚动容器各不相同（CM6 自己一个、所见即所得一个、预览一个），
   但判断逻辑一样：找到「最后一个顶部越过基准线的标题」。
   用标题相对容器顶部的距离，而不是自己累加行高——折行的行高算不准。 */
let outlineItems = [];
let outlineTick = 0;

function scheduleOutlineSync() {
  clearTimeout(outlineTick);
  outlineTick = setTimeout(syncOutline, 70);
}

function syncOutline() {
  const t = activeTab();
  if (!t || !settings.outlineVisible) return;
  if (!outlineItems.length) return;

  let cur = -1;
  if (t.mode === 'wysiwyg' && wys.virtual) {
    /* 视口模式：DOM 里只有窗口那一小段，标题数量对不上。
       高亮改由块模型按滚动位置算（等价于原来的「标题顶 ≤ 基准线」二分）。 */
    cur = atScrollEnd(el.wysiwyg.scrollTop, el.wysiwyg.scrollHeight, el.wysiwyg.clientHeight)
      ? outlineItems.length - 1
      : wys.headingIndexAt();
  } else if (t.mode === 'wysiwyg' || t.mode === 'preview') {
    const box = t.mode === 'wysiwyg' ? el.wysiwyg : el.preview;
    const heads = box.querySelectorAll(t.mode === 'wysiwyg' ? '.w-h' : 'h1,h2,h3,h4,h5,h6');
    if (atScrollEnd(box.scrollTop, box.scrollHeight, box.clientHeight)) {
      cur = heads.length - 1;      // 到底了：最后一个标题就是当前章节
    } else {
      const top = box.getBoundingClientRect().top + outlineBaseline(box);
      /* 标题在文档里自上而下排列，顶部坐标单调递增，可以二分。
         以前是 forEach 逐个量 —— 600 个标题就是 600 次布局查询，滚动时每 70ms 一轮。 */
      let lo = 0, hi = heads.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (heads[mid].getBoundingClientRect().top <= top) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      cur = found;
    }
  } else {
    // lineAtViewportY 收窗口坐标：基准线要加上编辑器在窗口里的偏移
    const baseY = plain.rectTop + outlineBaseline(el.editor);
    const line = atScrollEnd(plain.scrollTop, plain.scrollHeight, el.editor.clientHeight)
      ? Infinity
      : plain.lineAtViewportY(baseY) - 1;   // 0 起
    /* 大纲里的行号自上而下单调递增，二分找最后一个 ≤ line 的项 */
    let lo = 0, hi = outlineItems.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (outlineItems[mid].line <= line) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    cur = found;
  }
  paintOutlineActive(cur);
}

/** 大纲高亮的基准线：容器顶往下 96px（矮窗口取 30% 高）。点击跳转必须落在这条线上，高亮才对得上 */
function outlineBaseline(box) { return Math.min(96, box.clientHeight * 0.3); }

/** 滚到（几乎）底时高亮让给最后一个标题，否则文末标题够不到基准线、点了也不亮 */
function atScrollEnd(scrollTop, scrollHeight, clientHeight) {
  return scrollHeight > clientHeight + 4 && scrollHeight - scrollTop - clientHeight < 2;
}

function gotoLine(line, idx = null) {
  const t = activeTab();
  if (!t) return;
  // 大纲点击走「标题顶贴基准线」，和高亮判定共用 outlineBaseline，点谁谁亮
  if (t.mode === 'wysiwyg' && idx != null) {
    if (wys.virtual) { wys.scrollToHeadingIndex(idx); return; }   // 窗口外的标题也得能跳
    const h = el.wysiwyg.querySelectorAll('.w-h')[idx];
    if (h) { scrollBoxToHeading(el.wysiwyg, h); return; }
  }
  if (t.mode === 'preview' && idx != null) {
    const h = el.preview.querySelectorAll('h1,h2,h3,h4,h5,h6')[idx];
    if (h) { scrollBoxToHeading(el.preview, h); return; }
  }
  if (t.mode === 'wysiwyg') {          // 兜底：按行号数块（搜索结果跳转等无序号入口）
    if (wys.virtual) { wys.scrollToLine(line); return; }
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
  plain.revealOffset(off, off + (lines[line] || '').length,
    { atTop: idx != null, yMargin: outlineBaseline(el.editor) });
  updateStatus();
}

/** 把容器里某个标题滚到基准线（容器顶往下 outlineBaseline 处），带动高亮跟随 */
function scrollBoxToHeading(box, h) {
  const delta = h.getBoundingClientRect().top - box.getBoundingClientRect().top - outlineBaseline(box);
  box.scrollBy({ top: delta, behavior: 'smooth' });
}

/* ---------------- 侧栏：大纲 / 文件 ---------------- */
const tree = new FileTree({
  body: el.ftBody,
  pathText: el.ftPathText,
  be,
  toast,
  onOpen: (p, line) => openPathAt(p, line),
  menu: contextMenu,
  ask: askText,
  confirm: (title, html) => confirmBox(title, html, tt('删除'), tt('取消')),
  onReveal: (p) => revealInFolder(p),
  /* 树里选中两个文件右键「比较」：左边是被右键的那个 */
  onCompare: (l, r) => be.openCompareWindow(l, r).catch((e) => toast(tt('打不开对比窗口：') + e)),
  /* 改名/删除要带着已打开的标签一起走，否则标签还指着旧路径，
     下次保存就凭空造出一个同名文件（删除的情况则是把内容写回已删位置）。 */
  onRenamed: (oldPath, newPath) => {
    const t = tabs.find((x) => x.path === oldPath);
    if (!t) return;
    t.path = newPath;
    t.name = be.baseName(newPath);
    t.mtime = null;
    t.extChanged = false;
    currentLang = (t.name.split('.').pop() || '').toLowerCase();
    renderTabs();
    refreshTitle();
    syncWatches();
  },
  onDeleted: (p) => {
    const t = tabs.find((x) => x.path === p);
    if (!t) return;
    /* 文件没了，内容还留在标签里：断掉磁盘关系，别让人一保存又把它写回来 */
    t.path = null;
    t.mtime = null;
    t.extChanged = false;
    if (!t.name.includes(tt('（已删除）'))) t.name += tt('（已删除）');
    renderTabs();
    refreshTitle();
    syncWatches();
    toast(tt('文件已删除，标签内容保留，可另存为新文件'));
  },
});

/** 单行文本输入框。dialog 的 body 支持塞 DOM，和「跳转到行」走同一套 */
function askText(title, label, value, okLabel = tt('确定')) {
  const box = document.createElement('div');
  box.innerHTML = `<div class="dlg-text"></div><input class="dlg-input" id="askInput">`;
  box.querySelector('.dlg-text').textContent = label;
  const input = box.querySelector('#askInput');
  input.value = value || '';
  const p = dialog({
    title,
    body: box,
    buttons: [{ id: 'ok', label: okLabel, primary: true }, { id: 'cancel', label: tt('取消') }],
  }).then((r) => (r === 'ok' ? input.value.trim() : null));
  setTimeout(() => { input.focus(); input.select(); }, 40);
  return p;
}

/** 侧栏两个页面互斥显示；记住上次用的是哪个 */
function setSide(side) {
  const s = side === 'files' ? 'files' : 'outline';
  settings.side = s;
  saveSettings();
  el.sideTabs.forEach((b) => b.classList.toggle('active', b.dataset.side === s));
  el.sideOutline.classList.toggle('hidden', s === 'files');
  el.sideFiles.classList.toggle('hidden', s !== 'files');
}

/** 从搜索结果打开：先开文件，等它渲染完再跳到那一行 */
async function openPathAt(p, line) {
  await openPath(p);
  if (line) setTimeout(() => gotoLine(line - 1), 90);
}

async function pickFolder() {
  const p = await be.pickFolder(tt('选择文件夹'));
  if (!p) return;
  settings.folder = p;
  saveSettings();
  setSide('files');
  el.ftQuery.value = '';
  el.ftClear.classList.add('hidden');
  await tree.setRoot(p);
}

function clearFolder() {
  settings.folder = '';
  saveSettings();
  el.ftQuery.value = '';
  el.ftClear.classList.add('hidden');
  el.ftReplaceRow.classList.add('hidden');
  tree.setRoot('');
}

/* 全目录批量替换。安全边界：先问一次、说明会直接改磁盘、告诉用户历史快照在哪；
   后端只碰 UTF-8 文件，改每个文件前都留快照。 */
async function replaceInFolderNow() {
  const root = tree.root || settings.folder;
  const q = el.ftQuery.value;
  if (!root) { toast(tt('先打开一个文件夹')); return; }
  if (!q) { toast(tt('先在上面填要搜索的内容')); return; }
  const rep = el.ftReplaceInput.value;
  const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ok = await confirmBox(
    tt('在整个文件夹里替换'),
    tt('把 <code>{q}</code> 换成 <code>{rep}</code>。<br><br>', { q: htmlEsc(q), rep: htmlEsc(rep) || tt('（删除）') })
    + tt('这会<b>直接改动磁盘上的文件</b>，不是只改当前文档。<br>')
    + tt('每个文件改动前都会留一份历史快照，出问题可以从「文件 → 历史版本」找回。'),
    tt('开始替换'), tt('取消')
  );
  if (!ok) return;

  let r;
  try {
    r = await be.replaceInFolder(root, q, rep, tree.regex, tree.caseSensitive);
  } catch (e) {
    dialog({ title: tt('替换失败'), body: errText(e) });
    return;
  }
  toast(tt('替换完成：{files} 个文件、{hits} 处', { files: r.files, hits: r.hits }) + (r.skipped ? tt('（跳过 {n} 个）', { n: r.skipped }) : ''));

  await tree.search(q);
  /* 打开的标签跟着走：不脏就静默重载，脏就打个点等用户切过去再问 */
  for (const p of r.paths || []) {
    const t = tabs.find((x) => x.path === p);
    if (!t) continue;
    if (isDirty(t)) { t.extChanged = true; continue; }
    const m = await be.fileMtime(p).catch(() => null);
    await reloadTab(t, m).catch(() => {});
  }
  renderTabs();
}

function setupSidebar() {
  el.sideTabs.forEach((b) => { b.onclick = () => setSide(b.dataset.side); });
  el.ftPick.onclick = pickFolder;
  /* 设置入口只在两处：顶部菜单栏的「设置」和 Ctrl+,（同一个 showSettings）。
     侧栏那个齿轮去掉了——它紧挨「大纲/文件」，看着像「这一栏的设置」。 */

  let ftTimer = 0;
  el.ftQuery.addEventListener('input', () => {
    el.ftClear.classList.toggle('hidden', !el.ftQuery.value);
    el.ftReplaceRow.classList.toggle('hidden', !el.ftQuery.value);
    clearTimeout(ftTimer);
    ftTimer = setTimeout(() => tree.search(el.ftQuery.value), 320);
  });
  el.ftQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.ftQuery.value = ''; el.ftClear.classList.add('hidden'); tree.render(); }
  });
  el.ftClear.onclick = () => {
    el.ftQuery.value = '';
    el.ftClear.classList.add('hidden');
    el.ftReplaceRow.classList.add('hidden');
    tree.render();
  };

  /* ---- 跨文件替换 ----
     搜索一直是「只能看」的：找到 200 处命中，还是得一个一个点开改。
     这里补上批量替换，改之前先问、每个文件留历史快照、改完把打开的标签刷新。 */
  const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const syncSearchMode = () => {
    tree.regex = el.ftRegex.classList.contains('on');
    tree.caseSensitive = el.ftCase.classList.contains('on');
  };
  const rerunSearch = () => {
    clearTimeout(ftTimer);
    ftTimer = setTimeout(() => tree.search(el.ftQuery.value), 60);
  };
  el.ftRegex.onclick = () => {
    el.ftRegex.classList.toggle('on');
    el.ftRegex.title = tree.regex ? tt('按正则表达式匹配（已开启）') : tt('按正则表达式匹配');
    syncSearchMode();
    if (el.ftQuery.value) rerunSearch();
  };
  el.ftCase.onclick = () => {
    el.ftCase.classList.toggle('on');
    syncSearchMode();
  };
  el.ftReplaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceInFolderNow(); }
  });
  el.ftReplaceAll.onclick = () => replaceInFolderNow();

  setSide(settings.side || 'outline');
  // 有记住的文件夹就直接画出来；没有也要画一次（显示「还没打开文件夹」的引导）
  tree.setRoot(settings.folder || '').catch(() => {});
}

/* ---------------- 设置面板 ---------------- */
/* 设置项原来散在「视图」菜单里：主题、字号、单双栏各占一行，还看不出当前字号是多少。
   集中成一个面板，改一项立刻生效，不需要「确定」。 */
/** 语言偏好落地的唯一出口：改设置 → 生效 → 把「按需取词」的地方重刷一遍。
    静态 HTML 走 data-i18n（applyDom 一次扫完，顺带把已打开的设置面板就地翻掉），
    菜单顶级标签走 update()，其余是渲染时才算文案的动态区域（状态栏、大纲、预览）。 */
function applyLang() {
  setLang(resolveLang(settings.lang));
  applyDom();
  if (menuApi) menuApi.update(menuTree());
  const t = activeTab();
  if (t && t.mode) el.modeLabel.textContent = modeMeta()[t.mode].short || modeMeta()[t.mode].label;
  /* 模式下拉的说明行是 tt() 渲染时才算的动态区，换语言后要就地重刷 */
  if (t && t.mode) {
    const kind = detectKind(t.name);
    updateModeMenu(kind, modesFor(kind));
  }
  updateOutline();
  refreshStats();   // 状态栏「N 字 · N 字符」同属动态区
  updateStatus();
  tree.render();
  schedulePreview();
  refreshTitle();
}

function showSettings() {
  const box = document.createElement('div');
  box.className = 'set-panel';
  /* 面板里的文案一律写 data-i18n + 中文兜底，末尾 applyDom(box) 统一翻。
     这样换语言时同一个 applyDom 能把开着的面板就地刷掉，不用关掉重开。 */
  const seg = (name, opts, cur) => `<div class="set-seg" data-name="${name}">${
    opts.map(([v, l]) => `<button type="button" data-v="${v}" data-i18n="${l}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')
  }</div>`;

  const langOpts = ['auto'].concat(LANGS.map((l) => l.code)).map((c) => {
    const name = c === 'auto' ? '跟随系统' : (LANGS.find((l) => l.code === c) || {}).name || c;
    return `<option value="${c}"${c === settings.lang ? ' selected' : ''}${c === 'auto' ? ' data-i18n="跟随系统"' : ''}>${name}</option>`;
  }).join('');

  box.innerHTML = `
    <div class="set-group">
      <div class="set-label" data-i18n="语言">语言</div>
      <select class="set-select" id="setLang">${langOpts}</select>
      <div class="set-hint" data-i18n="「跟随系统」按系统语言自动选择，切换后立即生效。">「跟随系统」按系统语言自动选择，切换后立即生效。</div>
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="主题">主题</div>
      ${seg('theme', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']], settings.theme)}
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="字号">字号</div>
      <div class="set-zoom">
        <button type="button" class="set-step" data-zoom="-1" title="缩小" data-i18n-title="缩小">−</button>
        <span class="set-value" id="setFontSize">${settings.fontSize} px</span>
        <button type="button" class="set-step" data-zoom="1" title="放大" data-i18n-title="放大">+</button>
        <button type="button" class="set-link" id="setFontReset" data-i18n="实际大小">实际大小</button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="正文宽度">正文宽度</div>
      <div class="set-zoom">
        <button type="button" class="set-step" data-rw="-1" title="窄一点" data-i18n-title="窄一点">−</button>
        <span class="set-value" id="setReadWidth">${settings.readWidth} px</span>
        <button type="button" class="set-step" data-rw="1" title="宽一点" data-i18n-title="宽一点">+</button>
        <button type="button" class="set-link" id="setReadReset" data-i18n="默认">默认</button>
      </div>
      <div class="set-hint" data-i18n="Markdown 正文在宽窗口下居中的最大宽度（编辑与预览都按这个来）。窗口或分栏不够宽时自动收回到两侧留白，专注模式在此基础上再收 8%。">Markdown 正文在宽窗口下居中的最大宽度（编辑与预览都按这个来）。窗口或分栏不够宽时自动收回到两侧留白，专注模式在此基础上再收 8%。</div>
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="界面">界面</div>
      <label class="set-row"><input type="checkbox" id="setOutline" ${settings.outlineVisible ? 'checked' : ''} /> <span data-i18n="显示大纲 / 文件栏">显示大纲 / 文件栏</span></label>
      <label class="set-row"><input type="checkbox" id="setSplit" ${settings.layout === 'split' ? 'checked' : ''} /> <span data-i18n="双栏（编辑 + 预览）">双栏（编辑 + 预览）</span></label>
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="文件">文件</div>
      <label class="set-row"><input type="checkbox" id="setAutoSave" ${settings.autoSave ? 'checked' : ''} /> <span data-i18n="自动保存（停手约 1 秒写盘）">自动保存（停手约 1 秒写盘）</span></label>
      <label class="set-row"><input type="checkbox" id="setWatch" ${settings.watchFiles !== false ? 'checked' : ''} /> <span data-i18n="监听磁盘改动（别的程序改了文件时提示）">监听磁盘改动（别的程序改了文件时提示）</span></label>
      <div class="set-row folder">
        <span class="set-folder" id="setFolder"></span>
        <button type="button" class="mini" id="setPickFolder" data-i18n="选择…">选择…</button>
        <button type="button" class="mini ghost" id="setClearFolder" data-i18n="清除">清除</button>
      </div>
      <div class="set-hint" data-i18n="当前打开的文件夹，用于左侧「文件」页浏览与搜索。">当前打开的文件夹，用于左侧「文件」页浏览与搜索。</div>
    </div>

    <div class="set-group">
      <div class="set-label" data-i18n="快捷键">快捷键</div>
      <div class="keys-list" id="setKeysList"></div>
      <div class="set-hint" data-i18n="点「改」后直接按新的组合键（要带 Ctrl / Alt，或单用 F1–F12），Esc 取消。自定义优先于默认键位。">点「改」后直接按新的组合键（要带 Ctrl / Alt，或单用 F1–F12），Esc 取消。自定义优先于默认键位。</div>
    </div>

    <div class="set-foot">
      <button type="button" class="mini ghost" id="setReset" data-i18n="恢复默认设置">恢复默认设置</button>
    </div>
  `;
  applyDom(box);

  const paintFolder = () => {
    const n = box.querySelector('#setFolder');
    if (!n) return;
    n.textContent = settings.folder || tt('未打开文件夹');
    n.title = settings.folder || '';
    n.classList.toggle('faint', !settings.folder);
  };
  paintFolder();
  paintKeyList(box.querySelector('#setKeysList'));

  box.querySelector('#setLang').onchange = (e) => {
    settings.lang = e.target.value;
    saveSettings();
    applyLang();      // applyDom 顺带把这块还开着的面板翻掉
    /* dialog() 的标题和按钮文案是一次性写死的，applyDom 管不到（#dlgTitle 没有、
       也不能有 data-i18n —— 每个对话框的标题都不一样），这里就地补一次；
       快捷键列表的命令名同样是渲染时才取词，重画一遍 */
    const dt = document.getElementById('dlgTitle');
    if (dt) dt.textContent = tt('设置');
    const ok = document.querySelector('#dlgFoot button.primary');
    if (ok) ok.textContent = tt('完成');
    paintKeyList(box.querySelector('#setKeysList'));
    paintFolder();
  };

  box.querySelectorAll('.set-seg button').forEach((b) => {
    b.onclick = () => {
      settings.theme = b.dataset.v;
      saveSettings();
      applyTheme();
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  box.querySelectorAll('[data-zoom]').forEach((b) => {
    b.onclick = () => {
      zoom(Number(b.dataset.zoom));
      box.querySelector('#setFontSize').textContent = `${settings.fontSize} px`;
    };
  });
  box.querySelector('#setFontReset').onclick = () => {
    settings.fontSize = DEFAULTS.fontSize;
    saveSettings();
    applyFont();
    box.querySelector('#setFontSize').textContent = `${DEFAULTS.fontSize} px`;
  };
  box.querySelectorAll('[data-rw]').forEach((b) => {
    b.onclick = () => {
      const next = (Number(settings.readWidth) || DEFAULTS.readWidth) + Number(b.dataset.rw) * READ_W_STEP;
      settings.readWidth = Math.min(READ_W_MAX, Math.max(READ_W_MIN, next));
      saveSettings();
      applyReadWidth();
      box.querySelector('#setReadWidth').textContent = `${settings.readWidth} px`;
    };
  });
  box.querySelector('#setReadReset').onclick = () => {
    settings.readWidth = DEFAULTS.readWidth;
    saveSettings();
    applyReadWidth();
    box.querySelector('#setReadWidth').textContent = `${DEFAULTS.readWidth} px`;
  };
  box.querySelector('#setOutline').onchange = (e) => {
    settings.outlineVisible = e.target.checked;
    saveSettings();
    updateOutline();
  };
  box.querySelector('#setWatch').onchange = (e) => {
    settings.watchFiles = e.target.checked;
    saveSettings();
    syncWatches();
    toast(settings.watchFiles ? tt('已开启磁盘改动监听') : tt('已关闭磁盘改动监听'));
  };
  box.querySelector('#setSplit').onchange = (e) => {
    setLayout(e.target.checked ? 'split' : 'single');
    updateStatus();
  };
  box.querySelector('#setAutoSave').onchange = (e) => {
    settings.autoSave = e.target.checked;
    saveSettings();
    toast(settings.autoSave ? tt('自动保存已开启') : tt('自动保存已关闭'));
  };
  box.querySelector('#setPickFolder').onclick = async () => {
    await pickFolder();
    paintFolder();
  };
  box.querySelector('#setClearFolder').onclick = () => { clearFolder(); paintFolder(); };
  box.querySelector('#setReset').onclick = async () => {
    const ok = await confirmBox(tt('恢复默认设置'), tt('主题、字号、正文宽度、布局、自动保存都会回到出厂状态，文件夹设置也会清空。<br><br>确定？'), tt('恢复'), tt('取消'));
    if (!ok) return;
    /* 直接铺 DEFAULTS：字段增删只维护一处，不会漏项。
       keymap / lastMode 必须换成新对象 —— 否则 settings 和 DEFAULTS 共用同一份引用，
       以后改自定义键位会反过来改掉默认值 */
    Object.assign(settings, DEFAULTS, { keymap: {}, lastMode: {} });
    saveSettings();
    applyTheme();
    applyFont();
    setLayout(settings.layout);
    updateOutline();
    clearFolder();
    paintFolder();
    paintKeyList(box.querySelector('#setKeysList'));
    box.querySelector('#setFontSize').textContent = `${settings.fontSize} px`;
    box.querySelector('#setReadWidth').textContent = `${settings.readWidth} px`;
    box.querySelectorAll('.set-seg[data-name="theme"] button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'auto'));
    box.querySelector('#setOutline').checked = true;
    box.querySelector('#setSplit').checked = false;
    box.querySelector('#setAutoSave').checked = true;
    box.querySelector('#setLang').value = settings.lang;
    applyLang();
    toast(tt('已恢复默认设置'));
  };

  dialog({ title: tt('设置'), body: box, buttons: [{ id: 'ok', label: tt('完成'), primary: true }] });
}

/* ---------------- 状态栏 ---------------- */
/** 统计行数 / 字数 / 字符数：**单趟扫描，不分配中间数组**。
 *  原先用 split('\n') + 两个全局 match，10MB 文档上要 125ms、还要为 18 万个
 *  行号造一批临时字符串（GC 也跟着抖）；改成一次 charCodeAt 扫描只要 39ms。
 *  口径与原来逐字对齐：行数 = 换行数 + 1，字数 = 中日韩单字 + ASCII 连续段。 */
function countStats(text) {
  let lines = 1;
  let words = 0;
  let run = false;          // 是否正处在一段 ASCII 词里
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) lines++;
    if (c >= 0x4e00 && c <= 0x9fa5) {      // 中日韩统一表意文字：一字一词
      words++;
      run = false;
    } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c === 95 || c === 45 || c === 39) {   // 0-9 A-Z a-z _ ' -
      if (!run) { words++; run = true; }
    } else {
      run = false;
    }
  }
  return { lines, words, chars: text.length };
}

function refreshStats() {
  const t = activeTab();
  if (!t) return;
  /* 渐进载入进行中别覆盖「载入中…」：大文档上这次调用会落在载入冻结期，
     把进度文字冲掉后，完成前的状态栏就一直是假数据 */
  if (wys.loading) return;
  const { lines, words, chars } = countStats(t.content);
  el.stLines.textContent = tt('{n} 行', { n: lines });
  el.stWords.textContent = tt('{w} 字 · {c} 字符', { w: words, c: chars });
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
    el.stPos.textContent = tt('行 {line}，列 {col}', { line: c.line, col: c.col });
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
  el.stDraft.textContent = isDirty(t) ? tt('未保存') : tt('已保存');
  el.stDraft.classList.toggle('dirty', isDirty(t));
  renderTabs();
}

/* ---------------- 草稿 ---------------- */
let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

/* 草稿存**所有**脏标签，不再是「只存当前这个」。
   旧实现有两个致命处：切到一个干净的已保存文件时走 `LS.del('draft')`，
   把上一个标签的草稿顺手删了；退出时也只看得见活动标签，其余标签的改动
   连声招呼都不打就没了。 */
const DRAFT_MAX_BYTES = 4 * 1024 * 1024;   // localStorage 一般 5MB，给设置和会话留余量

function saveDraft() {
  const session = tabs.map((t) => ({
    path: t.path, name: t.name, mode: t.mode,
    scrollTop: t.scrollTop || 0, previewScroll: t.previewScroll || 0, caret: t.caret ?? null,
  }));
  LS.set('session', session);
  const act = activeTab();
  LS.set('sessionActive', act ? (act.path || act.name) : '');

  const dirty = tabs.filter(isDirty);
  if (!dirty.length) { LS.del('drafts'); LS.del('draft'); return; }
  /* 容量不够时从最前面的开始放弃：最近改的那个一定保得住 */
  let budget = DRAFT_MAX_BYTES;
  const list = [];
  for (let i = dirty.length - 1; i >= 0; i--) {
    const t = dirty[i];
    const size = (t.content || '').length * 2;   // UTF-16 粗算
    if (size > budget) continue;
    budget -= size;
    list.unshift({
      path: t.path, name: t.name, content: t.content,
      encoding: t.encoding, bom: t.bom, eol: t.eol, mode: t.mode,
      scrollTop: t.scrollTop || 0, caret: t.caret ?? null, time: Date.now(),
    });
  }
  LS.set('drafts', list);
  LS.del('draft');            // 老版本的单份草稿键，读完就清掉
}

/* 返回恢复了几份。没有草稿返回 0 */
async function restoreDrafts() {
  /* 老版本只有一个 draft 对象，读到就升级成数组 */
  const list = LS.get('drafts', null) || (LS.get('draft', null) ? [LS.get('draft')] : []);
  if (!list.length) return 0;

  const valid = [];
  for (const d of list) {
    if (!d || !d.content) continue;
    if (d.path) {
      /* 磁盘内容和草稿一样 → 其实已经存过了，不算未保存（两边都按 LF 比） */
      try { const r = await be.readText(d.path); if (toLF(r.content) === toLF(d.content)) continue; } catch {}
      valid.push(d);
    } else if (d.content.trim()) {
      valid.push(d);           // 未命名文档：有字就值得留
    }
  }
  if (!valid.length) { LS.del('drafts'); LS.del('draft'); return 0; }

  const names = valid.map((d) => `<b>${d.name}</b>`).join('、');
  const when = new Date(valid[valid.length - 1].time || Date.now()).toLocaleString();
  const keep = await confirmBox(
    valid.length === 1 ? tt('恢复上次的草稿') : tt('恢复 {n} 份未保存的内容', { n: valid.length }),
    tt('上次关闭时（{when}）还有没保存的内容：{names}。<br><br>是否全部恢复？', { when, names }),
    tt('恢复'), tt('丢弃')
  );
  if (!keep) { LS.del('drafts'); LS.del('draft'); return 0; }

  for (const d of valid) {
    const t = newTab(d.name, d.content, d.path, {
      encoding: d.encoding || 'UTF-8', bom: !!d.bom, eol: d.eol || 'LF', mode: d.mode,
      scrollTop: d.scrollTop || 0, caret: d.caret ?? null,
    });
    /* 恢复出来的内容要和磁盘比，而不是和它自己比 —— 否则一打开就是「已保存」，
       关窗时也不会提醒，等于把草稿又还回去了 */
    t.savedContent = '';
    if (d.path) {
      try { const r = await be.readText(d.path); t.savedContent = toLF(r.content); } catch {}
    }
  }
  renderTabs();
  LS.del('drafts'); LS.del('draft');
  saveDraft();          // 恢复过程中 activate 覆盖过 session，这里写回完整状态
  toast(valid.length === 1 ? tt('草稿已恢复') : tt('已恢复 {n} 份草稿', { n: valid.length }));
  return valid.length;
}

/* 按会话里的顺序重开标签，并把光标/滚动位置放回去 */
async function restoreSession() {
  const session = LS.get('session', null);
  if (!Array.isArray(session) || !session.length) return 0;
  const activeKey = LS.get('sessionActive', '');
  let n = 0;
  let last = null;
  let activeId2 = null;
  for (const s of session) {
    if (!s || !s.path) continue;            // 未命名的走草稿那条路
    const t = await openPath(s.path);
    if (!t) continue;
    if (s.mode && modesFor(detectKind(t.name)).includes(s.mode)) t.mode = s.mode;
    t.scrollTop = s.scrollTop || 0;
    t.previewScroll = s.previewScroll || 0;
    t.caret = s.caret ?? null;
    n++;
    last = t;
    if (s.path === activeKey) activeId2 = t.id;
  }
  const goal = activeId2 || (last && last.id);
  if (goal) activate(goal);
  return n;
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
/* 正在检查的标签 id：事件密集时别给同一个文件弹两次窗。
   以前这里是「全局一个锁」，多标签场景下会让别的标签被整个跳过。 */
const extChecking = new Set();
async function checkExternalChange(tab) {
  const t = tab || activeTab();
  if (!t || !t.path || t.mtime == null || extChecking.has(t.id)) return;
  extChecking.add(t.id);
  t.extChanged = false;
  try {
    const m = await be.fileMtime(t.path);
    if (m == null || m === t.mtime) return;
    if (!isDirty(t)) {
      await reloadTab(t, m);
      toast(tt('文件已在磁盘上更新，已重新载入'));
      return;
    }
    const reload = await confirmBox(
      tt('文件已在外部修改'),
      tt('<b>{name}</b> 在打开之后被其他程序改过。<br><br>重新载入会丢掉你这里的修改。', { name: t.name }),
      tt('重新载入'), tt('保留我的')
    );
    if (!reload) return;
    await reloadTab(t, m);
    toast(tt('已重新载入'));
  } catch {
    /* 读不到就算了：真正的失败留给保存时报错，别在这里弹窗打扰 */
  } finally {
    extChecking.delete(t.id);
    renderTabs();
  }
}

/* ---------------- 文件变化监听 ----------------
   后端只盯着「已打开文档所在目录」那一层，并且只放行我们关心的文件名，
   所以这里收到的事件是稀疏的。仍然做一层 250ms 合并：一次保存常被拆成
   「截断 + 写 + 改属性」好几个事件。 */

let watchTimer = 0;
/** 把当前打开的文件列表同步给后端；频繁开关标签时合并成一次调用 */
function syncWatches() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const paths = settings.watchFiles === false ? [] : tabs.filter((t) => t.path).map((t) => t.path);
    be.watchFiles(paths).catch(() => { /* 监听不上不影响任何编辑功能 */ });
  }, 300);
}

let fsTimer = 0;
const fsQueue = new Set();
function onFsChange(paths) {
  if (settings.watchFiles === false) return;
  for (const p of paths || []) fsQueue.add(p);
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => {
    const list = [...fsQueue];
    fsQueue.clear();
    for (const p of list) {
      const t = tabs.find((x) => x.path === p);
      if (!t) continue;
      if (activeTab() && activeTab().id === t.id) checkExternalChange(t);
      /* 后台标签不弹窗：人正在另一个文件里写字，这时候弹框只会被当成噪声。
         先挂个标记，标签上冒出小圆点，切过去的那一刻再问。 */
      else { t.extChanged = true; renderTabs(); }
    }
  }, 250);
}

/** 把磁盘上的最新内容装回标签（不动 mtime 就让下一次检查又弹一遍） */
async function reloadTab(t, mtime) {
  const r = await be.readText(t.path);
  t.mtime = mtime;
  t.encoding = r.encoding;
  t.eol = r.eol;
  t.bom = r.bom;
  t.content = toLF(r.content);
  t.savedContent = t.content;
  if (activeTab() && activeTab().id === t.id) setContent(t.content);
  else updateStatus();
}

/* ---------------- 文件操作 ---------------- */
export async function openPath(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    /* 已是当前标签就别再 activate —— activate 会整篇重渲染，
       大文档等于白白重载好几秒 */
    const act = activeTab();
    if (!act || act.id !== existing.id) activate(existing.id);
    return existing;
  }
  try {
    const r = await be.readText(path);
    // 先拿到修改时间再建标签：否则「刚打开就被自己当成外部改动」
    const mtime = await be.fileMtime(path).catch(() => null);
    const t = newTab(r.name, toLF(r.content), r.path, { encoding: r.encoding, bom: r.bom, eol: r.eol, mtime });
    addRecent(path);
    return t;
  } catch (e) {
    dialog({ title: tt('无法打开'), body: errText(e) });
    return null;
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
    syncWatches();                    // 文件落到了新目录，监听要跟过去
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
          tt('文件已被其他程序修改'),
          tt('磁盘上的 <b>{name}</b> 在打开之后被改过，保存会覆盖那些改动。', { name: t.name }),
          tt('仍然覆盖'), tt('取消')
        );
        if (!overwrite) return false;
      }
    }
    /* 落盘之前先留一份旧的：一键格式化、排序去重、批量替换之后想反悔，
       撤销栈未必翻得回去（还有 8MB 上限），这是最后一道 */
    if (t.savedContent && t.savedContent !== t.content) {
      await be.saveHistory(t.path, t.savedContent).catch(() => {});
    }
    await be.saveText({ path: t.path, content, encoding: t.encoding, bom: t.bom });
    t.savedContent = t.content;
    t.mtime = await be.fileMtime(t.path).catch(() => t.mtime);
    saveDraft();               // 这个标签干净了，把它从草稿堆里摘掉
    addRecent(t.path);
    updateStatus();
    if (!silent) toast(tt('已保存 {name}', { name: t.name }));
    return true;
  } catch (e) {
    dialog({ title: tt('保存失败'), body: errText(e) });
    return false;
  }
}

const saveTabAs = (t) => saveTab(t, true);

/* 我们自己已经确认过一次关闭时，让 close-requested 直接放行，避免二次弹窗 */
let forceClose = false;
/* 选了「不保存退出」：连草稿兜底也跳过（beforeunload 里的 saveDraft 要看它） */
let discardOnQuit = false;

/* 退出前把**所有**标签看一遍。以前只检查活动标签：开三个未命名文档各写一段，
   退出时只有一个进了草稿，其余静默消失。
   返回：false=取消；'discard'=不保存退出（调用方须跳过 saveDraft）；true=正常放行。 */
async function confirmQuit() {
  const dirty = tabs.filter(isDirty);
  if (!dirty.length) return true;
  const names = dirty.map((t) => `<b>${t.name}</b>`).join('、');
  const noPath = dirty.filter((t) => !t.path).length;
  const r = await dialog({
    title: tt('还有未保存的内容'),
    body: tt('{n} 个标签有未保存的修改：{names}。', { n: dirty.length, names })
      + (noPath ? tt('<br><br>其中 {n} 个还没保存过文件：「全部保存并退出」会把它们存成草稿，下次启动可恢复；「不保存退出」则连同丢弃。', { n: noPath }) : '')
      + tt('<br><br>要如何处理？'),
    buttons: [
      { id: 'save', label: tt('全部保存并退出'), primary: true },
      { id: 'discard', label: tt('不保存退出') },
      { id: 'cancel', label: tt('取消') },
    ],
  });
  if (r === 'cancel') return false;
  if (r === 'discard') return 'discard';
  await saveAllQuiet(dirty);
  return true;
}

/** 统一的「确认完、准备关窗」收尾：discard 时连草稿也不留 */
function finishQuit(ok) {
  if (ok === 'discard') discardOnQuit = true;
  else saveDraft();
  forceClose = true;
}

/* 批量保存不能走 saveTab()：它靠 readEditor(t) 取内容，而那只对屏幕上那个
   标签成立，拿去写别的文件就是把 A 的正文灌进 B。这里统一用各标签自己的
   t.content（切走时已经同步过）。写不进去的（文件被外部改过 / 权限不足）
   不阻塞退出，交给草稿兜底。 */
async function saveAllQuiet(list) {
  for (const t of list) {
    if (!t.path) continue;
    try {
      const cur = await be.fileMtime(t.path).catch(() => null);
      if (t.mtime != null && cur != null && cur !== t.mtime) continue;   // 被别处改过，不覆盖
      const content = t.eol === 'CRLF'
        ? t.content.replace(/\r?\n/g, '\r\n')
        : t.content.replace(/\r\n?/g, '\n');
      await be.saveText({ path: t.path, content, encoding: t.encoding, bom: t.bom });
      t.savedContent = t.content;
      t.mtime = cur;
    } catch { /* 留给草稿 */ }
  }
  renderTabs();
  updateStatus();
}

async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (isDirty(t)) {
    persistCurrentView();
    const r = await dialog({
      title: tt('未保存的修改'),
      body: tt('<b>{name}</b> 有未保存的修改，要保存吗？', { name: t.name }),
      buttons: [
        { id: 'save', label: tt('保存'), primary: true },
        { id: 'discard', label: tt('不保存') },
        { id: 'cancel', label: tt('取消') },
      ],
    });
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveTab(t))) return;
  }
  const wasActive = activeTab() && activeTab().id === id;
  removeTab(id);
  syncWatches();
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
  items.push({ id: 'clearRecent', label: tt('清除记录') });
  return [{ sep: true }, { head: tt('最近打开') }, ...items];
}

/* ---------------- 内容读写 ---------------- */
/* 内存里的内容统一 LF 表示。磁盘上的 CRLF 只留在 t.eol 这个标记上，保存时按它写回
   （saveTab 已有 normalize）。不这样做的话，模式切换时 readEditor 序列化出的 LF
   会和 savedContent 里的 CRLF 对不上 —— 刚打开、一个字没动的文件立刻亮脏标记，
   只能靠保存一次才消掉。 */
const toLF = (s) => s.replace(/\r\n?/g, '\n');

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
  if (t.mode === 'wysiwyg') renderWys(text, opts.caret);
  else plain.value = text;
  schedulePreview();
  scheduleStats();     // 大文档下全文字数统计不便宜，走防抖不挡打开
  scheduleOutline();   // 大纲同理：提取 + 上万按钮的构建不挡打开
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
  if (t.mode !== 'edit') { toast(tt('预览模式下不能编辑')); return; }
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
  if (t.mode === 'preview') { toast(tt('预览模式下不能编辑，请切换到编辑模式')); return false; }
  return true;
}

/** 块级格式命令只在「所见即所得」模式下有意义 */
function wysCmd(fn) {
  const t = activeTab();
  if (!t) return;
  if (t.mode !== 'wysiwyg') { toast(tt('该操作请在「所见即所得」模式下使用')); return; }
  fn(wys);
}

/** 表格列对齐 */
function alignColumn(w, align) {
  if (!w.isInTable()) { toast(tt('请先把光标放进表格')); return; }
  w.setColAlign(align);
  const alignWord = { left: tt('左对齐'), center: tt('居中'), right: tt('右对齐') };
  toast(align ? tt('本列已{how}', { how: alignWord[align] }) : tt('本列已取消对齐'));
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
  if (t.mode !== 'wysiwyg') { toast(tt('插入表格请在「所见即所得」模式下使用')); return; }
  const saved = saveRange();
  const box = document.createElement('div');
  box.innerHTML = '<div class="dlg-text">' + tt('行数（含表头）与列数：') + '</div>'
    + '<div class="dlg-row">'
    + '<input class="dlg-input" id="tblRows" value="3">'
    + '<span>' + tt('行') + '</span>'
    + '<input class="dlg-input" id="tblCols" value="3">'
    + '<span>' + tt('列') + '</span>'
    + '</div>';
  dialog({ title: tt('插入表格'), body: box, buttons: [{ id: 'ok', label: tt('插入'), primary: true }, { id: 'cancel', label: tt('取消') }] })
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
  if (t.mode !== 'wysiwyg') { toast(tt('插入链接请在「所见即所得」模式下使用')); return; }
  const saved = saveRange();
  const box = document.createElement('div');
  box.innerHTML = '<div class="dlg-text">' + tt('链接地址：') + '</div><input class="dlg-input" id="linkInput" value="https://">';
  dialog({ title: tt('插入链接'), body: box, buttons: [{ id: 'ok', label: tt('插入'), primary: true }, { id: 'cancel', label: tt('取消') }] })
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
  if (t.mode !== 'wysiwyg') { toast(tt('插入图片请在「所见即所得」模式下使用')); return; }
  const saved = saveRange();
  const pick = await dialog({
    title: tt('插入图片'),
    body: tt('本地图片会复制到文档同目录的 <b>assets/</b> 下，用相对路径引用；也可以直接给一个网络地址。'),
    buttons: [
      { id: 'local', label: tt('选择本地图片…'), primary: true },
      { id: 'url', label: tt('网络地址…') },
      { id: 'cancel', label: tt('取消') },
    ],
  });

  if (pick === 'local') {
    if (!t.path) { toast(tt('请先保存文档，图片要放进它同目录的 assets/')); return; }
    const src = await be.pickImage();
    if (!src) return;
    try {
      const rel = await be.copyImageToAssets(src, t.path);
      restoreRange(saved);
      wys.insertImage(rel, '');
      toast(tt('图片已复制到 assets/'));
    } catch (e) {
      toast(tt('插入失败：') + e);
    }
    return;
  }

  if (pick === 'url') {
    const box = document.createElement('div');
    box.innerHTML = '<div class="dlg-text">' + tt('图片地址：') + '</div><input class="dlg-input" id="imgInput" value="https://">';
    const ok = await dialog({ title: tt('图片地址'), body: box, buttons: [{ id: 'ok', label: tt('插入'), primary: true }, { id: 'cancel', label: tt('取消') }] });
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
  if (!t.path) { toast(tt('请先保存文档，图片要放进它同目录的 assets/')); return; }
  if (t.readonly) { toast(tt('当前标签是只读的')); return; }
  try {
    const ext = (String(file.type || '').split('/')[1] || 'png').replace(/^jpeg$/, 'jpg');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rel = await be.saveImageBytes(t.path, bytes, ext);
    // 截图这类没有文件名，alt 留空即可（Markdown 里就是 ![](assets/x.png)）
    placeImageRef(rel);
    toast(tt('图片已存入 assets/'));
  } catch (e) {
    toast(tt('插入图片失败：') + e);
  }
}

/* ---------------- 目录 ---------------- */

/** 标题文字进方括号前要清掉会截断链接语法的字符 */
const tocLabel = (s) => s.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim() || tt('（无标题）');

/**
 * 插入目录：扫一遍标题，按层级缩进成 Markdown 列表。
 * 锚点用的是一套和渲染时完全相同的 slug 规则，所以 [标题](#slug) 在预览里能直接跳。
 * 位置：光标在第一块就插到文首，否则插在光标所在块之后。
 */
function insertToc() {
  const t = activeTab();
  if (!t) return;
  if (t.mode === 'preview') { toast(tt('预览模式是只读的，Ctrl+1 或 Ctrl+2 之后再插入')); return; }
  const heads = outlineFromMarkdown(readEditor(t));
  if (!heads.length) { toast(tt('这篇还没有标题，先用 # 写几行小标题')); return; }
  const slugs = headingSlugs(heads.map((h) => h.text));
  const min = Math.min(...heads.map((h) => h.level));
  const md = heads
    .map((h, i) => `${'  '.repeat(Math.max(0, h.level - min))}- [${tocLabel(h.text)}](#${slugs[i]})`)
    .join('\n');
  if (canWys()) {
    const b = wys.currentBlock();
    wys.insertMarkdown(md, !!(b && b === wys.root.firstElementChild));
  } else {
    plain.insertText(md + '\n');
  }
  toast(tt('已插入目录：{n} 个标题', { n: heads.length }));
}

/** 跳文档内锚点：目录里的 [标题](#slug) 走这条 */
function gotoAnchor(href) {
  const slug = decodeURIComponent(String(href).slice(1));
  if (!slug) return;
  const t = activeTab();
  if (!t) return;
  const esc = window.CSS && CSS.escape ? CSS.escape(slug) : slug.replace(/["\\]/g, '\\$&');

  if (t.mode === 'preview') {
    const node = el.preview.querySelector(`[id="${slug.replace(/["\\]/g, '\\$&')}"]`) || el.preview.querySelector('#' + esc);
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else toast(tt('找不到这一节'));
    return;
  }
  if (canWys()) {
    const block = wys.findHeadingBySlug(slug);
    if (!block) { toast(tt('找不到这一节')); return; }
    wys.focusBlock(block);
    block.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  // 编辑模式：源码里数一下第几个标题，再滚到那一行
  const heads = outlineFromMarkdown(plain.value);
  const i = headingSlugs(heads.map((h) => h.text)).indexOf(slug);
  if (i < 0) { toast(tt('找不到这一节')); return; }
  plain.scrollToLine(heads[i].line + 1);
}

/** Ctrl/⌘+点击正文里的链接：外链交给系统浏览器，相对路径当文件打开 */
async function openExternal(href) {
  const u = String(href || '').trim();
  if (!u) return;
  if (/^(https?:|mailto:|tel:)/i.test(u)) {
    try {
      const { openUrl } = await import('../vendor/plugin-opener/dist-js/index.js');
      await openUrl(u);
    } catch { toast(tt('无法打开链接')); }
    return;
  }
  if (u.startsWith('#')) { gotoAnchor(u); return; }
  const t = activeTab();
  const base = t && t.path ? be.dirName(t.path) : '';
  const p = /^([a-zA-Z]:[\\/]|[\\/])/.test(u) ? u : `${base}/${u}`;
  try { await openPath(p); } catch { toast(tt('打不开：') + p); }
}

/* ---------------- 新建文档：先选类型 ---------------- */
const newTypes = () => [
  { ext: 'md', name: 'Markdown', desc: tt('所见即所得写作') },
  { ext: 'txt', name: tt('纯文本'), desc: tt('记事 / 日志') },
  { ext: 'json', name: 'JSON', desc: tt('校验 + 高亮') },
  { ext: 'csv', name: 'CSV', desc: tt('表格文本') },
  { ext: 'js', name: 'JavaScript', desc: tt('代码高亮') },
  { ext: 'ts', name: 'TypeScript' },
  { ext: 'py', name: 'Python' },
  { ext: 'html', name: 'HTML' },
  { ext: 'css', name: 'CSS' },
  { ext: 'sh', name: tt('Shell 脚本') },
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
  newTypes().forEach((ty) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'new-type' + (ty.ext === last ? ' active' : '');
    b.dataset.dialogClose = ty.ext;
    b.innerHTML = `<b>${ty.name}</b><small>.${ty.ext}${ty.desc ? ' · ' + ty.desc : ''}</small>`;
    box.appendChild(b);
  });
  const picked = await dialog({
    title: tt('新建文档'),
    body: box,
    buttons: [
      { id: last, label: tt('新建 {type}', { type: newTypes().find((t) => t.ext === last)?.name || 'Markdown' }), primary: true },
      { id: 'cancel', label: tt('取消') },
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
    renderWys(fn(md));
    toast(tt('{op}已应用', { op: label }));
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
  if (next === backup) { toast(tt('内容没有变化')); return; }
  setContent(next);
  if (hasSel) plain.setSelection(s, s + out.length);
  undoToast(tt('{op}已应用（{scope}）', { op: label, scope: hasSel ? tt('选区') : tt('全文') }), backup);
}

function formatDoc() {
  const t = activeTab();
  if (!t || !requireEditMode()) return;
  t.content = readEditor(t);
  const kind = detectKind(t.name);
  const backup = t.content;
  try {
    const r = formatByKind(kind, t.content);
    if (r.text === t.content) { toast(tt('已经是最佳格式，无需调整')); return; }
    setContent(r.text);
    const notes = r.notes && r.notes.length ? `（${r.notes.join('、')}）` : '';
    undoToast(tt('已格式化{notes}', { notes }), backup);
  } catch (e) {
    const loc = e.line ? tt('第 {line} 行第 {col} 列', { line: e.line, col: e.col }) : '';
    dialog({ title: tt('无法格式化'), body: tt('文件中存在语法错误，已保持原样。<br><br><b>{loc}</b><br><span style="font-family:var(--font-mono);font-size:12px">{msg}</span>', { loc, msg: String(e.message) }) });
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
  btn.textContent = tt('撤销');
  btn.style.cssText = 'border:none;background:var(--accent);color:#fff;border-radius:0;padding:2px 10px;font-size:11.5px;cursor:pointer';
  btn.onclick = () => { setContent(backup); box.remove(); toast(tt('已撤销')); };
  box.append(span, btn);
  wrap.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 300); }, 6000);
}

/* ---------------- 查找替换 ---------------- */
/* 两套匹配结果：
     · 编辑模式查的是 Markdown 源码，位置就是字符偏移；
     · 所见即所得查的是渲染后的 DOM，位置是「第几个块 + 块内偏移」。
   以前在所见即所得按 Ctrl+F 会被强行踢到编辑模式——查个词结果模式没了，
   现在两套并存，替换才需要回源码（改 DOM 会破坏行内样式）。 */
const find = { matches: [], index: 0, dom: false };

/* 输入框按内容长高：一行起步，插了换行就多一行，到四行封顶后内部滚动。
   查找框改成 textarea 是为了能看见换行——单行 input 里塞不进换行符，
   用户根本无从判断自己查的是「两个词」还是「跨行」。 */
function autoGrow(ta) {
  if (!ta) return;
  const MAX = 88;                       // ≈ 四行
  ta.style.height = 'auto';
  const h = Math.min(MAX, ta.scrollHeight || 26);
  ta.style.height = `${h}px`;
  ta.style.overflowY = (ta.scrollHeight || 0) > MAX ? 'auto' : 'hidden';
}

/* 在光标处插一个换行。IE 时代的 execCommand 不用管，textarea 手动切最稳 */
function insertNewlineIn(ta) {
  const a = ta.selectionStart ?? ta.value.length;
  const b = ta.selectionEnd ?? a;
  ta.value = `${ta.value.slice(0, a)}\n${ta.value.slice(b)}`;
  ta.selectionStart = a + 1;
  ta.selectionEnd = a + 1;
  autoGrow(ta);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

/* 折叠 = 只查找，展开 = 多一行替换。箭头转 90°，和展开语义一致 */
function setFindExpanded(on) {
  el.findbar.classList.toggle('expanded', !!on);
  $('findReplaceRow').classList.toggle('hidden', !on);
  $('findExpand').setAttribute('aria-expanded', on ? 'true' : 'false');
  $('findExpand').title = on ? tt('收起替换（Ctrl+F）') : tt('展开替换（Ctrl+H）');
  if (on) autoGrow($('replaceInput'));
}

/**
 * 文本对比改成独立窗口：两栏并排 + 侧边预览条，塞在主窗口的浮层里
 * 宽度永远不够（两栏各要 600 起步）。
 * 不在打开时自动填左侧：想比的是哪两个文件，只有用户自己知道 ——
 * 把当前文件塞进左槽只会让人先把它清掉。两侧都空着，选文件或直接粘文本。
 */
function openCompareWindow() {
  be.openCompareWindow(null, null).catch((e) => toast(tt('打不开对比窗口：') + e));
}

/**
 * @param {boolean} [expand] true 展开替换行 / false 收起 / 不传则保持现状
 *   ——Ctrl+F 只管聚焦，不该把用户已经展开的替换行收回去。
 */
function openFind(expand) {
  const t = activeTab();
  if (!t) return;
  el.findbar.classList.remove('hidden');
  if (expand != null) setFindExpanded(expand);
  // 「选区内」只在真的选了东西时才可用，否则勾了也没意义还让人困惑
  const sel = t.mode === 'wysiwyg' ? '' : plain.selectedText;
  $('findScope').disabled = !sel;
  if (!sel) $('findScope').checked = false;
  // 选中的文字直接填进查找框（含换行也行，跨块匹配现在支持）
  if (sel && sel.length <= 500) $('findInput').value = sel;
  autoGrow($('findInput'));
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
  let src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /* 整词：只在查询串的头/尾是 ASCII 单词字符时加边界。
     中文没有词边界这回事（"标题" 匹配到 "副标题" 是正常的），
     硬套 \b 只会让中文查询永远匹配不到。 */
  if ($('findWord').checked) {
    if (/^\w/.test(q)) src = '(?<!\\w)' + src;
    if (/\w$/.test(q)) src += '(?!\\w)';
  }
  return new RegExp(src, flags);
}

function setFindCount() {
  $('findCount').textContent = `${find.matches.length ? find.index + 1 : 0}/${find.matches.length}`;
}

/* 在所见即所得里改字之后，旧的高亮范围已经错位。
   停手 300ms 重算一次（DOM 模式下重算不碰选区，不会打断输入）。 */
let findRefreshTimer = 0;
function scheduleFindRefresh() {
  if (!find.dom || el.findbar.classList.contains('hidden')) return;
  clearTimeout(findRefreshTimer);
  findRefreshTimer = setTimeout(() => {
    if (el.findbar.classList.contains('hidden') || !find.dom) return;
    runFind();
  }, 300);
}

function runFind() {
  const t = activeTab();
  const re = buildRegex();
  const prevIndex = find.index;
  find.matches = [];
  find.index = 0;
  if (!t || !re) { setFindCount(); domfind.clear(); return; }

  if (t.mode === 'wysiwyg') {
    find.dom = true;
    if (wys.virtual) {
      /* 视口模式：匹配在块模型上算（DOM 里只有窗口内容），
         跳转时再把对应块搬进窗口、由 DOM 现算高亮范围 */
      find.model = true;
      find.matches = wys.findMatches(re) || [];
    } else {
      find.model = false;
      find.matches = domfind.findInDom(el.wysiwyg, re);
    }
    // 编辑正文触发的刷新不要把人踢回第一处匹配
    find.index = Math.min(prevIndex, Math.max(0, find.matches.length - 1));
  } else {
    find.dom = false;
    const sel = plain.selection;
    const onlySel = $('findScope').checked && sel.to > sel.from;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(t.content))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const a = m.index;
      const b = a + m[0].length;
      if (!onlySel || (a >= sel.from && b <= sel.to)) find.matches.push([a, b]);
      if (find.matches.length > 5000) break;
    }
    // 从光标位置往后数，避免每次都从头开始跳
    const pos = plain.selection.from;
    const idx = find.matches.findIndex(([a]) => a >= pos);
    find.index = idx < 0 ? 0 : idx;
  }
  setFindCount();
  if (find.matches.length) locateMatch();
  else domfind.clear();
}

function locateMatch() {
  const t = activeTab();
  if (!t || !find.matches.length) return;
  if (find.dom) {
    // 高亮交给 CSS Custom Highlight，不动 DOM —— contenteditable 里插 <mark> 会毁掉光标
    if (find.model) {
      const m = find.matches[find.index];
      if (m) wys.scrollToBlockIndex(m.block, true);
      // 只画窗口内的：窗口外的匹配没有 DOM，无法建 Range
      domfind.paint(domfind.findInDom(el.wysiwyg, buildRegex()), -1);
      return;
    }
    domfind.paint(find.matches, find.index);
    domfind.scrollTo(find.matches[find.index], el.wysiwyg);
    return;
  }
  const [a, b] = find.matches[find.index] || [];
  if (a == null) return;
  plain.revealOffset(a, b);
  updateStatus();
}

function findStep(dir) {
  if (!find.matches.length) { runFind(); return; }
  find.index = (find.index + dir + find.matches.length) % find.matches.length;
  setFindCount();
  locateMatch();
}

/** 替换要先回到编辑模式：在渲染后的 DOM 上改字会丢行内样式 */
async function switchToEditForReplace() {
  const t = activeTab();
  if (!t || t.mode !== 'wysiwyg') return true;
  const go = await confirmBox(
    tt('替换需要编辑模式'),
    tt('这一处匹配跨越了加粗、链接这类格式，在所见即所得里直接改会把它们弄乱。<br><br>切到编辑模式（Ctrl+2）继续替换？'),
    tt('切换并替换'), tt('取消')
  );
  if (!go) return false;
  setMode('edit', { fromActivate: true });
  runFind();
  return true;
}

/**
 * 所见即所得里就地替换一处：命中落在同一个文本节点内时直接改这个节点。
 * 行内样式（加粗 / 链接 / 行内代码）是节点边界，没被劈开就不会坏，
 * 改完 flush 一次让 md 重新序列化即可——比弹窗逼用户切模式顺手得多。
 * 命中劈开了一个 <strong> 时才返回 false，交给上层走「切到编辑模式」。
 * @param {boolean} [quiet] 批量时先攒着，最后统一 flush
 */
function replaceInDom(match, rep, quiet) {
  const r = domfind.rangeFor(match);
  if (!r || r.startContainer !== r.endContainer) return false;
  r.deleteContents();
  r.insertNode(document.createTextNode(rep));
  if (!quiet) {
    wys.hCoalesce = false;   // 一次替换 = 一步撤销
    wys.flush();
  }
  return true;
}

async function replaceOne() {
  const t = activeTab();
  if (!t || !find.matches.length) return;
  const rep = $('replaceInput').value;
  if (find.dom) {
    if (replaceInDom(find.matches[find.index], rep)) { runFind(); return; }
    if (!(await switchToEditForReplace())) return;
    if (!find.matches.length) return;
  }
  if (find.dom || !find.matches.length) return;
  const [a, b] = find.matches[find.index];
  setContent(t.content.slice(0, a) + rep + t.content.slice(b));
  runFind();
}

async function replaceAll() {
  const t = activeTab();
  if (!t) return;
  const rep = $('replaceInput').value;

  /* 所见即所得：从后往前就地替换，前面的偏移不会被改动影响。
     跨格式的那几处单独数出来，一个都不剩才不必退回编辑模式。 */
  if (find.dom) {
    const list = find.matches.slice();
    let ok = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (replaceInDom(list[i], rep, true)) ok++;
    }
    if (ok) {
      wys.hCoalesce = false;
      wys.flush();
      runFind();
    }
    const rest = list.length - ok;
    if (!list.length) { toast(tt('没有找到匹配项')); return; }
    if (rest) toast(tt('已替换 {ok} 处；另有 {rest} 处跨越了格式，请切到编辑模式处理', { ok, rest }));
    else toast(tt('已替换 {n} 处', { n: ok }));
    return;
  }

  if (!(await switchToEditForReplace())) return;
  const re = buildRegex();
  if (!re) return;
  const sel = plain.selection;
  const onlySel = $('findScope').checked && sel.to > sel.from;
  let n = 0;
  if (onlySel) {
    // 只动选区那一段，前后原样拼回去（选区外的同名文字不该被牵连）
    const body = t.content.slice(sel.from, sel.to).replace(re, () => (n++, rep));
    if (!n) { toast(tt('选区内没有匹配项')); return; }
    setContent(t.content.slice(0, sel.from) + body + t.content.slice(sel.to));
  } else {
    const next = t.content.replace(re, () => (n++, rep));
    if (!n) { toast(tt('没有找到匹配项')); return; }
    setContent(next);
  }
  toast(tt('已替换 {n} 处', { n }));
  runFind();
}

function closeFind() {
  el.findbar.classList.add('hidden');
  domfind.clear();
  find.matches = [];
}

/** 拖进来的图片文件：走「复制到 assets」那条路，和「插入图片」对话框一致 */
async function insertImageFromPath(p) {
  const t = activeTab();
  if (!t) return false;
  if (!t.path) { toast(tt('请先保存文档，图片要放进它同目录的 assets/')); return true; }
  try {
    const rel = await be.copyImageToAssets(p, t.path);
    placeImageRef(rel);
    toast(tt('图片已存入 assets/'));
  } catch (e) {
    toast(tt('插入图片失败：') + e);
  }
  return true;
}

/* ---------------- 拖拽 / 分栏 ---------------- */

/** 拖入提示：原生通道下 WebView2 不再把外部拖放转成 HTML5 事件，页面收不到
    dragover —— 没有这层提示，用户拖到窗口上只会看到光标变成「禁止」，以为不支持 */
let dropHintEl = null;
function showDropHint(paths) {
  if (!dropHintEl) {
    dropHintEl = document.createElement('div');
    dropHintEl.className = 'drop-hint hidden';
    dropHintEl.appendChild(document.createElement('div')).className = 'drop-hint-box';
    document.body.appendChild(dropHintEl);
  }
  const imgs = (paths || []).filter((p) => be.isImagePath(p));
  const all = (paths || []).length;
  const txt = all && imgs.length === all ? tt('松手插入图片') : tt('松手打开文件');
  dropHintEl.firstChild.textContent = txt;
  dropHintEl.classList.remove('hidden');
}
function hideDropHint() {
  if (dropHintEl) dropHintEl.classList.add('hidden');
}

/** 松手后按扩展名分流：图片进 assets/，其余按文档打开（多个文件 = 多个标签） */
async function dropPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const imgs = list.filter((p) => be.isImagePath(p));
  const docs = list.filter((p) => !be.isImagePath(p));
  if (imgs.length) {
    const t = activeTab();
    if (!t || t.mode === 'preview') toast(tt('预览模式是只读的，Ctrl+1 或 Ctrl+2 之后再插入'));
    else for (const p of imgs) await insertImageFromPath(p);
  }
  for (const p of docs) await openPath(p);
}

/**
 * 文件拖放。窗口配置开着 dragDropEnabled（Tauri 默认值），wry 只在**注册了原生
 * 处理器**时才把 WebView2 的 AllowExternalDrop 关掉（wry-0.57.0/src/webview2/mod.rs:155），
 * 外部拖放于是全部走 onDragDropEvent 给我们**真实磁盘路径** —— 这正是「拖个 .md
 * 进来直接打开」和「拖图片保留原文件名」需要的东西。
 * 以前这里反过来设了 false：那样文件只是普通的 HTML5 drop，dataTransfer.files
 * 有字节没有路径，只能处理图片，拖文档进来啥也做不了。
 * 下面那条 DOM 分支保留作兜底（万一原生通道没注册上），标签内部拖拽换位不带
 * files，不会被它误拦。
 */
function setupDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;   // 标签拖拽换位这类内部拖动有自己的处理器，别插手
    e.preventDefault();          // 后面的 await 之前必须落定，否则默认行为（导航到文件）会跑掉
    const t = activeTab();
    if (!t) return;
    if (t.mode === 'preview') { toast(tt('预览模式是只读的，Ctrl+1 或 Ctrl+2 之后再插入')); return; }
    const imgs = files.filter((f) => /^image\//.test(f.type));
    if (!imgs.length) { toast(tt('拖进来的不是图片；要打开文档请用「文件 → 打开」')); return; }
    for (const f of imgs) await insertImageFromFile(f);
  });

  import('../vendor/api/webview.js').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload || {};
      if (p.type === 'enter') { showDropHint(p.paths); return; }
      if (p.type === 'over') return;
      hideDropHint();                       // leave 和 drop 都要收掉提示
      if (p.type === 'drop') dropPaths(p.paths);
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
  applyReadWidth();
  refreshStats();
}

/* 正文栏宽：只写用户值 --rw，真正生效的 --read-measure 由 CSS 派生
   （专注模式要在用户值上乘 0.92，写死在这里就没法两者同时成立）。
   宽度不够时 CSS 的 max(--read-gutter, …) 会自动退回固定留白，不需要 JS 兜。 */
const READ_W_MIN = 560;
const READ_W_MAX = 1600;
const READ_W_STEP = 40;

function applyReadWidth() {
  const raw = Number(settings.readWidth) || DEFAULTS.readWidth;
  const w = Math.min(READ_W_MAX, Math.max(READ_W_MIN, raw));
  document.documentElement.style.setProperty('--rw', w + 'px');
}

function gotoLinePrompt() {
  const t = activeTab();
  if (!t) return;
  const total = t.content.split('\n').length;
  const box = document.createElement('div');
  box.innerHTML = `<div class="dlg-text">${tt('跳到第几行（1 – {total}）：', { total })}</div>
    <input class="dlg-input" id="gotoInput" value="1">`;
  dialog({ title: tt('跳转到行'), body: box, buttons: [{ id: 'ok', label: tt('跳转'), primary: true }, { id: 'cancel', label: tt('取消') }] })
    .then((r) => {
      if (r !== 'ok') return;
      const n = parseInt(document.getElementById('gotoInput').value, 10);
      if (n >= 1) gotoLine(n - 1);
    });
  setTimeout(() => document.getElementById('gotoInput')?.select(), 40);
}

/* 历史版本：快照住在应用数据目录，回滚一律「开成新标签」或「写回编辑器」，
   这个文件在按 Ctrl+S 之前一个字都不会变 */
function showHistoryPanel() {
  const t = activeTab();
  if (!t) return;
  if (!t.path) { toast(tt('这个文件还没保存过，没有历史版本')); return; }
  showHistory({
    path: t.path,
    onOpen: ({ text, time }) => {
      const d = new Date(time);
      const stamp = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} `
        + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      newTab(tt('历史 · {name}', { name: t.name }), text, null);
      toast(tt('已打开 {when} 的版本，要留下就「另存为」', { when: stamp }));
    },
    onApply: (text) => {
      t.content = text;
      setContent(text);
      updateStatus();
      toast(tt('已写回编辑器，按 Ctrl+S 才会改动文件'));
    },
  });
}

function cycleEol() {
  const t = activeTab();
  if (!t) return;
  t.eol = t.eol === 'LF' ? 'CRLF' : 'LF';
  el.stEOL.textContent = t.eol;
  toast(tt('换行符：{eol}（保存时生效）', { eol: t.eol }));
}

function changeEncoding() {
  const t = activeTab();
  if (!t) return;
  const box = document.createElement('div');
  box.innerHTML = `<div class="dlg-text">${tt('当前编码：')}<b>${t.encoding}</b>${t.bom ? tt('（含 BOM）') : ''}</div>
    <div class="dlg-label">${tt('以其它编码重新解读当前文件')}</div>
    <div class="dlg-row">${['UTF-8', 'GBK', 'UTF-16LE'].map((e) => `<button class="mini" data-reopen="${e}" ${t.path ? '' : 'disabled'}>${tt('按 {enc} 重新打开', { enc: e })}</button>`).join('')}</div>
    <div class="dlg-label">${tt('保存时使用编码')}</div>
    <div class="dlg-row">${['UTF-8', 'GBK', 'UTF-16LE'].map((e) => `<button class="mini${e === t.encoding ? ' primary' : ''}" data-saveenc="${e}">${e}</button>`).join('')}</div>
    <label class="chk" style="margin-top:14px;display:flex"><input type="checkbox" id="bomChk" ${t.bom ? 'checked' : ''}> ${tt('保存时写入 BOM')}</label>`;
  dialog({ title: tt('文件编码'), body: box, buttons: [{ id: 'cancel', label: tt('关闭') }] });
  setTimeout(() => {
    $('dlgBody').querySelectorAll('[data-saveenc]').forEach((b) => {
      b.onclick = () => {
        t.encoding = b.dataset.saveenc;
        t.bom = $('bomChk').checked;
        el.stEncoding.textContent = t.encoding + (t.bom ? ' BOM' : '');
        $('dlgOverlay').classList.add('hidden');
        toast(tt('保存编码：{enc}，保存后生效', { enc: t.encoding }));
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
          toast(tt('已按 {enc} 重新解读', { enc }));
        } catch (e) { toast(tt('重新解读失败')); }
      };
    });
  }, 30);
}

async function reloadCurrent() {
  const t = activeTab();
  if (!t || !t.path) { toast(tt('当前标签没有对应文件')); return; }
  if (isDirty(t) && !(await confirmBox(tt('重新载入'), tt('当前有未保存的修改，重新载入会丢弃它们。继续？')))) return;
  const r = await be.readText(t.path);
  t.encoding = r.encoding;
  t.eol = r.eol;
  t.bom = r.bom;
  setContent(r.content);
  t.savedContent = r.content;
  updateStatus();
  toast(tt('已重新载入'));
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
    title: tt('字数统计'),
    body: `<table class="kbd-table">
      <tr><td>${tt('行数')}</td><td>${lines}</td></tr>
      <tr><td>${tt('段落')}</td><td>${paras}</td></tr>
      <tr><td>${tt('字符（含空格）')}</td><td>${chars}</td></tr>
      <tr><td>${tt('字符（不含空格）')}</td><td>${noSpace}</td></tr>
      <tr><td>${tt('中文汉字')}</td><td>${cjk}</td></tr>
      <tr><td>${tt('英文单词')}</td><td>${words}</td></tr>
      <tr><td>${tt('预计阅读')}</td><td>${tt('约 {n} 分钟', { n: minutes })}</td></tr>
    </table>`,
  });
}

/* 版本号从 tauri.conf.json 读（编译期注入），不在这里写死 ——
   写死就等于每次发版都要记得改第二处，迟早对不上 */
async function showAbout() {
  const v = (await be.appVersion()) || '—';
  dialog({
    title: tt('关于 EZNotepad'),
    body: `<div class="dlg-text">
      <p style="margin-top:0"><b>EZNotepad</b> · ${tt('版本 {v}', { v })}</p>
      <p>${tt('把 Markdown 预览、文本对比、记事本读写，做成一个 10MB 以内、免安装、不联网的小工具。')}</p>
      <p style="color:var(--fg-faint);font-size:12px">${tt('文件只在本机读写，不向任何服务器发送内容。')}</p>
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
  if (t.mode !== 'edit') { toast(tt('预览模式下不能编辑')); return; }
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
    if (!text) { toast(tt('剪贴板是空的')); return; }
    if (inWys) document.execCommand('insertText', false, text);
    else plain.insertText(text);
  } catch {
    toast(tt('请按 Ctrl+V 粘贴'));
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
    const ok = await confirmQuit();
    if (!ok) return;
    finishQuit(ok);
    await win.closeWindow();
  },
  undo: () => editCmd('undo'),
  redo: () => editCmd('redo'),
  cut: () => editCmd('cut'),
  copy: () => editCmd('copy'),
  paste: pasteFromClipboard,
  selectAll: () => editCmd('selectAll'),
  exportPdf,
  exportHtml,
  print: () => printTab(activeTab()),
  palette: openPalette,
  history: showHistoryPanel,
  find: () => openFind(),
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
  /* 右键「引用」那排药丸里「普通」的意思是「切成普通引用」，不是「取消引用」：
     在提示块上应该只摘掉提示块样式，原先它跟 quote 走同一个命令，一点整个框
     就退成段落了。普通引用上再点一次仍然是取消（保持原来的开关手感） */
  plainQuote: () => wysCmd((w) => {
    const b = w.currentBlock();
    if (b && b.dataset.type === 'bq' && b.dataset.callout) { w.clearCallout(b); return; }
    w.insertBlock('quote');
  }),
  calloutInfo: () => wysCmd((w) => w.setCallout('info')),
  calloutWarning: () => wysCmd((w) => w.setCallout('warning')),
  calloutDanger: () => wysCmd((w) => w.setCallout('danger')),
  calloutSuccess: () => wysCmd((w) => w.setCallout('success')),
  codeBlock: () => wysCmd((w) => w.insertBlock('code')),
  mathBlock: () => wysCmd((w) => w.insertBlock('math')),
  hr: () => wysCmd((w) => w.insertBlock('hr')),
  table: () => wysCmd((w) => w.insertTable(3, 3)),
  tablePrompt,
  image: imagePrompt,
  toc: insertToc,
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
    const themeWord = { auto: tt('跟随系统'), light: tt('浅色'), dark: tt('深色') };
    toast(tt('主题：{name}', { name: themeWord[settings.theme] }));
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
    if (on) toast(tt('已进入全屏，按 F11 退出'));
  },
  toggleZen: () => toggleZen(),
  zoomIn: () => zoom(1),
  zoomOut: () => zoom(-1),
  zoomReset: () => { settings.fontSize = DEFAULTS.fontSize; saveSettings(); applyFont(); },
  setMode,
  modeWysiwyg: () => setMode('wysiwyg', { fromActivate: true }),
  modeEdit: () => setMode('edit', { fromActivate: true }),
  modePreview: () => setMode('preview', { fromActivate: true }),
  textCompare: () => openCompareWindow(),
  folderCompare: () => diff.openFolder(),
  merge: () => merge.open(),
  wordCount: showWordCount,
  reload: reloadCurrent,
  autoSave: () => {
    settings.autoSave = !settings.autoSave;
    saveSettings();
    toast(settings.autoSave ? tt('自动保存已开启：改动停下约 1 秒就写盘') : tt('自动保存已关闭'));
  },
  clearRecent: () => { LS.del('recent'); toast(tt('已清除最近记录')); },
  openFolder: pickFolder,
  settings: showSettings,
  shortcuts: showShortcuts,
  about: showAbout,
  encoding: changeEncoding,
  eol: cycleEol,
  sortAsc: () => transformText(lineOps.sortAsc, tt('升序排序')),
  sortDesc: () => transformText(lineOps.sortDesc, tt('降序排序')),
  sortNum: () => transformText(lineOps.sortNum, tt('按数字排序')),
  dedupe: () => transformText(lineOps.dedupe, tt('去重')),
  removeEmpty: () => transformText(lineOps.removeEmpty, tt('删除空行')),
  trimLines: () => transformText(lineOps.trimLines, tt('去除首尾空白')),
  upper: () => transformText(caseOps.upper, tt('转大写')),
  lower: () => transformText(caseOps.lower, tt('转小写')),
  title: () => transformText(caseOps.title, tt('首字母大写')),
};

/* ---------------- 菜单结构（自绘标题栏用） ---------------- */
const hasTab = () => !!activeTab();
const markMode = (m) => () => !!(activeTab() && activeTab().mode === m);
const canWys = () => !!(activeTab() && activeTab().mode === 'wysiwyg');
const inTable = () => canWys() && wys.isInTable();
const wysOnly = () => !canWys();
const previewMode = () => !!(activeTab() && activeTab().mode === 'preview');

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

/** 光标所在块的引用类型：''=普通引用，'info' 等=提示块；不是引用块返回 null。
    右键菜单的引用药丸拿它点亮当前值 */
const bqCallout = () => {
  if (!canWys()) return null;
  const b = wys.currentBlock();
  if (!b || b.dataset.type !== 'bq') return null;
  return b.dataset.callout || '';
};

/** 光标所在表格列的当前对齐方式：'' | 'left' | 'center' | 'right'；不在表格里返回 null。
    右键菜单的对齐药丸拿它点亮当前值，不用点进去试 */
const colAlign = () => {
  if (!canWys() || !wys.isInTable()) return null;
  const info = wys.tableInfo();
  if (!info) return null;
  return ((info.table.dataset.aligns || '').split(',')[info.colIdx] || '').trim();
};

const menuTree = () => [
  {
    label: tt('文件'),
    /* 每次展开都重算：最近打开是动态的，固定数组会永远停在打开那一刻的样子 */
    items: () => [
      { id: 'new', label: tt('新建'), kbd: 'Ctrl+N' },
      { id: 'open', label: tt('打开…'), kbd: 'Ctrl+O' },
      { id: 'openFolder', label: tt('打开文件夹…'), icon: 'folder-open' },
      ...recentMenuItems(),
      { sep: true },
      { id: 'save', label: tt('保存'), kbd: 'Ctrl+S', disabled: () => !hasTab() },
      { id: 'saveAs', label: tt('另存为…'), kbd: 'Ctrl+Shift+S', disabled: () => !hasTab() },
      { id: 'autoSave', label: tt('自动保存（约 1 秒）'), checked: () => !!settings.autoSave },
      { sep: true },
      { id: 'exportPdf', label: tt('导出 PDF / 打印…'), kbd: 'Ctrl+P', disabled: () => !hasTab() },
      { id: 'exportHtml', label: tt('导出网页（HTML）…'), disabled: () => !hasTab() },
      { id: 'history', label: tt('历史版本…'), disabled: () => !hasTab() },
      { id: 'reload', label: tt('重新载入'), disabled: () => !hasTab() },
      { sep: true },
      { id: 'closeTab', label: tt('关闭标签'), kbd: 'Ctrl+W', disabled: () => !hasTab() },
      { sep: true },
      { id: 'quit', label: tt('退出') },
    ],
  },
  {
    label: tt('编辑'),
    items: [
      { id: 'undo', label: tt('撤销'), kbd: 'Ctrl+Z', disabled: () => !hasTab() },
      { id: 'redo', label: tt('重做'), kbd: 'Ctrl+Y', disabled: () => !hasTab() },
      { sep: true },
      { id: 'cut', label: tt('剪切'), kbd: 'Ctrl+X', disabled: () => !hasTab() },
      { id: 'copy', label: tt('复制'), kbd: 'Ctrl+C', disabled: () => !hasTab() },
      { id: 'paste', label: tt('粘贴'), kbd: 'Ctrl+V', disabled: () => !hasTab() },
      { id: 'selectAll', label: tt('全选'), kbd: 'Ctrl+A', disabled: () => !hasTab() },
      { sep: true },
      { id: 'find', label: tt('查找…'), kbd: 'Ctrl+F' },
      { id: 'replace', label: tt('替换…'), kbd: 'Ctrl+H' },
      { id: 'gotoLine', label: tt('跳转到行…'), kbd: 'Ctrl+G', disabled: () => !hasTab() },
    ],
  },
  {
    label: tt('格式'),
    items: [
      /* 四级别是互斥的单选题，横排一行：比竖着占 4 行省地方，
         而且当前级别一目了然（这是竖向文字菜单做不到的） */
      { head: tt('标题级别') },
      { row: [
        { id: 'body', label: tt('正文'), hint: tt('正文（取消标题）'), kbd: 'Ctrl+Alt+0', disabled: wysOnly, checked: () => headingLevel() === 0 },
        { id: 'h1', label: 'H1', hint: tt('一级标题'), kbd: 'Ctrl+Alt+1', disabled: wysOnly, checked: () => headingLevel() === 1 },
        { id: 'h2', label: 'H2', hint: tt('二级标题'), kbd: 'Ctrl+Alt+2', disabled: wysOnly, checked: () => headingLevel() === 2 },
        { id: 'h3', label: 'H3', hint: tt('三级标题'), kbd: 'Ctrl+Alt+3', disabled: wysOnly, checked: () => headingLevel() === 3 },
      ] },
      { note: tt('标题与列表只在所见即所得模式下可用，Ctrl + 1 切换'), hidden: () => canWys() },

      { head: tt('文字') },
      { id: 'bold', label: tt('加粗'), icon: 'bold', kbd: 'Ctrl+B', disabled: () => !hasTab() },
      { id: 'italic', label: tt('斜体'), icon: 'italic', kbd: 'Ctrl+I', disabled: () => !hasTab() },
      { id: 'strike', label: tt('删除线'), icon: 'strikethrough', kbd: 'Ctrl+Shift+X', disabled: () => !hasTab() },
      { id: 'inlineCode', label: tt('行内代码'), icon: 'code', disabled: () => !hasTab() },

      { head: tt('段落') },
      { id: 'ul', label: tt('无序列表'), icon: 'list', kbd: 'Ctrl+Shift+8', disabled: wysOnly },
      { id: 'ol', label: tt('有序列表'), icon: 'list-ordered', kbd: 'Ctrl+Shift+7', disabled: wysOnly },
      { id: 'taskList', label: tt('任务列表'), icon: 'list-todo', kbd: 'Ctrl+Shift+9', disabled: wysOnly },
      { id: 'quote', label: tt('引用'), icon: 'text-quote', kbd: 'Ctrl+Shift+Q', disabled: wysOnly },
      { id: 'calloutInfo', label: tt('信息提示块'), icon: 'info', disabled: wysOnly },
      { id: 'calloutWarning', label: tt('警告提示块'), icon: 'triangle-alert', disabled: wysOnly },
      { id: 'calloutDanger', label: tt('危险提示块'), icon: 'octagon-alert', disabled: wysOnly },
      { id: 'calloutSuccess', label: tt('成功提示块'), icon: 'circle-check', disabled: wysOnly },
      { id: 'codeBlock', label: tt('代码块'), icon: 'square-code', kbd: 'Ctrl+Shift+K', disabled: wysOnly },
      { id: 'indentIn', label: tt('增加缩进'), icon: 'indent-increase', kbd: 'Tab', disabled: wysOnly },
      { id: 'indentOut', label: tt('减少缩进'), icon: 'indent-decrease', kbd: 'Shift+Tab', disabled: wysOnly },
    ],
  },
  {
    /* 「加东西」和「改样子」本来就是两件事，混在一个菜单里 38 项谁都得找半天。
       拆出去之后：格式 15 项、插入 6 项，各自一屏看完 */
    label: tt('插入'),
    items: [
      { id: 'link', label: tt('链接…'), icon: 'link', kbd: 'Ctrl+K', disabled: wysOnly },
      { id: 'image', label: tt('图片…'), icon: 'image', disabled: wysOnly },
      { sep: true },
      { id: 'table', label: tt('表格 3 × 3'), icon: 'table', kbd: 'Ctrl+Shift+T', disabled: wysOnly },
      { id: 'tablePrompt', label: tt('表格（自定大小）…'), icon: 'table', disabled: wysOnly },
      { id: 'hr', label: tt('分割线'), icon: 'minus', disabled: wysOnly },
      { sep: true },
      { id: 'mathBlock', label: tt('数学公式块'), disabled: wysOnly },
      { id: 'toc', label: tt('目录…'), icon: 'list-tree', disabled: () => !hasTab() || previewMode() },
      /* 增删行列、调对齐这些「改已有表格」的操作不再占菜单位置：
         右键菜单里本来就有一整套，同一个命令没必要在两个地方各列一遍。
         这里只在光标真的进了表格时提一句，省得有人找不到 */
      { note: tt('光标在表格内右键，可增删行列、调整对齐'), hidden: noTable },
    ],
  },
  {
    label: tt('视图'),
    items: [
      { id: 'modeWysiwyg', label: tt('所见即所得'), kbd: 'Ctrl+1', checked: markMode('wysiwyg'), disabled: () => !hasTab() },
      { id: 'modeEdit', label: tt('编辑模式'), kbd: 'Ctrl+2', checked: markMode('edit'), disabled: () => !hasTab() },
      { id: 'modePreview', label: tt('预览模式'), kbd: 'Ctrl+3', checked: markMode('preview'), disabled: () => !hasTab() },
      { sep: true },
      { id: 'layoutSingle', label: tt('单栏'), kbd: 'Ctrl+Shift+L', checked: () => settings.layout === 'single' },
      { id: 'layoutSplit', label: tt('双栏'), checked: () => settings.layout === 'split' },
      { sep: true },
      { id: 'toggleOutline', label: tt('显示大纲'), kbd: 'Ctrl+Shift+O', checked: () => settings.outlineVisible },
      { id: 'toggleToolbar', label: tt('显示快捷按钮'), checked: () => settings.showToolbar !== false },
      { id: 'toggleWinTitle', label: tt('标题栏显示文件名'), checked: () => settings.showWinTitle !== false },
      { sep: true },
      { id: 'zoomIn', label: tt('放大'), kbd: 'Ctrl+=' },
      { id: 'zoomOut', label: tt('缩小'), kbd: 'Ctrl+-' },
      { id: 'zoomReset', label: tt('实际大小'), kbd: 'Ctrl+0' },
      { sep: true },
      { id: 'themeAuto', label: tt('主题：跟随系统'), checked: () => settings.theme === 'auto' },
      { id: 'themeLight', label: tt('主题：浅色'), checked: () => settings.theme === 'light' },
      { id: 'themeDark', label: tt('主题：深色'), checked: () => settings.theme === 'dark' },
      { sep: true },
      { id: 'toggleZen', label: tt('专注模式'), kbd: 'F9', checked: () => settings.zen },
      { id: 'fullscreen', label: tt('全屏'), kbd: 'F11' },
    ],
  },
  {
    label: tt('工具'),
    items: [
      { id: 'palette', label: tt('命令面板…'), kbd: 'Ctrl+Shift+P' },
      { sep: true },
      { id: 'format', label: tt('一键格式化'), kbd: 'Ctrl+Shift+F', disabled: () => !hasTab() },
      { sep: true },
      { id: 'sortAsc', label: tt('按行升序排序'), disabled: () => !hasTab() },
      { id: 'sortDesc', label: tt('按行降序排序'), disabled: () => !hasTab() },
      { id: 'sortNum', label: tt('按数字排序'), disabled: () => !hasTab() },
      { id: 'dedupe', label: tt('去除重复行'), disabled: () => !hasTab() },
      { id: 'removeEmpty', label: tt('删除空行'), disabled: () => !hasTab() },
      { id: 'trimLines', label: tt('去除首尾空白'), disabled: () => !hasTab() },
      { sep: true },
      { id: 'upper', label: tt('转大写'), disabled: () => !hasTab() },
      { id: 'lower', label: tt('转小写'), disabled: () => !hasTab() },
      { id: 'title', label: tt('首字母大写'), disabled: () => !hasTab() },
      { sep: true },
      { id: 'textCompare', label: tt('文本对比…'), kbd: 'Ctrl+D' },
      { id: 'folderCompare', label: tt('文件夹对比…') },
      { id: 'merge', label: tt('三向合并…') },
      { sep: true },
      { id: 'wordCount', label: tt('字数统计'), disabled: () => !hasTab() },
      { id: 'encoding', label: tt('文件编码…'), disabled: () => !hasTab() },
      { id: 'eol', label: tt('切换换行符'), disabled: () => !hasTab() },
    ],
  },
  {
    /* 设置原本塞在「工具」最后一项，位置不对：工具是「处理文本」（排序、去重、对比），
       设置是「配置软件」。提成顶级项后，它有了自己的位置，点一下直接开面板——
       没有下拉，所以不跟别的菜单抢「展开/收起」那套交互。 */
    label: tt('设置'),
    action: () => showSettings(),
  },
  {
    label: tt('帮助'),
    items: [
      { id: 'shortcuts', label: tt('快捷键一览') },
      { id: 'about', label: tt('关于 EZNotepad') },
    ],
  },
];

/* 菜单实例只建一次。换语言时走 update(menuTree()) 而不是重建 ——
   createAppMenu 会往 document 上挂一套「点外面就关」的监听，重建等于叠一层，
   叠多了菜单开始自己闪。 */
let menuApi = null;
function setupAppMenu() {
  if (!el.menubar) return;
  menuApi = createAppMenu({
    bar: el.menubar,
    menus: menuTree(),
    run: (id) => { const fn = commands[id]; if (fn) fn(); },
  });
}

/* ---------------- 行首块手柄：+ 插入 / ⋮⋮ 换块类型 ----------------
   手柄挂在 .edit-wrap 上、在 contenteditable 之外，所以浏览器选不中它、
   退格删不到它、sweepBlock 也不会把它吸进正文。
   两张菜单都不含新逻辑：执行一律走 commands 表，和顶栏菜单同一条路。 */

const svgIco = (n) => `<svg class="ico" aria-hidden="true"><use href="#i-${n}" /></svg>`;

/* 图标要和「点了会发生什么」对得上：以前标题三级都画 `type`、列表两种都画
   `list-tree`、引用也是 `type`、表格是个空方框、链接是两个箭头，一列看下来
   分不出谁是谁。现在每个都用自己的图标。
   group 只用来在菜单里插分隔线：文本类 / 提示块，13 项一坨太难扫。 */
const blockKinds = () => [
  { id: 'body', label: tt('正文段落'), icon: 'pilcrow', group: 'text' },
  { id: 'h1', label: tt('标题 1'), icon: 'heading-1', group: 'text' },
  { id: 'h2', label: tt('标题 2'), icon: 'heading-2', group: 'text' },
  { id: 'h3', label: tt('标题 3'), icon: 'heading-3', group: 'text' },
  { id: 'ul', label: tt('无序列表'), icon: 'list', group: 'text' },
  { id: 'ol', label: tt('有序列表'), icon: 'list-ordered', group: 'text' },
  { id: 'taskList', label: tt('任务列表'), icon: 'list-todo', group: 'text' },
  { id: 'quote', label: tt('引用'), icon: 'text-quote', group: 'text' },
  { id: 'codeBlock', label: tt('代码块'), icon: 'code', group: 'text' },
  { id: 'calloutInfo', label: tt('信息提示块'), icon: 'info', group: 'callout' },
  { id: 'calloutWarning', label: tt('警告提示块'), icon: 'triangle-alert', group: 'callout' },
  { id: 'calloutDanger', label: tt('危险提示块'), icon: 'octagon-alert', group: 'callout' },
  { id: 'calloutSuccess', label: tt('成功提示块'), icon: 'circle-check', group: 'callout' },
];

/** 插入类：这几件事自己知道往哪插，不用先造空块。kbd 只是提示，真正的按键在快捷键表里 */
const blockInserts = () => [
  { id: 'table', label: tt('表格（3 × 3）'), icon: 'table', kbd: 'Ctrl+Shift+T' },
  { id: 'tablePrompt', label: tt('表格（自定大小）…'), icon: 'table' },
  { id: 'image', label: tt('图片…'), icon: 'image' },
  { id: 'link', label: tt('链接…'), icon: 'link', kbd: 'Ctrl+K' },
  { id: 'hr', label: tt('分割线'), icon: 'minus' },
];
const SELF_INSERTING = new Set(['table', 'tablePrompt', 'image', 'link', 'hr']);

/* 手柄锚在哪个块上。语义是「最后确定的那一行」而不是「鼠标此刻压着的行」：
   鼠标滑到行间空隙、页边距、甚至移出编辑区，锚点都不动，手柄就钉在原地。
   只有真的换到另一个块（或光标被键盘移走）才换锚点。 */
let anchorBlock = null;
let handleBlock = null;      // 当前画出手柄的那个块，由 placeHandle 写
let pointerInside = false;   // 鼠标是否在编辑区里，决定 selectionchange 能不能抢锚点
let handleTimer = 0;
let bmMode = 'convert';
/* 键盘高亮：焦点始终留在编辑区（菜单一抢焦点，正文选区就没了），所以「当前项」
   用 .hot 类表达，而不是真焦点。bmRows 只收可执行项，head / sep 不在里面。 */
let bmHot = -1;
let bmRows = [];

/** 块菜单开着的时候，手柄是它的定位锚点，不能被任何「鼠标离开」逻辑收掉 */
const blockMenuOpen = () => !el.wBlockMenu.classList.contains('hidden');

const isWysMode = () => !!activeTab() && activeTab().mode === 'wysiwyg';

/** 块当前是什么类型，用来在「转换」菜单里打勾 */
function kindOfBlock(b) {
  const t = b.dataset.type;
  if (t === 'li') return b.dataset.list === 'task' ? 'taskList' : (b.dataset.list === 'ol' ? 'ol' : 'ul');
  if (t === 'bq') {
    const co = b.dataset.callout;
    return co ? `callout${co[0].toUpperCase()}${co.slice(1)}` : 'quote';
  }
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
  /* 块滚出视野：只把元素藏起来，锚点留着 —— 滚回来还是它，不要重新按光标猜 */
  if (r.bottom < host.top + 4 || r.top > host.bottom - 4) {
    el.wHandle.classList.add('hidden');
    return;
  }
  handleBlock = block;
  anchorBlock = block;              // placeHandle 是唯一真源，锚点跟它同步
  el.wHandle.classList.remove('hidden');
  // 贴着首行：块可能是多行，手柄只对齐第一行
  el.wHandle.style.top = Math.round(Math.max(2, r.top - host.top + 2)) + 'px';
  el.wHandle.style.left = Math.round(Math.max(2, r.left - host.left - 45)) + 'px';
}

function hideHandle() {
  if (blockMenuOpen()) return;      // 菜单还开着，手柄得留在原地当锚点
  anchorBlock = null;
  handleBlock = null;
  el.wHandle.classList.add('hidden');
}

function refreshHandle() {
  if (!isWysMode()) { hideHandle(); return; }
  /* 锚点优先；还没有锚点（刚进所见即所得、鼠标没动过）时退回光标所在块 */
  const target = anchorBlock && anchorBlock.isConnected ? anchorBlock : wys.currentBlock();
  if (target) placeHandle(target); else hideHandle();
}

function openBlockMenu(mode) {
  if (!handleBlock || !handleBlock.isConnected) return;
  const box = el.wBlockMenu;
  // 同一个按钮再点一次 = 收起
  if (!box.classList.contains('hidden') && bmMode === mode) { closeBlockMenu(); return; }
  bmMode = mode;
  anchorBlock = handleBlock;        // 菜单锚在手柄上，锚点跟它对齐
  box.innerHTML = '';
  bmRows = [];
  bmHot = -1;
  box.scrollTop = 0;                // 重建后别继承上一次的滚动位置
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
    b.setAttribute('role', 'menuitem');
    if (checked) b.setAttribute('aria-checked', 'true');
    b.innerHTML = svgIco(it.icon || 'type') + `<span>${it.label}</span>`
      + (it.kbd ? `<kbd class="bm-kbd">${it.kbd}</kbd>` : '');
    b.addEventListener('mousedown', (e) => e.preventDefault());   // 保住编辑区选区
    /* 鼠标停在谁身上，Enter 就作用在谁身上 —— 键盘和鼠标混着用也不会错位 */
    const idx = bmRows.push(b) - 1;
    b.addEventListener('mouseenter', () => { bmHot = idx; });
    b.onclick = () => bmRun(it.id);
    box.appendChild(b);
  };

  const cur = mode === 'convert' ? kindOfBlock(handleBlock) : '';
  head(mode === 'insert' ? tt('在下方插入') : tt('转换这一块'));
  let prevGroup = '';
  blockKinds().forEach((it) => {
    if (prevGroup && it.group && it.group !== prevGroup) sep();
    if (it.group) prevGroup = it.group;
    item(it, it.id === cur);
  });
  if (mode === 'insert') {
    sep();
    head(tt('插入'));
    blockInserts().forEach((it) => item(it, false));
  }

  // 贴着按钮展开；右边放不下就翻到左边，下边放不下就往上收
  const hr = el.wHandle.getBoundingClientRect();
  const mw = box.offsetWidth || 198;
  const mh = box.offsetHeight || 280;
  let left = hr.right + 8;
  let top = hr.top - 5;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, hr.left - mw - 4);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
  box.style.left = Math.round(left) + 'px';
  box.style.top = Math.round(top) + 'px';
  /* 高亮要落在真正被点的那个按钮上：点 + 却亮抓手，会让人以为菜单开错了 */
  el.whAdd.classList.toggle('open', mode === 'insert');
  el.whMenu.classList.toggle('open', mode === 'convert');
}

function closeBlockMenu() {
  el.wBlockMenu.classList.add('hidden');
  el.wBlockMenu.innerHTML = '';
  bmRows = [];
  bmHot = -1;
  el.whAdd.classList.remove('open');
  el.whMenu.classList.remove('open');
}

/** 高亮第 i 项（-1 = 都不亮），并保证它在菜单可视范围内 */
function bmHover(i) {
  bmHot = i;
  bmRows.forEach((b, n) => b.classList.toggle('hot', n === i));
  const b = bmRows[i];
  if (!b) return;
  /* 不用 scrollIntoView：它会把所有可滚动祖先一起滚，正文会跟着跳一下。
     菜单自己这层的 overflow 才是要调的对象。 */
  const box = el.wBlockMenu;
  const top = b.offsetTop;
  const h = b.offsetHeight;
  if (top < box.scrollTop) box.scrollTop = top - 4;
  else if (top + h > box.scrollTop + box.clientHeight) box.scrollTop = top + h - box.clientHeight + 4;
}

/** ↑↓ 环绕着走，跟顶栏菜单一个手感 */
function bmStep(dir) {
  const n = bmRows.length;
  if (!n) return;
  let i = bmHot;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (bmRows[i] && !bmRows[i].disabled) { bmHover(i); return; }
  }
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
  /* 操作可能换了块（插入新块 / 转换类型），锚点跟到操作后的光标处 */
  handleTimer = setTimeout(() => {
    anchorBlock = wys.currentBlock() || anchorBlock;
    refreshHandle();
  }, 0);
}

function setupBlockHandle() {
  if (!el.wHandle) return;
  el.wysiwyg.addEventListener('mousemove', (e) => {
    if (!isWysMode()) return;
    pointerInside = true;
    /* 菜单开着时一律不响应：手柄和菜单之间有缝，鼠标从按钮挪到菜单必然
       经过编辑区，这里若继续跑就会当场把菜单收掉（用户根本来不及点）。
       关菜单只认「点编辑区别处」「Esc」「滚动」三条路。 */
    if (blockMenuOpen()) return;
    const b = e.target.closest ? e.target.closest('.w-block') : null;
    /* 没压在任何块上（行间空隙、左右页边距、块内的 .w-text 之外）就不动锚点。
       这是「只要不换行就不消失」的关键：以前这里会把 null 当成「离开」 */
    if (!b || b === anchorBlock) return;
    anchorBlock = b;
    refreshHandle();
  });
  el.wysiwyg.addEventListener('mouseenter', () => { pointerInside = true; });
  /* 鼠标移出编辑区（去预览、去菜单、出窗口）也不收 —— 只是不再抢锚点 */
  el.wysiwyg.addEventListener('mouseleave', () => { pointerInside = false; });
  /* 滚动会让菜单和它的块错位，这时关掉比让它悬在空中好 */
  el.wysiwyg.addEventListener('scroll', () => {
    if (blockMenuOpen()) closeBlockMenu();
    refreshHandle();
  }, { passive: true });

  /* 键盘移动光标时才让锚点跟着走；鼠标在场时以鼠标压着的块为准 */
  document.addEventListener('selectionchange', () => {
    if (!isWysMode() || blockMenuOpen()) return;
    clearTimeout(handleTimer);
    handleTimer = setTimeout(() => {
      if (pointerInside && anchorBlock && anchorBlock.isConnected) return;
      const c = wys.currentBlock();
      if (c) anchorBlock = c;
      refreshHandle();
    }, 0);
  });

  for (const b of [el.whAdd, el.whMenu]) b.addEventListener('mousedown', (e) => e.preventDefault());
  el.whAdd.onclick = () => openBlockMenu('insert');
  el.whMenu.onclick = () => openBlockMenu('convert');

  document.addEventListener('mousedown', (e) => {
    if (el.wBlockMenu.classList.contains('hidden')) return;
    if (el.wBlockMenu.contains(e.target) || el.wHandle.contains(e.target)) return;
    closeBlockMenu();
  });
  /* 菜单开着时的键盘：↑↓ Home End 选，Enter 执行，Esc 关。
     其余按键（字母、空格、退格）一律当成「我要打字了」—— 收起菜单、事件照常往下走，
     字符落进正文。不能像顶栏菜单那样拿空格当执行：这里焦点始终在编辑区，
     按空格的人百分之百是想打空格。Tab / ←→ 同理（不拦，让焦点或光标照常动）。 */
  document.addEventListener('keydown', (e) => {
    if (el.wBlockMenu.classList.contains('hidden')) return;
    /* 输入法组字中：Enter 是选候选，不是执行菜单项。229 是旧浏览器给的组字标记 */
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closeBlockMenu();
      return;
    }
    if (k === 'Tab' || k === 'ArrowLeft' || k === 'ArrowRight') { closeBlockMenu(); return; }
    if (k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); bmStep(1); return; }
    if (k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); bmStep(-1); return; }
    if (k === 'Home') { e.preventDefault(); e.stopPropagation(); bmHover(0); return; }
    if (k === 'End') { e.preventDefault(); e.stopPropagation(); bmHover(bmRows.length - 1); return; }
    if (k === 'Enter') {
      if (bmHot >= 0 && bmRows[bmHot]) { e.preventDefault(); e.stopPropagation(); bmRows[bmHot].click(); }
      else closeBlockMenu();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) closeBlockMenu();
  }, true);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  /* 用 addEventListener 而不是 onclick：覆盖式赋值一旦被后续代码碰上就悄悄失效，
     而 addEventListener 至少不会互相顶掉 */
  const on = (id, fn) => { const n = $(id); if (n) n.addEventListener('click', fn); };

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
    if (el.wcMax) el.wcMax.title = max ? tt('还原') : tt('最大化');
  };
  window.addEventListener('resize', syncMaxState);
  setTimeout(syncMaxState, 80);

  /* 窗口失焦时让标题与窗口按钮变淡（Win11 原生标题栏就是这个行为） */
  const setBlur = (on) => document.body.classList.toggle('win-blur', on);
  window.addEventListener('blur', () => setBlur(true));
  window.addEventListener('focus', () => { setBlur(false); syncMaxState(); });
  document.addEventListener('visibilitychange', () => setBlur(document.hidden));

  on('btnFind', () => openFind());
  on('btnSave', commands.save);
  on('tabAdd', commands.new);

  $('btnMode').onclick = (e) => { e.stopPropagation(); el.modeMenu.classList.toggle('open'); };
  el.modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (b.classList.contains('disabled')) { toast(tt('当前文件类型不支持该模式')); return; }
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
      { label: tt('剪切'), action: clip('cut') },
      { label: tt('复制'), action: clip('copy') },
      { label: tt('粘贴'), action: clip('paste') },
      { label: tt('全选'), action: () => { plain.focus(); plain.selectAll(); } },
      { sep: true },
      { label: tt('查找…'), shortcut: 'Ctrl+F', action: () => openFind() },
      { label: tt('替换…'), shortcut: 'Ctrl+H', action: () => openFind(true) },
      { label: tt('一键格式化'), shortcut: 'Ctrl+Shift+F', action: commands.format },
      { sep: true },
      { label: tt('转大写'), action: commands.upper },
      { label: tt('转小写'), action: commands.lower },
    ]);
  });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.wysiwyg')) {
      e.preventDefault();
      const tbl = wys.isInTable();
      /* 这一套是所见即所得里唯一的右键入口，原来 23 项一口气竖排、7 条分隔线，
         表格里那一截足有 11 项，找「右对齐」得从上往下数。现在按「文字 / 段落 /
         表格」分组，同族动作横排一行：高度从约 870px 降到约 340px，
         当前标题级别和本列对齐方式还能点亮，不用点进去试 */
      const items = [
        { head: tt('文字') },
        { row: [
          { label: tt('加粗'), hint: tt('加粗'), icon: 'bold', iconOnly: true, shortcut: 'Ctrl+B', action: () => commands.bold() },
          { label: tt('斜体'), hint: tt('斜体'), icon: 'italic', iconOnly: true, shortcut: 'Ctrl+I', action: () => commands.italic() },
          { label: tt('删除线'), hint: tt('删除线'), icon: 'strikethrough', iconOnly: true, shortcut: 'Ctrl+Shift+X', action: () => commands.strike() },
          { label: tt('行内代码'), hint: tt('行内代码'), icon: 'code', iconOnly: true, action: () => commands.inlineCode() },
          { label: tt('插入链接'), hint: tt('插入链接'), icon: 'link', iconOnly: true, shortcut: 'Ctrl+K', action: () => commands.link() },
        ] },

        { head: tt('段落') },
        { row: [
          { label: tt('正文'), checked: () => headingLevel() === 0, action: () => commands.body() },
          { label: 'H1', checked: () => headingLevel() === 1, action: () => commands.h1() },
          { label: 'H2', checked: () => headingLevel() === 2, action: () => commands.h2() },
          { label: 'H3', checked: () => headingLevel() === 3, action: () => commands.h3() },
        ] },
        { row: [
          { label: tt('无序列表'), hint: tt('无序列表'), icon: 'list', iconOnly: true, shortcut: 'Ctrl+Shift+8', action: () => commands.ul() },
          { label: tt('有序列表'), hint: tt('有序列表'), icon: 'list-ordered', iconOnly: true, shortcut: 'Ctrl+Shift+7', action: () => commands.ol() },
          { label: tt('任务列表'), hint: tt('任务列表'), icon: 'list-todo', iconOnly: true, shortcut: 'Ctrl+Shift+9', action: () => commands.taskList() },
          /* 引用相关的三项在表格里点了没反应（表格没有可搬的一行文本，换类型一律
             跳过它；见 wysiwyg.convertBlock），索性不摆出来 —— 死按钮比少一项更让人困惑 */
          ...(tbl ? [] : [
            { label: tt('引用'), hint: tt('引用块'), icon: 'text-quote', iconOnly: true, shortcut: 'Ctrl+Shift+Q', action: () => commands.quote() },
          ]),
        ] },
        ...(tbl ? [] : [{ lead: tt('引用'), row: [
          { label: tt('普通'), hint: tt('普通引用'), checked: () => bqCallout() === '', action: () => commands.plainQuote() },
          { label: tt('信息'), hint: tt('信息提示块'), checked: () => bqCallout() === 'info', action: () => commands.calloutInfo() },
          { label: tt('警告'), hint: tt('警告提示块'), checked: () => bqCallout() === 'warning', action: () => commands.calloutWarning() },
          { label: tt('危险'), hint: tt('危险提示块'), checked: () => bqCallout() === 'danger', action: () => commands.calloutDanger() },
          { label: tt('成功'), hint: tt('成功提示块'), checked: () => bqCallout() === 'success', action: () => commands.calloutSuccess() },
        ] }]),
      ];
      if (tbl) {
        items.push(
          { head: tt('表格') },
          { lead: tt('插入'), row: [
            { label: tt('上方行'), action: () => commands.tableRowAbove() },
            { label: tt('下方行'), action: () => commands.tableRowBelow() },
            { label: tt('左侧列'), action: () => commands.tableColBefore() },
            { label: tt('右侧列'), action: () => commands.tableColAfter() },
          ] },
          /* 四个方向的对齐都留在这里：主菜单已不再重复列表格操作，
             右键是唯一入口，少一个就等于功能丢了 */
          { lead: tt('对齐'), row: [
            { label: tt('左'), hint: tt('本列左对齐'), checked: () => colAlign() === 'left', action: () => commands.tableAlignLeft() },
            { label: tt('居中'), hint: tt('本列居中'), checked: () => colAlign() === 'center', action: () => commands.tableAlignCenter() },
            { label: tt('右'), hint: tt('本列右对齐'), checked: () => colAlign() === 'right', action: () => commands.tableAlignRight() },
            { label: tt('默认'), hint: tt('本列取消对齐'), checked: () => colAlign() === '', action: () => commands.tableAlignNone() },
          ] },
          { lead: tt('删除'), danger: true, row: [
            { label: tt('本行'), hint: tt('删除光标所在行'), action: () => commands.tableDelRow() },
            { label: tt('本列'), hint: tt('删除光标所在列'), action: () => commands.tableDelCol() },
            { label: tt('整表'), hint: tt('删除整个表格'), action: () => commands.tableDel() },
          ] },
        );
      } else {
        items.push(
          { head: tt('插入') },
          { label: tt('表格 3 × 3'), shortcut: 'Ctrl+Shift+T', action: () => commands.table() },
          { label: tt('分割线'), action: () => commands.hr() },
        );
      }
      items.push(
        { sep: true },
        { label: tt('全选'), shortcut: 'Ctrl+A', action: () => document.execCommand('selectAll') },
        { label: tt('查找替换…'), shortcut: 'Ctrl+F', action: () => openFind() },
      );
      contextMenu(e.clientX, e.clientY, items);
    }
  });

  $('findInput').addEventListener('input', () => { autoGrow($('findInput')); runFind(); });
  $('findInput').addEventListener('keydown', (e) => {
    // Ctrl/⌘+Enter 插换行（和 IDEA 一致）；光按 Enter 仍然是跳到下一处
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      insertNewlineIn($('findInput'));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { closeFind(); }
  });
  $('replaceInput').addEventListener('input', () => autoGrow($('replaceInput')));
  $('replaceInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      insertNewlineIn($('replaceInput'));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    if (e.key === 'Escape') { closeFind(); }
  });
  on('findNewline', () => insertNewlineIn($('findInput')));
  on('replaceNewline', () => insertNewlineIn($('replaceInput')));
  on('findExpand', () => setFindExpanded(!el.findbar.classList.contains('expanded')));
  on('findNext', () => findStep(1));
  on('findPrev', () => findStep(-1));
  on('findReplaceOne', replaceOne);
  on('findReplaceAll', replaceAll);
  on('findClose', closeFind);
  on('findCase', runFind);
  on('findRegex', runFind);
  on('findWord', runFind);
  on('findScope', runFind);

  /* 查找条上的 Alt 组合键。这三项的 title 里一直写着 Alt+C / Alt+R / Alt+W，
     但代码从来没实现过 —— 按下去什么也不发生，等于骗人。
     Alt+A 是 IDEA 的「全部替换」，补上之后不用鼠标也够得着。 */
  document.addEventListener('keydown', (e) => {
    if (el.findbar.classList.contains('hidden')) return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const toggle = (id) => {
      const n = $(id);
      if (!n || n.disabled) return;
      n.checked = !n.checked;
      runFind();
    };
    const k = (e.key || '').toLowerCase();
    if (k === 'c') { e.preventDefault(); toggle('findCase'); return; }
    if (k === 'r') { e.preventDefault(); toggle('findRegex'); return; }
    if (k === 'w') { e.preventDefault(); toggle('findWord'); return; }
    /* 只在替换行展开时才认：收起时替换框是空的，Alt+A 等于「全部删掉」 */
    if (k === 'a' && el.findbar.classList.contains('expanded')) { e.preventDefault(); replaceAll(); }
  });

  on('stEOL', cycleEol);
  on('stEncoding', changeEncoding);

  applyFont();
  applyTheme();
  document.getElementById('toolbar').classList.toggle('hidden', settings.showToolbar === false);
}

/* ---------------- 快捷键 ---------------- */
/* ---------------- 命令面板 ----------------
   命令表里已经有一百多条，靠菜单一层层找太慢。Ctrl+Shift+P 打开，
   输几个字就定位。列表直接从 MENU_TREE 抽 —— 以后菜单加了新命令，
   这里自动就有，不用维护第二份清单。 */
const pal = { el: null, sel: 0 };

function paletteItems() {
  const out = [];
  const seen = new Set();
  const walk = (items, group) => {
    for (const it of items) {
      if (!it || it.sep || it.head || it.note) continue;
      if (it.row) { walk(it.row, group); continue; }
      if (!it.id || !commands[it.id] || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({
        id: it.id,
        label: String(it.label || it.id).replace(/…$/, ''),
        group,
        kbd: it.kbd || '',
        off: typeof it.disabled === 'function' ? !!it.disabled() : !!it.disabled,
      });
    }
  };
  for (const m of menuTree()) {
    if (!m.items) continue;
    walk(typeof m.items === 'function' ? m.items() : m.items, m.label);
  }
  return out;
}

/** 子序列打分：连续命中、词首都加分。中文按字匹配，和拼音输入法一样「打几个字就行」 */
function fuzzyScore(text, q) {
  if (!q) return 1;
  const t = String(text).toLowerCase();
  const s = String(q).toLowerCase();
  let i = 0;
  let last = -2;
  let score = 0;
  for (const ch of s) {
    const idx = t.indexOf(ch, i);
    if (idx < 0) return 0;
    score += idx === last + 1 ? 3 : 1;
    if (idx === 0 || /[\s/·-]/.test(t[idx - 1])) score += 2;
    last = idx;
    i = idx + 1;
  }
  return score;
}

function closePalette() {
  if (!pal.el) return;
  pal.el.remove();
  pal.el = null;
}

function openPalette() {
  if (pal.el) { closePalette(); return; }
  const items = paletteItems();
  const wrap = document.createElement('div');
  wrap.className = 'palette';
  wrap.innerHTML = `<div class="palette-box" role="dialog" aria-label="${tt('命令面板')}">
      <input class="palette-input" placeholder="${tt('输入命令名…（↑↓ 选择，Enter 执行，Esc 关闭）')}" spellcheck="false">
      <div class="palette-list"></div>
    </div>`;
  const input = wrap.querySelector('.palette-input');
  const list = wrap.querySelector('.palette-list');
  let rows = [];
  let sel = 0;

  const mark = () => {
    [...list.children].forEach((c, i) => c.classList.toggle('on', i === sel));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };

  const draw = () => {
    const q = input.value.trim();
    rows = items
      .map((it) => ({ it, s: fuzzyScore(it.label + ' ' + it.group, q) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.it.label.length - b.it.label.length)
      .slice(0, 14)
      .map((r) => r.it);
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<div class="palette-empty">' + tt('没有匹配的命令') + '</div>';
      return;
    }
    rows.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'palette-item' + (i === sel ? ' on' : '') + (it.off ? ' off' : '');
      row.innerHTML = '<span class="p-label"></span><span class="p-group"></span><span class="p-kbd"></span>';
      row.querySelector('.p-label').textContent = it.label;
      row.querySelector('.p-group').textContent = it.group;
      row.querySelector('.p-kbd').textContent = it.kbd;
      row.addEventListener('mouseenter', () => { sel = i; mark(); });
      row.addEventListener('click', () => run(i));
      list.append(row);
    });
  };

  const run = (i) => {
    const it = rows[i];
    if (!it) return;
    if (it.off) { toast(tt('「{name}」在当前状态下不可用', { name: it.label })); return; }
    closePalette();
    commands[it.id]?.();
  };

  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(sel + 1, rows.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
  });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closePalette(); });

  document.body.append(wrap);
  pal.el = wrap;
  draw();
  input.focus();
}

/* ---------------- 快捷键自定义 ----------------
   默认键位写死在下面那串 if 里（一眼能看完、也不依赖配置）。
   自定义是一层「覆盖」：先查 settings.keymap，命中就执行并截断；
   没命中再走原来的判断。这样默认行为零改动，用户改坏了删掉配置即可复原。 */
const MOD_KEYS = { ctrl: 'mod', meta: 'mod', cmd: 'mod' };

/** 把一个 keydown 事件折成 "mod+shift+k" 这种稳定的字符串 */
function comboOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = e.key;
  if (k === ' ') k = 'space';
  else if (k.length === 1) k = k.toLowerCase();
  else k = k.toLowerCase();
  parts.push(k);
  return parts.join('+');
}

/** 菜单里写的 "Ctrl+Shift+8" → "mod+shift+8" */
function kbdToCombo(str) {
  if (!str) return '';
  const parts = String(str).split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.map((p) => MOD_KEYS[p] || p).join('+');
}

/** "mod+shift+8" → "Ctrl+Shift+8"，给界面看 */
function comboToKbd(combo) {
  return String(combo || '').split('+').map((p) => {
    if (p === 'mod') return 'Ctrl';
    if (p === 'alt') return 'Alt';
    if (p === 'shift') return 'Shift';
    return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
  }).join('+');
}

/** 菜单里所有带快捷键的命令（顺序和菜单一致） */
function keyRows() {
  const rows = [];
  for (const m of menuTree()) {
    if (!m.items) continue;
    const items = typeof m.items === 'function' ? m.items() : m.items;
    const walk = (arr) => arr.forEach((it) => {
      if (!it) return;
      if (it.row) { walk(it.row); return; }
      if (it.id && it.kbd && commands[it.id]) {
        rows.push({ id: it.id, label: it.label, kbd: it.kbd, group: m.label });
      }
    });
    walk(items);
  }
  return rows;
}

function keymap() {
  if (!settings.keymap) settings.keymap = {};
  return settings.keymap;
}

/** 这个命令身上挂着的自定义键（可能有多个） */
function customKeysOf(id) {
  return Object.keys(keymap()).filter((c) => keymap()[c] === id);
}

function paintKeyList(list) {
  const rows = keyRows();
  list.innerHTML = '';
  for (const r of rows) {
    const mine = customKeysOf(r.id);
    const row = document.createElement('div');
    row.className = 'key-row';
    row.innerHTML = '<span class="key-name"></span><span class="key-kbd"></span>';
    row.querySelector('.key-name').textContent = r.label.replace(/…$/, '');
    row.querySelector('.key-kbd').textContent = mine.length
      ? mine.map(comboToKbd).join(' / ')
      : r.kbd;
    row.querySelector('.key-kbd').classList.toggle('custom', mine.length > 0);

    const rec = document.createElement('button');
    rec.type = 'button';
    rec.className = 'mini';
    rec.textContent = tt('改');
    rec.onclick = () => {
      rec.textContent = tt('按键…');
      rec.classList.add('waiting');
      recordCombo((combo) => {
        rec.textContent = tt('改');
        rec.classList.remove('waiting');
        if (!combo) return;
        /* 一个命令只留一个自定义键；新键若被别的命令占着，直接接管 */
        for (const c of customKeysOf(r.id)) delete keymap()[c];
        keymap()[combo] = r.id;
        saveSettings();
        paintKeyList(list);
        toast(`${r.label.replace(/…$/, '')} → ${comboToKbd(combo)}`);
      });
    };

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'mini ghost';
    reset.textContent = tt('恢复');
    reset.disabled = !mine.length;
    reset.onclick = () => {
      for (const c of customKeysOf(r.id)) delete keymap()[c];
      saveSettings();
      paintKeyList(list);
    };

    row.append(rec, reset);
    list.append(row);
  }
}

/** 捕获下一组按键。catch 阶段抢在全局快捷键前面，免得边录边触发命令 */
function recordCombo(cb) {
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { finish(null); return; }
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const isFn = /^F([1-9]|1[0-2])$/.test(e.key);
    if (!hasMod && !isFn) return;        // 光按字母会误吞输入，必须带修饰键或用功能键
    finish(comboOf(e));
  };
  const finish = (v) => {
    window.removeEventListener('keydown', onKey, true);
    cb(v);
  };
  window.addEventListener('keydown', onKey, true);
}

function setupKeys() {
  window.addEventListener('keydown', (e) => {
    /* 自定义键位最优先：命中就执行并结束，不再往下走 */
    const combo = comboOf(e);
    const map = keymap();
    if (Object.prototype.hasOwnProperty.call(map, combo)) {
      e.preventDefault();
      const id = map[combo];
      if (id && commands[id]) commands[id]();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (!mod) {
      // F7 / F8 是「上一处 / 下一处差异」，只在对比窗口里有意义，那边自己处理
      if (e.key === 'F11') { e.preventDefault(); commands.fullscreen(); return; }
      if (e.key === 'F9') { e.preventDefault(); commands.toggleZen(); return; }
      if (e.key === 'F3') { findStep(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
      // Esc 先关查找条，再退专注模式：有事正在做的时候别把整块界面收掉
      if (e.key === 'Escape') {
        if (!el.findbar.classList.contains('hidden')) { closeFind(); return; }
        if (settings.zen) { toggleZen(false); return; }
      }
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

    if (k === 'n' && shift) openCompareWindow();
    else if (k === 'n') commands.new();
    else if (k === ',' && !shift) commands.settings();
    else if (k === 'o' && shift) commands.toggleOutline();
    else if (k === 'o') commands.open();
    else if (k === 's' && shift) commands.saveAs();
    else if (k === 's') commands.save();
    else if (k === 'w') commands.closeTab();
    else if (k === 'f' && shift) commands.format();
    else if (k === 'f') openFind();
    else if (k === 'h') openFind(true);
    else if (k === 'd') openCompareWindow();
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
    else if (k === 'p' && shift) openPalette();
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
  if (t.mode === 'wysiwyg') {
    /* 渐进载入进行中 DOM 只有半截，序列化它会把残缺内容写进 t.content，
       标签随即变脏 —— 自动保存一触发就用残篇覆盖磁盘文件。跳过：
       t.content 保持完整源文本，下次激活时重渲染即可。 */
    if (wys.loading) return;
    /* 同上：没编辑过就别把序列化结果写回 t.content —— 规范化（* → -）会
       凭空造出一个脏标记。真编辑过的标签 pending() 必然为真。
       落账后立刻清标记：切到下一个标签时那次迟到的 blur 不该再冲一遍。 */
    if (wys.pending()) { t.content = wys.toMarkdown(); wys.markCommitted(); }
    t.scrollTop = el.wysiwyg.scrollTop;
    t.caret = null;              // 所见即所得的 DOM 光标映射回源码偏移不可靠，只记住滚动位置
  } else if (t.mode === 'edit') {
    t.content = plain.value;
    t.scrollTop = plain.scrollTop;
    t.caret = plain.selection.from;
  }
  if (el.previewPane && !el.previewPane.classList.contains('hidden')) t.previewScroll = el.preview.scrollTop;
}

/* ---------------- 启动 ---------------- */
/* 欢迎文档按语言取，见 welcome.js；这里只在首次启动建标签时用一次。 */
async function boot() {
  /* 语言必须在任何界面文案生成之前定下来：菜单树、工具栏、状态栏、
     空态提示都是后面按需取词的，先定语言才不会渲染出旧语言再闪一下 */
  setLang(resolveLang(settings.lang));
  applyDom();

  bindEvents();
  setupKeys();
  setupAppMenu();
  setupSplitters();
  setupDrop();
  setupBlockHandle();
  setupSidebar();
  el.wysiwyg.addEventListener('scroll', scheduleOutlineSync, { passive: true });
  el.preview.addEventListener('scroll', scheduleOutlineSync, { passive: true });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme();
  });

  /* 先按上次的标签列表开文件，再把没保存的内容捞回来。
     两件事各管一段：会话管「开过哪些文件」，草稿管「哪些还没存」。
     以前这里只恢复最近 5 个文件里的标签，第 6 个开始就静默消失。 */
  const cliFiles = await be.initialFiles().catch(() => []);
  const opened = await restoreSession().catch(() => 0);
  const drafts = await restoreDrafts().catch(() => 0);
  /* 命令行/文件关联带进来的文件：双击 .md 时系统把路径塞进 argv */
  for (const p of cliFiles || []) await openPath(p);
  if (!opened && !drafts && !(cliFiles || []).length) newTab(tt('欢迎.md'), welcomeDoc(getLang()));
  setLayout(settings.layout);
  updateOutline();
  applyZen();

  window.addEventListener('beforeunload', () => { persistCurrentView(); if (!discardOnQuit) saveDraft(); });

  /* Alt+F4 / 任务栏关闭不走标题栏那个按钮，不拦一下就绕过上面那套检查 */
  win.onCloseRequested(async (event) => {
    if (forceClose) return;
    event.preventDefault();
    persistCurrentView();
    const ok = await confirmQuit();
    if (!ok) return;
    finishQuit(ok);
    win.closeWindow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !discardOnQuit) { persistCurrentView(); saveDraft(); }
  });
  /* 回到窗口时看一眼文件有没有被别的程序改过（延迟一点点，避开切换动画期间的 IO 抖动） */
  window.addEventListener('focus', () => setTimeout(checkExternalChange, 250));

  /* 文件变化监听：后端推过来的是「命中名单的绝对路径」。
     拿不到事件源也不影响任何编辑功能，所以静默失败即可。 */
  try { await listen('fs-change', (e) => onFsChange(e.payload)); } catch {}
  /* 第二个实例双击文件时，单实例插件把路径转过来，在这个窗口里打开 */
  try {
    await listen('open-files', (e) => { (e.payload || []).forEach((p) => openPath(p)); });
  } catch {}
  syncWatches();
}

/* 供子面板回调 */
window.__snp = {
  commands,
  plain,
  getActiveTab: activeTab,
  openPath,
  setContent,
  gotoLine,
  newTab,
  getEditorText: () => activeTab() && activeTab().content,
  isBusy: () => wys.loading,
  editor: wys,          // 编辑器实例（与 __diff / __merge 同类调试面：真机 CDP 探针要用）
  capture: persistCurrentView,
};
window.__diff = diff;
window.__merge = merge;

boot().catch((err) => {
  console.error(tt('[启动失败]'), err);
  try { document.getElementById('preview').innerHTML = '<div class="diff-empty">' + tt('启动失败：{msg}', { msg: (err && err.message) || '' }) + '</div>'; } catch {}
});
