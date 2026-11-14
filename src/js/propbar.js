// ============================================================
// propbar.js —— 属性区的两种长相
//
//   propsHtml(..., {doc:false})  编辑区顶部的一条（紧凑、可横向滚）
//   propsHtml(..., {doc:true})   预览正文顶部的一块（随正文滚动、可换行）
//
// 两者共用同一套标记与样式，只是一个贴边、一个进流。属性是元数据，
// 不进块模型 —— 所见即所得的正文里塞一个 contenteditable=false 的块，
// 光标、删除合并、虚拟渲染的块下标全要跟着改，代价远大于收益。
// ============================================================

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

function tagChip(t) {
  const raw = String(t);
  return `<button type="button" class="tag" data-tag="${esc(raw)}" title="${esc('#' + raw)}">#${esc(raw)}</button>`;
}

function valueHtml(e) {
  if (e.kind === 'checkbox') {
    const on = /^true$/i.test(e.value);
    return `<span class="pv pv-bool${on ? ' on' : ''}">${esc(on ? '✓' : '✗')}</span>`;
  }
  if (e.kind === 'list') {
    const items = e.items || [];
    if (!items.length) return '<span class="pv pv-empty">—</span>';
    const isTags = /^tags?$/i.test(e.key);
    if (isTags) return `<span class="pv pv-tags">${items.map(tagChip).join('')}</span>`;
    return `<span class="pv">${items.map(esc).join('<i class="pv-sep">·</i>')}</span>`;
  }
  if (!e.value) return '<span class="pv pv-empty">—</span>';
  return `<span class="pv" title="${esc(e.value)}">${esc(e.value)}</span>`;
}

/**
 * @param {Array} entries parseFrontmatter() 的 entries
 * @param {{doc?:boolean, label?:string}} opt doc=true 渲染成正文里的卡片
 */
export function propsHtml(entries, opt = {}) {
  if (!entries || !entries.length) return '';
  const items = entries
    .map((e) => `<span class="props-item"><span class="pk">${esc(e.key)}</span>${valueHtml(e)}</span>`)
    .join('');
  return `<div class="props${opt.doc ? ' props-doc' : ''}">`
    + `<span class="props-key">${esc(opt.label || '属性')}</span>${items}</div>`;
}
