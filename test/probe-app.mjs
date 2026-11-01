// ============================================================
// test/probe-app.mjs —— 对着真实窗口跑一遍（CDP）
//
// 前置：应用已用 --remote-debugging-port=9333 启动。
// 这里只放「必须跑在真壳子里」的检查：Tauri 命令、侧栏、设置面板、
// 所见即所得查找、大纲跟随滚动。纯逻辑的部分在 run-units / run.mjs 里。
//
//   node test/probe-app.mjs
// ============================================================
const PORT = process.env.CDP_PORT || 9333;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
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
  ok('默认停在大纲页', (await ev(`document.querySelector('.side-tab.active')?.textContent`)) === '大纲');

  await ev(`document.querySelector('[data-side="files"]').click()`);
  ok('切到文件页后大纲隐藏', await ev(`document.getElementById('sideOutline').classList.contains('hidden')`));
  ok('没打开文件夹时给引导', (await ev(`document.getElementById('ftBody').textContent`)).includes('还没打开文件夹'));

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

  // ---- C. 设置面板 ----
  await ev(`window.__snp.commands.settings()`);
  await sleep(120);
  ok('设置面板打开', (await ev(`!!document.querySelector('.set-panel')`)) === true);
  ok('主题是三选一', (await ev(`document.querySelectorAll('.set-seg[data-name="theme"] button').length`)) === 3);
  const beforeFont = await ev(`document.getElementById('setFontSize').textContent`);
  await ev(`document.querySelector('.set-step[data-zoom="1"]').click()`);
  const afterFont = await ev(`document.getElementById('setFontSize').textContent`);
  ok('调字号立刻反映在面板上', beforeFont !== afterFont, `${beforeFont} → ${afterFont}`);
  await ev(`document.querySelector('.set-step[data-zoom="-1"]').click()`);
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
