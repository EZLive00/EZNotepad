// ============================================================
// test/probe-media.mjs —— 文件查看器：真的打开 png / zip / 二进制
//
// 为什么只能真机：类型探测走 Rust（文件头）、图片尺寸要靠浏览器真的解码、
// 压缩包要真的读出条目 —— 三件事离线页里都只有假后端。
//
// 覆盖：
//   - 默认收起；打开 png 后正文区换成查看器、编辑器让位
//   - 认类型与真实尺寸（PNG 头部与解码宽高）
//   - 缩放：1:1 / 200% / 适应窗口
//   - 模式菜单在查看器上全置灰；状态栏写类型与体积
//   - zip 列条目、进子目录、预览条目文本、返回、筛选
//   - tar.gz 走同一条路
//   - 7z / PDF / Office 这类本程序打不开的：**先问一句**要不要用系统程序打开，
//     取消就什么都不发生（不建标签、不拉系统程序）
//   - 未知二进制 → 十六进制，从 00000000 开始
//   - ASCII 的陌生扩展名仍然退化成文本标签（别把文本当二进制）
//   - 切回文本标签：查看器让位、编辑器回来、Ctrl+F 恢复
//   - 同一个文件再点一次：复用标签，不开第二个
//
//   node test/probe-media.mjs
// ============================================================
import { ensureApp } from './lib/appctl.mjs';
import { writePng, writeZip, writeTarGz, writeWav } from './lib/mkmedia.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 测试文件现造在临时目录：二进制样本不入库 */
const dir = mkdtempSync(join(tmpdir(), 'ez-media-'));
const P = (n) => join(dir, n);
writePng(P('dot.png'), 200, 120, [230, 77, 46]);
writeWav(P('tone.wav'));
writeZip(P('pack.zip'), [
  { name: 'readme.txt', data: 'top level\n' },
  { name: 'docs/a.txt', data: 'hello from inside the archive\n' },
  { name: 'docs/b.json', data: '{"k":1}\n' },
]);
writeZip(P('fake.7z'), [{ name: 'x.txt', data: 'x' }]);
writeTarGz(P('pack.tgz'), [
  { name: 'readme.txt', data: 'top level\n' },
  { name: 'docs/a.txt', data: 'hello from inside the archive\n' },
]);
{
  // 7z 的魔数改成真的 7z：只为了验「认得出、但明确说不支持」
  const { readFileSync, writeFileSync } = await import('node:fs');
  const b = readFileSync(P('fake.7z'));
  b[0] = 0x37; b[1] = 0x7a; b[2] = 0xbc; b[3] = 0xaf; b[4] = 0x27; b[5] = 0x1c;
  writeFileSync(P('fake.7z'), b);
}
{
  const { writeFileSync } = await import('node:fs');
  writeFileSync(P('blob.bin'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x41, 0x42, 0x43]));
  writeFileSync(P('note.xyz'), 'plain ascii text, no NUL bytes\n');
  /* 本程序打不开的两种：PDF 连探测都走不到（openPath 先按扩展名拦），
     docx 则是「Office 扩展名优先于魔数」那条判据 —— 内容是合法 zip，
     但它是 Office 文档，不该被列成一个压缩包。 */
  writeFileSync(P('手册.pdf'), '%PDF-1.4\n%fake body for the probe\n');
}
writeZip(P('表格.docx'), [{ name: 'word/document.xml', data: '<w/>' }]);

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

const state = () => c.ev('window.__snp.viewer.state()');
const visible = () => c.ev('window.__snp.viewer.visible()');
const tabCount = () => c.ev(`document.querySelectorAll('.tab').length`);
const rows = () => c.ev(`[...document.querySelectorAll('#viewerPane .ar-row')].map((r) => r.dataset.name)`);
const editWrapHidden = () => c.ev(`document.getElementById('editWrap').classList.contains('hidden')`);
const paneHidden = () => c.ev(`document.getElementById('viewerPane').classList.contains('hidden')`);
const findbarHidden = () => c.ev(`document.getElementById('findbar').classList.contains('hidden')`);

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  return false;
}

const open = async (p) => {
  await c.ev(`window.__snp.openPath(${JSON.stringify(p)})`);
  await sleep(900);
};

/* 会弹「要不要用系统程序打开」的那类：**不能 await** —— openPath 要等用户
   点完才 resolve，await 会一直挂在这里，等到 call 的 20s 超时。 */
const openThenAsk = async (p) => {
  await c.ev(`void window.__snp.openPath(${JSON.stringify(p)})`);
};

const dialog = () => c.ev(`(() => {
  const o = document.getElementById('dlgOverlay');
  if (!o || o.classList.contains('hidden')) return null;
  const btns = [...document.querySelectorAll('#dlgFoot button')];
  return {
    title: document.getElementById('dlgTitle').textContent,
    body: document.getElementById('dlgBody').textContent,
    labels: btns.map((b) => b.textContent),
  };
})()`);

const waitDialog = async () => { await waitFor(async () => !!(await dialog())); return dialog(); };

const clickDialog = (label) => c.ev(`(() => {
  const b = [...document.querySelectorAll('#dlgFoot button')].find((x) => x.textContent === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`);

/* ---------- 0. 初始状态 ----------
   先开一个文本标签当起点：探针会恢复上次会话，上一次跑完可能正停在某个
   查看器上，直接断言「初始没有查看器」会得到一条跟被测行为无关的红。 */
await c.ev(`window.__snp.newTab('probe-base.md', '# base', null)`);
await sleep(500);
ok('文本标签上不显示查看器', (await visible()) === false && (await paneHidden()) === true);
ok('文本标签上编辑器在', (await editWrapHidden()) === false);

/* ---------- 1. 图片 ---------- */
await open(P('dot.png'));
ok('png 打开后是查看器', (await visible()) === true);
const s1 = await state();
ok('认出 png', s1 && s1.kind === 'image' && s1.format === 'png', JSON.stringify(s1));
ok('解码出真实尺寸 200×120', s1 && s1.natural && s1.natural.w === 200 && s1.natural.h === 120, JSON.stringify(s1 && s1.natural));
ok('默认按适应窗口算出了缩放', s1 && s1.scale > 0 && s1.scale <= 1, s1 && String(Math.round(s1.scale * 1000) / 1000));
ok('正文区换成查看器', (await paneHidden()) === false && (await editWrapHidden()) === true);
ok('状态栏写的是图片与尺寸',
  /图片/.test(await c.ev(`document.getElementById('stLines').textContent`))
  && /200 × 120/.test(await c.ev(`document.getElementById('stChars').textContent`)),
  await c.ev(`document.getElementById('stLines').textContent + ' | ' + document.getElementById('stChars').textContent`));
ok('标签名是文件名', (await c.ev(`(window.__snp.getActiveTab() || {}).name`)) === 'dot.png');
ok('模式菜单三项全置灰',
  await c.ev(`[...document.querySelectorAll('#modeMenu button[data-mode]')].every((b) => b.classList.contains('disabled'))`));
ok('工具条按钮齐全（缩放 / 适应 / 定位 / 系统打开）',
  await c.ev(`(() => {
    const acts = [...document.querySelectorAll('#viewerPane .vw-btn')].map((b) => b.dataset.act).filter(Boolean);
    return ['zoom-in','zoom-out','zoom-reset','fit','folder','system'].every((a) => acts.includes(a));
  })()`));

/* 200% 就是原图两倍宽；「适应窗口」要能回到窗口内 */
await c.ev('window.__snp.viewer.setZoom(2)');
await sleep(300);
const w2 = await c.ev(`document.querySelector('#viewerPane .vw-img').getBoundingClientRect().width`);
ok('200% 时宽度 = 原图两倍（400px）', Math.abs(w2 - 400) < 3, String(Math.round(w2)));
await c.ev(`[...document.querySelectorAll('#viewerPane .vw-btn')].find((b) => b.dataset.act === 'fit').click()`);
await sleep(300);
const wFit = await c.ev(`document.querySelector('#viewerPane .vw-img').getBoundingClientRect().width`);
/* 200×120 的图比舞台小，适应窗口 = 1:1（不放大），宽度回到 200 */
ok('点「适应窗口」回到原图大小（小图不放大）', Math.abs(wFit - 200) < 3, String(Math.round(wFit)));

/* ---------- 2. zip ---------- */
const tabsBefore = await tabCount();
await open(P('pack.zip'));
const s2 = await state();
ok('zip 打开成查看器', s2 && s2.kind === 'archive', JSON.stringify(s2));
ok('列出 3 个条目', s2 && s2.entries === 3, String(s2 && s2.entries));
ok('顶层是 docs/ 与 readme.txt',
  JSON.stringify(await rows()) === JSON.stringify(['docs/', 'readme.txt']), JSON.stringify(await rows()));
ok('压缩包用了新标签（没有覆盖上一个）', (await tabCount()) === tabsBefore + 1, String(await tabCount()));

await c.ev(`window.__snp.viewer.enter('docs')`);
await sleep(500);
ok('进 docs 后只剩两个文件',
  JSON.stringify(await rows()) === JSON.stringify(['docs/a.txt', 'docs/b.json']), JSON.stringify(await rows()));

await c.ev(`window.__snp.viewer.openEntry('docs/b.json')`);
await waitFor(async () => !!(await c.ev(`document.querySelector('#viewerPane .ar-text')`)));
ok('条目内容真的解出来了',
  /"k"\s*:\s*1/.test(await c.ev(`(document.querySelector('#viewerPane .ar-text') || {}).textContent`) || ''),
  JSON.stringify((await c.ev(`(document.querySelector('#viewerPane .ar-text') || {}).textContent`) || '').slice(0, 40)));

await c.ev(`document.querySelector('#viewerPane .vw-btn').click()`);
await sleep(400);
ok('返回后又是列表', await c.ev(`!!document.querySelector('#viewerPane .vw-list')`));

/* 筛选框：只筛当前这一层。先点面包屑回到根 —— 上一步返回只退了「条目预览」，
   prefix 还停在 docs/，在子目录里筛 readme.txt 当然什么都没有。 */
await c.ev(`document.querySelector('#viewerPane .vw-crumb').click()`);
await sleep(300);
await c.ev(`(() => {
  const f = document.querySelector('#viewerPane .vw-filter');
  f.value = 'readme';
  f.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
ok('筛选后只剩 readme.txt',
  JSON.stringify(await rows()) === JSON.stringify(['readme.txt']), JSON.stringify(await rows()));

/* tar.gz 走同一条路：条目结构与 zip 一致 */
await open(P('pack.tgz'));
const sTgz = await state();
ok('tar.gz 也能列条目', sTgz && sTgz.kind === 'archive' && sTgz.entries === 2, JSON.stringify(sTgz));
ok('tar.gz 里读得出子目录文件',
  JSON.stringify(await rows()) === JSON.stringify(['docs/', 'readme.txt']), JSON.stringify(await rows()));

/* ---------- 2.5 音频（CSP 的 media-src 少一条，这里才会红） ---------- */
await open(P('tone.wav'));
const sWav = await state();
ok('wav 打开成音频查看器', sWav && sWav.kind === 'audio', JSON.stringify(sWav));
ok('audio 元素真的拿到了时长（说明 asset 协议与 CSP 都放行了）',
  await waitFor(async () => {
    const d = await c.ev(`(() => { const a = document.querySelector('#viewerPane audio'); return a ? a.duration : 0; })()`);
    return d > 0.2;
  }, 5000),
  String(await c.ev(`(() => { const a = document.querySelector('#viewerPane audio'); return a ? a.duration : -1; })()`)));

/* ---------- 3. 本程序打不开的格式：先问，不偷偷拉系统程序 ----------
   用户口径：不要直接调用系统里别的程序，先提示、确认后再打开。
   这三条都只验「取消」这半边 —— 点确定会真的弹 Edge / Word，既没法断言，
   也会在跑测试的机器上留下窗口。确认后的那一步只到 openExternal 为止。 */
const tabsBeforeAsk = await tabCount();
const activeBeforeAsk = await c.ev(`(window.__snp.getActiveTab() || {}).path`);

await openThenAsk(P('fake.7z'));
const d7 = await waitDialog();
ok('7z 先问一句用不用系统程序，而不是开个空标签',
  !!d7 && /用系统程序打开/.test(d7.title), JSON.stringify(d7));
ok('说清是哪种东西打不开（压缩包）而不是甩一句「打不开」',
  !!d7 && /压缩包/.test(d7.body) && /fake\.7z/.test(d7.body), d7 && d7.body);
ok('没有建标签', (await tabCount()) === tabsBeforeAsk, String(await tabCount()));
ok('点得到「取消」', (await clickDialog('取消')) === true);
await sleep(260);
ok('取消后弹层关掉', (await dialog()) === null);
ok('取消后仍然没有标签（没有偷偷打开系统程序）', (await tabCount()) === tabsBeforeAsk, String(await tabCount()));

await openThenAsk(P('手册.pdf'));
const dPdf = await waitDialog();
ok('PDF 也是先问', !!dPdf && /用系统程序打开/.test(dPdf.title) && /PDF 阅读器/.test(dPdf.body), dPdf && dPdf.body);
await clickDialog('取消');
await sleep(260);
ok('PDF 取消后没有标签', (await tabCount()) === tabsBeforeAsk, String(await tabCount()));

await openThenAsk(P('表格.docx'));
const dDoc = await waitDialog();
ok('Office 文档先问，而不是当压缩包列出来',
  !!dDoc && /Office/.test(dDoc.body) && /表格\.docx/.test(dDoc.body), dDoc && dDoc.body);
await clickDialog('取消');
await sleep(260);
ok('Office 取消后没有标签', (await tabCount()) === tabsBeforeAsk, String(await tabCount()));
/* 三次取消都该是「什么都没发生」：当前标签还是原来那个，标签上也没多出小圆点 */
ok('取消后还停在原来那个标签上',
  (await c.ev(`(window.__snp.getActiveTab() || {}).path`)) === activeBeforeAsk, String(activeBeforeAsk));

/* ---------- 4. 未知二进制 ---------- */
await open(P('blob.bin'));
const s4 = await state();
ok('未知二进制开成十六进制', s4 && s4.kind === 'binary', JSON.stringify(s4));
ok('十六进制有内容且从 00000000 起',
  s4 && s4.hexLines >= 1
  && /^00000000/.test(await c.ev(`(document.querySelector('#viewerPane .ar-hex') || {}).textContent`) || ''),
  String(s4 && s4.hexLines));

/* ---------- 5. 陌生扩展名但内容是文本 ---------- */
await open(P('note.xyz'));
ok('ASCII 的陌生扩展名仍然是文本标签', (await visible()) === false);
ok('内容真的读进来了',
  (await c.ev(`window.__snp.getEditorText()`)) === 'plain ascii text, no NUL bytes\n',
  JSON.stringify(await c.ev(`window.__snp.getEditorText()`)));

/* ---------- 6. 回到文本 / 复用标签 ---------- */
const tabsBeforeReopen = await tabCount();
await open(P('dot.png'));
ok('再点 png 复用同一个标签', (await visible()) === true && (await tabCount()) === tabsBeforeReopen, String(await tabCount()));
const sAgain = await state();
ok('复用时状态还是图片（不是空壳）', sAgain && sAgain.kind === 'image' && sAgain.natural && sAgain.natural.w === 200, JSON.stringify(sAgain));

/* Ctrl+F 在查看器里不该弹查找条 */
await c.send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
});
await c.send('Input.dispatchKeyEvent', {
  type: 'keyUp', modifiers: 2, key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
});
await sleep(400);
ok('查看器里 Ctrl+F 不弹查找条', (await findbarHidden()) === true);

/* 关掉查看器标签，正文区要还回来。连着关到没有查看器为止 ——
   只关一次的话，下面接着激活的可能还是另一个查看器标签。 */
for (let i = 0; i < 12 && (await visible()); i++) {
  await c.ev(`window.__snp.commands.closeTab()`);
  await sleep(350);
}
ok('关掉所有查看器后编辑器回来了', (await editWrapHidden()) === false && (await paneHidden()) === true);
ok('关掉后没有残留的 img 节点', await c.ev(`!document.querySelector('#viewerPane img')`));

/* ---------- 7. 收尾：把自己开的标签关掉 ----------
   不关的话它们会进会话，下次启动一并恢复 —— 跑几十次之后标签栏能积上百个，
   下一轮的「标签数」断言也就没法看了。脏标签会弹确认框，点「不保存」。 */
for (let i = 0; i < 40; i++) {
  if ((await tabCount()) === 0) break;
  await c.ev(`window.__snp.commands.closeTab()`);
  await sleep(220);
  const hasDlg = await c.ev(`!!document.querySelector('#dlgOverlay:not(.hidden)')`);
  if (hasDlg) {
    await c.ev(`(() => {
      const btns = [...document.querySelectorAll('#dlgOverlay button')];
      const no = btns.find((b) => /不保存|放弃|Discard/.test(b.textContent));
      (no || btns[btns.length - 1]).click();
      return true;
    })()`);
    await sleep(220);
  }
}

console.log(`\n${pass}/${pass + fail} 通过`);
c.close();
process.exit(fail ? 1 : 0);
