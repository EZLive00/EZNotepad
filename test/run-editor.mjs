// ============================================================
// test/run-editor.mjs —— 纯文本编辑区（CM6）的行为回归
//
//   node test/run-editor.mjs               浅色
//   THEME=dark node test/run-editor.mjs    深色
//   SHOT=1 node test/run-editor.mjs        顺便截一张图到 node_modules/.tmp/
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPage, shot } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = process.env.THEME || 'light';

let out;
try {
  out = await runPage({
    page: '/test/editor.html',
    theme: THEME,
    port: 8801,
    cdpPort: 9447,
  });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const { results, errors, send, close } = out;
const fail = results.filter((r) => !r.ok);

for (const r of results) {
  if (r.ok) console.log('  ok   ' + r.name);
  else console.log('  FAIL ' + r.name
    + '\n         实际: ' + JSON.stringify(r.got)
    + '\n         期望: ' + JSON.stringify(r.want));
}

console.log(`\n${results.length - fail.length}/${results.length} 通过（主题 ${THEME}）`);
if (errors.length) console.log('\n页面异常:\n' + errors.join('\n'));

if (process.env.SHOT) {
  const file = path.join(ROOT, 'node_modules', '.tmp', `cm-${THEME}.png`);
  await shot(send, file);
  console.log('截图: ' + file);
}

close();
process.exit(fail.length ? 1 : 0);
