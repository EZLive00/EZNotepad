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

const { ws, ev, moveTo, dragTo, click } = await connect();

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

/** 段落中心坐标 */
const paraCenter = () => ev(`(() => {
  const b = [...document.querySelectorAll('.w-block')].find((n) => n.dataset.type === 'p');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + 40, y: r.top + r.height / 2, right: r.right, left: r.left };
})()`);
const btnCenter = (id) => ev(`(() => {
  const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);

/** 悬停段落 → 点 + 打开菜单。手柄本身会被 240ms 的空闲逻辑收起，所以重试几轮 */
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

/* ---------- 1.5 驻留：只要不换行，怎么挪都不该消失 ---------- */
const paraRects = await ev(`(() => {
  const ps = [...document.querySelectorAll('.w-block')].filter((n) => n.dataset.type === 'p');
  return ps.slice(0, 2).map((b) => {
    const r = b.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cy: (r.top + r.bottom) / 2 };
  });
})()`);
const handleTop = () => ev(`document.getElementById('wHandle').getBoundingClientRect().top`);
const shown = () => ev(`!document.getElementById('wHandle').classList.contains('hidden')`);
const topAfterFirst = await handleTop();

/* a. 两段之间的空隙：既不属于上一块也不属于下一块 */
const paraGapY = (paraRects[0].bottom + paraRects[1].top) / 2;
await moveTo(paraRects[0].left + 120, paraGapY);
await sleep(320);
ok('鼠标停在两段之间的空隙，手柄没消失', await shown());
ok('…而且还钉在原处（没有被挪到别的行）', Math.abs((await handleTop()) - topAfterFirst) < 2,
  `${Math.round(await handleTop())} vs ${Math.round(topAfterFirst)}`);

/* b. 块的左侧留白（手柄右边、正文左边这一条） */
await moveTo(paraRects[0].left - 52, paraRects[0].cy);
await sleep(320);
ok('鼠标停在正文左侧的留白里，手柄没消失', await shown());

/* c. 移出编辑区（去标题栏） */
await moveTo(300, 8);
await sleep(320);
ok('鼠标离开编辑区，手柄仍留在最后那一行', await shown());

/* d. 真的换到下一段，才跟着挪 */
await moveTo(paraRects[1].left + 120, paraRects[1].cy);
await sleep(320);
const topAfterSecond = await handleTop();
ok('鼠标换到下一段，手柄跟着挪过去', topAfterSecond > topAfterFirst + 5,
  `${Math.round(topAfterSecond)} vs ${Math.round(topAfterFirst)}`);

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
ok('面板每一项都带选择键', keys.length >= 18 && keys.every(Boolean), `${keys.length} 项 / ${JSON.stringify(keys)}`);
ok('选择键互不重复', new Set(keys).size === keys.length);
ok('键位按语义分段（0 正文 / 1-3 标题 / w 警告 / t 表格）',
  keys[0] === '0' && keys[1] === '1' && keys[3] === '3' && keys.includes('w') && keys.includes('t'),
  JSON.stringify(keys));
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
