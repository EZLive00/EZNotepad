// ============================================================
// tabdrag.js —— 标签拖拽的纯计算
//
// 拖拽本身（pointerdown/move/up）在 app.js，这里只放两件能 headless 断言的事：
//   · 指针还在不在标签条这条带子里（在 = 换位，出去 = 拆窗口）
//   · 松手时该插到哪张标签的前面 / 后面
//
// ⛔ 不要改用 HTML5 拖放（draggable + dragstart/dragover/drop）。
// Windows 上 Tauri 的 `dragDropEnabled: true` 会把整个窗口的拖放交给 OS，
// 页面里的 HTML5 拖拽事件**一个都不会来** —— 能写字、能点、就是拖不动，
// 而且没有任何报错（macOS 不受影响，所以只看 mac 是看不出来的）。
// `dragDropEnabled` 又不能关：主窗口还要接住从资源管理器拖进来的文件。
// 所以标签的换位 / 拖出 / 拖回全部自己跟 pointer 事件走（见 app.js 的 attachTabDrag）。
// ============================================================

/**
 * 指针是否横在标签条这条带子里（纵向放宽 slack）。
 *
 * 带子里是「换位」，带子外才是「拖出去开新窗口」。横向不判：拖到最右那颗
 * 右边、或者拖到第一颗左边（想插到最前），都还是换位。
 *
 * slack 取 10：真要排序时手会在上下 10px 内晃，判太死会让标签在「正在换位」
 * 和「要拆窗口」之间反复跳。真正拆窗口还有 leftTabbar 的 24 / 48px 垫距离。
 */
export function inBarBand(bar, point, slack = 10) {
  if (!bar || !point) return false;
  return point.y >= bar.top - slack && point.y <= bar.bottom + slack;
}

/**
 * 算出松手该落到哪儿。
 *
 * items 是**当前视觉顺序**（含被拖的那张），每项要 { id, left, width }；
 * x 是指针的 clientX。判据只看每张标签的中线：在中线左边就插到它前面。
 *
 * 返回 { toId, after }，直接喂给 taborder.js 的 moveById；
 * 挪了等于没挪（落点就在自己两侧）时返回 null，让调用方什么也别做 ——
 * 否则「往右拖过自己中线」会被当成「插到自己后面」，多走一次重排。
 */
export function planDrop(items, dragId, x) {
  if (!items || !items.length) return null;
  if (items.length < 2) return null;

  let at = items.length;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (x < it.left + it.width / 2) { at = i; break; }
  }

  /* 落点两侧只要有一侧是被拖那张自己，就是原地不动：
       落点在被拖那张的前面（at = 自己的下标）或后面（at = 自己下标 + 1） */
  const self = items.findIndex((it) => it.id === dragId);
  if (self >= 0 && (at === self || at === self + 1)) return null;

  /* 落点左边那张（去掉自己）→ 插到它后面；没有就插到右边那张前面 */
  for (let i = at - 1; i >= 0; i -= 1) {
    if (items[i].id !== dragId) return { toId: items[i].id, after: true };
  }
  for (let i = at; i < items.length; i += 1) {
    if (items[i].id !== dragId) return { toId: items[i].id, after: false };
  }
  return null;
}
