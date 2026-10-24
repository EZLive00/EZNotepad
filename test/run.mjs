// ============================================================
// test/run.mjs —— 所见即所得内核的行为回归
//
// 做法：Node 起一个静态服务（仓库根目录），拉起 headless Chrome，
// 用 CDP 打开 test/wysiwyg.html 并执行页面里的 window.__run()。
// 不需要任何依赖，Node 22+ 自带 WebSocket。
//
//   node test/run.mjs            浅色跑一遍
//   THEME=dark node test/run.mjs 深色跑一遍（样式回归用）
//   CHROME_PATH=... 指定浏览器
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const CDP_PORT = 9445;
const PAGE = '/test/wysiwyg.html';
const THEME = process.env.THEME || 'light';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) {
  console.error('找不到 Chrome / Edge，可用 CHROME_PATH 指定');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
    let s = '';
    res.on('data', (d) => (s += d));
    res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

const profile = path.join(ROOT, 'node_modules', '.tmp', 'chrome-wys-' + Date.now());

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--hide-scrollbars', '--window-size=900,1200',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}${PAGE}`,
  ], { stdio: 'ignore' });

  const finish = (code) => {
    try { chrome.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    setTimeout(() => process.exit(code), 300);
  };

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson('/json/list');
      target = list.find((t) => t.type === 'page' && t.url.includes('wysiwyg'));
      if (target) break;
    } catch { /* 尚未就绪 */ }
    await sleep(250);
  }
  if (!target) { console.error('Chrome 调试目标未就绪'); return finish(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  const send = (method, params = {}) => new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  await ev(`document.body.dataset.theme = ${JSON.stringify(THEME)}`);

  for (let i = 0; i < 40; i++) {
    if (await ev('!!window.__ready')) break;
    await sleep(200);
  }
  if (!(await ev('!!window.__ready'))) {
    console.error('页面模块未就绪：');
    console.error(await ev("import('../src/js/wysiwyg.js').then(() => 'import ok').catch(e => 'IMPORT ERR: ' + e.message)"));
    console.error(pageErrors.join('\n'));
    return finish(2);
  }

  const results = await ev('window.__run()');
  if (!results || results.__err) {
    console.error('用例抛错：', results && results.__err);
    console.error(pageErrors.join('\n'));
    return finish(2);
  }

  const fail = results.filter((r) => !r.ok);
  results.forEach((r) => {
    if (r.ok) console.log('  ok   ' + r.name);
    else console.log('  FAIL ' + r.name + '\n         实际: ' + JSON.stringify(r.got) + '\n         期望: ' + JSON.stringify(r.want));
  });
  console.log(`\n${results.length - fail.length}/${results.length} 通过（主题 ${THEME}）`);
  if (pageErrors.length) console.log('\n页面异常:\n' + pageErrors.join('\n'));
  ws.close();
  finish(fail.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(3); });
