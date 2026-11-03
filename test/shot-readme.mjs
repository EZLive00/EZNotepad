// ============================================================
// test/shot-readme.mjs —— README 用截图（英文界面；应用由 appctl 自己起，带调试端口）
//
//   node test/shot-readme.mjs
//     → SHOT_DIR/readme-{light,dark,split,compare}.png
//   跑完把四张图拷进 docs/screenshots（light.png / dark.png / split.png / compare.png）。
//
// 覆盖 docs/screenshots 里 README 引用的四张图：
//   light.png / dark.png      主界面（所见即所得 + 大纲）
//   split.png                 双栏：所见即所得 + 预览（表格 / 公式 / 代码）
//   compare.png               文本对比窗口
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { SHOT_DIR } from './harness.mjs';
import { ensureApp } from './lib/appctl.mjs';

const OUT = SHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.CDP_PORT || 9333);

// 端口上已经有应用就直接用；没有就自己起一个，退出时由 appctl 收干（含对比窗口）
await ensureApp(PORT);

/** 连一个 CDP target，返回 { call, ev, shot, close } */
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pend.get(m.id);
    if (p) { pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    .then((r) => (r.exceptionDetails ? null : r.result.value));
  const shot = async (name) => {
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(name, '->', file);
  };
  return { call, ev, shot, close: () => ws.close() };
}

const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
  .filter((t) => t.type === 'page');

const sleep = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

// ---------------------------------------------------------------
// 演示文档：标题 / 表格 / 提示块 / 代码 / 公式 / 任务列表都露一下
// ---------------------------------------------------------------
const doc = [
  '# EZNotepad',
  '',
  'A **5 MB** desktop utility: Markdown writing, plain-text editing and file comparison.',
  'Portable, offline, ready on double-click.',
  '',
  '## Why it stays small',
  '',
  '| Item | Size / time |',
  '|---|---|',
  '| Installer | 2.63 MB |',
  '| Clean start | ~170 MB RAM |',
  '| 10.8 MB document | opens in 1.14 s |',
  '| 100k-line log | opens in 20 ms |',
  '',
  '> [!tip] Type Markdown, see the result',
  '> `# ` at the start of a line makes a heading, `**bold**` turns bold while you type,',
  '> and `Ctrl+3` gives you a clean read-only preview.',
  '',
  '## Code, math and tables',
  '',
  '```js',
  'const blocks = compare(left, right);   // character-level marks',
  'if (blocks.some((b) => b.moved)) jumpTo(b);',
  '```',
  '',
  'Inline math such as $a^2 + b^2 = c^2$ is typeset by KaTeX in the preview only.',
  '',
  '- [x] Tabs, outline and folder-wide search',
  '- [x] Version history, single-file HTML export',
  '- [ ] Your next note goes here',
  '',
].join('\n');

const leftDoc = [
  '# Release notes',
  '',
  '## 1.0.2',
  '',
  '### Compare',
  '',
  '- Select two files in the tree, then right-click to diff them',
  '- Paste one text into each side of the blank compare window',
  '- F7 / F8 jump between differences',
  '',
  '### Editor',
  '',
  '- Tabs keep only the dividers between them, no boxes',
  '- Preview tables use the same grid as the editor',
  '- Settings can be reopened with Ctrl+,',
  '',
  '## 1.0.1',
  '',
  '- About dialog reads the real version number',
  '- CI derives the tag from tauri.conf.json',
  '- Portable build ships as a zip next to the installer',
  '',
].join('\n');

const rightDoc = [
  '# Release notes',
  '',
  '## 1.0.2',
  '',
  '### Compare',
  '',
  '- Pick two files in the tree, then right-click to compare them',
  '- F7 / F8 jump between differences',
  '',
  '### Editor',
  '',
  '- Tabs: only the dividers between tabs, no boxes',
  '- Preview: tables share the grid of the editor',
  '',
  '## 1.0.1',
  '',
  '- About dialog reads the real version number',
  '- CI derives the tag from tauri.conf.json',
  '',
].join('\n');

// ---------------------------------------------------------------
// 主窗口
// ---------------------------------------------------------------
let pages = await targets();
let page = pages.find((t) => !/compare\.html/.test(t.url));
if (!page) throw new Error('找不到主窗口 target');
let M = await attach(page);

// 英文 + 浅色 + 单栏 + 显示大纲，等应用按新语言重载
await M.ev(`(() => {
  const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
  Object.assign(s, { lang: 'en', theme: 'light', side: 'outline', outlineVisible: true, layout: 'single' });
  localStorage.setItem('snp.settings', JSON.stringify({ __v: 4, ...s }));
  localStorage.removeItem('snp.draft');
  location.reload();
})()`);
await M.ev(sleep(2000));
// 「恢复草稿」弹窗（如有）
await M.ev(`document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click()`);
await M.ev(`localStorage.removeItem('snp.draft')`);
await M.ev(sleep(300));

// 只留一个 Welcome 标签：先建（排在最后），再把前面的逐个关掉
await M.ev(`window.__snp.newTab('Welcome.md', ${JSON.stringify(doc)}, null)`);
await M.ev(`(async () => {
  for (let i = 0; i < 8; i++) {
    const tabs = document.querySelectorAll('.tab');
    if (tabs.length <= 1) break;
    tabs[0].querySelector('[class*="close"], .t-x, button')?.click();
    await new Promise(r => setTimeout(r, 220));
    const dlg = document.getElementById('dlgOverlay');
    if (dlg && !dlg.hidden) {
      document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click();
      await new Promise(r => setTimeout(r, 200));
    }
  }
})()`);
await M.ev(sleep(400));
await M.ev(`window.__snp.commands.modeWysiwyg()`);
await M.ev(sleep(600));
await M.ev(`document.querySelector('.wysiwyg')?.scrollTo(0, 0)`);
await M.ev(sleep(300));
await M.shot('readme-light.png');

await M.ev(`document.body.dataset.theme = 'dark'`);
await M.ev(sleep(600));
await M.shot('readme-dark.png');

// 双栏：左边所见即所得，右边预览（表格网格 / 公式 / 代码同屏）
await M.ev(`document.body.dataset.theme = 'light'`);
await M.ev(sleep(300));
await M.ev(`window.__snp.commands.layoutSplit()`);
await M.ev(sleep(800));
await M.ev(`document.querySelector('.preview-body')?.scrollTo(0, 0)`);
await M.ev(sleep(400));
await M.shot('readme-split.png');

// ---------------------------------------------------------------
// 对比窗口：先写两份样例文件，再让主窗口开对比
// ---------------------------------------------------------------
const dir = path.join(OUT, 'readme-cmp');
fs.mkdirSync(dir, { recursive: true });
const fL = path.join(dir, 'release-notes.md');
const fR = path.join(dir, 'release-notes.old.md');
fs.writeFileSync(fL, leftDoc, 'utf8');
fs.writeFileSync(fR, rightDoc, 'utf8');

const left = JSON.stringify(fR.split('/').join('\\'));
const right = JSON.stringify(fL.split('/').join('\\'));
await M.ev(`(async () => {
  const be = await import('./js/backend.js');
  await be.openCompareWindow(${left}, ${right});
})()`);
await M.ev(sleep(2500));

// 新开的窗口是另一个 target
const cmp = (await targets()).find((t) => /compare\.html/.test(t.url));
if (!cmp) throw new Error('对比窗口没起来');
const C = await attach(cmp);
await C.ev(`(() => {
  const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
  if (s.lang !== 'en') { localStorage.setItem('snp.settings', JSON.stringify({ __v: 4, ...s, lang: 'en' })); location.reload(); }
})()`);
await C.ev(sleep(1600));
await C.ev(`document.body.dataset.theme = 'light'`);
await C.ev(sleep(500));
// 对比窗口默认铺满工作区，README 里用不着那么大：缩到 1280x760 再拍
try {
  const { windowId } = await C.call('Browser.getWindowForTarget', { targetId: cmp.id });
  await C.call('Browser.setWindowBounds', { windowId, bounds: { width: 1280, height: 640 } });
  await C.ev(sleep(500));
} catch (e) {
  console.warn('窗口缩放失败（继续用原尺寸）:', e.message);
}
await C.shot('readme-compare.png');

C.close();
M.close();

// 临时样例文件留在 SHOT_DIR 下，不删（本机删除会进回收站）
console.log('done');
// 子进程（如果本轮是 appctl 起的）会撑住事件循环；显式退出触发 exit 钩子里的收尾
process.exit(0);
