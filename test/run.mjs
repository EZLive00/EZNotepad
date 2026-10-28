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
import { spawn, spawnSync } from 'node:child_process';
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

// Windows 上 child.kill() 杀不掉 renderer/gpu 子进程，它们会一直占着 profile 目录
const killTree = (child) => {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
};

// 按命令行里的 profile 路径收掉 Chrome（Chrome 会把活儿交给真正的浏览器进程，
// spawn 拿到的 pid 常常已退出，taskkill /pid 打空）。只匹配本仓库 .tmp，不动用户的 Chrome。
// 注意：Git Bash 起的 node 在 PATH 里看不到 PowerShell 目录，spawn('powershell') 会 ENOENT
// （静默失败 = 什么也没杀），所以优先用绝对路径。
const PS_CANDIDATES = [
  path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell',
  'pwsh',
];

const killChromeWhere = (marker) => {
  if (process.platform !== 'win32') return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${marker}*' } | `
    + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  for (const exe of PS_CANDIDATES) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', windowsHide: true });
    if (!r.error) return;
  }
};

const TMP_WIN = path.join(ROOT, 'node_modules', '.tmp').split(path.sep).join('\\');
const killStaleChrome = () => { killChromeWhere(TMP_WIN + '\\chrome-'); };

// 每次用全新 profile（复用会把上次的磁盘缓存带进来，页面拿旧资源），
// 但开跑前先清场：收掉上轮遗留的 Chrome 并删掉它们的目录，否则垃圾只增不减。
const profile = path.join(ROOT, 'node_modules', '.tmp', 'chrome-prof-wys-' + Date.now());
killStaleChrome();
try {
  const dir = path.dirname(profile);
  for (const n of fs.readdirSync(dir)) {
    if (/^chrome-/.test(n) && n !== path.basename(profile)) {
      fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
} catch { /* 删不掉就下次再收 */ }
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch { /* 上轮还没退干净就复用 */ }

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--hide-scrollbars', '--window-size=900,1200',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${PORT}${PAGE}`,
  ], { stdio: 'ignore' });

  const finish = (code) => {
    // 按本次 profile 路径精确杀（killTree 只杀得到启动器，真正干活的浏览器进程会活下来）
    killChromeWhere(profile.split(path.sep).join('\\'));
    killTree(chrome);
    try { server.close(); } catch { /* ignore */ }
    setTimeout(() => {
      // 用完即删，否则每跑一次就多一个 14MB 的临时 profile 目录。
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch { /* ignore */ }
      process.exit(code);
    }, 400);
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
