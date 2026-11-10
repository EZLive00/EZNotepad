// ============================================================
// mergewizard.js —— 三向合并（半自动版）
// 只做：基准 + A + B → 自动合并 → 冲突清单 → 另存为新文件
// 不做四栏可视化合并器（复杂交互交给已有的两栏对比）
// ============================================================
import * as be from './backend.js';
import { merge3 } from './diff.js';
import { toast } from './ui.js';
import { tt } from './i18n.js';
import { errText } from './errors.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class MergeWizard {
  constructor(opts = {}) {
    this.opts = opts;
    this.files = { base: null, a: null, b: null };
    this.lastResult = null;
    this.bind();
  }

  bind() {
    $('mergeClose').onclick = () => this.close();
    $('mergeCancel').onclick = () => this.close();
    $('mergeOverlay').addEventListener('mousedown', (e) => {
      if (e.target.id === 'mergeOverlay') this.close();
    });
    document.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.onclick = async () => {
        const side = btn.dataset.pick;
        const p = await be.pickFile(side === 'base' ? tt('选择基准版本') : side === 'a' ? tt('选择 A 侧文件') : tt('选择 B 侧文件'));
        if (!p) return;
        try {
          const r = await be.readText(p);
          this.files[side] = r;
          /* 只写路径：文件名本来就是路径的末尾，拼两遍等于同一件事说两次 */
          const nameEl = $(`mergeName${side === 'base' ? 'Base' : side === 'a' ? 'A' : 'B'}`);
          nameEl.textContent = r.path;
          nameEl.title = r.path;
          $('mergeResult').textContent = '';
        } catch (e) { toast(errText(e)); }
      };
    });
    $('mergeRun').onclick = () => this.run();
  }

  open() {
    this.files = { base: null, a: null, b: null };
    ['Base', 'A', 'B'].forEach((s) => (($(`mergeName${s}`).textContent = tt('未选择'))));
    $('mergeResult').innerHTML = '';
    $('mergeOverlay').classList.remove('hidden');
  }

  close() {
    $('mergeOverlay').classList.add('hidden');
  }

  run() {
    const { base, a, b } = this.files;
    const miss = ['base', 'a', 'b'].filter((k) => !this.files[k]);
    if (miss.length) { toast(tt('请先选择基准、A 侧、B 侧三个文件')); return; }
    const r = merge3(base.content, a.content, b.content);
    this.lastResult = r;
    const total = r.conflicts.length;
    const lines = r.text.split('\n').length;
    let html = '';
    if (total === 0) {
      html += '<span class="ok">' + tt('合并完成，无冲突。') + '</span>\n';
    } else {
      html += '<span class="warn">' + tt('合并完成，有 {n} 处冲突', { n: total }) + '</span>'
        + tt('（已保留 A 侧内容，请人工确认）') + '\n';
      html += r.conflicts.slice(0, 12).map((c, i) =>
        tt('{i}. 基准第 {from}–{to} 行：\n   A：{a}\n   B：{b}', { i: i + 1, from: c.aStart + 1, to: c.aEnd, a: esc(trunc(c.aText)), b: esc(trunc(c.bText)) })
      ).join('\n');
      if (total > 12) html += '\n' + tt('… 其余 {n} 处从略', { n: total - 12 });
    }
    html += '\n\n' + tt('A 侧改动 {a} 块，B 侧改动 {b} 块，结果 {lines} 行。', { a: r.aHunks, b: r.bHunks, lines });
    $('mergeResult').innerHTML = html;

    // 自动打开合并结果到新标签（不覆盖任何文件）
    const name = (a.name || 'merged').replace(/(\.[^.]+)?$/, '') + '.merged.md';
    window.__snp.newTab(name, r.text);
    toast(total ? tt('合并完成，{n} 处冲突待确认', { n: total }) : tt('合并完成，无冲突'));
    this.close();
  }
}

const trunc = (s) => {
  const one = s.replace(/\n/g, ' ⏎ ');
  return one.length > 90 ? one.slice(0, 90) + '…' : one;
};
