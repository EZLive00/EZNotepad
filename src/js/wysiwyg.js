// ============================================================
// wysiwyg.js —— Markdown 所见即所得编辑视图
// 采用「块级编辑」模型：每行内容是一个可编辑块（标题/段落/列表/代码/引用），
// 块内即时渲染粗体、斜体、行内码等行内样式。
// 输入后立即把 DOM 序列化回 Markdown 写回数据源。
// ============================================================

import { highlight } from './highlight.js';

export class WysiwygEditor {
  constructor(root, opts = {}) {
    this.root = root;
    this.onChange = opts.onChange || (() => {});
    this.silent = false;
    root.addEventListener('input', () => this.handleInput());
    root.addEventListener('paste', (e) => this.handlePaste(e));
    root.addEventListener('keydown', (e) => this.handleKey(e));
    root.addEventListener('blur', () => { this.flush(); });
    root.addEventListener('dragover', (e) => e.preventDefault());
    root.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) return;
      e.preventDefault();
    });
  }

  /** 用 Markdown 源重建视图；restore 为 {blockIndex, offset} 用于恢复光标 */
  render(md, restore) {
    this.silent = true;
    this.root.innerHTML = mdToHtml(md);
    this.silent = false;
    if (restore) this.restoreCaret(restore);
  }

  toMarkdown() {
    return blocksToMarkdown(this.root);
  }

  /** 把当前光标位置映射为 {blockIndex, offset} */
  caretState() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const node = sel.anchorNode;
    const block = node && (node.nodeType === 1 ? node.closest('.w-block') : node.parentElement && node.parentElement.closest('.w-block'));
    if (!block) return null;
    const idx = [...this.root.children].indexOf(block);
    return { blockIndex: idx, offset: sel.anchorOffset };
  }

  restoreCaret(state) {
    const block = this.root.children[state.blockIndex];
    if (!block) return;
    const target = block.querySelector('.w-text') || block;
    const range = document.createRange();
    try {
      range.setStart(target, Math.min(state.offset, target.childNodes.length));
    } catch {
      range.selectNodeContents(target);
    }
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  handleInput() {
    if (this.silent) return;
    this.syncBlockTypes();
    this.flush();
    this.maybeConvertShortcut();
  }

  /** 浏览器原生回车会产生新的子元素：把游离 div 提升为独立块，并同步类型 */
  syncBlockTypes() {
    const direct = [...this.root.childNodes];
    for (const n of direct) {
      if (n.nodeType === 1 && !n.classList.contains('w-block')) {
        const b = document.createElement('div');
        b.className = 'w-block';
        const type = n.tagName === 'H1' || n.tagName === 'H2' || n.tagName === 'H3' ? 'h' + n.tagName[1] : 'p';
        b.dataset.type = type;
        const inner = document.createElement('span');
        inner.className = 'w-text';
        inner.innerHTML = n.innerHTML || '<br>';
        b.appendChild(inner);
        n.replaceWith(b);
      }
    }
  }

  flush() {
    if (this.silent) return;
    this.onChange(this.toMarkdown());
  }

  /** "# " 变标题、"```" 变代码块、"- " 变列表、"**x**" 变粗体 */
  maybeConvertShortcut() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const textNode = range.startContainer;
    if (textNode.nodeType !== 3) return;
    const block = textNode.parentElement && textNode.parentElement.closest('.w-block');
    if (!block) return;
    const line = textNode.nodeValue;

    const rules = [
      { re: /^(#{1,6})\s$/, apply: (m) => ({ tag: 'h' + m[1].length }) },
      { re: /^[-*+]\s$/, apply: () => ({ tag: 'li' }) },
      { re: /^>\s$/, apply: () => ({ tag: 'bq' }) },
      { re: /^```$/, apply: () => ({ tag: 'code' }) },
      { re: /^(\d+)\.\s$/, apply: () => ({ tag: 'li' }) },
    ];
    for (const r of rules) {
      const m = line.match(r.re);
      if (m && block.dataset.type === 'p') {
        const { tag } = r.apply(m);
        this.replaceBlock(block, tag, '');
        this.handleInput();
        return;
      }
    }
  }

  replaceBlock(block, type, text) {
    const nb = createBlock(type, text);
    block.replaceWith(nb);
    focusBlockEnd(nb);
  }

  handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) {
      document.execCommand('insertText', false, lines[0]);
      return;
    }
    // 多行粘贴：首行插入当前，其余行作为新块
    document.execCommand('insertText', false, lines[0]);
    const cur = sel.anchorNode.parentElement.closest('.w-block');
    if (!cur) return;
    let anchor = cur;
    for (const l of lines.slice(1)) {
      const nb = createBlock('p', l);
      anchor.after(nb);
      anchor = nb;
    }
    focusBlockEnd(anchor);
    this.handleInput();
  }

  handleKey(e) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode;
    const el = node.nodeType === 1 ? node : node.parentElement;
    const block = el && el.closest('.w-block');

    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
      return;
    }

    // 代码块内回车保留原生换行
    if (block && block.dataset.type === 'code') return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!block) return;
      const type = block.dataset.type || 'p';
      const textEl = block.querySelector('.w-text') || block;
      const fullText = textEl.textContent;

      // 空列表项 / 空引用：退出该结构
      if ((type === 'li' || type === 'bq') && fullText.trim() === '') {
        const nb = createBlock('p', '');
        block.replaceWith(nb);
        focusBlockStart(nb);
        this.handleInput();
        return;
      }

      // 在光标处拆分：取光标前的文本留在当前块，光标后的文本进入新块
      const range = sel.getRangeAt(0);
      const pre = document.createRange();
      pre.setStart(textEl, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const beforeText = pre.toString();
      const afterText = fullText.slice(beforeText.length);

      textEl.textContent = beforeText;
      if (!beforeText) textEl.innerHTML = '<br>';

      let nextType = 'p';
      if (type === 'li') nextType = 'li';
      const nb = createBlock(nextType, afterText);
      if (nextType === 'li' && block.classList.contains('w-ol')) {
        nb.classList.add('w-ol');
        const n = parseInt((block.querySelector('.w-li-marker') || {}).textContent || '1', 10) + 1;
        nb.querySelector('.w-li-marker').textContent = isNaN(n) ? '1.' : n + '.';
      }
      block.after(nb);
      focusBlockStart(nb);
      this.handleInput();
      return;
    }

    // Shift+Enter：块内软换行
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      this.handleInput();
      return;
    }

    if (e.key === 'Backspace') {
      const r = sel.getRangeAt(0);
      if (r.collapsed && r.startOffset === 0 && block) {
        const prev = block.previousElementSibling;
        if (prev) {
          e.preventDefault();
          // 退格合并：把当前内容并入上一块（仅同类型）
          const pt = prev.querySelector('.w-text') || prev;
          const cur = block.querySelector('.w-text') || block;
          const len = pt.textContent.length;
          pt.textContent = pt.textContent + cur.textContent;
          block.remove();
          const range2 = document.createRange();
          const tn = pt.firstChild || pt;
          range2.setStart(tn, Math.min(len, tn.length || 0));
          range2.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range2);
          this.handleInput();
        }
      }
      return;
    }

    // 行内快捷键：Ctrl/Cmd+B 加粗、I 斜体
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i') {
        e.preventDefault();
        this.wrapInline(k === 'b' ? '**' : '_');
      }
    }
  }

  wrapInline(marker) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      document.execCommand('insertText', false, marker + marker);
      const r2 = sel.getRangeAt(0);
      r2.setStart(r2.startContainer, r2.startOffset - marker.length);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
      return;
    }
    const t = range.toString();
    document.execCommand('insertText', false, marker + t + marker);
  }
}

function focusBlockEnd(block) {
  const t = block.querySelector('.w-text') || block;
  const r = document.createRange();
  r.selectNodeContents(t);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function focusBlockStart(block) {
  const t = block.querySelector('.w-text') || block;
  const r = document.createRange();
  r.setStart(t, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function trimTrailingBr(block) {
  const t = block.querySelector('.w-text') || block;
  while (t.lastChild && t.lastChild.nodeName === 'BR') t.removeChild(t.lastChild);
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内 Markdown -> HTML（编辑视图里即时渲染样式） */
export function inlineHtml(s) {
  const codes = [];
  let t = String(s).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0001${codes.length - 1}\u0001`;
  });
  t = escapeHtml(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img class="w-img" src="${src}" alt="${alt}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => `<a href="${href}">${txt}</a>`);
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|\W)__([^_]+)__(?!_)/g, '$1<strong>$2</strong>');
  t = t.replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return t;
}

function createBlock(type, text) {
  let el;
  if (type === 'h1') el = document.createElement('h1');
  else if (type === 'h2') el = document.createElement('h2');
  else if (type === 'h3') el = document.createElement('h3');
  else if (type === 'h4') el = document.createElement('h4');
  else if (type === 'h5') el = document.createElement('h5');
  else if (type === 'h6') el = document.createElement('h6');
  else if (type === 'li') el = document.createElement('div');
  else if (type === 'bq') el = document.createElement('blockquote');
  else if (type === 'code') el = document.createElement('div');
  else el = document.createElement('div');

  el.className = 'w-block';
  el.dataset.type = type;

  if (type === 'li') el.dataset.ordered = el.dataset.ordered || '';
  const inner = document.createElement('span');
  inner.className = 'w-text';
  if (type === 'code') {
    inner.className = 'w-text w-code';
    inner.innerHTML = escapeHtml(text) + '\n';
  } else {
    inner.innerHTML = inlineHtml(text) + (text ? '' : '<br>');
  }
  el.appendChild(inner);
  return el;
}

/** Markdown -> 编辑视图 DOM */
export function mdToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let olCounter = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w#+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      html.push(
        `<div class="w-block w-codeblock" data-type="code" data-lang="${escapeHtml(lang)}">` +
        `<div class="w-codebar"><span>${escapeHtml(lang || 'code')}</span></div>` +
        `<span class="w-text w-code" contenteditable="true">${escapeHtml(body.join('\n'))}</span></div>`
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      html.push(`<div class="w-block w-h" data-type="h${h[1].length}"><span class="w-text">${inlineHtml(h[2]) || '<br>'}</span></div>`);
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      html.push(`<div class="w-block w-bq" data-type="bq"><span class="w-text">${inlineHtml(line.replace(/^\s*>\s?/, '')) || '<br>'}</span></div>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      html.push('<div class="w-block w-hr" data-type="hr" contenteditable="false"><hr></div>');
      i++;
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      olCounter = 0;
      html.push(`<div class="w-block w-li" data-type="li"><span class="w-li-marker">•</span><span class="w-text">${inlineHtml(ul[1]) || '<br>'}</span></div>`);
      i++;
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      olCounter++;
      html.push(`<div class="w-block w-li w-ol" data-type="li"><span class="w-li-marker">${ol[1]}.</span><span class="w-text">${inlineHtml(ol[2]) || '<br>'}</span></div>`);
      i++;
      continue;
    }
    html.push(`<div class="w-block w-p" data-type="p"><span class="w-text">${inlineHtml(line) || '<br>'}</span></div>`);
    i++;
  }
  return html.join('');
}

/** 编辑视图 DOM -> Markdown */
export function blocksToMarkdown(root) {
  const out = [];
  [...root.children].forEach((el) => {
    const type = el.dataset.type;
    if (type === 'hr') { out.push('---'); return; }
    const textEl = el.querySelector('.w-text') || el;
    const text = type === 'code' ? textEl.textContent.replace(/\n$/, '') : textEl.textContent;
    if (type && type.startsWith('h')) out.push('#'.repeat(+type[1]) + ' ' + text);
    else if (type === 'li') {
      const marker = el.querySelector('.w-li-marker');
      const ordered = el.classList.contains('w-ol');
      out.push((ordered ? marker.textContent.replace('.', '') + '. ' : '- ') + text);
    } else if (type === 'bq') out.push('> ' + text);
    else if (type === 'code') {
      out.push('```' + (el.dataset.lang || ''));
      out.push(text);
      out.push('```');
    } else out.push(text);
  });
  return out.join('\n');
}
