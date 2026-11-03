// ============================================================
// test/probe-app.mjs —— 对着真实窗口跑一遍（CDP）
//
// 端口没开就自动拉起应用，跑完随进程退出收掉；已有实例直接复用。
// 这里只放「必须跑在真壳子里」的检查：Tauri 命令、侧栏、设置面板、
// 所见即所得查找、大纲跟随滚动。纯逻辑的部分在 run-units / run.mjs 里。
//
//   node test/probe-app.mjs
// ============================================================
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
  const doc = Array.from({ length: 30 }, (_, i) => `## 第 ${i + 1} 节\n\n这一段是第 ${i + 1} 节的内容，用来把页面撑长。\n`).join('\n');
  await ev(`window.__snp.newTab('outline.md', ${JSON.stringify(doc)}, null)`);
  await sleep(150);
  await ev(`window.__snp.commands.modeWysiwyg()`);
  await sleep(250);
  ok('大纲生成了 30 项', (await ev(`document.querySelectorAll('.outline-item').length`)) === 30);
  ok('初始高亮在第一项', (await ev(`document.querySelector('.outline-item.active')?.textContent`)) === '第 1 节');

  await ev(`(() => {
    const w = document.getElementById('wysiwyg');
    w.scrollTop = w.scrollHeight;
  })()`);
  await sleep(400);
  const lastActive = await ev(`document.querySelector('.outline-item.active')?.textContent`);
  ok('滚到底部后高亮跟着走', lastActive && lastActive !== '第 1 节', lastActive);

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
  await sleep(900);
  ok('wysiwyg 点击大纲项，滚完该项点亮',
    (await ev(`document.querySelector('.outline-item.active')?.textContent`)) === '第 15 节');

  await ev(`window.__snp.commands.modePreview()`);
  await sleep(300);
  await clickOutline('第 8 节');
  await sleep(900);
  ok('预览模式点击大纲项，滚完该项点亮',
    (await ev(`document.querySelector('.outline-item.active')?.textContent`)) === '第 8 节');

  await ev(`window.__snp.commands.modeEdit()`);
  await sleep(300);
  await clickOutline('第 22 节');
  await sleep(900);
  ok('编辑模式点击大纲项，滚完该项点亮',
    (await ev(`document.querySelector('.outline-item.active')?.textContent`)) === '第 22 节');

  /* 纯文本大纲只认结构标记。这里守的是那个真实 bug：`1. 2. 3.` 连续编号逐行进面板，
     而且全被压成同一级 —— 用户看到的是「txt 每行都是大纲」 */
  const outlineRows = () => ev(`[...document.querySelectorAll('#outlineList .outline-item')].map(b => ((b.className.match(/\\bh[1-6]\\b/) || ['?'])[0]) + ':' + b.textContent)`);
  await ev(`window.__snp.newTab('清单.txt', '1. 买菜\\n2. 做饭\\n3. 洗碗', null)`);
  await sleep(400);
  ok('txt 连续编号不逐行成大纲', (await outlineRows()).length === 0, JSON.stringify(await outlineRows()));
  ok('txt 空态说明缺什么', /章节标记/.test(await ev(`document.querySelector('#outlineList .outline-empty')?.textContent || ''`)));
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
