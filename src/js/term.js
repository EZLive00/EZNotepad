// ============================================================
// term.js —— 内嵌终端面板（底部）
//
// 渲染交给 xterm.js，真实进程交给 Rust 的 pty（见 src-tauri/src/pty.rs）。
// 这一层只做三件事：
//   1. 面板生命周期：展开 / 收起 / 拖高，以及多标签的切换；
//   2. 把 pty 的字节流写进 xterm，把 xterm 的按键写回 pty；
//   3. 尺寸同步 —— 面板一变，xterm 重新算行列，pty 跟着重排。
//
// ⛔ 键盘这块有个前提：终端必须是一个「焦点岛」。应用全局快捷键
//   （Ctrl+C / Ctrl+W / Ctrl+K / Tab …）在 shell 里全是控制键，
//   被抢走的话「Ctrl+C 停不掉命令」这种问题根本没法解释给用户。
//   判定入口是 app.js::setupKeys 开头的 termHasFocus()，这里只提供判据。
//
// ⛔ 不用 navigator.clipboard.writeText：WebView2 里时好时坏（见 clipboard.js）。
//   复制走 writeClipboard，粘贴才用 readText（那是唯一的读入口）。
// ============================================================
import { listen } from '../vendor/api/event.js';
import * as be from './backend.js';
import { settings, saveSettings } from './state.js';
import { toast, contextMenu } from './ui.js';
import { tt } from './i18n.js';
import { errText } from './errors.js';
import { writeClipboard } from './clipboard.js';
import { iconHTML } from './icons.js';
import * as win from './win.js';

/** 动态载入的 xterm 模块：没开过终端的用户不为它付解析代价 */
let lib = null;
let styleLoaded = false;

let panel = null;
let tabsEl = null;
let bodyEl = null;
let myLabel = 'main';
/** 由 app.js 注入：当前该在哪个目录开终端（当前文档所在目录 / 侧栏第一个根） */
let getCwd = () => '';

const views = new Map();   // id -> view
let active = null;
let booted = false;

/* ---------------- 主题 ---------------- */

/** 终端配色跟着七个面走：底色用「坑」（比纸面低一步），强调色当光标 */
function termTheme() {
  const cs = getComputedStyle(document.body);
  const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
  return {
    background: v('--bg-well', '#ffffff'),
    foreground: v('--fg', '#1c2024'),
    cursor: v('--accent', '#d13415'),
    cursorAccent: v('--bg-well', '#ffffff'),
    selectionBackground: v('--accent-soft', 'rgba(0,0,0,.12)'),
    black: v('--gray-12', '#1c2024'),
    brightBlack: v('--fg-faint', '#80838d'),
    red: v('--red-9', '#e5484d'),
    green: v('--green-9', '#30a46c'),
    yellow: v('--amber-9', '#ffc53d'),
    blue: v('--blue-9', '#0090ff'),
    magenta: v('--violet-11', '#8e4ec6'),
    cyan: v('--teal-11', '#0d9488'),
    white: v('--gray-7', '#cdced6'),
  };
}

/** 换主题时重刷所有终端（xterm 的 theme 是实例属性，得逐个设） */
export function refreshTermTheme() {
  if (!views.size) return;
  const th = termTheme();
  for (const v of views.values()) v.term.options.theme = th;
}

/* ---------------- 尺寸 ---------------- */

function fitView(v) {
  if (!v || !v.host.isConnected) return;
  // 面板收着、标签切走时容器是 0×0，fit 会算出荒唐的行列（甚至负数）
  if (!v.host.offsetWidth || !v.host.offsetHeight) return;
  try { v.fit.fit(); } catch { /* 面板正在动画/收起，下一轮再说 */ }
  if (!v.dead) be.ptyResize(v.id, v.term.cols, v.term.rows).catch(() => {});
}

export function relayoutTerm() {
  if (!panel || panel.classList.contains('hidden')) return;
  fitView(active);
}

/* ---------------- 面板 ---------------- */

function applyHeight() {
  if (!panel) return;
  const h = Math.max(120, Math.min(Number(settings.termHeight) || 260, window.innerHeight * 0.7));
  panel.style.height = h + 'px';
}

function showPanel(on) {
  if (!panel) return;
  panel.classList.toggle('hidden', !on);
  if (on) {
    applyHeight();
    // 先让布局落定再量：刚去掉 hidden 时容器尺寸还是 0
    requestAnimationFrame(() => {
      fitView(active);
      active?.term.focus();
    });
  }
}

export function termVisible() {
  return !!(panel && !panel.classList.contains('hidden'));
}

/** 键盘归属判据：焦点在面板里（含 xterm 的隐藏 textarea）就算终端在管键盘 */
export function termHasFocus() {
  return termVisible() && panel.contains(document.activeElement);
}

export async function toggleTerm() {
  if (termVisible()) {
    showPanel(false);
    // 收起后焦点跟着走：不然键盘「还在终端里」，正文一个字都打不进去
    const t = document.querySelector('.wysiwyg:not(.hidden)') || document.getElementById('editor');
    t?.focus();
    return;
  }
  await openTermOrShow();
}

async function openTermOrShow() {
  await ensureLib();
  await ensurePanel();
  // 已经有一个活着就直接展开它 —— 再开一个等于每按一次 Ctrl+` 多一个 shell
  if (!views.size) await openTerm().catch((e) => toast(errText(e)));
  else showPanel(true);
}

/* ---------------- 一个终端 ---------------- */

const b64ToBytes = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function labelOf(shell, admin) {
  const name = { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'cmd', bash: 'Bash' }[shell] || shell;
  return admin ? name + tt('（管理员）') : name;
}

/**
 * 开一个终端标签。
 * @param {{shell?:string, admin?:boolean, cwd?:string}} opts
 */
export async function openTerm(opts = {}) {
  await ensureLib();
  await ensurePanel();
  showPanel(true);

  const shell = opts.shell || settings.termShell || 'powershell';
  const admin = !!opts.admin;
  const cwd = opts.cwd || getCwd() || '';

  const host = document.createElement('div');
  host.className = 'term-host';
  bodyEl.appendChild(host);

  const term = new lib.Terminal({
    fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: termTheme(),
    // ConPTY 已经把 \n 变成 \r\n；再让 xterm 自己转换会出现空行
    convertEol: false,
  });
  const fit = new lib.FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const view = { id: null, term, fit, host, tab: null, admin, shell, dead: false, buf: '', timer: 0 };

  // 先把尺寸量出来再开 pty：反过来的话 ConPTY 拿到的是默认 80×24，
  // 第一屏提示符按错的宽度折行
  await new Promise((r) => requestAnimationFrame(r));
  try { fit.fit(); } catch { /* 面板刚显示，量不到就用默认值，pty 起来后还会再同步一次 */ }

  const id = await be.ptyOpen({
    shell,
    cwd: cwd || null,
    cols: Math.max(20, term.cols || 80),
    rows: Math.max(2, term.rows || 24),
    owner: myLabel,
    // ⚠️ 这个字段一漏，标签上写着「（管理员）」而跑的是普通会话 ——
    // 界面看不出来，只有数一下进程数才发现没有 helper
    admin,
  });
  view.id = id;
  views.set(id, view);

  const tab = document.createElement('button');
  tab.type = 'button';
  tab.className = 'term-tab' + (admin ? ' admin' : '');
  tab.dataset.id = id;
  tab.innerHTML = `${iconHTML('terminal')}<span class="tt-name"></span>`
    + `<span class="tt-x" role="button" aria-label="${tt('关闭终端')}">${iconHTML('x')}</span>`;
  tab.querySelector('.tt-name').textContent = labelOf(shell, admin);
  tab.title = cwd || labelOf(shell, admin);
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.tt-x')) { closeTerm(id); return; }
    activateTerm(id);
  });
  tabsEl.appendChild(tab);
  view.tab = tab;

  /* 输入侧：8ms 合批。xterm 的 onData 是按事件来的，粘贴一大段会拆成很多次，
     每次都过一次 IPC 是白花的时间；8ms 攒起来等于「一次按键量级」的延迟。 */
  term.onData((d) => {
    view.buf += d;
    if (view.timer) return;
    view.timer = setTimeout(() => {
      const payload = view.buf;
      view.buf = '';
      view.timer = 0;
      if (!payload || view.dead) return;
      be.ptyWrite(id, payload).catch(() => {});
    }, 8);
  });
  term.onResize(({ cols, rows }) => {
    if (view.dead) return;
    be.ptyResize(id, cols, rows).catch(() => {});
  });

  /* Ctrl+Shift+C / V：Windows Terminal 的约定。这里只拦这两个组合，
     其余一律放行给 shell —— 终端里没有任何一个 Ctrl 组合是「我们的」。 */
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      copySelection(view);
      return false;
    }
    if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      pasteInto(view);
      return false;
    }
    /* 其余 Ctrl 组合一律原样交给 shell。注意 Ctrl+C 只到得了「行编辑器」
       —— 0x03 会让提示符上那一行丢掉，但**正在跑的子进程收不到**：
       ConPTY 把终端输入当按键记录，不生成 CTRL_C_EVENT（0x03 / win32 输入
       模式序列 / AttachConsole+WriteConsoleInputW / GenerateConsoleCtrlEvent
       四种都试过，attach 与注入都返回成功，前台进程组一律无反应）。
       要停掉跑飞的命令目前只能关掉这个终端（会 taskkill /T 整棵树）。 */
    return true;
  });

  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const hasSel = term.hasSelection();
    contextMenu(e.clientX, e.clientY, [
      { label: tt('复制'), shortcut: 'Ctrl+Shift+C', disabled: !hasSel, action: () => copySelection(view) },
      { label: tt('粘贴'), shortcut: 'Ctrl+Shift+V', action: () => pasteInto(view) },
      { sep: true },
      { label: tt('清空'), action: () => term.clear() },
      { label: tt('关闭终端'), danger: true, action: () => closeTerm(id) },
    ]);
  });

  activateTerm(id);
  return id;
}

function copySelection(view) {
  const sel = view.term.getSelection();
  if (!sel) return;
  if (writeClipboard(sel)) toast(tt('已复制'));
  view.term.clearSelection();
}

async function pasteInto(view) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) view.term.paste(text);
  } catch {
    toast(tt('请按 Ctrl+Shift+V 粘贴'));
  }
}

function activateTerm(id) {
  const v = views.get(id);
  if (!v) return;
  active = v;
  for (const x of views.values()) {
    x.host.classList.toggle('on', x === v);
    x.tab.classList.toggle('on', x === v);
  }
  requestAnimationFrame(() => {
    fitView(v);
    v.term.focus();
  });
}

export function closeTerm(id) {  const v = views.get(id);
  if (!v) return;
  views.delete(id);
  v.dead = true;
  if (v.timer) clearTimeout(v.timer);
  be.ptyKill(id).catch(() => {});
  v.term.dispose();
  v.host.remove();
  v.tab.remove();
  if (active === v) {
    active = null;
    const next = [...views.keys()].pop();
    if (next) activateTerm(next);
    else showPanel(false);
  }
}

/* ---------------- 探针 ---------------- */

/** 当前终端屏幕上有什么（整段回滚缓冲的纯文本）。只给真机探针用：
 *  终端的一切都发生在 canvas 里，DOM 上除了几个 div 一个字都没有。 */
export function termScreen(id = null) {
  const v = id ? views.get(id) : active;
  if (!v) return '';
  const b = v.term.buffer.active;
  const total = b.length;
  const out = [];
  // 只取最后 2000 行：命令跑了一屏又一屏时，断言关心的是尾巴
  for (let i = Math.max(0, total - 2000); i < total; i++) {
    out.push(b.getLine(i)?.translateToString(true) ?? '');
  }
  return out.join('\n');
}

export const termIds = () => [...views.keys()];

/** 探针：走「粘贴」那条路往终端送一段文字（onData → 合批 → pty_write）。
 *  键盘路径另由 CDP 真实按键验证，两者要分开断言 —— 合批一坏，
 *  粘贴能用而打字不能用。 */
export function termSend(text, id = null) {
  const v = id ? views.get(id) : active;
  if (!v) return false;
  v.term.paste(String(text));
  return true;
}

/* ---------------- 事件 ---------------- */

async function ensureStyle() {
  if (styleLoaded) return;
  styleLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'vendor/xterm.css';
  document.head.appendChild(link);
}

async function ensureLib() {
  if (lib) return lib;
  await ensureStyle();
  lib = await import('../vendor/xterm.js');
  return lib;
}

async function ensurePanel() {
  if (booted) return;
  panel = document.getElementById('termPanel');
  tabsEl = document.getElementById('termTabs');
  bodyEl = document.getElementById('termBody');
  // 单独的测试夹具里没有这块 DOM：没有就不接，别让 boot 挂掉
  if (!panel || !tabsEl || !bodyEl) return;
  myLabel = await win.label();

  document.getElementById('termHide').addEventListener('click', () => toggleTerm());
  document.getElementById('termMore').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openShellMenu(r.left, r.bottom + 4);
  });

  bindGrip();

  /* 事件订阅在这层失败不该拖垮启动：终端面板本身还能用（只是收不到输出），
     而 boot 里那一步是 await 的，抛出去整扇窗都起不来。 */
  try {
    await listen('pty:data', (e) => {
      const { id, data } = e.payload || {};
      const v = views.get(id);
      if (v) v.term.write(b64ToBytes(data));
    });
    await listen('pty:exit', (e) => {
      const v = views.get(e.payload?.id);
      if (!v) return;
      v.dead = true;
      v.tab.classList.add('dead');
      v.term.write('\r\n\x1b[2m[' + tt('进程已退出') + ']\x1b[0m\r\n');
    });
  } catch (e) {
    console.warn('[term] 事件订阅失败', e);
  }

  // 面板被拖高 / 窗口缩放：xterm 重算行列，pty 跟着重排
  let t = 0;
  const ro = new ResizeObserver(() => {
    if (t) cancelAnimationFrame(t);
    t = requestAnimationFrame(() => { t = 0; fitView(active); });
  });
  ro.observe(bodyEl);

  booted = true;
}

/* ---------------- 拖高 ---------------- */

function bindGrip() {
  const grip = document.getElementById('termGrip');
  if (!grip) return;
  /* 和 setupSplitters 同一套写法（mousedown + window 上跟 mousemove），
     不用 setPointerCapture：真机上一次拖拽中途 capture 会丢，
     而这里要的只是「按住那一刻开始跟鼠标」。 */
  let on = false;
  let startY = 0;
  let startH = 0;

  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    on = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    document.body.classList.add('resizing-v');
  });
  window.addEventListener('mousemove', (e) => {
    if (!on) return;
    // 往上拖 = 变高：终端在下方，所以是「起点减当前」
    const h = Math.max(120, Math.min(startH + (startY - e.clientY), window.innerHeight * 0.7));
    settings.termHeight = Math.round(h);
    panel.style.height = settings.termHeight + 'px';
    fitView(active);
  });
  window.addEventListener('mouseup', () => {
    if (!on) return;
    on = false;
    document.body.classList.remove('resizing-v');
    saveSettings();
    fitView(active);
  });
}

/* ---------------- 新建菜单（选 shell / 管理员） ---------------- */

async function openShellMenu(x, y) {
  let shells = ['powershell'];
  try { shells = await be.ptyShells(); } catch { /* 后端没就绪就只给一项 */ }
  if (!shells.length) shells = ['powershell'];
  const items = [];
  items.push({ head: tt('新建终端') });
  for (const s of shells) {
    items.push({ label: labelOf(s, false), action: () => { settings.termShell = s; saveSettings(); openTerm({ shell: s }); } });
  }
  items.push({ sep: true });
  items.push({ head: tt('以管理员身份') });
  for (const s of shells) {
    items.push({ label: labelOf(s, true), action: () => openTerm({ shell: s, admin: true }) });
  }
  contextMenu(x, y, items, { stayOnScroll: true });
}

/* ---------------- 启动 ---------------- */

/**
 * @param {{getCwd?:()=>string}} opts
 */
export async function initTerm(opts = {}) {
  if (opts.getCwd) getCwd = opts.getCwd;
  await ensurePanel();
  applyHeight();
}

/* 给拆窗用的：把订阅整体挪到另一扇窗（pty 进程不重启） */
export async function retargetTerms(label) {
  for (const id of views.keys()) {
    await be.ptyRetarget(id, label).catch(() => {});
  }
  myLabel = label;
}
