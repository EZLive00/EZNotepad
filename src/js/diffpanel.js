// ============================================================
// diffpanel.js —— 对比中心独立面板：文本对比 / 文件夹对比
// 与编辑器完全分离，关闭后回到编辑器
// ============================================================
import * as be from './backend.js';
import { buildSideBySide, diffStats, inlineDiff } from './diff.js';
import { toast } from './ui.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const $ = (id) => document.getElementById(id);

export class DiffPanel {
  constructor(opts = {}) {
    this.opts = opts;
    this.left = null;   // { path, name, content }
    this.right = null;
    this.rows = [];
    this.blocks = [];
    this.cursor = -1;
    this.ignore = { ignoreWS: true, ignoreCase: false };
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
    $('hubText').onclick = () => this.openText();
    $('hubFolder').onclick = () => this.openFolder();

    $('pickLeft').onclick = async () => {
      const p = await be.pickFile('选择左侧文件');
      if (p) await this.load('left', p);
    };
    $('pickRight').onclick = async () => {
      const p = await be.pickFile('选择右侧文件');
      if (p) await this.load('right', p);
    };
    $('swapDiff').onclick = () => {
      [this.left, this.right] = [this.right, this.left];
      this.render();
    };
    $('diffIgnoreWS').onchange = (e) => { this.ignore.ignoreWS = e.target.checked; this.render(); };
    $('diffIgnoreCase').onchange = (e) => { this.ignore.ignoreCase = e.target.checked; this.render(); };
    $('diffNext').onclick = () => this.step(1);
    $('diffPrev').onclick = () => this.step(-1);
    $('diffSaveReport').onclick = () => this.saveReport();
    $('diffBody').addEventListener('scroll', (e) => this.syncScroll(e));
    $('diffBody').addEventListener('click', (e) => {
      const b = e.target.closest('.d-sync');
      if (b) this.syncBlock(b.dataset.side, +b.dataset.idx);
    });

    $('pickFolderLeft').onclick = async () => {
      const p = await be.pickFolder('选择左侧文件夹');
      if (p) { $('nameFolderLeft').textContent = p; $('nameFolderLeft').title = p; await this.runFolder(); }
    };
    $('pickFolderRight').onclick = async () => {
      const p = await be.pickFolder('选择右侧文件夹');
      if (p) { $('nameFolderRight').textContent = p; $('nameFolderRight').title = p; await this.runFolder(); }
    };
    $('folderOnlyDiff').onchange = () => this.runFolder();
  }

  showPage(id) {
    document.querySelectorAll('.sheet-page').forEach((p) => p.classList.add('hidden'));
    $(id).classList.remove('hidden');
    $('pageHub').classList.add('hidden');
    $('overlay').classList.remove('hidden');
  }

  openHub() {
    document.querySelectorAll('.sheet-page').forEach((p) => p.classList.add('hidden'));
    $('pageHub').classList.remove('hidden');
    $('overlay').classList.remove('hidden');
  }

  async openText() {
    this.showPage('pageDiff');
    // 若当前编辑器有文件，自动带进来作为左侧
    const tab = window.__snp && window.__snp.getActiveTab();
    if (tab && !this.left) {
      this.left = { path: tab.path, name: tab.name, content: tab.content };
      $('nameLeft').textContent = tab.name + (this.left.content ? '' : '（空）');
    }
    this.render();
  }

  openFolder() {
    this.showPage('pageFolder');
  }

  close() {
    $('overlay').classList.add('hidden');
  }

  async load(side, path) {
    try {
      const r = await be.readText(path);
      this[side] = { path: r.path, name: r.name, content: r.content };
      $(side === 'left' ? 'nameLeft' : 'nameRight').textContent = r.name;
      $(side === 'left' ? 'nameLeft' : 'nameRight').title = r.path;
      this.render();
    } catch (e) {
      toast(String(e));
    }
  }

  render() {
    const body = $('diffBody');
    const a = this.left ? this.left.content : '';
    const b = this.right ? this.right.content : '';
    if (!this.left && !this.right) {
      body.innerHTML = '<div class="diff-empty">选择左右两个文件开始对比</div>';
      $('diffStat').textContent = '';
      return;
    }
    const aLines = a.replace(/\r\n?/g, '\n').split('\n');
    const bLines = b.replace(/\r\n?/g, '\n').split('\n');
    const { rows, blocks } = buildSideBySide(aLines, bLines, this.ignore);
    this.rows = rows;
    this.blocks = blocks;
    this.cursor = blocks.length ? 0 : -1;
    const st = diffStats(rows);
    $('diffStat').textContent = st.add + st.del + st.chg === 0
      ? '两侧内容完全一致'
      : `修改 ${st.chg} · 仅左 ${st.del} · 仅右 ${st.add}`;

    const leftHtml = [];
    const rightHtml = [];
    let inBlock = false;
    rows.forEach((r, idx) => {
      const isBlockRow = r.kind !== 'same';
      const isBlockStart = isBlockRow && (!rows[idx - 1] || rows[idx - 1].kind === 'same');
      const isBlockEnd = isBlockRow && (!rows[idx + 1] || rows[idx + 1].kind === 'same');
      let lInner = '', rInner = '';
      if (r.l && r.r && r.kind === 'chg') {
        const d = inlineDiff(r.l.text, r.r.text);
        lInner = d.l; rInner = d.r;
      } else {
        lInner = r.l ? esc(r.l.text) || '&nbsp;' : '';
        rInner = r.r ? esc(r.r.text) || '&nbsp;' : '';
      }
      const lCls = !r.l ? 'empty' : r.kind === 'del' ? 'del' : r.kind === 'chg' ? 'chg-l' : '';
      const rCls = !r.r ? 'empty' : r.kind === 'add' ? 'add' : r.kind === 'chg' ? 'chg-r' : '';
      const syncBtn = isBlockRow
        ? `<button class="d-sync" data-side="${isBlockEnd ? 'end' : 'mid'}" data-idx="${idx}">→</button>`
        : '';
      leftHtml.push(`<div class="d-row ${lCls}" data-block="${isBlockRow && isBlockStart ? idx : ''}">
        <span class="d-ln">${r.l ? r.l.no : ''}</span><span class="d-tx">${lInner}${isBlockEnd ? syncBtn : ''}</span></div>`);
      rightHtml.push(`<div class="d-row ${rCls}">
        <span class="d-ln">${r.r ? r.r.no : ''}</span><span class="d-tx">${rInner}</span></div>`);
    });
    body.innerHTML = `<div class="diff-grid"><div class="diff-col">${leftHtml.join('')}</div><div class="diff-col">${rightHtml.join('')}</div></div>`;
    if (this.blocks.length) this.highlightBlock(0, false);
  }

  syncScroll(e) {
    // 左右共用一个滚动容器，天然同步
  }

  highlightBlock(i, scroll = true) {
    const idx = this.blocks[i];
    this.cursor = i;
    const body = $('diffBody');
    body.querySelectorAll('.cur').forEach((n) => n.classList.remove('cur'));
    if (idx == null) return;
    const colL = body.querySelector('.diff-col:nth-child(1)');
    const colR = body.querySelector('.diff-col:nth-child(2)');
    const rowL = colL && colL.children[idx];
    const rowR = colR && colR.children[idx];
    if (rowL) rowL.classList.add('cur');
    if (rowR) rowR.classList.add('cur');
    if (scroll && rowL) {
      const top = rowL.offsetTop - body.clientHeight / 2 + rowL.offsetHeight;
      body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    $('diffStat').setAttribute('data-cur', i);
  }

  step(dir) {
    if (!this.blocks.length) { toast('没有差异'); return; }
    this.cursor = (this.cursor + dir + this.blocks.length) % this.blocks.length;
    this.highlightBlock(this.cursor, true);
  }

  /** 把一个差异块从左侧同步到右侧（或反向），直接写回右侧文件 */
  async syncBlock(_side, idx) {
    const row = this.rows[idx];
    if (!row || row.kind === 'same') return;
    // 找到该差异块的行范围
    let s = idx, e = idx;
    while (s > 0 && this.rows[s - 1].kind !== 'same') s--;
    while (e < this.rows.length - 1 && this.rows[e + 1].kind !== 'same') e++;
    const blockRows = this.rows.slice(s, e + 1);
    const srcText = blockRows.map((r) => (r.l ? r.l.text : null)).filter((x) => x !== null);
    const dstStart = blockRows.find((r) => r.r)?.r.no;
    if (!this.right) { toast('右侧没有文件'); return; }
    const bLines = this.right.content.replace(/\r\n?/g, '\n').split('\n');
    // 删除右侧块内的行（仅右有 / 双方都有）
    const rightNos = blockRows.filter((r) => r.r).map((r) => r.r.no);
    const insertAt = rightNos.length ? rightNos[0] - 1 : (blockRows[0].r ? blockRows[0].r.no - 1 : bLines.length);
    const delCount = rightNos.length;
    bLines.splice(insertAt, delCount, ...srcText);
    const next = bLines.join('\n');
    const ok = await this.writeBack(this.right.path, next);
    if (!ok) return;
    this.right.content = next;
    this.render();
    toast('已合并该差异块到右侧文件');
  }

  async writeBack(path, content) {
    return new Promise((resolve) => {
      import('./ui.js').then(({ confirmBox }) => {
        confirmBox('写回文件', `将把对比结果写入：<br><b>${esc(path)}</b><br><br>此操作会覆盖该文件内容，是否继续？`, '写入', '取消')
          .then(async (yes) => {
            if (!yes) return resolve(false);
            try {
              await be.saveText({ path, content, encoding: 'UTF-8', bom: false });
              toast('已写入文件');
              resolve(true);
            } catch (e) { toast('写入失败：' + e); resolve(false); }
          });
      });
    });
  }

  async saveReport() {
    const p = await be.pickSavePath('对比报告.html');
    if (!p) return;
    const rows = this.rows;
    const st = diffStats(rows);
    const html = `<!doctype html><meta charset="utf-8"><title>文本对比报告</title>
<style>
body{font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;margin:0;padding:28px;color:#1f2430;background:#fff}
h1{font-size:20px;margin:0 0 6px}
.meta{color:#6b7280;font-size:12.5px;margin-bottom:18px}
.bar{display:flex;gap:18px;font-size:12.5px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #e2e6ec;border-radius:0;overflow:hidden;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
.col{min-width:0}.col+.col{border-left:1px solid #e2e6ec}
.row{display:flex;line-height:1.6}
.ln{width:48px;flex:none;text-align:right;padding-right:10px;color:#9aa3b2;font-size:11px}
.tx{flex:1;white-space:pre-wrap;word-break:break-all;padding:0 8px}
.del{background:#fdeaea}.add{background:#e6f7ec}.chg-l{background:#fdeaea}.chg-r{background:#e6f7ec}
mark.ins{background:#b8ecc9}mark.rem{background:#f8c0c0}
.head{background:#f4f6f9;font-weight:600;padding:8px 12px;font-family:sans-serif;font-size:12px}
</style>
<h1>文本对比报告</h1>
<div class="meta">${esc(this.left?.name || '空')} ⇄ ${esc(this.right?.name || '空')} · ${new Date().toLocaleString()}</div>
<div class="bar"><span>修改 ${st.chg}</span><span>仅左 ${st.del}</span><span>仅右 ${st.add}</span><span>相同 ${st.same}</span></div>
<div class="grid"><div class="col"><div class="head">${esc(this.left?.name || '左')}</div>${rows.map((r) => `<div class="row ${!r.l ? '' : r.kind === 'del' ? 'del' : r.kind === 'chg' ? 'chg-l' : ''}"><span class="ln">${r.l ? r.l.no : ''}</span><span class="tx">${r.l && r.r && r.kind === 'chg' ? inlineDiff(r.l.text, r.r.text).l : esc(r.l ? r.l.text : '')}</span></div>`).join('')}</div>
<div class="col"><div class="head">${esc(this.right?.name || '右')}</div>${rows.map((r) => `<div class="row ${!r.r ? '' : r.kind === 'add' ? 'add' : r.kind === 'chg' ? 'chg-r' : ''}"><span class="ln">${r.r ? r.r.no : ''}</span><span class="tx">${r.l && r.r && r.kind === 'chg' ? inlineDiff(r.l.text, r.r.text).r : esc(r.r ? r.r.text : '')}</span></div>`).join('')}</div></div>`;
    const bytes = new TextEncoder().encode(html);
    await be.writeBinary(p, bytes);
    toast('报告已导出：' + be.baseName(p));
  }

  /* ---------------- 文件夹对比 ---------------- */
  async runFolder() {
    const L = $('nameFolderLeft').textContent;
    const R = $('nameFolderRight').textContent;
    const body = $('folderBody');
    if (L === '未选择' || R === '未选择') {
      body.innerHTML = '<div class="diff-empty">选择左右两个文件夹开始对比</div>';
      return;
    }
    body.innerHTML = '<div class="diff-empty">正在扫描…</div>';
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
      $('folderStat').textContent = `共 ${items.length} 个文件 · 仅左 ${cnt.left} · 仅右 ${cnt.right} · 已修改 ${cnt.mod} · 相同 ${cnt.same}`;
      if (!show.length) {
        body.innerHTML = '<div class="diff-empty">没有差异（或该目录为空）</div>';
        return;
      }
      body.innerHTML = `<table class="f-table"><thead><tr><th>状态</th><th>相对路径</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${
        show.map((i) => {
          const label = { left: '仅左', right: '仅右', mod: '已修改', same: '相同' }[i.kind];
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
            this.load('left', l).then(() => this.load('right', r)).then(() => {
              $('pageDiff').classList.remove('hidden');
              $('pageFolder').classList.add('hidden');
            });
          } else {
            window.__snp.openPath(l || r);
          }
        };
      });
    } catch (e) {
      body.innerHTML = `<div class="diff-empty">扫描失败：${esc(String(e))}</div>`;
    }
  }
}

function rel(root, p) {
  const r = root.replace(/[\\/]+$/, '');
  return p.startsWith(r) ? p.slice(r.length).replace(/^[\\/]/, '') : p;
}
