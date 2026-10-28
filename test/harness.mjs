// ============================================================
// test/harness.mjs —— 起静态服务 + headless Chrome + CDP 的通用壳子
//
// 只负责「把页面跑起来、把 window.__run() 的结果取回来」，
// 具体断言写在各自的 .html 里。run.mjs（所见即所得）暂时保留自己那份，
// 新测试统一用这里，避免再来一遍复制粘贴。
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 截图统一落这里（历史遗留：有的脚本写 node_modules/.tmp、有的写项目根，
 * 结果同一批图散在三处，找的时候满盘搜）。
 * 默认 D:\tmp\ez-shot（Windows）/ 系统临时目录，可用 SHOT_DIR 环境变量覆盖。
 */
export const SHOT_DIR = process.env.SHOT_DIR
  || (process.platform === 'win32'
    ? 'D:/tmp/ez-shot'
    : path.join(os.tmpdir(), 'ez-shot'));
fs.mkdirSync(SHOT_DIR, { recursive: true });

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_DIR = path.join(ROOT, 'node_modules', '.tmp');

/**
 * 杀掉 Chrome 整棵进程树。
 * 坑：Windows 上 child.kill() 只结束主进程，renderer/gpu/crashpad 子进程会留下来，
 * 一直占着 profile 目录句柄（于是删不掉），几十轮测试后就是一堆后台 Chrome + 几个 G。
 */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
  } catch { /* 交给下面的 kill 兜底 */ }
  try { child.kill(); } catch { /* ignore */ }
}

// 注意：在 Git Bash 起的 node 里 PATH 看不到 PowerShell 目录，直接 spawn('powershell')
// 会 ENOENT（静默失败，什么也没杀）。所以优先用绝对路径。
const PS_CANDIDATES = [
  path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  'powershell',
  'pwsh',
];

/**
 * 按命令行里的 profile 路径结束 Chrome。
 * 为什么不用 pid：Chrome 启动后会把活儿交给真正的浏览器进程，我们 spawn 到的那个 pid
 * 往往已经退出，taskkill /pid 就是打空——进程留一堆，profile 目录也删不掉。
 */
function killChromeWhere(markerWin) {
  if (process.platform !== 'win32') return;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${markerWin}*' } | `
    + `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  for (const exe of PS_CANDIDATES) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', windowsHide: true });
    if (!r.error) return;
  }
}

/** 收掉上一轮遗留的测试用 Chrome（本仓库 .tmp 下任意 profile） */
function killStaleChrome() {
  killChromeWhere(TMP_DIR.split(path.sep).join('\\') + '\\chrome-');
}

/** 这个端口上有没有人在监听（有就说明上一轮的 Chrome 还活着） */
function portBusy(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 400 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 清掉其它测试遗留的临时 Chrome 配置目录（keep 是本次自己的，留着）。
 * 调用前已经 killStaleChrome()，所以这些目录没有进程占用，删得掉。
 * 注意：本函数假设测试是串行跑的（各文件的端口本来就是写死的，并行本来也跑不了）。
 */
function sweepStaleProfiles(keep) {
  let names = [];
  try { names = fs.readdirSync(TMP_DIR); } catch { return; }
  const mine = path.basename(keep);
  for (const n of names) {
    if (!/^chrome-/.test(n) || n === mine) continue;
    try {
      fs.rmSync(path.join(TMP_DIR, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch { /* 还被占着就下轮再收 */ }
  }
}

/**
 * @param {object} o
 *   page     页面路径，如 '/test/editor.html'
 *   theme    'light' | 'dark'
 *   port     静态服务端口
 *   cdpPort  Chrome 调试端口
 *   width/height 视口
 * @returns {Promise<{results:Array, errors:string[], ev:Function, snapshot:Function}>}
 */
export async function runPage(o) {
  const {
    page, theme = 'light', port = 8801, cdpPort = 9447, width = 1000, height = 1200,
  } = o;

  const CHROME = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!CHROME) throw new Error('找不到 Chrome / Edge，可用 CHROME_PATH 指定');

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

  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  // 每次都用全新的 profile 目录（不要复用：Chrome 的磁盘缓存会把上一次的 JS/CSS 带过来，
  // 页面拿到旧资源，测试就会莫名其妙地少几项）。关键是「用完即删 + 开跑前清场」，
  // 以前只做「新建」不做「删除」，跑几百轮就是几个 G 的垃圾和一堆后台 Chrome。
  const profile = path.join(TMP_DIR, `chrome-prof-${cdpPort}-${Date.now()}`);
  killStaleChrome(); // 先收掉上轮遗留的 Chrome，它们占着目录句柄，否则下面删不掉
  sweepStaleProfiles(profile);
  // 端口还被占着就说明有别人的 Chrome 活着。此时 spawn 的新实例绑不上调试端口，
  // 后面的 /json/list 会接到那个旧实例上——断言全跑在旧页面上，症状是「莫名少几项」。
  if (await portBusy(cdpPort)) {
    await sleep(600);
    killStaleChrome();
    if (await portBusy(cdpPort)) {
      throw new Error(`调试端口 ${cdpPort} 被占用：上一轮残留的 headless Chrome 还活着，`
        + '先结束命令行里带 --remote-debugging-port=' + cdpPort + ' 的 chrome.exe 再跑');
    }
  }
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--hide-scrollbars', `--window-size=${width},${height}`,
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}${page}`,
  ], { stdio: 'ignore' });

  const close = () => {
    // 按本次 profile 路径精确杀：Chrome 真正干活的浏览器进程不是我们 spawn 的那个 pid，
    // taskkill /pid 会打空，留下几十个后台 chrome 占内存、也锁着 profile 目录。
    killChromeWhere(profile.split(path.sep).join('\\'));
    killTree(chrome);
    try { server.close(); } catch { /* ignore */ }
    // 进程没了再删目录；删不掉也无妨，下一次 runPage 开头的 sweepStaleProfiles() 会兜底。
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore */ }
  };

  const getJson = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cdpPort, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson('/json/list');
      target = list.find((t) => t.type === 'page' && t.url.includes(page));
      if (target) break;
    } catch { /* 尚未就绪 */ }
    await sleep(250);
  }
  if (!target) { close(); throw new Error('Chrome 调试目标未就绪'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  await ev(`document.body.dataset.theme = ${JSON.stringify(theme)}`);

  for (let i = 0; i < 40; i++) {
    if (await ev('!!window.__ready')) break;
    await sleep(200);
  }
  if (!(await ev('!!window.__ready'))) {
    const why = await ev('(window.__bootError || "未知原因")');
    close();
    throw new Error('页面模块未就绪：' + why + '\n' + errors.join('\n'));
  }

  const results = await ev('window.__run()');
  if (!results || results.__err) {
    close();
    throw new Error('用例抛错：' + (results && results.__err) + '\n' + errors.join('\n'));
  }

  return { results, errors, ev, close, send };
}

/** 拿一张截图（base64 PNG），验证视觉时用 */
export async function shot(send, file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r && r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}
