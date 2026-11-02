// ============================================================
// diffpanel.js —— 浮层里的「文件夹对比」
// 文本对比已经搬到独立窗口（compare.html + compare.js）：两栏并排加预览条，
// 浮层那点宽度放不下。这里只保留文件夹对比，点开某一对差异文件时
// 直接把两个路径交给对比窗口。
// ============================================================
import * as be from './backend.js';
import { toast } from './ui.js';
import { tt } from './i18n.js';
import { errText } from './errors.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const $ = (id) => document.getElementById(id);

export class DiffPanel {
  constructor() {
    this.bind();
  }

  bind() {
    document.querySelectorAll('.close-sheet').forEach((b) => (b.onclick = () => this.close()));
    $('overlay').addEventListener('mousedown', (e) => {
      if (e.target.id === 'overlay') this.lastDownOverlay = true;
      else this.lastDownOverlay = false;
    });
    $('overlay').addEventListener('click', (e) => {
      if (e.target.id === 'overlay' && this.lastDownOverlay) this.close();
    });

    $('pickFolderLeft').onclick = async () => {
      const p = await be.pickFolder(tt('选择左侧文件夹'));
      if (p) { $('nameFolderLeft').textContent = p; $('nameFolderLeft').title = p; await this.runFolder(); }
    };
    $('pickFolderRight').onclick = async () => {
      const p = await be.pickFolder(tt('选择右侧文件夹'));
      if (p) { $('nameFolderRight').textContent = p; $('nameFolderRight').title = p; await this.runFolder(); }
    };
    $('folderOnlyDiff').onchange = () => this.runFolder();
  }

  showPage(id) {
    document.querySelectorAll('.sheet-page').forEach((p) => p.classList.add('hidden'));
    $(id).classList.remove('hidden');
    $('overlay').classList.remove('hidden');
  }

  /** 文本对比：打开独立窗口。不带当前文件 —— 要比较的对象让用户自己挑 */
  async openText() {
    this.close();
    try {
      await be.openCompareWindow(null, null);
    } catch (e) {
      toast(tt('打不开对比窗口：') + e);
    }
  }

  openFolder() {
    this.showPage('pageFolder');
    // 先跑一次：没选文件夹时它会落下「选两个文件夹开始对比」的提示，
    // 否则打开就是一片空白（用户不知道这页是干什么的）
    this.runFolder();
  }

  close() {
    $('overlay').classList.add('hidden');
  }

  /* ---------------- 文件夹对比 ---------------- */
  async runFolder() {
    const L = $('nameFolderLeft').textContent;
    const R = $('nameFolderRight').textContent;
    const body = $('folderBody');
    if (L === tt('未选择') || R === tt('未选择')) {
      body.innerHTML = '<div class="diff-empty">' + tt('选择左右两个文件夹开始对比') + '</div>';
      return;
    }
    body.innerHTML = '<div class="diff-empty">' + tt('正在扫描…') + '</div>';
    try {
      const [a, b] = await Promise.all([be.listDir(L), be.listDir(R)]);
      const mapA = new Map(a.map((x) => [rel(L, x.path), x]));
      const mapB = new Map(b.map((x) => [rel(R, x.path), x]));
      const keys = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();
      const items = keys.map((k) => {
        const x = mapA.get(k), y = mapB.get(k);
        let kind;
        if (x && !y) kind = 'left';
        else if (!x && y) kind = 'right';
        else if (x.size !== y.size || Math.abs(x.mtime - y.mtime) > 1500) kind = 'mod';
        else kind = 'same';
        return { k, kind, x, y };
      });
      const only = $('folderOnlyDiff').checked;
      const show = only ? items.filter((i) => i.kind !== 'same') : items;
      const cnt = { left: 0, right: 0, mod: 0, same: 0 };
      items.forEach((i) => cnt[i.kind]++);
      $('folderStat').textContent = tt('共 {n} 个文件 · 仅左 {l} · 仅右 {r} · 已修改 {m} · 相同 {s}', { n: items.length, l: cnt.left, r: cnt.right, m: cnt.mod, s: cnt.same });
      if (!show.length) {
        body.innerHTML = '<div class="diff-empty">' + tt('没有差异（或该目录为空）') + '</div>';
        return;
      }
      body.innerHTML = `<table class="f-table"><thead><tr><th>${tt('状态')}</th><th>${tt('相对路径')}</th><th>${tt('大小')}</th><th>${tt('修改时间')}</th></tr></thead><tbody>${
        show.map((i) => {
          const label = { left: tt('仅左'), right: tt('仅右'), mod: tt('已修改'), same: tt('相同') }[i.kind];
          const f = i.x || i.y;
          return `<tr class="${i.kind === 'same' ? '' : 'f-row-click'}" data-l="${i.x ? i.x.path : ''}" data-r="${i.y ? i.y.path : ''}">
            <td><span class="f-badge ${i.kind}">${label}</span></td>
            <td class="f-path">${esc(i.k)}</td>
            <td style="color:var(--fg-faint)">${(i.x ? i.x.size : i.y.size).toLocaleString()} B</td>
            <td style="color:var(--fg-faint)">${new Date(f.mtime).toLocaleString()}</td>
          </tr>`;
        }).join('')}</tbody></table>`;
      body.querySelectorAll('.f-row-click').forEach((tr) => {
        tr.onclick = () => {
          const l = tr.dataset.l, r = tr.dataset.r;
          if (l && r) {
            // 两侧都在：丢给对比窗口并排看，浮层里塞不下两栏
            this.close();
            be.openCompareWindow(l, r).catch((e) => toast(tt('打不开对比窗口：') + e));
          } else {
            window.__snp.openPath(l || r);
          }
        };
      });
    } catch (e) {
      body.innerHTML = '<div class="diff-empty">' + tt('扫描失败：{msg}', { msg: esc(errText(e)) }) + '</div>';
    }
  }
}

function rel(root, p) {
  const r = root.replace(/[\\/]+$/, '');
  return p.startsWith(r) ? p.slice(r.length).replace(/^[\\/]/, '') : p;
}
