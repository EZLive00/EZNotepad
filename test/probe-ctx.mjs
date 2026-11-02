// ============================================================
// test/probe-ctx.mjs —— 表格右键菜单的真机验证（CDP）
//
// 前置：应用已用 --remote-debugging-port=9333 启动。
//   node test/probe-ctx.mjs
//
// 验证三件事：
//   1. 菜单按「文字 / 段落 / 表格」分组、同族动作横排（不再是 23 项竖长条）
//   2. 定位四边夹取：靠上、靠下右键都完整在窗口内（旧实现用 items*30 估高度，
//      表格菜单估成 710px，窗口一矮 top 直接算成负数，上半截看不见）
//   3. 对齐药丸点亮当前列，点击生效；滚动 / Esc 能关
// 右键用 Input.dispatchMouseEvent button:'right' 按真实轨迹触发，
// 合成 contextmenu 事件测不出 e.target.closest 这条路径。
// ============================================================

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !/compare\.html/.test(t.url));
  if (!page) throw new Error('没有找到页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = (expr) => call('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  }).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result.value;
  });
  const rightClick = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1, buttons: 2 });
    await sleep(30);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, buttons: 0 });
    await sleep(280);
  };
  const click = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(35);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  return { ws, ev, call, rightClick, click };
}

const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });

const DOC = `# 表格右键测试

${Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段。这一行把表格往下推，让编辑区一定可以滚动。`).join('\n\n')}

| 名称 | 数量 | 备注 |
| --- | :-: | --: |
| 苹果 | 3 | 新鲜 |
| 香蕉 | 5 |  |

表格后面的段落。
`;

const { ws, ev, rightClick, click } = await connect();

/** 启动时可能弹「恢复草稿」，遮罩会吃掉所有真实点击 —— 先点掉 */
async function dismissOverlay() {
  return ev(`(() => {
    const ov = document.getElementById('dlgOverlay');
    if (!ov || ov.hidden) return 'none';
    const b = [...document.querySelectorAll('#dlgFoot button')].find((x) => /丢弃/.test(x.textContent))
           || document.querySelector('#dlgFoot button');
    if (b) { b.click(); return 'clicked:' + b.textContent.trim(); }
    return 'no-button';
  })()`);
}

/** 当前右键菜单的完整状态（null = 没开） */
const menu = () => ev(`(() => {
  const m = document.querySelector('.ctx-menu');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return {
    heads: [...m.querySelectorAll('.am-head')].map((h) => h.textContent),
    leads: [...m.querySelectorAll('.ctx-lead')].map((l) => l.textContent),
    pills: m.querySelectorAll('.ctx-pill').length,
    dangerPills: m.querySelectorAll('.ctx-pill.danger').length,
    items: m.querySelectorAll('.ctx-item').length,
    onPills: m.querySelectorAll('.ctx-pill.on').length,
    h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
    vh: window.innerHeight, vw: window.innerWidth,
  };
})()`);

const inside = (m) => m && m.top >= 7 && m.bottom <= m.vh - 7 && m.left >= 7 && m.right <= m.vw - 7;

/** 某个格子（含表头）的中心坐标 */
const cellCenter = (idx = 0) => ev(`(() => {
  const c = document.querySelectorAll('.wysiwyg td, .wysiwyg th')[${idx}];
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };
})()`);

/** 把滚动容器滚到让第一个 td 贴近视口 targetY 处 */
const scrollCellTo = async (targetY) => {
  const r = await ev(`(() => {
    const cell = document.querySelector('.wysiwyg td, .wysiwyg th');
    let n = cell.parentElement, scroller = null;
    while (n && n !== document.body) {
      if (n.scrollHeight > n.clientHeight + 4) { scroller = n; break; }
      n = n.parentElement;
    }
    if (!scroller) return 'no-scroller';
    const rect = cell.getBoundingClientRect();
    scroller.scrollTop += rect.top - ${targetY};
    return 'ok';
  })()`);
  await sleep(320);
  return r;
};

const escClose = async () => {
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(220);
  return (await menu()) === null;
};

/* ---------- 准备 ---------- */
await sleep(900);
const ov = await dismissOverlay();
if (ov !== 'none') console.log('  （已关闭启动弹窗：' + ov + '）');

await ev(`window.__snp.newTab('表格右键测试.md', ${JSON.stringify(DOC)})`);
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(650);
await dismissOverlay();
await sleep(220);

/* 表格在长文档的下面，先滚到它能看见的位置 */
await scrollCellTo(320);

/* ---------- 1. 表格里右键：分组结构 ---------- */
const c0 = await cellCenter(1);           // 第二列表头「数量」
ok('表格里右键能弹出菜单', !!(await rightClick(c0.x, c0.y), await menu()));
let m = await menu();
if (!m) {
  console.log('  菜单没打开，后续断言无意义，提前退出');
  try { ws.close(); } catch {}
  process.exit(1);
}

ok('分组标题是 文字 / 段落 / 表格', JSON.stringify(m.heads) === JSON.stringify(['文字', '段落', '表格']), JSON.stringify(m.heads));
ok('表格组是 插入 / 对齐 / 删除 三行小按钮', JSON.stringify(m.leads) === JSON.stringify(['插入', '对齐', '删除']), JSON.stringify(m.leads));
ok('删除行三个按钮带 danger 样式', m.dangerPills === 3, `${m.dangerPills} 个`);
ok('底部保留 全选 / 查找替换', m.items === 2, `${m.items} 项`);
ok('菜单位过组织（高度 < 460，不再是竖长条）', m.h < 460, `${Math.round(m.h)}px`);

/* ---------- 2. 位置：四边都要夹在窗口里 ---------- */
ok('常规位置：菜单完整在窗口内', inside(m),
  `top=${Math.round(m.top)} bottom=${Math.round(m.bottom)} vh=${m.vh}`);

/* 靠上：把表格滚到贴近窗口顶部再右键 —— 旧实现这里 top 会算成负数 */
await escClose();
await scrollCellTo(46);
const cTop = await cellCenter(1);
await rightClick(cTop.x, cTop.y);
m = await menu();
ok('靠上右键：菜单完整在窗口内', inside(m),
  m ? `top=${Math.round(m.top)} bottom=${Math.round(m.bottom)} vh=${m.vh}` : '菜单没开');
ok('靠上右键：菜单没有超出上沿', m && m.top >= 8, m ? `top=${Math.round(m.top)}` : '-');
await escClose();

/* 靠下：翻到鼠标上方，同样不许出界 */
await scrollCellTo(m ? m.vh - 160 : 300);
const cBot = await cellCenter(1);
await rightClick(cBot.x, cBot.y);
m = await menu();
ok('靠下右键：菜单自动上翻且完整在窗口内', inside(m),
  m ? `top=${Math.round(m.top)} bottom=${Math.round(m.bottom)} vh=${m.vh}` : '菜单没开');
await escClose();

/* ---------- 3. 对齐药丸：点亮当前列 + 点击生效 ---------- */
await scrollCellTo(120);
const cAlign = await cellCenter(4);       // 第一行第二列的 td（Markdown 里 :-: 居中）
await rightClick(cAlign.x, cAlign.y);
m = await menu();
ok('当前列的居中对齐被点亮', m && m.onPills >= 1, m ? `${m.onPills} 个点亮` : '-');

/* 点「默认」（取消对齐）—— title 是完整说法「本列取消对齐」，用 aria-label 定位 */
const pill = await ev(`(() => {
  const p = [...document.querySelectorAll('.ctx-menu .ctx-pill')].find((x) => x.getAttribute('aria-label') === '默认');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await click(pill.x, pill.y);
await sleep(380);
const aligned = await ev(`(() => {
  const t = document.querySelector('.wysiwyg table');
  const td = t && t.querySelectorAll('tr')[1] && t.querySelectorAll('tr')[1].children[1];
  return td ? (td.style.textAlign || '(空)') : 'no-cell';
})()`);
ok('点「默认」后本列取消对齐、菜单关闭', aligned === '(空)' && (await menu()) === null, `textAlign=${aligned}`);

/* ---------- 4. 滚动关闭 ---------- */
const c1 = await cellCenter(1);
await rightClick(c1.x, c1.y);
/* 前面的测试可能已经把滚动推到底，往回滚保证这次滚动一定真的发生 */
await ev(`(() => {
  const cell = document.querySelector('.wysiwyg td, .wysiwyg th');
  let n = cell.parentElement;
  while (n && n !== document.body) {
    if (n.scrollHeight > n.clientHeight + 4) {
      n.scrollTop = n.scrollTop > 40 ? n.scrollTop - 60 : n.scrollTop + 60;
      return n.scrollTop;
    }
    n = n.parentElement;
  }
})()`);
await sleep(280);
ok('滚动时右键菜单自动关闭', (await menu()) === null);

/* ---------- 5. Esc 关闭 ---------- */
await rightClick(c1.x, c1.y);
ok('Esc 能关掉右键菜单', await escClose());

/* ---------- 6. 非表格右键：没有表格组 ---------- */
/* 取视口内可见的段落：文档很长，第一段可能滚出视口上方，坐标是负数就点不到了 */
const para = await ev(`(() => {
  const vh = window.innerHeight;
  const b = [...document.querySelectorAll('.w-block')]
    .find((n) => n.dataset.type === 'p' && n.getBoundingClientRect().top > 80 && n.getBoundingClientRect().bottom < vh - 40);
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + 60, y: r.top + r.height / 2 };
})()`);
await rightClick(para.x, para.y);
m = await menu();
/* 正文里会多一行「引用」（普通 / 信息 / 警告 / 危险 / 成功），表格里的三行则一个都不该有 */
ok('正文右键没有表格组，插入组回来了',
  m && !m.heads.includes('表格') && m.heads.includes('插入')
    && !m.leads.some((l) => ['插入', '对齐', '删除'].includes(l)),
  m ? `heads=${JSON.stringify(m.heads)} leads=${JSON.stringify(m.leads)}` : '-');
await escClose();

/* ---------- 汇总 ---------- */
console.log('');
let bad = 0;
for (const r of out) {
  if (!r.pass) bad++;
  console.log(`${r.pass ? '  ok ' : '  FAIL'}  ${r.name}${r.extra ? '   [' + r.extra + ']' : ''}`);
}
console.log(`\n${out.length - bad}/${out.length} 通过`);
try { ws.close(); } catch {}
process.exit(bad ? 1 : 0);
