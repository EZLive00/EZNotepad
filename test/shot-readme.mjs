// ============================================================
// test/shot-readme.mjs —— README 用英文界面截图（需要应用带 --remote-debugging-port=9333 启动）
//
//   node test/shot-readme.mjs   →  SHOT_DIR/readme-{light,dark}.png
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { SHOT_DIR } from './harness.mjs';

const OUT = SHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CDP_PORT || 9333;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const sleep = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;
const shot = async (name) => {
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(name, '->', file);
};

const doc = [
  '# EZNotepad',
  '',
  'A lightweight Markdown editor with **WYSIWYG**, source editing and preview — plus fast text diffing for everyday work.',
  '',
  '## Highlights',
  '',
  '- WYSIWYG editing: type `# ` for a heading, `**bold**` turns bold instantly',
  '- Multiple tabs, document outline, folder tree with full-text search',
  '- Character-level diff, side by side, jump between changes with F7 / F8',
  '- History snapshots, single-file HTML export, three-way merge',
  '',
  '## Modes',
  '',
  '| Mode | What it does |',
  '|---|---|',
  '| WYSIWYG | Write Markdown with live formatting |',
  '| Source | Raw text with syntax highlighting |',
  '| Preview | Clean read-only rendering |',
  '',
  '> Everything stays on your machine. No network, no upload, no tracking.',
  '',
  'Press `Ctrl+Shift+P` to open the command palette and find any command.',
  '',
].join('\n');

// 语言切英文 + 浅色主题，等应用按新语言重载完成
await ev(`(() => {
  const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
  Object.assign(s, { lang: 'en', theme: 'light', side: 'outline', outlineVisible: true, layout: 'single' });
  localStorage.setItem('snp.settings', JSON.stringify({ __v: 4, ...s }));
  localStorage.removeItem('snp.draft');
  location.reload();
})()`);
await ev(sleep(1800));
// 关掉「恢复草稿」弹窗（如有）
await ev(`document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click()`);
await ev(`localStorage.removeItem('snp.draft')`);
await ev(sleep(250));

// 清掉会话恢复/自动创建的多余标签：先建 Welcome（排在最后），再把前面的关到只剩它
await ev(`window.__snp.newTab('Welcome.md', ${JSON.stringify(doc)}, null)`);
await ev(`(async () => {
  for (let i = 0; i < 6; i++) {
    const tabs = document.querySelectorAll('.tab');
    if (tabs.length <= 1) break;
    tabs[0].querySelector('[class*="close"], .t-x, button')?.click();
    await new Promise(r => setTimeout(r, 200));
    // 若弹了确认框（未保存提示），选不保存
    const dlg = document.getElementById('dlgOverlay');
    if (dlg && !dlg.hidden) {
      document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click();
      await new Promise(r => setTimeout(r, 200));
    }
  }
})()`);
await ev(sleep(300));
await ev(sleep(300));
await ev(`window.__snp.commands.modeWysiwyg()`);
await ev(sleep(500));
await shot('readme-light.png');

// 深色主题直接切 data-theme，不重载（标签/滚动位置都保住）
await ev(`document.body.dataset.theme = 'dark'`);
await ev(sleep(500));
await shot('readme-dark.png');
await ev(`document.body.dataset.theme = 'light'`);

ws.close();
