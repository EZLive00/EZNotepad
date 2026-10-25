// ============================================================
// test/harness.mjs —— 起静态服务 + headless Chrome + CDP 的通用壳子
//
// 只负责「把页面跑起来、把 window.__run() 的结果取回来」，
// 具体断言写在各自的 .html 里。run.mjs（所见即所得）暂时保留自己那份，
// 新测试统一用这里，避免再来一遍复制粘贴。
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  const profile = path.join(ROOT, 'node_modules', '.tmp', 'chrome-cm-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--hide-scrollbars', `--window-size=${width},${height}`,
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}${page}`,
  ], { stdio: 'ignore' });

  const close = () => {
    try { chrome.kill(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
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
