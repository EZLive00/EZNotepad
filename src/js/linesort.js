// ============================================================
// linesort.js —— 把行按字典序排好（纯函数，不碰 DOM）
//
// 对比工具最常用的一招：两份名单 / 配置项 / 导出结果顺序不同，
// 直接 diff 是满屏红，先各自按字典序排一遍，剩下的差异就只剩
// 真正的增删 —— 顺序噪音被消掉了。
//
// 两个约定：
//   · 排序键跟着「忽略空白 / 忽略大小写」两个开关走。否则排出来的
//     顺序和 diff 认为的「相同」对不上：diff 说这两行一样，排序却
//     把它们分到两处，看着像 bug。
//   · 空行不参与排序，统一沉到末尾。它没有「字典位置」，排到开头
//     会让人以为文档前面凭空多了空行；沉到末尾则行数、行内容都不变，
//     只是顺序变了。
// ============================================================

/** 一行的排序键。放出来是为了让测试能单独盯住这条规则 */
export function sortKey(line, { ignoreWS = true, ignoreCase = false } = {}) {
  let k = String(line);
  if (ignoreWS) k = k.trim();
  if (ignoreCase) k = k.toLowerCase();
  return k;
}

/**
 * 按字典序排序，返回新数组（不改入参）。
 *
 * 用 Intl.Collator('zh-CN') 而不是 `<` / `>` 的码位比较：
 * 码位序下「张三」排在「李四」前面（张 U+5F20 < 李 U+674E 只是巧合对上，
 * 「王五」又跑到最前），中文根本不可读；Collator 按拼音排，才是「字典」。
 * numeric 让 a9 排在 a10 之前 —— 带编号的行几乎总是这个期望。
 */
export function sortLines(lines, opts = {}) {
  const coll = new Intl.Collator('zh-CN', { numeric: true });
  const blank = [];
  const body = [];

  for (const line of lines) {
    const k = sortKey(line, opts);
    if (k === '') blank.push(line);
    else body.push({ line, k });
  }

  // Array#sort 在 ES2019 起是稳定的：键完全相同的行保持原来的先后，
  // 所以重复行不会被打乱，用户看不出「同样内容的行换了位置」。
  body.sort((x, y) => coll.compare(x.k, y.k));
  return body.map((x) => x.line).concat(blank);
}

/** 排序前后是否有变化（避免白跑一遍重算，也用来决定要不要提示） */
export function isSorted(lines, opts = {}) {
  const next = sortLines(lines, opts);
  if (next.length !== lines.length) return false;
  for (let i = 0; i < next.length; i++) if (next[i] !== lines[i]) return false;
  return true;
}
