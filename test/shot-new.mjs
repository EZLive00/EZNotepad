// ============================================================
// test/shot-new.mjs —— 给这一轮的新功能截几张图看效果
//
//   node test/shot-new.mjs   →  node_modules/.tmp/new-*.png
//
// 前置：应用已用 --remote-debugging-port=9333 启动。
// 截图是用来「看」的：公式排版、专注模式的留白这种东西，断言只能证明元素在，
// 好不好看还得人眼过一遍。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('node_modules/.tmp');
fs.mkdirSync(OUT, { recursive: true });
const PORT = process.env.CDP_PORT || 9333;

const pend = new Map();
let seq = 0;
let ws = null;

const onMsg = (e) => {
  const m = JSON.parse(e.data);
  const p = pend.get(m.id);
  if (p) { pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = list.find((t) => t.type === 'page');
  if (!pg) throw new Error('没有找到页面目标');
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  ws.addEventListener('message', onMsg);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
}

const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = (expr) => call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  .then((r) => (r.exceptionDetails ? null : r.result.value));
const sleep = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
const probeState = () => ev(`(() => {
  const el = document.getElementById('preview');
  return document.querySelectorAll('#preview .katex').length
    + '/' + ((el.textContent.match(/\\$/g) || []).length)
    + ' katex=' + (typeof window.katex) + ' renderFn=' + (typeof window.renderMathInElement)
    + ' rts=' + (window.katex ? typeof window.katex.renderToString : 'n/a')
    + ' scripts=' + document.querySelectorAll('script[src*="katex"]').length;
})()`);

const shot = async (name) => {
  /* 等两帧：WebView2 在 --disable-gpu-sandbox 下偶尔会把「上一帧」交回来，
     刚由 KaTeX 插入的节点就会在截图里缺席。双 rAF + 一点余量能稳定挡住这个假象。 */
  await call('Page.bringToFront').catch(() => {});
  await ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 180))))`);
  console.log(`  [${name}] 截图前 katex/$ = ${await probeState()}`);
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  console.log(`  [${name}] 截图后 katex/$ = ${await probeState()}`);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(name, '->', file);
};

/** 等公式真的渲染出来再截图。KaTeX 是运行时注入的，reload 之后要重新读 545 KB */
async function waitKatex(n, limit = 8000) {
  for (let t = 0; t < limit; t += 200) {
    if ((await ev(`document.querySelectorAll('#preview .katex').length`)) >= n) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 350));
}

/** 改设置后重载，再重连接（reload 会把旧的 WebSocket 弄断） */
async function boot(patch) {
  await ev(`(() => {
    const s = JSON.parse(localStorage.getItem('snp.settings') || '{}');
    Object.assign(s, ${JSON.stringify(patch)});
    localStorage.setItem('snp.settings', JSON.stringify({ __v: 2, ...s }));
    localStorage.removeItem('snp.draft');
    location.reload();
  })()`).catch(() => {});
  try { ws.close(); } catch {}
  await new Promise((r) => setTimeout(r, 2600));
  await connect();
  /* reload 会触发 beforeunload → saveDraft，把刚清掉的草稿又写回来，
     于是启动时会弹「恢复上次的草稿」。截图前先点掉它。 */
  await ev(`(() => {
    const b = [...document.querySelectorAll('#dlgFoot button')].find((x) => /丢弃/.test(x.textContent));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 350));
}

const DOC = `# 数学公式示例

行内公式不会打断句子：质能方程 $E = mc^2$，下标 $a_1 + a_2 + \\cdots + a_n$ 也照常写。

## 块级公式

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

$$
\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}
\\begin{pmatrix} x \\\\ y \\end{pmatrix}
=
\\begin{pmatrix} ax + by \\\\ cx + dy \\end{pmatrix}
$$

## 混排

公式里的 * 和 _ 不会被当成斜体，这是渲染前就先保护住的：

- 求和 $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$
- 极限 $\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$
- 矩阵 $\\det(A - \\lambda I) = 0$

普通文字里的 **加粗** 和 _斜体_ 仍然正常工作。
`;

await connect();

/* ---- 1. 双栏：左边源码，右边渲染 ---- */
await boot({ theme: 'dark', layout: 'split', outlineVisible: false, zen: false });
await ev(`window.__snp.newTab('公式示例.md', ${JSON.stringify(DOC)})`);
await sleep(300);
await ev(`window.__snp.commands.modeEdit()`);
await waitKatex(8);
await shot('new-1-math-split-dark.png');

/* ---- 2. 独预览：看公式排版本身 ---- */
await ev(`window.__snp.commands.modePreview()`);
await waitKatex(8);
await shot('new-2-math-preview.png');

/* ---- 3. 专注模式 ---- */
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(400);
await ev(`window.__snp.commands.toggleZen()`);
await sleep(600);
await shot('new-3-zen-dark.png');
await ev(`window.__snp.commands.toggleZen()`);
await sleep(300);

/* ---- 4. 浅色 + 目录插在文首 ---- */
/* 这里不再 reload 换主题：WebView2 在 reload 之后有一段时间交不出新帧，
   截图会拿到旧的合成结果（DOM 明明是对的）。就地切主题更稳。 */
await ev(`window.__snp.commands.themeLight()`);
if (!(await ev(`document.getElementById('outlinePane').getBoundingClientRect().width > 0`))) {
  await ev(`window.__snp.commands.toggleOutline()`);
}
await sleep(400);
await ev(`window.__snp.newTab('目录示例.md', ${JSON.stringify(DOC)})`);
await sleep(300);
await ev(`window.__snp.commands.modeEdit()`);
await sleep(250);
await ev(`window.__snp.commands.toc()`);
await sleep(400);
await ev(`window.__snp.commands.modePreview()`);
await sleep(1600);
await shot('new-4-toc-light.png');

ws.close();
console.log('done');
