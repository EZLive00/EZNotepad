// ============================================================
// test/run-app.mjs —— 整壳（app.js）在假后端下的界面回归
//
// 真机 CDP 这条路被堵了（命令行里加 --remote-debugging-port，应用启动即
// 静默退出），所以 app.js 里的界面接线一直只能靠读代码。这里把 Tauri 的
// invoke 换成假的，boot 照样能走完，就能对「点一下会怎样」下断言。
//
// 用法：node test/run-app.mjs          （THEME=dark 可换主题）
// ============================================================
import { runPage } from './harness.mjs';

const THEME = process.env.THEME || 'light';
const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass, extra });

const { ev, send, close } = await runPage({
  page: `/test/app-preview.html?theme=${THEME}`,
  theme: THEME,
  port: 8871,
  cdpPort: 9521,
  width: 1180,
  height: 760,
});

const q = (sel) => ev(`!!document.querySelector(${JSON.stringify(sel)})`);
const cls = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).className || ''`);
const val = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).value ?? ''`);
const attr = (sel, a) => ev(`(document.querySelector(${JSON.stringify(sel)}) || {}).getAttribute?.(${JSON.stringify(a)}) ?? null`);
const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const typeIn = (sel, text) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
const keyIn = (sel, key, ctrl = false) => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${!!ctrl}, bubbles: true, cancelable: true }));
  return true;
})()`);

try {
  await ev('window.__ready === true');
  /* harness 的 Chrome profile 是按 cdpPort 固定复用的，上一轮写进去的草稿会让
     这一轮一启动就弹「恢复上次的草稿」。模态框挡在前面时，后面每一条
     「点一下会怎样」全是假红（查找条看着根本没打开，其实是被盖住了）。
     处置和探针 ensureApp 一样：点「丢弃」，要一个干净起点。 */
  await ev('new Promise((r) => setTimeout(r, 420))');
  for (let i = 0; i < 10; i++) {
    const st = await ev(`(() => {
      const ov = document.getElementById('dlgOverlay');
      if (!ov || ov.classList.contains('hidden')) return 'none';
      const bs = [...ov.querySelectorAll('#dlgFoot button')];
      const drop = bs.find((b) => !b.classList.contains('primary'));
      if (!drop) return 'wait';
      drop.click();
      return 'closed';
    })()`);
    if (st === 'closed') { await ev('new Promise((r) => setTimeout(r, 400))'); break; }
    if (st === 'none') break;
    await ev('new Promise((r) => setTimeout(r, 150))');
  }
  ok('app.js 能在假后端下启动', (await ev('!!window.__booted')) === true,
    String(await ev('window.__bootError || ""')).slice(0, 300));

  if (await ev('!!window.__booted')) {
    // ---- 1. 折叠 / 展开 ----
    await ev('window.__snp.commands.find()');
    ok('Ctrl+F 打开查找条', !(await cls('#findbar')).includes('hidden'));
    ok('默认折叠：没有替换行', (await cls('#findReplaceRow')).includes('hidden'));
    ok('箭头 aria-expanded=false', (await attr('#findExpand', 'aria-expanded')) === 'false');

    await click('#findExpand');
    ok('点箭头展开替换行', !(await cls('#findReplaceRow')).includes('hidden'));
    ok('展开后箭头 aria-expanded=true', (await attr('#findExpand', 'aria-expanded')) === 'true');
    ok('展开后浮层带 expanded 类（箭头转 90°）', (await cls('#findbar')).includes('expanded'));

    await click('#findExpand');
    ok('再点一次收起', (await cls('#findReplaceRow')).includes('hidden'));

    // Ctrl+H 直接展开
    await ev('window.__snp.commands.replace()');
    ok('Ctrl+H 直接展开替换行', !(await cls('#findReplaceRow')).includes('hidden'));

    // Ctrl+F 只在已展开时应保持展开（不该把用户摊开的替换行收回去）
    await ev('window.__snp.commands.find()');
    ok('Ctrl+F 不收起已展开的替换行', !(await cls('#findReplaceRow')).includes('hidden'));

    // ---- 1.5 焦点 ----
    // 打开后焦点必须在查找框里；否则键盘还在编辑器，打字直接进正文。
    const afOpen = await ev(`document.activeElement.id`);
    ok('Ctrl+F 把焦点送进查找框', afOpen === 'findInput', afOpen);

    // 编辑模式下每敲一个字都会 runFind → locateMatch → revealOffset，
    // 而 revealOffset 末尾会 view.focus()，一次就把焦点抢回正文 —— 症状是打一个字就再也打不进去。
    await ev('window.__snp.commands.modeEdit()');
    await typeIn('#findInput', 'EZNotepad');
    await ev('new Promise(r => setTimeout(r, 80))');
    const afType = await ev(`document.activeElement.id`);
    ok('编辑模式：输入后焦点仍留在查找框', afType === 'findInput', afType);
    const typed = await val('#findInput');
    ok('编辑模式：输入的字没有被吞掉', typed === 'EZNotepad', JSON.stringify(typed));
    // 定位本身要照常工作（焦点让出去不等于不跳转）
    const sel = await ev(`(() => { const s = window.__snp.plain.selection; return s.to - s.from; })()`);
    ok('定位仍选中命中文本', sel === 9, sel);
    await ev('window.__snp.commands.modeWysiwyg()');

    // ---- 2. 查找与计数 ----
    await typeIn('#findInput', 'EZNotepad');
    await ev('new Promise(r => setTimeout(r, 120))');
    const count = await ev(`document.querySelector('#findCount').textContent`);
    ok('欢迎稿里能查到内容并给出计数', /^\d+\/\d+$/.test(count) && !count.startsWith('0/'), count);

    // ---- 3. 换行按钮 ----
    await typeIn('#findInput', '甲');
    const h1 = await ev(`document.querySelector('#findInput').getBoundingClientRect().height`);
    await click('#findNewline');
    const v1 = await val('#findInput');
    const h2 = await ev(`document.querySelector('#findInput').getBoundingClientRect().height`);
    ok('↵ 按钮插入换行', v1 === '甲\n', JSON.stringify(v1));
    ok('插换行后输入框长高', h2 > h1, `${h1} -> ${h2}`);

    // Ctrl+Enter 也能插换行；单按 Enter 不是换行（是跳到下一处）
    await typeIn('#findInput', '乙');
    await ev(`(() => {
      const el = document.querySelector('#findInput');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    })()`);
    ok('Ctrl+Enter 插入换行', (await val('#findInput')) === '乙\n', JSON.stringify(await val('#findInput')));
    await typeIn('#findInput', '丙');
    await ev(`(() => {
      const el = document.querySelector('#findInput');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    ok('单按 Enter 不插换行', (await val('#findInput')) === '丙', JSON.stringify(await val('#findInput')));

    // ---- 4. 模式开关 ----
    const before = await ev(`document.querySelector('#findCase').checked`);
    await click('#findCase');
    ok('点方格能切「区分大小写」', (await ev(`document.querySelector('#findCase').checked`)) !== before);
    await click('#findRegex');
    ok('正则开关可切换', (await ev(`document.querySelector('#findRegex').checked`)) === true);
    await typeIn('#findInput', '[0-9]+');
    ok('正则模式不报错且给出计数', /^\d+\/\d+$/.test(await ev(`document.querySelector('#findCount').textContent`)));
    await click('#findRegex');

    // ---- 5. 关闭 ----
    await click('#findClose');
    ok('关闭按钮收起查找条', (await cls('#findbar')).includes('hidden'));

    // ---- 6. 跨行查询（编辑模式查 md 源码） ----
    await ev('window.__snp.commands.modeEdit()');
    await ev(`window.__snp.setContent(${JSON.stringify('甲\n乙\n')})`);
    await typeIn('#findInput', '甲\n乙');
    await ev('new Promise(r => setTimeout(r, 120))');
    ok('编辑模式下换行查询能命中', (await ev(`document.querySelector('#findCount').textContent`)) === '1/1',
      await ev(`document.querySelector('#findCount').textContent`));

    // ---- 7. 替换（编辑模式） ----
    await ev(`window.__snp.setContent('foo foo')`);
    await typeIn('#findInput', 'foo');
    await typeIn('#replaceInput', 'bar');
    await click('#findReplaceOne');
    ok('替换当前一处', (await ev('window.__snp.getEditorText()')) === 'bar foo',
      JSON.stringify(await ev('window.__snp.getEditorText()')));
    await click('#findReplaceAll');
    ok('全部替换', (await ev('window.__snp.getEditorText()')) === 'bar bar',
      JSON.stringify(await ev('window.__snp.getEditorText()')));

    // ---- 8. 所见即所得就地替换（不该逼用户切模式） ----
    await ev(`window.__snp.setContent(${JSON.stringify('一段 **粗体** 文字')})`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await typeIn('#findInput', '粗体');
    await typeIn('#replaceInput', '粗字');
    await click('#findReplaceOne');
    await ev('new Promise(r => setTimeout(r, 150))');
    const text8 = await ev('window.__snp.getEditorText()');
    ok('就地替换保住加粗', text8 === '一段 **粗字** 文字', JSON.stringify(text8));

    // 命中劈开加粗边界时不能瞎改，应该弹确认框退回编辑模式
    await typeIn('#findInput', '一段 粗字');
    await click('#findReplaceOne');
    await ev('new Promise(r => setTimeout(r, 250))');
    ok('跨格式匹配先弹确认框', !(await cls('#dlgOverlay')).includes('hidden'));
    await click('#dlgFoot button:last-child');
    await ev('new Promise(r => setTimeout(r, 150))');
    ok('取消后内容没被改动', (await ev('window.__snp.getEditorText()')) === '一段 **粗字** 文字');

    // ---- 6. 新建文档：类型网格能用方向键走 ----
    /* 网格是「两列 + 底部一条自定义输入」，方向键必须把它当一块面板走完：
       ←→ 只在本行内、↑↓ 跨行、最后一行 ↓ 落进输入框、输入框 ↑ 回网格。
       起点是上次用过的类型，所以断言全按实测下标算，不写死具体是第几格。 */
    const gridKey = (key) => ev(`(() => {
      const all = [...document.querySelectorAll('.new-types .new-type')];
      const a = document.activeElement;
      a.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      const b = document.activeElement;
      return {
        i: all.indexOf(b),
        inInput: !!(b.classList && b.classList.contains('new-ext')),
        tabbable: all.filter((x) => x.tabIndex >= 0).length,
      };
    })()`);

    await ev('window.__snp.commands.new(); 0');
    await ev('new Promise(r => setTimeout(r, 140))');
    const grid = await ev(`(() => {
      const all = [...document.querySelectorAll('.new-types .new-type')];
      const top = all[0].offsetTop;
      let cols = 0;
      while (cols < all.length && all[cols].offsetTop === top) cols++;
      const a = document.activeElement;
      return {
        cols, total: all.length,
        onCell: !!(a.classList && a.classList.contains('new-type')),
        active: all.findIndex((x) => x.classList.contains('active')),
        start: all.indexOf(a),
      };
    })()`);
    ok('新建面板打开时焦点就在格子里（不然方向键没反应）', grid.onCell && grid.start === grid.active,
      JSON.stringify(grid));
    ok('整个网格只留一个 Tab 停靠点', (await ev(`[...document.querySelectorAll('.new-types .new-type')].filter((x) => x.tabIndex >= 0).length`)) === 1);

    /* 起点是「上次用过的类型」，会随设置变（上一轮跑出来的 lastNewExt 会被记住），
       所以先把焦点按 Home 归到第一格，后面全都相对它算 */
    const home = await gridKey('Home');
    const p0 = 0;
    ok('Home 回到第一格', home.i === 0, JSON.stringify(home));
    const right = await gridKey('ArrowRight');
    ok('→ 往右挪一格', right.i === p0 + 1 && !right.inInput, JSON.stringify(right));
    const down = await gridKey('ArrowDown');
    ok('↓ 往下挪一行（步长 = 实测列数）', down.i === p0 + 1 + grid.cols, JSON.stringify(down));
    const up = await gridKey('ArrowUp');
    ok('↑ 回到上一行', up.i === p0 + 1, JSON.stringify(up));
    const left = await gridKey('ArrowLeft');
    ok('← 回到原处', left.i === p0, JSON.stringify(left));
    ok('走到第一列再 ← 就停住，不绕到上一行末尾', (await gridKey('ArrowLeft')).i === p0);

    ok('End 跳到最后一格', (await gridKey('End')).i === grid.total - 1);
    const tail = await gridKey('ArrowDown');
    ok('最后一行按 ↓ 落进自定义扩展名输入框', tail.inInput === true, JSON.stringify(tail));
    ok('输入框里按 ↑ 回到网格', (await gridKey('ArrowUp')).i === grid.total - 1);

    /* 回车必须建焦点那一格。焦点在格子上时 dialog 的全局 Enter 会去点主按钮，
       那建的就是「上次用过的类型」—— 方向键选了半天等于白选 */
    const pick = await ev(`(() => {
      const all = [...document.querySelectorAll('.new-types .new-type')];
      const cell = all[3];
      cell.focus();
      cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { ext: cell.dataset.dialogClose };
    })()`);
    await ev('new Promise(r => setTimeout(r, 220))');
    ok('回车关掉面板', (await cls('#dlgOverlay')).includes('hidden'));
    ok('回车建的是焦点那一格，不是主按钮那个类型',
      new RegExp('^未命名.*\\.' + pick.ext + '$').test(await ev('window.__snp.getActiveTab().name')),
      `${pick.ext} → ${await ev('window.__snp.getActiveTab().name')}`);

    // ---- 6b. 新建完不用先点一下正文 ----
    /* 对话框关闭时焦点还留在隐藏的弹层按钮上，初始焦点另有一个 30ms 的定时器。
       修好之后：焦点在编辑区、空文档光标钉在第一块首位、直接打字就进正文。 */
    await ev('window.__snp.commands.new(); 0');
    await ev('new Promise(r => setTimeout(r, 140))');
    await ev(`(() => {
      const c = document.querySelector('.new-types .new-type[data-dialog-close="md"]');
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 220))');
    /* 新建 md 的默认模式跟着 lastMode 走（profile 是复用的，可能被上一轮留在
       edit），所以焦点/光标的判据一律按当前模式分派，两种都得能直接打字。 */
    const focusedNow = `(() => {
      const mode = window.__snp.getActiveTab().mode;
      return mode === 'wysiwyg'
        ? document.activeElement === window.__snp.editor.root
        : document.activeElement === document.querySelector('.cm-content');
    })()`;
    const fresh = await ev(`(() => {
      const root = window.__snp.editor.root;
      const sel = window.getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0) : null;
      const first = root.firstElementChild;
      const mode = window.__snp.getActiveTab().mode;
      return {
        mode,
        name: window.__snp.getActiveTab().name,
        focused: mode === 'wysiwyg'
          ? document.activeElement === root
          : document.activeElement === document.querySelector('.cm-content'),
        atFirst: mode === 'wysiwyg'
          ? !!(r && first && r.collapsed && r.startOffset === 0 &&
               (r.startContainer === first || first.contains(r.startContainer)))
          : window.__snp.plain.selection.from === 0,
        blocks: root.children.length,
      };
    })()`);
    ok('面板新建空 md 落在可编辑模式', /\.md$/.test(fresh.name) && ['wysiwyg', 'edit'].includes(fresh.mode),
      JSON.stringify(fresh));
    ok('新建后焦点就在编辑区，不用先点一下', fresh.focused, JSON.stringify(fresh));
    ok('空文档光标钉在第一个位置', fresh.atFirst && (fresh.mode !== 'wysiwyg' || fresh.blocks === 1),
      JSON.stringify(fresh));
    /* 等过对话框那个 30ms 的初始焦点定时器，焦点应当稳稳留在编辑区 */
    await ev('new Promise(r => setTimeout(r, 140))');
    ok('等过弹层的初始焦点延时，焦点仍在编辑区', (await ev(focusedNow)) === true,
      String(await ev('document.activeElement && document.activeElement.className')));
    await send('Input.insertText', { text: '甲' });
    await ev('new Promise(r => setTimeout(r, 120))');
    const typedNow = await ev(`(() => {
      const t = window.__snp.getActiveTab();
      return t.mode === 'wysiwyg' ? window.__snp.editor.toMarkdown() : window.__snp.getEditorText();
    })()`);
    ok('不点正文直接打字就进了正文', typedNow === '甲', JSON.stringify(typedNow));
    /* 只在所见即所得下 flush：编辑模式下 wys 的 DOM 属于别处，冲一次会串档 */
    const syncedNow = await ev(`(() => {
      if (window.__snp.getActiveTab().mode === 'wysiwyg') window.__snp.editor.flush();
      return window.__snp.getEditorText();
    })()`);
    ok('打的字同步进了标签内容', syncedNow === '甲', JSON.stringify(syncedNow));

    /* 非 Markdown 走 CM6：同样一出现就能直接打字 */
    await ev(`window.__snp.newTab('focus.py', '', null)`);
    await ev('new Promise(r => setTimeout(r, 140))');
    const freshPlain = await ev(`(() => {
      const ce = document.querySelector('.cm-content');
      return { mode: window.__snp.getActiveTab().mode, focused: document.activeElement === ce };
    })()`);
    ok('新建代码文档焦点在纯文本编辑区', freshPlain.mode === 'edit' && freshPlain.focused, JSON.stringify(freshPlain));
    await send('Input.insertText', { text: 'x' });
    ok('代码文档也不用先点一下', (await ev('window.__snp.getEditorText()')) === 'x',
      JSON.stringify(await ev('window.__snp.getEditorText()')));

    /* 极快回车：对话框那个 30ms 的「初始焦点」定时器还没跑就被关掉了，
       不能让它事后再把焦点塞回已经隐藏的格子。 */
    await ev('window.__snp.commands.new(); 0');
    await ev(`(() => {
      const c = document.querySelector('.new-types .new-type[data-dialog-close="md"]');
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 180))');
    ok('极快回车关掉面板，新建后焦点仍落在编辑区',
      (await ev(focusedNow)) === true,
      String(await ev('document.activeElement && document.activeElement.className')));

    // ---- 7. ==高亮==：同一个命令能标上，也能撤掉 ----
    /* 按「第几个字符」选：块里的文字可能已经被拆成 文本 + <mark> + 文本 三个节点，
       直接拿 firstChild 当文本节点第二次就选不动了 */
    const selectInBlock = (a, b) => ev(`(() => {
      const t = document.querySelector('.wysiwyg .w-text');
      if (!t) return false;
      const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let n;
      while ((n = walk.nextNode())) nodes.push(n);
      const at = (off) => {
        for (const node of nodes) {
          const len = node.nodeValue.length;
          if (off <= len) return [node, off];
          off -= len;
        }
        return null;
      };
      const s0 = at(${a});
      const s1 = at(${b});
      if (!s0 || !s1) return false;
      const r = document.createRange();
      r.setStart(s0[0], s0[1]);
      r.setEnd(s1[0], s1[1]);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    })()`);

    await ev(`window.__snp.newTab('hl.md', '这是重点文字', null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 260))');
    ok('所见即所得里能选中一段文字', await selectInBlock(2, 4));
    await ev('window.__snp.commands.highlight(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('选中后高亮写回 ==重点==', (await ev('window.__snp.getEditorText()')) === '这是==重点==文字',
      JSON.stringify(await ev('window.__snp.getEditorText()')));
    ok('DOM 里真的变成 mark', (await ev(`!!document.querySelector('.wysiwyg .w-text mark')`)) === true);

    /* 再点一次要能撤掉：这次选中范围落在 <mark> 里面 */
    await selectInBlock(2, 4);
    await ev('window.__snp.commands.highlight(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('再点一次取消高亮', (await ev('window.__snp.getEditorText()')) === '这是重点文字',
      JSON.stringify(await ev('window.__snp.getEditorText()')));

    // ---- 8. 高亮重复行：只标不改 ----
    await ev(`window.__snp.newTab('dup.txt', '甲\\n乙\\n甲\\n丙\\n甲\\n', null)`);
    await ev('window.__snp.commands.modeEdit()');
    await ev('new Promise(r => setTimeout(r, 260))');
    await ev('window.__snp.commands.dupLines(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('重复的三行都被标亮', (await ev(`document.querySelectorAll('.cm-dup').length`)) === 3,
      String(await ev(`document.querySelectorAll('.cm-dup').length`)));
    ok('高亮不动文档', (await ev('window.__snp.getEditorText()')) === '甲\n乙\n甲\n丙\n甲\n',
      JSON.stringify(await ev('window.__snp.getEditorText()')));
    await ev('window.__snp.commands.dupLines(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('再点一次清掉标记', (await ev(`document.querySelectorAll('.cm-dup').length`)) === 0);

    /* 切模式（整篇重渲）会把标记连节点一起换掉，菜单的勾必须跟着消失：
       留一个假「开着」的状态，第一次点击就只是把勾去掉，看着像没反应 */
    await ev(`window.__snp.newTab('dup2.md', '一\\n二\\n一\\n', null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 260))');
    await ev('window.__snp.commands.dupLines(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('所见即所得里标出 2 处重复', (await ev(`document.querySelectorAll('.w-dup').length`)) === 2,
      String(await ev(`document.querySelectorAll('.w-dup').length`)));
    await ev('window.__snp.commands.modeEdit()');
    await ev('new Promise(r => setTimeout(r, 260))');
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 260))');
    await ev('window.__snp.commands.dupLines(); 0');
    await ev('new Promise(r => setTimeout(r, 200))');
    ok('转一圈回来第一次点击就能标亮', (await ev(`document.querySelectorAll('.w-dup').length`)) === 2,
      String(await ev(`document.querySelectorAll('.w-dup').length`)));

    /* ---- 8b. 非 Markdown 文件的高亮：== 不是这些文件的语法 ----
       用户反馈「只有前后出现 ==，并没有显示高亮」。修法：不写标记，只给
       选区挂一层视图装饰（编辑区当场显示黄底），文件内容一个字节都不动。 */
    const nap = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
    await ev(`window.__snp.newTab('hl.txt', '重点 重点 重点', null)`);
    await ev('window.__snp.commands.modeEdit()');
    await nap(200);
    await ev(`window.__snp.plain.setSelection(0, 2)`);
    await ev('window.__snp.commands.highlight(); 0');
    await nap(120);
    const hlTxt = await ev('window.__snp.getEditorText()');
    ok('非 md 高亮不往文件写 ==', hlTxt === '重点 重点 重点', JSON.stringify(hlTxt));
    ok('编辑区真的出现黄底装饰',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 1,
      String(await ev(`document.querySelectorAll('.cm-view-mark').length`)));
    ok('高亮区间记在标签上',
      (await ev(`window.__snp.getActiveTab().viewMarks.length`)) === 1,
      String(await ev(`window.__snp.getActiveTab().viewMarks.length`)));
    await ev('window.__snp.commands.highlight(); 0');
    await nap(120);
    ok('再点一次取消，装饰消失',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 0);
    /* 重新标上再切标签：视图高亮是标签自己的状态，不能串到别的文档 */
    await ev('window.__snp.commands.highlight(); 0');
    await nap(120);
    await ev(`window.__snp.newTab('other.txt', '别的文本', null)`);
    await nap(200);
    ok('切到别的标签不带高亮',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 0);

    /* 代码里的 a == b 不能被当成「已经标亮」——旧实现会去读源码里的 == */
    await ev(`window.__snp.newTab('eq.py', 'a == b', null)`);
    await ev('window.__snp.commands.modeEdit()');
    await nap(200);
    await ev(`window.__snp.plain.setSelection(2, 4)`);
    await ev('window.__snp.commands.highlight(); 0');
    await nap(120);
    ok('代码里的 == 不会被误判成标记',
      (await ev(`document.querySelectorAll('.cm-view-mark').length`)) === 1);
    ok('代码文件内容原样', (await ev('window.__snp.getEditorText()')) === 'a == b');

    /* md 的编辑模式仍走 ==，没有被一刀切改掉 */
    await ev(`window.__snp.newTab('hl2.md', '这是重点文字', null)`);
    await ev('window.__snp.commands.modeEdit()');
    await nap(200);
    await ev(`window.__snp.plain.setSelection(2, 4)`);
    await ev('window.__snp.commands.highlight(); 0');
    await nap(120);
    ok('md 的编辑模式仍写 ==重点==',
      (await ev('window.__snp.getEditorText()')) === '这是==重点==文字',
      JSON.stringify(await ev('window.__snp.getEditorText()')));

    /* ---- 9. 表格里的 ↑↓ 是上下走一格，不是横向跳 ----
       必须用真实按键：这条逻辑分的是「浏览器默认行为」和「我们的接管」，
       合成事件根本走不到浏览器的默认那一步。 */
    const press = async (key, code, vk, text) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text });
      if (text) await send('Input.dispatchKeyEvent', { type: 'char', key, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
      await ev('new Promise(r => setTimeout(r, 200))');
    };
    const cellAt = () => ev(`(() => {
      const info = window.__snp.editor.tableInfo();
      if (!info) return null;
      return info.rowIdx + ',' + info.colIdx + ',' + ((info.cell.textContent || '').replace(/\\u200b/g, ''));
    })()`);
    const TBL = ['| 甲 | 乙 | 丙 |', '| --- | --- | --- |', '| 丁 | 戊 | 己 |', '| 庚 | 辛 | 壬 |', ''].join('\n');
    await ev(`window.__snp.newTab('tbl.md', ${JSON.stringify(TBL)}, null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 320))');
    await ev(`(() => { window.__snp.editor.focusCell(document.querySelector('.w-block[data-type=table]'), 1, 1); return 1; })()`);
    await ev('new Promise(r => setTimeout(r, 160))');
    ok('起点在中间格（1,1）', (await cellAt()) === '1,1,戊', String(await cellAt()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('↓ 走到同一列的下一行（1,1 → 2,1），不是右边的格', (await cellAt()) === '2,1,辛', String(await cellAt()));
    await press('ArrowUp', 'ArrowUp', 38);
    ok('↑ 回同一列的上一行（2,1 → 1,1）', (await cellAt()) === '1,1,戊', String(await cellAt()));
    await press('ArrowRight', 'ArrowRight', 39);
    ok('→ 仍在格内逐字走，不再等于 ↓', (await ev(`(() => {
      const r = getSelection().getRangeAt(0);
      return window.__snp.editor.tableInfo().rowIdx + ':' + window.__snp.editor.tableInfo().colIdx + ':' + r.startOffset;
    })()`)) === '1:1:1');
    await press('ArrowDown', 'ArrowDown', 40);
    await press('ArrowDown', 'ArrowDown', 40);
    ok('最后一行按 ↓ 停在原地，不绕回别处', (await cellAt()) === '2,1,辛', String(await cellAt()));

    /* ---- 9b. 空表头 / 空单元格 / 格内换行：↑↓ 永远只上下 ----
       旧实现把 mkCell 给空格子垫的占位 <br> 算成「格内还有下一行」，于是
       放行给浏览器；浏览器在 contenteditable 表格里按阅读顺序走，↓ 就变成
       往右跳。mkTable 的默认表头是空串数组，所以「表头按 ↓」几乎必中。
       同一个空格子光标在 <br> 前 / 后还会表现不同 —— 正是「有时候上下、
       有时候左右」。这里全部用真实按键复现，合成事件到不了浏览器默认那一步。 */
    const TBL2 = ['|  |  |  |', '| --- | --- | --- |', '|  | 戊 |  |', '|  |  |  |', ''].join('\n');
    await ev(`window.__snp.newTab('tbl-blank.md', ${JSON.stringify(TBL2)}, null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 320))');
    const blankCell = (r, c) => ev(`(() => {
      const b = document.querySelector('.w-block[data-type=table]');
      const rows = b.querySelectorAll('tr').length;
      window.__snp.editor.focusCell(b, ${r}, ${c});
      return rows;
    })()`);
    const rowCount = await blankCell(0, 0);
    ok('空表头表格渲染出 3 行（表头 + 2 行数据）', rowCount === 3, String(rowCount));
    ok('起点在空表头 (0,0)', (await cellAt()) === '0,0,', String(await cellAt()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('空表头按 ↓ 只下移一行，不往右跑', (await cellAt()) === '1,0,', String(await cellAt()));
    await press('ArrowUp', 'ArrowUp', 38);
    ok('↑ 从首行数据回空表头同一列', (await cellAt()) === '0,0,', String(await cellAt()));

    await blankCell(0, 1);
    await ev('new Promise(r => setTimeout(r, 140))');
    await press('ArrowDown', 'ArrowDown', 40);
    ok('表头中间列 ↓ 到 (1,1)，不是右边一格', (await cellAt()) === '1,1,戊', String(await cellAt()));

    await blankCell(1, 0);
    await ev('new Promise(r => setTimeout(r, 140))');
    await press('ArrowDown', 'ArrowDown', 40);
    ok('空数据格 ↓ 只下移，不往右跑', (await cellAt()) === '2,0,', String(await cellAt()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('末行 ↓ 停在同一列', (await cellAt()) === '2,0,', String(await cellAt()));

    /* 光标停在占位 <br> **之前**（点空格子左侧、或把字删空后 Chromium 的落点）。
       focusCell 用的是 setCaretOffset，空格子没有文本节点会落到 <br> 之后；
       两种落点在旧实现里一个接管、一个放行，正是「有时候上下、有时候左右」。 */
    await ev(`(() => {
      const b = document.querySelector('.w-block[data-type=table]');
      const c = b.querySelectorAll('tr')[1].children[0];
      const r = document.createRange(); r.setStart(c, 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 140))');
    ok('空格子光标确实落在占位 <br> 前', (await cellAt()) === '1,0,', String(await cellAt()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('占位 <br> 前的 ↓ 也只下移，不往右跑', (await cellAt()) === '2,0,', String(await cellAt()));
    await press('ArrowUp', 'ArrowUp', 38);
    ok('占位 <br> 前的 ↑ 也只上移', (await cellAt()) === '1,0,', String(await cellAt()));

    /* 格内 Shift+Enter 换过行：↓ 先走格内那一行，走完才跨到下一行同列。
       设计承诺见《功能设计》表格光标一节，不能为了修横向跳把它删掉。 */
    await ev(`(() => {
      const b = document.querySelector('.w-block[data-type=table]');
      b.querySelectorAll('tr')[1].children[1].innerHTML = '甲<br>乙';
      window.__snp.editor.focusCell(b, 1, 1);
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 160))');
    const inCell = () => ev(`(() => {
      const i = window.__snp.editor.tableInfo();
      const pre = document.createRange(); pre.selectNodeContents(i.cell);
      const r = getSelection().getRangeAt(0);
      pre.setEnd(r.startContainer, r.startOffset);
      return i.rowIdx + ',' + i.colIdx + ',' + pre.toString().length;
    })()`);
    ok('格内两行起点在第一行', (await inCell()) === '1,1,0', String(await inCell()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('格内两行时 ↓ 先走格内下一行', (await inCell()) === '1,1,1', String(await inCell()));
    await press('ArrowDown', 'ArrowDown', 40);
    ok('格内走完 ↓ 才到下一行同一列', (await cellAt()).startsWith('2,1,'), String(await cellAt()));

    /* ---- 10. 删空一行之后 "/" 还能唤出插入面板 ----
       真 bug：删掉最后一个字，光标被 Chromium 提到 .w-block 上、.w-text 只剩 <br>，
       严格按 .w-text 读偏移得到 -1，面板那道门直接 return。 */
    await ev(`window.__snp.newTab('slash-del.md', '甲段\\n\\n', null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 320))');
    await ev(`(() => { const b = [...document.querySelectorAll('.wysiwyg > .w-block')].at(-1); window.__snp.editor.focusBlock(b, true); return 1; })()`);
    await send('Input.insertText', { text: 'x' });
    await ev('new Promise(r => setTimeout(r, 260))');
    await press('Backspace', 'Backspace', 8);
    ok('删空后光标停在块元素上（这正是问题现场）',
      (await ev(`(() => {
        const b = document.querySelector('.wysiwyg > .w-block:last-child');
        const r = getSelection().getRangeAt(0);
        return r.startContainer === b && (b.querySelector('.w-text').textContent || '') === '';
      })()`)) === true);
    await press('/', 'Slash', 191, '/');
    ok('删空之后再打 / 照样弹出插入面板',
      (await ev(`!document.getElementById('wBlockMenu').classList.contains('hidden')`)) === true);
    ok('…斜杠没有落进正文', !(await ev('window.__snp.editor.toMarkdown()')).includes('/'),
      JSON.stringify(await ev('window.__snp.editor.toMarkdown()')));
  }

  /* ---- 11. 提示块标题跟随界面语言 ----
     真 bug：CALLOUT_TYPES.label 在模块加载时把 tt() 算成中文固定住了，
     换语言后所见即所得里「警告」还是中文。自定义标题是用户正文，不许被翻。 */
  {
    const coMd = '> [!warning]\n> 注意内容\n\n> [!danger] 我自己的标题\n> 内容';
    await ev(`window.__snp.newTab('co.md', ${JSON.stringify(coMd)}, null)`);
    await ev('window.__snp.commands.modeWysiwyg()');
    await ev('new Promise(r => setTimeout(r, 320))');
    const heads = () => ev(`[...document.querySelectorAll('.wysiwyg .w-co-head span')].map(s => s.textContent)`);
    const zh = await heads();
    ok('中文下默认标题是「警告」，自定义标题原样保留',
      zh[0] === '警告' && zh[1] === '我自己的标题', JSON.stringify(zh));

    await ev('window.__snp.commands.settings()');
    await ev(`(() => { const s = document.getElementById('setLang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
    await ev('new Promise(r => setTimeout(r, 320))');
    const en = await heads();
    ok('切到英文：所见即所得提示块标题变成 Warning', en[0] === 'Warning', JSON.stringify(en));
    ok('切语言不会把用户自己写的标题翻掉', en[1] === '我自己的标题', JSON.stringify(en));

    await ev('window.__snp.commands.modePreview()');
    await ev('new Promise(r => setTimeout(r, 320))');
    const pv = await ev(`[...document.querySelectorAll('#preview .co-head')].map(s => s.textContent.trim())`);
    ok('预览侧的提示块标题同样跟着语言走',
      pv[0] === 'Warning' && pv[1] === '我自己的标题', JSON.stringify(pv));

    /* harness 的 profile 按 cdpPort 复用：留着 en 会污染下一轮，务必还原 */
    await ev(`(() => { const s = document.getElementById('setLang'); s.value = 'zh-CN'; s.dispatchEvent(new Event('change')); })()`);
    await click('#dlgClose');
    const dlgState = await ev(`(() => {
      const o = document.getElementById('dlgOverlay');
      return { hiddenAttr: o.hidden, hiddenCls: o.classList.contains('hidden') };
    })()`);
    /* dialog() 收起时是给 overlay 加 .hidden（CSS 里 display:none），不是设
       hidden 属性；两种都认，别把「其实关好了」判成没关 */
    ok('设置面板收起来了', dlgState.hiddenCls || dlgState.hiddenAttr, JSON.stringify(dlgState));
  }

  /* ---- 12. PDF 交给系统默认阅读器，不进文本标签模型 ----
     二进制塞进 t.content 会连带污染草稿 / localStorage、保存、格式化、
     查找和外部改动重载；入口分流是成本最低且不会串档的做法。 */
  {
    ok('只有 PDF 被认成外部只读格式',
      (await ev(`window.__snp.externalFileKind('手册.PDF')`)) === 'pdf'
      && (await ev(`window.__snp.externalFileKind('手册.md')`)) === '');

    const tabsBefore = await ev(`document.querySelectorAll('.tab').length`);
    await ev('window.__calls.length = 0');
    await ev(`window.__snp.openPath('C:/tmp/手册.PDF')`);
    const calls = await ev(`window.__calls.slice()`);
    const tabsAfter = await ev(`document.querySelectorAll('.tab').length`);
    ok('打开 PDF 不建标签、也不去按文本读取',
      tabsAfter === tabsBefore && !calls.includes('read_text_file'),
      JSON.stringify({ tabsBefore, tabsAfter, calls }));
    ok('打开 PDF 调的是系统默认程序',
      calls.includes('plugin:opener|open_path'), JSON.stringify(calls));
    ok('给了明确提示，不会以为点了没反应',
      (await ev(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')`)).includes('手册.PDF'));
  }

  /* ---- 13. 块级删除入口：转换面板与右键菜单 ----
     「转换这个块的面板」底部要能删块。删除是块级的：引用整组一起删，
     不是删光标所在那一行；组内续行的退格仍按行合并，两条路互不干扰。 */
  {
    const md = '> 第一行\n> 第二行\n> 第三行\n\n尾段';
    const fresh = async (name) => {
      await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(md)}, null)`);
      await ev('window.__snp.commands.modeWysiwyg()');
      await ev('new Promise(r => setTimeout(r, 320))');
      /* 上一段可能留着插入面板：bmMode 还记着 insert，先收掉免得点 whMenu 被当成收起 */
      await ev(`(() => { document.getElementById('wBlockMenu').classList.add('hidden'); document.querySelectorAll('.ctx-menu').forEach(m => m.remove()); return 1; })()`);
    };

    /* 手柄归一：鼠标挪到续行上，⋮⋮ 仍钉在组首（位置与挪到组首时一致） */
    await fresh('blocks-handle.md');
    const topAt = async (idx) => ev(`(() => {
      const b = document.querySelectorAll('.wysiwyg > .w-block')[${idx}];
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 20, clientY: r.top + 6 }));
      return document.getElementById('wHandle').style.top;
    })()`);
    const topFirst = await topAt(0);
    const topCont = await topAt(2);
    ok('引用续行不再单独出手柄：⋮⋮ 始终钉在组首',
      !!topFirst && topFirst === topCont, JSON.stringify({ topFirst, topCont }));

    /* 转换面板：底部有删除项，且不给盲打键（误按一个字母不该删掉一块） */
    await click('#whMenu');
    const bmOpen = await ev(`!document.getElementById('wBlockMenu').classList.contains('hidden')`);
    const bmLabels = await ev(`[...document.querySelectorAll('#wBlockMenu .bm-item span')].map(e => e.textContent)`);
    const delKey = await ev(`(() => { const b = [...document.querySelectorAll('#wBlockMenu .bm-item')].find(e => e.textContent.includes('删除这一块')); return b ? b.dataset.key : 'missing'; })()`);
    ok('转换面板底部有「删除这一块」', bmOpen && bmLabels.includes('删除这一块'),
      JSON.stringify({ bmOpen, tail: bmLabels.slice(-2) }));
    ok('删除项没有盲打选择键', delKey === '', JSON.stringify(delKey));
    const navSafe = await ev(`(() => {
      const items = [...document.querySelectorAll('#wBlockMenu .bm-item')];
      const del = items.find(e => e.textContent.includes('删除这一块'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      return { hotOnDel: !!del?.classList.contains('hot'),
               hotIdx: items.findIndex(b => b.classList.contains('hot')),
               delIdx: items.indexOf(del), total: items.length };
    })()`);
    ok('删除项不进键盘导航（End 不会落在它上面）',
      !navSafe.hotOnDel && navSafe.hotIdx >= 0 && navSafe.hotIdx !== navSafe.delIdx,
      JSON.stringify(navSafe));
    await ev(`(() => { const b = [...document.querySelectorAll('#wBlockMenu .bm-item')].find(e => e.textContent.includes('删除这一块')); if (b) b.click(); return 1; })()`);
    const afterBm = await ev(`window.__snp.editor.toMarkdown()`);
    ok('转换面板删除是块级：引用整组一起没',
      !/第一行|第二行|第三行/.test(afterBm) && afterBm.includes('尾段'), JSON.stringify(afterBm));

    /* 右键菜单：同一项，光标落在续行上也要回溯到组首 */
    await fresh('blocks-ctx.md');
    await ev(`(() => {
      const b = document.querySelectorAll('.wysiwyg > .w-block')[2];
      window.__snp.editor.focusBlock(b, true);
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
      return 1;
    })()`);
    const ctxLabels = await ev(`[...document.querySelectorAll('.ctx-menu .ctx-label')].map(e => e.textContent)`);
    ok('所见即所得右键也有「删除这一块」', ctxLabels.includes('删除这一块'),
      JSON.stringify(ctxLabels.slice(-4)));
    await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu .ctx-item')].find(e => e.textContent.includes('删除这一块')); if (b) b.click(); return 1; })()`);
    const afterCtx = await ev(`window.__snp.editor.toMarkdown()`);
    ok('右键从续行删除仍是块级',
      !/第一行|第二行|第三行/.test(afterCtx) && afterCtx.includes('尾段'), JSON.stringify(afterCtx));
  }

  /* ---- 关闭提示：Y 保存 / N 不保存 / Esc 取消 ----
     三个按钮过去只能靠鼠标点，键盘用户除了 Esc 没有别的出路。 */
  {
    const dlgHidden = () => ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`);
    const tabCount = () => ev(`document.querySelectorAll('.tab[data-id]').length`);
    const keys = () => ev(`[...document.querySelectorAll('#dlgFoot button')].map(b => [b.dataset.key, b.getAttribute('aria-keyshortcuts')])`);
    const openDirty = async (name) => {
      await ev(`(() => {
        window.__snp.newTab(${JSON.stringify(name)}, '原文', 'C:/tmp/' + ${JSON.stringify(name)});
        window.__snp.setContent('改过的正文');
        window.__snp.commands.closeTab();
        return 1;
      })()`);
      await ev('new Promise(r => setTimeout(r, 140))');
    };
    const before = await tabCount();

    await openDirty('key-esc.md');
    const k1 = await keys();
    ok('关标签提示三个按钮标出 Y / N / Esc',
      k1.length === 3 && k1[0][0] === 'Y' && k1[1][0] === 'N' && k1[2][0] === 'Esc'
      && k1[2][1] === 'Escape', JSON.stringify(k1));

    /* 弹层里带输入框时，字母键归输入框自己，别把弹层关掉 */
    await ev(`(() => { const i = document.createElement('input'); i.id = 'probeDlgInput'; document.getElementById('dlgBody').appendChild(i); i.focus(); return 1; })()`);
    await keyIn('#probeDlgInput', 'y');
    ok('弹层输入框里按 Y 不会误关对话框', !(await dlgHidden()));
    await ev(`document.getElementById('probeDlgInput').remove()`);

    await keyIn('#dlgOverlay', 'Escape');
    await ev('new Promise(r => setTimeout(r, 140))');
    const afterEsc = await ev(`(() => ({ hidden: document.getElementById('dlgOverlay').classList.contains('hidden'), name: window.__snp.getActiveTab().name }))()`);
    ok('Esc 取消关闭，标签还在',
      afterEsc.hidden && afterEsc.name === 'key-esc.md' && (await tabCount()) === before + 1,
      JSON.stringify(afterEsc));

    await openDirty('key-n.md');
    await keyIn('#dlgOverlay', 'n');
    await ev('new Promise(r => setTimeout(r, 160))');
    ok('N 不保存，直接关掉标签', (await dlgHidden()) && (await tabCount()) === before + 1,
      `tabs=${await tabCount()} hidden=${await dlgHidden()}`);

    await openDirty('key-y.md');
    const callsBefore = await ev(`window.__calls.filter(c => c === 'save_text_file').length`);
    await keyIn('#dlgOverlay', 'Y');   // 大写也要认（按住 Shift 敲 Y 是常态）
    await ev('new Promise(r => setTimeout(r, 260))');
    const afterY = await ev(`(() => ({ hidden: document.getElementById('dlgOverlay').classList.contains('hidden'), calls: window.__calls.filter(c => c === 'save_text_file').length }))()`);
    ok('Y 保存并关掉标签，保存确实落到了后端',
      afterY.hidden && (await tabCount()) === before + 1 && afterY.calls === callsBefore + 1,
      JSON.stringify(afterY));

    /* 退出守卫走同一个 dialog，键帽不能被落下。
       quit() 的 Promise 要等用户按完键才 resolve，ev 又开了 awaitPromise，
       直接把它返回出去会死锁在这一行 —— 用 IIFE 吞掉 Promise。 */
    await ev(`(() => { window.__snp.commands.quit(); return 1; })()`);
    await ev('new Promise(r => setTimeout(r, 180))');
    const kq = await keys();
    ok('退出守卫三个按钮同样标出 Y / N / Esc',
      kq.length === 3 && kq[0][0] === 'Y' && kq[1][0] === 'N' && kq[2][0] === 'Esc',
      JSON.stringify(kq));
    await keyIn('#dlgOverlay', 'Escape');
    await ev('new Promise(r => setTimeout(r, 140))');
    ok('Esc 取消退出，脏标签还在', (await dlgHidden()) && (await tabCount()) === before + 1,
      `tabs=${await tabCount()}`);

    /* 幽灵菜单回归：旧实现换菜单只 remove DOM，document 上的 capture keydown
       监听泄漏；连开两次菜单后每一次 Esc 都会被它吞掉，未保存提示的
       「Esc 取消」正是这么失效的。事件必须派给浮层**内的按钮**（会经过
       document capture），直接派给 overlay 会绕过 capture，什么也测不到。 */
    await ev(`(async () => {
      const ui = await import('/src/js/ui.js');
      ui.contextMenu(100, 100, [{ label: '甲', action() {} }]);
      ui.contextMenu(100, 100, [{ label: '乙', action() {} }]);
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 90))');
    await ev(`(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); return 1; })()`);
    await openDirty('key-ghost.md', null);
    await keyIn('#dlgFoot button.primary', 'Escape');
    await ev('new Promise(r => setTimeout(r, 140))');
    ok('连开两次浮层菜单后，Esc 仍能取消对话框（幽灵监听已清）', await dlgHidden(),
      String(await ev(`document.getElementById('dlgTitle').textContent`)));
  }

  /* ---- 14. 一键格式化：不标准也不拒绝 ----
     以前 prettier 一报语法错误就弹「无法格式化」且原文不动；现在三级
     尽力而为。这里测的是 app.js 的接线：不弹框、真排版、可撤销。 */
  {
    const hidden = () => ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`);
    const fmt = async (name, text, wait = 700) => {
      await ev(`window.__snp.newTab(${JSON.stringify(name)}, ${JSON.stringify(text)}, null)`);
      await ev('new Promise(r => setTimeout(r, 120))');
      await ev(`window.__snp.commands.format(); 0`);
      await ev(`new Promise(r => setTimeout(r, ${wait}))`);
      return ev(`window.__snp.getEditorText()`);
    };
    const strip = (s) => String(s).replace(/[ \t\r\n]/g, '');

    /* 首次按会现拉 2 MB 的引擎，多等一拍 */
    const broken = await fmt('broke.json', '{ "a":1,', 1800);
    ok('坏 JSON 不弹「无法格式化」', await hidden(),
      String(await ev(`document.getElementById('dlgTitle').textContent`)));
    ok('坏 JSON 仍按深度缩进了', broken.includes('\n  "a":1,'), JSON.stringify(broken));
    ok('坏 JSON 一个非空白字符都没丢', strip(broken) === strip('{ "a":1,'), JSON.stringify(broken));
    ok('强行排版给了撤销入口', await ev(`[...document.querySelectorAll('#toasts .toast')].some(b => b.textContent.includes('撤销'))`),
      String(await ev(`document.getElementById('toasts').textContent`)));

    const comment = await fmt('cmt.json', '{ "a":1, // hi\n "b":2 }');
    ok('带注释的 JSON 被宽松 parser 接住、注释还在', comment.includes('// hi'), JSON.stringify(comment));

    const css = await fmt('style.css', 'a{color:red}');
    ok('CSS 格式化成功（parser 名不再是 postcss）', css.includes('color: red;'), JSON.stringify(css));

    const py = await fmt('f.py', 'def f():   \n    return 1   \n');
    ok('Python 仍是保守清理，缩进一字不动', py === 'def f():\n    return 1\n', JSON.stringify(py));
  }

  /* ---------- 标签右键：关闭左侧 / 复制路径 / 批量关闭守卫 ---------- */
  {
    const names = () => ev(`[...document.querySelectorAll('.tab[data-id] .tab-name')].map(n => n.textContent)`);
    const menu = () => ev(`[...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => ({
      label: b.querySelector('.ctx-label').textContent, disabled: b.disabled }))`);
    const rightTab = (name) => ev(`(() => {
      const b = [...document.querySelectorAll('.tab[data-id]')]
        .find(x => (x.querySelector('.tab-name')?.textContent || '').includes(${JSON.stringify(name)}));
      if (!b) return false;
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 20 }));
      return true;
    })()`);
    const clickItem = (label) => ev(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu .ctx-item')]
        .find(x => x.querySelector('.ctx-label').textContent === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click(); return true;
    })()`);
    const dlgHidden = () => ev(`document.getElementById('dlgOverlay').classList.contains('hidden')`);
    const dlgKey = (k) => ev(`(() => {
      const b = [...document.querySelectorAll('#dlgFoot button')].find(x => x.dataset.key === ${JSON.stringify(k)});
      if (!b) return false; b.click(); return true;
    })()`);
    const waitDlg = async () => {
      for (let i = 0; i < 40; i++) { if (!(await dlgHidden())) return true; await new Promise(r => setTimeout(r, 80)); }
      return false;
    };
    const waitFor = async (pred) => {
      for (let i = 0; i < 40; i++) { const n = await names(); if (pred(n)) return n; await new Promise(r => setTimeout(r, 80)); }
      return names();
    };

    /* 左侧造一个无路径的脏标签：既触发整批守卫，又验证「保存」时
       没地方落盘的内容会进草稿，而不是跟着标签一起消失。 */
    await ev(`(() => {
      window.__snp.newTab('dirty-nopath.md', '原始', null);
      window.__snp.setContent('未落盘的内容');
      window.__snp.newTab('L.md', 'L', 'C:/tmp/L.md');
      window.__snp.newTab('M.md', 'M', 'C:/tmp/M.md');
      window.__snp.newTab('R.md', 'R', 'C:/tmp/R.md');
      return 1;
    })()`);
    await ev('new Promise(r => setTimeout(r, 200))');

    ok('右键中间标签能弹出菜单', await rightTab('M.md'));
    const items = await menu();
    const ls = items.map(i => i.label);
    ok('标签右键有四个关闭方向 + 复制路径 + 在文件夹中显示',
      ['关闭', '关闭其他', '关闭左侧', '关闭右侧', '复制文件路径', '在文件夹中显示'].every(s => ls.includes(s)),
      JSON.stringify(ls));
    ok('关闭方向按「其他 / 左 / 右」相邻排列',
      ls.indexOf('关闭左侧') === ls.indexOf('关闭其他') + 1
        && ls.indexOf('关闭右侧') === ls.indexOf('关闭左侧') + 1, JSON.stringify(ls));
    ok('中间标签的左右两侧都可执行',
      !items.find(i => i.label === '关闭左侧').disabled
        && !items.find(i => i.label === '关闭右侧').disabled, JSON.stringify(items));

    /* 真实 copy 照常执行，只拦下来记录离屏 textarea 里写了什么 */
    await ev(`(() => {
      window.__tabCopied = [];
      const orig = document.execCommand.bind(document);
      document.execCommand = (cmd) => {
        if (cmd === 'copy') { window.__tabCopied.push(document.activeElement && document.activeElement.value); return true; }
        return orig(cmd);
      };
      return 1;
    })()`);
    ok('点「复制文件路径」能执行', await clickItem('复制文件路径'));
    const tabCopied = await ev(`window.__tabCopied`);
    ok('标签右键复制的是该标签自己的路径',
      tabCopied.length === 1 && tabCopied[0] === 'C:/tmp/M.md', JSON.stringify(tabCopied));
    ok('复制成功提示「路径已复制」',
      await ev(`[...document.querySelectorAll('#toasts .toast')].some(b => b.textContent.includes('路径已复制'))`));

    /* 整批只确认一次；Esc 取消后一个都不能少 */
    await rightTab('M.md');
    const before = await names();
    ok('点「关闭左侧」能执行', await clickItem('关闭左侧'));
    ok('批量关闭遇到未保存内容会先确认，不静默丢弃',
      await waitDlg() && (await ev(`document.getElementById('dlgTitle').textContent`)) === '还有未保存的内容');
    ok('确认框是整批一次，三个按钮带 Y / N / Esc',
      (await ev(`[...document.querySelectorAll('#dlgFoot button')].map(b => b.dataset.key).join(',')`)) === 'Y,N,Esc');
    ok('Esc 取消关闭', await dlgKey('Esc'));
    await ev('new Promise(r => setTimeout(r, 200))');
    const afterCancel = await names();
    ok('取消后一个标签都没少', afterCancel.length === before.length,
      JSON.stringify({ before: before.length, after: afterCancel.length }));

    /* 「全部保存并关闭」：左侧清空，无路径的脏内容进草稿 */
    await rightTab('M.md');
    ok('再次点「关闭左侧」', await clickItem('关闭左侧'));
    ok('第二次确认也会弹出', await waitDlg());
    ok('Y 全部保存并关闭', await dlgKey('Y'));
    const after = await waitFor((n) => n.includes('M.md') && n.includes('R.md') && !n.includes('L.md'));
    ok('关闭左侧后只剩被右键的标签及其右侧',
      after.includes('M.md') && after.includes('R.md') && !after.includes('L.md')
        && !after.includes('dirty-nopath.md'), JSON.stringify(after));
    const drafts = await ev(`localStorage.getItem('snp.drafts') || ''`);
    ok('无路径的未保存内容没被丢掉，写进了草稿',
      drafts.includes('未落盘的内容'), String(drafts).slice(0, 200));
    ok('draftStash 会一直跟着草稿，恢复后才清',
      await ev(`(localStorage.getItem('snp.draftStash') || '').includes('未落盘的内容')`));
  }

  // ---- 标签条竖线：一条缝一条线，右端收口 ----
  {
    await ev(`(() => { window.__snp.newTab('edge-a.md', 'A'); window.__snp.newTab('edge-b.md', 'B'); return 1; })()`);
    await ev('new Promise(r => setTimeout(r, 150))');
    const g = await ev(`(() => {
      const ts = [...document.querySelectorAll('.tabs .tab')];
      return ts.slice(-3).map(e => {
        const s = getComputedStyle(e); const r = e.getBoundingClientRect();
        return { l: +r.left.toFixed(2), r: +r.right.toFixed(2),
          blw: s.borderLeftWidth, brw: s.borderRightWidth,
          blc: s.borderLeftColor, brc: s.borderRightColor, ml: s.marginLeft };
      });
    })()`);
    ok('每颗标签只有左边框，中间不再叠两道',
      g.length >= 3 && g.slice(0, -1).every(x => parseFloat(x.brw) === 0),
      JSON.stringify(g));
    ok('相邻标签精确相接，没有半像素负 margin',
      g.slice(1).every((x, i) => Math.abs(x.l - g[i].r) < 0.02 && parseFloat(x.ml) === 0),
      JSON.stringify(g));
    ok('最右侧标签画出右边框（不是透明）',
      parseFloat(g.at(-1).brw) > 0 && g.at(-1).brc !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(g.at(-1)));
    const firstColor = await ev(`getComputedStyle(document.querySelector('.tabs .tab:first-child')).borderLeftColor`);
    ok('最左侧标签仍不封口', firstColor === 'rgba(0, 0, 0, 0)', firstColor);
  }
} catch (e) {
  ok('运行期间没有异常', false, String((e && e.message) || e).slice(0, 300));
} finally {
  close();
}

let pass = 0;
for (const r of out) {
  if (r.pass) pass++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`);
}
console.log(`\n${pass}/${out.length} 通过（主题 ${THEME}）`);
process.exit(pass === out.length ? 0 : 1);
