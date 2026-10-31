// ============================================================
// test/run-filetree.mjs —— 侧栏文件树的回归断言
//
// 树从「只读」变成能新建 / 改名 / 删除之后，右键菜单、局部刷新、
// 以及「改名后要通知外面」这些事光看代码不放心：挂错一个冒泡，
// 表现是点了没反应或者整棵树收起，肉眼很难一眼看出来。
//
// 用法：node test/run-filetree.mjs       （THEME=dark 可换主题）
// ============================================================
import { runPage } from './harness.mjs';

const THEME = process.env.THEME || 'light';
const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass, extra });

async function boot(opt, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await runPage({ ...opt, port: opt.port + i, cdpPort: opt.cdpPort + i });
    } catch (e) {
      last = e;
      console.error('[boot retry]', e.message.split('\n')[0]);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

const { ev, close } = await boot({
  page: `/test/filetree-preview.html?theme=${THEME}`,
  theme: THEME,
  port: 8866,
  cdpPort: 9511,
  width: 560,
  height: 720,
});

const rows = () => ev(`[...document.querySelectorAll('.ft-row')].map(r => r.querySelector('.ft-name').textContent)`);
const rightClick = (name) => ev(`(() => {
  const row = [...document.querySelectorAll('.ft-row')].find(r => r.querySelector('.ft-name').textContent === ${JSON.stringify(name)});
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  return true;
})()`);
const labels = () => ev(`window.__menuItems.map(i => i.label || (i.sep ? '---' : ''))`);
const pick = (label) => ev(`(() => {
  const it = window.__menuItems.find(i => i.label === ${JSON.stringify(label)});
  if (!it) return false;
  it.action();
  return true;
})()`);
const calls = () => ev(`window.__calls`);

try {
  await ev(`window.__ready === true`);
  /* 页面把 __ready 提前点亮了（import 失败也要能报出来），这里等树真的画完 */
  for (let i = 0; i < 40; i++) {
    if ((await ev(`document.querySelectorAll('.ft-row').length`)) > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const bootErr = await ev(`window.__bootError || ''`);
  if (bootErr) throw new Error(String(bootErr));

  // ---- 渲染 ----
  const first = await rows();
  ok('根目录渲染出 3 项', first.length === 3, first.join(','));
  ok('目录在前、文件在后', first[0] === 'assets', first.join(','));
  ok('目录行带 dir 样式', await ev(`document.querySelectorAll('.ft-row.dir').length === 1`));

  // ---- 右键菜单 ----
  ok('右键文件弹菜单', await rightClick('笔记.md'));
  const fileMenu = await labels();
  ok('文件菜单有重命名 / 删除', fileMenu.includes('重命名…') && fileMenu.includes('删除'), fileMenu.join(' | '));
  ok('文件菜单没有「新建文件」', !fileMenu.includes('新建文件…'), fileMenu.join(' | '));

  ok('右键目录弹菜单', await rightClick('assets'));
  const dirMenu = await labels();
  ok('目录菜单多出两个新建项', dirMenu.includes('新建文件…') && dirMenu.includes('新建文件夹…'), dirMenu.join(' | '));

  // ---- 重命名 ----
  await ev(`window.__nextName = '改名后.md'`);
  await rightClick('笔记.md');
  ok('点「重命名…」能触发', await pick('重命名…'));
  await new Promise((r) => setTimeout(r, 120));
  const c1 = await calls();
  const renamed = c1.find((c) => c[0] === 'rename');
  ok('调用了 renameEntry', !!renamed && renamed[1] === 'C:/demo/笔记.md' && renamed[2] === '改名后.md',
    JSON.stringify(renamed));
  ok('改名后通知了外层（标签要跟着改）',
    (await ev(`window.__renamed.length`)) === 1 && (await ev(`window.__renamed[0][1]`)) === 'C:/demo/改名后.md',
    JSON.stringify(await ev(`window.__renamed`)));
  const afterRename = await rows();
  ok('改名后行文字跟着变', afterRename.includes('改名后.md'), afterRename.join(','));

  // ---- 新建文件 ----
  await ev(`window.__nextName = '新笔记.md'`);
  await rightClick('assets');
  ok('点「新建文件…」能触发', await pick('新建文件…'));
  await new Promise((r) => setTimeout(r, 120));
  const c2 = await calls();
  const made = c2.find((c) => c[0] === 'create');
  ok('调用了 createEntry（在 assets 下）', !!made && made[1] === 'C:/demo/assets' && made[2] === '新笔记.md' && made[3] === false,
    JSON.stringify(made));
  ok('新建完自动打开', (await ev(`window.__opened`)).includes('C:/demo/assets/新笔记.md'));

  // ---- 删除：确认框说「不」时不许动手 ----
  await ev(`window.__confirm = false`);
  await rightClick('日志.txt');
  await pick('删除');
  await new Promise((r) => setTimeout(r, 100));
  ok('确认框拒绝就不删除', !(await calls()).some((c) => c[0] === 'delete'));

  await ev(`window.__confirm = true`);
  await rightClick('日志.txt');
  await pick('删除');
  await new Promise((r) => setTimeout(r, 120));
  const c3 = await calls();
  ok('确认后调用了 deleteEntry', c3.some((c) => c[0] === 'delete' && c[1] === 'C:/demo/日志.txt'));
  ok('删除后通知了外层', (await ev(`window.__deleted`))[0] === 'C:/demo/日志.txt');

  // ---- 展开 / 局部刷新 ----
  await ev(`[...document.querySelectorAll('.ft-row.dir')][0].click()`);
  await new Promise((r) => setTimeout(r, 120));
  ok('展开目录能看到子项', (await rows()).includes('a.png'), (await rows()).join(','));

  // 展开后再新建，只重画这一层：目录仍然是展开的（整棵树重来会收起）
  await ev(`window.__nextName = 'b.png'`);
  await rightClick('assets');
  await pick('新建文件…');
  await new Promise((r) => setTimeout(r, 150));
  ok('局部刷新后仍在展开状态', (await rows()).includes('a.png'), (await rows()).join(','));

  // ---- 空白处右键 = 对根目录操作 ----
  await ev(`document.getElementById('ftBody').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 300 }))`);
  const rootMenu = await labels();
  ok('空白处右键给根目录菜单', rootMenu.includes('新建文件…') && rootMenu.includes('刷新'), rootMenu.join(' | '));
} catch (e) {
  ok('执行完成', false, e.message);
} finally {
  await close();
}

let bad = 0;
for (const r of out) {
  if (!r.pass) bad++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
}
console.log(`\n${out.length - bad}/${out.length} 通过（主题 ${THEME}）`);
process.exit(bad ? 1 : 0);
