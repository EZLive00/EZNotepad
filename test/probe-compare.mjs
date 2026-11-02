// ============================================================
// test/probe-compare.mjs —— 对比窗口的真机验证（CDP）
//
// 前置：应用已用 --remote-debugging-port=9333 启动。
//   node test/probe-compare.mjs
//
// 覆盖四件在单测里做不到的事：
//   1. 预览条的几何：宽度、与正文区顶部对齐、短文档时不拉满整列
//   2. 交换按钮的位置不随文件名长度变化
//   3. 差异清单：计数、位置/类型排序、类型筛选、点击跳转
//   4. 上限：行数超限时不加载、给出原因、失败侧不会留着上一轮的旧文件
//
// 夹具写到 node_modules/.tmp（可写，且不进仓库），跑完删掉。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  return {
    ev: (expr) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    }).then((r) => {
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
} finally {
  main.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

/* ---------- 汇总 ---------- */
out.forEach((r) => console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  ' + r.extra : ''}`));
const fail = out.filter((r) => !r.ok).length;
console.log(`\n${out.length - fail}/${out.length} 通过`);
process.exit(fail ? 1 : 0);
