// ============================================================
// selmatch.js —— 所见即所得：选中一段文字时，标出文档里相同的文字
//
// 纯视图：走 CSS Custom Highlight API，不插 <mark>、不动 DOM、不触发 flush。
// 查找高亮（domfind.js）与代码块着色（codehilite.js）也用这套机制，三个
// Highlight 名字互不冲突。往 contenteditable 里插真实节点会毁掉行内结构与
// 光标位置，也是「输入即脏」的来源，所以这里一个字节的文档都不改。
// ============================================================

const HL = 'sn-same';
/* 中文一个字就是一个词（「红」「重点」里的「重」），所以最小长度取 1；
   噪音靠 MAX_HITS 兜住，而不是靠一刀切拒绝单字。
   与 CM6 侧的 minSelectionLength: 1 / maxMatches: 300 保持一致。 */
const MIN_LEN = 1;
const MAX_SEL = 64;
const MAX_TEXT = 200000;   // 超过就不标：拖选时逐帧扫全文会卡
const MAX_HITS = 300;

/* 代码块 / 公式块有自己的 token 着色，再铺一层灰底会把颜色盖脏；行内代码同理。 */
const SKIP = '.w-code, .w-tex, pre, code, .katex';

const live = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

export function clearSelMatch() {
  if (live()) CSS.highlights.delete(HL);
}

/** 收集可参与匹配的文本节点，并记下它们在「拼接全文」里的起点。 */
function textNodes(root) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && p.closest(SKIP)) continue;
    const v = n.nodeValue || '';
    if (!v) continue;
    total += v.length;
    if (total > MAX_TEXT) return null;
    out.push({ node: n, start: total - v.length, len: v.length });
  }
  return out;
}

/** 把全文偏移 [s, e) 拆成若干 Range（一个命中可能横跨多个文本节点）。 */
function addRangeFor(hl, nodes, s, e) {
  /* 二分找第一个与 s 相交的节点，避免「每个命中都从头扫一遍节点表」 */
  let lo = 0, hi = nodes.length - 1, first = nodes.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].start + nodes[mid].len > s) { first = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  for (let i = first; i < nodes.length; i++) {
    const x = nodes[i];
    if (x.start >= e) break;
    const a = Math.max(s, x.start);
    const b = Math.min(e, x.start + x.len);
    if (a >= b) continue;
    const r = document.createRange();
    r.setStart(x.node, a - x.start);
    r.setEnd(x.node, b - x.start);
    hl.add(r);
  }
}

/**
 * @param {HTMLElement} root 所见即所得的根容器
 * @param {Selection|null} sel 当前选区
 */
export function updateSelMatch(root, sel) {
  if (!live()) return;
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) { clearSelMatch(); return; }
  const r = sel.getRangeAt(0);
  /* 选区不在正文里（查找框、侧栏、预览、编辑模式）一律清掉，别把上一次的
     灰底留在屏幕上 —— CSS.highlights 是全局注册表，不会自己消失。 */
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) { clearSelMatch(); return; }

  const needle = String(sel).replace(/\u200b/g, '').trim();
  if (needle.length < MIN_LEN || needle.length > MAX_SEL || /[\r\n]/.test(needle)) {
    clearSelMatch();
    return;
  }

  const nodes = textNodes(root);
  if (!nodes || !nodes.length) { clearSelMatch(); return; }
  const all = nodes.map((x) => x.node.nodeValue).join('');
  /* 忽略大小写，但 toLowerCase 在个别字符上会改变长度（İ → i̇）：
     hay 或 key 一旦变长，命中偏移就全错了。只把 key 退回原文、却继续拿
     小写后的全文去搜，照样会涂错位置 —— 这种情况两边一起退回原文匹配，
     宁可少标几个，也不能把灰底糊到别的字上。 */
  const lowAll = all.toLowerCase();
  const lowKey = needle.toLowerCase();
  const fold = lowAll.length === all.length && lowKey.length === needle.length;
  const hay = fold ? lowAll : all;
  const key = fold ? lowKey : needle;

  const hits = [];
  let at = 0;
  while (hits.length < MAX_HITS) {
    const i = hay.indexOf(key, at);
    if (i < 0) break;
    hits.push([i, i + needle.length]);
    at = i + needle.length;      // 命中不重叠，避免同一个词被反复扫
  }
  if (!hits.length) { clearSelMatch(); return; }

  const hl = new Highlight();
  for (const [s, e] of hits) addRangeFor(hl, nodes, s, e);
  if (hl.size) CSS.highlights.set(HL, hl);
  else clearSelMatch();
}
