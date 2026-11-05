// ============================================================
// diagram.js —— ```mermaid 代码块的渲染
//
// 只在**真的出现** mermaid 块时才去加载引擎（5.4 MB 的 vendor/mermaid.js）。
// 没有图的文档连 import 都不会发生，启动路径一个字节都不多读。
//
// 三件事必须做对，否则体验是「图时有时无」：
//   1. 缓存按「源码 + 主题」存 SVG。预览每次输入都会重渲染整篇，
//      没有缓存的话一张流程图的 100 ms 会被每敲一个字重跑一遍。
//   2. 异步回来时容器可能已经被重渲染过：落笔前必须确认那个 <pre> 还挂在文档里，
//      否则会把旧的 SVG 贴进已经作废的节点（看起来就是「图闪一下又没了」）。
//   3. 画不出来就把错误和源码留在原处。静默吞掉的话，用户只会看到
//      「我写的图不见了」，无从下手改。
// ============================================================

/** 源码 + 主题 → SVG。mermaid 的渲染不便宜（流程图 50~200 ms），值得缓存 */
const cache = new Map();
const CACHE_MAX = 80;

let libPromise = null;
let initedTheme = '';
let seq = 0;

const themeName = () => (document.body.dataset.theme === 'dark' ? 'dark' : 'default');

function lib() {
  if (!libPromise) {
    libPromise = import('../vendor/mermaid.js').then((m) => m.default).catch((e) => {
      /* 加载失败（文件没打进来）也算「没有引擎」，别每次输入都重试 */
      libPromise = Promise.reject(e);
      throw e;
    });
  }
  return libPromise;
}

/** 主题一换，mermaid 的配色就得跟着换；initialize 是全局的，切一次就够 */
function initTheme(mm, theme) {
  if (initedTheme === theme) return;
  mm.initialize({
    startOnLoad: false,
    /* 用户写的图来自文档，不是可信输入：strict 会把标签里的 HTML 过滤掉，
       同时禁止 click 绑定跑脚本 */
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme,
    fontFamily: getComputedStyle(document.body).fontFamily,
  });
  initedTheme = theme;
}

function remember(key, svg) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, svg);
}

/** 一张图 → SVG 字符串；失败返回 { error } */
async function draw(mm, src, theme) {
  const key = theme + '\u0000' + src;
  const hit = cache.get(key);
  if (hit) return { svg: hit };
  try {
    const { svg } = await mm.render(`mmd-${++seq}`, src);
    remember(key, svg);
    return { svg };
  } catch (e) {
    return { error: String((e && e.message) || e || '').split('\n')[0] || 'mermaid' };
  }
}

/**
 * 把容器里所有 ```mermaid 代码块换成图。
 * @param {HTMLElement} root
 * @returns {Promise<number>} 画出来的张数
 */
export async function renderDiagrams(root) {
  if (!root) return 0;
  const codes = [...root.querySelectorAll('pre > code.lang-mermaid')];
  if (!codes.length) return 0;

  let mm;
  try {
    mm = await lib();
    initTheme(mm, themeName());
  } catch {
    return 0;       // 引擎没打进来：保留源码，不报错也不中断预览
  }

  const theme = themeName();
  let made = 0;
  for (const code of codes) {
    const pre = code.parentElement;
    const src = code.textContent.trim();
    if (!pre || !src) continue;

    const r = await draw(mm, src, theme);
    /* 等渲染的这几十毫秒里，预览很可能已经因为下一次输入重渲染了：
       旧的 <pre> 不再挂在文档上，这一份结果直接丢掉 */
    if (!pre.isConnected) continue;

    if (r.svg) {
      const fig = document.createElement('figure');
      fig.className = 'mermaid-fig';
      fig.innerHTML = r.svg;
      pre.replaceWith(fig);
      made++;
    } else {
      const tip = document.createElement('div');
      tip.className = 'mermaid-err';
      tip.textContent = r.error;
      pre.after(tip);
    }
  }
  return made;
}

/** 主题变了：缓存全作废（SVG 里的颜色是写死的） */
export function resetDiagramCache() {
  cache.clear();
  initedTheme = '';
}
