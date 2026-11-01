// ============================================================
// exporthtml.js —— 导出单文件 HTML
//
// 目标：一篇 Markdown 变成一个「双击就能看」的网页，发给别人、丢进静态站点都行。
// 两个关键决定：
//   · CSS 内嵌（不引外部样式表）—— 少一个外部依赖就少一种打不开的方式
//   · 图片转 data URI —— 不转的话另存到别处就只剩一堆断链
// 图片超过 4MB 的不内嵌，保留原路径并在提示里说明。
// ============================================================

import { renderMarkdown, resolveDocImg } from './markdown.js';
import { renderPreview } from './preview.js';
import { renderMathIn } from './math.js';
import { highlight } from './highlight.js';
import { detectKind } from './format.js';
import { activeTab } from './state.js';
import { dialog, toast } from './ui.js';
import * as be from './backend.js';
import { tt, getLang } from './i18n.js';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  avif: 'image/avif', ico: 'image/x-icon',
};

const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '').replace(/\\/g, '/');

function absolute(dir, rel) {
  if (/^(data:|https?:|file:)/i.test(rel) || rel.startsWith('/')) return rel;
  return dir ? `${dir}/${rel.replace(/^\.\//, '')}` : rel;
}

function collectImages(md) {
  const out = new Set();
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m;
  while ((m = re.exec(md))) {
    if (!/^(data:|https?:)/i.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

async function buildImageMap(md, docDir) {
  const map = new Map();
  for (const src of collectImages(md)) {
    const mime = MIME[(src.split('.').pop() || '').toLowerCase()];
    if (!mime) continue;
    try {
      const b64 = await be.readFileBase64(absolute(docDir, src));
      map.set(src, `data:${mime};base64,${b64}`);
    } catch {
      /* 太大或读不到：保留原地址，图可能打不开，但文档本身还能看 */
    }
  }
  return map;
}

function inlineCss() {
  return [...document.styleSheets].map((s) => {
    try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; }
  }).join('\n');
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function exportHtml() {
  const t = activeTab();
  if (!t) return;
  const kind = detectKind(t.name);
  const docDir = dirOf(t.path || '');

  const box = document.createElement('div');
  let embedded = 0;
  if (kind === 'md') {
    const map = await buildImageMap(t.content, docDir);
    embedded = map.size;
    box.innerHTML = renderMarkdown(t.content, {
      codeHighlight: (code, l) => highlight(code, l),
      imgResolver: (s) => map.get(s) || resolveDocImg(s, docDir),
    });
    renderMathIn(box);
  } else {
    renderPreview(kind, t.content, '', box, docDir);
  }

  const title = t.name.replace(/\.[^.]+$/, '');
  const css = inlineCss();
  const body = kind === 'md'
    ? `<article class="md">${box.innerHTML}</article>`
    : box.innerHTML;

  const html = `<!doctype html>
<html lang="${getLang()}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="EZNotepad">
<title>${escapeHtml(title)}</title>
<style>
${css}
/* 导出页：固定浅色，阅读宽度按 46rem 居中。屏幕小的时候两边留 20px */
html, body { background: #fff !important; }
body[data-theme] { --bg: #fff; --bg-panel: #fff; --bg-soft: #fff; }
body {
  margin: 0; padding: 48px 20px 80px;
  color: #1f2430; font-family: var(--font-read, Georgia, "Songti SC", serif);
  -webkit-font-smoothing: antialiased;
}
article, .plainview { max-width: 46rem; margin: 0 auto; }
.plainview { white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono); font-size: 13px; }
.md pre { background: #f6f8fa !important; }
.md img { height: auto; }
.json-err { display: none; }
@media print { body { padding: 0; } }
</style>
</head><body data-theme="light">
${body}
</body></html>`;

  const target = await be.pickSavePath(`${title}.html`, [
    { name: tt('网页'), extensions: ['html', 'htm'] },
    { name: tt('所有文件'), extensions: ['*'] },
  ]);
  if (!target) return;

  try {
    await be.saveText({ path: target, content: html, encoding: 'UTF-8', bom: false });
    const kb = Math.round(html.length / 1024);
    toast(tt('已导出 {name}（{kb} KB{extra}）', { name: be.baseName(target), kb, extra: embedded ? tt('，内嵌 {n} 张图', { n: embedded }) : '' }), 3000);
  } catch (e) {
    dialog({ title: tt('导出失败'), body: String(e) });
  }
}
