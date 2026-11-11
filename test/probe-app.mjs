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

const ev = (expr) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({
    id, method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  }));
}).then((r) => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
  return r.result.value;
});

const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });
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
    localStorage.removeItem('snp.draft');
    location.reload();
  })()`);
  await sleep(1600);

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
  ok('高亮已注册', (await ev(`!!(CSS.highlights && CSS.highlights.get('sn-find-cur'))`)) === true);
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

  await ev(`(() => {
    const w = document.getElementById('wysiwyg');
    w.scrollTop = w.scrollHeight;
  })()`);
  await sleep(400);
  const lastActive = await ev(`document.querySelector('.outline-item.active')?.textContent`);
  ok('滚到底部后高亮跟着走', lastActive && lastActive !== '第 1 节',
    JSON.stringify({
      active: lastActive || null,
      idx: await ev(`window.__snp.outlineActive()`),
      st: await ev(`document.getElementById('wysiwyg').scrollTop`),
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
      const cm = document.querySelector('#editor .cm-scroller');
      const pv = document.getElementById('preview');
      const wys = document.getElementById('wysiwyg');
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

  /* ---- H. 跨块拖选 与 代码块内粘贴 ----
     两件事都只在真机上才看得见：
     ①跨块拖选松手后浏览器把 click 派发给「按下点与松开点的最近公共祖先」，
       也就是编辑区根节点 —— 和「点了正文空白」完全是同一个事件形状；
     ②代码块里粘贴多行，走的是 paste 事件 + 真实选区。
     离线套件里用合成事件盖住了这两条，这里再按真鼠标 / 真粘贴走一遍。 */
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

    /* 起止点要真的落在段首。原来取 getBoundingClientRect().left + 20 —— 窗口一窄，
       20px 就跨过好几个汉字，选区跟着变，于是「第一段整段被删掉」必然红：
       不是删除错了，是压根没从段首开始选。用 Range 把字符位置算成坐标。 */
    const pts = await ev(`(() => {
      const atStart = (blk) => {
        const t = blk.querySelector('.w-text') || blk;
        const node = t.firstChild;
        if (!node) return null;
        const r = document.createRange();
        r.setStart(node, 0); r.setEnd(node, 0);
        const b = r.getBoundingClientRect();
        return { x: Math.round(b.left + 1), y: Math.round(b.top + Math.round(b.height / 2)) };
      };
      return [...document.querySelectorAll('.wysiwyg > .w-block')].map(atStart);
    })()`);
    const a = pts[0], z = pts[2];
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
      const s = getSelection(); const r = s.rangeCount ? s.getRangeAt(0) : null;
      const bl = [...document.querySelectorAll('.wysiwyg > .w-block')];
      return { collapsed: s.isCollapsed, len: String(s).length, spanning: r ? bl.filter((b) => r.intersectsNode(b)).length : 0, blocks: bl.length };
    })()`);
    ok('跨块拖选：松手后选区还在', sel.collapsed === false && sel.len > 10, JSON.stringify(sel));
    ok('跨块拖选：选区真的跨了 3 个块', sel.spanning === 3, String(sel.spanning));
    ok('跨块拖选：没有凭空补一个空段落', sel.blocks === 3, String(sel.blocks));

    /* 选中的字要真能删 —— 只看选区长度，容易被「选中了但键盘不动」骗过去。
       选区是从第 1 段开头到第 3 段开头，删完只剩第 3 段（按内容判，别钉子符数） */
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
    await sleep(400);
    const after = await ev(`window.__snp.getEditorText()`);
    ok('跨块拖选后按退格，整段真的删掉了',
      after.includes('第三段') && !after.includes('第一段') && !after.includes('第二段'), JSON.stringify(after));

    /* 代码块里粘贴多行 JSON：块必须还在，内容必须进块 */
    const CB = ['前一段', '', '```json', '```', '', '后一段', ''].join('\n');
    await ev(`window.__snp.newTab('paste.md', ${JSON.stringify(CB)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await ev(`(() => {
      const c = document.querySelector('.w-code');
      const r = document.createRange();
      r.selectNodeContents(c);
      r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    await sleep(150);
    await ev(`(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '{\\n  "b": 2,\\n  "c": [1, 2]\\n}');
      document.querySelector('.w-code').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    })()`);
    await sleep(500);

    const types = await ev(`(() => [...document.querySelectorAll('.wysiwyg > .w-block')].map((b) => b.dataset.type))()`);
    ok('空代码块里粘贴多行：代码块还在', JSON.stringify(types) === '["p","code","p"]', JSON.stringify(types));
    const saved = await ev(`window.__snp.getEditorText()`);
    ok('粘贴内容进了代码块（没有跑到块外变成段落）',
      saved === '前一段\n\n```json\n{\n  "b": 2,\n  "c": [1, 2]\n}\n```\n\n后一段\n', JSON.stringify(saved));

    /* ---- I. 带范围的块末尾：↓ / → 只移动光标，绝不改文档 ----
       表格和代码块内部没有「更靠后的光标位」，走到头就得走出去。但方向键只是
       移动光标：出块时若后面已有空行就停进去，否则把光标送到下一块开头（文末
       保持原位）并记下一次性的「块后待插入」；用户按回车 / 打字 / 粘贴时才真的
       在块后插一个空段落。1.2.6 之前是出块即插行，按一下方向键文档就变脏。 */
    const TB = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', ''].join('\n');
    const bl = () => ev(`(() => [...document.querySelectorAll('.wysiwyg > .w-block')].map((b) => (b.dataset.type || 'p') + ':' + (b.textContent || '').replace(/\\u200b/g, '')))()`);
    const caretWhere = () => ev(`(() => {
      const n = getSelection().anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      const b = el && el.closest ? el.closest('.wysiwyg > .w-block') : null;
      return b ? JSON.stringify({ idx: [...b.parentElement.children].indexOf(b),
        type: b.dataset.type || 'p', text: (b.textContent || '').split('\u200b').join('') }) : null;
    })()`).then((s) => s ? JSON.parse(s) : null);
    const caretEndOf = (sel) => ev(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const el = all[all.length - 1];
      if (!el) return;
      const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    const arrow = async (key, code, vk) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
      await sleep(320);
    };
    const down = () => arrow('ArrowDown', 'ArrowDown', 40);
    const right = () => arrow('ArrowRight', 'ArrowRight', 39);
    const enter = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(360);
    };
    /* 两张表相邻时 caretEndOf 会选到第二张表的最后一格；这里只摆到第一张表 */
    const caretEndOfFirstTable = () => ev(`(() => {
      const t = document.querySelector('.w-table');
      const td = [...t.querySelectorAll('td')].pop();
      const r = document.createRange(); r.selectNodeContents(td); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    /* 代码块正文末尾带换行时，那个 \n 在 pre-wrap 下不生成可点击的行，真实点击
       只会把光标落在它**前面**。模拟用户点最后一行末尾：退回所有尾部 \n / ZWSP。 */
    const caretBeforeTrailingNewline = () => ev(`(() => {
      const el = document.querySelector('.w-code');
      if (!el) return;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n, last = null;
      while ((n = w.nextNode())) last = n;
      if (!last) return;
      let off = last.nodeValue.length;
      while (off > 0 && (last.nodeValue[off - 1] === '\\n' || last.nodeValue[off - 1] === '\\u200b')) off--;
      const r = document.createRange(); r.setStart(last, off); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    const gapPending = () => ev(`!!window.__snp.editor.gapAfter`);
    const isAtEnd = () => ev(`(() => { const b = document.querySelector('.w-block[data-type="code"]'); return b ? window.__snp.editor.isCaretAtEnd(b) : null; })()`);

    await ev(`window.__snp.newTab('dir.md', ${JSON.stringify(TB)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);

    await caretEndOf('.w-table td');
    await down();
    ok('表格末格 ↓ 出表但文档不变', (await bl()).length === 1, JSON.stringify(await bl()));
    ok('↓ 只记下「块后待插入」', await gapPending(), true);
    await enter();
    ok('回车才在表格后开一个空行', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-table td');
    await down();
    ok('表格下面已经空着一行，再按 ↓ 不改文档', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-table td');
    await right();
    ok('表格末格 → 出表但文档不变', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-table td');
    await down();
    await down();
    ok('连按方向键不攒空行', (await bl()).length === 2, JSON.stringify(await bl()));

    /* 表格后面已有正文：方向键只把光标送到后文开头，文档一动不动；
       回车 / 打字时才在表格与后文之间补出那个空行。 */
    await ev(`window.__snp.newTab('dir2.md', ${JSON.stringify(TB + '\n后一段')}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-table td');
    await down();
    ok('表格后面有正文时 ↓ 不改文档', JSON.stringify(await bl()) === '["table:甲乙丙丁","p:后一段"]', JSON.stringify(await bl()));
    const where = await caretWhere();
    ok('↓ 光标只是落到后文开头', !!where && where.idx === 1 && where.text === '后一段', JSON.stringify(where));
    ok('↓ 记下块后待插入', await gapPending(), true);
    ok('↓ 不改 Markdown', (await ev(`window.__snp.getEditorText()`)) === TB + '\n后一段', JSON.stringify(await ev(`window.__snp.getEditorText()`)));
    await enter();
    ok('回车才在表格与后文之间开一行', JSON.stringify(await bl()) === '["table:甲乙丙丁","p:","p:后一段"]', JSON.stringify(await bl()));
    ok('回车后光标站在新空行', (await caretWhere()).idx === 1, JSON.stringify(await caretWhere()));
    await send('Input.insertText', { text: '新' });
    await sleep(420);
    ok('出块后打字写进块后新行', (await ev(`window.__snp.getEditorText()`)) === TB + '\n新\n\n后一段', JSON.stringify(await ev(`window.__snp.getEditorText()`)));

    await ev(`window.__snp.newTab('dir2b.md', ${JSON.stringify(TB + '\n后一段')}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-table td');
    await right();
    await send('Input.insertText', { text: '新' });
    await sleep(420);
    ok('→ 出块后打字不污染后文', (await ev(`window.__snp.getEditorText()`)) === TB + '\n新\n\n后一段', JSON.stringify(await ev(`window.__snp.getEditorText()`)));

    /* 代码块是同一类：文末没有可落脚的下一块，出块时保持光标不动、只记状态 */
    const CB2 = ['```', '甲', '乙', '```', ''].join('\n');
    await ev(`window.__snp.newTab('dir3.md', ${JSON.stringify(CB2)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-code');
    await right();
    ok('代码块末行 → 出块但文档不变', (await bl()).length === 1, JSON.stringify(await bl()));
    ok('→ 记下块后待插入', await gapPending(), true);
    await enter();
    ok('回车才在代码块后开一行', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-code');
    await right();
    ok('代码块后面已经空着一行，→ 不改文档', (await bl()).length === 2, JSON.stringify(await bl()));

    /* ---- I3. 出块提示线与 Ctrl+Enter 强制插入 ----
       方向键出块零文档改动是对的，但状态一直隐形：光标还在原位、或落进下一块，
       界面上没任何东西说「按回车会在这儿开一行」。这里在真 WebView2 里验
       提示线真的画出来、钉在接缝上、状态一作废就收起；Ctrl+Enter 是 Typora
       式一步到位命令，只在带边界块的最后一个可编辑位置生效。 */
    const gapHint = () => ev(`(() => {
      const h = window.__snp.editor.gapHint;
      return { display: h.style.display, top: parseFloat(h.style.top),
        label: h.querySelector('.w-gap-hint-label').textContent,
        hostTop: h.parentElement.getBoundingClientRect().top };
    })()`);
    const codeBottom = () => ev(`(() => {
      const b = document.querySelector('.w-block[data-type="code"]');
      return b ? b.getBoundingClientRect().bottom : null;
    })()`);
    const caretCode = (off) => ev(`(() => {
      window.__snp.editor.restoreCaret({ blockIndex: 0, offset: ${off} });
      document.querySelector('.wysiwyg').focus(); return 1;
    })()`);
    /* 只发 rawKeyDown + keyUp：Ctrl+Enter 不该产生字符，也不该让 beforeinput
       把一次换行偷偷写进代码块里。modifiers:2 = Ctrl。 */
    const ctrlEnter = async () => {
      const k = { modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      await sleep(360);
    };

    await ev(`window.__snp.newTab('gap1.md', ${JSON.stringify(CB2)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-code');
    await down();
    const h1 = await gapHint();
    ok('真机：出块后插入提示线亮起', h1.display === 'block', JSON.stringify(h1));
    ok('真机：提示文字写明按哪个键', h1.label.includes('Enter'), h1.label);
    ok('真机：提示线钉在代码块底边',
      Math.abs(h1.top - ((await codeBottom()) - h1.hostTop)) < 3,
      `${h1.top} vs ${(await codeBottom()) - h1.hostTop}`);
    await enter();
    ok('真机：回车兑现后提示线收起', (await gapHint()).display === 'none');

    await caretEndOf('.w-code');
    await down();
    await arrow('ArrowLeft', 'ArrowLeft', 37);
    ok('真机：非写入键让状态作废后提示线也收起', (await gapHint()).display === 'none');

    const CBQ = ['```', '甲', '```', '', '> 引用'].join('\n');
    await ev(`window.__snp.newTab('gap2.md', ${JSON.stringify(CBQ)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-code');
    await down();
    const h2 = await gapHint();
    const bqBottom = await ev(`document.querySelector('.w-block[data-type="bq"]').getBoundingClientRect().bottom`);
    ok('真机：光标进了引用块，提示线仍钉在代码块底边',
      h2.display === 'block'
        && Math.abs(h2.top - ((await codeBottom()) - h2.hostTop)) < 3
        && Math.abs(h2.top - (bqBottom - h2.hostTop)) > 4,
      `${h2.top} / code ${(await codeBottom()) - h2.hostTop} / bq ${bqBottom - h2.hostTop}`);

    await ev(`window.__snp.newTab('gap3.md', ${JSON.stringify(CB2)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-code');
    await ctrlEnter();
    ok('真机：块末尾 Ctrl+Enter 直接开出块后空行', (await bl()).length === 2, JSON.stringify(await bl()));
    ok('真机：Ctrl+Enter 不留待插入状态', !(await gapPending()));
    ok('真机：Ctrl+Enter 后光标在新空行', (await caretWhere()).idx === 1, JSON.stringify(await caretWhere()));

    await ev(`window.__snp.newTab('gap4.md', ${JSON.stringify(CB2)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretCode(0);
    await ctrlEnter();
    ok('真机：块中间 Ctrl+Enter 不劈开代码块', (await bl()).length === 1, JSON.stringify(await bl()));

    await ev(`window.__snp.newTab('gap5.md', '正文一段', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretCode(4);
    await ctrlEnter();
    ok('真机：普通段落里 Ctrl+Enter 不改文档', (await bl()).length === 1, JSON.stringify(await bl()));

    /* ---- I2. 引用 / 提示块 / 列表也是「带范围的块」 ----
       它们一行一块：只有「这一组的最后一行」归我们管，组内还有下一行时交给
       浏览器自己走（折了几行、要不要顺手滚动，只有它知道）。 */
    const caretAt = (i) => ev(`(() => {
      const b = [...document.querySelectorAll('.wysiwyg > .w-block')][${i}];
      const t = b.querySelector('.w-text') || b;
      const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    const caretBlock = () => ev(`(() => {
      const s = getSelection();
      const n = s.anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      const b = el && el.closest ? el.closest('.wysiwyg > .w-block') : null;
      return b ? b.dataset.type : 'none';
    })()`);
    const load = async (name, md) => {
      await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(md)}, null)`);
      await sleep(400);
      await ev(`window.__snp.commands.modeWysiwyg()`);
      await sleep(500);
    };

    /* 下一块也是「带边界的块」：方向键零改动，回车才在两块之间开行。
       跳进下一块开头时按回车只会在那个块**内部**加行（表格加一行、代码块内换行），
       所以「块后待插入」必须把这一下回车接管过来。→ 与 ↓ 都必须一样。 */
    const TB2 = ['| 戊 | 己 |', '| --- | --- |', '| 庚 | 辛 |', ''].join('\n');
    for (const [kn, kf] of [['→', right], ['↓', down]]) {
      await load('dirb-t.md', TB + '\n' + TB2);
      await caretEndOfFirstTable();
      await kf();
      ok(`表格+表格 ${kn} 出块不改文档`,
        JSON.stringify(await bl()) === '["table:甲乙丙丁","table:戊己庚辛"]', JSON.stringify(await bl()));
      const bw0 = await caretWhere();
      ok(`表格+表格 ${kn} 光标落到下一块开头`, !!bw0 && bw0.idx === 1, JSON.stringify(bw0));
      ok(`表格+表格 ${kn} 记下待插入`, await gapPending(), true);
      await enter();
      ok(`表格+表格 ${kn} 回车才在两块之间开一行`,
        JSON.stringify(await bl()) === '["table:甲乙丙丁","p:","table:戊己庚辛"]', JSON.stringify(await bl()));
      const bw = await caretWhere();
      ok(`表格+表格 ${kn} 回车后光标在空行`, !!bw && bw.idx === 1 && bw.text === '', JSON.stringify(bw));
      await enter();
      ok(`表格+表格 ${kn} 再按回车才加第二行（状态一次性）`,
        JSON.stringify(await bl()) === '["table:甲乙丙丁","p:","p:","table:戊己庚辛"]', JSON.stringify(await bl()));
    }
    await load('dirb-c.md', CB2 + '\n' + TB);
    await caretEndOf('.w-code');
    await right();
    const cb1 = await bl();
    ok('代码块+表格 → 不改文档', cb1.length === 2 && cb1[1].startsWith('table:'), JSON.stringify(cb1));
    ok('代码块+表格 → 记下待插入', await gapPending(), true);
    await enter();
    const cb2 = await bl();
    ok('代码块+表格 回车才在中间开一行',
      cb2.length === 3 && cb2[1] === 'p:' && cb2[2].startsWith('table:'), JSON.stringify(cb2));
    await load('dirb-q.md', '> 甲\n> 乙\n\n' + CB2);
    await caretAt(1);
    await right();
    const qb1 = await bl();
    ok('引用+代码块 → 不改文档', qb1.length === 3 && qb1[2].startsWith('code:'), JSON.stringify(qb1));
    ok('引用+代码块 → 记下待插入', await gapPending(), true);
    await enter();
    const qb2 = await bl();
    ok('引用+代码块 回车才在中间开一行',
      qb2.length === 4 && qb2[2] === 'p:' && qb2[3].startsWith('code:'), JSON.stringify(qb2));

    /* 代码块正文末尾带一个换行（写完顺手回车 / 粘贴带尾部换行）：1.2.6 里
       末尾判据把它算进 end，光标永远被判成「不在末尾」，→ / ↓ 不接管、浏览器
       把光标直接甩进下一块 —— 用户看到的「代码块后面有内容时出不了块」。
       后面接引用 / 表格 / 另一个代码块 / 正文都要一样能出块、能回车插行。 */
    const CB_NL = ['```', '甲', '乙', '', '```'].join('\n');
    let nlN = 0;
    for (const [nm, tail, pre] of [
      ['引用', '> 引用一行', 'bq:'],
      ['表格', TB, 'table:'],
      ['代码块', CB2, 'code:'],
      ['正文', '后一段', 'p:后一段'],
    ]) {
      for (const [kn, kf] of [['→', right], ['↓', down]]) {
        await load(`dirn-${++nlN}.md`, CB_NL + '\n\n' + tail);
        await caretBeforeTrailingNewline();
        ok(`末尾换行的代码块+${nm} ${kn} 光标算在末尾`, await isAtEnd(), true);
        await kf();
        ok(`末尾换行的代码块+${nm} ${kn} 出块不改文档`, (await bl()).length === 2, JSON.stringify(await bl()));
        ok(`末尾换行的代码块+${nm} ${kn} 记下待插入`, await gapPending(), true);
        await enter();
        const nr = await bl();
        ok(`末尾换行的代码块+${nm} ${kn} 回车才在两块之间开行`,
          nr.length === 3 && nr[1] === 'p:' && nr[2].startsWith(pre), JSON.stringify(nr));
      }
      await load(`dirn-${++nlN}.md`, CB_NL + '\n\n' + tail);
      await caretBeforeTrailingNewline();
      await right();
      await send('Input.insertText', { text: '新' });
      await sleep(420);
      const tr = await bl();
      ok(`末尾换行的代码块+${nm} 打字写进块后新行`, tr[1] === 'p:新', JSON.stringify(tr));
    }

    await load('dirq.md', '> 甲\n> 乙\n');
    await caretAt(1);
    await down();
    ok('引用末行 ↓ 不改文档', (await bl()).length === 2, JSON.stringify(await bl()));
    ok('引用末行 ↓ 记下待插入', await gapPending(), true);
    await enter();
    ok('引用末行回车才在下面开一行', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('引用出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());
    await caretAt(0);
    await down();
    ok('引用组内还有下一行时不多开块', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('引用组内向下的落点仍是引用', (await caretBlock()) === 'bq', await caretBlock());

    await load('dirq2.md', '> 甲\n> 乙\n\n后文\n');
    await caretAt(1);
    await right();
    /* → 和 ↓ 在块末做同一件事：只把光标送到后文开头；回车 / 打字才在
       引用与后文之间补出空行。落进后文开头直接打字会变成 `新后文`。 */
    ok('引用组末行 → 不改文档',
      JSON.stringify(await bl()) === '["bq:甲","bq:乙","p:后文"]', JSON.stringify(await bl()));
    ok('引用组末行 → 记下待插入', await gapPending(), true);
    await enter();
    ok('回车才在引用与后文之间开一行',
      JSON.stringify(await bl()) === '["bq:甲","bq:乙","p:","p:后文"]', JSON.stringify(await bl()));
    const qWhere = await caretWhere();
    ok('引用出块后光标站在空行里', !!qWhere && qWhere.idx === 2 && qWhere.text === '', JSON.stringify(qWhere));

    await load('dirc.md', '> [!info] 标题\n> 正文\n');
    await caretAt(1);
    await down();
    ok('提示块末行 ↓ 不改文档', (await bl()).length === 2, JSON.stringify(await bl()));
    await enter();
    ok('提示块末行回车才开一行（不把标题行一起带走）', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('提示块出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());

    await load('dirl.md', '- 甲\n- 乙\n');
    await caretAt(1);
    await down();
    ok('列表末项 ↓ 不改文档', (await bl()).length === 2, JSON.stringify(await bl()));
    await enter();
    ok('列表末项回车才在列表外开一行', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('列表出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());
    await caretAt(0);
    await right();
    ok('列表中间项 → 不多开块', (await bl()).length === 3, JSON.stringify(await bl()));

    /* 分割线本身放不了光标：它落在文末时，光标停在上面那行末尾按 ↓
       只记下「线后待插入」，回车才在线下开一行 */
    await load('dirh.md', '前文\n\n---\n');
    await caretAt(0);
    await down();
    ok('分割线在文末时 ↓ 不改文档',
      JSON.stringify(await bl()) === '["p:前文","hr:"]', JSON.stringify(await bl()));
    ok('分割线在文末时 ↓ 记下待插入', await gapPending(), true);
    await enter();
    ok('回车才在线下开一行',
      JSON.stringify(await bl()) === '["p:前文","hr:","p:"]', JSON.stringify(await bl()));
    ok('穿过分割线后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());

    /* ---- I3. 块级删除与两处退格：真 WebView2 下用真实按键复验 ----
       离线内核跑的是 headless Chrome，这里是真应用。四件事都要在真机上站得住：
       引用整组当一个块、面板能删块、多空行退格不塌行、边界块后空行删得掉。 */
    const bksp = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' });
      await sleep(320);
    };
    const caretStart = (i) => ev(`(() => {
      const b = [...document.querySelectorAll('.wysiwyg > .w-block')][${i}];
      const t = b.querySelector('.w-text') || b;
      const r = document.createRange(); r.setStart(t, 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.wysiwyg').focus();
    })()`);
    const firstHeight = () => ev(`(() => { const b = [...document.querySelectorAll('.wysiwyg > .w-block')][1]; return b ? b.getBoundingClientRect().height : -1; })()`);

    /* 引用整组：鼠标挪到续行，从「转换这一块」面板删除，整组一起没 */
    await load('blk-del.md', '> 第一行\n> 第二行\n> 第三行\n\n尾段\n');
    await ev(`(() => {
      const b = [...document.querySelectorAll('.wysiwyg > .w-block')][2];
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 20, clientY: r.top + 6 }));
      return 1;
    })()`);
    await ev(`document.getElementById('whMenu').click()`);
    const bmDel = await ev(`[...document.querySelectorAll('#wBlockMenu .bm-item')].map(b => b.textContent.trim())`);
    ok('真机：转换面板底部有「删除这一块」', bmDel.includes('删除这一块'), JSON.stringify(bmDel.slice(-2)));
    await ev(`(() => { const b = [...document.querySelectorAll('#wBlockMenu .bm-item')].find(e => e.textContent.includes('删除这一块')); if (b) b.click(); return 1; })()`);
    await sleep(320);
    const afterDel = await bl();
    ok('真机：从续行删是块级，引用整组一起没',
      !afterDel.some((s) => /第一行|第二行|第三行/.test(s)) && afterDel.some((s) => s.includes('尾段')),
      JSON.stringify(afterDel));

    /* 标题后多空行：一次只少一行，留下的空块还得有一行高（不塌成 0） */
    await load('blk-blank.md', '# 标题\n\n\n\n正文\n');
    await caretStart(2);
    await bksp();
    const blankBlocks = await bl();
    const blankH = await firstHeight();
    ok('真机：多空行退格一次只少一行', blankBlocks.length === 3, JSON.stringify(blankBlocks));
    ok('真机：留下的空块没塌成 0 高', blankH >= 12, String(blankH));

    /* 边界块后那个空段落：退格要真删掉 */
    await load('blk-code.md', '```js\nlet a = 1;\n```\n\n');
    await caretStart(1);
    await bksp();
    ok('真机：代码块后空行退格能删掉', (await bl()).length === 1, JSON.stringify(await bl()));
    await load('blk-table.md', '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n');
    await caretStart(1);
    await bksp();
    ok('真机：表格后空行退格能删掉', (await bl()).length === 1, JSON.stringify(await bl()));

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

  /* ---- K. 点文末空白：只把光标送回文末，不许一直加行 ----
     补一行本来是给「带边界的块」兜底的（代码块 / 公式块 / 表格 / 分割线：
     块内没有可写的尾位）。以前无条件 insertEmptyAfter，于是在文末下方
     随便点几次，文档就多出几个空行 —— 这个兜底变成了加行的入口。 */
  {
    const blocks = () => ev(`document.querySelectorAll('.wysiwyg > .w-block').length`);
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
    const p1 = await clickBlank();
    const n1 = await blocks();
    await clickBlank();
    await clickBlank();
    const n3 = await blocks();
    ok('段落垫底：点文末空白不加行', n1 === 2 && n3 === 2, `${JSON.stringify(p1)} → ${n1} / 三次后 ${n3}`);
    /* 光标要真的落在文末那一块里，否则「没加行」可能是因为点空了没反应 */
    const caretTail = await ev(`(() => {
      const root = document.querySelector('.wysiwyg');
      const a = window.getSelection().anchorNode;
      const b = a && (a.nodeType === 3 ? a.parentElement : a);
      return !!(b && b.closest && b.closest('.w-block') === root.lastElementChild);
    })()`);
    ok('段落垫底：点文末空白光标落回末段', caretTail === true);

    /* 代码块垫底才补一行，而且只补一次：补出来的空段落就是新的末块 */
    await ev(`window.__snp.newTab('blank-code.md', '\`\`\`js\\nconst a = 1;\\n\`\`\`', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(600);
    await clickBlank();
    const c1 = await blocks();
    await clickBlank();
    await clickBlank();
    const c3 = await blocks();
    ok('代码块垫底：点文末空白补一行且只补一次', c1 === 2 && c3 === 2, `${c1} / 三次后 ${c3}`);
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

    /* 没标语言的 JSON 块：语言条应当自己认出来，键名要真的着色 */
    await ev(`window.__snp.newTab('code-auto.md', '\`\`\`\\n{"name": "snp", "n": 3}\\n\`\`\`\\n\\n第二段', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(900);
    await ev(`(() => { const b = document.getElementById('findClose'); if (b && !document.getElementById('findbar').classList.contains('hidden')) b.click(); })()`);
    const cinfo = await ev(`(() => {
      const cb = document.querySelector('.w-codeblock');
      const attr = CSS.highlights && CSS.highlights.get('sn-tok-attr');
      const str = CSS.highlights && CSS.highlights.get('sn-tok-str');
      return {
        lang: cb && cb.querySelector('.cc-lang') ? cb.querySelector('.cc-lang').textContent : null,
        btn: !!(cb && cb.querySelector('.cc-copy')),
        attr: attr ? [...attr].map((r) => r.toString()) : [],
        str: str ? str.size : 0,
      };
    })()`);
    ok('没标语言时自动识别成 json', cinfo.lang === 'json', JSON.stringify(cinfo.lang));
    ok('识别结果真的驱动了高亮（键名区间在）',
      cinfo.attr.length >= 2 && cinfo.attr.every((t) => /^"[^"]+"$/.test(t)), JSON.stringify(cinfo.attr));
    ok('语言条上有复制按钮', cinfo.btn === true);

    /* 一键复制：真鼠标点按钮 → 图标切对勾 → 粘回编辑器验证内容 */
    const cp = await ev(`(() => {
      const btn = document.querySelector('.w-codeblock .cc-copy');
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
    })()`);
    ok('复制按钮有实际尺寸（不是 0×0 的画外元素）', cp.w >= 12, JSON.stringify(cp));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cp.x, y: cp.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const done = await ev(`document.querySelector('.w-codeblock .cc-copy').classList.contains('done')`);
    ok('点复制后按钮切成对勾（说明 execCommand 真的成功了）', done === true);

    /* 粘回去：光标放在第二段末尾，把剪贴板内容贴进来 */
    await ev(`(() => {
      const p = [...document.querySelectorAll('.wysiwyg > .w-block')].pop();
      const t = p.querySelector('.w-text');
      const r = document.createRange();
      r.selectNodeContents(t); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await paste();
    const pasted = await ev(`window.__snp.getEditorText()`);
    ok('复制出去的确实是整块代码（粘回来一字不差）',
      pasted.includes('{"name": "snp", "n": 3}'), JSON.stringify(pasted));

    /* Ctrl+A：代码块里第一下选自己，第二下才扩到全篇 */
    await ev(`window.__snp.newTab('code-sel.md', '\`\`\`js\\nconst a = 1;\\n\`\`\`\\n\\n第二段', null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(700);
    await ev(`(() => {
      const t = document.querySelector('.w-code');
      const r = document.createRange();
      r.setStart(t.firstChild, 3); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await ctrlA();
    const sel1 = await ev(`window.getSelection().toString()`);
    ok('代码块内 Ctrl+A 只选这一块', sel1 === 'const a = 1;', JSON.stringify(sel1));
    await ctrlA();
    const sel2 = await ev(`window.getSelection().toString()`);
    ok('再按一次才扩到全文', sel2.includes('第二段'), JSON.stringify(sel2));
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

    /* JSONL 不是合法 JSON（一行一条），预览必须走代码视图而不是「JSON 语法错误」 */
    await ev(`window.__snp.newTab('pv.jsonl', '{"a": 1}\\n{"b": 2}', null)`);
    await ev(`window.__snp.commands.modePreview()`);
    await sleep(320);
    const pv = await ev(`(() => {
      const el = document.getElementById('preview');
      return { code: !!el.querySelector('.codeview'), err: !!el.querySelector('.json-err') };
    })()`);
    ok('JSON Lines 预览按代码看，不当成坏 JSON', pv.code && !pv.err, JSON.stringify(pv));
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

  /* ---------- 表格单元格里的行内格式 ----------
     用户原话：「表格中的内容，无法选中高亮」。选中是好的（拖选、跨格都通），
     坏的是「选中之后加不了格式」：toggleMark / toggleInline 见到单元格就整条返回。
     现在只拦跨格选区，单格里的加粗 / 高亮照常写回 `==…==`。 */
  {
    await ev(`window.__snp.newTab('cell-mark.md', '', null, { mode: 'wysiwyg' })`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(300);
    await ev(`window.__snp.setContent('| 姓名 | 城市 |\\n| --- | --- |\\n| 张三 | 北京 |\\n')`);
    await sleep(700);

    /* 程序化选区（不依赖鼠标轨迹）：第一格里「张三」两个字 */
    await ev(`(() => {
      const td = document.querySelector('.w-block[data-type="table"] td');
      const tn = [...td.childNodes].find((n) => n.nodeType === 3);
      const r = document.createRange(); r.setStart(tn, 0); r.setEnd(tn, 2);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await sleep(140);
    await ev(`window.__snp.commands.highlight()`);
    await sleep(320);
    const one = await ev(`(() => ({
      hasMark: !!document.querySelector('.w-block[data-type="table"] td mark'),
      md: window.__snp.getEditorText(),
    }))()`);
    ok('单元格里选中后能加高亮', one.hasMark, JSON.stringify(one.md));
    ok('单元格里的高亮写回 ==…==', /==张三==/.test(one.md), JSON.stringify(one.md));

    await ev(`(() => {
      const tn = document.querySelector('.w-block[data-type="table"] mark').firstChild;
      const r = document.createRange(); r.setStart(tn, 0); r.setEnd(tn, tn.nodeValue.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await sleep(140);
    await ev(`window.__snp.commands.highlight()`);
    await sleep(320);
    const off = await ev(`(() => ({
      hasMark: !!document.querySelector('.w-block[data-type="table"] td mark'),
      md: window.__snp.getEditorText(),
    }))()`);
    ok('单元格里再点一次取消高亮', !off.hasMark && !/==/.test(off.md), JSON.stringify(off.md));

    /* 跨格：不许动结构（会把 <td> 搬进 <mark>） */
    await ev(`(() => {
      const tds = document.querySelectorAll('.w-block[data-type="table"] td');
      const a = [...tds[0].childNodes].find((n) => n.nodeType === 3);
      const b = [...tds[1].childNodes].find((n) => n.nodeType === 3);
      const r = document.createRange(); r.setStart(a, 0); r.setEnd(b, b.nodeValue.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    await sleep(140);
    await ev(`window.__snp.commands.highlight()`);
    await sleep(320);
    const cross = await ev(`window.__snp.getEditorText()`);
    ok('跨格选区不改表格结构', !/==/.test(cross) && /张三 \| 北京/.test(cross), JSON.stringify(cross));
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

    /* 所见即所得：同一件事走 CSS Custom Highlight API */
    await ev('window.__snp.commands.modeWysiwyg()');
    await sleep(320);
    await ev(`(() => {
      const root = window.__snp.editor.root;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n = null;
      while ((n = w.nextNode())) if (n.nodeValue.includes('红')) break;
      const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return 1;
    })()`);
    await sleep(200);   // selectionchange → rAF → updateSelMatch
    const same = await ev(`(() => { const h = CSS.highlights && CSS.highlights.get('sn-same'); return h ? h.size : -1; })()`);
    ok('真机：所见即所得把三处「红」都标出来', same >= 3, String(same));
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
} catch (e) {
  ok('探针执行完成', false, e.message);
} finally {
  ws.close();
}

let bad = 0;
for (const r of out) {
  if (!r.pass) bad++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
}
console.log(`\n${out.length - bad}/${out.length} 通过`);
process.exit(bad ? 1 : 0);
