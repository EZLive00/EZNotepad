// ============================================================
// diff.js —— 文本对比引擎（行级 LCS/Myers + 行内字符级）与三向合并
// 零依赖，纯函数
// ============================================================

const norm = (s, opt) => {
  let r = s;
  if (opt.ignoreCase) r = r.toLowerCase();
  if (opt.ignoreWS) r = r.replace(/\s+/g, ' ').trim();
  return r;
};

/** DP 表单元格上限：4M 格 × 4 字节 ≈ 16MB，超过就走锚点切分 */
const DP_CELLS = 4_000_000;
/** 锚点递归深度上限，防止病态输入把栈走穿 */
const MAX_DEPTH = 24;

/**
 * 行级差异算法：公共前后缀 → 段内精确 LCS；段大到放不下 DP 表时，
 * 先用「两侧都只出现一次的行」当锚点把段切开，各自递归。
 *
 * 为什么不是简单的二分或「按集合判断有没有公共行」：那些做法只能告诉你
 * 「这行在对方文件里存不存在」，给不出**位置**。曾经就有一个分支把不匹配
 * 的行标成 same 且 b=-1，结果 2000 行对 2000 行的两个文件整页右侧空白 ——
 * 退化得再快，也不能拿假结果冒充真结果。
 *
 * @returns {Array<{type:'same'|'add'|'del', a?:number, b?:number}>}  a/b 为 0 基行号
 */
export function diffLines(aLines, bLines, opt = {}) {
  const A = aLines.map((l) => norm(l, opt));
  const B = bLines.map((l) => norm(l, opt));
  return lcsOps(A, B, 0, 0, 0);
}

/**
 * 求 [A] 到 [B] 的操作序列。offA / offB 是这两段在原文件里的起始行号 ——
 * 两侧偏移**必须分开传**，递归切分后左右不再同步。
 */
function lcsOps(A, B, offA, offB, depth) {
  const n = A.length, m = B.length;

  // 段内先剥公共前后缀：递归切出来的碎片多半同头同尾，剥掉能省下整张 DP 表
  let p = 0;
  while (p < n && p < m && A[p] === B[p]) p++;
  let eA = n - 1, eB = m - 1;
  while (eA >= p && eB >= p && A[eA] === B[eB]) { eA--; eB--; }
  const sameCount = n - 1 - eA;          // 后缀长度，左右一致

  const head = [];
  for (let k = 0; k < p; k++) head.push({ type: 'same', a: offA + k, b: offB + k });
  const tail = [];

  const an = eA - p + 1, bn = eB - p + 1;
  let mid;
  if (an === 0 && bn === 0) {
    mid = [];
  } else if (an === 0) {
    mid = [];
    for (let j = 0; j < bn; j++) mid.push({ type: 'add', b: offB + p + j });
  } else if (bn === 0) {
    mid = [];
    for (let i = 0; i < an; i++) mid.push({ type: 'del', a: offA + p + i });
  } else {
    const sa = A.slice(p, eA + 1), sb = B.slice(p, eB + 1);
    if (an * bn <= DP_CELLS) mid = dpOps(sa, sb, offA + p, offB + p);
    else if (depth >= MAX_DEPTH) mid = coarseOps(sa, sb, offA + p, offB + p);
    else mid = anchoredOps(sa, sb, offA + p, offB + p, depth);
  }

  for (let k = 0; k < sameCount; k++) {
    tail.push({ type: 'same', a: offA + eA + 1 + k, b: offB + eB + 1 + k });
  }
  return head.concat(mid, tail);
}

/** 经典 LCS 动态规划，输出最小编辑脚本。只在该段能放下 DP 表时调用 */
function dpOps(A, B, offA, offB) {
  const n = A.length, m = B.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: 'same', a: offA + i, b: offB + j });
      i++; j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ type: 'del', a: offA + i }); i++;
    } else {
      ops.push({ type: 'add', b: offB + j }); j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', a: offA + i }); i++; }
  while (j < m) { ops.push({ type: 'add', b: offB + j }); j++; }
  return ops;
}

/**
 * 锚点切分：在两侧都恰好出现一次的行里，取「两边顺序一致」的最长子序列
 * 作为锚点。重复行（空行、表格分隔线）不当锚点 —— 它们的位置本来就多解，
 * 拿来定位只会把差异切碎。
 */
function anchoredOps(A, B, offA, offB, depth) {
  const cntA = new Map(), cntB = new Map(), posB = new Map();
  for (const s of A) cntA.set(s, (cntA.get(s) || 0) + 1);
  for (let j = 0; j < B.length; j++) {
    const s = B[j];
    cntB.set(s, (cntB.get(s) || 0) + 1);
    posB.set(s, j);
  }
  const cand = [];
  for (let i = 0; i < A.length; i++) {
    const s = A[i];
    if (cntA.get(s) === 1 && cntB.get(s) === 1) cand.push([i, posB.get(s)]);
  }
  if (!cand.length) return coarseOps(A, B, offA, offB);

  const anchors = lisByJ(cand);
  const ops = [];
  let ai = 0, bi = 0;
  for (const [i, j] of anchors) {
    if (i > ai || j > bi) {
      ops.push(...lcsOps(A.slice(ai, i), B.slice(bi, j), offA + ai, offB + bi, depth + 1));
    }
    ops.push({ type: 'same', a: offA + i, b: offB + j });
    ai = i + 1; bi = j + 1;
  }
  if (ai < A.length || bi < B.length) {
    ops.push(...lcsOps(A.slice(ai), B.slice(bi), offA + ai, offB + bi, depth + 1));
  }
  return ops;
}

/** 候选锚点已按 A 的行号升序，取其中 B 行号的最长严格递增子序列 */
function lisByJ(cand) {
  const tails = [], idx = [], prev = new Array(cand.length).fill(-1);
  for (let k = 0; k < cand.length; k++) {
    const j = cand[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = idx[lo - 1];
    tails[lo] = j; idx[lo] = k;
  }
  const out = [];
  let k = idx.length ? idx[idx.length - 1] : -1;
  while (k >= 0) { out.push(cand[k]); k = prev[k]; }
  return out.reverse();
}

/**
 * 兜底：整段视为「全删 + 全增」。只在两侧一个锚点都找不到时走到这里，
 * 语义上是「这段被整体替换了」。绝不能把不匹配的行标成 same —— 那会让
 * 行号错位，界面上看起来像整页未改动。
 */
function coarseOps(A, B, offA, offB) {
  const ops = [];
  for (let i = 0; i < A.length; i++) ops.push({ type: 'del', a: offA + i });
  for (let j = 0; j < B.length; j++) ops.push({ type: 'add', b: offB + j });
  return ops;
}

/**
 * 行内字符级差异。
 * @returns {{l:string,r:string}} 带 <mark> 标记的 HTML 片段（已转义）
 */
export function inlineDiff(left, right) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toks = (s) => s.match(/[\u4e00-\u9fa5]|[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_\u4e00-\u9fa5]/g) || [];
  const a = toks(left), b = toks(right);
  const n = a.length, m = b.length;
  if (n * m > 250_000) {
    return { l: `<mark class="rem">${esc(left)}</mark>`, r: `<mark class="ins">${esc(right)}</mark>` };
  }
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  let i = 0, j = 0, ol = '', or = '';
  const flushL = [], flushR = [];
  const pushL = (s) => { flushL.push(s); };
  const commit = () => {
    if (flushL.length) ol += `<mark class="rem">${esc(flushL.join(''))}</mark>`;
    if (flushR.length) or += `<mark class="ins">${esc(flushR.join(''))}</mark>`;
    flushL.length = 0; flushR.length = 0;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      commit();
      ol += esc(a[i]); or += esc(b[j]);
      i++; j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      pushL(a[i]); i++;
    } else {
      flushR.push(b[j]); j++;
    }
  }
  while (i < n) pushL(a[i++]);
  while (j < m) flushR.push(b[j++]);
  commit();
  return { l: ol, r: or };
}

/**
 * 生成并排比对的行模型：左右各一行，空行占位
 * @returns {{rows:Array<{l:object|null,r:object|null,kind:string}>, blocks:number[]}}
 */
export function buildSideBySide(aLines, bLines, opt = {}) {
  const ops = diffLines(aLines, bLines, opt);
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === 'same') {
      rows.push({
        l: { no: op.a + 1, text: aLines[op.a] },
        r: { no: op.b + 1, text: bLines[op.b] },
        kind: 'same',
      });
      k++;
      continue;
    }
    // 收集一段连续的 del / add
    const dels = [], adds = [];
    while (k < ops.length && ops[k].type !== 'same') {
      if (ops[k].type === 'del') dels.push({ no: ops[k].a + 1, text: aLines[ops[k].a] });
      else adds.push({ no: ops[k].b + 1, text: bLines[ops[k].b] });
      k++;
    }
    const len = Math.max(dels.length, adds.length);
    for (let x = 0; x < len; x++) {
      const L = dels[x] || null;
      const R = adds[x] || null;
      let kind;
      if (L && R) kind = 'chg';
      else if (L) kind = 'del';
      else kind = 'add';
      rows.push({ l: L, r: R, kind, blockId: rows.length });
    }
  }
  // 差异块编号（用于 F7/F8 导航）
  const blocks = [];
  rows.forEach((row, idx) => {
    if (row.kind !== 'same') {
      if (idx === 0 || rows[idx - 1].kind === 'same') blocks.push(idx);
    }
  });
  return { rows, blocks };
}

export function diffStats(rows) {
  let add = 0, del = 0, chg = 0;
  for (const r of rows) {
    if (r.kind === 'add') add++;
    else if (r.kind === 'del') del++;
    else if (r.kind === 'chg') chg++;
  }
  return { add, del, chg, same: rows.length - add - del - chg };
}

/* ============================================================
 * 三向合并：以 base 为基准，合并 a、b 两侧改动
 * ============================================================ */

/** 从 base->x 得到 hunks: [{baseStart, baseEnd, lines}] */
function toHunks(base, x, opt) {
  const rows = buildSideBySide(base, x, opt).rows;
  const hunks = [];
  let cur = null;
  let baseIdx = 0;
  for (const r of rows) {
    if (r.kind === 'same') {
      if (cur) { hunks.push(cur); cur = null; }
      baseIdx++;
    } else {
      if (!cur) cur = { baseStart: baseIdx, baseEnd: baseIdx, lines: [] };
      if (r.l) { cur.baseEnd++; baseIdx++; }
      if (r.r) cur.lines.push(r.r.text);
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

/**
 * 三向合并
 * @returns {{text:string, conflicts:Array<{aStart:number,aEnd:number}>}}
 */
export function merge3(baseText, aText, bText) {
  const opt = { ignoreWS: false, ignoreCase: false };
  const base = baseText.replace(/\r\n?/g, '\n').split('\n');
  const A = aText.replace(/\r\n?/g, '\n').split('\n');
  const B = bText.replace(/\r\n?/g, '\n').split('\n');
  const hA = toHunks(base, A, opt);
  const hB = toHunks(base, B, opt);

  // 合并两边 hunk（按 baseStart 排序，区间重叠视为可能需要冲突判定）
  const all = [...hA.map((h) => ({ ...h, side: 'A' })), ...hB.map((h) => ({ ...h, side: 'B' }))]
    .sort((x, y) => x.baseStart - y.baseStart || x.baseEnd - y.baseEnd);

  const groups = [];
  for (const h of all) {
    const last = groups[groups.length - 1];
    if (last && h.baseStart < last.baseEnd) {
      last.items.push(h);
      last.baseEnd = Math.max(last.baseEnd, h.baseEnd);
    } else if (last && h.baseStart === last.baseStart && h.baseStart === last.baseEnd) {
      last.items.push(h);
      last.baseEnd = Math.max(last.baseEnd, h.baseEnd);
    } else {
      groups.push({ baseStart: h.baseStart, baseEnd: h.baseEnd, items: [h] });
    }
  }

  const out = [];
  const conflicts = [];
  let pos = 0;
  for (const g of groups) {
    // base 未变的部分
    for (; pos < g.baseStart; pos++) out.push(base[pos]);
    const fromA = g.items.filter((i) => i.side === 'A');
    const fromB = g.items.filter((i) => i.side === 'B');
    if (fromA.length && fromB.length) {
      const ta = fromA.flatMap((i) => i.lines).join('\n');
      const tb = fromB.flatMap((i) => i.lines).join('\n');
      if (ta === tb) {
        out.push(...ta.split('\n'));
      } else {
        conflicts.push({ aStart: g.baseStart, aEnd: g.baseEnd, aText: ta, bText: tb });
        // 冲突处保留 A 侧内容，并标记（不写入冲突标记，避免污染文档）
        out.push(...ta.split('\n'));
      }
    } else if (fromA.length) {
      out.push(...fromA.flatMap((i) => i.lines));
    } else {
      out.push(...fromB.flatMap((i) => i.lines));
    }
    pos = g.baseEnd;
  }
  for (; pos < base.length; pos++) out.push(base[pos]);

  return { text: out.join('\n'), conflicts, aHunks: hA.length, bHunks: hB.length };
}
