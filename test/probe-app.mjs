// ============================================================
// test/probe-app.mjs —— 对着真实窗口跑一遍（CDP）
//
// 端口没开就自动拉起应用，跑完随进程退出收掉；已有实例直接复用。
// 这里只放「必须跑在真壳子里」的检查：Tauri 命令、侧栏、设置面板、
// 所见即所得查找、大纲跟随滚动。纯逻辑的部分在 run-units / run.mjs 里。
//
//   node test/probe-app.mjs
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureApp } from './lib/appctl.mjs';

const PORT = process.env.CDP_PORT || 9333;
await ensureApp(PORT);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
/* 比较窗口是独立页面，也会出现在目标列表里（而且常常排在最前面）。
   只按 type === 'page' 抓会把比较窗口当成主窗口，断言全落在错误的页面上 */
const page = list.find((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));
if (!page) { console.error('没有找到页面目标'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
});
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

/* 每条 CDP 求值都带超时：渲染进程卡死 / 崩溃时 `Runtime.evaluate` 永远不回，
   整个探针会静默挂住（实测过一次，日志停在半句上，看不出是哪一条）。
   超时当成一条正常错误抛出去，至少能定位到具体那一步。 */
const EV_TIMEOUT = Number(process.env.EV_TIMEOUT || 20000);
const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    rej(new Error(`CDP 求值超时（${EV_TIMEOUT}ms，渲染进程可能卡死）：${String(expr).replace(/\s+/g, ' ').slice(0, 120)}`));
  }, EV_TIMEOUT);
  pending.set(id, {
    res: (v) => { clearTimeout(timer); res(v); },
    rej: (e) => { clearTimeout(timer); rej(e); },
  });
  ws.send(JSON.stringify({
    id, method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  }));
}).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
  return r.result.value;
});

const out = [];
/* 每条断言**当场**打一行：探针跑到一半卡住 / 崩掉时，末尾那份汇总根本印不出来，
   现场只剩一个空日志。即时输出让它变成「最后一行就是卡住的地方」。 */
const ok = (name, pass, extra = '') => {
  const r = { name, pass: !!pass, extra };
  out.push(r);
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
  return r.pass;
};
const sleep = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
/* 等一个条件成立（上限 timeout）。点击大纲项后编辑区是 smooth 滚动，
   滚多远取决于窗口高度 —— 固定 sleep 迟早碰运气，宁可轮询到点上为止。 */
const waitUntil = async (fn, timeout = 2500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(80);
  }
  return false;
};
const outlineActiveText = () => ev(`document.querySelector('.outline-item.active')?.textContent || null`);
/* 需要真实鼠标事件的断言（右键菜单）走这个：合成事件测不到浏览器默认行为 */
const send = (method, params) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

try {
  /* 先把设置恢复成出厂值再刷新：真机上的 localStorage 是活的，
     上一次手点的「单栏 / 隐藏大纲」会留在这里，让断言看天吃饭 */
  await ev(`(() => {
    localStorage.setItem('snp.settings', JSON.stringify({
      theme: 'light', fontSize: 13.5, layout: 'split', outlineVisible: true,
      showToolbar: true, showWinTitle: true, lastMode: { md: 'edit' },
      lastNewExt: 'md', autoSave: false, folder: '', side: 'outline',
      __v: 4, lang: 'zh-CN'   /* 钉死设置（含语言）：带上当前版本号，跳过 state.js 的默认值迁移 */
    }));
    /* 会话与草稿也要清干净，起点必须是确定的空场。
       探针的数据目录是固定复用的（appctl 里放着不删），上一轮留下的标签会进
       snp.session，启动时 restoreSession() 挨个 openPath —— 那是异步的，
       1600ms 不一定恢复得完，恢复途中的 activate() 会把探针刚 newTab 出来的
       标签挤下去：断言读到的正文成了别人的（「长行不换行」就是这么假的红的）。
       草稿那边同理，snp.drafts 不清就会在启动时弹「恢复草稿」，一层遮罩挡住
       后面所有右键与点击。 */
    for (const k of ['draft', 'drafts', 'draftStash', 'session', 'sessionActive']) {
      localStorage.removeItem('snp.' + k);
    }
    location.reload();
  })()`);
  await sleep(1600);
  /* 弹窗兜底：万一还有草稿恢复框，一律选「不恢复」 */
  await ev(`document.getElementById('dlgFoot')?.querySelectorAll('button')[1]?.click()`);
  /* 等启动恢复彻底跑完再断言：标签数连续三次采样不变才算稳（恢复是逐篇 IO 的，
     固定 sleep 在机器忙的时候一定不够）。 */
  for (let i = 0, prev = -1, stable = 0; i < 40; i++) {
    const n = await ev(`document.querySelectorAll('.tab[data-id]').length`);
    if (n === prev) { if (++stable >= 2) break; } else { prev = n; stable = 0; }
    await sleep(120);
  }

  // ---- A. 侧栏两个页面 ----
  ok('侧栏有两个页面切换', (await ev(`document.querySelectorAll('.side-tab').length`)) === 2);
  /* 侧栏页签是记住的（settings.side），「重载后停在哪」取决于上次的选择。
     这里断言的是那个契约；写死「大纲」只在新配置下成立，跑第二遍就红 */
  const wantSide = await ev(`JSON.parse(localStorage.getItem('snp.settings') || '{}').side === 'files' ? '文件' : '大纲'`);
  ok('重载后停在上次的侧栏页', (await ev(`document.querySelector('.side-tab.active')?.textContent`)) === wantSide, wantSide);

  await ev(`document.querySelector('[data-side="files"]').click()`);
  ok('切到文件页后大纲隐藏', await ev(`document.getElementById('sideOutline').classList.contains('hidden')`));
  ok('没打开文件夹时给引导', (await ev(`document.getElementById('ftBody').textContent`)).includes('还没打开文件夹'));
  /* 文件搜索只负责「找」，不负责「改」：跨文件批量替换会把磁盘上几十个文件
     一次改掉，误点一次要按文件翻历史快照才救得回来，而真实需求几乎没有。
     改内容交给编辑区的查找替换（Ctrl+H），那里只改当前这一份。 */
  ok('文件搜索里没有替换行',
    (await ev(`!!document.getElementById('ftReplaceRow') || !!document.getElementById('ftReplaceAll')`)) === false);
  ok('区分大小写并进搜索行，不再挂在替换行上',
    (await ev(`!!document.querySelector('#sideFiles .ft-search #ftCase')`)) === true);

  // ---- B. 后端命令：列目录 / 全目录搜索 ----
  const invoke = (cmd, args) =>
    ev(`window.__TAURI_INTERNALS__.invoke('${cmd}', ${JSON.stringify(args)})`);
  const self = await ev(`window.__TAURI_INTERNALS__.invoke('file_mtime', { path: 'src/index.html' })`).catch(() => null);
  ok('file_mtime 能取到修改时间', typeof self === 'number' || self === null, String(self));

  const ls = await invoke('read_dir_shallow', { path: '.' }).catch(() => null);
  ok('read_dir_shallow 列出仓库根目录', Array.isArray(ls) && ls.length > 3, ls ? ls.length + ' 项' : 'null');
  const dirsFirst = Array.isArray(ls) && ls.every((e, i) => i === 0 || !(ls[i - 1].is_dir === false && e.is_dir === true));
  ok('目录排在文件前面', dirsFirst);

  const hits = await invoke('search_in_folder', { root: '.', query: 'EZNotepad', maxResults: 20 }).catch(() => null);
  ok('search_in_folder 能搜到内容', Array.isArray(hits) && hits.length > 0, hits ? hits.length + ' 条' : 'null');
  ok('搜索结果带行号和片段', !!(hits && hits[0] && hits[0].line > 0 && hits[0].text));
  const noRep = await invoke('replace_in_folder', { root: '.', query: 'a', replacement: 'b' })
    .then(() => false).catch(() => true);
  ok('后端不再暴露跨文件替换命令', noRep);

  // ---- C. 设置面板 ----
  await ev(`window.__snp.commands.settings()`);
  await sleep(120);
  ok('设置面板打开', (await ev(`!!document.querySelector('.set-panel')`)) === true);
  ok('主题是三选一', (await ev(`document.querySelectorAll('.set-seg[data-name="theme"] button').length`)) === 3);

  /* 设置面板是「左分类 + 右内容」。原先一路竖排下来，窗口矮一点就要滚三屏，
     找「快捷键」得先盲滚。这里守三件事：分类齐全、一次只露一页、切换不丢值 */
  ok('设置面板是左分类右内容',
    (await ev(`!!document.querySelector('.modal.wide') && !!document.querySelector('.set-panel .set-nav') && !!document.querySelector('.set-panel .set-body')`)) === true);
  const navPages = await ev(`[...document.querySelectorAll('.set-nav [data-page]')].map(b => b.dataset.page).join(',')`);
  ok('左侧四个分类', navPages === 'look,ui,file,keys', navPages);
  const shownPages = () => ev(`[...document.querySelectorAll('.set-page')].filter(p => !p.classList.contains('hidden')).map(p => p.dataset.page).join(',')`);
  ok('一次只显示一页', (await shownPages()) === 'look', await shownPages());

  const beforeFont = await ev(`document.getElementById('setFontSize').textContent`);
  await ev(`document.querySelector('.set-step[data-zoom="1"]').click()`);
  const afterFont = await ev(`document.getElementById('setFontSize').textContent`);
  ok('调字号立刻反映在面板上', beforeFont !== afterFont, `${beforeFont} → ${afterFont}`);
  await ev(`document.querySelector('.set-step[data-zoom="-1"]').click()`);

  await ev(`document.querySelector('.set-nav [data-page="file"]').click()`);
  ok('点分类切到对应页', (await shownPages()) === 'file', await shownPages());
  ok('当前分类高亮', (await ev(`document.querySelector('.set-tab.on')?.dataset.page`)) === 'file');
  await ev(`document.querySelector('.set-nav [data-page="look"]').click()`);
  ok('切回来页面还在、值没丢',
    (await shownPages()) === 'look' && (await ev(`document.getElementById('setFontSize').textContent`)) === beforeFont);
  // 关掉：点底部「完成」
  await ev(`document.querySelector('#dlgFoot button')?.click()`);
  await sleep(120);
  // 弹层关闭后 body 还留在 #dlgBody 里（下次打开会被替换），所以要看遮罩是否隐藏
  ok('设置面板能关闭', await ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`));

  // ---- D. 所见即所得里原地查找（不切模式）----
  await ev(`window.__snp.newTab('probe.md', '# 标题一\\n\\n正文里的标题，还有一处标题。', null)`);
  await sleep(120);
  await ev(`window.__snp.commands.modeWysiwyg()`);
  await sleep(200);
  ok('切到所见即所得', await ev(`!document.getElementById('wysiwyg').classList.contains('hidden')`));

  await ev(`window.__snp.commands.find()`);
  await sleep(120);
  await ev(`(() => {
    const i = document.getElementById('findInput');
    i.value = '标题';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  ok('查找后仍是所见即所得（没被踢到编辑模式）',
    (await ev(`document.getElementById('wysiwyg').classList.contains('hidden')`)) === false);
  ok('匹配计数正确', (await ev(`document.getElementById('findCount').textContent`)) === '1/3',
    await ev(`document.getElementById('findCount').textContent`));
  /* 所见即所得的高亮是 CM6 的目录装饰：匹配按源码偏移算，
     DOM 里只渲染视口那几行，建不出全部 Range（所以不再走 CSS Custom Highlight） */
  ok('高亮已画上（当前这一处是实色）',
    (await ev(`document.querySelectorAll('#wysiwyg .cm-find-cur').length`)) === 1,
    String(await ev(`document.querySelectorAll('#wysiwyg .cm-find-cur').length`)));
  ok('其余匹配也标了淡色',
    (await ev(`document.querySelectorAll('#wysiwyg .cm-find').length`)) >= 1,
    String(await ev(`document.querySelectorAll('#wysiwyg .cm-find').length`)));
  ok('DOM 没被插入 mark 标记', (await ev(`document.getElementById('wysiwyg').querySelectorAll('mark').length`)) === 0);

  // 下一个匹配
  await ev(`document.getElementById('findNext').click()`);
  ok('能跳到下一个匹配', (await ev(`document.getElementById('findCount').textContent`)) === '2/3');

  /* ---- D2. 换块类型：原地搬内容 ----
     用户报过两处：代码块上点「引用」毫无反应；引用上点「代码块」不是换类型，
     而是引用原地不动、下面多出一个空代码块。这里在真壳子里两个方向都走一遍 */
  {
    const convDoc = '```js\nconst a = 1;\n```\n\n> 一句引用';
    await ev(`window.__snp.newTab('conv.md', ${JSON.stringify(convDoc)}, null)`);
    await sleep(200);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(200);

    await ev(`(() => {
      const ed = window.__snp.editor;
      ed.restoreCaret({ blockIndex: 0, offset: 0 });
      window.__snp.commands.quote();
    })()`);
    await sleep(150);
    const conv1 = await ev(`window.__snp.getEditorText()`);
    ok('代码块改成引用：原地换类型',
      conv1.indexOf('```') < 0 && conv1.indexOf('> const a = 1;') === 0, JSON.stringify(conv1));

    await ev(`(() => {
      const ed = window.__snp.editor;
      ed.restoreCaret({ blockIndex: ed.root.children.length - 1, offset: 0 });
      window.__snp.commands.codeBlock();
    })()`);
    await sleep(150);
    const conv2 = await ev(`window.__snp.getEditorText()`);
    ok('引用改成代码块：不在下面另起一块',
      conv2.indexOf('```\n一句引用\n```') >= 0 && conv2.indexOf('> 一句引用') < 0, JSON.stringify(conv2));

    /* 右键「引用」那排药丸里的「普通」= 切成普通引用。原先它跟「取消引用」
       共用一个命令，在提示块上一点整个框就退成段落了 */
    const coDoc = '> [!info] 提示标题\n> 续行';
    await ev(`window.__snp.newTab('co.md', ${JSON.stringify(coDoc)}, null)`);
    await sleep(200);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(200);
    await ev(`(() => {
      const ed = window.__snp.editor;
      ed.restoreCaret({ blockIndex: 0, offset: 0 });
      window.__snp.commands.plainQuote();
    })()`);
    await sleep(150);
    const co1 = await ev(`window.__snp.getEditorText()`);
    ok('提示块上点「普通」只摘样式、引用留着', co1 === '> 提示标题\n> 续行', JSON.stringify(co1));
  }

  // ---- E. 大纲跟随滚动 ----
  /* A 段把侧栏切到了文件页再没切回来。隐藏容器里的列表 clientHeight 是 0，
     既滚不动也滚不了 scrollTop，点击跳转虽然生效却永远点不亮 —— 这一整段
     必须在「大纲页真的在前台」的前提下跑。 */
  await ev(`document.querySelector('[data-side="outline"]').click()`);
  await sleep(250);
  const doc = Array.from({ length: 30 }, (_, i) => `## 第 ${i + 1} 节\n\n这一段是第 ${i + 1} 节的内容，用来把页面撑长。\n`).join('\n');
  await ev(`window.__snp.newTab('outline.md', ${JSON.stringify(doc)}, null)`);
  await sleep(150);
  await ev(`window.__snp.commands.modeWysiwyg()`);
  await sleep(250);
  /* 数真实条目，不数 DOM：大纲是窗口化渲染的，`.outline-item` 只有视口那一段，
     矮窗口下数到 25 不代表少收录（见 __snp.outlineCount 的说明） */
  const outlineTotal = await ev(`window.__snp.outlineCount()`);
  ok('大纲收录了全部 30 节', outlineTotal === 30, String(outlineTotal));
  ok('初始高亮在第一项', (await ev(`document.querySelector('.outline-item.active')?.textContent`)) === '第 1 节');

  /* 滚动容器是 CM6 的 .cm-scroller（#wysiwyg 只是挂载点，滚它没用） */
  await ev(`(() => {
    const w = document.querySelector('#wysiwyg .cm-scroller');
    w.scrollTop = w.scrollHeight;
  })()`);
  await sleep(400);
  const lastActive = await ev(`document.querySelector('.outline-item.active')?.textContent`);
  ok('滚到底部后高亮跟着走', lastActive && lastActive !== '第 1 节',
    JSON.stringify({
      active: lastActive || null,
      idx: await ev(`window.__snp.outlineActive()`),
      st: await ev(`document.querySelector('#wysiwyg .cm-scroller')?.scrollTop ?? -1`),
      sh: await ev(`document.querySelector('#wysiwyg .cm-scroller')?.scrollHeight ?? -1`),
      ch: await ev(`document.querySelector('#wysiwyg .cm-scroller')?.clientHeight ?? -1`),
      listTop: await ev(`Math.round(document.getElementById('outlineList').scrollTop)`),
    }));
  /* 高亮项必须真的被铺出来 —— 窗口化之后「算对了但没渲染」是一种独立的坏法 */
  ok('滚到底部后高亮项在 DOM 里', lastActive === '第 30 节', JSON.stringify({
    active: lastActive || null,
    items: await ev(`document.querySelectorAll('.outline-item').length`),
  }));

  // 编辑模式也要跟（走的是 CM6 的行号，不是 DOM）
  await ev(`window.__snp.commands.modeEdit()`);
  await sleep(250);
  await ev(`(() => {
    const s = document.querySelector('#editor .cm-scroller');
    if (s) s.scrollTop = s.scrollHeight;
  })()`);
  await sleep(400);
  const editActive = await ev(`document.querySelector('.outline-item.active')?.textContent`);
  ok('编辑模式下大纲也跟滚动', editActive && editActive !== '第 1 节', editActive);

  // 大纲点击：滚动后点亮的必须就是点的那一项（曾滚到视口中央、高亮停在上一节）
  const clickOutline = (label) =>
    ev(`[...document.querySelectorAll('.outline-item')].find(b => b.textContent === '${label}')?.click()`);
  await ev(`window.__snp.commands.modeWysiwyg()`);
  await sleep(300);
  await clickOutline('第 15 节');
  await waitUntil(async () => (await outlineActiveText()) === '第 15 节');
  ok('wysiwyg 点击大纲项，滚完该项点亮', (await outlineActiveText()) === '第 15 节');

  await ev(`window.__snp.commands.modePreview()`);
  await sleep(300);
  await clickOutline('第 8 节');
  await waitUntil(async () => (await outlineActiveText()) === '第 8 节');
  ok('预览模式点击大纲项，滚完该项点亮', (await outlineActiveText()) === '第 8 节');

  await ev(`window.__snp.commands.modeEdit()`);
  await sleep(300);
  await clickOutline('第 22 节');
  await waitUntil(async () => (await outlineActiveText()) === '第 22 节');
  ok('编辑模式点击大纲项，滚完该项点亮', (await outlineActiveText()) === '第 22 节',
    JSON.stringify({ now: await outlineActiveText(),
      top: await ev(`document.querySelector('#editor .cm-scroller')?.scrollTop`) }));

  /* 纯文本大纲只认结构标记。这里守的是那个真实 bug：`1. 2. 3.` 连续编号逐行进面板，
     而且全被压成同一级 —— 用户看到的是「txt 每行都是大纲」 */
  const outlineRows = () => ev(`[...document.querySelectorAll('#outlineList .outline-item')].map(b => ((b.className.match(/\\bh[1-6]\\b/) || ['?'])[0]) + ':' + b.textContent)`);
  await ev(`window.__snp.newTab('清单.txt', '1. 买菜\\n2. 做饭\\n3. 洗碗', null)`);
  await sleep(400);
  ok('txt 连续编号不逐行成大纲', (await outlineRows()).length === 0, JSON.stringify(await outlineRows()));
  ok('txt 空态说明缺什么', /章节标记/.test(await ev(`document.querySelector('#outlineList .outline-empty')?.textContent || ''`)),
    await ev(`JSON.stringify({ empty: document.querySelector('#outlineList .outline-empty')?.textContent || null,
      kids: document.getElementById('outlineList').children.length,
      paneHidden: document.getElementById('outlinePane').classList.contains('hidden') })`));
  /* 空态说明会被「列表自己滚一下」抹掉：上一份文档的大纲滚到 498，换成没有结构的
     文件后内容变短、scrollTop 被夹回 0 → 浏览器补一个 scroll → 那个 rAF 里的重铺
     把刚写的说明清成空白面板。这条曾经是一条假绿：靠「切换后 400ms 内恰好没有
     scroll」才通过。这里显式补一次 scroll 事件，把时序钉死。 */
  await ev(`document.getElementById('outlineList').dispatchEvent(new Event('scroll'))`);
  await sleep(120);
  ok('列表自己滚过一次，空态说明还在', /章节标记/.test(await ev(`document.querySelector('#outlineList .outline-empty')?.textContent || ''`)),
    await ev(`JSON.stringify({ kids: document.getElementById('outlineList').children.length,
      html: document.getElementById('outlineList').innerHTML.slice(0, 80) })`));
  await ev(`window.dispatchEvent(new Event('resize'))`);
  await sleep(120);
  ok('窗口 resize 重铺后，空态说明还在', /章节标记/.test(await ev(`document.querySelector('#outlineList .outline-empty')?.textContent || ''`)),
    await ev(`JSON.stringify({ kids: document.getElementById('outlineList').children.length })`));
  await ev(`window.__snp.setContent('1. 总论\\n1.1 背景\\n1.1.1 细节\\n2. 方法')`);
  await sleep(400);
  ok('多级编号按点号段数分级',
    (await outlineRows()).join(',') === 'h1:1. 总论,h2:1.1 背景,h3:1.1.1 细节,h1:2. 方法', JSON.stringify(await outlineRows()));
  await ev(`window.__snp.newTab('表.csv', 'a,b\\n1,2', null)`);
  await sleep(400);
  ok('csv 不提取大纲', (await outlineRows()).length === 0);

  /* 长大纲滚到中段后切到另一份文件：窗口化必须立刻换成新文档的条目。
     旧实现拿上一份文档的 scrollTop 算新区间，start > end 时 new Array(负数)
     抛异常、DOM 原封不动留着旧条目，只有用户手动滚回顶部才刷新。 */
  const olLong = Array.from({ length: 320 }, (_, i) => `## LONG-${i + 1}\n\n段落 ${i + 1}\n`).join('\n');
  const olShort = Array.from({ length: 3 }, (_, i) => `## SHORT-${i + 1}\n\n段落\n`).join('\n');
  await ev(`window.__snp.newTab('ol-long.md', ${JSON.stringify(olLong)}, null)`);
  await sleep(250);
  await ev(`window.__snp.newTab('ol-short.md', ${JSON.stringify(olShort)}, null)`);
  await sleep(250);
  const clickTabNamed = (name) => ev(`(() => {
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(name)}));
    if (t) t.click(); return !!t;
  })()`);
  ok('两个测试标签都在标签条上', await clickTabNamed('ol-long.md'));
  await sleep(300);
  await ev(`(() => { const l = document.getElementById('outlineList'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); })()`);
  await sleep(250);
  const olBefore = await ev(`JSON.stringify({ st: Math.round(document.getElementById('outlineList').scrollTop), first: document.querySelector('#outlineList .outline-item')?.textContent || null })`);
  ok('长大纲确实滚到了中段', JSON.parse(olBefore).st > 1000, olBefore);
  await clickTabNamed('ol-short.md');
  await sleep(400);
  const olAfter = await ev(`JSON.stringify({ tab: window.__snp.getActiveTab().name, count: window.__snp.outlineCount(), st: Math.round(document.getElementById('outlineList').scrollTop), rows: [...document.querySelectorAll('#outlineList .outline-item')].map(b => b.textContent) })`);
  const sw = JSON.parse(olAfter);
  ok('切到另一份文件，大纲立刻换成新文档的条目',
    sw.tab === 'ol-short.md' && sw.count === 3 && sw.rows.length === 3
      && sw.rows[0] === 'SHORT-1' && !sw.rows.some((x) => x.startsWith('LONG-')), olAfter);
  ok('换文档后大纲滚动位置归零', sw.st === 0, olAfter);
  await clickTabNamed('ol-long.md');
  await sleep(350);
  ok('切回去长大纲仍在，且从第一项开始',
    (await ev(`window.__snp.outlineCount()`)) === 320
      && (await ev(`document.querySelector('#outlineList .outline-item')?.textContent`)) === 'LONG-1');

  /* 选区配色：浅色跟大纲选中项同一层浅橙，深色不刷半透明白。
     WYSIWYG / 预览此前没有 ::selection 规则，用的是系统高亮色。 */
  const selColors = `(() => {
    const p = document.createElement('div');
    p.style.position = 'fixed'; p.style.left = '-9999px';
    document.body.appendChild(p);
    const get = (v) => { p.style.backgroundColor = 'var(' + v + ')'; return getComputedStyle(p).backgroundColor; };
    const r = { theme: document.body.dataset.theme, sel: get('--sel-bg'), soft: get('--accent-soft'), match: get('--sel-match-bg') };
    p.remove(); return JSON.stringify(r);
  })()`;
  const lum = (s) => {
    const n = (s.match(/[\d.]+/g) || []).map(Number).slice(0, 3);
    if (!n.length) return 1;
    return s.startsWith('color(') ? Math.max(...n) : Math.max(...n) / 255;
  };
  const lightColors = JSON.parse(await ev(selColors));
  ok('浅色选区就是大纲选中项那层浅橙',
    lightColors.sel === lightColors.soft && /254, 235, 231/.test(lightColors.sel), JSON.stringify(lightColors));
  await ev(`(() => { document.body.dataset.theme = 'dark'; return document.body.dataset.theme; })()`);
  await sleep(150);
  const darkColors = JSON.parse(await ev(selColors));
  ok('深色相同文本高亮不再是半透明白',
    darkColors.match.indexOf('/') < 0 && lum(darkColors.match) < 0.35, JSON.stringify(darkColors));
  ok('深色选区是暗底，不是发白的亮块', lum(darkColors.sel) < 0.5, JSON.stringify(darkColors));
  const selRules = JSON.parse(await ev(`(() => {
    let bare = 0, scoped = 0, rule = false;
    for (const ss of document.styleSheets) {
      let rules; try { rules = [...ss.cssRules]; } catch { continue; }
      for (const r of rules) {
        const sel = (r.selectorText || '').trim();
        if (!sel.includes('::selection')) continue;
        if (sel === '::selection') {
          bare++;
          if ((r.style.backgroundColor || '').includes('--sel-bg')) rule = true;
        } else if (/^#(wysiwyg|preview|editor)\b/.test(sel)) scoped++;
      }
    }
    return JSON.stringify({ bare, scoped, rule });
  })()`));
  /* 用户 2026-11-13：所有选区统一一块底色，含对比窗口。对比窗载入同一份
     styles.css，所以「一条裸规则、没有按容器分叉」就是这条要求的形状：
     谁再往 #wysiwyg / #preview 前面加限定，就等于把别处漏回系统高亮色。 */
  ok('全局只有一条裸 ::selection，三个窗口共用',
    selRules.bare === 1 && selRules.scoped === 0 && selRules.rule, JSON.stringify(selRules));
  await ev(`document.body.dataset.theme = 'light'`);
  await sleep(150);

  /* 拖入文件。窗口开着 dragDropEnabled，正常路径是 Tauri 的 onDragDropEvent，
     但 OS 级拖放没法在探针里模拟。这里用合成 HTML5 drop 验的是**兜底分支**：
     真走到它时（原生通道没注册上）图片仍能落 assets、非图片仍会拦下默认行为。 */
  await ev(`window.__snp.newTab('drop.md', '# 拖放\\n', null)`);
  await sleep(300);
  const dropExpr = (type, name) => `(async () => {
    const f = new File([new Uint8Array([137, 80, 78, 71])], '${name}', { type: '${type}' });
    const dt = new DataTransfer(); dt.items.add(f);
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    const notCancelled = document.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ prevented: !notCancelled, toast: [...document.querySelectorAll('.toast')].pop()?.textContent || '' });
  })()`;
  const imgDrop = JSON.parse(await ev(dropExpr('image/png', 'shot.png')));
  ok('拖入图片：拦下默认行为并提示先存盘',
    imgDrop.prevented && /assets/.test(imgDrop.toast), imgDrop.toast);

  const docBefore = await ev(`window.__snp.getEditorText()`);
  const fileDrop = JSON.parse(await ev(dropExpr('text/markdown', 'note.md')));
  ok('拖入非图片：拦下默认行为、正文不变',
    fileDrop.prevented && (await ev(`window.__snp.getEditorText()`)) === docBefore, fileDrop.toast);

  const internalDrop = await ev(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'tab');
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    return !document.dispatchEvent(e);
  })()`);
  ok('无文件的内部拖放（标签换位）不被拦截', internalDrop === false, String(internalDrop));

  /* ---- F. 标签条溢出 ----
     标签开到十几个之后，标签条本身能横滚，但滚动条是隐藏的：既看不出
     「后面还有」，也没有可抓的东西。三个入口各验一次。 */
  {
    const strip = async () => JSON.parse(await ev(`(() => {
      const s = document.getElementById('tabs');
      const a = s.querySelector('.tab.active');
      const sr = s.getBoundingClientRect();
      const ar = a ? a.getBoundingClientRect() : null;
      return JSON.stringify({
        n: s.querySelectorAll('.tab').length,
        scrollW: s.scrollWidth, clientW: s.clientWidth, left: Math.round(s.scrollLeft),
        more: !document.getElementById('tabMore').classList.contains('hidden'),
        actIn: !!(ar && ar.left >= sr.left - 1 && ar.right <= sr.right + 1),
      });
    })()`));

    await ev(`(() => { for (let i = 0; i < 14; i++) window.__snp.newTab('ov' + i + '.md', '# ' + i, null); })()`);
    await sleep(400);                 // 等一帧 rAF
    const st = await strip();
    ok('标签开满后确实溢出', st.scrollW > st.clientW + 1, `${st.scrollW} / ${st.clientW}`);
    ok('溢出时才出现「全部标签」按钮', st.more === true, JSON.stringify(st));
    /* 新建的标签排在最后一个。不把它滚进视野，界面上就是「点了新建没反应」 */
    ok('当前标签自动滚进视野', st.actIn === true, JSON.stringify(st));

    // 滚轮：标签条没有纵向可滚的东西，垂直滚轮直接当横向用
    await ev(`document.getElementById('tabs').scrollLeft = 0`);
    await ev(`document.getElementById('tabs').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))`);
    const wh = await strip();
    ok('滚轮能横着滚标签条', wh.left > 0, `0 → ${wh.left}`);

    // 「全部标签」下拉
    /* 刚刚滚过标签条就点按钮：scroll 事件是排队派发的，菜单会被那条迟到的
       scroll 顺手收掉（修之前一半概率「点了没反应」）。这条守的就是这个时序 */
    await ev(`document.getElementById('tabMore').click()`);
    await sleep(250);
    const menu = await ev(`(() => {
      const m = document.querySelector('.ctx-menu');
      if (!m) return null;
      const it = [...m.querySelectorAll('.ctx-item')];
      return JSON.stringify({
        head: (m.querySelector('.am-head') || {}).textContent || '',
        n: it.length,
        ticked: it.filter((b) => (b.textContent || '').trim().startsWith('✓')).length,
        titles: it.map((b) => b.title),
      });
    })()`);
    const m = menu ? JSON.parse(menu) : null;
    ok('「全部标签」下拉列出全部标签', !!m && m.n === st.n, m ? `${m.n} 条 / 标签 ${st.n} 个` : '没弹出菜单');
    ok('下拉里只有当前标签打勾', !!m && m.ticked === 1, m ? `${m.ticked} 个勾` : '');
    ok('下拉抬头写明总数', !!m && m.head.includes(String(st.n)), m && m.head);
    /* 点第 3 条：下拉顺序与标签条一致，切过去的必须就是那条。
       顺带验「当前标签滚进视野」在切到远处标签时也生效 */
    const wantTitle = m && m.titles[2];
    await ev(`document.querySelectorAll('.ctx-menu .ctx-item')[2].click()`);
    await sleep(200);
    ok('点下拉条目能切过去',
      (await ev(`document.querySelector('.tab.active')?.title`)) === wantTitle, wantTitle);
    ok('切换后当前标签也在视野内', (await strip()).actIn === true);
  }

  /* ---- F2. 标签拆成独立窗口 / 收回来 ----
     拖出去这个手势合成不出来（dragend 的坐标是浏览器按真实指针给的），这里直接
     调 tearOffTab：它依赖的判据（leftTabbar）在 run-units 里逐条验过，真机这层
     要验的是「拆出去之后会发生什么」—— 另一扇窗口真的起来、只带那一个标签、
     改动能跟着收回来。 */
  {
    const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
      .filter((t) => t.type === 'page' && !/(?:compare|foldercmp)\.html/.test(t.url));

    /* 连到另一扇窗口：每扇窗口一个 WebSocket，用完就关 */
    const attach = async (target) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      let n = 0;
      const pend = new Map();
      socket.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        const p = pend.get(msg.id);
        if (p) { pend.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
      });
      await new Promise((r) => socket.addEventListener('open', r));
      return {
        ev: (expr) => new Promise((res, rej) => {
          const id = ++n;
          pend.set(id, { res, rej });
          socket.send(JSON.stringify({
            id, method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true },
          }));
        }).then((r) => (r.exceptionDetails ? null : r.result.value)),
        close: () => { try { socket.close(); } catch { /* 已经关了 */ } },
      };
    };

    /* 真手势：在标签节点上走一遍 pointerdown → pointermove → pointerup。
       这套事件是我们自己监听的，所以合成事件就够（不像 HTML5 拖放那样
       必须由真实指针产生 dragstart）。 */
    const dragTab = (idx, toX, toY) => ev(`(() => {
      const n = document.querySelectorAll('.tab')[${idx}];
      const r = n.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const opt = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 1,
        pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY });
      n.dispatchEvent(new PointerEvent('pointerdown', opt(x0, y0)));
      for (let i = 1; i <= 8; i++) {
        n.dispatchEvent(new PointerEvent('pointermove', opt(x0 + (${toX} - x0) * i / 8, y0 + (${toY} - y0) * i / 8)));
      }
      n.dispatchEvent(new PointerEvent('pointerup', { ...opt(${toX}, ${toY}), buttons: 0 }));
      return { x0, y0, barTop: document.querySelector('.tabbar').getBoundingClientRect().top };
    })()`);

    /* 先验换位：把第一张标签拖过最后一张的中线。
       HTML5 那套在 Windows 上是死的（dragDropEnabled=true 把拖放交给了 OS），
       这条断言就是防它再被写回去 —— 那时它是「能编译、能跑、拖了不动」。 */
    {
      const ids0 = await ev(`[...document.querySelectorAll('.tab')].map(n => Number(n.dataset.id))`);
      const active0 = await ev(`document.querySelector('.tab.active')?.title`);
      const geo = await ev(`(() => {
        const t = document.querySelectorAll('.tab');
        const last = t[t.length - 1].getBoundingClientRect();
        const first = t[0].getBoundingClientRect();
        return { x: last.left + last.width - 6, y: first.top + first.height / 2, n: t.length };
      })()`);
      await dragTab(0, geo.x, geo.y);
      await sleep(300);
      const ids1 = await ev(`[...document.querySelectorAll('.tab')].map(n => Number(n.dataset.id))`);
      ok('拖过最后一张的中线 → 第一张挪到末尾',
        ids1.length === geo.n && ids1[ids1.length - 1] === ids0[0] && ids1[0] === ids0[1],
        JSON.stringify({ ids0, ids1 }));
      ok('拖完不顺手把标签切过去（松手后的 click 得吞掉）',
        (await ev(`document.querySelector('.tab.active')?.title`)) === active0, active0);
      /* 拖回原位，别把后面的断言建立在一个被改过的顺序上 */
      const back = await ev(`(() => {
        const t = document.querySelectorAll('.tab');
        const first = t[0].getBoundingClientRect();
        return { x: first.left + 4, y: first.top + first.height / 2 };
      })()`);
      await dragTab(geo.n - 1, back.x, back.y);
      await sleep(300);
      ok('再拖回去，顺序复原',
        JSON.stringify(await ev(`[...document.querySelectorAll('.tab')].map(n => Number(n.dataset.id))`))
          === JSON.stringify(ids0));

      /* 手抖 2px 不该变成拖拽：点了自己那颗标签却换了位置最难解释 */
      const jitter = await ev(`(() => {
        const r = document.querySelectorAll('.tab')[0].getBoundingClientRect();
        const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        return { x: c.x + 2, y: c.y };
      })()`);
      await dragTab(0, jitter.x, jitter.y);
      await sleep(200);
      ok('按下后只挪 2px = 还是点击，不换位',
        JSON.stringify(await ev(`[...document.querySelectorAll('.tab')].map(n => Number(n.dataset.id))`))
          === JSON.stringify(ids0));
    }

    const n0 = await ev(`document.querySelectorAll('.tab[data-id]').length`);
    const made = await ev(`(() => {
      const t = window.__snp.newTab('tear-probe.md', '# 拆出去\\n\\n正文在另一扇窗口里', null);
      return { id: t.id, name: t.name };
    })()`);
    await sleep(250);
    const nMade = await ev(`document.querySelectorAll('.tab[data-id]').length`);
    ok('先确认标签建出来了', nMade === n0 + 1, `${n0} → ${nMade}`);
    /* 拖出去也走真手势：往下 120px（超过 leftTabbar 的 24px 垫距） */
    const madeIdx = await ev(`[...document.querySelectorAll('.tab')].findIndex(n => n.title === 'tear-probe.md')`);
    const madeGeo = await ev(`(() => {
      const n = [...document.querySelectorAll('.tab')].find(x => x.title === 'tear-probe.md');
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await dragTab(madeIdx, madeGeo.x, madeGeo.y + 120);
    await sleep(2600);
    const n1 = await ev(`document.querySelectorAll('.tab[data-id]').length`);
    ok('拆出去后主窗口回到拆之前的标签数', n1 === n0, `${nMade} → ${n1}（拆之前 ${n0}）`);

    const all = await pages();
    ok('多了一扇窗口', all.length >= 2, `${all.length} 个页面`);

    let w2 = null;
    for (const t of all) {
      if (t.webSocketDebuggerUrl === page.webSocketDebuggerUrl) continue;
      const c = await attach(t);
      const names = await c.ev(`[...document.querySelectorAll('.tab-name')].map((n) => n.textContent).join('|')`);
      if ((names || '').includes('tear-probe.md')) { w2 = { c, names }; break; }
      c.close();
    }
    ok('新窗口里只有那一个标签（没把主窗口的标签复制一份）',
      !!w2 && w2.names === 'tear-probe.md', w2 ? w2.names : '没找到窗口');

    if (w2) {
      ok('正文跟着过去了',
        (await w2.c.ev(`window.__snp.getEditorText()`)).includes('正文在另一扇窗口里'));
      /* 标签栏矩形：主窗口报的是相对坐标，读回来必须是「主窗口此刻的屏幕位置 + 相对位置」。
         存屏幕坐标的写法在窗口被拖走之后就会失效，这条守着它。 */
      const gotRect = await ev(`window.__TAURI_INTERNALS__.invoke('main_tabbar_rect')`);
      const wantRect = await ev(`(() => {
        const b = document.querySelector('.tabbar').getBoundingClientRect();
        return { x: window.screenX + b.left, y: window.screenY + b.top, w: b.width, h: b.height };
      })()`);
      ok('标签栏矩形按主窗口当前位置现算（不是存下来的旧屏幕坐标）',
        !!gotRect && Math.abs(gotRect.x - wantRect.x) <= 2 && Math.abs(gotRect.y - wantRect.y) <= 2
          && Math.abs(gotRect.w - wantRect.w) <= 2 && Math.abs(gotRect.h - wantRect.h) <= 2,
        JSON.stringify({ gotRect, wantRect }));

      const before = (await pages()).length;
      /* 改了再收回去：改动和脏标记都得活着回到主窗口。
         回去也走真手势 —— 按住标签把指针拖到主窗口标签栏上松手。 */
      await w2.c.ev(`window.__snp.setContent('# 拆出去\\n\\n改过的正文')`);
      await sleep(250);
      const backDrag = await w2.c.ev(`(async () => {
        const rect = await window.__TAURI_INTERNALS__.invoke('main_tabbar_rect');
        const n = document.querySelector('.tab');
        const r = n.getBoundingClientRect();
        const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
        const tx = rect.x + 40 - window.screenX, ty = rect.y + 10 - window.screenY;
        const opt = (x, y) => ({ bubbles: true, cancelable: true, composed: true, pointerId: 9,
          pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
          clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY });
        n.dispatchEvent(new PointerEvent('pointerdown', opt(x0, y0)));
        for (let i = 1; i <= 6; i++) {
          n.dispatchEvent(new PointerEvent('pointermove', opt(x0 + (tx - x0) * i / 6, y0 + (ty - y0) * i / 6)));
        }
        n.dispatchEvent(new PointerEvent('pointerup', { ...opt(tx, ty), buttons: 0 }));
        return { rect, tx, ty };
      })()`);
      ok('拖回时要拿到主窗口标签栏的矩形', !!backDrag && !!backDrag.rect,
        JSON.stringify(backDrag));
      await sleep(1800);
      w2.c.close();
      const back = await ev(`(() => {
        const t = window.__snp.getActiveTab();
        return { name: t && t.name, text: window.__snp.getEditorText(),
          dot: document.querySelectorAll('.tab-dot').length };
      })()`);
      ok('收回来变成主窗口的活动标签', back.name === 'tear-probe.md', String(back.name));
      ok('收回来的是改过的内容', (back.text || '').includes('改过的正文'), back.text);
      ok('脏标记跟着回来', back.dot >= 1, `${back.dot} 个未保存点`);
      ok('那扇窗口自己关掉了', (await pages()).length === before - 1, `${before} → ${(await pages()).length}`);
      /* 收尾：把它记成干净的，别给后面的段留一个「未保存」标签 */
      await ev(`(() => { const t = window.__snp.getActiveTab(); t.savedContent = t.content; return 1; })()`);
    }
    await ev(`window.__TAURI_INTERNALS__.invoke('close_tearoff_windows')`);
  }

  /* ---- G. 行显示模式（自动换行 / 不换行）----
     三种模式共用一个设置。换行是浏览器默认，所以真正要验的是「关掉之后
     长行确实横向滚起来」以及「切回来能复原」—— 只改属性不改编辑器
     （CodeMirror 走 Compartment）是最容易漏的一半。 */
  {
    const LONG = 'A'.repeat(400);
    await ev(`window.__snp.newTab('wrap.md', ${JSON.stringify('# 长行\n\n' + LONG + '\n')}, null)`);
    await sleep(300);
    await ev(`window.__snp.commands.modeEdit()`);
    await sleep(300);

    const geo = () => ev(`(() => {
      /* #wysiwyg 只是挂载点，真正滚的是里面的 .cm-scroller（白拿它的
         scrollWidth 永远是 clientWidth，会把「不换行没生效」和自己骗成一回事） */
      const cm = document.querySelector('#editor .cm-scroller');
      const pv = document.getElementById('preview');
      const wys = document.querySelector('#wysiwyg .cm-scroller');
      const m = (el) => (el && el.offsetParent !== null)
        ? { sw: el.scrollWidth, cw: el.clientWidth, ws: getComputedStyle(el).whiteSpace }
        : null;
      return {
        nowrap: document.body.hasAttribute('data-nowrap'),
        cm: m(cm), preview: m(pv), wys: m(wys),
      };
    })()`);

    const d0 = await geo();
    ok('默认是自动换行（body 上没有 data-nowrap）', d0.nowrap === false, JSON.stringify(d0.nowrap));
    ok('编辑区默认不横向溢出：长行折着显示', !!d0.cm && d0.cm.sw <= d0.cm.cw + 1,
      JSON.stringify(d0.cm));

    await ev(`window.__snp.commands.wrapNone()`);
    await sleep(700);
    const d1 = await geo();
    ok('切到不换行：编辑区能横向滚了', !!d1.cm && d1.cm.sw > d1.cm.cw + 200, JSON.stringify(d1.cm));
    ok('切到不换行：body 上挂 data-nowrap', d1.nowrap === true);

    /* 1.2.1：横向滚动时长行不能从行号槽底下透出来。CM6 的 .cm-gutters 是
       sticky + zIndex 200，背景透明就等于没挡住；判据取 computed style：
       不透明、与编辑区纸面同色、挡板仍在正文之上。 */
    await ev(`(() => { const s = document.querySelector('#editor .cm-scroller'); if (s) s.scrollLeft = 260; return 1; })()`);
    await sleep(250);
    const gut = await ev(`(() => {
      const s = document.querySelector('#editor .cm-scroller');
      const g = document.querySelector('#editor .cm-gutters');
      const pane = document.querySelector('.editor-pane');
      if (!s || !g || !pane) return null;
      const cs = getComputedStyle(g);
      const bg = cs.backgroundColor;
      const parts = bg.includes('(')
        ? bg.slice(bg.indexOf('(') + 1, bg.lastIndexOf(')')).split(',').map(Number) : [];
      return {
        scrollLeft: s.scrollLeft,
        bg, alpha: parts.length === 4 ? parts[3] : (parts.length === 3 ? 1 : 0),
        paneBg: getComputedStyle(pane).backgroundColor,
        pos: cs.position, z: +cs.zIndex,
      };
    })()`);
    ok('真机：不换行确实横向滚起来了', !!gut && gut.scrollLeft > 100, JSON.stringify(gut));
    ok('真机：行号槽是不透明纸面，长行不会透到行号左边',
      !!gut && gut.alpha === 1 && gut.bg === gut.paneBg && gut.pos === 'sticky' && gut.z >= 200,
      JSON.stringify(gut));
    /* 横滚位置别留给后面的右键：它按 .cm-line 的可见坐标算落点，滚着的时候
       那个点会落到视口外，右键菜单根本弹不出来。 */
    await ev(`(() => { const s = document.querySelector('#editor .cm-scroller'); if (s) s.scrollLeft = 0; return 1; })()`);

    /* 菜单里的勾选：状态是每次展开时求值的，不是建菜单那一刻定死的 */
    await ev(`(() => { [...document.querySelectorAll('.am-btn')].find((b) => b.textContent.trim() === '视图')?.click(); })()`);
    await sleep(200);
    const menuWrap = await ev(`(() => {
      const items = [...document.querySelectorAll('.appmenu .am-item')];
      return items.filter((b) => /自动换行|不换行/.test(b.textContent))
        .map((b) => ({ t: b.textContent.trim(), on: !!b.querySelector('.am-slot svg') }));
    })()`);
    ok('视图菜单里有换行两项，且当前勾在「不换行」',
      menuWrap.length === 2 && menuWrap.some((x) => x.on && x.t === '不换行'), JSON.stringify(menuWrap));
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(150);

    /* 预览模式：不换行时长行撑开 body，横向滚 */
    await ev(`window.__snp.commands.modePreview()`);
    await sleep(500);
    const d2 = await geo();
    ok('预览模式不换行：正文横向滚', !!d2.preview && d2.preview.sw > d2.preview.cw + 200, JSON.stringify(d2.preview));
    ok('预览模式不换行的 white-space 是 nowrap', !!d2.preview && d2.preview.ws === 'nowrap', d2.preview && d2.preview.ws);

    /* 所见即所得：同一个开关 */
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(600);
    const d3 = await geo();
    ok('所见即所得不换行：正文横向滚', !!d3.wys && d3.wys.sw > d3.wys.cw + 200, JSON.stringify(d3.wys));

    /* 编辑器右键里也有这一组（三种模式的右键入口都要在） */
    await ev(`window.__snp.commands.modeEdit()`);
    await sleep(400);
    /* 坐标落在真正的一行文字上，而不是「编辑区容器里的某一点」：
       上面那些小节可能还留着查找条，容器左上角那一下会打在它身上 */
    const rc = await ev(`(() => {
      const close = document.getElementById('findClose');
      if (close && !document.getElementById('findbar').classList.contains('hidden')) close.click();
      const line = document.querySelector('#editor .cm-line');
      const b = (line || document.getElementById('editor')).getBoundingClientRect();
      return { x: Math.round(b.left + 60), y: Math.round(b.top + Math.round(b.height / 2)) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'right', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'right', clickCount: 1 });
    await sleep(180);
    const ctx = await ev(`(() => {
      const m = document.querySelector('.ctx-menu');
      return m ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
    })()`);
    ok('编辑区右键里有换行开关',
      ctx.some((t) => t.includes('自动换行')) && ctx.some((t) => t.includes('不换行')), JSON.stringify(ctx));
    /* 走菜单自己的关闭路径。直接 remove DOM 会把 document 上的 capture
       keydown 监听留在页面里，后面每一次 Esc 都被这个幽灵菜单吞掉。 */
    await ev(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return 1; })()`);
    await sleep(120);

    /* 复原：后面可能还有别的断言依赖默认值 */
    await ev(`window.__snp.commands.wrapSoft()`);
    await sleep(400);
    ok('切回自动换行，连编辑器一起复原', (await geo()).nowrap === false);
  }

  /* ---- H. 真鼠标跨块拖选 与 代码块内粘贴 ----
     离线套件用合成事件盖住了这两条，这里按真鼠标 / 真 paste 再走一遍。
     新内核里选区由 CM6 自己维护（document 的 Selection 只是它的投影），
     所以判据从「DOM 选区跨了几个块」改成「CM6 的 state.selection 跨了几行」。 */
  {
    const SRC = [
      '第一段文字，用来拖选的起点。', '',
      '第二段文字，中间应该被选中。', '',
      '第三段文字，也应当被选中。', '',
    ].join('\n');
    await ev(`window.__snp.newTab('sel.md', ${JSON.stringify(SRC)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(600);
    await ev(`(() => { const b = document.getElementById('findClose'); if (b && !document.getElementById('findbar').classList.contains('hidden')) b.click(); })()`);
    await sleep(150);

    /* 起止点要真的落在段首：拿首字符的 Range 矩形算坐标，别用 left + 20 ——
       窗口一窄，20px 就跨过好几个汉字，测的就不是「从段首开始拖」了 */
    const pts = await ev(`(() => {
      const atStart = (blk) => {
        const node = blk.firstChild;
        if (!node) return null;
        const r = document.createRange();
        r.setStart(node, 0); r.setEnd(node, 0);
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + 1), y: Math.round(b.top + Math.round(b.height / 2)) };
      };
      return [...document.querySelectorAll('#wysiwyg .cm-line')].map(atStart);
    })()`);
    const linesBefore = await ev(`document.querySelectorAll('#wysiwyg .cm-line').length`);
    const a = pts[0], z = pts[4];
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      const y = Math.round(a.y + ((z.y - a.y) * i) / 6);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y, button: 'left', buttons: 1 });
      await sleep(40);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: z.x, y: z.y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(300);

    const sel = await ev(`(() => {
      const v = window.__snp.editor.view;
      const r = v.state.selection.main;
      const d = v.state.doc;
      return {
        empty: r.empty,
        fromLine: d.lineAt(r.from).number, toLine: d.lineAt(r.to).number,
        len: r.to - r.from,
        domText: String(getSelection() || '').length,
      };
    })()`);
    ok('真鼠标跨块拖选：CM6 拿到了非空选区', sel.empty === false && sel.len > 10, JSON.stringify(sel));
    ok('……选区从第 1 段跨到第 3 段', sel.fromLine === 1 && sel.toLine === 5, JSON.stringify(sel));
    ok('拖选不往文档里加行',
      (await ev(`document.querySelectorAll('#wysiwyg .cm-line').length`)) === linesBefore,
      String(linesBefore));

    /* 选中的字要真能删 —— 只看选区长度，容易被「选中了但键盘不动」骗过去 */
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await sleep(400);
    const after = await ev(`window.__snp.getEditorText()`);
    ok('跨块拖选后按退格，整段真的删掉了',
      after.includes('第三段') && !after.includes('第一段') && !after.includes('第二段'), JSON.stringify(after));

    /* 代码块里粘贴多行 JSON：块必须还在，内容必须进块。
       paste 事件交给 CM6 处理，所以光标要先落进它自己的选区里 */
    const CB = ['前一段', '', '```json', '', '```', '', '后一段', ''].join('\n');
    await ev(`window.__snp.newTab('paste.md', ${JSON.stringify(CB)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(520);
    /* 空代码块的两条围栏按源码显示（见 live-preview 里的注释），光标放进围栏之间。
       位置在 Node 这边算：反引号写进模板串会当场把字符串截断 */
    const mdNow = await ev('window.__snp.getEditorText()');
    /* +7 是围栏行末尾，+8 才是围栏之间那条空内容行的起点 —— 要测的是「光标在块内」 */
    const inner = mdNow.indexOf('```json') + 8;
    await ev(`window.__snp.editor.setSelection(${inner})`);
    await sleep(200);
    await ev(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '{\\n  "b": 2,\\n  "c": [1, 2]\\n}');
      document.querySelector('#wysiwyg .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await sleep(500);

    const saved = await ev(`window.__snp.getEditorText()`);
    ok('空代码块里粘贴多行：内容进了代码块（没变成块外段落）',
      saved === '前一段\n\n```json\n{\n  "b": 2,\n  "c": [1, 2]\n}\n```\n\n后一段\n', JSON.stringify(saved));
    ok('……粘贴后代码块仍然闭合（围栏成对）',
      (saved.match(/```/g) || []).length === 2, JSON.stringify(saved.match(/```/g)));
  }

    /* ---- I. 方向键 / 退格：文本内核里它们只动光标和行 ----
       旧内核有一整套「块后待插入」（gapAfter）：块里没有「更靠后的光标位」，
       出块时先记一笔、等用户真打字才补行 —— 那是 contenteditable 里光标跳不出
       块逼出来的补丁，连带一堆「按 ↓ 会不会加行」「连按会不会攒空行」的断言。
       CM6 里光标就是字符偏移，方向键永远只移动它，文档一个字节都不改；
       所以这里只守契约本身，不再验那套机制的内部状态。 */
    {
      const text = () => ev('window.__snp.getEditorText()');
      const arrow = async (key, code, vk) => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
        await sleep(160);
      };
      const down = () => arrow('ArrowDown', 'ArrowDown', 40);
      const right = () => arrow('ArrowRight', 'ArrowRight', 39);
      const bksp = async () => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
        await sleep(280);
      };
      const enter = async () => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(220);
      };

      const TB = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', '', '后一段'].join('\n');
      await ev(`window.__snp.newTab('dir.md', ${JSON.stringify(TB)}, null)`);
      await sleep(400);
      await ev('window.__snp.commands.modeWysiwyg()');
      await sleep(520);
      /* 光标放进表格第一行（表格里光标在 = 源码态，看得见 | 分隔） */
      await ev(`window.__snp.editor.setSelection(2)`);
      await sleep(200);
      const t0 = await text();
      for (let i = 0; i < 4; i++) await down();
      for (let i = 0; i < 3; i++) await right();
      ok('方向键只移动光标，文档一字不改', (await text()) === t0, JSON.stringify(await text()));
      const moved = await ev(`window.__snp.editor.head`);
      ok('……光标确实动了（不是「没反应」被当成没改）', typeof moved === 'number' && moved > 2, String(moved));

      /* 回车就是把光标处断开成两行 —— 不再有「补一个空段落」这层隐藏语义 */
      await ev(`window.__snp.editor.setSelection(0)`);
      await sleep(120);
      await enter();
      ok('回车就是断行，不额外多出空行', (await text()).startsWith('\n'), JSON.stringify((await text()).slice(0, 6)));
      await ev('window.__snp.commands.undo()');
      await sleep(260);

      /* 行首退格 = 把两行接起来（markdown 的引用就是一组以 > 开头的行，
         接完之后仍然是同一段引用；不再有「合并两个块」那种 DOM 层语义） */
      await ev(`window.__snp.newTab('bq-bksp.md', '> 第一行\\n> 第二行', null)`);
      await sleep(360);
      await ev('window.__snp.commands.modeWysiwyg()');
      await sleep(480);
      await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().indexOf('第二行') - 2)`);
      await sleep(160);
      await bksp();
      ok('引用里行首退格把两行并成一行',
        (await text()) === '> 第一行> 第二行', JSON.stringify(await text()));

      /* ---- I2. 行内码的两个用户复报点（1.2.19 / 1.2.21）----
         ①` ` 里只有一个空格时光标进不去；②输入 ` 时把内容截断。
         新内核里这两件事都是「文档里的字符」，光标按字符走，那两个 bug 结构上
         不复存在 —— 所以验的是特性本身：空格码能进能改、反引号成对才成码。
         注意基线是「前 后」三个字（前 + 空格 + 后），光标落在后字前面。 */
      const marks = () => ev(`document.querySelectorAll('#wysiwyg .cm-lp-codemark').length`);
      await ev(`window.__snp.newTab('code-span.md', '前 后', null)`);
      await sleep(360);
      await ev('window.__snp.commands.modeWysiwyg()');
      await sleep(480);
      await ev(`window.__snp.editor.setSelection(2)`);
      await sleep(120);
      await send('Input.insertText', { text: '` `' });
      await sleep(320);
      ok('`` ` ` `` 这种只含空格的码写得进去', (await text()) === '前 ` `后', JSON.stringify(await text()));
      ok('……成对了就算一段码（装饰层认得它）', (await marks()) === 1, String(await marks()));
      /* 光标落在码内（两个反引号之间）还能继续打字 */
      await ev(`window.__snp.editor.setSelection(3)`);
      await sleep(120);
      await send('Input.insertText', { text: 'x' });
      await sleep(320);
      ok('空格码里还能继续输入', (await text()) === '前 `x `后', JSON.stringify(await text()));
      /* 删掉收尾那个反引号：退成字面，内容一个字符都不少 */
      await ev(`window.__snp.editor.setSelection(6)`);
      await sleep(120);
      await bksp();
      ok('删掉收尾反引号就退回字面，不吞字',
        (await text()) === '前 `x 后', JSON.stringify(await text()));
      ok('……不再是码了', (await marks()) === 0, String(await marks()));
    }
  {
    /* ---- J. 菜单栏：速记与对比放在最右边 ----
       它们原来分别在「文件」的第二位和「工具」的中段 —— 天天点的东西不该让人
       在菜单栏上找。两个都是一级项：速记是动作（点一次直接打开，没有下拉），
       对比是一组同族窗口的下拉。 */
    const bar = await ev(`[...document.querySelectorAll('#menubar .am-btn')].map((b) => b.textContent.trim())`);
    ok('菜单栏最后两项是「速记」「对比」',
      JSON.stringify(bar.slice(-2)) === '["速记","对比"]', JSON.stringify(bar));

    const items = () => ev(`(() => {
      const m = document.querySelector('.appmenu');
      return m && !m.hidden ? [...m.querySelectorAll('.am-item')].map((b) => b.textContent.trim()) : null;
    })()`);
    const openTop = async (name) => {
      await ev(`(() => { [...document.querySelectorAll('#menubar .am-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})?.click(); })()`);
      await sleep(260);
    };
    const closeTop = async () => {
      await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(160);
    };

    await openTop('工具');
    const tools = await items();
    ok('「工具」里不再重复列对比入口',
      !!tools && !tools.some((t) => /文本对比|文件夹对比|三向合并/.test(t)), JSON.stringify(tools));
    await closeTop();

    /* 速记是一级**动作**：点一次直接开，不该先展开一个只有「打开速记」的下拉 */
    await openTop('速记');
    await sleep(700);
    const qn = await ev(`({
      menu: (document.querySelector('.appmenu') || { hidden: true }).hidden,
      quick: !!(window.__snp.getActiveTab() || {}).quickNote,
    })`);
    ok('点「速记」直接打开速记，不展开下拉', qn.menu === true && qn.quick === true, JSON.stringify(qn));

    await openTop('对比');
    const cmpItems = await items();
    ok('「对比」下拉里有文本 / 文件夹 / 三向合并',
      !!cmpItems && ['文本对比', '文件夹对比', '三向合并'].every((k) => cmpItems.some((t) => t.includes(k))),
      JSON.stringify(cmpItems));
    await closeTop();
  }

  /* ---- K. 点文末空白：只把光标送回文末，不许加行 ----
     旧内核为「带边界的块」做 insertEmptyAfter 兜底，于是文末下方随便点几次
     就多出几个空行。新内核里文档就是文本，光标可以直接停在末行行尾 ——
     那个兜底整条不需要，这里守的是「点几次行数都不变、光标真的到文末」。 */
  {
    const blocks = () => ev(`document.querySelectorAll('#wysiwyg .cm-line').length`);
    const docLen = () => ev(`window.__snp.editor.toMarkdown().length`);
    /* 真鼠标：位置按「最后一块下方」算，和用户看到的那片空白一致 */
    const clickBlank = async () => {
      const p = await ev(`(() => {
        const root = document.querySelector('.wysiwyg');
        const last = root.lastElementChild;
        const rr = root.getBoundingClientRect();
        const lb = last ? last.getBoundingClientRect().bottom : rr.top;
        return { x: Math.round(rr.left + 24), y: Math.round(Math.min(lb + 30, rr.bottom - 8)) };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(220);
      return p;
    };

    await ev(`window.__snp.newTab('blank-click.md', '第一段文字。\\n\\n第二段文字。', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(600);
    await ev(`(() => { const b = document.getElementById('findClose'); if (b && !document.getElementById('findbar').classList.contains('hidden')) b.click(); })()`);
    const n0 = await blocks();
    const len0 = await docLen();
    const p1 = await clickBlank();
    const n1 = await blocks();
    await clickBlank();
    await clickBlank();
    const n3 = await blocks();
    ok('段落垫底：点文末空白不加行', n1 === n0 && n3 === n0, `${JSON.stringify(p1)} → ${n0} / ${n1} / 三次后 ${n3}`);
    /* 光标要真的落在文末，否则「没加行」可能是因为点空了没反应 */
    const head = await ev(`window.__snp.editor.head`);
    ok('段落垫底：点文末空白光标落回文末', head === len0, `${head} / ${len0}`);
    const tail = await ev(`(() => {
      const last = [...document.querySelectorAll('#wysiwyg .cm-line')].pop();
      const a = window.getSelection().anchorNode;
      const b = a && (a.nodeType === 3 ? a.parentElement : a);
      return !!(b && b.closest && b.closest('.cm-line') === last);
    })()`);
    ok('……DOM 选区也在最后一行里', tail === true);

    /* 代码块垫底也一样：不再有「块边界没有可写尾位」这回事，点几次都不加行 */
    await ev(`window.__snp.newTab('blank-code.md', '\`\`\`js\\nconst a = 1;\\n\`\`\`', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(600);
    const c0 = await blocks();
    await clickBlank();
    const c1 = await blocks();
    await clickBlank();
    await clickBlank();
    const c3 = await blocks();
    ok('代码块垫底：点文末空白同样不加行', c1 === c0 && c3 === c0, `${c0} / ${c1} / 三次后 ${c3}`);
  }

  /* ---- L. 代码块：自动识别语言 / 编辑态高亮 / 一键复制 / Ctrl+A ----
     三件事都只有真机才验得到：高亮走 CSS Custom Highlight API（区间建立与否
     能查，实际上色是像素级的事）；复制要真鼠标激活 + 真剪贴板；Ctrl+A 的
     第二下是浏览器的默认全选，合成事件根本不触发它。 */
  {
    const ctrlA = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await sleep(300);
    };
    const paste = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
      await sleep(500);
    };

    /* 语言条：语言名只取 info string（不写就显示「代码」）。
       词法着色另有一条路：没标语言时停手 500 ms 后自动识别一次，
       识别结果只影响颜色、不改语言条上的字（条上写的就是文件里的那一行）。 */
    await ev(`window.__snp.newTab('code-lang.md', '\`\`\`js\\nconst a = 1;\\n\`\`\`\\n\\n第二段', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(900);
    await ev(`(() => { const b = document.getElementById('findClose'); if (b && !document.getElementById('findbar').classList.contains('hidden')) b.click(); })()`);
    /* 光标别停在围栏上：光标在块里时整块按源码显示（这是有意的，见
       live-preview 里 FencedCode 分支的注释），那时没有语言条可看 */
    await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().length)`);
    await sleep(400);
    const cinfo = await ev(`(() => {
      const bar = document.querySelector('#wysiwyg .cm-lp-codebar');
      const lang = bar && bar.querySelector('.cm-lp-lang');
      const btn = bar && bar.querySelector('.cm-lp-copy');
      const r = btn && btn.getBoundingClientRect();
      return {
        lang: lang ? lang.textContent : null,
        btn: !!btn, w: r ? Math.round(r.width) : 0,
      };
    })()`);
    ok('代码块有语言条，语言名取 info string', cinfo.lang === 'js', JSON.stringify(cinfo.lang));
    ok('语言条上有复制按钮，且有实际尺寸（不是 0×0 的画外元素）',
      cinfo.btn === true && cinfo.w >= 12, JSON.stringify(cinfo));

    /* 词法着色：新内核挂的是 tok-* 类（`Decoration.mark`），不再是 CSS Custom
       Highlight。两条一起验 —— 只数 span 会被「整块一个颜色」骗过去：
       1.3.0 第一版就是这样，整段代码全是绿的（CM6 的 monospace tag 盖住了）。 */
    const toks = await ev(`(() => {
      const els = [...document.querySelectorAll('#wysiwyg .cm-line.cm-lp-code [class^="tok-"]')];
      const kw = els.find((e) => e.className === 'tok-key');
      const plain = document.querySelector('#wysiwyg .cm-line.cm-lp-code > span:not([class*="tok-"])');
      const col = (e) => (e ? getComputedStyle(e).color : '');
      return { n: els.length, kw: kw ? kw.textContent : null, keyCol: col(kw), plainCol: col(plain) };
    })()`);
    ok('代码块里的关键字有词法着色', toks.n > 0 && toks.kw === 'const', JSON.stringify(toks));
    ok('关键字颜色与正文不同（不是整块一个色）',
      !!toks.keyCol && toks.keyCol !== toks.plainCol, JSON.stringify(toks));

    /* 一键复制：真鼠标点按钮 → 图标切对勾 → 粘回编辑器验证内容 */
    const cp = await ev(`(() => {
      const r = document.querySelector('#wysiwyg .cm-lp-copy').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const done = await ev(`document.querySelector('#wysiwyg .cm-lp-copy').classList.contains('done')`);
    ok('点复制后按钮切成对勾（说明 execCommand 真的成功了）', done === true);

    /* 粘回去：光标放到文末，把剪贴板内容贴进来 */
    await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().length)`);
    await sleep(150);
    await paste();
    const pasted = await ev(`window.__snp.getEditorText()`);
    ok('复制出去的确实是整块代码（粘回来一字不差）',
      pasted.includes('const a = 1;'), JSON.stringify(pasted));

    /* 没标语言时语言条写「代码」：留一条空白条会让人以为坏了 */
    /* 文档里必须有块外的位置可停：光标在块内时整块按源码显示，没有语言条 */
    await ev(`window.__snp.newTab('code-nolang.md', '前\\n\\n\`\`\`\\nplain text\\n\`\`\`\\n\\n后', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(700);
    await ev(`window.__snp.editor.setSelection(0)`);
    await sleep(300);
    ok('没标语言时语言条写「代码」',
      (await ev(`document.querySelector('#wysiwyg .cm-lp-lang')?.textContent`)) === '代码');

    /* Ctrl+A：新内核是标准编辑器语义，第一下就全选。
       旧内核「先选本块、再选全篇」是 DOM 块模型的产物（块是独立元素，
       全选会跨块选到不可见的壳），源码里没有这个边界。 */
    await ev(`window.__snp.newTab('code-sel.md', '\`\`\`js\\nconst a = 1;\\n\`\`\`\\n\\n第二段', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(700);
    await ev(`window.__snp.editor.setSelection(12)`);
    await sleep(150);
    await ctrlA();
    const sel1 = await ev(`(() => {
      const r = window.__snp.editor.view.state.selection.main;
      return { from: r.from, to: r.to, len: r.to - r.from, all: r.to - r.from === window.__snp.editor.toMarkdown().length };
    })()`);
    ok('Ctrl+A 全选整篇', sel1.all === true, JSON.stringify(sel1));
    await ctrlA();
    const sel2 = await ev(`(() => { const r = window.__snp.editor.view.state.selection.main; return r.to - r.from; })()`);
    ok('再按一次还是全选（不叠加、不缩小）', sel2 === sel1.len, String(sel2));
  }

  /* ---------- 语言覆盖面：类型表是唯一真源 ----------
     以前 .jsonl / .kt 这类扩展名「不在表里」就一路掉到纯文本，
     界面上完全看不出区别。这里量的是「编辑区真的产生了着色 span」。 */
  {
    const probes = [
      ['p1.jsonl', '{"id": 1, "name": "a"}\n{"id": 2, "name": "b"}\n', 'JSON Lines'],
      ['p2.js', 'const a = 1;\nfunction f() { return a; }\n', 'JavaScript'],
      ['p3.kt', 'fun main() {\n    val a = 1\n    println(a)\n}\n', 'Kotlin'],
      ['p4.toml', 'name = "x"\n[table]\nkey = 1\n', 'TOML'],
    ];
    for (const [name, body, label] of probes) {
      await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(body)}, null)`);
      await sleep(420);
      const n = await ev(`document.querySelectorAll('#editor .cm-line span').length`);
      ok(`${label}：编辑区有语法着色`, n > 0, `${n} 个 span`);
    }

    /* 非 md 的预览 = 同一个编辑器锁住输入。以前这里换成 <pre class="codeview">，
       行号、滚动、查找全变成另一套 —— 用户要的只是「不能改」，不是「换个样子」。 */
    await ev(`window.__snp.newTab('pv.jsonl', '{"a": 1}\\n{"b": 2}', null)`);
    await sleep(320);
    await ev(`(() => { window.__cmBefore = document.querySelector('#editor .cm-editor'); return 1; })()`);
    await ev(`window.__snp.commands.modePreview()`);
    await sleep(320);
    const pv = await ev(`(() => {
      const ed = document.getElementById('editor');
      const pane = document.getElementById('preview');
      const cm = ed && ed.querySelector('.cm-editor');
      return {
        visible: !!cm && ed.offsetParent !== null,
        same: window.__cmBefore === cm,
        ce: cm ? cm.querySelector('.cm-content').getAttribute('contenteditable') : null,
        gutters: ed ? ed.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length : 0,
        paneHidden: !pane || pane.offsetParent === null,
        codeview: !!(pane && pane.querySelector('.codeview')),
      };
    })()`);
    ok('JSON Lines 预览不换 DOM：还是那个编辑器，行号还在',
      pv.visible && pv.same && pv.gutters > 1 && pv.paneHidden && !pv.codeview, JSON.stringify(pv));
    ok('JSON Lines 预览是只读的', pv.ce === 'false', String(pv.ce));

    /* 真敲一下才作数：contenteditable 可能写着 false 却仍能改 */
    const lineAt = async () => ev(`(() => {
      const line = document.querySelector('#editor .cm-line');
      const b = (line || document.getElementById('editor')).getBoundingClientRect();
      return { x: Math.round(b.left + 24), y: Math.round(b.top + Math.round(b.height / 2)) };
    })()`);
    const clickEditor = async () => {
      const p = await lineAt();
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(150);
    };
    const cmText = () => ev(`document.querySelector('#editor .cm-content').textContent`);
    const beforeText = await cmText();
    await clickEditor();
    await send('Input.insertText', { text: 'ZZZ' });
    await sleep(260);
    ok('只读预览里敲字改不动正文', (await cmText()) === beforeText, JSON.stringify(beforeText));

    await ev(`window.__snp.commands.modeEdit()`);
    await sleep(320);
    const ed2 = await ev(`(() => {
      const cm = document.querySelector('#editor .cm-editor');
      return cm ? cm.querySelector('.cm-content').getAttribute('contenteditable') : null;
    })()`);
    await clickEditor();
    await send('Input.insertText', { text: 'ZZZ' });
    await sleep(260);
    ok('切回编辑模式就又能写了', ed2 === 'true' && (await cmText()).includes('ZZZ'), String(ed2));
  }

  /* ---------- 新建文档：类型够多 + 自定义扩展名 ---------- */
  {
    /* 末尾补 `; 0`：commands.new() 返回的 promise 要等对话框关闭才 resolve，
       直接 await 会把 CDP 求值卡死在这里 */
    await ev(`window.__snp.commands.new(); 0`);
    await sleep(260);
    const grid = await ev(`(() => {
      const cells = document.querySelectorAll('.new-types .new-type');
      const input = document.querySelector('.new-ext');
      const go = document.querySelector('.new-go');
      return { n: cells.length, hasInput: !!input, disabled: !!go && go.disabled };
    })()`);
    ok('新建网格列出的类型 ≥ 28', grid.n >= 28, String(grid.n));
    ok('新建网格有自定义扩展名输入', grid.hasInput);
    ok('没填扩展名时「创建」不可点', grid.disabled);

    const made = await ev(`(async () => {
      const input = document.querySelector('.new-ext');
      input.value = 'kt';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const go = document.querySelector('.new-go');
      const enabled = !go.disabled;
      go.click();
      await new Promise((r) => setTimeout(r, 260));
      return { enabled, name: window.__snp.getActiveTab().name };
    })()`);
    ok('填了扩展名后「创建」可点', made.enabled);
    ok('自定义类型建出 未命名.kt', made.name === '未命名.kt', made.name);
  }

  /* ---------- 新建完光标与焦点：不用先点一下正文 ---------- */
  {
    /* 对话框关闭时焦点留在隐藏的弹层按钮上，新建完曾经得先点一下才能打字。
       这里走真实面板点 Markdown，再用 CDP 真输入验证，而不是只查 activeElement。 */
    await ev(`window.__snp.commands.new(); 0`);
    await sleep(260);
    await ev(`(() => {
      const c = document.querySelector('.new-types .new-type[data-dialog-close="md"]');
      c.focus();
      c.click();
      return 1;
    })()`);
    await sleep(320);
    /* 新建 md 的默认模式跟着 lastMode 走，真机探针跑到这里时它常被前面的用例
       留在 edit。断言按「当前模式对应的编辑区」分派，两种模式都得能直接打字。 */
    const f = await ev(`(() => {
      const root = window.__snp.editor.root;
      const sel = window.getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0) : null;
      const first = root.firstElementChild;
      const mode = window.__snp.getActiveTab().mode;
      const focused = mode === 'wysiwyg'
        ? document.activeElement === root
        : document.activeElement === document.querySelector('.cm-content');
      const atFirst = mode === 'wysiwyg'
        ? !!(r && first && r.collapsed && r.startOffset === 0 &&
             (r.startContainer === first || first.contains(r.startContainer)))
        : window.__snp.plain.selection.from === 0;
      return { name: window.__snp.getActiveTab().name, mode, focused, atFirst };
    })()`);
    ok('真机：面板新建空文档后焦点就在当前模式的编辑区', f.focused, JSON.stringify(f));
    ok('真机：空文档光标在第一个位置', f.atFirst, JSON.stringify(f));
    await send('Input.insertText', { text: '甲' });
    await sleep(160);
    const got = await ev(`(() => {
      const t = window.__snp.getActiveTab();
      return t.mode === 'wysiwyg' ? window.__snp.editor.toMarkdown() : window.__snp.getEditorText();
    })()`);
    ok('真机：不点正文直接打字就进了文档', String(got).includes('甲'), JSON.stringify(got));

    /* 显式钉成所见即所得：不管 lastMode 被环境改成什么，这条路径都要真机覆盖 */
    await ev(`window.__snp.newTab('focus-wys.md', '', null, { mode: 'wysiwyg' })`);
    await sleep(220);
    const w = await ev(`(() => {
      const root = window.__snp.editor.root;
      const r = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
      const first = root.firstElementChild;
      return {
        mode: window.__snp.getActiveTab().mode,
        focused: document.activeElement === root,
        atFirst: !!(r && first && r.collapsed && r.startOffset === 0 &&
                    (r.startContainer === first || first.contains(r.startContainer))),
      };
    })()`);
    ok('真机：所见即所得新建空文档，焦点与首块光标都到位', w.mode === 'wysiwyg' && w.focused && w.atFirst,
      JSON.stringify(w));
    await send('Input.insertText', { text: '乙' });
    await sleep(140);
    ok('真机：所见即所得下不点正文直接打字就进第一块',
      (await ev('window.__snp.editor.toMarkdown()')) === '乙',
      JSON.stringify(await ev('window.__snp.editor.toMarkdown()')));

    /* 文件树新建空文件 / 打开空文件走的是 newTab 的普通编辑器那条路 */
    await ev(`window.__snp.newTab('focus-tree.py', '', null)`);
    await sleep(220);
    const p = await ev(`(() => ({
      mode: window.__snp.getActiveTab().mode,
      focused: document.activeElement === document.querySelector('.cm-content'),
    }))()`);
    ok('真机：新建代码文档焦点在纯文本编辑区', p.mode === 'edit' && p.focused, JSON.stringify(p));
    await send('Input.insertText', { text: 'x' });
    ok('真机：代码文档也不用先点一下', (await ev('window.__snp.getEditorText()')) === 'x',
      JSON.stringify(await ev('window.__snp.getEditorText()')));
  }

  /* ---------- 关闭提示：Y 保存 / N 不保存 / Esc 取消（真实按键） ---------- */
  {
    const dlgHidden = () => ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`);
    const tabCount = () => ev(`document.querySelectorAll('.tab[data-id]').length`);
    const realKey = async (key, code, vk) => {
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(240);
    };
    const openDirty = async (name, filePath) => {
      await ev(`(() => {
        window.__snp.newTab(${JSON.stringify(name)}, '原文', ${JSON.stringify(filePath)});
        window.__snp.setContent('改过的正文');
        window.__snp.commands.closeTab();
        return 1;
      })()`);
      await sleep(240);
    };
    const before = await tabCount();

    await openDirty('key-esc.md', null);
    const caps = await ev(`[...document.querySelectorAll('#dlgFoot button')].map(b => b.dataset.key)`);
    ok('真机：关闭提示三个按钮带 Y / N / Esc 键帽', caps.join(',') === 'Y,N,Esc', JSON.stringify(caps));
    await realKey('Escape', 'Escape', 27);
    const escState = await ev(`(() => ({
      hidden: document.getElementById('dlgOverlay').classList.contains('hidden'),
      title: document.getElementById('dlgTitle').textContent,
      keys: [...document.querySelectorAll('#dlgFoot button')].map(b => b.dataset.key || null),
      active: document.activeElement && (document.activeElement.id || document.activeElement.className),
    }))()`);
    ok('真机：Esc 取消关闭，标签还在',
      escState.hidden && (await tabCount()) === before + 1,
      JSON.stringify({ ...escState, tabs: await tabCount(), before }));

    await openDirty('key-n.md', null);
    await realKey('n', 'KeyN', 78);
    ok('真机：N 不保存，直接关掉标签',
      (await dlgHidden()) && (await tabCount()) === before + 1,
      `tabs=${await tabCount()} hidden=${await dlgHidden()}`);

    /* Y 会给没有路径的标签弹系统保存框（CDP 关不掉），所以给它一个真实文件 */
    const yPath = path.resolve('node_modules/.tmp/probe-keys.md').replace(/\\/g, '/');
    fs.mkdirSync(path.dirname(yPath), { recursive: true });
    fs.writeFileSync(yPath, '原文', 'utf8');
    await openDirty('key-y.md', yPath);
    await realKey('y', 'KeyY', 89);
    await sleep(450);
    const disk = fs.readFileSync(yPath, 'utf8');
    ok('真机：Y 保存并关掉标签，改动真的落盘',
      (await dlgHidden()) && (await tabCount()) === before + 1 && disk.includes('改过的正文'),
      JSON.stringify({ disk: disk.slice(0, 40), tabs: await tabCount(), hidden: await dlgHidden() }));
  }

  /* ---------- 格式化走 prettier（懒加载） ---------- */
  {
    /* 第一次按会现拉 2 MB 的引擎，等久一点 */
    await ev(`window.__snp.newTab('fmt.json', '{"a":1,"b":[1,2],"c":{"d":true}}', null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(1400);
    const json2 = await ev(`window.__snp.getEditorText()`);
    ok('JSON 被 prettier 重排成两空格缩进', /\n {2}"a": 1,/.test(json2), JSON.stringify(json2.slice(0, 40)));

    await ev(`window.__snp.newTab('fmt.md', '# 标题\\n正文一行\\n- a\\n', null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(1200);
    const md2 = await ev(`window.__snp.getEditorText()`);
    ok('Markdown 标题后补了空行（prettier 行为）', /# 标题\n\n正文一行/.test(md2), JSON.stringify(md2));

    /* prettier 不管的语言：只做保守清理，绝不重排缩进 */
    await ev(`window.__snp.newTab('fmt.py', 'def f():   \\n    return 1   \\n', null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(900);
    const py2 = await ev(`window.__snp.getEditorText()`);
    ok('Python 只去行尾空格，缩进原样', py2 === 'def f():\n    return 1\n', JSON.stringify(py2));

    /* ---------- 不标准的文本：严格 → 宽松 → 只重排空白 ---------- */
    const NL = String.fromCharCode(10);
    const badJson = '{ "a":1,';
    const cmtJson = ['{ "a":1, // hi', ' "b":2 }'].join(NL);
    const cssSrc = 'a{color:red}';

    await ev(`window.__snp.newTab('fmt-bad.json', ${JSON.stringify(badJson)}, null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(1100);
    const bad2 = await ev(`window.__snp.getEditorText()`);
    ok('真机：残缺 JSON 也强行按深度缩进', bad2.includes(NL + '  "a":1,'), JSON.stringify(bad2));
    ok('真机：残缺 JSON 的非空白字符一字不变',
      bad2.replace(/[ \t\r\n]/g, '') === badJson.replace(/[ \t\r\n]/g, ''), JSON.stringify(bad2));
    ok('真机：不再弹「无法格式化」把人挡在门外',
      await ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`),
      String(await ev(`document.getElementById('dlgTitle').textContent`)));
    ok('真机：提示里说明只调整了空白',
      await ev(`/仅调整空白|whitespace/i.test(document.getElementById('toasts').textContent)`),
      String(await ev(`document.getElementById('toasts').textContent`)));
    ok('真机：强行排版仍可撤销',
      await ev(`[...document.querySelectorAll('#toasts .toast')].some(b => b.textContent.includes('撤销'))`));

    await ev(`window.__snp.newTab('fmt-cmt.json', ${JSON.stringify(cmtJson)}, null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(900);
    const cmt2 = await ev(`window.__snp.getEditorText()`);
    ok('真机：宽松 parser 接住带注释的 JSON，注释还在',
      cmt2.includes('// hi') && cmt2.includes('"b": 2'), JSON.stringify(cmt2));

    /* 以前写的是插件名 postcss，不是 parser 名，CSS 格式化一直报错 */
    await ev(`window.__snp.newTab('fmt.css', ${JSON.stringify(cssSrc)}, null)`);
    await sleep(260);
    await ev(`window.__snp.commands.format(); 0`);
    await sleep(900);
    const css2 = await ev(`window.__snp.getEditorText()`);
    ok('真机：CSS 用真正的 parser 名格式化成功', css2.includes('color: red;'), JSON.stringify(css2));
  }

  /* ---------- ```mermaid：真的画出来 ----------
     纯逻辑测不了：它要 import 5 MB 的引擎、按主题配色、把 SVG 贴回 DOM。
     这里量的是「预览里真的出现了 <svg>，而且源码块没了」。 */
  {
    const md = ['# 图', '', '```mermaid', 'flowchart LR', '  A[开始] --> B[结束]', '```', ''].join('\n');
    await ev(`window.__snp.newTab('mmd.md', ${JSON.stringify(md)}, null)`);
    await sleep(420);
    await ev('window.__snp.commands.modePreview()');
    /* 首次要加载引擎（5 MB）+ 布局，给足 6 秒 */
    let figs = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      figs = await ev(`document.querySelectorAll('#preview .mermaid-fig svg').length`);
      if (figs) break;
    }
    const left = await ev(`document.querySelectorAll('#preview pre code.lang-mermaid').length`);
    ok('mermaid 代码块在预览里变成真 SVG', figs === 1, `${figs} 个图 / 剩 ${left} 个源码块`);
    ok('原来的源码块被图替换掉', left === 0);

    /* 画不出来时要留下原因和源码，不能静默消失 */
    await ev(`window.__snp.newTab('mmd-bad.md', '# 坏图\\n\\n\`\`\`mermaid\\nthis is not a diagram\\n\`\`\`', null)`);
    await sleep(300);
    await ev('window.__snp.commands.modePreview()');
    await sleep(1500);
    const bad = await ev(`(() => ({
      err: !!document.querySelector('#preview .mermaid-err'),
      src: document.querySelectorAll('#preview pre code.lang-mermaid').length,
    }))()`);
    ok('画不出来的 mermaid 留下错误提示和源码', bad.err && bad.src === 1, JSON.stringify(bad));
  }

  /* ---------- 导出 PDF：真的落成一个 PDF 文件 ----------
     这条以前没法测，因为走的是 window.print()（WebView2 里压根不弹框）。
     现在写死路径调用 exportPdfTo，绕开系统保存框。 */
  {
    const out = path.join(os.tmpdir(), 'eznotepad-probe', 'probe-export.pdf');
    try { fs.unlinkSync(out); } catch { /* 上次没留 */ }
    const md = ['# 导出', '', '正文一段。', '', '```js', 'const a = 1;', '```'].join('\n');
    await ev(`window.__snp.newTab('pdf.md', ${JSON.stringify(md)}, null)`);
    await sleep(300);
    await ev('window.__snp.commands.modePreview()');
    await sleep(500);
    const before = await ev(`document.body.dataset.theme`);
    await ev(`window.__snp.exportPdfTo(${JSON.stringify(out)})`);
    await sleep(1200);
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    const head = size ? fs.readFileSync(out).subarray(0, 5).toString('latin1') : '';
    ok('导出 PDF 真的写了文件', size > 2000 && head === '%PDF-', `${size} 字节 / ${head}`);
    const after = await ev(`(() => ({
      theme: document.body.dataset.theme,
      busy: !!document.querySelector('.pdf-busy'),
      print: document.getElementById('printRoot').innerHTML.length,
    }))()`);
    ok('导出后主题还原、遮罩收起、打印容器清空',
      after.theme === before && !after.busy && after.print === 0, JSON.stringify(after));
  }

  /* ---------- 导出 PDF 必须分页，不能只剩第一页 ----------
     2026-11-07 用户报「只能导出一页，后面内容没了」。根因是屏幕布局
     html/body{height:100%;overflow:hidden;display:flex} 在 @media print 下
     没解除，整篇文档被裁进第一个视口高度。两条断言一条量布局、一条量
     真实 PDF 的 /Type /Page 对象数，只改 CSS 不真的导出是抓不到的。 */
  {
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    const pm = await ev(`(() => {
      const s = getComputedStyle(document.body);
      const h = getComputedStyle(document.documentElement);
      return { h: s.height, ov: s.overflow, d: s.display, htmlOv: h.overflow };
    })()`);
    await send('Emulation.setEmulatedMedia', { media: '' });   // 空串 = 取消模拟
    ok('打印媒体下不再锁死视口高度 / 隐藏溢出',
      pm.ov === 'visible' && pm.htmlOv === 'visible' && pm.d === 'block', JSON.stringify(pm));

    const out = path.join(os.tmpdir(), 'eznotepad-probe', 'probe-export-long.pdf');
    const md = Array.from({ length: 90 }, (_, i) =>
      `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 段的正文内容，用来把版面撑过好几页 A4 纸，检查分页是否完整。`).join('\n\n');
    await ev(`window.__snp.newTab('long.md', ${JSON.stringify(md)}, null)`);
    await ev(`window.__snp.commands.modePreview()`);
    await ev(`window.__snp.exportPdfTo(${JSON.stringify(out)})`);
    await sleep(300);
    const txt = fs.existsSync(out) ? fs.readFileSync(out).toString('latin1') : '';
    const pages = (txt.match(/\/Type\s*\/Page\b/g) || []).length;
    ok('长文档导出成多页 PDF（不是只留第一页）', pages >= 3,
      `页数 ${pages} / ${txt.length} 字节`);
  }

  /* ---------- 切标签 / 关标签不许串档 ----------
     2026-11-05 的真机 bug：编辑器 DOM 属于上一个标签，而 activeTab() 已经是新标签，
     于是「把 DOM 序列化回 content」这一步把上一篇写进了下一篇。
     真机表现：清空速记之后，速记里出现了刚才那篇文档的内容。 */
  {
    await ev(`window.__snp.newTab('cross-a.md', '# A 文档\\n\\nA 的内容。', null)`);
    await sleep(300);
    await ev(`window.__snp.newTab('cross-b.md', '# B 文档\\n\\nB 的内容。', null)`);
    await sleep(300);
    const back = await ev(`(async () => {
      const el = [...document.querySelectorAll('.tab')].find((t) => (t.title || '').includes('cross-a.md'));
      el.click();
      await new Promise((r) => setTimeout(r, 400));
      /* 三种模式各自显示在不同容器里：只读「当前看得见的那一坨」 */
      const w = document.getElementById('wysiwyg');
      const shown = (w && !w.classList.contains('hidden')) ? w.innerText
        : (document.querySelector('.cm-content')?.innerText || document.getElementById('preview').innerText);
      return { content: window.__snp.getEditorText(), shown };
    })()`);
    ok('切回 A 时 A 的内容没被 B 覆盖',
      String(back.content).includes('A 的内容') && !String(back.content).includes('B 的内容'),
      JSON.stringify(back.content));
    ok('屏幕上显示的也是 A', String(back.shown).includes('A 的内容') && !String(back.shown).includes('B 的内容'));

    /* 关掉 B（后台标签，没有未保存修改）：A 的内容也不能变 */
    await ev(`(() => {
      const el = [...document.querySelectorAll('.tab')].find((t) => (t.title || '').includes('cross-b.md'));
      el.querySelector('.tab-close').click();
      return 1;
    })()`);
    await sleep(500);
    const after = await ev(`window.__snp.getEditorText()`);
    ok('关掉另一个标签后，当前标签的内容原样',
      String(after).includes('A 的内容') && !String(after).includes('B 的内容'), JSON.stringify(after));
  }

  /* ---------- 表格：只读渲染 + 点一下回源码 ----------
     旧内核的表格是 contenteditable 单元格，于是有一整类「单元格里选中后加不上
     格式」的问题（选区落在 <td> 里，命令见到单元格就整条返回）。新内核里表格
     是只读 widget，点一下整块退回源码 —— 之后就是普通的行内编辑，格式和正文
     走同一条路，不需要单元格那一套特例。 */
  {
    await ev(`window.__snp.newTab('cell-mark.md', '', null, { mode: 'wysiwyg' })`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(300);
    await ev(`window.__snp.setContent('前\\n\\n| 姓名 | 城市 |\\n| --- | --- |\\n| 张三 | 北京 |\\n\\n后\\n')`);
    await sleep(700);

    /* 光标移出表格：光标在表里时整块按源码显示（那是编辑入口） */
    await ev(`window.__snp.editor.setSelection(0)`);
    await sleep(400);
    const tbl = await ev(`(() => {
      const t = document.querySelector('#wysiwyg .cm-lp-table');
      return {
        has: !!t,
        ths: t ? [...t.querySelectorAll('th')].map((x) => x.textContent) : [],
        tds: t ? [...t.querySelectorAll('td')].map((x) => x.textContent) : [],
      };
    })()`);
    ok('表格渲染成真表格（表头 + 单元格）',
      tbl.has && tbl.ths.join('|') === '姓名|城市' && tbl.tds.join('|') === '张三|北京', JSON.stringify(tbl));

    /* 点一下表格 → 退回源码，可以按字改 */
    const tg = await ev(`(() => {
      const r = document.querySelector('#wysiwyg .cm-lp-table').getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tg.x, y: tg.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tg.x, y: tg.y, button: 'left', clickCount: 1 });
    await sleep(350);
    ok('点一下表格回源码（可以直接改字）',
      (await ev(`!!document.querySelector('#wysiwyg .cm-lp-table-src')`)) === true);

    /* 源码态：选中「张三」加高亮，写回 ==…== */
    const a1 = String(await ev(`window.__snp.getEditorText()`)).indexOf('张三');
    await ev(`window.__snp.editor.setSelection(${a1}, ${a1 + 2})`);
    await sleep(150);
    await ev(`window.__snp.commands.highlight()`);
    await sleep(340);
    const one = await ev(`window.__snp.getEditorText()`);
    ok('源码态选中后能加高亮', /==张三==/.test(one), JSON.stringify(one));

    /* 再点一次取消 */
    const b1 = String(await ev(`window.__snp.getEditorText()`)).indexOf('==张三==');
    await ev(`window.__snp.editor.setSelection(${b1 + 2}, ${b1 + 4})`);
    await sleep(150);
    await ev(`window.__snp.commands.highlight()`);
    await sleep(340);
    const off = await ev(`window.__snp.getEditorText()`);
    ok('再点一次取消高亮', !/==/.test(off), JSON.stringify(off));
  }

  /* ---------- 编辑区三条视图能力（真机 WebView2） ----------
     这里验「浏览器真的这么画」：computed 色值、CSS Custom Highlight 注册表、
     以及右键高亮在非 Markdown 文件里不再往内容里塞 ==。 */
  {
    const alphaOf = (c) => {
      const m = String(c).match(/\/\s*([\d.]+)\s*\)/);
      if (m) return +m[1];
      const s = String(c);
      const p = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')).split(',').map(Number);
      return p.length === 4 ? p[3] : -1;
    };
    await ev(`window.__snp.newTab('view.md', '红 蓝 红 绿 红', null, { mode: 'edit' })`);
    await sleep(220);
    const lineBg = await ev(`(() => {
      const el = document.querySelector('.cm-activeLine');
      if (!el) return { bg: '', want: '' };
      const p = document.createElement('div');
      p.style.backgroundColor = 'var(--active-line-bg)';
      document.body.appendChild(p);
      const want = getComputedStyle(p).backgroundColor;
      p.remove();
      return { bg: getComputedStyle(el).backgroundColor, want };
    })()`);
    ok('真机：当前行底色走 --active-line-bg', !!lineBg.bg && lineBg.bg === lineBg.want,
      JSON.stringify(lineBg));
    ok('真机：当前行底色够淡（alpha ≤ 0.08）',
      alphaOf(lineBg.bg) > 0 && alphaOf(lineBg.bg) <= 0.08, lineBg.bg);

    /* 编辑模式：选中一个字也把相同的字一并标出来。
       ⚠️ @codemirror/search 的 getDeco 只装饰「选区之外」的命中
       （from >= range.to || to <= range.from），主选区那处由选区底色自己画，
       不挂 .cm-selectionMatch。三个「红」选中第一个，答案就是 2 而不是 3。
       所见即所得的 sn-same 是 3，因为它把选中的那一处也算进去了。 */
    await ev(`window.__snp.plain.setSelection(0, 1)`);
    await sleep(220);
    const cmSame = await ev(`(() => {
      const els = [...document.querySelectorAll('.cm-selectionMatch')];
      return { n: els.length, allRed: els.length > 0 && els.every((e) => e.textContent === '红') };
    })()`);
    ok('真机：编辑模式把选中之外的两处「红」一并标出',
      cmSame.n === 2 && cmSame.allRed, JSON.stringify(cmSame));
    await ev(`window.__snp.plain.setSelection(0)`);
    await sleep(220);
    ok('真机：光标折叠后清掉匹配',
      (await ev(`document.querySelectorAll('.cm-selectionMatch').length`)) === 0);

    /* 所见即所得用的是同一个 CM6 机制（highlightSelectionMatches），
       只是装饰落在 #wysiwyg 里。同样不算选中的那一处，所以是三处里的两处 */
    await ev('window.__snp.commands.modeWysiwyg()');
    await sleep(400);
    const redPos = String(await ev('window.__snp.getEditorText()')).indexOf('红');
    await ev(`window.__snp.editor.setSelection(${redPos}, ${redPos + 1})`);
    await sleep(260);   // selectionchange → rAF → updateSelMatch
    const same = await ev(`(() => {
      const els = [...document.querySelectorAll('#wysiwyg .cm-selectionMatch')];
      return { n: els.length, allRed: els.length > 0 && els.every((e) => e.textContent === '红') };
    })()`);
    ok('真机：所见即所得把另外两处「红」标出来',
      same.n === 2 && same.allRed, JSON.stringify(same));
    ok('真机：标相同文本不改内容',
      (await ev('window.__snp.getEditorText()')) === '红 蓝 红 绿 红');
    ok('真机：标相同文本没往 DOM 插 mark',
      (await ev(`document.querySelectorAll('#wysiwyg mark').length`)) === 0);

    /* 非 Markdown 文件：视图高亮，不再写 == */
    await ev(`window.__snp.newTab('view.txt', '重点 重点 重点', null, { mode: 'edit' })`);
    await sleep(240);
    await ev(`window.__snp.plain.setSelection(0, 2)`);
    await ev(`window.__snp.commands.highlight(); 0`);
    await sleep(180);
    const txt = await ev('window.__snp.getEditorText()');
    ok('真机：非 md 高亮不往文件写 ==', txt === '重点 重点 重点', JSON.stringify(txt));
    ok('真机：编辑区真的显示黄底',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 1);
    await ev(`window.__snp.commands.highlight(); 0`);
    await sleep(180);
    ok('真机：再点一次取消',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 0);

    await ev(`window.__snp.newTab('eq.py', 'a == b', null, { mode: 'edit' })`);
    await sleep(240);
    await ev(`window.__snp.plain.setSelection(2, 4)`);
    await ev(`window.__snp.commands.highlight(); 0`);
    await sleep(180);
    ok('真机：代码里的 == 不被当成已高亮',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 1
        && (await ev('window.__snp.getEditorText()')) === 'a == b');
  }

  /* ---------- 侧栏：在文件列表中定位当前文件 ----------
     照 IDEA 的 Select Opened File：展开父目录 → 滚到可见 → 闪三下。
     这里用三层深的真文件，且先把侧栏切到大纲页，模拟「用户不知道文件在哪」。 */
  {
    const root = path.join(os.tmpdir(), 'eznotepad-probe', 'locate-demo');
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    for (const f of ['top.md', 'a/one.md', 'a/b/two.md']) {
      const fp = path.join(root, f);
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, '# ' + f + '\n\n正文\n', 'utf8');
    }
    const win = (x) => x.replace(/\//g, '\\');
    const target = win(path.join(deep, 'two.md'));

    const btn = await ev(`(() => {
      const b = document.getElementById('sideLocate');
      if (!b) return { exists: false };
      const r = b.getBoundingClientRect();
      const tr = document.querySelector('.side-tabs').getBoundingClientRect();
      return { exists: true, visible: r.width > 0, icon: b.querySelector('use').getAttribute('href'),
        rightOfTabs: r.left >= tr.right - 1 };
    })()`);
    ok('侧栏页签右边有定位按钮', btn.exists && btn.visible && btn.rightOfTabs, JSON.stringify(btn));
    ok('定位按钮用的是 locate 准星图标', btn.icon === '#i-locate', String(btn.icon));

    await ev(`window.__snp.openPath(${JSON.stringify(target)})`);
    await sleep(800);
    await ev(`(async () => { await window.__snp.setFolder(${JSON.stringify(win(root))}); return 1; })()`);
    await sleep(500);
    await ev(`document.querySelector('[data-side="outline"]').click()`);
    await sleep(250);
    const before = await ev(`(() => ({
      onFiles: !document.getElementById('sideFiles').classList.contains('hidden'),
      hasRow: [...document.querySelectorAll('#ftBody .ft-row')].some((r) => r.dataset.path === ${JSON.stringify(target)}),
    }))()`);
    ok('前置：停在大纲页，深层那一行还没展开', !before.onFiles && !before.hasRow, JSON.stringify(before));

    await ev(`document.getElementById('sideLocate').click()`);
    await sleep(650);
    const after = await ev(`(() => {
      const row = [...document.querySelectorAll('#ftBody .ft-row')].find((r) => r.dataset.path === ${JSON.stringify(target)});
      const body = document.getElementById('ftBody').getBoundingClientRect();
      const rr = row ? row.getBoundingClientRect() : null;
      return {
        onFiles: !document.getElementById('sideFiles').classList.contains('hidden'),
        found: !!row,
        active: !!(row && row.classList.contains('active')),
        flash: !!(row && row.classList.contains('ft-flash')),
        inView: !!(rr && rr.top >= body.top - 2 && rr.bottom <= body.bottom + 2),
      };
    })()`);
    ok('点定位后切到文件页并展开到那一行', after.onFiles && after.found, JSON.stringify(after));
    ok('定位到的那一行点亮、在视野里、正在闪',
      after.active && after.inView && after.flash, JSON.stringify(after));

    await sleep(1200);
    await ev(`document.getElementById('sideLocate').click()`);
    await sleep(260);
    const again = await ev(`(() => {
      const row = [...document.querySelectorAll('#ftBody .ft-row')].find((r) => r.dataset.path === ${JSON.stringify(target)});
      return !!(row && row.classList.contains('ft-flash'));
    })()`);
    ok('已经是当前文件时仍然闪一下', again, String(again));
  }

  /* ---------- 菜单文案：不弹框的项后面不该有省略号 ----------
     用户原话：「导出pdf，导出网页，历史版本，这些菜单后面没必要跟…」 */
  {
    const labels = await ev(`(async () => {
      const bar = [...document.querySelectorAll('.am-btn')];
      const btn = bar.find((b) => b.textContent === '文件');
      btn.click();
      await new Promise((r) => setTimeout(r, 150));
      const panel = document.querySelector('.appmenu');
      const out = [...panel.querySelectorAll('.am-item .am-label')].map((n) => n.textContent);
      btn.click();
      return out;
    })()`);
    ok('导出 PDF / 导出网页 / 历史版本 不再带省略号',
      ['导出 PDF', '导出网页（HTML）', '历史版本'].every((s) => labels.includes(s)),
      JSON.stringify(labels));
    ok('「在文件夹中显示」紧跟在「打开文件夹」下面',
      labels.indexOf('在文件夹中显示') === labels.indexOf('打开文件夹…') + 1, JSON.stringify(labels));
  }

  /* ---------- 两个右键菜单的新命令（真机 WebView2） ----------
     复制路径必须真机验：navigator.clipboard.writeText 在这儿会抛
     NotAllowedError，旧实现还照样弹「路径已复制」。 */
  {
    const ctxLabels = () => ev(`[...document.querySelectorAll('.ctx-menu .ctx-item')]
      .map(b => ({ label: b.querySelector('.ctx-label').textContent, disabled: b.disabled }))`);
    const clickCtx = (label) => ev(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu .ctx-item')]
        .find(x => x.querySelector('.ctx-label').textContent === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`);
    const rightClickAt = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
      await sleep(260);
    };
    /* 真读系统剪贴板：离屏 textarea + 真实 Ctrl+V，paste 事件或 value 都认 */
    const readClip = async () => {
      await ev(`(() => {
        window.__clipProbe = null;
        const ta = document.createElement('textarea');
        ta.id = 'snClipProbe';
        ta.style.cssText = 'position:fixed;left:8px;top:90px;width:280px;height:30px;z-index:99999';
        ta.addEventListener('paste', (e) => {
          window.__clipProbe = e.clipboardData && e.clipboardData.getData('text');
          e.preventDefault();
        });
        document.body.appendChild(ta);
        ta.focus();
        return 1;
      })()`);
      const k = { modifiers: 2, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      await sleep(350);
      const v = await ev(`window.__clipProbe === null
        ? document.getElementById('snClipProbe').value : window.__clipProbe`);
      await ev(`document.getElementById('snClipProbe')?.remove(); 1`);
      return v;
    };

    /* 标签右键：M 是中间那个，左右都有可关的目标 */
    await ev(`(() => {
      window.__snp.newTab('ctx-L.md', 'L', 'C:/tmp/ctx-L.md');
      window.__snp.newTab('ctx-M.md', 'M', 'C:/tmp/ctx-M.md');
      window.__snp.newTab('ctx-R.md', 'R', 'C:/tmp/ctx-R.md');
      return 1;
    })()`);
    await sleep(350);
    const tbox = await ev(`(() => {
      const b = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => (x.querySelector('.tab-name')?.textContent || '').includes('ctx-M.md'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    ok('真机：找到中间标签', !!tbox, JSON.stringify(tbox));
    if (tbox) {
      await rightClickAt(tbox.x, tbox.y);
      const tm = await ctxLabels();
      const tl = tm.map(i => i.label);
      ok('真机：标签右键同时有「关闭左侧」和「复制文件路径」',
        tl.includes('关闭左侧') && tl.includes('复制文件路径'), JSON.stringify(tl));
      ok('真机：关闭方向仍是「其他 / 左 / 右」相邻',
        tl.indexOf('关闭左侧') === tl.indexOf('关闭其他') + 1
          && tl.indexOf('关闭右侧') === tl.indexOf('关闭左侧') + 1, JSON.stringify(tl));
      ok('真机：中间标签两侧都可关闭',
        !tm.find(i => i.label === '关闭左侧').disabled
          && !tm.find(i => i.label === '关闭右侧').disabled, JSON.stringify(tm));
      ok('真机：点「复制文件路径」能执行', await clickCtx('复制文件路径'));
      await sleep(250);
      ok('真机：WebView2 里复制真的成功（不再抛 NotAllowedError）',
        await ev(`[...document.querySelectorAll('#toasts .toast')].some(b => b.textContent.includes('路径已复制'))`),
        String(await ev(`document.getElementById('toasts').textContent`)));
      const pastedPath = await readClip();
      ok('真机：剪贴板里就是该标签的完整路径',
        pastedPath === 'C:/tmp/ctx-M.md', JSON.stringify(pastedPath));
    }

    /* 文件树行右键：新开的文件夹里放一个真文件，右键那一行 */
    const ftRoot = path.join(os.tmpdir(), 'eznotepad-probe', 'ctx-path');
    fs.mkdirSync(ftRoot, { recursive: true });
    const ftFile = path.join(ftRoot, 'p.md');
    fs.writeFileSync(ftFile, '# p\n', 'utf8');
    const winRoot = ftRoot.replace(/\//g, '\\');
    const winFile = ftFile.replace(/\//g, '\\');
    await ev(`(async () => { await window.__snp.setFolder(${JSON.stringify(winRoot)}); return 1; })()`);
    await sleep(650);
    await ev(`document.querySelector('[data-side="files"]').click()`);
    await sleep(350);
    const fbox = await ev(`(() => {
      const r = [...document.querySelectorAll('#ftBody .ft-row')]
        .find(x => /p\\.md$/.test(x.dataset.path || ''));
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2), path: r.dataset.path };
    })()`);
    ok('真机：文件树里有目标文件行', !!fbox, JSON.stringify(fbox));
    if (fbox) {
      await rightClickAt(fbox.x, fbox.y);
      const fm = (await ctxLabels()).map(i => i.label);
      ok('真机：文件树行右键有「复制文件路径」', fm.includes('复制文件路径'), JSON.stringify(fm));
      ok('真机：复制路径紧挨「在资源管理器中显示」',
        fm.indexOf('复制文件路径') === fm.indexOf('在资源管理器中显示') - 1, JSON.stringify(fm));
      ok('真机：点文件树复制路径能执行', await clickCtx('复制文件路径'));
      await sleep(250);
      const ftPasted = await readClip();
      ok('真机：文件树复制的是那一行的完整路径',
        ftPasted === winFile, JSON.stringify({ got: ftPasted, want: winFile }));
    }
  }

  /* ---- I4. 标签条竖线：一条缝只画一条线，最右端要封口 ----
     真机 WebView2 把 --bw 的 0.5px 取整成 1px，所以只用 computed 边框宽度
     和相邻 rect 判断，别拿 CSS 里写的 0.5px 当真。 */
  {
    await ev(`(() => { window.__snp.newTab('edge-a.md', 'A'); window.__snp.newTab('edge-b.md', 'B'); return 1; })()`);
    await sleep(450);
    const tg = await ev(`(() => {
      const ts = [...document.querySelectorAll('.tabs .tab')];
      return ts.slice(-3).map(e => {
        const s = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { l: +r.left.toFixed(2), r: +r.right.toFixed(2),
          blw: s.borderLeftWidth, brw: s.borderRightWidth,
          blc: s.borderLeftColor, brc: s.borderRightColor,
          ml: s.marginLeft, act: e.classList.contains('active') };
      });
    })()`);
    ok('真机：中间标签没有右边框（缝里的线只归后一颗）',
      tg.length >= 3 && tg.slice(0, -1).every(x => parseFloat(x.brw) === 0),
      JSON.stringify(tg));
    ok('真机：相邻标签精确相接，不再叠出半像素粗线',
      tg.slice(1).every((x, i) => Math.abs(x.l - tg[i].r) < 0.02 && parseFloat(x.ml) === 0),
      JSON.stringify(tg));
    ok('真机：最右侧标签画出了右边框（不是透明）',
      parseFloat(tg.at(-1).brw) > 0 && tg.at(-1).brc !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(tg.at(-1)));
    ok('真机：激活的最右标签右边框跟着加深',
      tg.at(-1).act && tg.at(-1).brc === tg.at(-1).blc,
      JSON.stringify(tg.at(-1)));
    const firstColor = await ev(`getComputedStyle(document.querySelector('.tabs .tab:first-child')).borderLeftColor`);
    ok('真机：最左侧标签仍不封口', firstColor === 'rgba(0, 0, 0, 0)', firstColor);
  }

  /* ---- I5. ↑ / ↓ 跨块移动：文本内核里就是行与行之间的移动 ----
     旧内核这一整段在守「块末尾那个不可见尾 \n」：pre-wrap 下它不生成可点击的
     行，浏览器往回找上一行时会整块跳过、落到更前面一块去。CM6 的行就是文档里的
    行，↑/↓ 由它自己算「上一行同一列」，那条坑不存在了。这里只验结果：
     跨块能回到块内、只移光标、文档零改动。 */
  {
    const up = async () => {
      const k = { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      await sleep(260);
    };
    const lineOf = () => ev(`(() => {
      const v = window.__snp.editor.view;
      const n = v.state.doc.lineAt(v.state.selection.main.head);
      return { line: n.number, text: n.text };
    })()`);
    const scene = async (name, md) => {
      await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(md)}, null)`);
      await sleep(380);
      await ev('window.__snp.commands.modeWysiwyg()');
      await sleep(500);
    };

    const DOC = ['前面一段', '', '```js', '甲', '乙', '```', '', '后面一段'].join('\n');
    await scene('up-code.md', DOC);
    const md0 = await ev('window.__snp.getEditorText()');
    /* 光标放到代码块后面那一段的行首。三下 ↑ 才进到块里：空行、围栏各停一格
       （新内核里空行、围栏都是文档里真实的行；光标停在围栏上时整块按源码
       显示 —— 和点进代码块是同一个口径，所以那一格看得见、也编得了） */
    await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().indexOf('后面一段'))`);
    await sleep(200);
    await up();
    await up();
    await up();
    const hit = await lineOf();
    ok('↑ 从代码块后一段回到代码块最后一行（第 5 行「乙」）',
      hit.line === 5 && hit.text === '乙', JSON.stringify(hit));
    ok('↑ 只移光标，文档零改动', (await ev('window.__snp.getEditorText()')) === md0);

    /* 普通段落：↑ 就是上一行，不需要任何补丁 */
    await scene('up-plain.md', ['第一行', '第二行', '第三行'].join('\n'));
    await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().indexOf('第三行'))`);
    await sleep(160);
    await up();
    const hit2 = await lineOf();
    ok('段落之间 ↑ 落到上一行', hit2.line === 2 && hit2.text === '第二行', JSON.stringify(hit2));

    /* 折行的长段落：↑ 按视觉列走，落点仍是上一行（不跳块、不丢列） */
    await scene('up-long.md', ['前面一段', '', '甲'.repeat(90), '', '后面一段'].join('\n'));
    const tailPos = await ev(`window.__snp.editor.toMarkdown().indexOf('后面一段')`);
    await ev(`window.__snp.editor.setSelection(${tailPos})`);
    await sleep(180);
    await up();
    await up();          // 第一下落在中间那条空行上，第二下才进折行段落
    const hit3 = await lineOf();
    ok('折行长段落里 ↑ 也留在上一行（第 3 行）', hit3.line === 3, JSON.stringify(hit3));
  }

  /* ---- I6. 文件树选中态 / 分割线独立块 / 文件右键历史版本 ----
     放在整组最后：这几项都会换文档、切模式、开弹层，不能压在别的断言前面。 */
  {
    const dir = path.join(os.tmpdir(), 'eznotepad-probe-ft');
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, body] of [['ft-a.md', '# A\n'], ['ft-b.md', '# B\n'], ['ft-c.md', '# C\n']]) {
      fs.writeFileSync(path.join(dir, n), body);
    }
    await ev(`window.__snp.setFolder(${JSON.stringify(dir)})`);
    await sleep(450);
    await ev(`document.querySelector('[data-side="files"]').click()`);
    const rows = () => ev(`JSON.stringify([...document.querySelectorAll('.ft-row')].map(r => ({ n: r.querySelector('.ft-name').textContent, cls: r.className })))`);
    const clickRow = (n) => ev(`(() => { const r = [...document.querySelectorAll('.ft-row')].find(x => x.querySelector('.ft-name').textContent === ${JSON.stringify(n)}); if (r) r.click(); return !!r; })()`);
    const clickTab = (n) => ev(`(() => { const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(${JSON.stringify(n)})); if (t) t.click(); return !!t; })()`);
    await clickRow('ft-a.md');
    await sleep(300);
    await clickRow('ft-b.md');
    await sleep(300);
    await clickTab('ft-a.md');
    await sleep(350);
    const rs = JSON.parse(await rows());
    const ra = rs.find((x) => x.n === 'ft-a.md');
    const rb = rs.find((x) => x.n === 'ft-b.md');
    ok('真机：从标签栏切回后，只有当前文件点亮',
      !!ra && /\bactive\b/.test(ra.cls) && !/\bsel\b/.test(ra.cls), JSON.stringify(rs));
    ok('真机：旧文件不再残留 .sel 边框与灰底',
      !!rb && !/\bsel\b/.test(rb.cls) && !/\bactive\b/.test(rb.cls), JSON.stringify(rs));

    /* 文件树右键的「历史版本」：对一个没打开的文件也要能看，但不给「恢复」 */
    await ev(`(() => { const r = [...document.querySelectorAll('.ft-row')].find(x => x.querySelector('.ft-name').textContent === 'ft-c.md'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 20, clientY: b.top + 8 })); })()`);
    await sleep(200);
    const ctxItems = await ev(`JSON.stringify([...document.querySelectorAll('.ctx-item')].map(x => x.textContent.trim()))`);
    ok('真机：文件树右键有「历史版本」', JSON.parse(ctxItems).some((t) => t.includes('历史版本')), ctxItems);
    await ev(`(() => { const b = [...document.querySelectorAll('.ctx-item')].find(x => x.textContent.includes('历史版本')); if (b) b.click(); return !!b; })()`);
    await sleep(350);
    ok('真机：未打开文件的历史版本只给查看，不给「恢复」',
      (await ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`)) === false
        && (await ev(`document.querySelectorAll('#dlgOverlay .hist-btn.primary').length`)) === 0);
    await ev(`(() => { const b = document.querySelector('#dlgFoot .mini.primary') || document.getElementById('dlgClose'); if (b) b.click(); })()`);
    await sleep(250);

    /* 分割线：插入时只多一行 `---`，不凭空补空行；点中它退回源码。
       （旧断言按 .w-block[data-type] 逐块比对 —— 新内核里块就是行，
       空行也是行，所以这里比的是**文档文本**，比 DOM 类名稳得多。） */
    await ev(`window.__snp.newTab('hr-block.md', ${JSON.stringify('# T\n\n甲\n\n乙\n')}, null)`);
    await sleep(300);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(450);
    await ev(`window.__snp.editor.setSelection(window.__snp.editor.toMarkdown().indexOf('甲') + 1)`);
    await sleep(150);
    await ev(`window.__snp.commands.hr()`);
    await sleep(350);
    ok('真机：插入分割线只多一行 ---，不凭空补空行',
      (await ev('window.__snp.getEditorText()')) === '# T\n\n甲\n\n---\n\n乙\n',
      JSON.stringify(await ev('window.__snp.getEditorText()')));
    ok('真机：插入后光标就在分割线那一行',
      (await ev(`window.__snp.editor.lineText`)) === '---',
      JSON.stringify(await ev(`window.__snp.editor.lineText`)));

    /* 光标移开就画成一条线 */
    await ev(`window.__snp.editor.setSelection(0)`);
    await sleep(350);
    ok('真机：分割线渲染成一条线', (await ev(`document.querySelectorAll('#wysiwyg .cm-lp-hr hr').length`)) === 1);

    /* 点一下这条线 → 退回源码，可以改 / 删 */
    const hrRect = await ev(`(() => {
      const h = document.querySelector('#wysiwyg .cm-lp-hr');
      const b = h.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hrRect.x, y: hrRect.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hrRect.x, y: hrRect.y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(300);
    ok('真机：点中分割线退回源码（可直接编辑）',
      (await ev(`document.querySelectorAll('#wysiwyg .cm-lp-hr-src').length`)) === 1,
      JSON.stringify(await ev(`window.__snp.editor.lineText`)));

    /* 合并窗口在 Rust 侧，只有真调后端才验得到。用唯一路径，免得历次探针
       留下的快照混进条数。这里存的是「即将被覆盖的旧版」，所以合并应当跳过、
       保留会话起点那一版，而不是拿新内容覆盖它。 */
    const hp = path.join(dir, `hist-merge-${Date.now()}.md`);
    const hSave = (text, auto) => ev(`window.__snp.historyProbe.save(${JSON.stringify(hp)}, ${JSON.stringify(text)}, ${auto})`);
    const hCount = () => ev(`window.__snp.historyProbe.list(${JSON.stringify(hp)}).then(r => r.length)`);
    await hSave('# v0\n', false);
    await hSave('# v1\n', true);
    await hSave('# v2\n', true);
    await hSave('# v3\n', true);
    const merged = await hCount();
    ok('真机：连续自动保存并成一份，不把 60 份上限塞满逐秒半成品', merged === 1, String(merged));
    const oldest = await ev(`window.__snp.historyProbe.list(${JSON.stringify(hp)}).then(r => window.__snp.historyProbe.read(r[r.length - 1].path))`);
    ok('真机：合并保住的是编辑会话起点那一版，不是被覆盖后的碎片',
      oldest === '# v0\n', JSON.stringify(oldest));
    await hSave('# v4\n', false);
    const explicit = await hCount();
    ok('真机：Ctrl+S 是显式里程碑，一定多记一份', explicit === 2, String(explicit));
    await hSave('# v4\n', false);
    ok('真机：内容完全相同不重复留档', (await hCount()) === 2);
    /* 紧挨着存两次：文件名就是毫秒戳，撞在同一毫秒会互相覆盖、凭空少一条历史 */
    await hSave('# v5\n', false);
    await hSave('# v6\n', false);
    ok('真机：连着两次显式保存各留一份（同一文件内戳严格递增）', (await hCount()) === 4);
    await ev(`window.__snp.historyProbe.save(${JSON.stringify(hp)}, 'x'.repeat(2 * 1024 * 1024 + 1), false)`);
    ok('真机：超大文件不进历史，免得一份吃光 20MB 总额', (await hCount()) === 4);
    await ev(`window.__snp.historyProbe.clear(${JSON.stringify(hp)})`);

    /* ---- 检查点保留：检查点代表不能被 60 份上限挤掉 ----
       快照文件名就是毫秒戳，探针直接往历史目录写「翻过日期」的快照
       （fnv1a 与 Rust 侧同一算法、同一目录规则），再真调 65 次后端触发
       prune。年龄设计：
         新 = 1.958 天 → 1 天检查点的代表（年龄 ≥ 1 天的最新一份）
         中 = 2.000 天 → 不是任何检查点的代表，应当照常被挤掉
         老 = 95 天    → 3/7/10/20/30/60/90 天检查点的代表 */
    const ident = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).identifier;
    const fnv1a = (s) => {
      let h = 0xcbf29ce484222325n;
      for (const b of Buffer.from(s, 'utf8')) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return h.toString(16).padStart(16, '0');
    };
    const DAY = 86_400_000;
    const cpPath = path.join(dir, `hist-ckpt-${Date.now()}.md`);
    const cpDir = path.join(process.env.APPDATA || '', ident, 'history', fnv1a(cpPath));
    fs.mkdirSync(cpDir, { recursive: true });
    const nowMs = Date.now();
    const olds = [
      [nowMs - 2 * DAY + 3_600_000, '新'],
      [nowMs - 2 * DAY, '中'],
      [nowMs - 95 * DAY, '老'],
    ];
    for (const [ts, tag] of olds) fs.writeFileSync(path.join(cpDir, `${ts}.txt`), tag);
    const cpSave = (text) => ev(`window.__snp.historyProbe.save(${JSON.stringify(cpPath)}, ${JSON.stringify(text)}, false)`);
    for (let i = 0; i < 65; i++) await cpSave(`ckpt v${i}\n`);
    ok('真机：检查点代表不被 60 份上限挤掉（1.96 天 / 95 天两份还在）',
      fs.existsSync(path.join(cpDir, `${olds[0][0]}.txt`))
        && fs.existsSync(path.join(cpDir, `${olds[2][0]}.txt`)));
    ok('真机：非检查点代表的旧快照照常被挤掉（2.0 天那份没了）',
      !fs.existsSync(path.join(cpDir, `${olds[1][0]}.txt`)));
    const cpCount = await ev(`window.__snp.historyProbe.list(${JSON.stringify(cpPath)}).then(r => r.length)`);
    ok('真机：60 份新快照 + 2 份检查点代表 = 62 条', cpCount === 62, String(cpCount));
    await ev(`window.__snp.historyProbe.clear(${JSON.stringify(cpPath)})`);
  }

  /* ---- 自己写的不算「外部改动」----
     用户在速记上报的那个 bug 的通用形态：文件内容一个字没变，只是 mtime 动了
     （自己刚写完、别的程序原样重存一遍、两个标签指着同一个文件都算）。以前这种
     会 reloadTab + toast「文件已在磁盘上更新」，顺带把光标和滚动挪走。
     所以这里两条都要：内容一样 → 换个基准时间，一声不响；内容真变了 → 照旧提示。 */
  {
    const dir = path.join(os.tmpdir(), 'eznotepad-probe', 'ext-mtime');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'same.txt');
    fs.writeFileSync(f, 'line1\nline2\n', 'utf8');
    await ev(`window.__snp.openPath(${JSON.stringify(f)})`);
    await sleep(600);
    const m0 = await ev(`window.__snp.getActiveTab().mtime`);
    ok('探针文件打开时记下了 mtime', typeof m0 === 'number', String(m0));

    const toastsNow = () => ev(`JSON.stringify([...document.querySelectorAll('#toasts .toast')].map(n => n.textContent))`);
    const hasDiskToast = async () => String(await toastsNow()).includes('文件已在磁盘上更新');

    /* 1) 原样重写：内容逐字相同，mtime 让它新 5 秒 */
    fs.writeFileSync(f, 'line1\nline2\n', 'utf8');
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(f, future, future);
    await ev(`window.dispatchEvent(new Event('focus'))`);
    await sleep(1000);
    ok('内容没变、只是 mtime 变了：不提示「文件已在磁盘上更新」', !(await hasDiskToast()), await toastsNow());
    const m1 = await ev(`window.__snp.getActiveTab().mtime`);
    ok('新时间戳被静默采纳（不然下次切窗口还要再判一遍）', m1 !== m0 && typeof m1 === 'number', `${m0} → ${m1}`);
    ok('内容没被动过', (await ev(`window.__snp.getActiveTab().content`)) === 'line1\nline2\n');

    /* 2) 真改了内容：该提示还得提示，别把这条能力一起修没了 */
    fs.writeFileSync(f, 'line1\nline2\nline3\n', 'utf8');
    const future2 = Date.now() / 1000 + 10;
    fs.utimesSync(f, future2, future2);
    await ev(`window.dispatchEvent(new Event('focus'))`);
    await sleep(1200);
    ok('内容真的变了：照旧提示已重新载入', await hasDiskToast(), await toastsNow());
    ok('磁盘上的新内容进了编辑器',
      (await ev(`window.__snp.getActiveTab().content`)) === 'line1\nline2\nline3\n');

    /* 收尾：关掉这个标签（它是干净的，不会弹框） */
    await ev(`(() => {
      const t = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => (x.title || '').endsWith('same.txt'));
      if (t) t.querySelector('.tab-close').click();
    })()`);
    await sleep(400);
  }

  /* ---- 钉住（ding）----
     放在最后：它要用「关闭其他」把别的标签一次扫掉，前面那些用例还要用它们。
     真机这层只验两件离线验不到的：钉子真的画出来了（图标来自 index.html 的
     精灵图，编译期内嵌，漏了构建就只剩一个空 18px 格子），以及关闭其他真的
     没带走钉住的那颗。 */
  {
    const tabInfo = async (name) => JSON.parse(await ev(`(() => {
      const b = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => (x.querySelector('.tab-name') || {}).textContent && x.querySelector('.tab-name').textContent.includes(${JSON.stringify(name)}));
      if (!b) return 'null';
      const pin = b.querySelector('.tab-pin');
      const r = pin ? pin.getBoundingClientRect() : null;
      const use = pin ? pin.querySelector('use') : null;
      return JSON.stringify({
        ding: b.classList.contains('ding'),
        close: !!b.querySelector('.tab-close'),
        pin: !!pin,
        pinW: r ? Math.round(r.width) : 0,
        href: use ? use.getAttribute('href') : null,
      });
    })()`));
    const tabMenu = (name) => ev(`(() => {
      const b = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => x.querySelector('.tab-name').textContent.includes(${JSON.stringify(name)}));
      if (!b) return false;
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 40 }));
      return true;
    })()`);
    const menuClick = (label) => ev(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu .ctx-item')]
        .find(x => (x.querySelector('.ctx-label') || {}).textContent === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`);

    await ev(`window.__snp.newTab('ding-a.md', 'A', null)`);
    await sleep(200);
    await ev(`window.__snp.newTab('ding-b.md', 'B', null)`);
    await sleep(200);

    ok('真机：右键标签弹得出菜单', await tabMenu('ding-a.md'));
    await sleep(200);
    ok('真机：点「钉住标签」能执行', await menuClick('钉住标签'));
    await sleep(300);
    const da = await tabInfo('ding-a.md');
    ok('真机：钉住后没有关闭键，钉子真的画出来了（精灵图没漏）',
      !!da && da.ding && !da.close && da.pin && da.pinW >= 10 && da.href === '#i-pin', JSON.stringify(da));

    /* 单关这一条不走「关闭其他」：探针复用的数据目录里躺着四十来个脏标签，
       一次批量关闭会先弹确认框（CDP 点不掉），验的就不是「绕开钉子」而是那个框。
       批量口径在 run-app 的干净标签集里逐条验过；真机这层验单关 —— Ctrl+W 与
       × 同一条路（closeTab），它挡住了，批量那条的过滤才谈得上意义。 */
    await clickTabNamed('ding-a.md');          // closeTab 关的是活动标签，先站到它身上
    await sleep(250);
    ok('真机：钉住的标签自己也关不掉（closeTab 挡住 Ctrl+W 那条路）',
      (await ev(`(() => { window.__snp.commands.closeTab(); return 1; })()`)) === 1);
    await sleep(400);
    ok('真机：关不掉时说明了原因，标签还在',
      (await ev(`[...document.querySelectorAll('.tab[data-id] .tab-name')].some(n => n.textContent.includes('ding-a.md'))`))
        && await ev(`[...document.querySelectorAll('#toasts .toast')].some(b => b.textContent.includes('已钉住'))`),
      await ev(`JSON.stringify([...document.querySelectorAll('#toasts .toast')].map(b => b.textContent))`));

    /* 收尾：取消钉住 —— 探针的数据目录是复用的，别给下一轮留个关不掉的标签 */
    await tabMenu('ding-a.md');
    await sleep(250);
    ok('真机：钉住时右键菜单变「取消钉住」，自己那颗「关闭」置灰',
      await ev(`(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ctx-item')];
        const has = it.some(b => (b.querySelector('.ctx-label') || {}).textContent === '取消钉住');
        const close = it.find(b => (b.querySelector('.ctx-label') || {}).textContent === '关闭');
        return has && !!close && close.disabled;
      })()`));
    ok('真机：取消钉住能执行', await menuClick('取消钉住'));
    await sleep(300);
    ok('真机：钉子收起、关闭键回来', await ev(`(() => {
      const b = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => x.querySelector('.tab-name').textContent.includes('ding-a.md'));
      return !!b && !b.classList.contains('ding')
        && !!b.querySelector('.tab-close') && !b.querySelector('.tab-pin');
    })()`));
  }
} catch (e) {
  ok('探针执行完成', false, e.message);
} finally {
  ws.close();
}

let bad = 0;
for (const r of out) if (!r.pass) bad++;
console.log(`\n${out.length - bad}/${out.length} 通过`);
process.exit(bad ? 1 : 0);
