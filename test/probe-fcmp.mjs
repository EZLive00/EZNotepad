// ============================================================
// test/probe-fcmp.mjs —— 文件夹对比独立窗口的真机验证（CDP）
//
// 端口没开就自动拉起应用，跑完随进程退出收掉；已有实例直接复用。
//   node test/probe-fcmp.mjs
//
// 这个窗口只回答一个问题：两个目录差在哪儿。所以断言也围绕「看得懂」：
//   1. 两侧各列自己那份清单，同一行就是同一对；只有一侧有的那条，另一侧
//      必须是斜纹占位（不是留白 —— 留白和「这行没读到」分不清）
//   2. 差异只红字，与文本对比窗口同一套语言
//   3. 点行有下文：两边都有 → 开文本对比；只有一边 → 在主窗口打开
//   4. 窗口自己的按钮（最小化 / 关闭）真的能用 —— 这扇窗的 label 必须在
//      capabilities 里登记，否则权限被拒，按钮点了毫无反应
//
// 夹具写到 node_modules/.tmp（可写、不进仓库），每轮覆盖，不删除。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { ensureApp } from './lib/appctl.mjs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await ensureApp(PORT);

const TMP = path.resolve('node_modules/.tmp/probe-fcmp');
const A = path.join(TMP, 'proj-a');
const B = path.join(TMP, 'proj-b');

const out = [];
const ok = (name, v, extra) => out.push({ name, ok: !!v, extra });

/* ---------- 夹具：四个条目，四种状态各一条 ----------
   两侧各 3 个文件，并集 4 条 → 仅左 1 · 仅右 1 · 已修改 1 · 相同 1。
   数量写死在断言里，所以文件名和结构不能再改，改了就同步改断言。
   mod.txt 两侧的字节数**故意相同**（16 / 16）：这一对必须靠读内容才分得出来，
   只看大小会被误报成「相同」—— 那个 bug 就是这么漏掉的。 */
const put = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
};
const SAME = '这一份两边一模一样，逐字节相同\n';
put(path.join(A, 'same.txt'), SAME);
put(path.join(B, 'same.txt'), SAME);
put(path.join(A, 'mod.txt'), '左边这一行\n');
put(path.join(B, 'mod.txt'), '右边改过了\n');
put(path.join(A, 'sub', 'only-a.txt'), '只有左边有\n');
put(path.join(B, 'sub', 'only-b.txt'), '只有右边有\n');

/* ---------- CDP ---------- */
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());

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
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true },
      }));
    }).then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
      return r.result.value;
    }),
    close: () => ws.close(),
  };
}

/** 主窗口 = 既不是 compare.html 也不是 foldercmp.html 的那个页面 */
const mainTarget = async () => (await targets()).find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));
const fcmpTarget = async () => (await targets()).find((t) => /foldercmp\.html/.test(t.url));

async function waitFor(fn, ms = 8000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const main = await connect((await mainTarget()).webSocketDebuggerUrl);
const J = JSON.stringify;

try {
  const beforeTabs = await main.ev(`document.querySelectorAll('#tabs .tab').length`);

  /* ---------- 1. 从主窗口要一扇窗 ---------- */
  await main.ev(`window.__TAURI_INTERNALS__.invoke('open_folder_compare_window', { left: ${J(A)}, right: ${J(B)} })`);
  const t = await waitFor(fcmpTarget);
  ok('文件夹对比打开独立窗口', !!t, t ? 'foldercmp.html' : '等不到窗口');
  if (!t) throw new Error('窗口没起来，后面的断言无从谈起');
  await sleep(600);

  const cmp = await connect(t.webSocketDebuggerUrl);

  /* ---------- 2. 两侧各列自己的清单 ---------- */
  const head = await cmp.ev(`({
    l: document.getElementById('headL').textContent,
    r: document.getElementById('headR').textContent,
    nl: document.getElementById('nameL').textContent,
    nr: document.getElementById('nameR').textContent,
    nlTitle: document.getElementById('nameL').title,
  })`);
  ok('表头写清两侧文件夹名与文件数', /proj-a/.test(head.l) && /proj-b/.test(head.r), `${head.l} | ${head.r}`);
  /* 每侧各 3 个文件（mod / same / 自己那一侧独有的），合起来 4 个条目 */
  ok('两侧各列自己那份文件数', /3 个文件/.test(head.l) && /3 个文件/.test(head.r), `${head.l} | ${head.r}`);
  const norm = (p) => String(p).replace(/\\/g, '/');
  ok('顶部槽位显示所选目录全路径',
    norm(head.nl) === norm(A) && norm(head.nlTitle) === norm(A), `${head.nl} ← ${head.nlTitle}`);

  const snap = () => cmp.ev(`(() => {
    const rows = [...document.querySelectorAll('#rows .fcmp-row')];
    return {
      n: rows.length,
      kinds: rows.map((r) => (r.className.match(/k-(left|right|mod|same)/) || ['?'])[0]),
      voidCells: document.querySelectorAll('#rows .fcmp-c.void').length,
      stat: document.getElementById('stat').textContent,
      empty: !document.getElementById('empty').classList.contains('hidden'),
      pairs: rows.map((r) => {
        const c = r.querySelectorAll('.fcmp-c');
        return [(c[0].textContent || '').trim(), (c[1].textContent || '').trim()];
      }),
    };
  })()`);

  let s = await snap();
  ok('默认只列有差异的条目', s.n === 3, `${s.n} 行`);
  ok('三种差异各一行', ['k-left', 'k-mod', 'k-right'].every((k) => s.kinds.includes(k)), JSON.stringify(s.kinds));
  ok('相同的那条被隐藏', !s.kinds.includes('k-same'));
  ok('统计行报出四类计数',
    /共 4 个文件/.test(s.stat) && /仅左 1/.test(s.stat) && /仅右 1/.test(s.stat)
    && /已修改 1/.test(s.stat) && /相同 1/.test(s.stat), s.stat);

  /* 行行对齐：同一行左右是同一对，只有一侧有的那条，另一侧必须是斜纹 */
  const leftRow = s.pairs[s.kinds.indexOf('k-left')];
  ok('只有左侧有的那条，右侧是斜纹占位', /\S/.test(leftRow[0]) && leftRow[1] === '', JSON.stringify(leftRow));
  ok('斜纹占位一格一条（两条单侧条目 → 两个空位）', s.voidCells === 2, String(s.voidCells));
  const hatch = await cmp.ev(`(() => {
    const c = document.querySelector('#rows .fcmp-c.void');
    return c ? getComputedStyle(c).backgroundImage : '';
  })()`);
  ok('占位格画的是斜纹，不是留白', /repeating-linear-gradient/.test(hatch), hatch.slice(0, 60));

  /* ---------- 3. 差异只红字 ---------- */
  const redRgb = await cmp.ev(`(() => {
    const d = document.createElement('div');
    d.style.color = 'var(--cmp-red)';
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  })()`);
  const colors = await cmp.ev(`(() => {
    const pick = (k) => {
      const r = document.querySelector('#rows .fcmp-row.' + k);
      const n = r && r.querySelector('.fcmp-nm');
      return n ? getComputedStyle(n).color : null;
    };
    return { mod: pick('k-mod'), left: pick('k-left'), right: pick('k-right') };
  })()`);
  ok('已修改那条的名字标红', colors.mod === redRgb, `${colors.mod} vs ${redRgb}`);
  ok('只有左侧有的那条也标红', colors.left === redRgb, String(colors.left));

  /* 关掉「只看差异」：相同的那条不标红 —— 红字只给差异，不给「一样」 */
  await cmp.ev(`(() => { const c = document.getElementById('optDiff'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  s = await snap();
  ok('关掉「只看差异」后列出全部条目', s.n === 4, `${s.n} 行`);
  const sameColor = await cmp.ev(`(() => {
    const r = document.querySelector('#rows .fcmp-row.k-same');
    const n = r && r.querySelector('.fcmp-nm');
    return n ? getComputedStyle(n).color : null;
  })()`);
  ok('相同的那条不标红', !!sameColor && sameColor !== redRgb, String(sameColor));

  /* ---------- 4. 交换左右 ---------- */
  await cmp.ev(`document.getElementById('swap').click()`);
  await sleep(500);
  const swapped = await cmp.ev(`({ l: document.getElementById('headL').textContent, r: document.getElementById('headR').textContent })`);
  ok('交换按钮对调左右两栏', /proj-b/.test(swapped.l) && /proj-a/.test(swapped.r), `${swapped.l} | ${swapped.r}`);
  await cmp.ev(`document.getElementById('swap').click()`);
  await sleep(400);

  /* ---------- 5. 重新扫描 ---------- */
  await cmp.ev(`(() => { const r = document.getElementById('rescan'); r.click(); })()`);
  await sleep(600);
  const rescanned = await snap();
  ok('重新扫描结果不变', rescanned.n === 4 && rescanned.voidCells === 2, `${rescanned.n} 行 / ${rescanned.voidCells} 个空位`);

  /* ---------- 6. 点行有下文 ---------- */
  await cmp.ev(`(() => {
    const r = document.querySelector('#rows .fcmp-row.k-mod');
    r.click();
  })()`);
  const cmpWin = await waitFor(async () => (await targets()).find((x) => /compare\.html/.test(x.url)), 6000);
  ok('点「已修改」那行开出文本对比窗口', !!cmpWin);
  // 关掉它，免得上一个窗口被后面的 probe 当成自己的
  if (cmpWin) {
    await main.ev(`window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'compare' })`).catch(() => {});
    const gone = await waitFor(async () => !(await targets()).some((x) => /compare\.html/.test(x.url)), 5000);
    ok('文本对比窗口关得掉（关窗权限到位）', !!gone);
  }

  await cmp.ev(`(() => { const r = document.querySelector('#rows .fcmp-row.k-left'); r.click(); })()`);
  await sleep(900);
  const opened = await main.ev(`({
    n: document.querySelectorAll('#tabs .tab').length,
    act: (document.querySelector('.tab.active') || {}).title || '',
  })`);
  /* 「打开」的可观测结果就是它成为当前标签。已经开着的话 openPath 只聚焦、
     不新开一个（两个标签写同一个文件会互相覆盖），所以标签数最多 +1 */
  ok('点只有左侧有的那行，文件在主窗口打开',
    /only-a\.txt$/.test(opened.act) && opened.n >= beforeTabs && opened.n <= beforeTabs + 1,
    `标签 ${beforeTabs} → ${opened.n}，当前 ${opened.act}`);

  /* ---------- 7. 已经开着就复用，不再开第二扇 ---------- */
  const before = (await targets()).filter((x) => /foldercmp\.html/.test(x.url)).length;
  await main.ev(`window.__TAURI_INTERNALS__.invoke('open_folder_compare_window', { left: ${J(B)}, right: ${J(A)} })`);
  await sleep(800);
  const after = (await targets()).filter((x) => /foldercmp\.html/.test(x.url)).length;
  ok('再要一次不新开窗，只把新的一对推过去', before === 1 && after === 1, `${before} → ${after}`);
  ok('复用同一扇窗时内容确实换了',
    /proj-b/.test(await cmp.ev(`document.getElementById('headL').textContent`)));

  /* ---------- 8. 窗口按钮能用（label 必须在 capabilities 里） ----------
     最大化/还原走的是应用内命令 tool_set_fullscreen(label)，label 写错就
     静默回滚（按钮图标弹回去），所以看的是图标最后有没有换过来 */
  const wx = await cmp.ev(`(() => {
    const b = document.getElementById('wmax');
    const a = b.classList.contains('restored');
    b.click();
    return new Promise((r) => setTimeout(() => r({ a, b: b.classList.contains('restored') }), 700));
  })()`);
  ok('最大化/还原按钮能切（label 传对了）', wx.a !== wx.b, JSON.stringify(wx));

  /* 关闭按钮走的是 plugin:window|close —— 这扇窗的 label 没在
     capabilities 里登记的话，点下去毫无反应，窗口留着 */
  await cmp.ev(`document.getElementById('wclose').click()`);
  const closed = await waitFor(async () => !(await targets()).some((x) => /foldercmp\.html/.test(x.url)), 6000);
  ok('关闭按钮真的把窗口关掉（权限到位）', !!closed);
  cmp.close();
} catch (e) {
  ok('探针执行完成', false, e.message);
} finally {
  main.close();
}

let bad = 0;
for (const r of out) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
}
console.log(`\n${out.length - bad}/${out.length} 通过`);
process.exit(bad ? 1 : 0);
