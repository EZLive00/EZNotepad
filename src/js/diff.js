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

/**
 * 行级差异算法（Myers 的等价实现：基于公共前后缀 + LCS 动态规划，
 * 大文件时退化到分块处理，保证不卡死）
 * @returns {Array<{type:'same'|'add'|'del', a?:number, b?:number}>}  a/b 为 0 基行号
 */
export function diffLines(aLines, bLines, opt = {}) {
  const A = aLines.map((l) => norm(l, opt));
  const B = bLines.map((l) => norm(l, opt));
  const n = A.length, m = B.length;
  const ops = [];

  // 前缀
  let start = 0;
  while (start < n && start < m && A[start] === B[start]) {
    ops.push({ type: 'same', a: start, b: start });
    start++;
  }
  // 后缀
  let endA = n - 1, endB = m - 1;
  const tail = [];
  while (endA >= start && endB >= start && A[endA] === B[endB]) {
    tail.push({ type: 'same', a: endA, b: endB });
    endA--; endB--;
  }
  tail.reverse();

  const midA = A.slice(start, endA + 1);
  const midB = B.slice(start, endB + 1);
  const mid = lcsOps(midA, midB, start);
  ops.push(...mid, ...tail);

  // 把相邻的 del/add 合并成「修改块」
  return ops;
}

/** 经典 LCS -> 操作序列。对超长中段做分块，避免 O(n*m) 内存爆炸 */
function lcsOps(A, B, offset) {
  const n = A.length, m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return B.map((_, j) => ({ type: 'add', b: offset + j }));
  if (m === 0) return A.map((_, i) => ({ type: 'del', a: offset + i }));

  // 规模控制：任一侧超过 1500 行时，用「无公共行」快速判定
  if (n * m > 4_000_000) {
    const setB = new Set(B);
    const ops = [];
    for (let i = 0; i < n; i++) {
      if (!setB.has(A[i])) ops.push({ type: 'del', a: offset + i });
      else ops.push({ type: 'same', a: offset + i, b: -1 });
    }
    const setA = new Set(A);
    for (let j = 0; j < m; j++) if (!setA.has(B[j])) ops.push({ type: 'add', b: offset + j });
    return ops;
  }

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
      ops.push({ type: 'same', a: offset + i, b: offset + j });
      i++; j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      ops.push({ type: 'del', a: offset + i }); i++;
    } else {
      ops.push({ type: 'add', b: offset + j }); j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', a: offset + i }); i++; }
  while (j < m) { ops.push({ type: 'add', b: offset + j }); j++; }
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
