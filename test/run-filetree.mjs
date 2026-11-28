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

  // ---- 定位当前文件（reveal） ----
  /* 树是懒加载 + 折叠的：目标在三层下面，必须一路展开才能找到那一行。
     断言认「返回码 + 行真的在 DOM 里 + 闪了 + 点亮了」，不认像素。 */
  const revealState = (p) => ev(`(async () => {
    const r = await window.__tree.reveal(${JSON.stringify(p)});
    const row = [...document.querySelectorAll('.ft-row')]
      .find((x) => x.dataset.path === ${JSON.stringify(p)}) || null;
    return { code: r, row: !!row, flash: !!(row && row.classList.contains('ft-flash')),
      active: !!(row && row.classList.contains('active')) };
  })()`);

  const rv1 = await revealState('C:/demo/assets/deep/deep.md');
  ok('reveal 会一路展开到深层文件', rv1.code === 'revealed' && rv1.row, JSON.stringify(rv1));
  ok('reveal 之后那一行是点亮的', rv1.active, JSON.stringify(rv1));
  ok('reveal 之后那一行会闪', rv1.flash, JSON.stringify(rv1));

  const rv2 = await revealState('C:/demo/assets/deep/deep.md');
  ok('已经就在眼前时返回 already，但照样闪', rv2.code === 'already' && rv2.flash, JSON.stringify(rv2));

  const rv3 = await revealState('C:/other/x.md');
  ok('不在根目录下返回 outside', rv3.code === 'outside', JSON.stringify(rv3));

  const rv4 = await revealState('C:/demo/ghost.md');
  ok('根目录下但树里没有这一行返回 gone', rv4.code === 'gone', JSON.stringify(rv4));

  /* 收回到「只展开根」：根现在是分组行，expanded 清空会把整棵（含根）收起来，
     后面的右键 / 新建用例就找不到任何行了 */
  await ev(`(async () => {
    window.__tree.expanded.clear();
    for (const r of window.__tree.roots) window.__tree.expanded.add(r);
    await window.__tree.render();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 120));

  // ---- 右键菜单 ----
  ok('右键文件弹菜单', await rightClick('笔记.md'));
  const fileMenu = await labels();
  ok('文件菜单有重命名 / 删除', fileMenu.includes('重命名…') && fileMenu.includes('删除'), fileMenu.join(' | '));
  ok('文件菜单没有「新建文件」', !fileMenu.includes('新建文件…'), fileMenu.join(' | '));

  ok('右键目录弹菜单', await rightClick('assets'));
  const dirMenu = await labels();
  ok('目录菜单多出两个新建项', dirMenu.includes('新建文件…') && dirMenu.includes('新建文件夹…'), dirMenu.join(' | '));

  // ---- 行右键「复制文件路径」：路径对、提示真、目录也支持 ----
  /* 预览页没有系统剪贴板权限，这里只拦 execCommand 记录「离屏 textarea 里
     写了什么」，真实调用照常发生（结果由 __copyOk 控制，用来走失败分支）。 */
  await ev(`(() => {
    window.__copied = [];
    window.__copyOk = true;
    const orig = document.execCommand.bind(document);
    document.execCommand = (cmd) => {
      if (cmd === 'copy') {
        window.__copied.push(document.activeElement && document.activeElement.value);
        return window.__copyOk;
      }
      return orig(cmd);
    };
    return 1;
  })()`);
  ok('文件菜单有「复制文件路径」', fileMenu.includes('复制文件路径'), fileMenu.join(' | '));
  ok('复制路径紧挨在「在资源管理器中显示」之前',
    fileMenu.indexOf('复制文件路径') === fileMenu.indexOf('在资源管理器中显示') - 1, fileMenu.join(' | '));
  ok('目录菜单也给了复制路径', dirMenu.includes('复制文件路径'), dirMenu.join(' | '));

  // ---- 行右键「在此处打开终端」：文件给所在目录，目录给自己 ----
  ok('文件菜单有「在此处打开终端」', fileMenu.includes('在此处打开终端'), fileMenu.join(' | '));
  ok('目录菜单也有「在此处打开终端」', dirMenu.includes('在此处打开终端'), dirMenu.join(' | '));
  await ev(`window.__termDirs.length = 0; 1`);
  await rightClick('笔记.md');
  ok('点它能执行', await pick('在此处打开终端'));
  const fileDir = await ev(`window.__termDirs.slice()`);
  ok('文件传下去的是它所在的目录（不是文件自己的路径）',
    fileDir.length === 1 && fileDir[0] === 'C:/demo', JSON.stringify(fileDir));
  await rightClick('assets');
  await pick('在此处打开终端');
  const dirDir = await ev(`window.__termDirs.slice(-1)[0]`);
  ok('目录传下去的是它自己', dirDir === 'C:/demo/assets', JSON.stringify(dirDir));

  await rightClick('笔记.md');
  ok('点复制路径能执行', await pick('复制文件路径'));
  const copied = await ev(`window.__copied`);
  ok('复制的是被右键那一行的完整路径',
    copied.length === 1 && copied[0] === 'C:/demo/笔记.md', JSON.stringify(copied));
  const lastToast = await ev(`window.__calls.filter(c => c[0] === 'toast').pop()`);
  ok('复制成功才提示「路径已复制」', lastToast && lastToast[1] === '路径已复制', JSON.stringify(lastToast));

  await ev(`window.__copyOk = false; 1`);
  await rightClick('笔记.md');
  await pick('复制文件路径');
  const failToast = await ev(`window.__calls.filter(c => c[0] === 'toast').pop()`);
  ok('复制失败时说「无法复制路径」，不假装成功',
    failToast && failToast[1] === '无法复制路径', JSON.stringify(failToast));
  await ev(`window.__copyOk = true; 1`);

  await rightClick('assets');
  await pick('复制文件路径');
  const dirCopied = await ev(`window.__copied.slice(-1)[0]`);
  ok('右键目录复制的是目录自己的路径', dirCopied === 'C:/demo/assets', JSON.stringify(dirCopied));

  // ---- 多选 + 右键比较 ----
  const clickRow = (name, mod) => ev(`(() => {
    const row = [...document.querySelectorAll('.ft-row')].find(r => r.querySelector('.ft-name').textContent === ${JSON.stringify(name)});
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      ctrlKey: ${mod === 'ctrl'},
      shiftKey: ${mod === 'shift'},
    }));
    return true;
  })()`);
  const selNames = () => ev(`[...document.querySelectorAll('.ft-row.sel')].map(r => r.querySelector('.ft-name').textContent)`);

  /* 先用普通点击落成单选 —— 前面的右键检查也会顺手选中一行，
     直接从 Ctrl 点击开始会把它取消掉，测出来的就不是多选了 */
  await clickRow('笔记.md');
  await ev(`window.__opened.length = 0`);
  ok('Ctrl 点击文件只选中，不打开', await clickRow('日志.txt', 'ctrl'));
  ok('Ctrl 点击没有触发打开', (await ev(`window.__opened.length`)) === 0, JSON.stringify(await ev(`window.__opened`)));
  ok('Ctrl 点击加上第二个文件后两个都选中', (await selNames()).length === 2, (await selNames()).join(','));

  await rightClick('日志.txt');
  const twoMenu = await labels();
  ok('选中两个文件后右键出现「比较这两个文件」', twoMenu.includes('比较这两个文件'), twoMenu.join(' | '));
  ok('点「比较」把两个路径交出去', await pick('比较这两个文件'));
  const cmp = await ev(`window.__compared`);
  ok('比较参数是右键的那个文件 + 另一个',
    JSON.stringify(cmp) === JSON.stringify([['C:/demo/日志.txt', 'C:/demo/笔记.md']]), JSON.stringify(cmp));

  await clickRow('笔记.md');
  ok('普通点击只选一个并照旧打开', (await selNames()).join(',') === '笔记.md'
    && (await ev(`window.__opened`) ).includes('C:/demo/笔记.md'), (await selNames()).join(','));

  ok('Shift 点击选一段', await clickRow('日志.txt', 'shift'));
  ok('Shift 选中的是两行文件', (await selNames()).length === 2, (await selNames()).join(','));

  await clickRow('笔记.md');          // 收回到单选，再验证菜单里没有比较项
  await rightClick('笔记.md');
  const singleMenu = await labels();
  ok('只选一个文件时没有比较项', !singleMenu.includes('比较这两个文件'), singleMenu.join(' | '));

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
  /* 上一步是「在 assets 下新建文件」，建完会把父目录展开 —— 否则新文件只出现在
     标签栏、树里找不到。所以此刻它已经是展开态，再点一下才是收起。 */
  ok('新建文件后父目录自动展开', (await rows()).includes('a.png'), (await rows()).join(','));
  await ev(`[...document.querySelectorAll('.ft-row.dir')][0].click()`);
  await new Promise((r) => setTimeout(r, 120));
  ok('点一下收起，子项消失', !(await rows()).includes('a.png'), (await rows()).join(','));
  await ev(`[...document.querySelectorAll('.ft-row.dir')][0].click()`);
  await new Promise((r) => setTimeout(r, 120));
  ok('再点一下又能看到子项', (await rows()).includes('a.png'), (await rows()).join(','));

  // ---- 文件夹右侧的「＋」：只在新（删仍然只走右键） ----
  const plus = await ev(`(() => {
    const all = [...document.querySelectorAll('.ft-row')];
    return {
      dirs: all.filter((r) => r.classList.contains('dir')).length,
      adds: document.querySelectorAll('.ft-add').length,
      onFile: !!document.querySelector('.ft-row:not(.dir) .ft-add'),
    };
  })()`);
  ok('每个文件夹都有「＋」，文件行没有', plus.adds === plus.dirs && plus.adds > 0 && !plus.onFile, JSON.stringify(plus));

  await ev(`document.querySelector('.ft-row.dir .ft-add').click()`);
  await new Promise((r) => setTimeout(r, 120));
  const addLabels = (await labels()).filter(Boolean);
  ok('「＋」菜单只有新建两项，没有删除',
    addLabels.length === 2 && addLabels[0].startsWith('新建') && !addLabels.some((l) => /删除/.test(l)),
    addLabels.join(' | '));
  ok('点「＋」不会顺手把文件夹收起', (await rows()).includes('a.png'), (await rows()).join(','));

  // 展开后再新建，只重画这一层：目录仍然是展开的（整棵树重来会收起）
  await ev(`window.__nextName = 'b.png'`);
  await rightClick('assets');
  await pick('新建文件…');
  await new Promise((r) => setTimeout(r, 150));
  ok('局部刷新后仍在展开状态', (await rows()).includes('a.png'), (await rows()).join(','));

  // ---- 空白处右键 = 与具体根无关的两件事 ----
  /* 多根之后「对根目录操作」没有唯一答案（空白算哪个根的？），
     所以这里只剩添加 / 刷新；「在某个根里新建」回到那个根自己的行上 */
  await ev(`document.getElementById('ftBody').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 300 }))`);
  const rootMenu = await labels();
  ok('空白处右键给「添加文件夹 / 刷新」', rootMenu.includes('添加文件夹…') && rootMenu.includes('刷新'), rootMenu.join(' | '));
  ok('空白处右键不再猜「哪个根」（没有新建项）', !rootMenu.includes('新建文件…'), rootMenu.join(' | '));

  // ---- 根行右键：和普通目录行一样能「出去」 ----
  /* 根行也是一个真实目录，复制路径 / 在资源管理器中显示 / 开终端这三件事
     以前只给了子目录行，想复制根自己的路径反而要绕一圈 */
  await ev(`document.querySelector('.ft-root').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 }))`);
  const rootRowMenu = await labels();
  ok('根行右键有「复制文件路径 / 在资源管理器中显示」',
    rootRowMenu.includes('复制文件路径') && rootRowMenu.includes('在资源管理器中显示'),
    rootRowMenu.join(' | '));
  ok('根行右键有「在此处打开终端」', rootRowMenu.includes('在此处打开终端'), rootRowMenu.join(' | '));
  await ev(`window.__termDirs.length = 0; window.__copied = []; 1`);
  await pick('在此处打开终端');
  const rootTerm = await ev(`window.__termDirs.slice()`);
  ok('根行开终端进的是根自己', JSON.stringify(rootTerm) === JSON.stringify(['C:/demo']), JSON.stringify(rootTerm));
  await ev(`document.querySelector('.ft-root').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20 }))`);
  await pick('复制文件路径');
  const rootCopied = await ev(`window.__copied.slice(-1)[0]`);
  ok('根行复制的是根自己的路径', rootCopied === 'C:/demo', JSON.stringify(rootCopied));

  // ---- 多根：一个侧栏同时挂两个目录 ----
  await ev(`window.__tree.addRoot('C:/work')`);
  await new Promise((r) => setTimeout(r, 180));
  const multi = await ev(`(() => ({
    roots: [...document.querySelectorAll('.ft-root')].map((r) => r.querySelector('.ft-name').textContent),
    rows: [...document.querySelectorAll('.ft-row')].map((r) => r.querySelector('.ft-name').textContent),
    saved: window.__roots,
  }))()`);
  ok('两个根各占一行分组标题', JSON.stringify(multi.roots) === JSON.stringify(['demo', 'work']), JSON.stringify(multi.roots));
  ok('新加的根默认展开，两边的东西都在', multi.rows.includes('改名后.md') && multi.rows.includes('业务.md'), multi.rows.join(','));
  ok('根列表变了会通知外面存盘',
    JSON.stringify(multi.saved) === JSON.stringify(['C:/demo', 'C:/work']), JSON.stringify(multi.saved));

  await ev(`document.querySelectorAll('.ft-root')[0].click()`);
  await new Promise((r) => setTimeout(r, 140));
  const folded = await ev(`[...document.querySelectorAll('.ft-row')].map((r) => r.querySelector('.ft-name').textContent)`);
  ok('折叠一个根只收它自己，另一个根不动', !folded.includes('笔记.md') && folded.includes('业务.md'), folded.join(','));
  await ev(`document.querySelectorAll('.ft-root')[0].click()`);
  await new Promise((r) => setTimeout(r, 140));

  // ---- 缩进层级：重画之后不能变平 ----
  /* 踩过的坑：层数原来是读 `row.style.paddingLeft` 反推的，可根行的 6px 写在 CSS
     的 `padding: 0 6px` 里、内联是空串 → `parseInt('')` 得 NaN → 根下面整层算成
     `"NaNpx"`（无效值，浏览器忽略）→ 一刷新整棵树变平，折叠再展开才回来。
     层数从路径就能算，不该反过来问 DOM。 */
  const indents = () => ev(`[...document.querySelectorAll('.ft-root, .ft-row')].map((r) => ({
    name: r.querySelector('.ft-name').textContent,
    pad: getComputedStyle(r).paddingLeft,
  }))`);
  const padOf = (list, name) => (list.find((x) => x.name === name) || {}).pad;

  await ev(`(async () => {
    window.__tree.expanded.clear();
    for (const r of window.__tree.roots) window.__tree.expanded.add(r);
    await window.__tree.render();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 160));
  const lvl1 = await indents();
  ok('整棵树重画之后，根下面仍是 18px 缩进',
    padOf(lvl1, 'demo') === '6px' && padOf(lvl1, '改名后.md') === '18px' && padOf(lvl1, 'assets') === '18px',
    JSON.stringify(lvl1));

  await ev(`(async () => {
    const byName = (n) => [...document.querySelectorAll('.ft-row')].find((r) => r.querySelector('.ft-name').textContent === n);
    byName('assets').click();
    await new Promise((r) => setTimeout(r, 160));
    byName('deep').click();
    await new Promise((r) => setTimeout(r, 160));
  })()`);
  const lvl3 = await indents();
  ok('展开两层后按层递进 18 / 30 / 42',
    padOf(lvl3, 'assets') === '18px' && padOf(lvl3, 'deep') === '30px' && padOf(lvl3, 'deep.md') === '42px',
    JSON.stringify(lvl3));

  await ev(`window.__tree.render()`);
  await new Promise((r) => setTimeout(r, 200));
  const afterRender = await indents();
  ok('刷新（整棵树重画）之后缩进不丢，三层都还在原位',
    padOf(afterRender, 'deep') === '30px' && padOf(afterRender, 'deep.md') === '42px',
    JSON.stringify(afterRender));

  await ev(`window.__tree._reloadDir('C:/demo/assets')`);
  await new Promise((r) => setTimeout(r, 200));
  const afterLocal = await indents();
  ok('局部刷新只重画那一层，孙目录仍开着（42 还在）',
    padOf(afterLocal, 'deep.md') === '42px', JSON.stringify(afterLocal));

  // ---- 同一棵树不叠两个根 ----
  /* 子目录再挂一次会让同一个路径出现两行（`_rowOf` 只认第一行，第二棵的展开
     就落到第一棵的位置上），层数也没法算对 —— 所以直接不让这种状态出现 */
  const nested = await ev(`window.__tree.addRoot('C:/demo/assets')`);
  const rootsNow = await ev(`document.querySelectorAll('.ft-root').length`);
  ok('子目录不会再单独成一个根（它已经在树里）', nested === false && rootsNow === 2, `${nested} / ${rootsNow}`);

  /* 命令行传进来的目录可能是 `D:/work`，后端读出来却是 `D:\work\a.md`。
     只按字面比前缀会把同一棵树判成两棵：缩进全平、定位说「不在里面」。 */
  const mixed = await ev(`({
    depth: window.__tree._depthOfPath('C:\\\\demo\\\\assets'),
    root: window.__tree.rootOf('C:\\\\demo\\\\x.md'),
  })`);
  ok('反斜杠写法也算在同一棵树里', mixed.depth === 1 && mixed.root === 'C:/demo', JSON.stringify(mixed));

  await ev(`window.__tree.search('笔记')`);
  await new Promise((r) => setTimeout(r, 220));
  const hits = await ev(`(() => ({
    files: [...document.querySelectorAll('.ft-hit-file .ft-name')].map((n) => n.textContent),
    tags: [...document.querySelectorAll('.ft-hit-file .ft-root-tag')].map((n) => n.textContent),
  }))()`);
  ok('搜索会跑遍所有根', hits.files.length === 2, JSON.stringify(hits.files));
  ok('多根时每条命中标出所属根', hits.tags.join(',') === 'demo,work', hits.tags.join(','));

  const rv = await ev(`window.__tree.reveal('C:/work/notes/客户.md')`);
  ok('第二个根下的文件也能定位到', rv === 'revealed', String(rv));

  await ev(`window.__tree.removeRoot('C:/work')`);
  await new Promise((r) => setTimeout(r, 180));
  const afterRemove = await ev(`(() => ({
    roots: document.querySelectorAll('.ft-root').length,
    rows: [...document.querySelectorAll('.ft-row')].map((r) => r.querySelector('.ft-name').textContent),
    saved: window.__roots,
  }))()`);
  ok('移除根只留另一棵', afterRemove.roots === 1 && afterRemove.rows.includes('改名后.md'), JSON.stringify(afterRemove));
  ok('移除后根列表也同步出去',
    JSON.stringify(afterRemove.saved) === JSON.stringify(['C:/demo']), JSON.stringify(afterRemove.saved));

  // ---- 拖动移动 ----
  /* 拖动是 pointer 实现的：HTML5 拖放在 Windows 的 WebView2 里**一个事件都收不到**
     （Tauri 的 dragDropEnabled 把整窗口的拖放交给 OS，见 filetree.js 的 _dragDown）。
     这里按真实顺序派发 pointerdown → pointermove → pointerup，落点靠 elementFromPoint
     判，所以行必须真的可见、坐标必须真的对得上。 */
  await ev(`(async () => {
    await window.__tree.setRoots(['C:/demo']);
    window.__tree.expanded.clear();
    for (const r of window.__tree.roots) window.__tree.expanded.add(r);
    window.__tree.expanded.add('C:/demo/assets');
    await window.__tree.render();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 220));

  const dragTo = (fromName, toName) => ev(`(() => {
    const byName = (n) => [...document.querySelectorAll('.ft-row')]
      .find((r) => r.querySelector('.ft-name').textContent === n);
    const from = byName(${JSON.stringify(fromName)});
    const to = [...document.querySelectorAll('.ft-row.dir, .ft-root')]
      .find((r) => r.querySelector('.ft-name').textContent === ${JSON.stringify(toName)});
    if (!from || !to) return { err: 'row missing' };
    const pe = (type, x, y, extra = {}) => new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', ...extra,
    });
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x0 = a.left + 20, y0 = a.top + a.height / 2;
    const x1 = b.left + 20, y1 = b.top + b.height / 2;
    const openedBefore = window.__opened.length;
    from.dispatchEvent(pe('pointerdown', x0, y0));
    document.dispatchEvent(pe('pointermove', x0 + 8, y0 + 6));
    document.dispatchEvent(pe('pointermove', x1, y1));
    const chip = !!document.querySelector('.ft-drag-chip');
    const marked = [...document.querySelectorAll('.ft-drop')].map((r) => r.querySelector('.ft-name').textContent);
    const blocked = [...document.querySelectorAll('.ft-drop-no')].map((r) => r.querySelector('.ft-name').textContent);
    document.dispatchEvent(pe('pointerup', x1, y1, { buttons: 0 }));
    /* 松手之后浏览器会补一个 click：不拦住就会顺手打开源文件 */
    from.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { chip, marked, blocked, opened: window.__opened.length - openedBefore };
  })()`);

  // 1）往子目录里拖：高亮、真调用、提示、树里换位置
  await ev(`window.__calls.length = 0; window.__renamed.length = 0; 1`);
  const dropOk = await dragTo('改名后.md', 'assets');
  ok('拖动时指针旁跟着一个名字小签', dropOk.chip === true, JSON.stringify(dropOk));
  ok('合法落点高亮在目标目录上', JSON.stringify(dropOk.marked) === JSON.stringify(['assets']), JSON.stringify(dropOk));
  ok('拖完那一下不顺手打开源文件', dropOk.opened === 0, JSON.stringify(dropOk));
  await new Promise((r) => setTimeout(r, 300));
  const moveCall = await ev(`window.__calls.filter((c) => c[0] === 'move').slice(-1)[0]`);
  ok('拖动真的调了后端移动（源 → 目标目录）',
    JSON.stringify(moveCall) === JSON.stringify(['move', 'C:/demo/改名后.md', 'C:/demo/assets']),
    JSON.stringify(moveCall));
  const moveToast = await ev(`window.__calls.filter((c) => c[0] === 'toast').slice(-1)[0]`);
  ok('移动成功给出「已移动」', moveToast && moveToast[1] === '已移动', JSON.stringify(moveToast));
  const movedTag = await ev(`window.__renamed.slice(-1)[0]`);
  ok('打开着的标签跟着换路径（onRenamed 第三参表示是不是目录）',
    JSON.stringify(movedTag) === JSON.stringify(['C:/demo/改名后.md', 'C:/demo/assets/改名后.md', false]),
    JSON.stringify(movedTag));
  const afterMove = await ev(`(() => {
    const rows = [...document.querySelectorAll('.ft-row')];
    const hits = rows.filter((r) => r.querySelector('.ft-name').textContent === '改名后.md');
    /* 归谁管看它挂在哪个 .ft-kids 里，不看扁平列表的下一个 —— 兄弟容器的顺序
       会把同层的所有行连成一片 */
    const head = hits.length === 1 && hits[0].parentElement.classList.contains('ft-kids')
      ? hits[0].parentElement.previousElementSibling : null;
    return { count: hits.length, under: head ? head.querySelector('.ft-name').textContent : '' };
  })()`);
  ok('树里它已经挪到目标目录下面（不是复制出一份）',
    afterMove.count === 1 && afterMove.under === 'assets', JSON.stringify(afterMove));

  // 2）拖进自己的子目录：不许，标红且不出手
  await ev(`window.__calls.length = 0; 1`);
  const bad = await dragTo('assets', 'deep');
  ok('目录拖进自己的子目录会被标红拒绝',
    JSON.stringify(bad.blocked) === JSON.stringify(['deep']) && bad.marked.length === 0, JSON.stringify(bad));
  await new Promise((r) => setTimeout(r, 200));
  ok('拒绝时后端一次都没被调用', (await ev(`window.__calls.filter((c) => c[0] === 'move').length`)) === 0);

  // 3）拖回原来的父目录：标红（这里放不了），松手不做事、不报错
  await ev(`window.__calls.length = 0; 1`);
  const same = await dragTo('deep', 'assets');
  ok('拖回父目录只标红、不给可放置的暗示',
    same.marked.length === 0 && JSON.stringify(same.blocked) === JSON.stringify(['assets']), JSON.stringify(same));
  await new Promise((r) => setTimeout(r, 200));
  ok('拖回原地后端没被调用', (await ev(`window.__calls.filter((c) => c[0] === 'move').length`)) === 0);

  // ---- 一个根都没有：给一个明显的入口 ----
  await ev(`window.__tree.setRoots([])`);
  await new Promise((r) => setTimeout(r, 140));
  const emptyState = await ev(`(() => {
    const b = document.querySelector('.ft-empty-btn');
    return { has: !!b, text: b ? b.textContent : '', added: window.__added.length };
  })()`);
  ok('没有根时给「添加文件夹」按钮', emptyState.has && /添加文件夹/.test(emptyState.text), JSON.stringify(emptyState));
  await ev(`document.querySelector('.ft-empty-btn').click()`);
  ok('点它走的是加文件夹那条路', (await ev(`window.__added.length`)) > emptyState.added);
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
