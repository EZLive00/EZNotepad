// ============================================================
// test/run-menu.mjs —— 菜单渲染的回归断言
//
// appmenu.js 支持了 head / row / note / hidden / icon 之后渲染分支变多，
// 光靠截图看不出「键盘能不能走」「图标名有没有写错」，所以这里查 DOM。
//
// 全部断言跑在同一个页面里（点菜单按钮切菜单），因为本机连续 spawn
// 多个 headless Chrome 时，第二个常常 15 秒内连不上调试端口。
//
// 用法：node test/run-menu.mjs        （THEME=dark 可换主题）
// ============================================================
import { runPage } from './harness.mjs';

const THEME = process.env.THEME || 'light';
const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass, extra });

// 本机连续 spawn headless Chrome 时，紧挨着的下一次有概率在 15 秒内连不上
// 调试端口（上一个进程刚被杀、还没完全退干净）。换端口重试一次即可。
async function boot(opt, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await runPage({ ...opt, port: opt.port + i, cdpPort: opt.cdpPort + i });
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

const { ev, close } = await boot({
  page: `/test/menu-preview.html?theme=${THEME}&menu=format`,
  theme: THEME,
  port: 8861,
  cdpPort: 9501,
  width: 520,
  height: 760,
});

const count = (sel) => ev(`document.querySelectorAll('.appmenu ${sel}').length`);
const text = (sel) => ev(`document.querySelector('.appmenu ${sel}')?.textContent.trim()`);
// 菜单栏顺序：文件 编辑 格式 插入 视图 工具 帮助 —— 格式是 2，插入是 3
const openMenu = (i) => ev(`document.querySelectorAll('#menubar .am-btn')[${i}].click()`);

try {
  // ---- 格式菜单 ----
  ok('分组小标题 3 个', (await count('.am-head')) === 3);
  ok('标题级别横排 4 个', (await count('.am-row .am-pill')) === 4);
  ok('当前级别只有一个选中', (await count('.am-pill.on')) === 1);
  ok('选中的是 H2', (await text('.am-pill.on')) === 'H2');
  ok('普通项 11 个', (await count('.am-item')) === 11);

  const slots = await ev(`(() => {
    const items = [...document.querySelectorAll('.appmenu .am-item')];
    return { all: items.length, withIcon: items.filter(b => b.querySelector('.am-slot .ico')).length };
  })()`);
  ok('每一项都有图标位', slots.all === slots.withIcon, `${slots.withIcon}/${slots.all}`);

  // 图标名写错时 <use> 指不到 symbol，会渲染成空白 —— 最容易漏的低级错
  const missing = await ev(`(() => {
    const have = new Set([...document.querySelectorAll('.icon-sprite symbol')].map(s => s.id));
    return [...document.querySelectorAll('.appmenu use')]
      .map(u => (u.getAttribute('href') || '').slice(1))
      .filter(id => !have.has(id));
  })()`);
  ok('图标全部能在精灵图里找到', missing.length === 0, missing.join(','));

  // 键盘：ArrowDown 应该把热态落到第一个可点项上
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  ok('ArrowDown 落到第一个按钮', (await ev(`document.querySelectorAll('.appmenu .hot').length`)) === 1);
  ok('热态是「正文」', (await text('.hot')) === '正文');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  ok('再按一次移到下一项', (await text('.hot')) === 'H1');

  // 点击真的派发命令 id，并且菜单自己关掉
  await ev(`[...document.querySelectorAll('.appmenu .am-item')].find(b => b.textContent.includes('加粗')).click()`);
  ok('点击派发命令 id', (await ev(`JSON.stringify(window.__calls || [])`)) === '["bold"]');
  ok('点完菜单关闭', (await ev(`document.querySelector('.appmenu').hidden`)) === true);

  // ---- 文件菜单：最近打开是动态渲染的 ----
  await ev(`window.__calls = []; window.__itemsCalls = 0`);
  await openMenu(0);
  const heads = await ev(`[...document.querySelectorAll('.appmenu .am-head')].map(h => h.textContent).join('|')`);
  ok('文件菜单有「最近打开」分组', heads.includes('最近打开'), heads);
  ok('最近打开 3 条', (await ev(`document.querySelectorAll('.appmenu .am-item[title]').length`)) === 3);
  const w = await ev(`Math.round(document.querySelector('.appmenu').getBoundingClientRect().width)`);
  ok('长文件名不会把菜单撑宽', w <= 420, w + 'px');

  await ev(`[...document.querySelectorAll('.appmenu .am-item')].find(b => b.textContent.includes('读书笔记')).click()`);
  ok('点击最近项走 action', (await ev(`JSON.stringify(window.__calls)`)) === '["recent:读书笔记.md"]');
  ok('点完菜单关闭（文件）', await ev(`document.querySelector('.appmenu').hidden`));

  const before = await ev(`window.__itemsCalls`);
  await openMenu(0);
  const after = await ev(`window.__itemsCalls`);
  ok('items 函数每次展开都重新求值', after === before + 1, `${before} → ${after}`);

  // ---- 插入菜单：不在表格里 ----
  await openMenu(3);
  ok('插入菜单 7 项', (await count('.am-item')) === 7);
  ok('插入菜单无分组小标题', (await count('.am-head')) === 0);
  ok('不在表格里时不显示提示', (await count('.am-note')) === 0);

  // ---- 插入菜单：光标在表格里 ----
  await ev(`window.__inTable = true`);
  await openMenu(2);
  await openMenu(3);          // 关掉再开，让 hidden 重新求值
  ok('表格内出现提示', (await count('.am-note')) === 1);
  ok('提示说明去右键', (await text('.am-note')).includes('右键'));

  // ---- 设置：动作型顶级项（没有下拉，点一下直接执行）----
  await ev(`window.__calls = []`);
  await openMenu(6);
  ok('设置不弹菜单面板', await ev(`document.querySelector('.appmenu').hidden`));
  ok('设置点击直接派发命令', (await ev(`JSON.stringify(window.__calls)`)) === '["settings"]');

  // 左右换菜单要跳过它，否则键盘会停在「没有面板」的项上，看起来像卡住
  await openMenu(5);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  ok('左右切换跳过「设置」',
    (await ev(`document.querySelectorAll('#menubar .am-btn')[7].classList.contains('open')`)) === true);

  // ---- 长菜单不会顶出窗口 ----
  const fits = await ev(`(() => {
    const p = document.querySelector('.appmenu');
    const r = p.getBoundingClientRect();
    return r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
  })()`);
  ok('菜单完整落在窗口内', fits === true);
} finally {
  close();
}

let bad = 0;
for (const r of out) {
  if (!r.pass) bad++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
}
console.log(`\n${out.length - bad}/${out.length} 通过（主题 ${THEME}）`);
process.exit(bad ? 1 : 0);
