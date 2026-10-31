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

const { ev, close } = await runPage({
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

    // ---- 2. 查找与计数 ----
    await typeIn('#findInput', '简单记事本');
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
