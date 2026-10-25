// ============================================================
// test/shot-bmenu.mjs —— 手柄 + 块菜单的效果图（明/暗）
// 前置：应用已用 --remote-debugging-port=9333 启动。
// ============================================================
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9333;
const OUT = path.resolve('node_modules/.tmp');
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
const moveTo = (x, y) => call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
const click = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(35);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
};
/** 截图要等真实合成帧：WebView2 在 --disable-gpu-sandbox 下会把上一帧交回来 */
const shot = async (name) => {
  await call('Page.bringToFront').catch(() => {});
  await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 180))))`);
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(name, '->', file);
};

const DOC = `# 块手柄

把鼠标移到这些段落上，左侧会出现两个按钮：加号用来在下方插入，
六个点的抓手用来转换这一块的类型。

## 这是二级标题

- 列表项也能用手柄转换
- 换成引用、代码块、表格都从这里进

> 引用块同样适用。
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
  localStorage.setItem('snp.settings', JSON.stringify(s));
})()`);
await ev(`window.__snp.newTab('块手柄.md', ${JSON.stringify(DOC)})`);
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(700);

for (const theme of ['light', 'dark']) {
  await ev(`document.body.dataset.theme = ${JSON.stringify(theme)}`);
  await sleep(260);
  /* 悬停到第二个段落，让手柄出现在它左侧 */
  const p = await ev(`(() => {
    const b = [...document.querySelectorAll('.w-block')].filter((n) => n.dataset.type === 'p')[1];
    const r = b.getBoundingClientRect();
    return { x: r.left + 60, y: r.top + r.height / 2 };
  })()`);
  await moveTo(p.x, p.y);
  await sleep(320);
  const add = await ev(`(() => {
    const r = document.getElementById('whAdd').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (let i = 1; i <= 4; i++) { await moveTo(p.x + (add.x - p.x) * i / 4, p.y + (add.y - p.y) * i / 4); await sleep(16); }
  await sleep(80);
  await shot(`bmenu-${theme}-hover.png`);        // 先拍「只有手柄」
  await click(add.x, add.y);
  await sleep(320);
  await shot(`bmenu-${theme}-menu.png`);         // 再拍「菜单展开」
  /* 关掉，进入下一轮 */
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
}
await ev(`document.body.dataset.theme = 'light'`);

try { ws.close(); } catch {}
process.exit(0);
