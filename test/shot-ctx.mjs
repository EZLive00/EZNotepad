// ============================================================
// test/shot-ctx.mjs —— 表格右键菜单的效果图（明/暗）
// 前置：应用已用 --remote-debugging-port=9333 启动。
// ============================================================
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SHOT_DIR } from './harness.mjs';

const PORT = process.env.CDP_PORT || 9333;
const OUT = SHOT_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data); const p = pending.get(m.id);
  if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
const ev = (x) => call('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  .then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; });
/** 截图要等真实合成帧：WebView2 在 --disable-gpu-sandbox 下会把上一帧交回来 */
const shot = async (name) => {
  await call('Page.bringToFront').catch(() => {});
  await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 180))))`);
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(name, '->', file);
};
const rightClick = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1, buttons: 2 });
  await sleep(30);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, buttons: 0 });
  await sleep(320);
};

const DOC = `# 表格右键

表格前的段落。

| 名称 | 数量 | 备注 |
| --- | :-: | --: |
| 苹果 | 3 | 新鲜 |
| 香蕉 | 5 |  |

表格后的段落。
`;

await sleep(900);
await ev(`(() => {
  const ov = document.getElementById('dlgOverlay');
  if (ov && !ov.hidden) {
    const b = [...document.querySelectorAll('#dlgFoot button')].find((x) => /丢弃/.test(x.textContent));
    if (b) b.click();
  }
  const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
  s.zen = false; s.layout = 'split'; s.outlineVisible = true;
  localStorage.setItem('snp.settings', JSON.stringify({ __v: 4, lang: 'zh-CN', ...s }));
})()`);
await ev(`window.__snp.newTab('表格右键.md', ${JSON.stringify(DOC)})`);
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(700);

for (const theme of ['light', 'dark']) {
  await ev(`document.body.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(260);
  const c = await ev(`(() => {
    const cell = document.querySelectorAll('.wysiwyg td, .wysiwyg th')[1];
    const r = cell.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await rightClick(c.x, c.y);
  await shot(`ctx-${theme}-table.png`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
}
await ev(`document.body.dataset.theme = 'light'`);

try { ws.close(); } catch {}
process.exit(0);
