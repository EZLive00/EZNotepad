// ============================================================
// clipboard.js —— 把纯文本写进系统剪贴板的唯一入口
//
// ⛔ 不用 navigator.clipboard.writeText：WebView2 里没有用户激活时抛
//    NotAllowedError，有激活时也偶发不 resolve（对比窗口读剪贴板踩过同一个坑，
//    见 compare.js 的注释）。execCommand('copy') 只依赖「有选区」这一个条件、
//    同步给出成败，菜单和按钮要的正是这种确定性 —— 失败了能真的告诉用户。
//
// 代价是离屏 textarea 的 select() 会顶掉编辑区选区，进出都把它还回去。
// ============================================================

/** @returns {boolean} 是否复制成功 */
export function writeClipboard(text) {
  const s = String(text == null ? '' : text);
  const sel = window.getSelection();
  const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  /* 不能 display:none / visibility:hidden —— 那样 select() 选不中，复制出来是空的 */
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, s.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  /* 用选择器找回来再删：恢复选区可能把焦点/选区挪回编辑区，不能靠引用硬删 */
  ta.remove();
  if (saved && sel) { sel.removeAllRanges(); sel.addRange(saved); }
  return ok;
}
