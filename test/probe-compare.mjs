// ============================================================
// test/probe-compare.mjs —— 对比窗口的真机验证（CDP）
//
// 端口没开就自动拉起应用，跑完随进程退出收掉；已有实例直接复用。
//   node test/probe-compare.mjs
//
// 覆盖四件在单测里做不到的事：
//   1. 预览条的几何：宽度、与正文区顶部对齐、短文档时不拉满整列
//   2. 交换按钮的位置不随文件名长度变化
//   3. 差异清单：计数、位置/类型排序、类型筛选、点击跳转
//   4. 上限：行数超限时不加载、给出原因、失败侧不会留着上一轮的旧文件
//
// 夹具写到 node_modules/.tmp（可写，且不进仓库），每轮覆盖，不删除。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ensureApp } from './lib/appctl.mjs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ensureApp(PORT);
const TMP = path.resolve('node_modules/.tmp/probe-cmp');

const out = [];
const ok = (name, v, extra) => out.push({ name, ok: !!v, extra });

/* ---------- 夹具 ---------- */
fs.mkdirSync(TMP, { recursive: true });
const p = (n) => path.join(TMP, n).replace(/\\/g, '/');
fs.writeFileSync(p('short-a.txt'), '一行\n二行\n三行\n四行\n五行\n六行\n', 'utf8');
fs.writeFileSync(p('short-b.txt'), '一行\n二行改了\n三行\n四行\n五行\n六行\n', 'utf8');

/* 2000 行，20 处修改、5 处删除、7 处新增、1 处整节新增 */
const A = [], B = [];
for (let i = 1; i <= 2000; i++) {
  const line = `第 ${i} 行：这是用于真机探针的正文内容 content-${(i * 37) % 9001}`;
  A.push(line);
  B.push(i % 100 === 50 ? line + '（改过）' : line);
}
B.splice(700, 5);
B.splice(1200, 0, '新增一', '新增二', '新增三', '新增四', '新增五', '新增六', '新增七');
fs.writeFileSync(p('big-a.txt'), A.join('\n') + '\n', 'utf8');
fs.writeFileSync(p('big-b.txt'), B.join('\n') + '\n', 'utf8');

/* 60001 行：超过 50000 的上限（内容行 60000 + 结尾换行后的空行） */
fs.writeFileSync(p('over.txt'), Array.from({ length: 60000 }, (_, i) => `第 ${i} 行`).join('\n') + '\n', 'utf8');

/* 编辑 / 排序用的小夹具：6 行 + 结尾空行，order 打乱，含中文与数字 */
const EDIT_A = ['zeta 末行', 'alpha 首行', 'mmm 中间', 'beta 次行', '2020 年份', '第 3 章'];
fs.writeFileSync(p('edit-a.txt'), EDIT_A.join('\n') + '\n', 'utf8');
fs.writeFileSync(p('edit-a2.txt'), EDIT_A.join('\n') + '\n', 'utf8');            // 内容相同：一行对一行，便于定位
fs.writeFileSync(p('edit-b.txt'), EDIT_A.slice().reverse().join('\n') + '\n', 'utf8');

/* ---------- CDP ---------- */
async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}

async function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const q = pending.get(m.id);
    if (q) { pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  /* send 是给 Input.dispatchMouseEvent / dispatchKeyEvent 用的：
     三击和按键必须是**真实输入事件**，用 dispatchEvent 合成的假事件
     不会触发浏览器的默认行为（选段、删除），测不到真正的问题。 */
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    ev: (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
      return r.result.value;
    }),
    close: () => ws.close(),
  };
}

async function compareTarget() {
  const t = (await targets()).find((x) => /compare\.html/.test(x.url));
  if (!t) throw new Error('对比窗口没有打开');
  return t;
}

const main = await connect((await targets()).find((t) => t.type === 'page' && !/compare\.html/.test(t.url)).webSocketDebuggerUrl);

try {
  /* ---------- 1. 大文件对比：预览条几何 ---------- */
  await main.ev(`window.__snp.openCompare(${JSON.stringify(p('big-a.txt'))}, ${JSON.stringify(p('big-b.txt'))})`);
  await sleep(2200);
  let cmp = await connect((await compareTarget()).webSocketDebuggerUrl);

  const geo = await cmp.ev(`(() => {
    const r = document.getElementById('ruler').getBoundingClientRect();
    const sc = document.getElementById('scrollL').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), scTop: Math.round(sc.top), scH: Math.round(sc.height) };
  })()`);
  ok('预览条宽 22px', geo.w === 22, JSON.stringify(geo));
  ok('预览条与正文区顶部对齐', Math.abs(geo.top - geo.scTop) <= 1, `rulerTop=${geo.top} scTop=${geo.scTop}`);
  ok('预览条不超出正文可视高度', geo.h <= geo.scH + 1, `${geo.h} <= ${geo.scH}`);

  const stat = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('大文件统计出来了', /差异/.test(stat), stat);

  /* 悬停浮标给出真实行号 */
  const tip = await cmp.ev(`(() => {
    const r = document.getElementById('ruler').getBoundingClientRect();
    document.getElementById('ruler').dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10, clientY: r.top + 8, bubbles: true }));
    const t = document.getElementById('rulerTip');
    return { hidden: t.hidden, text: t.textContent };
  })()`);
  ok('悬停浮标显示行号', !tip.hidden && /[0-9]/.test(tip.text), JSON.stringify(tip));

  /* ---------- 2. 交换按钮位置固定 ---------- */
  const x1 = await cmp.ev(`Math.round(document.getElementById('swap').getBoundingClientRect().left)`);
  await cmp.ev(`document.getElementById('swap').click()`);
  await sleep(500);
  const x2 = await cmp.ev(`Math.round(document.getElementById('swap').getBoundingClientRect().left)`);
  ok('交换后按钮位置不动', Math.abs(x1 - x2) <= 1, `${x1} -> ${x2}`);
  await cmp.ev(`document.getElementById('swap').click()`);
  await sleep(400);

  /* ---------- 3. 差异清单 ---------- */
  await cmp.ev(`document.getElementById('listBtn').click()`);
  await sleep(350);
  /* 窗口是复用的，清单的排序/筛选会留在上一次的状态里。先归零再断言，
     否则「点了位置列」可能只是把 kind 排切换成 pos，看不出升降序 */
  await cmp.ev(`(() => {
    document.querySelector('#listFilter button[data-f="all"]').click();
    const b = document.querySelector('.cmp-list-sort[data-sort="pos"]');
    for (let i = 0; i < 3 && (!b.classList.contains('on') || b.textContent.includes('↓')); i++) b.click();
    return b.textContent;
  })()`);
  await sleep(300);
  const li = await cmp.ev(`(() => {
    const items = [...document.querySelectorAll('#listBody .cmp-li')];
    const kinds = items.map(i => i.querySelector('.cmp-li-kind').textContent);
    return { n: items.length, count: document.getElementById('listN').textContent, kinds,
             unique: [...new Set(kinds)] };
  })()`);
  ok('清单条数与统计一致', li.n > 0 && li.count.includes(String(li.n)), JSON.stringify({ n: li.n, count: li.count }));
  ok('清单里三种类型都认得', li.unique.length >= 2, li.unique.join('/'));

  const asc = await cmp.ev(`[...document.querySelectorAll('#listBody .cmp-li')].map(i => +i.dataset.i)`);
  await cmp.ev(`document.querySelector('.cmp-list-sort[data-sort="pos"]').click()`);
  await sleep(250);
  const desc = await cmp.ev(`[...document.querySelectorAll('#listBody .cmp-li')].map(i => +i.dataset.i)`);
  ok('位置列可切升降序', asc[0] !== desc[0] && asc.length === desc.length, `${asc[0]} -> ${desc[0]}`);

  await cmp.ev(`document.querySelector('.cmp-list-sort[data-sort="kind"]').click()`);
  await sleep(250);
  const kindSeq = await cmp.ev(`[...document.querySelectorAll('#listBody .cmp-li-kind')].map(i => i.textContent)`);
  const groups = kindSeq.filter((v, i) => i === 0 || v !== kindSeq[i - 1]);
  ok('类型列把同类聚在一起', new Set(groups).size === groups.length, groups.join(','));

  await cmp.ev(`document.querySelector('#listFilter button[data-f="add"]').click()`);
  await sleep(250);
  const onlyAdd = await cmp.ev(`(() => {
    const ks = [...document.querySelectorAll('#listBody .cmp-li-kind')].map(i => i.textContent);
    return { n: ks.length, same: ks.every(k => k === ks[0]) };
  })()`);
  ok('按类型筛选有效', onlyAdd.n > 0 && onlyAdd.same, JSON.stringify(onlyAdd));

  await cmp.ev(`document.querySelector('#listBody .cmp-li').click()`);
  await sleep(400);
  const jumped = await cmp.ev(`({ top: document.getElementById('scrollL').scrollTop, cur: document.getElementById('curInfo').textContent })`);
  ok('点清单能跳到那一处', jumped.top > 0 && /[0-9]/.test(jumped.cur), JSON.stringify(jumped));

  await cmp.ev(`document.getElementById('listBtn').click()`);
  ok('再点一次收起清单', await cmp.ev(`document.getElementById('listPanel').hidden`) === true);
  cmp.close();

  /* ---------- 4. 短文档：预览条只占内容高度 ---------- */
  await main.ev(`window.__snp.openCompare(${JSON.stringify(p('short-a.txt'))}, ${JSON.stringify(p('short-b.txt'))})`);
  await sleep(1600);
  cmp = await connect((await compareTarget()).webSocketDebuggerUrl);
  const short = await cmp.ev(`(() => {
    const r = document.getElementById('ruler').getBoundingClientRect();
    const sc = document.getElementById('scrollL').getBoundingClientRect();
    const row = parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-row'));
    const lines = document.querySelectorAll('#rowsL .cmp-row').length;
    return { h: Math.round(r.height), scH: Math.round(sc.height), row, lines };
  })()`);
  ok('短文档：预览条按内容高度画', Math.abs(short.h - short.row * short.lines) <= 2, JSON.stringify(short));
  ok('短文档：预览条远短于可视区', short.h < short.scH / 2, `${short.h} vs ${short.scH}`);
  cmp.close();

  /* ---------- 5. 行数超限 ---------- */
  await main.ev(`window.__snp.openCompare(${JSON.stringify(p('over.txt'))}, ${JSON.stringify(p('short-b.txt'))})`);
  await sleep(1600);
  cmp = await connect((await compareTarget()).webSocketDebuggerUrl);
  const over = await cmp.ev(`({
    warnHidden: document.getElementById('warn').hidden,
    warn: document.getElementById('warnText').textContent,
    stat: document.getElementById('stat').textContent,
    nameL: document.getElementById('nameL').textContent,
  })`);
  ok('超限时显示警示条', !over.warnHidden, JSON.stringify(over.warn));
  ok('警示条写明行列数与上限', /60001/.test(over.warn) && /50000/.test(over.warn), over.warn);
  ok('超限的一侧没有被加载', over.nameL !== 'over.txt', `nameL=${over.nameL}`);
  ok('失败侧不会留着上一轮的旧文件', /只打开了一侧/.test(over.stat), over.stat);
  cmp.close();

  /* ---------- 6. 编辑：三击选中一行，按 Backspace / Delete ----------
     用户报的现象：三击选中一行再按 Backspace，只删掉了上一行的换行，
     选中内容一点没动。根因是按键分支只看锚点（三击的锚点就在行首），
     把它当成「光标在行首」→ mergeUp()。这里按真实轨迹验证。 */
  const pressKey = async (vk, key, code, modifiers = 0) => {
    const base = { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key, code, modifiers };
    await cmp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cmp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const triple = async (x, y) => {
    for (const n of [1, 2, 3]) {
      await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
      await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
      await sleep(50);
    }
    await sleep(220);
  };
  const rowText = (side) => cmp.ev(`[...document.querySelectorAll('#rows${side.toUpperCase()} .cmp-tx')].map(e => e.textContent)`);
  const rowAt = (side, i) => cmp.ev(`(() => {
    const e = document.querySelector('#rows${side.toUpperCase()} .cmp-tx[data-i="${i}"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.45), y: Math.round(r.top + r.height / 2) };
  })()`);
  const openPair = async (a, b) => {
    await main.ev(`window.__snp.openCompare(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    await sleep(1600);
    if (cmp) cmp.close();
    cmp = await connect((await compareTarget()).webSocketDebuggerUrl);
  };

  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  if (!(await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`))) {
    await cmp.ev(`document.getElementById('toggleEdit').click()`);
    await sleep(500);
  }
  ok('编辑态下每行是可编辑单元',
    (await cmp.ev(`document.querySelector('#rowsL .cmp-tx').getAttribute('contenteditable')`)) === 'plaintext-only');

  const beforeBs = await rowText('l');
  const hit = await rowAt('l', 1);          // 第 2 行
  await triple(hit.x, hit.y);
  const sel = await cmp.ev(`(() => { const s = getSelection(); return { collapsed: s.isCollapsed, len: s.toString().length, text: s.toString() }; })()`);
  ok('三击选中了整行', !sel.collapsed && sel.len > 0, JSON.stringify(sel));

  await pressKey(8, 'Backspace', 'Backspace');
  await sleep(700);
  const afterBs = await rowText('l');
  ok('三击后 Backspace 清空的是选中的行', afterBs[1] === '', `第2行=${JSON.stringify(afterBs[1])}`);
  ok('三击后 Backspace 不再吞掉上一行', afterBs[0] === beforeBs[0] && afterBs.length === beforeBs.length,
    `${JSON.stringify(afterBs[0])} / 期望 ${JSON.stringify(beforeBs[0])}`);

  /* Delete 走的是对称分支，同一个毛病，一并盯住 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  const beforeDel = await rowText('l');
  const hit2 = await rowAt('l', 1);
  await triple(hit2.x, hit2.y);
  await pressKey(46, 'Delete', 'Delete');
  await sleep(700);
  const afterDel = await rowText('l');
  ok('三击后 Delete 也清空选中的行', afterDel[1] === '' && afterDel[0] === beforeDel[0],
    `第2行=${JSON.stringify(afterDel[1])} 第1行=${JSON.stringify(afterDel[0])}`);

  /* ---------- 7. 按字典序排序 ---------- */
  await openPair(p('edit-a.txt'), p('edit-b.txt'));
  const rawL = await rowText('l');
  const rawR = await rowText('r');
  /* 每侧自己的行数看行号列的最大值 —— 不能数 .cmp-tx：那是 diff 行数，
     排序后两侧一致了，diff 行数本来就会变（12 → 7），不是 bug。 */
  const maxLine = (side) => cmp.ev(`Math.max(0, ...[...document.querySelectorAll('#rows${side.toUpperCase()} .cmp-ln')].map(e => +e.textContent || 0))`);
  const nL0 = await maxLine('l');
  const nR0 = await maxLine('r');

  const ORDERED = `((sel) => {
    const rows = [...document.querySelectorAll(sel + ' .cmp-tx')].map(e => e.textContent);
    const coll = new Intl.Collator('zh-CN', { numeric: true });
    const body = rows.filter(t => t.trim() !== '');
    let ordered = true;
    for (let i = 1; i < body.length; i++) if (coll.compare(body[i - 1].trim(), body[i].trim()) > 0) ordered = false;
    const ln = [...document.querySelectorAll(sel + ' .cmp-ln')].map(e => +e.textContent || 0);
    return { n: rows.length, body, ordered, max: Math.max(0, ...ln), blankTail: rows.slice(body.length).every(t => t.trim() === '') };
  })`;

  /* 退出编辑态再点排序：这是用户最可能走的路径。排序会改内容，
     只读态点它必须自己进编辑，否则「内容变了但保存按钮是灰的」。 */
  if (await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`)) {
    await cmp.ev(`document.getElementById('toggleEdit').click()`);
    await sleep(400);
  }
  await cmp.ev(`document.getElementById('sortBtn').click()`);
  await sleep(700);
  ok('只读态点排序会自动进编辑', await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`));
  const tools = await cmp.ev(`(() => {
    const t = document.querySelector('.cmp-tools');
    const b = document.getElementById('sortBtn').getBoundingClientRect();
    return { sw: t.scrollWidth, cw: t.clientWidth, w: Math.round(b.width), h: Math.round(b.height) };
  })()`);
  ok('工具栏放得下排序按钮（不溢出、不是零宽）',
    tools.sw <= tools.cw + 1 && tools.w > 20 && tools.h > 10, JSON.stringify(tools));
  const sl = await cmp.ev(`${ORDERED}('#rowsL')`);
  const sr = await cmp.ev(`${ORDERED}('#rowsR')`);
  ok('排序后左侧按字典序', sl.ordered, sl.body.join(' / '));
  ok('排序后右侧按字典序', sr.ordered, sr.body.join(' / '));
  ok('排序不改每侧的行数', sl.max === nL0 && sr.max === nR0, `左 ${nL0}->${sl.max} / 右 ${nR0}->${sr.max}`);
  ok('空行沉到末尾', sl.blankTail && sr.blankTail, JSON.stringify(sl.body));

  /* Ctrl+Z 一次还原两侧（只还原一侧会留下「一边排好一边没排」） */
  await cmp.ev(`document.querySelector('#rowsL .cmp-tx').focus()`);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  const backL = await rowText('l');
  const backR = await rowText('r');
  ok('Ctrl+Z 一次撤销两侧排序',
    JSON.stringify(backL) === JSON.stringify(rawL) && JSON.stringify(backR) === JSON.stringify(rawR),
    `${JSON.stringify(backL)} vs ${JSON.stringify(rawL)}`);
} finally {
  main.close();
  // 夹具留在 node_modules/.tmp/probe-cmp 下不复用删除：每轮 writeFileSync 直接覆盖。
  // 本机删除全部进回收站，删目录 = 往回收站塞文件，所以这里一次删除都不做。
}

/* ---------- 汇总 ---------- */
out.forEach((r) => console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  ' + r.extra : ''}`));
const fail = out.filter((r) => !r.ok).length;
console.log(`\n${out.length - fail}/${out.length} 通过`);
process.exit(fail ? 1 : 0);
