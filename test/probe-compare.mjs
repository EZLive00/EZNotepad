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

const main = await connect((await targets()).find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url)).webSocketDebuggerUrl);

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
  ok('预览条宽 34px（轨道 22px，三段各有位置）', geo.w === 34, JSON.stringify(geo));
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

  /* ---------- 3b. 只看差异：相同行收起来 ----------
     「20 处改动散在 2000 行之间」是这类工具最贵的成本，折叠是唯一能一次
     解决的。验四件事：默认开着、真的缩短、折叠处看得出来、关掉能复原，
     以及「把差异改成相同」那一刻光标所在的行不会被当场收走。 */
  const foldGeo = () => cmp.ev(`(() => {
    const row = parseFloat(getComputedStyle(document.body).getPropertyValue('--cmp-row'));
    const h = parseFloat(document.getElementById('canvasL').style.height) || 0;
    return {
      checked: document.getElementById('optFold').checked,
      viewRows: Math.round(h / row),
      gaps: document.querySelectorAll('#rowsL .cmp-row.gap').length,
      inView: document.querySelectorAll('#rowsL .cmp-row.diff').length,
    };
  })()`);

  ok('打开时「只看差异」默认开着',
    (await cmp.ev(`document.getElementById('optFold').checked`)) === true);
  /* 先量一遍全文行数当基准：折叠之后「缩短了多少」是相对它说的，
     写死 2000 会被「对齐全行数」坑到（两侧行数本来就不相等） */
  await cmp.ev(`document.getElementById('optFold').click()`);
  await sleep(450);
  const fullRows = (await foldGeo()).viewRows;
  await cmp.ev(`document.getElementById('optFold').click()`);
  await sleep(450);

  const fold1 = await foldGeo();
  ok('折叠后整篇只剩一小截', fold1.viewRows > 0 && fold1.viewRows < fullRows / 3,
    `${fold1.viewRows} / 全文 ${fullRows}，${JSON.stringify(fold1)}`);
  ok('折叠处在行号栏画出接缝', fold1.gaps > 0, `gaps=${fold1.gaps}`);

  /* 折叠状态下导航仍要停在真差异上 —— 行位换算是这里最容易错的地方 */
  let f8ok = true;
  const f8note = [];
  for (let k = 0; k < 3; k++) {
    await cmp.ev(`document.getElementById('next').click()`);
    await sleep(400);
    const v = await cmp.ev(`(() => {
      const sc = document.getElementById('scrollL').getBoundingClientRect();
      const hit = [...document.querySelectorAll('#rowsL .cmp-row.diff')].some((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom > sc.top && b.top < sc.bottom;
      });
      return { hit, cur: document.getElementById('curInfo').textContent };
    })()`);
    if (!v.hit) f8ok = false;
    f8note.push(v.cur);
  }
  ok('折叠状态下「下一处」每次都停在真差异上', f8ok, f8note.join(' → '));

  /* 手动滚动之后，「第几处」必须跟着视口 —— 否则按 F8 是从一个用户
     根本没在看的序号继续走，看起来就像导航乱跳 */
  await cmp.ev(`document.getElementById('scrollL').scrollTop = 0`);
  await sleep(480);
  const atTop = await cmp.ev(`document.getElementById('curInfo').textContent`);
  await cmp.ev(`document.getElementById('scrollL').scrollTop = 999999`);
  await sleep(480);
  const atBottom = await cmp.ev(`document.getElementById('curInfo').textContent`);
  /* 滚到底时视口中心不一定正好压在最后一处（最后几处可能在中心线以下），
     所以断言「跟到了后段」而不是「正好是最后一处」 */
  const mB = /第 (\d+) \/ (\d+) 处/.exec(atBottom);
  ok('手动滚动时「第几处」跟着视口走',
    atTop !== atBottom && !!mB && +mB[1] > +mB[2] * 0.7, `${atTop} → ${atBottom}`);

  /* 把这一处改成和对面一样：从「修改」变成「相同」，随即会被折叠掉。
     光标所在的行必须钉住，否则用户打完字光标当场消失。 */
  const pair = await cmp.ev(`(() => {
    const r = [...document.querySelectorAll('#rowsL .cmp-row.diff')].find((x) => x.querySelector('.cmp-tx'));
    if (!r) return null;
    const tx = r.querySelector('.cmp-tx');
    const rx = document.querySelector('#rowsR .cmp-tx[data-i="' + tx.dataset.i + '"]');
    const b = tx.getBoundingClientRect();
    return { i: +tx.dataset.i, right: rx ? rx.textContent : '', x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (pair && pair.right) {
    for (const n of [1, 2, 3]) {
      await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pair.x, y: pair.y, button: 'left', clickCount: n });
      await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pair.x, y: pair.y, button: 'left', clickCount: n });
      await sleep(50);
    }
    await sleep(200);
    await cmp.send('Input.insertText', { text: pair.right });
    await sleep(900);
    const still = await cmp.ev(`!!document.querySelector('#rowsL .cmp-tx[data-i="${pair.i}"]')`);
    ok('把这一行改成和对面一样，光标所在的行不会被折走', still === true, `data-i=${pair.i}`);
  } else {
    ok('把这一行改成和对面一样，光标所在的行不会被折走', false, '没找到可改的差异行');
  }

  await cmp.ev(`document.getElementById('optFold').click()`);
  await sleep(450);
  const fold2 = await foldGeo();
  ok('关掉「只看差异」后回到全文', fold2.viewRows === fullRows, `${fold2.viewRows} vs ${fullRows}`);
  ok('关掉后不再画接缝', fold2.gaps === 0, `gaps=${fold2.gaps}`);
  await cmp.ev(`document.getElementById('optFold').click()`);      // 复原成默认开着
  await sleep(400);

  /* ---------- 3c. 查找 ----------
     两千行里找一个词，以前只能滚。这里验「唤出、计数、跳转、无匹配、关掉」，
     以及折叠态下命中行落在「相同行」里时也跳得到（那一行本来根本不在屏幕上）。 */
  const hotkey = async (vk, k, code, modifiers = 0) => {
    const base = { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, key: k, code, modifiers };
    await cmp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cmp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const typeFind = async (text) => {
    await cmp.ev(`(() => { const i = document.getElementById('findInput'); i.focus(); i.select(); })()`);
    await cmp.send('Input.insertText', { text });
    await sleep(430);
  };

  await hotkey(70, 'f', 'KeyF', 2);
  await sleep(320);
  const findOpen = await cmp.ev(`({ hidden: document.getElementById('findBar').hidden, focus: document.activeElement.id })`);
  ok('Ctrl+F 打开查找条，光标直接进输入框',
    findOpen.hidden === false && findOpen.focus === 'findInput', JSON.stringify(findOpen));

  await typeFind('第 900 行');
  const f1 = await cmp.ev(`(() => {
    const r = document.querySelector('#rowsL .cmp-row.hit-cur');
    const sc = document.getElementById('scrollL').getBoundingClientRect();
    const b = r && r.getBoundingClientRect();
    return {
      n: document.getElementById('findN').textContent,
      hasCur: !!r,
      inView: !!b && b.bottom > sc.top && b.top < sc.bottom,
      line: r ? r.querySelector('.cmp-ln').textContent : '',
    };
  })()`);
  ok('命中有计数', /^1 \/ 1$/.test(f1.n), JSON.stringify(f1));
  ok('折叠时命中行在「相同行」里也跳得到', f1.hasCur && f1.inView, JSON.stringify(f1));
  ok('跳到的是那一行本身', f1.line.trim() === '900', `行号=${JSON.stringify(f1.line)}`);

  await typeFind('zzz-找不到的词');
  const f2 = await cmp.ev(`document.getElementById('findN').textContent`);
  ok('没有匹配时直接说没有匹配', f2 === '没有匹配', f2);

  await typeFind('content-');
  const f3 = await cmp.ev(`document.getElementById('findN').textContent`);
  await hotkey(13, 'Enter', 'Enter');
  await sleep(420);
  const f4 = await cmp.ev(`document.getElementById('findN').textContent`);
  ok('Enter 走到下一个匹配', /^\d+ \/ \d+$/.test(f3) && f4 !== f3, `${f3} → ${f4}`);

  /* 查找框里的按键不能再被正文快捷键接走 */
  const beforeF8 = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  await hotkey(119, 'F8', 'F8');
  await sleep(380);
  const afterF8 = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  ok('在查找框里按 F8 不会让正文乱跳', beforeF8 === afterF8, `${beforeF8} → ${afterF8}`);

  await hotkey(27, 'Escape', 'Escape');
  await sleep(420);
  const f5 = await cmp.ev(`({
    hidden: document.getElementById('findBar').hidden,
    hits: document.querySelectorAll('.cmp-row.hit, .cmp-row.hit-cur').length,
  })`);
  ok('Esc 关掉查找并清掉全部高亮', f5.hidden === true && f5.hits === 0, JSON.stringify(f5));

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
  /* 失败的一侧清成空白可写区：既不留上一轮的旧文件（那会给出一个看似正常的
     结论），也不留一块点不动的死区 —— 原因已经在警示条里说清楚了 */
  const overLeft = await cmp.ev(`[...document.querySelectorAll('#rowsL .cmp-tx')].map((e) => e.textContent).join('').trim()`);
  ok('失败侧清成空白，不留上一轮的旧文件', overLeft === '' && /仅右/.test(over.stat), `${over.stat} left=${JSON.stringify(overLeft)}`);
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
  /* 后面这些编辑/排序用例是按「模型行」写断言的（第 N 行、共几行），
     折叠会把这些数字改掉。默认把它们跑在「全文」上，折叠本身单独验。 */
  const setFold = async (on) => {
    const cur = await cmp.ev(`document.getElementById('optFold').checked`);
    if (cur === on) return;
    await cmp.ev(`document.getElementById('optFold').click()`);
    await sleep(350);
  };
  const openPair = async (a, b, fold = false) => {
    await main.ev(`window.__snp.openCompare(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    await sleep(1600);
    if (cmp) cmp.close();
    cmp = await connect((await compareTarget()).webSocketDebuggerUrl);
    await setFold(fold);
  };

  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  /* 默认就该是可写的：打开两份文件却不让人改，用户的第一反应是「坏了」。
     只读是用户主动切过去的状态，不是打开时的默认值。 */
  ok('打开一对文件就已经是可写状态',
    (await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`)) === true);
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

  /* ---------- 9b. 点工具栏按钮撤销/重做，视口不许动 ----------
     这里测的是**另一条路**：滚动会重建行 DOM，选区跟着作废，于是点按钮那
     一刻 getSelection() 已经指向脱落的节点 —— caretAt() 退回「第 1 行」，
     屏幕一跳到底。键盘那条路（焦点还在行里）不会暴露这个问题。 */
  await cmp.ev(`(() => { const c = document.getElementById('optFold'); if (c.checked) c.click(); return c.checked; })()`);
  await sleep(400);
  await cmp.ev(`document.getElementById('scrollL').scrollTop = 8000`);
  await sleep(400);
  const midBtn = await midRow();
  const hitHere = async (xy) => {
    await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: xy.x, y: xy.y, button: 'left', clickCount: 1 });
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xy.x, y: xy.y, button: 'left', clickCount: 1 });
    await sleep(200);
  };
  const btnXY = (id) => cmp.ev(`(() => {
    const r = document.getElementById('${id}').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await hitHere(midBtn);
  const stat0 = await cmp.ev(`document.getElementById('stat').textContent`);
  await cmp.send('Input.insertText', { text: 'BTN' });
  await sleep(900);
  const statTyped = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('点按钮之前先打一笔（差异数变了）', statTyped !== stat0, `${stat0} -> ${statTyped}`);

  /* 滚到别处再点按钮：用户报的就是这个场景 */
  await cmp.ev(`document.getElementById('scrollL').scrollTop = 16000`);
  await sleep(400);
  const topFar = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  const undoXY = await btnXY('undoBtn');
  await hitHere(undoXY);
  const topAfterBtn = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  const caretBtn = await caretNow();
  const statUndone = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('点工具栏「撤销」视口不动（不再跳回顶部）',
    Math.abs(topAfterBtn - topFar) < 24, `scrollTop ${topFar} -> ${topAfterBtn}`);
  ok('点按钮撤销真的撤掉了（差异数回到打字前）', statUndone === stat0, `${statTyped} -> ${statUndone}`);
  ok('点按钮撤销后焦点仍在正文里（键盘还能接着用）', caretBtn.inCell === true, JSON.stringify(caretBtn));

  const redoXY = await btnXY('redoBtn');
  await hitHere(redoXY);
  const topAfterRedo = await cmp.ev(`document.getElementById('scrollL').scrollTop`);
  ok('点工具栏「重做」视口也不动',
    Math.abs(topAfterRedo - topFar) < 24, `scrollTop ${topFar} -> ${topAfterRedo}`);
  ok('点按钮重做把字放回来了', (await cmp.ev(`document.getElementById('stat').textContent`)) === statTyped);

  /* 还原成没打过字的样子，后面的段落沿用前面的假设（折叠也开回去） */
  await hitHere(undoXY);
  await cmp.ev(`(() => { const c = document.getElementById('optFold'); if (!c.checked) c.click(); return c.checked; })()`);
  await sleep(300);

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

  /* ---------- 11. 工具栏上的撤销 / 重做按钮 ----------
     键盘能用不等于看得见：用户不会去猜 Ctrl+Z，尤其在他刚从主窗口过来的时候。
     按钮还必须**诚实地灰着** —— 历史栈空了却亮着，是比没有按钮更差的体验。 */
  const btnState = () => cmp.ev(`({
    u: document.getElementById('undoBtn').disabled,
    r: document.getElementById('redoBtn').disabled,
    w: Math.round(document.getElementById('undoBtn').getBoundingClientRect().width),
  })`);

  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  const st0 = await btnState();
  ok('刚打开时撤销/重做都是灰的', st0.u && st0.r && st0.w > 20, JSON.stringify(st0));

  await typeIn('l', 0, 'XY');
  await sleep(400);
  const st1 = await btnState();
  ok('打字之后撤销按钮变亮', !st1.u && st1.r, JSON.stringify(st1));

  await cmp.ev(`document.getElementById('undoBtn').click()`);
  await sleep(700);
  const afterBtn = await rowText('l');
  const st2 = await btnState();
  ok('点撤销按钮把字撤掉', !has(afterBtn, 'XY'), JSON.stringify(afterBtn[0]));
  ok('撤到底后撤销变灰、重做变亮', st2.u && !st2.r, JSON.stringify(st2));

  await cmp.ev(`document.getElementById('redoBtn').click()`);
  await sleep(700);
  const afterRedoBtn = await rowText('l');
  ok('点重做按钮把字放回来', has(afterRedoBtn, 'XY'), JSON.stringify(afterRedoBtn[0]));

  /* 排序是「整侧替换」，快照存在 S.lastSort 里而不是两侧的栈里：
     按钮必须认这步，否则排完序按钮是灰的，用户只能去猜快捷键。 */
  await openPair(p('edit-a.txt'), p('edit-b.txt'));
  await enterEdit();
  const sortL0 = await rowText('l');
  const sortR0 = await rowText('r');
  await cmp.ev(`document.getElementById('sortBtn').click()`);
  await sleep(700);
  const stSorted = await btnState();
  ok('排序之后撤销按钮可点', !stSorted.u, JSON.stringify(stSorted));
  await cmp.ev(`document.getElementById('undoBtn').click()`);
  await sleep(800);
  const sortL1 = await rowText('l');
  const sortR1 = await rowText('r');
  ok('点撤销按钮一次还原两侧排序',
    JSON.stringify(sortL1) === JSON.stringify(sortL0) && JSON.stringify(sortR1) === JSON.stringify(sortR0),
    `${JSON.stringify(sortL1)} vs ${JSON.stringify(sortL0)}`);

  /* 只读态：键盘不吃 Ctrl+Z，按钮也必须灰着 —— 亮着却点不动比灰着更困惑 */
  if (await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`)) {
    await cmp.ev(`document.getElementById('toggleEdit').click()`);
    await sleep(400);
  }
  const stRO = await btnState();
  ok('只读态撤销/重做按钮都是灰的', stRO.u && stRO.r, JSON.stringify(stRO));

  /* ---------- 12. 工具栏不许静默裁掉右边的按钮 ----------
     工具栏是 overflow:hidden 的单行 flex：窗口一窄，最右边的「导出报告」直接消失，
     没有任何提示（加按钮前 880px 就已经裁了）。降级由 fitTools() 按真实溢出量决定。 */
  const barFit = () => cmp.ev(`(() => {
    const t = document.getElementById('tools');
    const box = t.getBoundingClientRect();
    const btns = [...t.querySelectorAll('.cmp-btn')].map((el) => {
      const b = el.getBoundingClientRect();
      return { id: el.id, w: Math.round(b.width), clipped: b.right > box.right + 0.5 };
    });
    return {
      over: t.scrollWidth - t.clientWidth,
      tight: t.classList.contains('tight'),
      tighter: t.classList.contains('tighter'),
      clipped: btns.filter((b) => b.clipped).map((b) => b.id),
      zero: btns.filter((b) => b.w < 20).map((b) => b.id),
    };
  })()`);

  const wide = await barFit();
  ok('宽窗口下工具栏不溢出、按钮都完整',
    wide.over <= 1 && !wide.clipped.length && !wide.zero.length && !wide.tight, JSON.stringify(wide));

  /* 620 比 min_inner_size(760) 还窄，用来验证第二级降级（连勾选项文字也收起来）真的存在 */
  for (const w of [1100, 900, 780, 620]) {
    await cmp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const f = await barFit();
    ok(`${w}px 宽时没有按钮被裁掉`, f.over <= 1 && !f.clipped.length && !f.zero.length, JSON.stringify(f));
  }

  await cmp.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(500);
  const back = await barFit();
  ok('窗口变宽后按钮文字回来（折叠不粘住）',
    !back.tight && !back.tighter && back.over <= 1 && !back.clipped.length, JSON.stringify(back));

  /* ---------- 13. 粘贴两段文本后，点哪儿都能落光标 ----------
     用户：「鼠标必须点击第一行旁边才能插入，其他地方点击没反应」。
     两处根因：① canvas 只按内容宽度算，行右侧那片「看着还是正文」的空白
     不属于任何行；② blur 时同步重建 DOM，把「正要被点中的那一行」从文档里
     摘掉（只有先打过字、有 pending 时才复现）。 */
  const openBlank = async () => {
    /* 对比窗口是复用的：上一次打开的文件还挂在里面。先关窗再开，拿一个
       真正空白的窗口 —— 默认状态本身就是「两侧空白 + 可写 + 光标在左侧」，
       不用再点任何按钮。 */
    const old = (await targets()).find((t) => /compare\.html/.test(t.url));
    if (old) {
      const prev = await connect(old.webSocketDebuggerUrl);
      await prev.send('Runtime.evaluate', {
        expression: `window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'compare' })`,
      }).catch(() => {});
      prev.close();
      await sleep(800);
    }
    await main.ev(`window.__snp.openCompare(null, null)`);
    await sleep(1600);
    if (cmp) cmp.close();
    cmp = await connect((await compareTarget()).webSocketDebuggerUrl);
    await sleep(350);
  };
  const clickXY = async (x, y) => {
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(200);
  };
  const viewL = () => cmp.ev(`(() => {
    const sc = document.getElementById('scrollL');
    const b = sc.getBoundingClientRect();
    const cv = document.getElementById('canvasL').getBoundingClientRect();
    return {
      left: Math.round(b.left), right: Math.round(b.right), bottom: Math.round(b.bottom),
      viewW: sc.clientWidth, cvW: Math.round(cv.width),
      rows: [...document.querySelectorAll('#rowsL .cmp-row')].map((r) => {
        const rb = r.getBoundingClientRect();
        const tx = r.querySelector('.cmp-tx');
        return { ln: +r.querySelector('.cmp-ln').textContent, top: Math.round(rb.top), txLeft: Math.round(tx.getBoundingClientRect().left) };
      }),
    };
  })()`);

  await openBlank();
  /* 打开就是两个空白编辑区：不再有「选择左侧文件 / 选择右侧文件 / 粘贴两段
     文本」那一步 —— 用户点「对比」就是想贴两段东西比一比，让他先做两次选择
     才给一块能写的区域，等于把入口藏起来了。 */
  const blank0 = await cmp.ev(`({
    editable: document.querySelectorAll('#rowsL .cmp-tx[contenteditable]').length,
    noEmpty: !document.getElementById('empty'),
    focusInCell: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.cmp-tx')),
    stat: document.getElementById('stat').textContent,
  })`);
  ok('打开对比窗口就是两侧空白、直接可写', blank0.editable >= 1 && blank0.noEmpty, JSON.stringify(blank0));
  ok('光标已经在左侧正文里（可以直接粘）', blank0.focusInCell === true, JSON.stringify(blank0));
  ok('两侧都空时不报「完全一致」，而是说下一步做什么',
    /粘|打开文件/.test(blank0.stat) && !/一致/.test(blank0.stat), blank0.stat);

  await cmp.send('Input.insertText', { text: 'aaa\nbbb\nccc\nddd\neee\n' });
  await sleep(800);
  const v13 = await viewL();
  ok('短文本时行也铺满整栏（不是只有内容那么宽）',
    v13.cvW >= v13.viewW - 1, `canvas=${v13.cvW} 可视=${v13.viewW}`);
  const rowOf = (v, n) => v.rows.find((r) => r.ln === n);

  await clickXY(v13.right - 30, rowOf(v13, 3).top + 10);
  const atFar = await caretNow();
  ok('点正文行右侧的空白也能落光标', atFar.inCell && atFar.line === 3, JSON.stringify(atFar));

  await clickXY(rowOf(v13, 4).txLeft - 20, rowOf(v13, 4).top + 10);
  const atNo = await caretNow();
  ok('点行号把光标放到这一行', atNo.inCell && atNo.line === 4, JSON.stringify(atNo));

  await clickXY(v13.left + 200, v13.bottom - 24);
  const atBlank = await caretNow();
  ok('点正文下方的大片空白，光标落到最后一行',
    atBlank.inCell && atBlank.line >= 4, JSON.stringify(atBlank));

  /* 有未落库的输入时再点另一行：以前光标不动，字继续进原来那一行 */
  await clickXY(rowOf(v13, 1).txLeft + 4, rowOf(v13, 1).top + 10);
  await cmp.send('Input.insertText', { text: 'X' });
  await sleep(100);
  await clickXY(rowOf(v13, 3).txLeft + 4, rowOf(v13, 3).top + 10);
  await cmp.send('Input.insertText', { text: 'Y' });
  await sleep(700);
  const moved = await rowText('l');
  ok('打了字再点别的行，新字进点的那一行',
    moved[2].includes('Y') && !moved[0].includes('Y'), JSON.stringify(moved));

  /* 粘贴后立刻点别的行（不等 300ms 防抖）也算一次「有 pending 时换行」 */
  await openBlank();
  await cmp.send('Input.insertText', { text: 'p1\np2\np3\np4\n' });
  await sleep(80);
  const v14 = await viewL();
  const r2 = rowOf(v14, 2);
  ok('粘贴的多行立刻拆成行（不用等防抖）', !!r2 && v14.rows.length >= 4, JSON.stringify(v14.rows.map((r) => r.ln)));
  if (r2) {
    await clickXY(r2.txLeft + 4, r2.top + 10);
    await sleep(350);
    const atPaste = await caretNow();
    ok('粘贴后立刻点别的行也能落进去', atPaste.inCell && atPaste.line === 2, JSON.stringify(atPaste));
  } else {
    ok('粘贴后立刻点别的行也能落进去', false, '第 2 行还没渲染出来');
  }

  /* ---------- 14. 一侧贴完，另一侧的占位行也能改 ----------
     用户：「一边粘贴后，另一边没法选中修改了」。
     diff 把短的一侧补成占位行；占位行以前不给 contenteditable ——
     看着就是空行，点上去什么都不会发生。更糟的是 mousedown 兜底从
     `.cmp-ln` 的文字拿行号，占位行这里是空串 → 0 → focusAt 夹成第 1 行，
     于是「点第 3 行，字进第 1 行」。 */
  await openBlank();
  await cmp.send('Input.insertText', { text: 'L1\nL2\nL3\nL4\nL5\nL6' });
  await sleep(800);

  const phState = () => cmp.ev(`(() => {
    const rowsR = [...document.querySelectorAll('#rowsR .cmp-row')];
    const isFill = (r) => !r.querySelector('.cmp-ln').textContent.trim();
    return {
      rows: rowsR.length,
      fill: rowsR.filter(isFill).length,
      editableFill: rowsR.filter((r) => isFill(r) && r.querySelector('.cmp-tx').isContentEditable).length,
      text: rowsR.map((r) => r.querySelector('.cmp-tx').textContent),
    };
  })()`);

  const ph0 = await phState();
  ok('左侧贴 6 行后右侧补出占位行', ph0.rows >= 6 && ph0.fill >= 4, JSON.stringify(ph0));
  ok('占位行也能直接写', ph0.fill > 0 && ph0.editableFill === ph0.fill,
    `可写 ${ph0.editableFill}/${ph0.fill}`);

  const rowBox = (side, idx, col = 4) => cmp.ev(`(() => {
    const r = document.querySelectorAll('#rows${side} .cmp-row')[${idx}];
    if (!r) return null;
    const b = r.getBoundingClientRect();
    const tx = r.querySelector('.cmp-tx').getBoundingClientRect();
    return { x: Math.round(tx.left + ${col}), y: Math.round(b.top + b.height / 2) };
  })()`);

  const ph3 = await rowBox('R', 2);
  if (ph3) {
    await clickXY(ph3.x, ph3.y);
    const phCaret = await cmp.ev(`(() => {
      const sel = getSelection(); if (!sel.rangeCount) return { ok: false };
      const n = sel.anchorNode; const e = n && (n.nodeType === 1 ? n : n.parentElement);
      const host = e && e.closest && e.closest('.cmp-tx');
      return host ? { ok: true, i: +host.dataset.i, side: host.dataset.side } : { ok: false };
    })()`);
    ok('点占位行落在这一行本身（不是第 1 行）',
      phCaret.ok && phCaret.i === 2 && phCaret.side === 'r', JSON.stringify(phCaret));

    await cmp.send('Input.insertText', { text: 'R3' });
    await sleep(800);
    const ph1 = await phState();
    const leftAfter = await rowText('l');
    ok('往占位行写的字进右侧，左侧不受影响',
      ph1.text.some((t) => t.includes('R3')) && !leftAfter.some((t) => t.includes('R3')),
      JSON.stringify(ph1.text));
  } else {
    ok('点占位行落在这一行本身（不是第 1 行）', false, '第 3 行不在 DOM 里');
    ok('往占位行写的字进右侧，左侧不受影响', false, '第 3 行不在 DOM 里');
  }

  /* 真正的用法是往占位行粘一整段：多行要展开成多行，不是挤成一行 */
  const phLast = await rowBox('R', 5);
  if (phLast) {
    await clickXY(phLast.x, phLast.y);
    await cmp.send('Input.insertText', { text: 'P1\nP2\nP3' });
    await sleep(900);
    const ph2 = await phState();
    const got = ['P1', 'P2', 'P3'].filter((k) => ph2.text.some((t) => t.trim() === k)).length;
    ok('往占位行粘一整段会展开成多行', got === 3, `${got}/3 ${JSON.stringify(ph2.text)}`);
  } else {
    ok('往占位行粘一整段会展开成多行', false, '第 6 行不在 DOM 里');
  }

  /* ---------- 15. 预览条只有红和灰 ----------
     以前「当前这处差异」也画成蓝色，和视口框抢同一条 22px 的槽 —— 用户看到的
     是一条蓝框加一段蓝点，没有办法知道它们不是一回事。现在差异一律红、视口
     一律灰，蓝色不再出现在预览条上。 */
  const pixAt = () => cmp.ev(`(() => {
    const cv = document.getElementById('rulerC');
    const g = cv.getContext('2d');
    const x = Math.floor(cv.width / 2);
    const d = g.getImageData(x, 0, 1, cv.height).data;
    let red = 0, blue = 0, any = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      any++;
      const [r, gg, b] = [d[i], d[i + 1], d[i + 2]];
      if (r - gg > 60 && r - b > 60) red++;
      else if (b - r > 40) blue++;
    }
    return { any, red, blue };
  })()`);

  await openPair(p('big-a.txt'), p('big-b.txt'));
  await sleep(700);
  const rulerPix = await pixAt();
  ok('有差异时预览条上只有红线，没有第二种颜色',
    rulerPix.red > 0 && rulerPix.blue === 0, JSON.stringify(rulerPix));

  await openPair(p('big-a.txt'), p('big-a.txt'));
  await sleep(700);
  const rulerSame = await pixAt();
  ok('两侧内容相同时预览条上没有红线', rulerSame.red === 0 && rulerSame.any > 0, JSON.stringify(rulerSame));

  const rulerTitle = await cmp.ev(`document.getElementById('ruler').title`);
  ok('预览条只解释红与灰两种含义',
    /灰/.test(rulerTitle) && /红/.test(rulerTitle) && !/蓝/.test(rulerTitle), rulerTitle);

  /* 差异在预览条上是「一行一条细线」，不是粗红块：一段 20 行的差异画成一根
     20px 高的柱子，看着像滚动条的影子，也分不清是哪几行。
     用 10 行、改 3 行的小文件量：每一行分到 20px，正好能逐行画。 */
  fs.writeFileSync(p('thin-a.txt'), Array.from({ length: 10 }, (_, i) => `行 ${i + 1}`).join('\n') + '\n', 'utf8');
  fs.writeFileSync(p('thin-b.txt'),
    ['行 1', '行 2改', '行 3', '行 4', '行 5改', '行 6', '行 7', '行 8', '行 9', '行 10改'].join('\n') + '\n', 'utf8');
  await openPair(p('thin-a.txt'), p('thin-b.txt'));
  const thin = await cmp.ev(`(() => {
    const cv = document.getElementById('rulerC');
    const g = cv.getContext('2d');
    const x = Math.floor(cv.width / 2);
    const d = g.getImageData(x, 0, 1, cv.height).data;
    const runs = []; let run = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, gg, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      const colored = a > 200 && Math.max(r, gg, b) - Math.min(r, gg, b) > 30;
      if (colored) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    return { runs, dpr: window.devicePixelRatio || 1 };
  })()`);
  ok('预览条上的差异是一行一条细线（3 处差异 = 3 条）',
    thin.runs.length === 3, JSON.stringify(thin));
  ok('每条都是 1px 级，不是粗色块',
    thin.runs.every((n) => n <= Math.ceil(thin.dpr) + 1), JSON.stringify(thin));

  /* 差异的写法：只把字标红，不铺底色、不画色块。
     改行只红差异片段，新增/删除的整行都红 —— 一屏几十处差异时，
     铺底色会让整页发红，反而看不出是哪几个字变了。 */
  fs.writeFileSync(p('paint-a.txt'), '甲\n乙\n丙\n', 'utf8');
  fs.writeFileSync(p('paint-b.txt'), '甲\n乙改\n丙\n丁\n', 'utf8');
  await openPair(p('paint-a.txt'), p('paint-b.txt'));
  const paint = await cmp.ev(`(() => {
    /* 右侧那行的「改」才是新增的字，左侧整行没有差异片段 —— 取有 mark 的那侧 */
    const rowChg = [...document.querySelectorAll('#rowsR .cmp-row')].find((r) => r.classList.contains('k-chg'));
    const rowAdd = [...document.querySelectorAll('#rowsR .cmp-row')].find((r) => r.classList.contains('k-add'));
    const mark = rowChg && rowChg.querySelector('mark');
    return {
      rowBg: rowChg && getComputedStyle(rowChg).backgroundColor,
      markColor: mark && getComputedStyle(mark).color,
      markBg: mark && getComputedStyle(mark).backgroundColor,
      addColor: rowAdd && getComputedStyle(rowAdd.querySelector('.cmp-tx')).color,
      addBg: rowAdd && getComputedStyle(rowAdd).backgroundColor,
    };
  })()`);
  /* 红不红按「红明显高于绿蓝」判，不写死色值：明暗两套主题的红不一样 */
  const isRed = (c) => {
    const m = String(c).match(/rgba?\((\d+), (\d+), (\d+)/);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return r - g > 100 && r - b > 100;
  };
  ok('差异行不铺底色', /rgba\(0, 0, 0, 0\)|transparent/.test(String(paint.rowBg)), String(paint.rowBg));
  ok('改行只把差异片段标红，片段本身也没有底色',
    isRed(paint.markColor) && /rgba\(0, 0, 0, 0\)|transparent/.test(String(paint.markBg)),
    `${paint.markColor} / ${paint.markBg}`);
  ok('新增的整行都标红', isRed(paint.addColor) && /rgba\(0, 0, 0, 0\)|transparent/.test(String(paint.addBg)),
    `${paint.addColor} / ${paint.addBg}`);

  /* ---------- 16. 只读态：能选中、能复制，只是不能改 ----------
     「没法选中」有两种含义：占位行那种是真不能点，另一种是只读态下拖选不出选区。
     后者是看差异最常用的动作（选一段去搜、去复制），必须一直成立。 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  if (await cmp.ev(`document.getElementById('toggleEdit').classList.contains('on')`)) {
    await cmp.ev(`document.getElementById('toggleEdit').click()`);
    await sleep(400);
  }
  const selAt = await rowBox('L', 0, 10);
  await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selAt.x, y: selAt.y, button: 'left', clickCount: 1 });
  await cmp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: selAt.x + 70, y: selAt.y, button: 'left' });
  await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selAt.x + 70, y: selAt.y, button: 'left', clickCount: 1 });
  await sleep(250);
  const picked = await cmp.ev(`getSelection().toString()`);
  ok('只读态下也能拖选文字', typeof picked === 'string' && picked.length > 0, JSON.stringify(picked));

  /* ---------- 16b. 编辑态的选区：全选是全文，拖出视口也不断 ----------
     每一行都是一个独立的 contenteditable，浏览器默认的全选只认得当时 DOM 里
     摆着的那几行；虚拟滚动又只摆一屏。两个限制叠在一起，用户看到的就是
     「Ctrl+A 只选中一屏」「拖到屏幕边缘选区就停」。 */
  const selLines = Array.from({ length: 200 }, (_, i) => `第 ${i + 1} 行 selection-${i + 1}`);
  fs.writeFileSync(p('sel-a.txt'), selLines.join('\n') + '\n', 'utf8');
  fs.writeFileSync(p('sel-b.txt'), selLines.map((x, i) => (i % 50 === 10 ? x + '（改过）' : x)).join('\n') + '\n', 'utf8');
  await openPair(p('sel-a.txt'), p('sel-b.txt'), true);      // 折叠打开：先制造「看不全」
  await enterEdit();
  const atSel = await rowBox('L', 1);
  await clickXY(atSel.x, atSel.y);
  await pressKey(65, 'a', 'KeyA', 2);
  await sleep(500);
  const allSel = await cmp.ev(`(() => {
    const s = window.getSelection();
    const host = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); const h = e && e.closest && e.closest('.cmp-tx'); return h ? h.dataset.side : '?'; };
    const txt = s.toString();
    return {
      lines: txt.split('\\n').filter((x) => x.length).length,
      a: host(s.anchorNode), f: host(s.focusNode),
      fold: document.getElementById('optFold').checked,
      dom: document.querySelectorAll('#rowsL .cmp-row').length,
      tail: txt.slice(-14),
    };
  })()`);
  ok('编辑态 Ctrl+A 选中整侧全文（200 行，不是一屏）', allSel.lines === 200, JSON.stringify(allSel));
  ok('全选只落在光标那一侧，不会把两栏一起框进去',
    allSel.a === 'l' && allSel.f === 'l', JSON.stringify(allSel));
  ok('全选会先展开「只看差异」：折起来的行也进选区',
    allSel.fold === false && allSel.dom >= 200, JSON.stringify(allSel));

  /* 拖到视口下缘：行不够时先补 DOM，指针跨出行之后选区由自己接管
     （Blink 的选区不许跨出编辑宿主，见 compare.js 的 dragMove） */
  await openPair(p('sel-a.txt'), p('sel-b.txt'), false);    // 重新打开：DOM 回到一屏
  await enterEdit();
  const dragDom0 = await cmp.ev(`document.querySelectorAll('#rowsL .cmp-row').length`);
  const atDrag = await rowBox('L', 1);
  /* 落在正文区里、贴着下缘（再往下就是横向滚动条了）：一步跳到窗外浏览器会当成「没动」 */
  const holdY = await cmp.ev(`Math.round(document.getElementById('scrollL').getBoundingClientRect().bottom) - 20`);
  const rowsNow = () => cmp.ev(`parseInt(document.getElementById('metaL').textContent, 10)`);
  const rows0 = await rowsNow();
  await cmp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: atDrag.x, y: atDrag.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 6; k++) {
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: atDrag.x, y: atDrag.y + (holdY - atDrag.y) * k / 6, button: 'left', buttons: 1 });
    await sleep(60);
  }
  for (let k = 0; k < 10; k++) {
    await cmp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: atDrag.x, y: holdY, button: 'left', buttons: 1 });
    await sleep(110);
  }
  const dragged = await cmp.ev(`({
    lines: getSelection().toString().split('\\n').filter(Boolean).length,
    top: document.getElementById('scrollL').scrollTop,
    dom: document.querySelectorAll('#rowsL .cmp-row').length,
  })`);
  await cmp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: atDrag.x, y: holdY, button: 'left', clickCount: 1 });
  await sleep(250);
  ok('拖到视口下缘会继续滚动，选区跟着往下长',
    dragged.top > 0 && dragged.lines > 40, JSON.stringify({ dragDom0, dragged }));
  ok('视口外的行会被补进 DOM（否则选区到边缘就断）',
    dragged.dom > dragDom0, `${dragDom0} → ${dragged.dom}`);
  ok('松手后拖出来的选区还在（不会一放就散）',
    (await cmp.ev(`getSelection().toString().split('\\n').filter(Boolean).length`)) === dragged.lines,
    String(dragged.lines));

  /* 这一段选区跨了好几个编辑宿主：浏览器连删都删不了，得自己落到模型上 */
  await pressKey(8, 'Backspace', 'Backspace');
  await sleep(700);
  const rowsAfterDel = await rowsNow();
  ok('跨行选区按 Backspace 删掉的是整段，不是一个字',
    rowsAfterDel < rows0 - 20, `${rows0} → ${rowsAfterDel}`);
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  ok('Ctrl+Z 把整段删掉的撤得回来', (await rowsNow()) === rows0, `${rows0} → ${await rowsNow()}`);

  /* 全选之后打字：没有编辑上下文，浏览器不会替我们插入那个字符 */
  await clickXY(atDrag.x, atDrag.y);
  await pressKey(65, 'a', 'KeyA', 2);
  await sleep(400);
  await cmp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Q', code: 'KeyQ', text: 'Q', unmodifiedText: 'Q',
    windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81,
  });
  await cmp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Q', code: 'KeyQ', windowsVirtualKeyCode: 81, nativeVirtualKeyCode: 81 });
  await sleep(800);
  const afterQ = await cmp.ev(`(() => {
    const rows = [...document.querySelectorAll('#rowsL .cmp-row')];
    const withNo = rows.filter((r) => r.querySelector('.cmp-ln').textContent.trim());
    return { leftLines: withNo.length, first: (document.querySelector('#rowsL .cmp-tx') || {}).textContent };
  })()`);
  ok('全选之后打字会把整侧替换成一个字', afterQ.leftLines === 1 && afterQ.first === 'Q', JSON.stringify(afterQ));
  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  ok('撤销把全选被替换掉的正文找回来', (await rowsNow()) === rows0, `${rows0} → ${await rowsNow()}`);

  /* ---------- 16c. 差异只用红字：没有蓝框、没有删除线 ---------- */
  fs.writeFileSync(p('strike-a.txt'), '甲\n乙一\n丙\n', 'utf8');
  fs.writeFileSync(p('strike-b.txt'), '甲\n乙二\n丙\n', 'utf8');
  await openPair(p('strike-a.txt'), p('strike-b.txt'), false);
  const clean = await cmp.ev(`(() => {
    const m = document.querySelector('#rowsL mark.rem');
    return {
      box: !!document.querySelector('.cmp-curbox'),
      deco: m ? getComputedStyle(m).textDecorationLine : 'no-mark',
      markColor: m ? getComputedStyle(m).color : '',
    };
  })()`);
  ok('当前这一处不再套蓝框', clean.box === false, JSON.stringify(clean));
  ok('行内改动的字不再加删除线', clean.deco === 'none', String(clean.deco));

  /* ---------- 17. 把一处差异整段同步到另一边 ----------
     Beyond Compare 的 Copy to Other Side、WinMerge 的 Alt+←/→、Meld 中栏的箭头，
     说的都是同一件事，单位是「一处差异」而不是一行、也不是整个文件，方向跟着
     光标在哪一侧。以前没有这个动作 —— 改完左边，右边只能手抄。 */
  fs.writeFileSync(p('push-a.txt'), '甲\n乙\n丙\n丁\n戊\n', 'utf8');
  fs.writeFileSync(p('push-b.txt'), '甲\n乙改\n丙\n丁改\n戊\n', 'utf8');
  const cur = () => cmp.ev(`document.getElementById('curInfo').textContent`);
  /* 箭头在中间那道缝里，纵向跟着当前这一处差异走 */
  const gut = () => cmp.ev(`(() => {
    const pair = document.getElementById('gutPair');
    const b = pair.getBoundingClientRect();
    return {
      shown: !pair.hidden,
      left: !document.getElementById('pushLeft').disabled,
      right: !document.getElementById('pushRight').disabled,
      top: Math.round(b.top),
      cx: Math.round(b.left + b.width / 2),
    };
  })()`);
  const midX = () => cmp.ev(`(() => {
    const m = document.getElementById('main').getBoundingClientRect();
    const r = document.getElementById('ruler').getBoundingClientRect();
    return Math.round((m.left + (r.left - m.left) / 2));
  })()`);

  await openPair(p('push-a.txt'), p('push-b.txt'));
  await enterEdit();
  await clickRow('l', 1);
  const blk0 = await cur();
  const g0 = await gut();
  ok('中间缝里有推送箭头（编辑态 + 有差异才出现）', g0.shown && g0.left && g0.right, JSON.stringify(g0));
  ok('箭头落在两栏中间的分割缝上', Math.abs(g0.cx - (await midX())) <= 2, `${g0.cx} vs ${await midX()}`);

  const blkTop = g0.top;
  await cmp.ev(`document.getElementById('next').click()`);
  await sleep(500);
  const g1 = await gut();
  ok('箭头跟着当前这一处差异上下走', g1.top > blkTop + 10, `${blkTop} → ${g1.top}`);
  await cmp.ev(`document.getElementById('prev').click()`);
  await sleep(500);

  /* 方向就是箭头指向：右箭头 = 把左边这一处推到右边 */
  await cmp.ev(`document.getElementById('pushRight').click()`);
  await sleep(700);
  const rt1 = await rowText('r');
  ok('点右箭头把这一处整段复制到右侧', rt1[1] === '乙', JSON.stringify(rt1));
  const blk1 = await cur();
  ok('复制完这一处不再是差异（2 处 → 1 处）',
    blk0.includes('/ 2 处') && blk1.includes('/ 1 处'), `${blk0} → ${blk1}`);

  await pressKey(90, 'z', 'KeyZ', 2);
  await sleep(700);
  const rt2 = await rowText('r');
  ok('Ctrl+Z 把整段同步撤得回来', rt2[1] === '乙改', JSON.stringify(rt2));

  await clickRow('r', 1);
  await cmp.ev(`document.getElementById('pushLeft').click()`);
  await sleep(700);
  const lt1 = await rowText('l');
  ok('左箭头反向也能整段推过去（方向固定，不跟光标）', lt1[1] === '乙改', JSON.stringify(lt1));

  /* 键盘与连续合并：Alt+→ 推一次仍停在原处，Ctrl+Alt+→ 推完并接着处理下一处 */
  await openPair(p('push-a.txt'), p('push-b.txt'));
  await enterEdit();
  await pressKey(39, 'ArrowRight', 'ArrowRight', 1);
  await sleep(700);
  const kp1 = await rowText('r');
  ok('Alt+→ 等同于「复制到右侧」', kp1[1] === '乙', JSON.stringify(kp1));
  ok('只推一处时不会跳过下一处', (await cur()).includes('/ 1 处'), await cur());

  await pressKey(39, 'ArrowRight', 'ArrowRight', 3);      // Ctrl+Alt+→
  await sleep(900);
  const kp2 = await rowText('r');
  const statSel = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('Ctrl+Alt+→ 连着推，推完两侧完全一致',
    kp2[1] === '乙' && kp2[3] === '丁' && /一致/.test(statSel), `${JSON.stringify(kp2)} ${statSel}`);
  ok('没有差异时中间的箭头整组隐藏', (await gut()).shown === false);

  /* ---------- 18. 改完不保存关窗，要拦一下 ----------
     对比窗口是独立窗口：Alt+F4 或点 × 直接关，改动静默消失，没有任何提示。
     拦截点是 onCloseRequested，所以三条关窗路径都从同一个口过。 */
  const alive = async () => !!(await targets()).find((t) => /compare\.html/.test(t.url));
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  await clickRow('l', 0);
  await cmp.send('Input.insertText', { text: 'Z' });
  await sleep(500);
  await cmp.ev(`document.getElementById('wclose').click()`);
  await sleep(900);
  const guard = await cmp.ev(`({
    alive: !!document.getElementById('rowsL'),
    shown: !document.getElementById('confirm').hidden,
    text: document.getElementById('confirmText').textContent,
    canSave: !document.getElementById('confirmSave').hidden,
  })`).catch(() => ({ alive: false }));
  ok('有未保存改动时点关闭会被拦下',
    guard.alive && guard.shown && guard.canSave, JSON.stringify(guard));

  await cmp.ev(`document.getElementById('confirmDrop').click()`);
  await sleep(900);
  ok('点「不保存」才真的关掉', !(await alive()));

  /* 保存并关闭：改动要真的落到磁盘上，不是「窗口关了就算存了」 */
  await openPair(p('edit-a.txt'), p('edit-a2.txt'));
  await enterEdit();
  await clickRow('l', 1);
  await cmp.send('Input.insertText', { text: 'Q' });
  await sleep(500);
  await cmp.ev(`document.getElementById('wclose').click()`);
  await sleep(700);
  const canSave = await cmp.ev(`!document.getElementById('confirmSave').hidden`).catch(() => false);
  ok('关窗确认条给出「保存并关闭」', canSave === true);
  await cmp.ev(`document.getElementById('confirmSave').click()`);
  await sleep(1400);
  ok('「保存并关闭」把窗口关掉', !(await alive()));
  const onDisk = fs.readFileSync(p('edit-a.txt'), 'utf8');
  ok('「保存并关闭」把改动写回了磁盘', onDisk.includes('Q'), onDisk.split('\n')[1] || '');
  /* ---------- 19. 窗口落在主程序那一块屏上 ----------
     以前铺满用的是 SPI_GETWORKAREA，那个 API 只认主屏：主程序在副屏时，
     对比窗口照样开在主屏，拖到副屏再点最大化又被打回主屏。
     断言用「主窗口所在的屏」当基准，单屏机器上是恒等，多屏机器上才有区分度。 */
  const scr = (c) => c.ev(`({
    left: screen.availLeft, top: screen.availTop,
    w: screen.availWidth, h: screen.availHeight,
    x: window.screenX, y: window.screenY,
    ow: window.outerWidth, oh: window.outerHeight,
  })`);
  await openPair(p('push-a.txt'), p('push-b.txt'));
  const ms = await scr(main);
  const cs = await scr(cmp);
  ok('对比窗口和主窗口在同一块屏上',
    cs.left === ms.left && cs.w === ms.w, `${JSON.stringify(ms)} vs ${JSON.stringify(cs)}`);
  ok('铺满的正是这块屏的工作区（不是主屏的工作区）',
    Math.abs(cs.x - cs.left) <= 2 && Math.abs(cs.y - cs.top) <= 2 && Math.abs(cs.ow - cs.w) <= 16,
    JSON.stringify(cs));

  const ico = () => cmp.ev(`({
    restored: document.getElementById('wmax').classList.contains('restored'),
    maxShown: getComputedStyle(document.querySelector('#wmax .i-max')).display !== 'none',
    resShown: getComputedStyle(document.querySelector('#wmax .i-restore')).display !== 'none',
    title: document.getElementById('wmax').title,
  })`);
  const icoFull = await ico();
  ok('铺满时最大化按钮显示「还原」图标，而不是一直挂最大化的方框',
    icoFull.restored && icoFull.resShown && !icoFull.maxShown && /还原/.test(icoFull.title),
    JSON.stringify(icoFull));

  await cmp.ev(`document.getElementById('wmax').click()`);   // 还原
  await sleep(800);
  const rs = await scr(cmp);
  ok('还原后仍在同一块屏里，而且不再是铺满',
    rs.left === cs.left && rs.ow < rs.w - 100
      && rs.x >= rs.left - 2 && rs.x + rs.ow <= rs.left + rs.w + 16,
    JSON.stringify(rs));

  const icoSmall = await ico();
  ok('还原后图标和提示都切成「最大化」',
    !icoSmall.restored && icoSmall.maxShown && !icoSmall.resShown && /最大化/.test(icoSmall.title),
    JSON.stringify(icoSmall));

  await cmp.ev(`document.getElementById('wmax').click()`);   // 再铺满
  await sleep(800);
  const fs2 = await scr(cmp);
  ok('再点一次又铺满这块屏，没有跑到别处',
    Math.abs(fs2.x - fs2.left) <= 2 && Math.abs(fs2.ow - fs2.w) <= 16, JSON.stringify(fs2));
  ok('再铺满后图标又回到「还原」', (await ico()).restored === true);

  /* ---------- 20. 「忽略空白」不能把「按口径一致」说成「逐字一致」 ---------- */
  fs.writeFileSync(p('ws-a.txt'), '一\n二\n', 'utf8');
  fs.writeFileSync(p('ws-b.txt'), '一  \n二\n', 'utf8');    // 行尾多了两个空格
  await openPair(p('ws-a.txt'), p('ws-b.txt'));
  const wsStat = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('忽略空白让两份文件「看着一致」时，状态栏说明这是忽略后的结论',
    /忽略/.test(wsStat), wsStat);
  await cmp.ev(`document.getElementById('optWS').click()`);
  await sleep(600);
  const wsStat2 = await cmp.ev(`document.getElementById('stat').textContent`);
  ok('关掉忽略空白，行尾差异就露出来了', /差异/.test(wsStat2), wsStat2);
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
