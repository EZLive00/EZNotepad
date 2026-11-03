// ============================================================
// test/probe-quicknote.mjs —— 速记：固定位置、不用保存、随时可用
//
// 为什么必须真机：这个功能的全部承诺都在「打字之后磁盘上真的有了」，
// 而合成事件既不经过真实的输入法管线，也没法证明 Rust 那边写到了哪个路径。
// 这里按真键、读真文件。
//
// 覆盖：
//   - 路径只由后端给，且探针跑在 %TEMP%（绝不碰用户真正的那份笔记）
//   - 打开就停在末尾；标签上写「速记」而不是 quicknote.md
//   - 打字 350ms 后自动落盘；不出现脏标记
//   - Ctrl+S 不弹保存框；打字后立刻关标签，最后几个字也要写完
//   - 编辑模式同样自动保存；「插入当前时间」真的插进正文
//   - 同一个入口重复打开只有一份（不会两个编辑器写同一个文件）
//   - 菜单里自成一个一级菜单，并写明它存在哪
//   - 清空会先留历史快照，然后文件真的变空
//   - 速记不进「会话」：下次启动不会被当成上次打开的文档
//
//   node test/probe-quicknote.mjs
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ensureApp, PROBE_QUICKNOTE } from './lib/appctl.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ensureApp(PORT);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));
if (!page) throw new Error('找不到主窗口');

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const h = pending.get(m.id);
    if (h) { pending.delete(m.id); h(m); }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 8000);
  });
  return {
    ready,
    send: call,
    async ev(expr) {
      const m = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'eval 异常');
      return m.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

const c = connect(page.webSocketDebuggerUrl);
await c.ready;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const disk = () => { try { return fs.readFileSync(PROBE_QUICKNOTE, 'utf8'); } catch { return ''; } };
const editorText = async () => ((await c.ev('window.__snp.getEditorText()')) || '').replace(/\n+$/, '');
const type = (s) => c.send('Input.insertText', { text: s });

/* 上一次跑留下的「恢复上次的草稿」会挡在最前面（探针共用同一个配置目录）。
   按别的探针一样的规矩先点掉：优先「丢弃」，没有就点第一个按钮。 */
await c.ev(`(() => {
  const ov = document.getElementById('dlgOverlay');
  if (!ov || ov.classList.contains('hidden')) return false;
  const bs = [...document.querySelectorAll('#dlgFoot button')];
  const pick = bs.find((b) => /丢弃/.test(b.textContent)) || bs[0];
  if (pick) pick.click();
  return true;
})()`);
await sleep(250);

/* 应用可能是复用的：上一次跑留下的速记标签会带着旧内容。
   先按 title（= 绝对路径）找到那个标签关掉，再从干净的文件开始。
   速记永远算干净，关它不会弹「要保存吗」。 */
await c.ev(`(() => {
  const p = ${JSON.stringify(PROBE_QUICKNOTE)};
  const el = [...document.querySelectorAll('.tab')].find((t) => t.title === p);
  if (el) el.querySelector('.tab-close').click();
  return !!el;
})()`);
await sleep(400);

fs.mkdirSync(path.dirname(PROBE_QUICKNOTE), { recursive: true });
fs.writeFileSync(PROBE_QUICKNOTE, '# 起点\n\n第一行\n', 'utf8');

/* ---------- 1. 路径与隔离 ---------- */
const file = await c.ev('window.__snp.quickNoteFile()');
ok('速记路径由后端给出，并与探针目录一致',
  !!file && path.resolve(file).toLowerCase() === path.resolve(PROBE_QUICKNOTE).toLowerCase(), String(file));

/* ---------- 2. 打开 ---------- */
const first = await c.ev(`(async () => {
  const t = await window.__snp.openQuickNote();
  return { id: t && t.id, name: t && t.name, path: t && t.path, text: window.__snp.getEditorText() };
})()`);
ok('打开速记拿到一个标签', !!first && !!first.id, JSON.stringify(first && first.path));
ok('读到了磁盘上的种子内容', String(first.text || '').includes('起点'), JSON.stringify(first.text));
ok('标签上写「速记」而不是文件名',
  (await c.ev(`document.querySelector('.tab.active .tab-name')?.textContent`)) === '速记');

/* ---------- 3. 自动保存 ---------- */
/* 打开就接着上次往下写：新字必须落在文档末尾，而不是开头。
   编辑器末尾本来就有一个空段落等你写，所以断言「落在末尾」而不是「落在最后一行」。 */
await type('AAA');
await sleep(900);
ok('打开后接着上次往下写（新字落在末尾）',
  (await editorText()).trimEnd().endsWith('AAA') && disk().trimEnd().endsWith('AAA'),
  JSON.stringify(disk().slice(-14)));

const dirty = await c.ev(`({
  dot: !!document.querySelector('.tab.active .tab-dot'),
  title: document.title,
})`);
ok('速记不显示「未保存」标记', dirty.dot === false && !String(dirty.title).includes('•'), JSON.stringify(dirty));

/* Ctrl+S 落在速记上不该弹保存对话框（位置是固定的） */
for (const t of ['keyDown', 'keyUp']) {
  await c.send('Input.dispatchKeyEvent', {
    type: t, modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83,
  });
}
await sleep(400);
const afterSave = await c.ev(`({
  hidden: document.getElementById('dlgOverlay').classList.contains('hidden'),
  title: document.getElementById('dlgTitle').textContent,
  body: document.getElementById('dlgBody').textContent,
})`);
ok('Ctrl+S 不弹保存框', afterSave.hidden === true, JSON.stringify(afterSave));

/* ---------- 4. 关标签前最后几个字也要落地 ---------- */
await type('ZZZ');
/* 不等 350ms 防抖，立刻关 —— closeTab 里会先 flush */
await c.ev(`(() => {
  const p = ${JSON.stringify(PROBE_QUICKNOTE)};
  const el = [...document.querySelectorAll('.tab')].find((t) => t.title === p);
  if (el) el.querySelector('.tab-close').click();
})()`);
await sleep(600);
ok('打完立刻关标签，最后几个字没有丢', disk().includes('ZZZ'), JSON.stringify(disk().slice(-12)));

const reopened = await c.ev(`(async () => {
  const t = await window.__snp.openQuickNote();
  return { id: t && t.id, text: window.__snp.getEditorText() };
})()`);
ok('重新打开读到的是刚才写的内容', String(reopened.text || '').includes('ZZZ'));

/* ---------- 5. 重复打开只有一份 ---------- */
const tabCount0 = await c.ev(`document.querySelectorAll('.tab').length`);
const again = await c.ev(`(async () => { const t = await window.__snp.openQuickNote(); return t && t.id; })()`);
ok('再点一次「打开速记」还是同一个标签',
  again === reopened.id && (await c.ev(`document.querySelectorAll('.tab').length`)) === tabCount0,
  `${again} vs ${reopened.id}`);

/* 从「打开文件」这条路进来也要落回同一份，不能开出第二个编辑器 */
const viaPath = await c.ev(`(async () => { const t = await window.__snp.openPath(${JSON.stringify(PROBE_QUICKNOTE)}); return t && t.id; })()`);
ok('从文件路径打开速记也回到同一个标签', viaPath === reopened.id, String(viaPath));

/* ---------- 6. 编辑模式 + 时间戳 ---------- */
await c.ev('window.__snp.commands.modeEdit()');
await sleep(300);
await c.ev('window.__snp.plain.focus(); window.__snp.plain.setSelection(window.__snp.plain.value.length)');
await type('PLAIN');
await sleep(900);
ok('编辑模式下同样自动保存', disk().includes('PLAIN'), JSON.stringify(disk().slice(-10)));

await c.ev('window.__snp.plain.focus(); window.__snp.plain.setSelection(window.__snp.plain.value.length)');
await c.ev('window.__snp.commands.quickStamp()');
await sleep(600);
const stamp = disk().match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
ok('插入当前时间，格式是 年-月-日 时:分', !!stamp, stamp && stamp[0]);
ok('时间戳也落到了磁盘', !!stamp && disk().includes(stamp[0]));

/* ---------- 7. 菜单 ----------
   用户：「速记要点两次，不合理」—— 一级项展开是下拉，里面再点「打开速记」。
   现在它是一个动作项：点一下按钮速记就开，不弹下拉。辅助动作挪进「文件」，
   不是删掉。 */
const menu = await c.ev(`(async () => {
  const bar = [...document.querySelectorAll('.am-btn')];
  const btn = bar.find((b) => b.textContent === '速记');
  if (!btn) return { found: false, labels: bar.map((b) => b.textContent) };
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  const panel = document.querySelector('.appmenu');
  const t = window.__snp.getActiveTab();
  return {
    found: true,
    panelOpen: !!panel && !panel.hidden,
    quick: !!(t && t.quickNote),
    labels: bar.map((b) => b.textContent),
  };
})()`);
ok('菜单栏里有独立的「速记」一级项', menu.found === true, JSON.stringify(menu.labels || ''));
ok('点一次「速记」就打开速记（不再弹二级菜单）',
  menu.panelOpen === false && menu.quick === true, JSON.stringify(menu));

/* 辅助动作不能被顺手删掉：它们只是搬了家 */
const fileMenu = await c.ev(`(async () => {
  const bar = [...document.querySelectorAll('.am-btn')];
  const btn = bar.find((b) => b.textContent === '文件');
  btn.click();
  await new Promise((r) => setTimeout(r, 150));
  const panel = document.querySelector('.appmenu');
  const out = {
    items: [...panel.querySelectorAll('.am-item .am-label')].map((n) => n.textContent),
    notes: [...panel.querySelectorAll('.am-note')].map((n) => n.textContent),
  };
  btn.click();
  return out;
})()`);
ok('速记的辅助动作在「文件」菜单里',
  ['插入当前时间', '清空速记…'].every((s) => (fileMenu.items || []).includes(s)), JSON.stringify(fileMenu.items));
ok('「文件」里写明速记存在哪',
  (fileMenu.notes || []).some((s) => s.includes('quicknote.md')), JSON.stringify(fileMenu.notes));
/* 按 Esc 收菜单（点第一个顶级项只会换成「文件」那个下拉） */
for (const t of ['keyDown', 'keyUp']) {
  await c.send('Input.dispatchKeyEvent', { type: t, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}
await sleep(150);

/* ---------- 8. 不进会话 ---------- */
const session = await c.ev(`JSON.parse(localStorage.getItem('snp.session') || '[]')`);
ok('速记不进「上次打开的标签」',
  Array.isArray(session) && !session.some((s) => s && s.path === file), JSON.stringify(session));

/* ---------- 9. 清空 ---------- */
const before = disk();
await c.ev('void window.__snp.commands.quickClear()');
await sleep(300);
const dlg = await c.ev(`(() => {
  const ov = document.getElementById('dlgOverlay');
  const open = !ov.classList.contains('hidden');
  const title = document.getElementById('dlgTitle').textContent;
  const body = document.getElementById('dlgBody').textContent;
  const btn = [...document.querySelectorAll('#dlgFoot button')].find((b) => b.textContent === '清空');
  return { open, title, body, hasBtn: !!btn };
})()`);
ok('清空前先问一句，并说清有多少字', dlg.open && dlg.hasBtn && dlg.body.includes(String(before.length)), JSON.stringify(dlg.title));
await c.ev(`[...document.querySelectorAll('#dlgFoot button')].find((b) => b.textContent === '清空')?.click()`);
await sleep(700);
ok('确认后文件真的变空', disk() === '', JSON.stringify(disk()));
ok('编辑器里的内容也跟着清了', (await editorText()) === '');

/* ---------- 10. 空速记再清一次：不弹多余的对话框 ---------- */
await c.ev('void window.__snp.commands.quickClear()');
await sleep(300);
ok('空速记再清一次不弹确认框', (await c.ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`)) === true);

/* ---------- 11. 快捷键 ---------- */
await c.ev(`(() => {
  const p = ${JSON.stringify(PROBE_QUICKNOTE)};
  const el = [...document.querySelectorAll('.tab')].find((t) => t.title === p);
  if (el) el.querySelector('.tab-close').click();
})()`);
await sleep(400);
await c.ev('window.__snp.newTab()');
await sleep(300);
for (const t of ['keyDown', 'keyUp']) {
  await c.send('Input.dispatchKeyEvent', {
    type: t, modifiers: 10, key: 'M', code: 'KeyM', windowsVirtualKeyCode: 77, nativeVirtualKeyCode: 77,
  });
}
await sleep(700);
const hot = await c.ev(`(() => { const t = window.__snp.getActiveTab(); return { path: t && t.path, quick: !!(t && t.quickNote) }; })()`);
ok('Ctrl+Shift+M 从任何标签打开速记', hot.quick === true && hot.path === file, JSON.stringify(hot));

const recent = await c.ev(`JSON.parse(localStorage.getItem('snp.recent') || '[]')`);
ok('速记不进「最近打开」', Array.isArray(recent) && !recent.includes(file), JSON.stringify(recent));

/* 收尾：把标签关掉，别把状态留给后面的探针 */
await c.ev(`(() => {
  const p = ${JSON.stringify(PROBE_QUICKNOTE)};
  const el = [...document.querySelectorAll('.tab')].find((t) => t.title === p);
  if (el) el.querySelector('.tab-close').click();
})()`);

console.log(`\n${pass}/${pass + fail} 通过`);
c.close();
process.exit(fail ? 1 : 0);
