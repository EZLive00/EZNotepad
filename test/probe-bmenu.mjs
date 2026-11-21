// ============================================================
// test/probe-bmenu.mjs —— 行首块手柄的真机验证（CDP）
//
// 端口没开就自动拉起应用，跑完随进程退出收掉；已有实例直接复用。
//   node test/probe-bmenu.mjs
//
// 为什么必须真机：手柄靠 mousemove 定位、菜单靠 document 级 mousedown
// 判定「点了外面」，这些在 jsdom 里都是假的。这里用 Input.dispatchMouseEvent
// **按真实轨迹移动鼠标**（块 → + 按钮 → 缝隙 → 菜单项），复现用户的手。
// ============================================================
import { ensureApp } from './lib/appctl.mjs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await ensureApp(PORT);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));
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
  /** 把鼠标真的挪到某点 */
  const moveTo = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  };
  /** 分段移动：真实用户是连续移动，缝隙里的 mousemove 才是 bug 的触发器 */
  const dragTo = async (x, y, from, steps = 6) => {
    for (let i = 1; i <= steps; i++) {
      await moveTo(from.x + (x - from.x) * i / steps, from.y + (y - from.y) * i / steps);
      await sleep(16);
    }
  };
  const click = async (x, y) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(35);
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  };
  return { ws, ev, call, moveTo, dragTo, click };
}

const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });

/** WCAG 相对亮度 */
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [la, lb] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
};
const parseRgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

const DOC = `# 手柄测试

第一个段落，用来挂手柄。

第二个段落，菜单里的「转换」应该作用在它上面。
`;

const { ws, ev, call, moveTo, dragTo, click } = await connect();

/** 启动时可能弹「恢复草稿」，它的遮罩会吃掉所有真实点击 —— 先点掉 */
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

const state = () => ev(`(() => {
  const m = document.getElementById('wBlockMenu');
  return {
    menuOpen: !m.classList.contains('hidden'),
    items: m.querySelectorAll('.bm-item').length,
    handleShown: !document.getElementById('wHandle').classList.contains('hidden'),
  };
})()`);

/** 块内的一个内点：按块自身宽度取，不用固定 120px。
 *  侧栏展不展开会把正文列压得很窄（实测窄到 110px、一段折成五行），
 *  固定偏移会落到段落右边的留白里 —— 那里按设计「不属于任何块」，手柄当然不动。
 *  这类假红最难查：症状与「手柄不会跟着挪」一模一样。 */
const inPara = (r, dx = 40) => Math.round(r.left + Math.min(dx, Math.max(8, (r.right - r.left) / 2)));

/** 段落中心坐标 */
const paraCenter = () => ev(`(() => {
  const b = [...document.querySelectorAll('.w-block')].find((n) => n.dataset.type === 'p');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {
    x: r.left + Math.min(40, Math.max(8, (r.right - r.left) / 2)),
    y: r.top + r.height / 2, right: r.right, left: r.left,
  };
})()`);
const btnCenter = (id) => ev(`(() => {
  const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

/** 悬停段落 → 点 + 打开菜单。手柄是 hover 语义（离开块 220ms 收起），所以重试几轮 */
async function openMenu() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = await paraCenter();
    if (!p) return false;
    await moveTo(p.x, p.y);
    await sleep(220);
    const b = await btnCenter('whAdd');
    if (!b) continue;
    await dragTo(b.x, b.y, p, 4);
    await sleep(40);
    await click(b.x, b.y);
    await sleep(260);
    if ((await state()).menuOpen) return true;
  }
  return false;
}

/* ---------- 准备 ---------- */
await sleep(900);
const ov = await dismissOverlay();
if (ov !== 'none') console.log('  （已关闭启动弹窗：' + ov + '）');

await ev(`window.__snp.newTab('手柄测试.md', ${JSON.stringify(DOC)})`);
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(600);
await dismissOverlay();                // 切模式时也可能再弹一次
await sleep(200);

/* ---------- 1. 手柄出现 ---------- */
const p0 = await paraCenter();
await moveTo(p0.x, p0.y);
await sleep(320);
ok('鼠标移到段落上，行首手柄出现', await ev(`!document.getElementById('wHandle').classList.contains('hidden')`));

/* ---------- 1.5 Notion 式 hover：鼠标在哪行，手柄就在哪行；离开就收起 ---------- */
const paraRects = await ev(`(() => {
  const ps = [...document.querySelectorAll('.w-block')].filter((n) => n.dataset.type === 'p');
  return ps.slice(0, 2).map((b) => {
    const r = b.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: (r.top + r.bottom) / 2 };
  });
})()`);
const handleTop = () => ev(`document.getElementById('wHandle').getBoundingClientRect().top`);
const shown = () => ev(`!document.getElementById('wHandle').classList.contains('hidden')`);
/** 手柄当前贴着哪一段（按 y 最近）。断言认「贴着谁」，不认某个绝对像素 ——
 *  窗口大小、DPI、前面的组留下的滚动位置都会改绝对坐标，那是环境不是行为 */
const handleAnchor = () => ev(`(() => {
  const h = document.getElementById('wHandle');
  if (h.classList.contains('hidden')) return '(隐藏)';
  const y = h.getBoundingClientRect().top;
  const ps = [...document.querySelectorAll('.w-block')].filter((n) => n.dataset.type === 'p');
  let best = null;
  for (const b of ps) {
    const t = b.getBoundingClientRect().top;
    if (!best || Math.abs(t - y) < Math.abs(best.t - y)) best = { t, text: (b.textContent || '').slice(0, 4) };
  }
  return best ? best.text : '(没有段落)';
})()`);
const topAfterFirst = await handleTop();
ok('手柄一开始贴在第一段', (await handleAnchor()) === '第一个段', await handleAnchor());

/* a. 两段之间的空隙：既不属于上一块也不属于下一块 → 收起（Notion 式不常驻） */
const paraGapY = (paraRects[0].bottom + paraRects[1].top) / 2;
await moveTo(inPara(paraRects[0]), paraGapY);
await sleep(420);   // > 220ms 宽限期
ok('鼠标停在两段之间的空隙，手柄收起', !(await shown()));

/* b. 块的左侧留白（手柄右边、正文左边这一条）→ 收起 */
await moveTo(inPara(paraRects[0]), paraRects[0].cy);       // 先回块上，让它重新出现
await sleep(120);
await moveTo(paraRects[0].left - 52, paraRects[0].cy);     // 手柄按钮左侧的干净留白（按钮本身在 left-45~-24）
await sleep(420);
ok('鼠标停在正文左侧的留白里，手柄收起', !(await shown()));

/* c. 移出编辑区（去标题栏）→ 收起 */
await moveTo(300, 8);
await sleep(420);
ok('鼠标离开编辑区，手柄收起', !(await shown()));

/* d. 真的换到下一段，才跟着挪。
   按真实手的轨迹分段移过去：从标题栏一步瞬移到段落中心，是一次 mousemove 跨过
   整个编辑区，事件会不会被丢取决于当时的合成时序 —— 这不属于被测行为。 */
await dragTo(inPara(paraRects[1]), paraRects[1].cy, { x: 300, y: 8 }, 8);
await sleep(340);
const topAfterSecond = await handleTop();
ok('鼠标换到下一段，手柄跟着挪过去', topAfterSecond > topAfterFirst + 5,
  `${Math.round(topAfterSecond)} vs ${Math.round(topAfterFirst)}`);
ok('…而且贴的是第二段', (await handleAnchor()) === '第二个段', await handleAnchor());

/* ---------- 2. 点 + 打开菜单 ---------- */
ok('点击 + 弹出块菜单', await openMenu());
const opened = await state();
ok('菜单里有可选项', opened.items >= 6, `${opened.items} 项`);
ok('高亮落在被点的 + 上（不是旁边的抓手）',
  await ev(`document.getElementById('whAdd').classList.contains('open')
        && !document.getElementById('whMenu').classList.contains('open')`));
if (!opened.menuOpen) {
  console.log('  菜单没打开，后续断言无意义，提前退出');
  console.log(JSON.stringify(await state()));
  try { ws.close(); } catch {}
  process.exit(1);
}

/* ---------- 3. 关键回归：滑过手柄与菜单之间的缝隙 ---------- */
const rects = await ev(`(() => {
  const h = document.getElementById('wHandle').getBoundingClientRect();
  const m = document.getElementById('wBlockMenu').getBoundingClientRect();
  return { hRight: h.right, mLeft: m.left, mTop: m.top, hCenter: { x: (h.left + h.right) / 2, y: (h.top + h.bottom) / 2 } };
})()`);
const gapX = (rects.hRight + rects.mLeft) / 2;
const gapY = rects.mTop + 24;
await dragTo(gapX, gapY, rects.hCenter, 5);
await sleep(260);
ok('鼠标经过手柄与菜单之间的缝隙，菜单仍在', (await state()).menuOpen);
ok('此刻手柄也还在（不能被当成「离开了」）', (await state()).handleShown);

/* ---------- 4. 滑到菜单项上停留 ---------- */
const firstItem = await ev(`(() => {
  const it = document.querySelector('#wBlockMenu .bm-item');
  if (!it) return null;
  const r = it.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2 };
})()`);
await dragTo(firstItem.x, firstItem.y, { x: gapX, y: gapY }, 4);
await sleep(450);                      // 停够久：旧逻辑 240ms 就收了
ok('停在菜单项上 450ms，菜单没消失', (await state()).menuOpen);

/* ---------- 5. 点下去生效并关闭 ---------- */
await click(firstItem.x, firstItem.y);
await sleep(420);
ok('点菜单项后菜单关闭', !(await state()).menuOpen);
/* 手柄不该「闪空」：光标落在被操作的块上，它本就该跟着光标显示 */
ok('点菜单项后手柄仍在光标所在块', (await state()).handleShown);

/* ---------- 6. 点编辑区别处也能关 ---------- */
ok('再次点 + 能打开', await openMenu());
const p1 = await paraCenter();
/* 必须点在菜单覆盖范围之外（菜单从块左沿展开约 190px），否则就是点菜单自己 */
await click(p1.right - 40, p1.y);
await sleep(320);
ok('点编辑区别处关闭菜单', !(await state()).menuOpen);

/* ---------- 6.5 点六点抓手：转换菜单 + 高亮跟着换 ---------- */
const p2 = await paraCenter();
await moveTo(p2.x, p2.y);
await sleep(240);
const grip = await btnCenter('whMenu');
await dragTo(grip.x, grip.y, p2, 4);
await click(grip.x, grip.y);
await sleep(320);
ok('点抓手打开转换菜单', (await state()).menuOpen);
ok('高亮落在抓手上', await ev(
  `document.getElementById('whMenu').classList.contains('open')
   && !document.getElementById('whAdd').classList.contains('open')`));
ok('Esc 能关掉菜单', await ev(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`) && (await sleep(200), !(await state()).menuOpen));

/* ---------- 6.6 键盘操作：↑↓ Home End Enter ----------
   焦点始终在编辑区（菜单不抢焦点，否则正文选区没了），所以「当前项」是 .hot 类 */
const key = (k) => ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true; })()`);
const hotIdx = () => ev(`[...document.querySelectorAll('#wBlockMenu .bm-item')].findIndex(b => b.classList.contains('hot'))`);

await click(grip.x, grip.y);
await sleep(320);
const total = await ev(`document.querySelectorAll('#wBlockMenu .bm-item').length`);
const navTotal = await ev(`document.querySelectorAll('#wBlockMenu .bm-item:not(.danger)').length`);
const dangerHot = () => ev(`!!document.querySelector('#wBlockMenu .bm-item.danger.hot')`);
ok('键盘：每一项都有 menuitem 角色', (await ev(`document.querySelectorAll('#wBlockMenu [role=menuitem]').length`)) === total);
/* 1.2.1：面板底部多了「删除这一块」。它是破坏性操作，只能鼠标点，
   不该被 ↑↓ / Home / End 选中 —— 否则 End + Enter 会平白删掉整块。 */
ok('键盘：底部删除项在面板里但不进导航序列', total === navTotal + 1, `${total} / ${navTotal}`);
ok('键盘：打开时不预选（和顶栏菜单一致）', (await hotIdx()) === -1);
await key('ArrowDown'); await sleep(80);
ok('键盘：↓ 选中第一项', (await hotIdx()) === 0);
await key('ArrowDown'); await sleep(80);
ok('键盘：再 ↓ 到第二项', (await hotIdx()) === 1);
await key('ArrowUp'); await key('ArrowUp'); await sleep(100);
ok('键盘：首项再 ↑ 环绕到最后一个可导航项', (await hotIdx()) === navTotal - 1,
  `${await hotIdx()} / ${navTotal}`);
ok('键盘：环绕没落到破坏性项上', !(await dangerHot()));
await key('Home'); await sleep(80);
ok('键盘：Home 回到首项', (await hotIdx()) === 0);
await key('End'); await sleep(80);
ok('键盘：End 到最后一个可导航项（不是删除）', (await hotIdx()) === navTotal - 1,
  `${await hotIdx()} / ${navTotal}`);
ok('键盘：删除项始终没被键盘高亮', !(await dangerHot()));

/* 最后一个可导航项是「成功提示块」：Enter 之后这一块必须真的转换过去，
   绝不能因为底部多了个删除项就把整块删掉 */
const blocksBefore = await ev(`document.querySelectorAll('.wysiwyg > .w-block').length`);
await key('Enter'); await sleep(450);
ok('键盘：Enter 执行末项（块变成成功提示块）',
  !(await state()).menuOpen && (await ev(`!!document.querySelector('.w-block[data-callout=success]')`)));
const blocksAfter = await ev(`document.querySelectorAll('.wysiwyg > .w-block').length`);
ok('键盘：Enter 没有误删当前块', blocksAfter === blocksBefore, `${blocksBefore} → ${blocksAfter}`);

await click(grip.x, grip.y);
await sleep(320);
await key('a'); await sleep(100);
ok('键盘：未分配的字母键收起菜单（字符归正文）', !(await state()).menuOpen);
ok('键盘：菜单全程不抢焦点', await ev(`!document.activeElement.closest('#wBlockMenu')`));

/* ---------- 6.7 "/" 起面板（手不离键盘） ----------
   合成 KeyboardEvent 派到编辑区：它不会真的插入字符，正好用来验「这一下有没有
   被拦下、面板开没开」；字符到底落没落进正文看 toMarkdown。
   注意必须派到 #wysiwyg 本身 —— 派到 document 传不进编辑区的监听。 */
const slash = () => ev(`(() => {
  const el = document.getElementById('wysiwyg');
  const ev = new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
})()`);
const md = () => ev('window.__snp.editor.toMarkdown()');
const menuOpen = async () => (await state()).menuOpen;
const openDoc = async (name, text) => {
  await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(text)})`);
  await ev('window.__snp.commands.modeWysiwyg()');
  await sleep(420);
  await dismissOverlay();
  await sleep(120);
};
/** 光标放到第 i 块（默认最后一块）的末尾 */
const caretIn = (i = -1) => ev(`(() => {
  const bs = [...document.querySelectorAll('.w-block')];
  const b = bs[${i} < 0 ? bs.length + ${i} : ${i}];
  if (!b) return null;
  window.__snp.editor.focusBlock(b, true);
  return b.dataset.type;
})()`);

await openDoc('slash-a.md', '甲段\n\n');
await caretIn();
const blocked = await slash();
await sleep(240);
ok('/ 在行尾弹出插入面板', await menuOpen());
ok('…斜杠被拦下，没落进正文', blocked && !(await md()).includes('/'), JSON.stringify(await md()));

/* 空段落里按 1：直接改这一块的类型，而不是在下面再造一个（否则上面留个空行） */
await key('1'); await sleep(450);
ok('/ + 1：空段落原地变成一级标题',
  !(await menuOpen()) && (await ev(`[...document.querySelectorAll('.w-block')].at(-1).dataset.type`)) === 'h1',
  JSON.stringify(await md()));
ok('…没有多出空段落', (await ev(`document.querySelectorAll('.w-block').length`)) === 2,
  `${await ev(`document.querySelectorAll('.w-block').length`)} 块`);

/* 什么都没选就关：斜杠必须还回正文，且光标在它后面 */
await openDoc('slash-b.md', '乙段\n\n');
await caretIn();
await slash(); await sleep(200);
await key('Escape'); await sleep(280);
ok('Esc 关面板后斜杠回到正文', !(await menuOpen()) && (await md()).includes('/'), JSON.stringify(await md()));
ok('…光标停在斜杠后面（接着打就是正常输入）',
  await ev(`(() => {
    const b = window.__snp.editor.currentBlock();
    const t = b && b.querySelector('.w-text');
    if (!t) return false;
    const r = window.getSelection().getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(t); pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().endsWith('/');
  })()`));

/* 斜杠前面不是空白（日期 / 路径 / 分数）不该弹 */
await openDoc('slash-c.md', '2026/11/05\n');
await caretIn();
await slash(); await sleep(220);
ok('"/" 前不是空白（日期 2026/11/05）不弹面板', !(await menuOpen()));

/* 只在「空行」弹：行里有文字了，哪怕光标在行首 / 前面是空白，也不弹 */
await openDoc('slash-c2.md', '已经有正文了\n');
await ev(`(() => {
  const b = [...document.querySelectorAll('.w-block')].at(-1);
  window.__snp.editor.focusBlock(b, false);   // 光标到这一行开头
  return 1;
})()`);
await slash(); await sleep(220);
ok('非空行行首打 "/" 不弹面板（不像空白之后那样误触发）', !(await menuOpen()));
await openDoc('slash-c3.md', '段尾文字 \n');
await caretIn();
await slash(); await sleep(220);
ok('文字后带空格再打 "/" 不弹面板', !(await menuOpen()), JSON.stringify(await md()));

/* 代码块里的 "/" 是正文字符 */
await openDoc('slash-d.md', '```\n/a\n```\n');
await caretIn(0);
await slash(); await sleep(220);
ok('代码块里的 "/" 不弹面板', !(await menuOpen()));

/* 插入类的选择键：t = 表格 */
await openDoc('slash-e.md', '丙段\n\n');
await caretIn();
await slash(); await sleep(220);
await key('t'); await sleep(520);
ok('/ + t 插入表格', !(await menuOpen()) && (await ev(`!!document.querySelector('.w-block[data-type=table]')`)));

/* 每一档都要有键，且互不重复（数字 0-9 + w/d/s + t/T/i/l/-） */
await openDoc('slash-f.md', '丁段\n\n');
await caretIn();
await slash(); await sleep(220);
const keys = await ev(`[...document.querySelectorAll('#wBlockMenu .bm-item')].map(b => b.dataset.key)`);
const real = keys.filter(Boolean);
/* 1.5.0 起插入面板顶部多了一段「最近使用」：那一组故意不带选择键 ——
   同一个 id 在下面的正式分组里还会出现一次，键只该命中一个。 */
ok('面板里可直达的项都有选择键', real.length >= 18, `${keys.length} 项 / 带键 ${real.length}`);
ok('选择键互不重复', new Set(real).size === real.length, JSON.stringify(real));
ok('键位按语义分段（0 正文 / 1-3 标题 / w 警告 / t 表格）',
  real[0] === '0' && real[1] === '1' && real[3] === '3' && real.includes('w') && real.includes('t'),
  JSON.stringify(real));
ok('最近使用组不带选择键', keys.length > real.length, `${keys.length - real.length} 项无键`);
await key('Escape'); await sleep(240);

/* ---------- 7. 图标对比度（两套主题都量） ---------- */
/* 主题挂在 body[data-theme] 上；背景要往上找到第一个不透明的祖先 */
const contrastOf = async (theme) => ev(`(() => {
  document.body.dataset.theme = ${JSON.stringify(theme)};
  const btn = document.querySelector('.wh-btn');
  const color = getComputedStyle(btn).color;
  let node = btn.parentElement, bg = 'rgba(0, 0, 0, 0)';
  while (node) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) { bg = c; break; }
    node = node.parentElement;
  }
  return { color, bg };
})()`);
for (const theme of ['light', 'dark']) {
  const { color, bg } = await contrastOf(theme);
  const ratio = contrast(parseRgb(color), parseRgb(bg));
  ok(`${theme} 主题下 + 图标对比度 ≥ 4.5:1`, ratio >= 4.5, `${ratio.toFixed(2)}:1（${color} on ${bg}）`);
}
await ev(`document.body.dataset.theme = 'light'`);

/* ---------- 8. 「+」面板的「插入空行」（Notion 式显式入口） ----------
   出块提示线是「已经按了方向键」之后的引导；这里给不碰方向键的人一条
   明确的、点得到的路。kbd 只作 title 提示，不注册成全局命令（全局那条
   会被编辑模式、查找框一起吃到）。 */
await openDoc('blank-line.md', '甲段\n\n乙段');
await sleep(220);
const nBefore = await ev(`document.querySelectorAll('.wysiwyg > .w-block').length`);
ok('点 + 打开插入面板', await openMenu());
const blankItem = await ev(`(() => {
  const b = [...document.querySelectorAll('#wBlockMenu .bm-item')]
    .find(e => e.textContent.includes('插入空行'));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { key: b.dataset.key, title: b.title, x: r.left + 40, y: r.top + r.height / 2 };
})()`);
ok('面板里有「插入空行」，标了 n 选择键与 Ctrl+Enter',
  !!blankItem && blankItem.key === 'n' && blankItem.title === 'Ctrl+Enter',
  JSON.stringify(blankItem));
if (blankItem) {
  await click(blankItem.x, blankItem.y);
  await sleep(420);
  const nAfter = await ev(`document.querySelectorAll('.wysiwyg > .w-block').length`);
  ok('点「插入空行」真的多出一个块', nAfter === nBefore + 1, `${nBefore} -> ${nAfter}`);
  ok('新块是空段落，光标落在里面', await ev(`(() => {
    const n = getSelection().anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const b = el && el.closest ? el.closest('.wysiwyg > .w-block') : null;
    return !!b && (b.dataset.type || 'p') === 'p'
      && (b.textContent || '').split('\\u200b').join('') === '';
  })()`));
} else {
  ok('点「插入空行」真的多出一个块', false, '菜单项没找到');
  ok('新块是空段落，光标落在里面', false, '菜单项没找到');
}

/* ---------- 9. Shift+点抓手 = 块选中；整组移动；拖动排序；标题折叠 ----------
   这一组全是要「真的按下去、真的拖过去」才成立的交互：块选中靠 pointerdown
   的 shiftKey、拖动靠 pointer 捕获 + 落点线，jsdom 里都没有。 */
await openDoc('blocks.md', '一段\n\n二段\n\n三段\n');
const blockTexts = () => ev(`[...document.querySelectorAll('.wysiwyg > .w-block')].map(b => (b.textContent || '').replace(/\\u200b/g, '').trim())`);
const selCount = () => ev(`document.querySelectorAll('.wysiwyg > .w-block.w-sel').length`);
const nthBlock = (i) => ev(`(() => {
  const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
  const b = bs[${i}];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + Math.min(30, Math.max(8, r.width / 2)), y: r.top + r.height / 2,
           left: r.left, right: r.right, top: r.top, bottom: r.bottom };
})()`);
/** Shift+点：CDP 的 modifiers 8 = Shift */
const shiftClickAt = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, modifiers: 8 });
  await sleep(40);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, modifiers: 8 });
};
/** Ctrl+点：modifiers 2 = Ctrl（进块选择模式） */
const ctrlClickAt = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, modifiers: 2 });
  await sleep(40);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, modifiers: 2 });
};
/** 悬停第 i 块 → 等手柄**真的贴上**它 → 返回抓手中心。
 *  固定 sleep 不够：release 产物比 debug 快，160ms 时手柄偶尔还在上一块上，
 *  接着 Shift+点就成了「点锚块 = 取消选中」，测试红得莫名其妙。 */
const gripAt = async (i) => {
  const p = await nthBlock(i);
  if (!p) return null;
  const anchoredAt = () => ev(`(() => {
    const h = document.getElementById('wHandle');
    if (h.classList.contains('hidden')) return -1;
    const y = h.getBoundingClientRect().top;
    const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
    let best = -1, bd = 1e9;
    bs.forEach((b, n) => {
      const d = Math.abs(b.getBoundingClientRect().top - y);
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  })()`);
  let anchor = -1;
  for (let k = 0; k < 8; k++) {
    await moveTo(p.x, p.y);
    await sleep(80);
    anchor = await anchoredAt();
    if (anchor === i) break;
  }
  const btn = await btnCenter('whMenu');
  return btn ? { ...btn, anchor, want: i } : null;
};
const pressKey = (k, mods = {}) => ev(`(() => {
  const el = document.getElementById('wysiwyg');
  el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }, ${JSON.stringify(mods)})));
  return true;
})()`);

const g0 = await gripAt(0);
ok('悬停段落时抓手可点', !!g0, JSON.stringify(g0));
if (g0) {
  await shiftClickAt(g0.x, g0.y);
  await sleep(180);
  ok('Shift+点抓手选中这一块', (await selCount()) === 1, String(await selCount()));
}
const g2 = await gripAt(2);
if (g2) {
  await shiftClickAt(g2.x, g2.y);
  await sleep(180);
  const dbg2 = await ev(`(() => ({
    sel: [...document.querySelectorAll('.w-sel')].map((b) => (b.textContent || '').replace(/\\u200b/g, '').slice(0, 4)),
    menu: !document.getElementById('wBlockMenu').classList.contains('hidden'),
  }))()`);
  ok('再 Shift+点第三块：扩成连续三段', (await selCount()) === 3, `${await selCount()} ${JSON.stringify(dbg2)}`);
}
ok('块选中不改正文', (await md()).trim() === '一段\n\n二段\n\n三段', JSON.stringify(await md()));
ok('块选中时抓手仍在（它是选中态的操作入口）',
  await ev(`!document.getElementById('wHandle').classList.contains('hidden')`),
  await ev(`document.getElementById('wHandle').className`));

/* 清掉选中，测「单块键盘上移」 */
await pressKey('Escape');
await sleep(120);
ok('Esc 取消块选中', (await selCount()) === 0);

const g1 = await gripAt(1);
if (g1) await shiftClickAt(g1.x, g1.y);
await sleep(140);
await pressKey('ArrowUp', { ctrlKey: true, shiftKey: true });
await sleep(260);
ok('Ctrl+Shift+↑ 把选中的块上移一位',
  (await blockTexts()).join(',') === '二段,一段,三段', (await blockTexts()).join(','));

/* 拖动排序：从第一段的抓手按下去，拖到第三段下半部分，松手 */
await pressKey('Escape');
await sleep(100);
const gTop = await gripAt(0);
const pBottom = await nthBlock(2);
if (gTop && pBottom) {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: gTop.x, y: gTop.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  const yTo = pBottom.bottom - 4;
  for (let i = 1; i <= 8; i++) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: gTop.x + 6, y: gTop.y + (yTo - gTop.y) * i / 8, buttons: 0,
    });
    await sleep(20);
  }
  await sleep(80);
  /* 松手之前先看插入线：这是「会插在哪」的唯一提示，位置得真的贴在目标块边缘 */
  const dl = await ev(`(() => {
    const l = document.querySelector('.w-drop-line');
    const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
    const b = bs[2];
    if (!l || !b) return null;
    const lr = l.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { hidden: l.classList.contains('hidden'), w: Math.round(lr.width), h: Math.round(lr.height),
             dy: Math.round(lr.top - br.bottom), bw: Math.round(br.width), top: Math.round(lr.top) };
  })()`);
  ok('拖动时插入线是显示出来的', !!dl && !dl.hidden && dl.w > 0 && dl.h > 0, JSON.stringify(dl));
  ok('插入线贴住落点（目标块下边缘）', !!dl && Math.abs(dl.dy) <= 3, JSON.stringify(dl));
  ok('插入线横跨整块宽度', !!dl && Math.abs(dl.w - dl.bw) <= 2, JSON.stringify(dl));
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gTop.x + 6, y: yTo, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(320);
  /* 拖动前顺序是「二段,一段,三段」（上一条用例刚把二段提到最前），
     所以拖走第一块之后应该剩「一段,三段,二段」 */
  ok('拖抓手把第一块搬到最后', (await blockTexts()).join(',') === '一段,三段,二段', (await blockTexts()).join(','));
} else {
  ok('拖抓手把第一块搬到最后', false, '抓手或目标块没找到');
  ok('拖动时插入线是显示出来的', false, '抓手或目标块没找到');
  ok('插入线贴住落点（目标块下边缘）', false, '抓手或目标块没找到');
  ok('插入线横跨整块宽度', false, '抓手或目标块没找到');
}

/* 标题折叠：三角只在标题块上出现，折起来是一行不差的「只是看不见」 */
await openDoc('fold.md', '# 标题一\n\n正文甲\n\n## 标题二\n\n正文乙\n');
const hb = await nthBlock(0);
await moveTo(hb.x, hb.y);
await sleep(200);
const foldBtn = await btnCenter('whFold');
ok('标题块的手柄里出现折叠三角', !!foldBtn);
if (foldBtn) {
  await click(foldBtn.x, foldBtn.y);
  await sleep(220);
  ok('点三角：后续块全部不可见', await ev(`(() => {
    const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
    return bs.length > 1 && bs.slice(1).every((b) => getComputedStyle(b).display === 'none');
  })()`));
  ok('折叠不改 Markdown（视图状态不进文件）', (await md()).includes('## 标题二'), JSON.stringify(await md()));
  /* 折起来之后手柄还贴在这个标题上，再点一次就是展开 */
  await moveTo(hb.x, hb.y);
  await sleep(150);
  const foldBtn2 = await btnCenter('whFold');
  if (foldBtn2) await click(foldBtn2.x, foldBtn2.y);
  await sleep(220);
  ok('再点一次展开：正文重新可见', await ev(`(() => {
    const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
    return bs.slice(1).every((b) => getComputedStyle(b).display !== 'none');
  })()`));
} else {
  ok('点三角：后续块全部不可见', false, '三角没找到');
  ok('折叠不改 Markdown（视图状态不进文件）', false, '三角没找到');
}

/* ---------- 10. 滚动之后的插入线 ----------
   paintDropLine 以前在「块矩形相对容器的偏移」上又加了一次 scrollTop，
   文档一滚线就被推到视口外 —— 用户看到的是「拖的时候完全没有插入位置」。 */
await openDoc('long.md', Array.from({ length: 40 }, (_, i) => `第${i + 1}段`).join('\n\n') + '\n');
await ev(`(() => { const w = document.getElementById('wysiwyg'); w.scrollTop = 700; return w.scrollTop; })()`);
await sleep(240);
const midIdx = await ev(`(() => {
  const w = document.getElementById('wysiwyg');
  const wr = w.getBoundingClientRect();
  const mid = (wr.top + wr.bottom) / 2;
  const bs = [...w.querySelectorAll(':scope > .w-block')];
  return bs.findIndex((b) => { const r = b.getBoundingClientRect(); return r.top < mid && r.bottom > mid; });
})()`);
const sFrom = midIdx > 2 ? await gripAt(midIdx - 2) : null;
const sTo = midIdx > 0 ? await nthBlock(midIdx + 2) : null;
if (sFrom && sTo) {
  const yTo = sTo.bottom - 3;
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: sFrom.x, y: sFrom.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= 8; i++) {
    await call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: sFrom.x + 6, y: sFrom.y + (yTo - sFrom.y) * i / 8, buttons: 0,
    });
    await sleep(20);
  }
  await sleep(90);
  const sd = await ev(`(() => {
    const l = document.querySelector('.w-drop-line');
    const w = document.getElementById('wysiwyg');
    if (!l) return null;
    const lr = l.getBoundingClientRect(), wr = w.getBoundingClientRect();
    return { hidden: l.classList.contains('hidden'), h: Math.round(lr.height),
             inView: lr.top > wr.top - 4 && lr.top < wr.bottom + 4,
             scrollTop: Math.round(w.scrollTop) };
  })()`);
  ok('滚动后拖动：插入线仍在视口内', !!sd && !sd.hidden && sd.h > 0 && sd.inView, JSON.stringify(sd));
  ok('滚动后拖动：线确实按滚动位置重算过', !!sd && sd.scrollTop > 300, JSON.stringify(sd));
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sFrom.x + 6, y: yTo, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(240);
} else {
  ok('滚动后拖动：插入线仍在视口内', false, `from=${!!sFrom} to=${!!sTo}`);
  ok('滚动后拖动：线确实按滚动位置重算过', false, `from=${!!sFrom} to=${!!sTo}`);
}

/* ---------- 11. 块选择模式 ----------
   Ctrl+点抓手进去，抓手与行首 + 让位，只留整块高亮 + 顶部提示条；
   点正文换选中的块，右键出整套整组操作，Esc 退出。 */
await openDoc('sel.md', '一段\n\n二段\n\n三段\n');
const sA = await gripAt(0);
if (sA) { await ctrlClickAt(sA.x, sA.y); await sleep(220); }
const mode1 = await ev(`(() => {
  const wrap = document.querySelector('.edit-wrap');
  const hint = document.querySelector('.w-selhint');
  const h = document.getElementById('wHandle');
  return {
    mode: wrap.classList.contains('w-selmode'),
    hint: hint ? hint.textContent : null,
    hintShown: hint ? !hint.classList.contains('hidden') : false,
    grip: getComputedStyle(h).display,
    sel: document.querySelectorAll('.wysiwyg > .w-block.w-sel').length,
  };
})()`);
ok('Ctrl+点抓手进入选择模式', mode1.mode && mode1.sel === 1, JSON.stringify(mode1));
ok('顶部提示条写明已选几块', mode1.hintShown && /已选 1 块/.test(mode1.hint || ''), JSON.stringify(mode1.hint));
ok('模式里抓手让位（只留选中高亮）', mode1.grip === 'none', mode1.grip);

const pB = await nthBlock(2);
if (pB) { await click(pB.x, pB.y); await sleep(220); }
ok('模式里点正文 = 扩到那一段', (await selCount()) === 3, String(await selCount()));
ok('点正文不进编辑，提示条跟着更新',
  /已选 3 块/.test(await ev(`(document.querySelector('.w-selhint') || {}).textContent || ''`)),
  await ev(`(document.querySelector('.w-selhint') || {}).textContent || ''`));

/* 右键：整套整组菜单（文字格式那一套对着一堆整块没有意义） */
await ev(`(() => {
  const b = document.querySelectorAll('.wysiwyg > .w-block')[2];
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 6,
  }));
  return true;
})()`);
await sleep(200);
const bmenu = await ev(`(() => {
  const m = document.querySelector('.ctx-menu');
  if (!m) return null;
  return {
    heads: [...m.querySelectorAll('.am-head')].map((h) => h.textContent),
    labels: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
  };
})()`);
ok('右键弹出整组菜单', !!bmenu && bmenu.heads.includes('类型'), JSON.stringify(bmenu && bmenu.heads));
ok('菜单里有「删除 3 块」', !!bmenu && bmenu.labels.some((l) => /删除 3 块/.test(l)),
  JSON.stringify(bmenu && bmenu.labels));
ok('菜单里有「复制为 Markdown」', !!bmenu && bmenu.labels.some((l) => /复制为 Markdown/.test(l)),
  JSON.stringify(bmenu && bmenu.labels));

/* 整组转类型：三块一起变 h2，且转换后仍是选中态 */
await ev(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu button')].find((x) => x.textContent.trim() === '标题 2');
  if (b) b.click();
  return !!b;
})()`);
await sleep(320);
ok('整组转成标题 2', await ev(`(() => {
  const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
  return bs.length === 3 && bs.every((b) => b.dataset.type === 'h2');
})()`), await ev(`[...document.querySelectorAll('.wysiwyg > .w-block')].map((b) => b.dataset.type).join(',')`));
ok('转换后仍然选中（可以接着操作）', (await selCount()) === 3, String(await selCount()));

await pressKey('Escape');
await sleep(180);
ok('Esc 退出选择模式', await ev(`!document.querySelector('.edit-wrap').classList.contains('w-selmode')`));
ok('退出后提示条收起', await ev(`(() => {
  const h = document.querySelector('.w-selhint');
  return !h || h.classList.contains('hidden');
})()`));

/* 非连续多选：Ctrl+点单块加入 / 移出，中间没选的块原地不动。
   提示条必须把两个手势都写出来 —— 没有多选框，用户不知道还能怎么加第二块。
   整组上下移在非连续上没有自洽落点，菜单里要置灰。 */
await openDoc('sel2.md', '甲\n\n乙\n\n丙\n\n丁\n');
const d0 = await gripAt(0);
if (d0) { await ctrlClickAt(d0.x, d0.y); await sleep(200); }
const hintOne = await ev(`(document.querySelector('.w-selhint') || {}).textContent || ''`);
ok('提示条写了怎么选（点块扩选 / Ctrl+点加选）',
  /点块扩选/.test(hintOne) && /Ctrl\+点加选/.test(hintOne), hintOne);

const d2 = await nthBlock(2);
if (d2) { await ctrlClickAt(d2.x, d2.y); await sleep(220); }
const dsel = await ev(`(() => {
  const ed = window.__snp.editor;
  const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
  return {
    sel: bs.filter((b) => b.classList.contains('w-sel')).map((b) => b.textContent),
    contiguous: ed.isContiguousSelection(),
    hint: (document.querySelector('.w-selhint') || {}).textContent || '',
  };
})()`);
ok('Ctrl+点正文加选第二块，跳过中间那块',
  dsel.sel.join(',') === '甲,丙' && dsel.contiguous === false, JSON.stringify(dsel));
ok('非连续也照样报「已选 2 块」', /已选 2 块/.test(dsel.hint), dsel.hint);

await ev(`(() => {
  const b = document.querySelectorAll('.wysiwyg > .w-block')[2];
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 6,
  }));
  return true;
})()`);
await sleep(200);
const dmv = await ev(`(() => {
  const m = document.querySelector('.ctx-menu');
  if (!m) return null;
  const pick = (s) => [...m.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(s));
  const up = pick('上移'), down = pick('下移');
  return { up: up ? up.disabled : null, down: down ? down.disabled : null };
})()`);
ok('非连续时上移 / 下移置灰（差的那几块没有「挪一格」的落点）',
  !!dmv && dmv.up === true && dmv.down === true, JSON.stringify(dmv));
await pressKey('Escape');
await sleep(160);

/* 复制为 Markdown：列表项必须带上 `- ` / `1. ` 标记 —— 用 blockMarkdownText
   拼的话只有块内文本，粘到别的编辑器里就是一堆裸段落 */
await openDoc('copymd.md', '## 标题\n\n- 甲\n- 乙\n\n正文\n');
const cpList = await ev(`(() => {
  const ed = window.__snp.editor;
  const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
  ed.selectBlock(bs[1]);
  ed.selectBlock(bs[2], { additive: true });
  return ed.selectionMarkdown();
})()`);
ok('复制为 Markdown：列表项带 - 标记', cpList === '- 甲\n- 乙', JSON.stringify(cpList));
const cpMix = await ev(`(() => {
  const ed = window.__snp.editor;
  const bs = [...document.querySelectorAll('.wysiwyg > .w-block')];
  ed.selectBlock(bs[0]);
  ed.selectBlock(bs[1], { additive: true });
  return ed.selectionMarkdown();
})()`);
ok('复制为 Markdown：标题与列表之间空一行', cpMix === '## 标题\n\n- 甲', JSON.stringify(cpMix));
await ev('window.__snp.editor.clearBlockSel()');

/* 内置使用手册：帮助菜单能进、只读预览、关不掉。
   「首次开机自动打开」那条在离线不变量里验（真机这一次跑时 manualSeen 早已置位）。 */
await ev(`window.__snp.commands.manual()`);
await sleep(420);
const man = await ev(`(() => {
  const t = window.__snp.getActiveTab();
  return {
    builtin: t ? t.builtin : null,
    mode: t ? t.mode : null,
    name: t ? t.name : null,
    dirty: t ? t.content !== t.savedContent : null,
    body: !!document.querySelector('#wyPreview .md-body, #preview .md-body, #preview .preview-body'),
    chars: t ? (t.content || '').length : 0,
  };
})()`);
ok('帮助菜单能打开内置手册', man.builtin === 'manual' && /使用手册/.test(man.name || ''), JSON.stringify(man));
ok('手册以预览模式打开且不脏（没有可保存的东西）', man.mode === 'preview' && man.dirty === false,
  JSON.stringify({ mode: man.mode, dirty: man.dirty }));
ok('手册正文不是空壳', man.chars > 600, String(man.chars));

/* 手册标签上**根本不画关闭键**：它关不掉，摆一个按了只弹提示的 × 是骗人。
   中键与 Ctrl+W 都会落到 closeTab，一并验一遍。 */
ok('手册标签上没有关闭键', await ev(`(() => {
  const man = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === '使用手册.md');
  return !!man && !man.querySelector('.tab-close') && !!man.querySelector('.tab-builtin');
})()`));

await ev(`(() => {
  const man = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === '使用手册.md');
  if (!man) return false;
  man.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  return true;
})()`);
await sleep(320);
const manStill = await ev(`(() => {
  const t = window.__snp.getActiveTab();
  return t ? t.builtin : null;
})()`);
ok('中键点手册标签也关不掉', manStill === 'manual', String(manStill));

/* 命令面板拿当前文档的标题做过滤，上面的用例已经把文档换成 sel.md 了 —— 切回来 */
await openDoc('fold.md', '# 标题一\n\n正文甲\n\n## 标题二\n\n正文乙\n');

/* 命令面板：一次输入框里同时找得到「文件 / 标题 / 命令」 */
await ev('window.__snp.commands.palette()');
await sleep(260);
const palInfo = await ev(`(() => {
  const box = document.querySelector('.palette');
  if (!box) return null;
  return {
    heads: [...box.querySelectorAll('.palette-head')].map((h) => h.textContent),
    kinds: [...new Set([...box.querySelectorAll('.palette-item')].map((r) => r.dataset.kind))],
    items: box.querySelectorAll('.palette-item').length,
  };
})()`);
ok('命令面板打开并分了三组', !!palInfo && palInfo.heads.length >= 3, JSON.stringify(palInfo));
ok('…三组分别是文件 / 标题 / 命令',
  !!palInfo && ['file', 'head', 'cmd'].every((k) => palInfo.kinds.includes(k)), JSON.stringify(palInfo?.kinds));

/* 输入标题关键词：过滤结果里第一条必须是标题，且能真的跳过去 */
await ev(`(() => {
  const i = document.querySelector('.palette-input');
  i.value = '标题二';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(180);
const palFirst = await ev(`(() => {
  const r = document.querySelector('.palette-item.on');
  return r ? { kind: r.dataset.kind, label: r.querySelector('.p-label').textContent } : null;
})()`);
ok('输入标题名第一条就是那个标题', palFirst?.kind === 'head' && palFirst.label === '标题二', JSON.stringify(palFirst));
await ev(`(() => {
  const i = document.querySelector('.palette-input');
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(320);
ok('回车跳到那一节，面板关掉', await ev(`!document.querySelector('.palette')`));

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
