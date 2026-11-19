// ============================================================
// test/shot-wys.mjs —— 给「所见即所得」拍一套观感图
//
//   node test/shot-wys.mjs   →  SHOT_DIR/wys-{light,dark}[-bottom].png
//
// 用一篇把各种块都摆上的文档（标题 / 行内格式 / 链接 / 列表 / 任务 /
// 引用 / 提示块 / 代码块 / 表格 / 分割线）跑一遍，浅色深色各出一张首屏、
// 一张滚到底的图。这个内核的「像不像 Typora」只能看图判断，断言测不出来。
//
// 不需要事先起应用：端口上没实例会自己拉一个（跑完随进程退出收掉）。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ensureApp } from './lib/appctl.mjs';
import { SHOT_DIR } from './harness.mjs';

const OUT = SHOT_DIR;
fs.mkdirSync(OUT, { recursive: true });

const PORT = process.env.CDP_PORT || 9333;
await ensureApp(PORT);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, { res, rej: res });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  .then((r) => (r.exceptionDetails ? { __err: r.exceptionDetails.exception?.description } : r.result.value));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (file) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(file);
};

const DOC = [
  '# 演示文档',
  '',
  '这是一段**粗体**、*斜体*、~~删除线~~、`行内码` 与 [链接](https://example.com) 混排的正文。',
  '',
  '## 二级标题',
  '',
  '- 无序项一',
  '- 无序项二',
  '  - 缩进的子项',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '- [ ] 未完成的任务',
  '- [x] 已完成的任务',
  '',
  '> 一句引用。',
  '',
  '> [!info] 提示',
  '> 这是提示块的内容。',
  '',
  '```js',
  'const a = 1;',
  'function f() { return a + 1; }',
  '```',
  '',
  '| 列一 | 列二 |',
  '| --- | :-: |',
  '| 甲 | 乙 |',
  '',
  '---',
  '',
  '结尾段落。',
  '',
].join('\n');

for (const theme of ['light', 'dark']) {
  await ev(`window.__snp.commands.theme${theme === 'light' ? 'Light' : 'Dark'}()`);
  await sleep(300);
  const name = `wys-${theme}.md`;
  await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(DOC)}, null)`);
  await sleep(500);
  await ev('window.__snp.commands.modeWysiwyg()');
  await sleep(900);
  await ev(`window.__snp.editor.setSelection(0)`);
  await sleep(300);
  await shot(path.join(OUT, `wys-${theme}.png`));
  await ev(`(() => { const s = document.querySelector('#wysiwyg .cm-scroller'); s.scrollTop = s.scrollHeight; })()`);
  await sleep(500);
  await shot(path.join(OUT, `wys-${theme}-bottom.png`));

  /* 表格格内编辑：点开某格之后的样子。这个状态只能看图判断 ——
     输入框浮在格子上，字体、行高、内边距对不对齐，断言测不出来 */
  await ev(`(() => {
    const td = document.querySelector('#wysiwyg .cm-lp-table [data-row="1"][data-col="1"]');
    if (!td) return 0;
    td.scrollIntoView({ block: 'center' });
    const r = td.getBoundingClientRect();
    td.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
      clientX: r.left + 10, clientY: r.top + 10,
    }));
    return 1;
  })()`);
  await sleep(450);
  await shot(path.join(OUT, `wys-${theme}-cell.png`));
  await ev(`(() => {
    const i = document.querySelector('#wysiwyg .cm-lp-cell');
    if (i) i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(250);
}
process.exit(0);
