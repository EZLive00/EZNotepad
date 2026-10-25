// ============================================================
// test/shot-app.mjs —— 给真实窗口截图（需要应用带 --remote-debugging-port=9333 启动）
//
//   node test/shot-app.mjs   →  node_modules/.tmp/app-*.png
//
// 和 shot-ui.mjs 的区别：那边是静态骨架（只看 CSS），这边是跑起来的真应用，
// 文件树、设置面板、查找高亮这些必须有 JS 才出得来。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('node_modules/.tmp');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CDP_PORT || 9333;
const ROOT = path.resolve('.').replace(/\\/g, '/');

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

const boot = async (patch) => {
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
    Object.assign(s, ${JSON.stringify(patch)});
    localStorage.setItem('snp.settings', JSON.stringify(s));
    localStorage.removeItem('snp.draft');
    location.reload();
  })()`);
  await ev(sleep(1500));
  // 刷新时未保存的标签会写草稿，重载后弹「恢复草稿」——截图里不要这个弹窗
  await ev(`document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click()`);
  await ev(`localStorage.removeItem('snp.draft')`);
  await ev(sleep(250));
};

// 1) 文件页：真实目录树
await boot({ theme: 'light', side: 'files', outlineVisible: true, layout: 'split', folder: ROOT });
await ev(`window.__snp.newTab('产品设计备忘.md', '# 产品设计备忘\\n\\n## 一、现状\\n\\n界面足够克制，问题在层级太平均。\\n\\n## 二、改造方向\\n\\n先把分区做出来。', null)`);
await ev(sleep(300));
await ev(`window.__snp.commands.modeWysiwyg()`);
await ev(sleep(400));
await shot('app-files-light.png');

// 2) 设置面板
await ev(`window.__snp.commands.settings()`);
await ev(sleep(400));
await shot('app-settings-light.png');
await ev(`document.querySelector('#dlgFoot button')?.click()`);
await ev(sleep(200));

// 3) 所见即所得里的查找高亮
await ev(`window.__snp.commands.find()`);
await ev(`(() => {
  const i = document.getElementById('findInput');
  i.value = '界面';
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await ev(sleep(400));
await shot('app-find-light.png');

// 4) 深色的文件页
await boot({ theme: 'dark', side: 'files', folder: ROOT });
await ev(sleep(600));
await shot('app-files-dark.png');

// 5) 大纲页：滚到中段，当前章节自动点亮
await boot({ theme: 'light', side: 'outline', folder: ROOT });
const headings = Array.from({ length: 8 }, (_, i) => `## 第 ${i + 1} 章\n\n这一章的内容。\n\n再写一段，把页面撑长一点，滚动才有意义。\n`).join('\n');
await ev(`window.__snp.newTab('长文档.md', ${JSON.stringify(headings)}, null)`);
await ev(`window.__snp.commands.modeWysiwyg()`);
await ev(sleep(400));
await ev(`(() => {
  const w = document.getElementById('wysiwyg');
  w.scrollTop = Math.round(w.scrollHeight * 0.55);
})()`);
await ev(sleep(500));
await shot('app-outline-light.png');

ws.close();
