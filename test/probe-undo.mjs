// ============================================================
// test/probe-undo.mjs —— 撤销 / 重做的真机行为
//
// 为什么必须真机：撤销靠真实按键推动，而且要看工具栏按钮的可用状态是否真的
// 跟着历史栈走。合成 `KeyboardEvent` 测不出默认行为，jsdom 里也没有
// `Input.dispatchKeyEvent`。这里用 CDP 按真键。
//
// 覆盖：
//   - 所见即所得：输入进栈、Ctrl+Z 逐步后退、Ctrl+Y / Ctrl+Shift+Z 重做
//   - 纯文本（CM6）：同上
//   - 菜单命令（commands.undo）与快捷键必须落在同一套栈上
//   - 焦点在侧栏时 Ctrl+Z 仍然有效（真实使用里最常见的「以为坏了」）
//   - 工具栏两个按钮：无历史时禁用、有历史可点、点一下真的退、到底后又变灰
//
//   node test/probe-undo.mjs
// ============================================================
import { ensureApp } from './lib/appctl.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ensureApp(PORT);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && !/compare\.html/.test(t.url));
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

async function key(mods, k, vk) {
  for (const type of ['keyDown', 'keyUp']) {
    await c.send('Input.dispatchKeyEvent', {
      type, modifiers: mods, key: k, code: 'Key' + k.toUpperCase(),
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
}
const ctrlZ = () => key(2, 'z', 90);
const ctrlY = () => key(2, 'y', 89);
const ctrlShiftZ = () => key(10, 'Z', 90);

const text = async () => ((await c.ev('window.__snp.getEditorText()')) || '').replace(/\n+$/, '');
const btn = async (id) => c.ev(`document.getElementById('${id}').disabled`);
const type = (s) => c.send('Input.insertText', { text: s });

/** 新标签 + 指定模式 + 聚焦。每个用例都从干净状态开始，别让上一条的栈串过来 */
async function fresh(mode) {
  await c.ev('window.__snp.newTab()');
  await c.ev('window.__snp.commands.' + (mode === 'wysiwyg' ? 'modeWysiwyg' : mode === 'edit' ? 'modeEdit' : 'modePreview') + '()');
  await sleep(450);
  if (mode !== 'preview') {
    await c.ev(mode === 'wysiwyg'
      ? 'document.getElementById("wysiwyg").focus()'
      : 'window.__snp.plain.focus()');
    await sleep(150);
  }
}

/** 三次输入，间隔超过 700ms 的合并窗口 —— 否则历史里只有一条，测不出「逐步」 */
async function typeThree() {
  await type('AAA'); await sleep(900);
  await type('BBB'); await sleep(900);
  await type('CCC'); await sleep(900);
}

/* ---------- 1. 所见即所得 ---------- */
await fresh('wysiwyg');
ok('新标签没有可撤销的历史', (await btn('btnUndo')) === true);

await typeThree();
ok('输入后「撤销」按钮变为可用', (await btn('btnUndo')) === false);
const w0 = await text();
ok('输入内容正确', w0 === 'AAABBBCCC', w0);

await ctrlZ(); await sleep(400);
const w1 = await text();
ok('Ctrl+Z 退一步', w1 === 'AAABBB', `"${w0}" -> "${w1}"`);

await ctrlZ(); await sleep(400);
ok('Ctrl+Z 再退一步', (await text()) === 'AAA', await text());

await ctrlY(); await sleep(400);
const w3 = await text();
ok('Ctrl+Y 重做', w3 === 'AAABBB', `"${w3}"`);

await ctrlZ(); await sleep(300);
await ctrlShiftZ(); await sleep(400);
ok('Ctrl+Shift+Z 也能重做', (await text()) === 'AAABBB', await text());

/* 菜单命令必须和快捷键用同一套栈（以前 wysiwyg 走的是浏览器原生栈） */
await fresh('wysiwyg');
await typeThree();
const m0 = await text();
await c.ev('window.__snp.commands.undo()');
await sleep(450);
const m1 = await text();
ok('菜单「撤销」与快捷键同栈', m1 === 'AAABBB', `"${m0}" -> "${m1}"`);

/* 工具栏按钮：点一下真的退，到底后两个按钮的状态要反过来 */
await c.ev(`document.getElementById('btnUndo').click()`);
await sleep(450);
ok('点工具栏「撤销」退一步', (await text()) === 'AAA', await text());

/* 历史里第一条是「空文档」，所以还要再退一步才到底 */
await c.ev(`document.getElementById('btnUndo').click()`);
await sleep(450);
const bottom = await text();
ok('退到栈底后「撤销」变灰', bottom === '' && (await btn('btnUndo')) === true, `"${bottom}"`);
ok('此时「重做」可用', (await btn('btnRedo')) === false);

await c.ev(`document.getElementById('btnRedo').click()`);
await sleep(450);
ok('点工具栏「重做」回一步', (await text()) === 'AAA', await text());

/* ---------- 2. 纯文本（CM6） ---------- */
await fresh('edit');
await typeThree();
const e0 = await text();
await ctrlZ(); await sleep(400);
const e1 = await text();
ok('纯文本 Ctrl+Z', e1 === 'AAABBB', `"${e0}" -> "${e1}"`);
await ctrlY(); await sleep(400);
ok('纯文本 Ctrl+Y', (await text()) === 'AAABBBCCC', await text());

await fresh('edit');
await typeThree();
const p0 = await text();
await c.ev('window.__snp.commands.undo()');
await sleep(450);
ok('纯文本 菜单「撤销」', (await text()) === 'AAABBB', `"${p0}"`);

/* ---------- 3. 焦点不在编辑区 ---------- */
await fresh('wysiwyg');
await typeThree();
const f0 = await text();
await c.ev('document.querySelector(".side-tab").focus()');
await ctrlZ(); await sleep(450);
const f1 = await text();
ok('焦点在侧栏时 Ctrl+Z 仍生效', f1 === 'AAABBB', `"${f0}" -> "${f1}"`);

/* ---------- 4. 预览模式 ---------- */
await fresh('preview');
ok('预览模式「撤销」禁用', (await btn('btnUndo')) === true);
ok('预览模式「重做」禁用', (await btn('btnRedo')) === true);

/* ---------- 5. 工具行排布 ---------- */
const tb = await c.ev(`(() => { const t = document.getElementById('toolbar'); return { sw: t.scrollWidth, cw: t.clientWidth, n: t.querySelectorAll('.tb').length }; })()`);
ok('工具行多了两个按钮但不溢出', tb.sw <= tb.cw + 1, JSON.stringify(tb));
ok('工具行现在有 5 颗按钮', tb.n === 5, String(tb.n));

console.log(`\n${pass}/${pass + fail} 通过`);
c.close();
process.exit(fail ? 1 : 0);
