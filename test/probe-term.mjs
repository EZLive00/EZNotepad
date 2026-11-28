// ============================================================
// test/probe-term.mjs —— 内嵌终端：真的起 shell、真的回显、关掉真的没进程
//
// 为什么只能真机：终端的一切都在 canvas 里，DOM 上一个字都没有；而「开关
// 面板」「切标签」「拖高」全都依赖真实布局。更关键的是 ConPTY 只在真进程里
// 存在 —— 单测能验的只有「谁该认识谁」，验不了「字节真的回流了」。
//
// 覆盖：
//   - 默认不占地方（面板 hidden、没有 shell 进程）
//   - Ctrl+` 开一次只起一个 shell（曾经每按一次多一个）
//   - 提示符真的出现；粘贴路径与键盘路径分别验（合批一坏只坏其中一条）
//   - 终端里 Ctrl+C 交给 shell（出现 ^C），不是我们的快捷键
//   - 终端有焦点时别的快捷键让路（Ctrl+Shift+M 不该弹速记）
//   - 再按 Ctrl+` 只收起、不杀进程；再打开内容还在
//   - 拖柄改高度并落盘
//   - 新建菜单能开第二个 shell，两个会话内容互不串；切回去内容还在
//   - 关标签真的把 shell 进程收掉（数 EZNotepad.exe 之外的 cmd.exe）
//   - 管理员模式：标签带 .admin、shell 起得来、回显正常、关掉整棵树都没了
//
// 管理员这一段走 EZNOTEPAD_PTY_NO_ELEVATE：自动化里没人能点 UAC。
// 它只跳过「提权」这一句 ShellExecuteExW，握手 / 两条连接 / 帧格式 / 收尾
// 全都照走。真正弹 UAC 的那一下只能人工点一次。
//
//   node test/probe-term.mjs
// ============================================================
import { spawnSync } from 'node:child_process';
import { ensureApp } from './lib/appctl.mjs';

/* 必须在 ensureApp 之前：环境变量只在起进程那一刻能塞进去 */
process.env.EZNOTEPAD_PTY_NO_ELEVATE = '1';

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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
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

const screen = (id) => c.ev(`window.__snp.term.screen(${id ? JSON.stringify(id) : ''})`);
const ids = () => c.ev('window.__snp.term.ids()');
const visible = () => c.ev('window.__snp.term.visible()');
const tabTexts = () => c.ev(`[...document.querySelectorAll('.term-tab .tt-name')].map((n) => n.textContent)`);

async function key(key, code, vk, modifiers = 0, text) {
  await c.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', modifiers, key, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text } : {}),
  });
  await c.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers, key, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
/* 组合键必须发 rawKeyDown：带 text 的 keyDown 在 Chromium 里 keyCode 是 0，
   xterm 的 Ctrl 组合查表是按 keyCode 走的，查不到就什么都不发 —— 症状是
   「Ctrl+C 停不掉命令」，而屏幕上连个 ^C 都没有。 */
async function ctrl(key_, code, vk) {
  await c.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', modifiers: 2, key: key_, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await c.send('Input.dispatchKeyEvent', {
    type: 'keyUp', modifiers: 2, key: key_, code,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}
const backquote = () => ctrl('`', 'Backquote', 192);

/* 数一数系统里还剩几个 cmd.exe —— 关终端真的收掉进程，这件事只能从外面看。
   标题过滤太麻烦，直接数 powershell/cmd 的实例：探针自己不起别的 shell。 */
function shellProcs() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 });
  const out = String(r.stdout || '');
  let cmd = 0;
  let ps = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (/^"cmd\.exe"/i.test(line)) cmd++;
    if (/^"powershell\.exe"/i.test(line)) ps++;
  }
  return { cmd, ps };
}
function ezProcs() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq EZNotepad.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000 });
  return String(r.stdout || '').split(/\r?\n/).filter((l) => /^"EZNotepad\.exe"/i.test(l)).length;
}

/* ---------- 0. 起点干净 ----------
   应用可能是复用的（run-probe 里一次起、多探针共用）：上一次留下的终端
   标签会带着还活着的 shell。先全关掉，再从「什么都没有」开始验。 */
const before0 = { cmd: shellProcs().cmd, ps: shellProcs().ps };
await c.ev(`(() => {
  for (const id of window.__snp.term.ids()) window.__snp.term.close(id);
  return true;
})()`);
await sleep(900);
ok('起点：面板是收起的', (await visible()) === false);
ok('起点：一个终端都没有', JSON.stringify(await ids()) === '[]', JSON.stringify(await ids()));
ok('起点：之前开的 shell 进程都收掉了',
  shellProcs().cmd <= before0.cmd && shellProcs().ps <= before0.ps,
  JSON.stringify({ before: before0, after: shellProcs() }));

/* ---------- 1. Ctrl+` 只开一个 ----------
   起哪个 shell 取决于设置里「上次用的」（探针目录是复用的，上一次跑可能
   停在 cmd），所以这里只断言「跟设置一致」，不写死 PowerShell。 */
const remembered = await c.ev(`JSON.parse(localStorage.getItem('snp.settings') || '{}').termShell || 'powershell'`);
const LABEL = { powershell: 'PowerShell', pwsh: 'PowerShell 7', cmd: 'cmd', bash: 'Bash' };
const procsBefore1 = shellProcs();
await backquote();
await sleep(2200);
const one = await ids();
ok('Ctrl+` 打开面板', (await visible()) === true);
ok('Ctrl+` 只起一个 shell（不是每次一个）', one.length === 1, JSON.stringify(one));
ok('标签上写着设置里那个 shell 的名字', (await tabTexts())[0] === LABEL[remembered],
  JSON.stringify({ remembered, tabs: await tabTexts() }));
ok('焦点在终端里（xterm 的隐藏 textarea）',
  await c.ev(`document.activeElement?.classList.contains('xterm-helper-textarea') === true`),
  await c.ev(`String(document.activeElement && document.activeElement.className)`));
ok('系统里真的多了一个 shell 进程',
  shellProcs().cmd + shellProcs().ps > procsBefore1.cmd + procsBefore1.ps,
  JSON.stringify({ before: procsBefore1, after: shellProcs() }));

/* 再按一次不许多开 —— 这是最早的真机 bug（按一次开出两个 shell） */
await backquote();
await sleep(500);
ok('再按 Ctrl+` 只是收起，不起新 shell',
  (await visible()) === false && (await ids()).length === 1, JSON.stringify(await ids()));
await backquote();
await sleep(500);
ok('再展开还是原来那个会话',
  (await visible()) === true && (await ids()).length === 1, JSON.stringify(await ids()));

/* ---------- 2. 粘贴路径 ---------- */
await c.ev(`window.__snp.term.send('echo TERMOK\\r')`);
for (let i = 0; i < 30 && !/TERMOK/.test(await screen()); i++) await sleep(150);
ok('粘贴进去的命令有回显也有输出', /TERMOK/.test(await screen()), JSON.stringify((await screen()).slice(-60)));

/* ---------- 3. 键盘路径与 Ctrl+C ----------
   和粘贴分开验：合批（8ms 攒一次 pty_write）一坏，往往只用其中一条还能用。

   Ctrl+C 走的是「丢掉提示符上这一行」（cmd / PowerShell 都是这样）。
   ⚠️ 正在跑的子进程收不到 Ctrl+C —— ConPTY 把终端输入当按键记录，不生成
   CTRL_C_EVENT，四种合成方式都试过无效（见 term.js 里的注释）。所以这里
   验能验的那一半，别写一条注定红的「ping 被打断」。 */
const lastLine = async () => {
  const l = (await screen()).split('\n').filter((x) => x.trim());
  return l[l.length - 1] || '';
};
for (const ch of ['a', 'b', 'c']) await key(ch, 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), 0, ch);
await sleep(500);
const typedLine = await lastLine();
ok('真键盘打的字进了 shell 的提示符', /abc/.test(typedLine), JSON.stringify(typedLine));
await ctrl('c', 'KeyC', 67);
await sleep(900);
const afterCtrlC = await lastLine();
ok('Ctrl+C 丢掉提示符上这一行，回到干净的空行',
  !/abc/.test(afterCtrlC) && afterCtrlC.length > 0, JSON.stringify(afterCtrlC));
ok('Ctrl+C 没有被应用当成自己的快捷键（没弹提示、没复制）',
  (await c.ev(`document.querySelectorAll('#toasts .toast').length`)) === 0,
  JSON.stringify(await c.ev(`[...document.querySelectorAll('#toasts .toast')].map((n) => n.textContent)`)));
/* ---------- 4. 键盘归属：终端有焦点时别的快捷键让路 ----------
   先做对照（同一个组合在正文里确实会开速记），否则「终端里没反应」什么
   都说明不了 —— 可能只是这个组合压根没绑上。 */
await c.ev(`window.__snp.newTab('py.md', '# 起点', null)`);
await sleep(400);
await key('M', 'KeyM', 77, 10, 'M');
await sleep(1000);
ok('对照：焦点在正文时 Ctrl+Shift+M 会打开速记',
  await c.ev(`!!(window.__snp.getActiveTab() || {}).quickNote`));
await c.ev(`(() => {
  const t = [...document.querySelectorAll('.tab')].find((x) => x.querySelector('.tab-name')?.textContent === '速记');
  if (t) t.querySelector('.tab-close').click();
  return !!t;
})()`);
await sleep(600);

/* 点一下终端标签把焦点交给 xterm —— 新建标签会把焦点抢回编辑区 */
if (!(await ids()).length) await c.ev(`window.__snp.term.open({ shell: ${JSON.stringify(remembered)} })`);
await sleep(600);
await c.ev(`[...document.querySelectorAll('.term-tab')][0].click()`);
await sleep(500);
ok('点终端标签后焦点在终端里',
  await c.ev(`document.activeElement?.classList.contains('xterm-helper-textarea') === true`),
  await c.ev(`String(document.activeElement && document.activeElement.className)`));
const tabBefore = await c.ev(`(window.__snp.getActiveTab() || {}).name`);
await key('M', 'KeyM', 77, 10, 'M');
await sleep(1000);
ok('终端里同一个组合不弹速记（键盘归 shell）',
  (await c.ev(`(window.__snp.getActiveTab() || {}).name`)) === tabBefore,
  JSON.stringify({ before: tabBefore, after: await c.ev(`(window.__snp.getActiveTab() || {}).name`) }));

/* ---------- 5. 拖柄 ----------
   注意面板高度封顶在窗口的 70%（见 term.js 的上限），上一次跑可能正好停在
   封顶值 —— 那就先往下拖变矮，再往上拖变高，两个方向都验。 */
const h0 = await c.ev(`document.getElementById('termPanel').getBoundingClientRect().height`);
const grip = await c.ev(`(() => { const r = document.getElementById('termGrip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
const panelH = () => c.ev(`document.getElementById('termPanel').getBoundingClientRect().height`);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y, buttons: 0 });
await sleep(60);
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1, buttons: 1 });
await sleep(80);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y + 120, buttons: 1 });
await sleep(200);
const hSmall = await panelH();
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y - 40, buttons: 1 });
await sleep(200);
const hBig = await panelH();
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x, y: grip.y - 40, button: 'left', clickCount: 1, buttons: 0 });
await sleep(300);
const savedH = await c.ev(`JSON.parse(localStorage.getItem('snp.settings') || '{}').termHeight`);
ok('往下拖变矮', hSmall < h0 - 60, JSON.stringify({ from: Math.round(h0), to: Math.round(hSmall) }));
ok('往上拖变高', hBig > hSmall + 60, JSON.stringify({ from: Math.round(hSmall), to: Math.round(hBig) }));
ok('高度记得住（落进 settings）', Math.abs(Number(savedH) - Math.round(hBig)) < 2, String(savedH));
ok('面板没有压到状态栏上',
  await c.ev(`(() => {
    const p = document.getElementById('termPanel').getBoundingClientRect();
    const s = document.querySelector('.statusbar').getBoundingClientRect();
    return p.bottom <= s.top + 1;
  })()`));

/* ---------- 6. 新建菜单：第二个 shell + 记住上次用的 ---------- */
await c.ev(`document.getElementById('termMore').click()`);
await sleep(400);
const menuItems = await c.ev(`[...document.querySelectorAll('.ctx-menu .ctx-label')].map((n) => n.textContent)`);
ok('新建菜单列出可用 shell 与「以管理员身份」',
  menuItems.includes('cmd') && menuItems.some((s) => s.includes('（管理员）')), JSON.stringify(menuItems));
await c.ev(`(() => {
  const item = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((n) => n.textContent.trim() === 'cmd');
  if (item) item.click();
  return !!item;
})()`);
await sleep(1600);
const two = await ids();
ok('开出了第二个终端', two.length === 2, JSON.stringify(two));
ok('标签上多了 cmd', (await tabTexts()).includes('cmd'), JSON.stringify(await tabTexts()));
const cmdId = two[two.length - 1];
await c.ev(`window.__snp.term.send('echo CMDOK\\r', ${JSON.stringify(cmdId)})`);
for (let i = 0; i < 30 && !/CMDOK/.test(await screen(cmdId)); i++) await sleep(150);
ok('cmd 里 echo 有回显', /CMDOK/.test(await screen(cmdId)), JSON.stringify((await screen(cmdId)).slice(-50)));
ok('新终端用的是 cmd（记住上次选的 shell）',
  (await c.ev(`JSON.parse(localStorage.getItem('snp.settings') || '{}').termShell`)) === 'cmd',
  String(await c.ev(`JSON.parse(localStorage.getItem('snp.settings') || '{}').termShell`)));

/* 切回第一个：两个会话的内容不能串 */
await c.ev(`[...document.querySelectorAll('.term-tab')][0].click()`);
await sleep(600);
const psScreen = await screen();
ok('切回第一个标签，内容还是 PowerShell 那份',
  /TERMOK/.test(psScreen) && !/CMDOK/.test(psScreen), JSON.stringify(psScreen.slice(-60)));

/* ---------- 7. 关标签真的收进程 ---------- */
const procsBefore = shellProcs();
await c.ev(`[...document.querySelectorAll('.term-tab')][1].querySelector('.tt-x').click()`);
await sleep(1200);
ok('关一个标签只剩一个终端', (await ids()).length === 1, JSON.stringify(await ids()));
ok('关掉的那个 cmd 进程没了', shellProcs().cmd === procsBefore.cmd - 1,
  JSON.stringify({ before: procsBefore, after: shellProcs() }));

/* ---------- 8. 管理员 ----------
   ConPTY 一启动就发 DSR（ESC[6n）问终端光标在哪，并且会等到应答才继续吐。
   xterm 收到会自动回，所以这里「有提示符」就等于 DSR 往返是通的 —— 这一条
   正是 Node 徒手连 helper 时踩过的坑（不回就一个字节都不再出）。 */
const ezBefore = ezProcs();
await c.ev(`document.getElementById('termMore').click()`);
await sleep(400);
await c.ev(`(() => {
  const item = [...document.querySelectorAll('.ctx-menu .ctx-item')].find((n) => n.textContent.trim() === 'cmd（管理员）');
  if (item) item.click();
  return !!item;
})()`);
await sleep(2500);
const adminTabs = await c.ev(`[...document.querySelectorAll('.term-tab')].map((t) => ({ name: t.querySelector('.tt-name').textContent, admin: t.classList.contains('admin') }))`);
const adminTab = (adminTabs || []).find((t) => t.admin);
ok('管理员终端起来了，标签带 .admin 且写明（管理员）',
  !!adminTab && adminTab.name.includes('管理员'), JSON.stringify(adminTabs));
ok('多了一个 EZNotepad.exe（helper 是同一份 exe）', ezProcs() > ezBefore,
  JSON.stringify({ before: ezBefore, after: ezProcs() }));

const adminId = (await ids()).slice(-1)[0];
await c.ev(`window.__snp.term.send('echo ADMINOK\\r', ${JSON.stringify(adminId)})`);
for (let i = 0; i < 40 && !/ADMINOK/.test(await screen(adminId)); i++) await sleep(150);
ok('管理员 shell 回显正常（DSR 往返是通的）',
  /ADMINOK/.test(await screen(adminId)), JSON.stringify((await screen(adminId)).slice(-60)));

/* 提权重排：主进程只能通过帧告诉 helper 新尺寸 */
const colsBefore = await c.ev(`(() => { const r = document.querySelector('.term-host.on .xterm-screen'); return r ? r.getBoundingClientRect().width : 0; })()`);
await c.ev(`(() => { document.getElementById('termPanel').style.height = '340px'; window.__snp.term.visible(); window.dispatchEvent(new Event('resize')); return true; })()`);
await sleep(900);
ok('重排以后管理员终端还活着', /ADMINOK/.test(await screen(adminId)), `cols=${colsBefore}`);

const ezMid = ezProcs();
await c.ev(`window.__snp.term.close(${JSON.stringify(adminId)})`);
await sleep(2000);
ok('关掉管理员终端，helper 与 shell 一起收掉', ezProcs() < ezMid,
  JSON.stringify({ before: ezMid, after: ezProcs() }));

/* ---------- 9. 收尾 ---------- */
await c.ev(`(() => { for (const id of window.__snp.term.ids()) window.__snp.term.close(id); return true; })()`);
await sleep(1500);
ok('全关掉后面板自己收起', (await visible()) === false);
ok('全关掉后没有残余终端', JSON.stringify(await ids()) === '[]', JSON.stringify(await ids()));

console.log(`\n${pass}/${pass + fail} 通过`);
c.close();
process.exit(fail ? 1 : 0);
