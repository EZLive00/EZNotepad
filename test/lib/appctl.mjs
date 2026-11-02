// ============================================================
// test/lib/appctl.mjs —— CDP 探针的应用启动与收尾
//
// 以前开调试端口要临时改两处（tauri.conf.json 的 additionalBrowserArgs
// 和 lib.rs::spawn_compare_window），测完再撤掉重打 —— 一轮就是两次全量重编。
// WebView2 认 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，而且是进程级的：
// 主窗口和随后打开的对比窗口都会带上，所以改成启动时注入，零改动零重编。
//
// 注意：环境变量会覆盖窗口级参数，`tauri.conf.json` 里那串必须原样带上，
// 漏掉 `--disable-gpu-sandbox` 就会重新踩到 WebView2 沙箱崩溃。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const CONF_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox';

/* 探针用**自己的** WebView2 用户数据目录（固定在 %TEMP% 下，复用、永不删除）。
   不沿用 %LOCALAPPDATA%\com.simple.notepad\EBWebView，有两个理由：

   1) 那是用户的真实配置目录。探针在里面写 localStorage/settings，残留状态会让
      断言假红 —— probe-app 的「默认停在大纲页」就是这么红的，改成断言真实契约
      才算治本；但探针本来就不该动用户数据。
   2) Chromium 每次会话结束都要重建 Session Storage（LOCK/CURRENT/MANIFEST/LOG）
      和 Code Cache 索引，本机的深信服 SGuard 会把这类删除重定向进回收站，
      一次 10 条。而 SGuard 对 %TEMP% 下的删除不做重定向：同一个数据目录连续
      启动 4 次，实测 0 条。

   曾经试过 --disable-application-cache / --disk-cache-size=1 / --media-cache-size=1
   来"少写缓存"，对上面这些删除一概无效（测下来还是 10 条），已移除，
   别再加回来。 */
const PROBE_PROFILE = process.env.APP_PROFILE || path.join(os.tmpdir(), 'eznotepad-probe');

const EXE_CANDIDATES = [
  process.env.APP_EXE,
  'src-tauri/target/debug/EZNotepad.exe',
  'src-tauri/target/release/EZNotepad.exe',
].filter(Boolean);

function findExe() {
  return EXE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

export async function cdpReady(port, ms = 1200) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

/* 先礼后兵地收掉应用。
   直接 /F 硬杀会让 WebView2 留下脏状态，下次启动要清理一遍缓存目录 ——
   本机删除全部进回收站，实测一次硬杀 + 下一次启动会往里塞几十条。
   所以先发 WM_CLOSE 让它自己关，等 1.2s 再兜底强杀。
   exit 钩子里只能同步操作，用 Atomics.wait 睡。 */
function killTree(proc) {
  if (!proc || proc.killed) return;
  try { spawnSync('taskkill', ['/PID', String(proc.pid)], { stdio: 'ignore', timeout: 4000 }); } catch {}
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); } catch {}
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {
    try { proc.kill(); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 连上去算一个表达式的值，用完就断 —— 只用于就绪判定 */
function evalIn(url, expression, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('未响应')); }, timeout);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接失败')); });
  });
}

/**
 * 等主窗口真正可用：端口通了只代表 WebView2 起来了，前端脚本可能还没跑。
 * 就绪判据是 document 加载完且 app.js 已经挂上调试面 —— 否则探针会拿 undefined 开打。
 */
export async function waitForMainPage(port, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      const page = list.find((t) => t.type === 'page' && !/compare\.html/.test(t.url));
      if (page) {
        const ready = await evalIn(page.webSocketDebuggerUrl, "document.readyState === 'complete' && !!window.__snp");
        if (ready) { await sleep(250); return page; }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('主窗口没有在预期时间内就绪（前端脚本没跑起来？）');
}

/**
 * 端口上已经有应用就直接复用；否则起一个，并登记退出时收掉。
 * 探针末尾的 process.exit() 也会触发 exit 钩子，所以调用方不需要善后。
 */
export async function ensureApp(port = Number(process.env.CDP_PORT || 9333), { timeout = 30000 } = {}) {
  if (await cdpReady(port)) {
    await waitForMainPage(port, { timeout });
    return { reused: true };
  }

  const exe = findExe();
  if (!exe) throw new Error('找不到应用产物：先 cargo build（或 tauri build）');
  if (process.env.NO_LAUNCH === '1') throw new Error(`端口 ${port} 上没有应用，且已禁止自动启动`);

  const proc = spawn(path.resolve(exe), [], {
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: PROBE_PROFILE,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `${CONF_ARGS} --remote-debugging-port=${port}`,
    },
  });
  proc.on('error', () => {});
  process.on('exit', () => killTree(proc));

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdpReady(port)) {
      await waitForMainPage(port, { timeout: Math.max(5000, deadline - Date.now()) });
      return { reused: false, pid: proc.pid };
    }
    await sleep(200);
  }
  killTree(proc);
  throw new Error(`等了 ${timeout}ms，端口 ${port} 仍未就绪`);
}
