// ============================================================
// pdf.js —— 导出 PDF / 打印
// 用系统 WebView 的打印引擎（不额外打包 PDF 渲染库，体积不涨）
// ============================================================
import { renderPreview } from './preview.js';
import { detectKind } from './format.js';
import { dialog, toast } from './ui.js';
import { activeTab } from './state.js';
import { tt } from './i18n.js';

export async function exportPdf() {
  const t = activeTab();
  if (!t) return;
  toast(tt('正在调起打印，请在对话框中选择「另存为 PDF」'), 2600);
  await printTab(t);
}

export async function printTab(t) {
  const html = buildPrintHtml(t);
  const win = window.open('', '_blank', 'width=900,height=1000');
  if (!win) {
    dialog({
      title: tt('无法打开打印窗口'),
      body: tt('请在浏览器/系统设置中允许弹出窗口后重试。'),
    });
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    setTimeout(() => {
      win.focus();
      win.print();
    }, 250);
  };
  // 兜底：若 onload 未触发
  setTimeout(() => { try { win.focus(); win.print(); } catch {} }, 800);
}

function buildPrintHtml(t) {
  const kind = detectKind(t.name);
  const css = [...document.styleSheets].map((s) => {
    try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; }
  }).join('\n');
  const box = document.createElement('div');
  const docDir = t.path ? t.path.replace(/[\\/][^\\/]*$/, '') : '';
  renderPreview(kind, t.content, '', box, docDir);
  const body = kind === 'md'
    ? box.innerHTML
    : `<pre class="plainview">${t.content.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t.name}</title><style>
    ${css}
    :root, body { background:#fff !important; color:#1f2430 !important; }
    body[data-theme] { }
    @page { size: A4; margin: 18mm 16mm; }
    body { margin:0; padding:8mm 4mm; font-family: var(--font-read); }
    .print-head { font-size:11px;color:#9aa3b2;margin-bottom:14px;font-family:sans-serif }
    .md { max-width: 100%; }
    .md pre { white-space: pre-wrap; word-break: break-word; background:#f6f8fa !important; }
    .md h1, .md h2 { page-break-after: avoid; }
    .md tr { page-break-inside: avoid; }
    .plainview { white-space: pre-wrap; word-break: break-word; }
    .json-err { display:none; }
    .preview-body { padding:0 !important; }
  </style></head><body data-theme="light"><div class="print-head">${t.name}</div>${body}
  <script>window.addEventListener('afterprint',()=>{setTimeout(()=>window.close(),300)})<\/script>
  </body></html>`;
}
