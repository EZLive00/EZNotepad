// ============================================================
// domfind.js —— 在「渲染后的 DOM」里查找文字（所见即所得 / 预览）
//
// 为什么不能直接用 md 源码的偏移：所见即所得里 `**粗**` 已经变成 <strong>，
// 用户看到的是「粗」两个字，用源码偏移去定位会差好几格。
// 所以这里按「块」建立自己的字符索引，再映射回 DOM Range。
//
// 高亮走 CSS Custom Highlight API（Chromium 105+，WebView2 早就支持）：
// 往 DOM 里插 <mark> 会破坏 contenteditable 的结构和光标位置，得不偿失。
// 不支持时降级成「只滚动、不画高亮」，功能不残。
// ============================================================

const HL_ALL = 'sn-find';
const HL_CUR = 'sn-find-cur';

/** 这些子树里的文字不参与查找（列表符号、任务框、块标记、代码块语言标签、
 *  代码预览的行号、JSON 预览顶部的校验横幅、KaTeX 那份 aria-hidden 的
 *  MathML —— 后者和可见的 katex-html 是同一份公式，算进去每处公式都会命中两次） */
const SKIP = '.w-li-marker, .w-check, .w-hash, .w-codebar, .ln, .json-err, .katex-mathml';

const NL = '\n';

/**
 * 哪些元素算「块」——它决定两件事：块与块之间插一个 \n，以及跳转时滚到哪儿。
 *   · 所见即所得：根的直接子元素就是 `.w-block`（结构自己定的，最准）
 *   · 预览（markdown）：根下只有一个 `<div class="md">`，真正的正文块是它的子元素
 *   · 预览（代码 / JSON）：整篇是一个 `<pre>`，逐行定位靠 `.codeline`
 *   · 纯文本预览：一个 `<pre>` 装全文 —— 就用它，滚动交给 scrollTo 按匹配矩形兜底
 * 以前只认 `.w-block`，于是预览 DOM 里一个块都扫不出来，查找在预览模式下永远 0 命中。
 */
function blocksOf(root) {
  const kids = [...root.children];
  const wys = kids.filter((b) => b.classList.contains('w-block'));
  if (wys.length) return wys;
  const md = kids.find((b) => b.classList.contains('md'));
  if (md) return [...md.children];
  const lines = root.querySelectorAll('.codeline');
  if (lines.length) return [...lines];
  return kids;
}

/**
 * 整篇建一份索引，块与块之间插一个 \n。
 *
 * 为什么不再「一个块一份索引」：查询串里带换行时（查找框的换行按钮就是干这个的），
 * `甲\n乙` 要能匹配上下两段，而块内文本里根本没有换行符，永远命中不到。
 * 显式插入分隔符后，不带换行的查询照样不可能匹配到「上一段结尾 + 下一段开头」
 * 这种假命中——和以前按块隔离是同一个效果。
 */
function indexOfDoc(root) {
  const nodes = [];    // 文本节点 → 在全文中的起点
  const spans = [];    // 块 → 在全文中的范围（滚动与定位用）
  let text = '';
  let first = true;
  for (const block of blocksOf(root)) {
    if (!first) text += NL;
    first = false;
    const start = text.length;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n, start: text.length });
      text += n.nodeValue;
    }
    spans.push({ block, start, end: text.length });
  }
  return { text, nodes, spans };
}

/** 某个绝对偏移落在哪个块上（spans 单调递增，二分） */
function blockAt(idx, offset) {
  let lo = 0;
  let hi = idx.spans.length - 1;
  let pick = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx.spans[mid].start <= offset) { pick = idx.spans[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return pick ? pick.block : null;
}

/**
 * 找出某个绝对偏移落在哪个文本节点上（返回节点 + 节点内偏移）。
 * @param {boolean} [asEnd] 取匹配结尾时用：偏移正好落在两个节点的接缝上，
 *   要落在**前一个节点的末尾**，而不是后一个节点的开头。
 *   落在后一个节点开头的话，`粗体` 这种「整段就是一个 <strong>」的匹配会
 *   算成跨节点，替换时就被误判成「劈开了格式」。
 */
function locate(nodes, offset, asEnd) {
  if (!nodes.length) return null;
  // nodes[].start 单调递增，二分即可（长文档里匹配很多时别每match 都线性扫）
  let lo = 0;
  let hi = nodes.length - 1;
  let pick = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const hit = asEnd ? nodes[mid].start < offset : nodes[mid].start <= offset;
    if (hit) { pick = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const n = nodes[pick];
  const len = n.node.nodeValue.length;
  const off = Math.max(0, Math.min(len, offset - n.start));
  return { node: n.node, offset: off };
}

function rangeOf(idx, start, end) {
  const a = locate(idx.nodes, start, false);
  const b = locate(idx.nodes, end, true);
  if (!a || !b) return null;
  try {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  } catch {
    return null;
  }
}

/**
 * 在 root 里找全部匹配。一个匹配可以横跨多个块（查询里带换行时）。
 * @returns {Array<{block:Element, start:number, end:number, idx:object}>} 全文字符偏移
 */
export function findInDom(root, re) {
  const out = [];
  if (!root || !re) return out;
  const idx = indexOfDoc(root);
  if (!idx.text) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(idx.text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    out.push({ block: blockAt(idx, m.index), start: m.index, end: m.index + m[0].length, idx });
    if (out.length >= 2000) return out;
  }
  return out;
}

/** 把「块 + 块内偏移」还原成 DOM Range（插入替换文字时也用得上） */
export function rangeFor(match) {
  if (!match || !match.idx) return null;
  return rangeOf(match.idx, match.start, match.end);
}

const supported = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

/** 全部匹配淡色、当前匹配实色；current 为 -1 表示只画全部 */
export function paint(matches, current) {
  if (!supported()) return;
  const all = new Highlight();
  let cur = null;
  matches.forEach((m, i) => {
    const r = rangeFor(m);
    if (!r) return;
    if (i === current) { cur = r; return; }
    all.add(r);
  });
  if (all.size) CSS.highlights.set(HL_ALL, all);
  else CSS.highlights.delete(HL_ALL);
  if (cur) {
    const h = new Highlight(cur);
    CSS.highlights.set(HL_CUR, h);
  } else {
    CSS.highlights.delete(HL_CUR);
  }
}

export function clear() {
  if (!supported()) return;
  CSS.highlights.delete(HL_ALL);
  CSS.highlights.delete(HL_CUR);
}

/** 把某个匹配滚到视野中间（block 而不是 range：range 的 rect 在折行时会很窄）
 *
 *  例外：块比视口还高时按块滚没有意义 —— 纯文本预览整篇就是一个 `<pre>`，
 *  滚到「块居中」只会停在半山腰。这时改用匹配自身的矩形，按增量滚。
 */
export function scrollTo(match, scroller) {
  if (!match || !match.block) return;
  const box = scroller.getBoundingClientRect();
  const br = match.block.getBoundingClientRect();
  let top = br.top;
  let bottom = br.bottom;
  let ranged = false;
  if (br.height > box.height * 0.9) {
    const r = rangeFor(match);
    const rr = r ? r.getBoundingClientRect() : null;
    if (rr && rr.height > 0) { top = rr.top; bottom = rr.bottom; ranged = true; }
  }
  // 已经在舒适区内就别动，否则每按一次下一个都跳一下，很晕
  if (top >= box.top + 40 && bottom <= box.bottom - 40) return;
  if (!ranged) {
    match.block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const delta = top - box.top - Math.max(24, (box.height - (bottom - top)) / 2);
  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' });
}
