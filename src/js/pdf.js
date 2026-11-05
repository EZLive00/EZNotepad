// ============================================================
// pdf.js —— 导出 PDF（只导出，不打印）
//
// 为什么不走「打印」：WebView2 **没有实现**浏览器的打印面板。以前那版是
// window.open('') + win.print()，真机上点了既不弹框也不报错 —— 用户看到的就是
// 「唤不醒打印窗口」。嵌入式 WebView 里根本不存这条路径。
//
// 现在的做法：把要导出的内容渲染进 #printRoot，由打印样式把其余 UI 全部藏掉，
// 再让 Rust 侧用 WebView2 自己的 PrintToPdf 把「按打印样式排好的页面」写成 PDF。
// 不需要打印机、不需要系统对话框、也不会弹第二个窗口。
//
// 三个约束值得记住：
//   · PrintToPdf 用的是**打印媒体**，所以 @media print 里的规则是真的生效的，
//     页面上的东西藏不藏得住全看那段 CSS（styles.css 末尾）。
//   · PDF 一律按浅色排：深色主题下把代码块的浅灰底打成一片黑，既费墨也没法看。
//     所以导出期间临时把主题切成 light（外面盖一层同色遮罩，看不见这一下切换）。
//   · 导出是异步的（Rust 等 WebView2 回调），期间用户可能切标签、改内容。
//     内容在开工前就抓成快照，之后编辑器怎么变都不影响这一份。
// ============================================================
import { renderPreview } from './preview.js';
import { detectKind } from './format.js';
import { dialog, toast } from './ui.js';
import { activeTab } from './state.js';
import { tt } from './i18n.js';
import * as be from './backend.js';
import { errText } from './errors.js';

/** 取当前标签的正文。所见即所得那边是防抖 flush 的，屏幕上可能比 t.content 新 */
function snapshot(t) {
  return t.content == null ? '' : t.content;
}

/** 文件名：`笔记.md` → `笔记.pdf`；没有扩展名的原样加 .pdf */
function pdfName(name) {
  const base = String(name || '').replace(/\.[^.\\/]+$/, '') || 'document';
  return `${base}.pdf`;
}

/**
 * 把一份文档渲染成打印用的 DOM。
 * Markdown 走预览同一套渲染（公式、代码高亮、表格都在里面），
 * 其余类型直接复用预览的代码视图 / 纯文本视图 —— 导出的样子跟屏幕上看到的一致。
 */
async function buildPrintBody(kind, text, docDir) {
  const box = document.createElement('div');
  renderPreview(kind, text, '', box, docDir);
  /* 图要等画完再序列化：PDF 里没有 mermaid 引擎，抓到源码就是一段代码 */
  if (box.__pvDiagrams) await box.__pvDiagrams;
  return kind === 'md' ? `<article class="md">${box.innerHTML}</article>` : box.innerHTML;
}

/** 等版面真正落地：字体就绪 + 两帧，避免抓到还没排好版的中间态 */
function settle() {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const fonts = document.fonts && document.fonts.ready ? document.fonts.ready.catch(() => {}) : Promise.resolve();
  return Promise.all([fonts, frames()]);
}

/** 导出期间盖住整屏：一是让主题切换（深→浅）不被看见，二是给一个「正在进行」的信号 */
function busyOverlay(text) {
  const el = document.createElement('div');
  el.className = 'pdf-busy';
  el.innerHTML = `<div class="pdf-busy-box"><span class="pdf-spin"></span><span>${text}</span></div>`;
  document.body.appendChild(el);
  return () => el.remove();
}

export async function exportPdf() {
  const t = activeTab();
  if (!t) return;

  const path = await be.pickSavePath(pdfName(t.name), [{ name: 'PDF', extensions: ['pdf'] }]);
  if (!path) return;
  await exportPdfTo(path, t);
}

/**
 * 导出到指定路径（不弹保存框）。探针用这个跑完整链路：
 * 弹框是系统原生的，CDP 点不动它。
 */
export async function exportPdfTo(path, tab = activeTab()) {
  const t = tab;
  if (!t || !path) return;

  const kind = detectKind(t.name);
  const docDir = t.path ? t.path.replace(/[\\/][^\\/]*$/, '') : '';
  const text = snapshot(t);

  const root = document.getElementById('printRoot');
  if (!root) {
    dialog({ title: tt('导出 PDF 失败'), body: tt('页面缺少打印容器') });
    return;
  }

  /* 主题：切到浅色再排。保留原来的值，收尾一定还原 */
  const themeBefore = document.body.dataset.theme;
  const done = busyOverlay(tt('正在生成 PDF…'));
  document.body.dataset.theme = 'light';
  try {
    root.innerHTML = await buildPrintBody(kind, text, docDir);
    await settle();
    await be.exportPdf(path);
    toast(tt('已导出 {name}', { name: be.baseName(path) }));
  } catch (e) {
    dialog({ title: tt('导出 PDF 失败'), body: errText(e) });
  } finally {
    root.innerHTML = '';
    if (themeBefore) document.body.dataset.theme = themeBefore;
    done();
  }
}

/** 兼容旧调用点：主窗口里已经没有「打印」这条命令了 */
export const printTab = exportPdf;
