// ============================================================
// codehilite.js —— 编辑态代码块高亮（不改 DOM）
//
// 代码块在编辑态是 contenteditable 里的一段纯文本（`.w-code` 里只有文本和
// `<br>`）。往里插 `<span>` 会同时毁掉三样东西：光标位置（Blink 会把光标
// 从 span 里踢出来）、撤销记录（记录按块存，结构一变就不是同一个块了）、
// 序列化（多处逻辑假定子节点是 text / br）。所以这里走 **CSS Custom
// Highlight API**：它给「文本区间」上色，不碰 DOM —— 光标、选区、复制、
// 存盘全都不受影响，和查找高亮（domfind.js）是同一套机制。
//
// 区间从哪来：直接喂 `highlight.js` 的输出（预览用的就是它），在离屏节点里
// 走一遍，把每个 `.tok-x` 的文本节点换算成「源码偏移」。没有第二套分词实现，
// 编辑态与预览的高亮因此天然一致。
//
// 代价与边界：单个代码块超过 MAX_CHARS 就不上色（几万字的块每键重分词会卡）；
// 浏览器不支持这个 API 时静默退化成纯文本块（语言条照常显示）。
// ============================================================
import { highlight, normalizeLang, detectLang } from './highlight.js';

const PREFIX = 'sn-tok-';
/** highlight() 真正会产出的 token 类（styles.css 里各有一条 ::highlight 规则） */
const CLS = ['key', 'str', 'num', 'comment', 'punc', 'fn', 'tag', 'attr'];
/** 单块上限：超过就不上色，宁可没有也别让打字变卡 */
const MAX_CHARS = 80000;

const live = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';

/**
 * 代码块的源码文本。
 *
 * **这是「代码块里到底是什么字」的唯一定义** —— 序列化（wysiwyg 的 codeToText）、
 * 复制按钮、高亮分词全都走它。`<br>` 是换行、零宽空格是编辑器垫的垫片（源码里
 * 没有这一位）、不换行空格还原成普通空格。
 *
 * @param {Element} el `.w-code`（或代码块本身）
 * @returns {string}
 */
export function codeText(el) {
  if (!el) return '';
  if (el.childNodes.length === 1 && el.firstChild.nodeName === 'BR') return '';
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) s += n.nodeValue.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    else if (n.nodeName === 'BR') s += '\n';
    else if (n.nodeType === 1) s += codeText(n);
  });
  return s;
}

/* ---------------- highlight() 的 HTML → 源码区间 ---------------- */

let sandbox = null;

/** 把一段 HTML 摊成 `[{start, end, cls}]`，偏移以源码字符计 */
function tokenSpans(html) {
  if (!sandbox) sandbox = document.createElement('div');
  sandbox.innerHTML = html;
  const out = [];
  let off = 0;
  const walk = (node, stack) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        const len = n.nodeValue.length;
        if (len && stack.length) out.push({ start: off, end: off + len, cls: stack[stack.length - 1] });
        off += len;
      } else if (n.nodeType === 1) {
        const m = /^tok-(\w+)$/.exec(n.className || '');
        if (m) stack.push(m[1]);
        walk(n, stack);
        if (m) stack.pop();
      }
    }
  };
  walk(sandbox, []);
  sandbox.textContent = '';
  return out;
}

/* ---------------- 源码偏移 → DOM 位置 ---------------- */

/**
 * 把 `.w-code` 摊成「源码偏移 → 节点位置」的段表。
 *
 * `<br>` 在源码里是换行、占一位却在 DOM 里没有文本节点；零宽空格恰好相反 ——
 * 在 DOM 里是一位、源码里根本没有。所以不能直接拿 textContent 的长度当源码
 * 偏移，得逐个字符记位置（`pos[k]` = 第 k 个源码字符在节点里的下标）。
 */
function segments(el) {
  const segs = [];
  let off = 0;
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      const v = n.nodeValue;
      const pos = [];
      for (let i = 0; i < v.length; i++) if (v[i] !== '\u200b') pos.push(i);
      if (pos.length) segs.push({ node: n, base: off, pos, len: v.length });
      off += pos.length;
    } else if (n.nodeName === 'BR') {
      off += 1;
    } else if (n.nodeType === 1) {
      /* 代码块里理论上只有 text / br。真出现别的元素子节点时只把源码偏移
         往前推、不给它建 range —— 那几个字没有颜色，但也不会让后面的字
         整体错位（错位的结果是颜色涂在别的字上，比没颜色难查得多）。 */
      off += codeText(n).length;
    }
  }
  return segs;
}

function rangeIn(seg, lo, hi) {
  const a = seg.pos[lo];
  if (a === undefined) return null;
  const b = hi < seg.pos.length ? seg.pos[hi] : seg.len;
  if (b <= a) return null;
  const r = document.createRange();
  r.setStart(seg.node, a);
  r.setEnd(seg.node, b);
  return r;
}

/* ---------------- 语言条 ---------------- */

/** 语言条上的名字：用户写了就照抄（`bash` 别显示成 `sh`），没写才显示识别结果 */
function paintBar(block, name) {
  if (!block) return;
  const el = block.querySelector('.cc-lang');
  if (!el) return;
  const shown = name || 'code';
  if (el.textContent !== shown) el.textContent = shown;
}

/* ---------------- 对外入口 ---------------- */

/**
 * 重算 root 里所有代码块的语言条与高亮。幂等，可以随便多调。
 *
 * @param {Element} root 编辑区根节点
 */
export function refreshCode(root) {
  if (!root) return;
  const codes = root.querySelectorAll('.w-code');
  if (!codes.length) { clear(); return; }

  const canPaint = live();
  const byCls = new Map();

  for (const el of codes) {
    const block = el.closest('.w-block');
    const declared = ((block && block.dataset.lang) || '').trim();
    const text = codeText(el);
    const auto = declared || !text ? '' : detectLang(text);
    paintBar(block, declared || auto);

    if (!canPaint || !text || text.length > MAX_CHARS) continue;
    const lang = normalizeLang(declared) || auto;
    if (!lang) continue;

    const spans = tokenSpans(highlight(text, lang));
    if (!spans.length) continue;
    const segs = segments(el);
    if (!segs.length) continue;

    for (const sp of spans) {
      let bucket = byCls.get(sp.cls);
      for (const seg of segs) {
        const lo = Math.max(sp.start, seg.base);
        const hi = Math.min(sp.end, seg.base + seg.pos.length);
        if (hi <= lo) continue;
        const r = rangeIn(seg, lo - seg.base, hi - seg.base);
        if (!r) continue;
        if (!bucket) { bucket = new Highlight(); byCls.set(sp.cls, bucket); }
        bucket.add(r);
      }
    }
  }

  if (!canPaint) return;
  for (const cls of CLS) {
    const key = PREFIX + cls;
    const bucket = byCls.get(cls);
    if (bucket && bucket.size) CSS.highlights.set(key, bucket);
    else CSS.highlights.delete(key);
  }
}

/** 清掉所有代码块高亮（离开编辑器 / 空文档时） */
export function clear() {
  if (!live()) return;
  for (const cls of CLS) CSS.highlights.delete(PREFIX + cls);
}
