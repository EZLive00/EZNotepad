// ============================================================
// taborder.js —— 标签的纯逻辑（命名、排序）
//
// 单独拆出来的原因：这两个函数是纯数据变换，不碰 DOM 也不碰 Tauri，
// 所以能用 node 直接跑断言（test/run-units.mjs）。
// 放在 app.js 里就只能靠手点验证，而「重名」和「插错位置」恰恰是手点最容易漏的。
// ============================================================

/**
 * 新建文档的名字。连开三个不该都叫「未命名.md」，
 * 重名时依次加序号：未命名.md → 未命名 2.md → 未命名 3.md。
 * @param {string[]} names 现有标签名
 * @param {string} ext 扩展名（不带点）
 */
export function freeUntitledName(names, ext) {
  const used = new Set(names || []);
  let name = `未命名.${ext}`;
  let n = 1;
  while (used.has(name)) {
    n += 1;
    name = `未命名 ${n}.${ext}`;
  }
  return name;
}

/**
 * 把 fromId 挪到 toId 之前/之后，返回新数组（不改原数组）。
 * 找不到 toId 时放到末尾 —— 拖到标签栏空白处的语义。
 * @param {Array<{id:number|string}>} list
 * @param {boolean} after true = 插到 toId 后面
 */
export function moveById(list, fromId, toId, after) {
  if (fromId === toId) return list;      // 拖回自己身上：什么也不做（否则会被当成「找不到目标」丢到末尾）
  const from = list.findIndex((t) => t.id === fromId);
  if (from < 0) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  const to = next.findIndex((t) => t.id === toId);
  if (to < 0) next.push(item);
  else next.splice(after ? to + 1 : to, 0, item);
  return next;
}
