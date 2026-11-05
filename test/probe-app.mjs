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
    await ev(`(() => { const m = document.querySelector('.ctx-menu'); if (m) m.remove(); })()`);

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

    const pts = await ev(`(() => [...document.querySelectorAll('.wysiwyg > .w-block')].map((b) => {
      const t = b.querySelector('.w-text') || b;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + Math.round(r.height / 2)) };
    }))()`);
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

    /* ---- I. 带范围的块末尾：↓ / → 都要能出块，且不重复开空行 ----
       表格和代码块内部没有「更靠后的光标位」，走到头就得走出去；而出去要有地方站，
       老实现无条件插一个空段落，于是「下面本来就空着」时按一下多一行、越按越长。 */
    const TB = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', ''].join('\n');
    const bl = () => ev(`(() => [...document.querySelectorAll('.wysiwyg > .w-block')].map((b) => (b.dataset.type || 'p') + ':' + (b.textContent || '').replace(/\\u200b/g, '')))()`);
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

    await ev(`window.__snp.newTab('dir.md', ${JSON.stringify(TB)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);

    await caretEndOf('.w-table td');
    await down();
    ok('表格末格 ↓ 在表格后开一行', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-table td');
    await down();
    ok('表格下面已经空着一行，再按 ↓ 不再加行', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-table td');
    await right();
    ok('表格末格 → 也出表，不多开一行', (await bl()).length === 2, JSON.stringify(await bl()));

    /* 表格后面已有正文：落进那一段开头，而不是插一个空行把它顶下去 */
    await ev(`window.__snp.newTab('dir2.md', ${JSON.stringify(TB + '\n后一段')}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-table td');
    await down();
    ok('表格后面有正文时 ↓ 落进那一段', JSON.stringify(await bl()) === '["table:甲乙丙丁","p:后一段"]', JSON.stringify(await bl()));
    ok('落进正文没有改动文档', (await ev(`window.__snp.getEditorText()`)) === TB + '\n后一段', JSON.stringify(await ev(`window.__snp.getEditorText()`)));

    /* 代码块是同一类：末行 → 出块，后面空着就复用 */
    const CB2 = ['```', '甲', '乙', '```', ''].join('\n');
    await ev(`window.__snp.newTab('dir3.md', ${JSON.stringify(CB2)}, null)`);
    await sleep(400);
    await ev(`window.__snp.commands.modeWysiwyg()`);
    await sleep(500);
    await caretEndOf('.w-code');
    await right();
    ok('代码块末行 → 出块', (await bl()).length === 2, JSON.stringify(await bl()));
    await caretEndOf('.w-code');
    await right();
    ok('代码块后面已经空着一行，→ 不再加行', (await bl()).length === 2, JSON.stringify(await bl()));

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

    await load('dirq.md', '> 甲\n> 乙\n');
    await caretAt(1);
    await down();
    ok('引用末行 ↓ 在下面开一行', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('引用出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());
    await caretAt(0);
    await down();
    ok('引用组内还有下一行时不多开块', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('引用组内向下的落点仍是引用', (await caretBlock()) === 'bq', await caretBlock());

    await load('dirq2.md', '> 甲\n> 乙\n\n后文\n');
    await caretAt(1);
    await right();
    ok('引用组末行 → 落进后面那一段',
      JSON.stringify(await bl()) === '["bq:甲","bq:乙","p:后文"]', JSON.stringify(await bl()));

    await load('dirc.md', '> [!info] 标题\n> 正文\n');
    await caretAt(1);
    await down();
    ok('提示块末行 ↓ 出块（不把标题行一起带走）', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('提示块出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());

    await load('dirl.md', '- 甲\n- 乙\n');
    await caretAt(1);
    await down();
    ok('列表末项 ↓ 在列表外开一行', (await bl()).length === 3, JSON.stringify(await bl()));
    ok('列表出块后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());
    await caretAt(0);
    await right();
    ok('列表中间项 → 不多开块', (await bl()).length === 3, JSON.stringify(await bl()));

    /* 分割线本身放不了光标：它落在文末时，光标停在上面那行末尾按 ↓ 得能穿过去 */
    await load('dirh.md', '前文\n\n---\n');
    await caretAt(0);
    await down();
    ok('分割线在文末时 ↓ 在线下开一行',
      JSON.stringify(await bl()) === '["p:前文","hr:","p:"]', JSON.stringify(await bl()));
    ok('穿过分割线后光标在普通段落里', (await caretBlock()) === 'p', await caretBlock());

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
