// ============================================================
// test/probe-new.mjs —— 这一轮新功能的真机验证（CDP）
//
// 前置：应用已用 --remote-debugging-port=9333 启动。
//   node test/probe-new.mjs
//
// 覆盖：数学公式（预览渲染 + 所见即所得染色）、目录插入、专注模式、文件变化监听。
// 这些东西离不开真壳子：KaTeX 的脚本是运行时注入的、文件监听走 Rust 的
// ReadDirectoryChangesW、专注模式靠真实布局像素说话，jsdom 里都测不出来。
// ============================================================
import { writeFileSync, unlinkSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
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
  return { ws, ev };
}

const out = [];
const ok = (name, pass, extra = '') => out.push({ name, pass: !!pass, extra });

let { ws, ev } = await connect();

/* ---------- 0. 清掉上次手点的设置，重载 ---------- */
await ev(`localStorage.clear(); 1`);
ev(`location.reload(); 1`).catch(() => {});
try { ws.close(); } catch {}
await sleep(2600);
({ ws, ev } = await connect());
ok('重载后应用起来了', await ev(`!!window.__snp && !!document.querySelector('.wysiwyg')`));

/* ---------- 1. 数学公式 ---------- */
const doc = [
  '# 公式测试',
  '',
  '行内公式 $E = mc^2$ 应该渲染出来。',
  '',
  '$$',
  '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
  '$$',
  '',
  '- 列表里的 $a_1 + b_1$ 也要渲染',
].join('\n');

await ev(`window.__snp.newTab('公式测试.md', ${JSON.stringify(doc)})`);
await sleep(300);
await ev(`window.__snp.commands.modePreview()`);
// KaTeX 是运行时注入的：reload 之后要从内嵌资源重新读 545 KB，别用固定 sleep 赌
for (let t = 0; t < 8000; t += 200) {
  if ((await ev(`document.querySelectorAll('#preview .katex').length`)) >= 3) break;
  await sleep(200);
}

const katexCount = await ev(`document.querySelectorAll('#preview .katex').length`);
ok('预览里出现 KaTeX 节点', katexCount >= 3, `${katexCount} 个（两处行内 + 一处块级）`);
ok('块级公式单独成块', await ev(`!!document.querySelector('#preview .math-block')`));
ok('块级公式不再显示 $$ 源码', await ev(`
  (() => { const n = document.querySelector('#preview .math-block'); return !!n && !n.textContent.includes('$$'); })()
`));
ok('公式里的下标没被当斜体', await ev(`
  !document.querySelector('#preview li em, #preview li i')
`));
ok('KaTeX 的字体样式表已注入', await ev(`
  [...document.styleSheets].some((s) => (s.href || '').includes('katex'))
`));

/* ---------- 2. 目录 ---------- */
await ev(`window.__snp.commands.modeEdit()`);
await sleep(250);
await ev(`window.__snp.commands.toc()`);
await sleep(350);
const content = await ev(`window.__snp.getActiveTab().content`);
ok('目录插进了文档', content.includes('- [公式测试](#公式测试)'), JSON.stringify(content.slice(0, 40)));

// 目录里的链接在预览里要真的跳得动：锚点 id 和 slug 必须一致
await ev(`window.__snp.commands.modePreview()`);
await sleep(900);
ok('标题 id 就是目录里的锚点', await ev(`!!document.querySelector('#preview [id="公式测试"]')`));

/* ---------- 3. 所见即所得里的公式染色 ---------- */
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(500);
const mathSpans = await ev(`document.querySelectorAll('.wysiwyg .w-math').length`);
ok('所见即所得里公式被标出来', mathSpans >= 2, `${mathSpans} 处`);
ok('染色真的生效了', await ev(`
  (() => {
    const n = document.querySelector('.wysiwyg .w-math');
    if (!n) return false;
    const bg = getComputedStyle(n).backgroundColor;
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  })()
`));
// 存回去不能变样：$ 还在，文字一字不差
const back = await ev(`window.__snp.getActiveTab().content`);
ok('公式存回 Markdown 不走样', back.includes('$E = mc^2$') && back.includes('$a_1 + b_1$'));

/* 真正的回归点：所见即所得的序列化。在这一层丢过 `$`，
   表现是只要在富文本视图里碰过文档、再切回编辑模式，公式就退化成普通文字。 */
await ev(`window.__snp.commands.modeEdit()`);
await sleep(350);
const back2 = await ev(`window.__snp.getActiveTab().content`);
ok('从所见即所得切回编辑模式后公式还在', back2.includes('$E = mc^2$') && back2.includes('$a_1 + b_1$'), JSON.stringify(back2.slice(0, 60)));
/* 块级公式是一个整体块：要是被当成三个普通段落，往返一趟就会在 $$ 和公式之间塞满空行 */
ok('块级公式往返没被拆成三段', !/\\$\\$\\s*\\n\\s*\\n/.test(back2) && back2.includes('\\int_0^1'));
await ev(`window.__snp.commands.modeWysiwyg()`);
await sleep(350);

/* ---------- 4. 专注模式 ---------- */
await ev(`window.__snp.commands.toggleZen()`);
await sleep(250);
ok('专注模式打开', await ev(`document.body.dataset.zen === '1'`));
ok('标签行收起', await ev(`getComputedStyle(document.querySelector('.tabbar')).display === 'none'`));
ok('侧栏收起', await ev(`getComputedStyle(document.getElementById('outlinePane')).display === 'none'`));
ok('状态栏收起', await ev(`getComputedStyle(document.querySelector('.statusbar')).display === 'none'`));
ok('标题栏还在（不然窗口没法拖、没法关）', await ev(`
  (() => { const n = document.querySelector('.titlebar'); return !!n && getComputedStyle(n).display !== 'none'; })()
`));
ok('正文比平时窄', await ev(`
  (() => { const s = getComputedStyle(document.body); return (s.getPropertyValue('--read-measure') || '').trim() === '42rem'; })()
`));
await ev(`window.__snp.commands.toggleZen()`);
await sleep(250);
ok('退出后界面回来', await ev(`
  document.body.dataset.zen !== '1' && getComputedStyle(document.querySelector('.tabbar')).display !== 'none'
`));

/* ---------- 5. 文件变化监听 ---------- */
const tmp = 'D:\\dev\\project\\EZ\\EZNotepad\\test\\.tmp-watch.md';
writeFileSync(tmp, '# 监听测试\n\n原始内容\n', 'utf8');
await ev(`window.__snp.openPath(${JSON.stringify(tmp)})`);
await sleep(1400);                      // syncWatches 有 300ms 合并，再给 Rust 布置的时间
writeFileSync(tmp, '# 监听测试\n\n外部改过了\n', 'utf8');
await sleep(1600);
const after = await ev(`window.__snp.getActiveTab().content`);
ok('外部改动被监听到并重载', after.includes('外部改过了'), JSON.stringify(after.slice(0, 30)));

// 自己保存不该反复自激：存完再等一会儿，内容仍然是刚写的
await ev(`window.__snp.commands.save()`);
await sleep(1200);
ok('自己保存不会自激重载', await ev(`window.__snp.getActiveTab().content`).then((c) => c.includes('外部改过了')));

try { unlinkSync(tmp); } catch {}

/* ---------- 汇总 ---------- */
ws.close();
const fail = out.filter((r) => !r.pass);
out.forEach((r) => console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`));
console.log(`\n${out.length - fail.length}/${out.length} 通过`);
process.exit(fail.length ? 1 : 0);
