// ============================================================
// win.js —— 原生窗口控制（自绘标题栏用）
// 窗口装饰已在 tauri.conf.json 关闭（decorations=false），
// 最小化 / 最大化 / 关闭 / 全屏 都在这里调 Tauri 的 window API。
// 在普通浏览器里打开时全部静默失败，方便前端单独调试。
// ============================================================

const HAS_TAURI = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

let pending = null;
function api() {
  if (!HAS_TAURI()) return Promise.resolve(null);
  if (!pending) {
    pending = import('../vendor/api/window.js')
      .then((m) => m.getCurrentWindow())
      .catch(() => null);
  }
  return pending;
}

async function call(method, ...args) {
  try {
    const w = await api();
    if (!w || typeof w[method] !== 'function') return undefined;
    return await w[method](...args);
  } catch (e) {
    console.warn('[window]', method, e);
    return undefined;
  }
}

export const isMaximized = () => call('isMaximized');
export const isFullscreen = () => call('isFullscreen');
export const minimize = () => call('minimize');
export const toggleMaximize = () => call('toggleMaximize');
export const closeWindow = () => call('close');
export const setTitle = (t) => call('setTitle', t);

/**
 * 拦截系统关闭（Alt+F4、任务栏右键关闭）。handler 里可以 preventDefault() 拦下来。
 * 返回是否挂上了监听（浏览器里调试时为 false）。
 */
export async function onCloseRequested(handler) {
  const w = await api();
  if (!w || typeof w.onCloseRequested !== 'function') return false;
  try { await w.onCloseRequested(handler); return true; } catch { return false; }
}

/** 全屏切换（F11）：返回切换后的状态 */
export async function toggleFullscreen() {
  const now = await isFullscreen();
  const next = !now;
  await call('setFullscreen', next);
  return next;
}
