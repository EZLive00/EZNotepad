// ============================================================
// filetree.js —— 侧栏「文件」页：文件夹树 + 全目录搜索
//
// 只负责「把数据画出来」和「点了通知谁」，不碰应用状态：
//   · 后端调用通过注入的 be（backend.js）
//   · 打开文件通过注入的 onOpen(path, line)
// 这样它能在预览页里单独跑，也能被截图脚本驱动。
//
// 树是懒加载的：展开某个目录才去读那一层，打开大仓库不会先把几万个文件读进来。
// ============================================================

import { tt } from './i18n.js';
const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
/** 取所在目录，保留原来的分隔符风格（后端给的是 \，别混用手写的 /） */
const parentOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

function icon(id, cls = '') {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${id}" /></svg>`;
}

export class FileTree {
  /**
   * @param {object} opt
   *   body     树/搜索结果的容器
   *   pathText 显示当前文件夹名的元素
   *   be       backend.js 模块（readDirShallow / searchInFolder / createEntry / renameEntry / deleteEntry）
   *   onOpen   (path, line?) => void
   *   toast    (msg) => void
   *   menu     (x, y, items) => void           右键菜单（ui.js 的 contextMenu）
   *   ask      (title, label, value) => Promise<string|null>   文本输入框
   *   confirm  (title, html) => Promise<boolean>               二次确认
   *   onRenamed (oldPath, newPath) => void     让打开着的标签跟着改名
   *   onDeleted (path) => void                 让打开着的标签脱离磁盘
   *   onReveal  (path) => void                 在资源管理器里定位
   */
  constructor(opt) {
    this.body = opt.body;
    this.pathText = opt.pathText;
    this.be = opt.be;
    this.onOpen = opt.onOpen || (() => {});
    this.toast = opt.toast || (() => {});
    this.menu = opt.menu || null;
    this.ask = opt.ask || null;
    this.confirmAsk = opt.confirm || null;
    this.onRenamed = opt.onRenamed || (() => {});
    this.onDeleted = opt.onDeleted || (() => {});
    this.onReveal = opt.onReveal || (() => {});
    this.root = '';
    this.expanded = new Set();
    this.regex = false;        // 搜索是否按正则匹配（由侧栏那个 .* 开关控制）
    this.caseSensitive = false;
    this.token = 0;            // 搜索序号：慢请求回来时直接丢弃
    this.activePath = '';      // 编辑区当前文件，用来在树里点亮
    /* 空白处右键 = 对根目录操作。挂在容器上，树被重画多少次都还在 */
    this.body.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest('.ft-row')) return;     // 行自己处理
      if (ev.target.closest('.ft-hit, .ft-hit-file')) return;
      ev.preventDefault();
      this._rootMenu(ev);
    });
  }

  setRoot(path) {
    this.root = path || '';
    this.expanded.clear();
    if (this.pathText) {
      this.pathText.textContent = this.root ? baseName(this.root) : tt('未打开文件夹');
      this.pathText.title = this.root || '';
    }
    return this.render();
  }

  /** 编辑区换文件时调用：把对应行点亮 */
  setActive(path) {
    this.activePath = path || '';
    this.body.querySelectorAll('.ft-row.active').forEach((r) => r.classList.remove('active'));
    if (!this.activePath) return;
    const row = [...this.body.querySelectorAll('.ft-row')].find((r) => r.dataset.path === this.activePath);
    if (row) row.classList.add('active');
  }

  async render() {
    this.token++;
    this.body.innerHTML = '';
    if (!this.root) {
      this.body.innerHTML = '<div class="ft-empty">' + tt('还没打开文件夹。<br>点上面的「选择…」挑一个目录，<br>之后就能在这里翻文件、搜内容。') + '</div>';
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'ft-tree';
    tree.append(await this._children(this.root, 0));
    this.body.append(tree);
    this.setActive(this.activePath);
  }

  async _children(dir, depth) {
    const frag = document.createDocumentFragment();
    let entries = [];
    try {
      entries = await this.be.readDirShallow(dir);
    } catch (e) {
      const err = document.createElement('div');
      err.className = 'ft-empty small';
      err.textContent = tt('读不到这个目录');
      frag.append(err);
      return frag;
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'ft-empty small';
      empty.style.paddingLeft = `${18 + depth * 12}px`;
      empty.textContent = tt('空目录');
      frag.append(empty);
      return frag;
    }
    for (const e of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ft-row' + (e.is_dir ? ' dir' : '');
      row.dataset.path = e.path;
      row.title = e.path;
      row.style.paddingLeft = `${6 + depth * 12}px`;
      row.innerHTML =
        (e.is_dir ? icon('chevron-right', 'ft-caret') : '<span class="ft-caret"></span>') +
        icon(e.is_dir ? 'folder' : 'file-text', 'ft-ico') +
        '<span class="ft-name"></span>';
      row.querySelector('.ft-name').textContent = e.name;
      if (e.is_dir) row.onclick = () => this._toggle(row, e, depth);
      else row.onclick = () => this.onOpen(e.path);
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._rowMenu(ev, e, depth);
      };
      frag.append(row);
    }
    return frag;
  }

  async _toggle(row, entry, depth) {
    if (this.expanded.has(entry.path)) {
      this.expanded.delete(entry.path);
      row.classList.remove('open');
      const kids = row.nextElementSibling;
      if (kids && kids.classList.contains('ft-kids')) kids.remove();
      return;
    }
    this.expanded.add(entry.path);
    row.classList.add('open');
    const kids = document.createElement('div');
    kids.className = 'ft-kids';
    kids.append(await this._children(entry.path, depth + 1));
    row.after(kids);
  }

  /* ---------------- 右键菜单与写操作 ----------------
     树以前是纯只读的：打开一个文件夹写笔记，想新建一个文件还得回资源管理器。
     写操作全部走后端命令，名字只允许单层（后端会再挡一次 ../）。 */

  _rowMenu(ev, entry) {
    if (!this.menu) return;
    const items = [];
    if (entry.is_dir) {
      items.push({ label: tt('新建文件…'), icon: 'file-plus', action: () => this._create(entry.path, false) });
      items.push({ label: tt('新建文件夹…'), icon: 'folder-plus', action: () => this._create(entry.path, true) });
      items.push({ sep: true });
    }
    items.push({ label: tt('重命名…'), icon: 'pencil', action: () => this._rename(entry) });
    items.push({ label: tt('删除'), icon: 'trash-2', danger: true, action: () => this._remove(entry) });
    items.push({ sep: true });
    items.push({ label: tt('在资源管理器中显示'), icon: 'folder-open', action: () => this.onReveal(entry.path) });
    this.menu(ev.clientX, ev.clientY, items);
  }

  _rootMenu(ev) {
    if (!this.menu || !this.root) return;
    this.menu(ev.clientX, ev.clientY, [
      { label: tt('新建文件…'), icon: 'file-plus', action: () => this._create(this.root, false) },
      { label: tt('新建文件夹…'), icon: 'folder-plus', action: () => this._create(this.root, true) },
      { sep: true },
      { label: tt('刷新'), icon: 'rotate-ccw', action: () => this.render() },
    ]);
  }

  async _create(dir, isDir) {
    if (!this.ask) return;
    const name = await this.ask(
      isDir ? tt('新建文件夹') : tt('新建文件'),
      isDir ? tt('文件夹名') : tt('文件名（带扩展名）'),
      isDir ? tt('新建文件夹') : tt('未命名.md')
    );
    if (!name) return;
    try {
      const p = await this.be.createEntry(dir, name, isDir);
      await this._reloadDir(dir);
      if (!isDir) this.onOpen(p);          // 建完直接打开：新建文件的下一步就是写
      else await this._expandRow(dir);
    } catch (e) {
      this.toast(String(e));
    }
  }

  async _rename(entry) {
    if (!this.ask) return;
    const name = await this.ask(tt('重命名'), tt('新名字'), entry.name);
    if (!name || name === entry.name) return;
    try {
      const np = await this.be.renameEntry(entry.path, name);
      await this._reloadDir(parentOf(entry.path));
      this.onRenamed(entry.path, np);
      this.toast(tt('已重命名'));
    } catch (e) {
      this.toast(String(e));
    }
  }

  async _remove(entry) {
    const ok = this.confirmAsk
      ? await this.confirmAsk(
        tt('删除'),
        tt('确定删除 <b>{name}</b> 吗？<br><br>{detail}', {
          name: entry.name,
          detail: entry.is_dir ? tt('只能删除空文件夹，里面的东西请先清空。') : tt('文件会进系统回收站，需要时可以从那里还原。'),
        })
      )
      : true;
    if (!ok) return;
    try {
      await this.be.deleteEntry(entry.path);
      await this._reloadDir(parentOf(entry.path));
      this.onDeleted(entry.path);
      this.toast(entry.is_dir ? tt('文件夹已删除') : tt('已移到回收站'));
    } catch (e) {
      this.toast(String(e));
    }
  }

  /* 只重画受影响的那一层：整棵树重来会把手动展开的目录全收起来，
     刚新建完就看不到新文件，等于逼人再点一遍。 */
  async _reloadDir(dir) {
    if (!dir || dir === this.root) { await this.render(); return; }
    const row = this._rowOf(dir);
    if (!row) { await this.render(); return; }
    const kids = row.nextElementSibling;
    if (!kids || !kids.classList.contains('ft-kids')) return;   // 没展开过，没有要刷的
    kids.innerHTML = '';
    kids.append(await this._children(dir, this._depthOf(row) + 1));
  }

  async _expandRow(dir) {
    const row = this._rowOf(dir);
    if (row && !this.expanded.has(dir)) await this._toggle(row, { path: dir }, this._depthOf(row));
  }

  _rowOf(path) {
    for (const r of this.body.querySelectorAll('.ft-row')) {
      if (r.dataset.path === path) return r;
    }
    return null;
  }

  _depthOf(row) {
    return Math.max(0, Math.round((parseInt(row.style.paddingLeft, 10) - 6) / 12));
  }

  /** 全目录搜内容；空串回退成树 */
  async search(q) {
    if (!this.root) { await this.render(); return; }
    const query = String(q || '').trim();
    if (!query) { await this.render(); return; }

    const token = ++this.token;
    this.body.innerHTML = '<div class="ft-empty">' + tt('搜索中…') + '</div>';
    let hits = [];
    try {
      hits = await this.be.searchInFolder(this.root, query, 200, this.regex, this.caseSensitive);
    } catch (e) {
      if (token === this.token) this.body.innerHTML = '';
      this.toast(tt('搜索失败：') + e);
      return;
    }
    if (token !== this.token) return;   // 期间又搜了新词，这次结果作废

    this.body.innerHTML = '';
    if (!hits.length) {
      const none = document.createElement('div');
      none.className = 'ft-empty';
      none.textContent = tt('没有找到「{q}」', { q: query });
      this.body.append(none);
      return;
    }

    // 按文件分组：搜索结果按行平铺会让人分不清哪几行是同一个文件
    const groups = new Map();
    for (const h of hits) {
      if (!groups.has(h.path)) groups.set(h.path, []);
      groups.get(h.path).push(h);
    }
    const wrap = document.createElement('div');
    wrap.className = 'ft-results';
    for (const [path, list] of groups) {
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'ft-hit-file';
      head.title = path;
      head.innerHTML = icon('file-text', 'ft-ico') + '<span class="ft-name"></span><span class="ft-count"></span>';
      head.querySelector('.ft-name').textContent = baseName(path);
      head.querySelector('.ft-count').textContent = list.length;
      head.onclick = () => this.onOpen(path);
      wrap.append(head);

      for (const h of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ft-hit';
        row.title = `${path}:${h.line}`;
        row.innerHTML = '<span class="ft-line"></span><span class="ft-text"></span>';
        row.querySelector('.ft-line').textContent = h.line;
        row.querySelector('.ft-text').textContent = h.text || tt('（空行）');
        row.onclick = () => this.onOpen(path, h.line);
        wrap.append(row);
      }
    }
    this.body.append(wrap);
  }
}
