// ============================================================
// difflist.js —— 把并排比较的结果折成「差异清单」
//
// 只做纯计算，不碰 DOM：compare.js 负责画，run-units 负责测。
// 清单里的一条 = 一个差异块（连续的非 same 行），带两侧行号范围、
// 类型（修改 / 仅左 / 仅右）和一行可读摘要。
//
// 排序与筛选都在这里做。排序的第二键永远是位置升序 —— 否则
// 「按类型排」时同类型内部会跟着倒序，读起来莫名其妙。
// ============================================================

/** 块类型：两侧都有行 = 修改，只有一侧 = 仅左 / 仅右 */
const kindOf = (nl, nr) => (nl && nr ? 'chg' : (nl ? 'del' : 'add'));

const KIND_ORDER = { chg: 0, del: 1, add: 2 };

/** 摘要取块里第一行有内容的文本：右侧优先，因为「改成了什么」更值得看 */
function summaryOf(rows, start, end) {
  for (let i = start; i <= end; i++) {
    const r = rows[i];
    const t = (r.r && r.r.text) || (r.l && r.l.text) || '';
    if (t.trim()) return t.trim().slice(0, 80);
  }
  return '';
}

/**
 * @param {Array} rows buildSideBySide 的行
 * @param {number[]} blocks 每个差异块的起始行索引
 * @returns {Array<{index,start,end,kind,lFrom,lTo,rFrom,rTo,nl,nr,lines,text}>}
 */
export function blockItems(rows, blocks) {
  const out = [];
  for (let k = 0; k < blocks.length; k++) {
    const start = blocks[k];
    /* 块尾不能取「下一块起点 - 1」：中间那些 same 行不属于任何差异 */
    let end = start;
    while (end + 1 < rows.length && rows[end + 1].kind !== 'same') end++;
    let lFrom = 0, lTo = 0, rFrom = 0, rTo = 0, nl = 0, nr = 0;
    for (let i = start; i <= end; i++) {
      const r = rows[i];
      if (r.l) { if (!lFrom) lFrom = r.l.no; lTo = r.l.no; nl++; }
      if (r.r) { if (!rFrom) rFrom = r.r.no; rTo = r.r.no; nr++; }
    }
    out.push({
      index: k, start, end,
      kind: kindOf(nl, nr),
      lFrom, lTo, rFrom, rTo,
      nl, nr, lines: nl + nr,
      text: summaryOf(rows, start, end),
    });
  }
  return out;
}

/**
 * 筛选 + 排序，返回新数组（不改入参顺序）。
 * @param {Array} items blockItems 的结果
 * @param {{sort?:'pos'|'kind'|'size', dir?:1|-1, filter?:'all'|'chg'|'del'|'add'}} opt
 */
export function arrange(items, opt = {}) {
  const { sort = 'pos', dir = 1, filter = 'all' } = opt;
  const list = filter === 'all' ? items.slice() : items.filter((it) => it.kind === filter);
  const byPos = (a, b) => a.start - b.start;
  list.sort((a, b) => {
    if (sort === 'kind') {
      const d = (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) * dir;
      if (d) return d;
      return byPos(a, b);
    }
    if (sort === 'size') {
      const d = (a.lines - b.lines) * dir;
      if (d) return d;
      return byPos(a, b);
    }
    return byPos(a, b) * dir;
  });
  return list;
}

/** 「12–18」这样的行号区间；只有一行时不给破折号 */
export function rangeText(from, to) {
  if (!from) return '';
  return from === to ? String(from) : `${from}–${to}`;
}
