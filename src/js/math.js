// ============================================================
// math.js —— 数学公式（KaTeX）
//
// 两个原则：
//   1. 懒加载。脚本和样式是 document 里动态插 <link>/<script> 加载的，
//      不写公式的文档不会为这 546 KB 付任何代价（不下载、不解析、不占内存）。
//   2. 只渲染预览。所见即所得里公式保持 $...$ 源码显示：往 contenteditable
//      里塞 contenteditable=false 的渲染节点，退格删不掉、光标会卡住，
//      序列化也得额外照顾，代价远大于收益。要看成 Ctrl+3，或者开双栏。
// ============================================================

const BASE = 'vendor/katex/';
let loading = null;

/** 只在首次用到时把 KaTeX 拉进来；失败一次就记住，不反复重试 */
export function ensureKatex() {
  if (window.katex && window.renderMathInElement) return Promise.resolve(true);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = BASE + 'katex.min.css';
    document.head.appendChild(css);

    const load = (src) => new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = BASE + src;
      s.async = false;                       // 保持顺序：auto-render 依赖 katex
      s.onload = () => res(true);
      s.onerror = () => rej(new Error(src));
      document.head.appendChild(s);
    });
    load('katex.min.js')
      .then(() => load('auto-render.min.js'))
      .then(() => resolve(!!(window.katex && window.renderMathInElement)))
      .catch(() => resolve(false));
  });
  return loading;
}

const DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '$', right: '$', display: false },
];

/**
 * 扫一遍元素里的公式并渲染。
 * 拿 token 认「这一轮是不是已经过期」——预览是复用同一个容器做 innerHTML 替换的，
 * 光看 isConnected 分辨不出内容已经换过一轮了。
 */
export function renderMathIn(el) {
  if (!el || !el.textContent.includes('$')) return;
  const token = (el.__mathToken = (el.__mathToken || 0) + 1);
  ensureKatex().then((ok) => {
    if (!ok || el.__mathToken !== token) return;
    try {
      window.renderMathInElement(el, {
        delimiters: DELIMS,
        throwOnError: false,
        strict: false,
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
      });
    } catch { /* 公式写错了不该让整篇预览挂掉 */ }
  });
}
