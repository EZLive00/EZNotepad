// ============================================================
// test/run-probe.mjs —— 五个真机探针，只起一次应用
//
// 每个探针单独跑都要「起应用 → 收应用」，而应用的 WebView2 每次会话都会
// 写/删一批日志与锁文件（本机删除全部进回收站）。探针的数据目录已经挪到
// %TEMP%（SGuard 不备份那里的删除），但一次会话仍然是几十次文件操作，
// 能少开就少开。这里先起一次、五个探针共用（NO_LAUNCH=1 让它们别自己起），
// runner 退出时统一收，也省掉四次冷启动。
//
//   node test/run-probe.mjs
//   CDP_PORT=9344 node test/run-probe.mjs
// ============================================================
import { spawnSync } from 'node:child_process';
import { ensureApp } from './lib/appctl.mjs';

const PORT = Number(process.env.CDP_PORT || 9333);
const PROBES = ['probe-app', 'probe-bmenu', 'probe-ctx', 'probe-compare', 'probe-undo', 'probe-quicknote'];

const app = await ensureApp(PORT);
console.log(app.reused ? `复用已在端口 ${PORT} 的应用` : `已启动应用（pid ${app.pid}）`);

let bad = 0;
for (const name of PROBES) {
  const r = spawnSync(process.execPath, [`test/${name}.mjs`], {
    stdio: 'inherit',
    env: { ...process.env, NO_LAUNCH: '1', CDP_PORT: String(PORT) },
  });
  if (r.status !== 0) bad++;
}

// ensureApp 注册了 exit 钩子，这里退出时会把应用收掉（先 WM_CLOSE，再兜底强杀）
process.exit(bad ? 1 : 0);
