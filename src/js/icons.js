// ============================================================
// icons.js —— 图标引用辅助
// 图标本身来自 Lucide（ISC），以 <symbol> 精灵图形式内联在 index.html，
// 由 scripts/build-icons.mjs 从 src/vendor/icons/lucide/*.svg 生成。
// 这里只负责拼 <use> 引用，不包含任何路径数据。
// ============================================================
const NS = 'http://www.w3.org/2000/svg';

/** 图标名 -> 精灵图 id（接受 'search' 或 'i-search' 两种写法） */
const ref = (name) => '#' + (name.startsWith('i-') ? name : 'i-' + name);

/** 生成一段可直接插入 innerHTML 的图标标记 */
export function iconHTML(name, cls = '') {
  return `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="${ref(name)}" /></svg>`;
}

/** 把已存在的 <svg>（或含 svg 的容器）切到指定图标 */
export function setIcon(target, name) {
  if (!target) return;
  const svg = target.tagName && target.tagName.toLowerCase() === 'svg' ? target : target.querySelector('svg');
  if (!svg) return;
  let use = svg.querySelector('use');
  if (!use) {
    use = document.createElementNS(NS, 'use');
    svg.appendChild(use);
  }
  use.setAttribute('href', ref(name));
}
