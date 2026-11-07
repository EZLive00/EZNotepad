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
