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

  /* ---------- 8. 打字之后的 Ctrl+Z / Ctrl+Y ----------
     用户问「对比窗口是不是没有撤销」。排序那条路径已经验过，但**打字**这条路
     一次都没测过 —— 而它才是用户真正会去按 Ctrl+Z 的场景（打错一个字）。
     这里按真实轨迹走：点进某行、真的插入字符、等输入防抖（300ms）落库，再按快捷键。 */
  const enterEdit = async () => {
    if (!(await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`))) {
      await cmp.ev(`document.getElementById('toggleEdit').click()`);
      await sleep(400);
    }
  };
  const clickRow = async (side, i) => {
    const at = await rowAt(side, i);
    const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
    await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    await sleep(120);
    return at;
  };
  const typeIn = async (side, i, text) => {
    await clickRow(side, i);
    await cmp.send('Input.insertText', { text });
    await sleep(900);                       // 输入防抖 300ms + 重算重画
  };
  const has = (arr, t) => arr.some((s) => s.includes(t));

  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  const plain0 = await rowText('l');
  await typeIn('l', 0, 'XYZ');
  const typed = await rowText('l');
  ok('打字后模型里出现了新字符', has(typed, 'XYZ'), JSON.stringify(typed[0]));

  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  const afterUndo = await rowText('l');
  ok('Ctrl+Z 撤销刚打的字', !has(afterUndo, 'XYZ') && JSON.stringify(afterUndo) === JSON.stringify(plain0),
    `${JSON.stringify(afterUndo[0])} / 期望 ${JSON.stringify(plain0[0])}`);

  await pressKey(89, 'y', 'KeyY', 2);
  await sleep(700);
  const afterRedo = await rowText('l');
  ok('Ctrl+Y 把撤销掉的字重做回来', has(afterRedo, 'XYZ'), JSON.stringify(afterRedo[0]));

  /* 连续两次撤销要退回两步，而不是卡在同一个位置 */
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(600);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(600);
  const twice = await rowText('l');
  ok('连按两次 Ctrl+Z 不会崩、内容仍是可读的一侧',
    Array.isArray(twice) && twice.length > 0 && !has(twice, 'XYZ'), JSON.stringify(twice.slice(0, 2)));

  /* 换行是结构性编辑，跟打字不是一条路径，也要能撤 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  const lines0 = await maxLine('l');
  await clickRow('l', 2);
  await pressKey(35, 'End', 'End');          // 行尾，Enter 在这里断行
  await pressKey(13, 'Enter', 'Enter');
  await sleep(700);
  const linesSplit = await maxLine('l');
  ok('Enter 把一行断成两行', linesSplit === lines0 + 1, `${lines0} -> ${linesSplit}`);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  const linesBack = await maxLine('l');
  ok('Ctrl+Z 撤销回车断行', linesBack === lines0, `${linesSplit} -> ${linesBack}`);

  /* 焦点不在可编辑行时也必须能撤 —— 点过工具栏按钮（排序、编辑开关）之后
     焦点就在按钮上，这是「按了没反应」最常见的来源 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  await typeIn('l', 0, 'ABC');
  await cmp.ev(`document.getElementById('sortBtn').focus()`);
  await sleep(150);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  const fromBtn = await rowText('l');
  ok('焦点在工具栏上时 Ctrl+Z 也生效', !has(fromBtn, 'ABC'), JSON.stringify(fromBtn[0]));

  /* 只读态按 Ctrl+Z：没有可撤的东西，但绝不能抛错或改内容 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  if (await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`)) {
    await cmp.ev(`document.getElementById('toggleEdit').click()`);
    await sleep(400);
  }
  const ro0 = await rowText('l');
  await cmp.ev(`document.querySelector('#rowsL .cmp-tx').focus()`);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(500);
  const ro1 = await rowText('l');
  ok('只读态 Ctrl+Z 不改内容也不报错',
    JSON.stringify(ro0) === JSON.stringify(ro1) && (await cmp.ev(`!!document.getElementById('rowsL')`)) === true);

  /* ---------- 9. 撤销之后光标留在原处 ----------
     撤销如果一律 focusAt(side, 1, 0)，2000 行的文档里按一次 Ctrl+Z 就跳回顶部，
     用户得自己把位置找回来 —— 这跟「撤销」两个字给人的承诺正相反。 */
  const caretNow = () => cmp.ev(`(() => {
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return { inCell: false };
    const n = sel.anchorNode;
    if (!n) return { inCell: false };
    const e = n.nodeType === 1 ? n : n.parentElement;
    const host = e && e.closest ? e.closest('.cmp-tx') : null;
    if (!host) return { inCell: false, active: (document.activeElement && document.activeElement.className) || '' };
    const row = host.closest('.cmp-row');
    return { inCell: true, line: +row.querySelector('.cmp-ln').textContent, side: host.dataset.side };
  })()`);
  /* 滚到中段，取一条完整可见的行来点：虚拟滚动下，屏幕外的行根本没有 DOM */
  const midRow = () => cmp.ev(`(() => {
    const sc = document.getElementById('scrollL').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#rowsL .cmp-row')];
    const hit = rows.find((r) => {
      const b = r.getBoundingClientRect();
      return b.top > sc.top + 60 && b.bottom < sc.bottom - 60;
    });
    if (!hit) return null;
    const tx = hit.querySelector('.cmp-tx');
    const b = tx.getBoundingClientRect();
    return {
      line: +hit.querySelector('.cmp-ln').textContent,
      i: +tx.dataset.i,
      x: Math.round(b.left + b.width * 0.5),
      y: Math.round(b.top + b.height / 2),
    };
  })()`);

  await openPair(p('big-a.txt'), p('big-b.txt'));
  await enterEdit();
  await cmp.ev(`(() => {
    const sc = document.getElementById('scrollL');
    const row = parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-row')) || 20;
    sc.scrollTop = 1200 * row;
    return sc.scrollTop;
  })()`);
  await sleep(400);
  const mid = await midRow();
  ok('滚到中段后能取到一条可见行', !!mid && mid.line > 1000, JSON.stringify(mid));

  const topBefore = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  const clickBase = { x: mid.x, y: mid.y, button: 'left', clickCount: 1 };
  await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...clickBase });
  await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...clickBase });
  await sleep(150);
  await cmp.send('Input.insertText', { text: 'QQ' });
  await sleep(900);
  const caretTyped = await caretNow();
  ok('打字后光标在刚点的那一行', caretTyped.inCell && Math.abs(caretTyped.line - mid.line) <= 1,
    `点的是第 ${mid.line} 行，光标在第 ${caretTyped.line} 行`);

  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(800);
  const afterUndoBig = await rowText('l');
  const caretUndone = await caretNow();
  const topAfter = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  ok('长文档撤销后没有跳回顶部', Math.abs(topAfter - topBefore) < 200,
    `scrollTop ${topBefore} -> ${topAfter}`);
  ok('撤销后光标还在原处（不是第 1 行）',
    caretUndone.inCell && Math.abs(caretUndone.line - mid.line) <= 1,
    JSON.stringify(caretUndone));
  ok('撤销后焦点仍在编辑区（键盘还能接着用）', caretUndone.inCell === true && !has(afterUndoBig, 'QQ'),
    JSON.stringify(caretUndone));

  await pressKey(89, 'y', 'KeyY', 2);
  await sleep(800);
  const caretRedone = await caretNow();
  ok('重做也不跳位置', caretRedone.inCell && Math.abs(caretRedone.line - mid.line) <= 1, JSON.stringify(caretRedone));

  /* 文档变短的撤销（回车断行 → 撤销）也要把光标夹到合法位置，不许掉到 body 上 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  await clickRow('l', 3);
  await pressKey(35, 'End', 'End');
  await pressKey(13, 'Enter', 'Enter');
  await sleep(700);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(800);
  const caretShort = await caretNow();
  ok('撤销断行后光标落在合法行上（没掉到 body）',
    caretShort.inCell === true && caretShort.line >= 2, JSON.stringify(caretShort));

  /* ---------- 10. 撤回原样之后，脏标记要跟着消失 ----------
     一直拿布尔量记「改过」，撤销回原样也会显示「未保存 · 保存按钮可点」，
     再按 Ctrl+S 就把一模一样的字节又写一遍 —— 用户会以为文件真变了。 */
  const dirtyState = () => cmp.ev(`({
    dot: document.getElementById('dotL').classList.contains('on'),
    save: document.getElementById('save').disabled === false,
    meta: document.getElementById('metaL').textContent,
  })`);
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  const clean0 = await dirtyState();
  ok('刚打开的对比是干净的', !clean0.dot && !clean0.save && !/未保存/.test(clean0.meta), JSON.stringify(clean0));

  await typeIn('l', 0, 'ZZ');
  const dirty1 = await dirtyState();
  ok('改过之后标脏、保存可点', dirty1.dot && dirty1.save && /未保存/.test(dirty1.meta), JSON.stringify(dirty1));

  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(800);
  const clean1 = await dirtyState();
  ok('撤销回原样后标脏消失、保存变灰', !clean1.dot && !clean1.save && !/未保存/.test(clean1.meta),
    JSON.stringify(clean1));

  await pressKey(89, 'y', 'KeyY', 2);
  await sleep(800);
  const dirty2 = await dirtyState();
  ok('重做之后又重新标脏', dirty2.dot && dirty2.save, JSON.stringify(dirty2));
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
