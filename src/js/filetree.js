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

const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');

function icon(id, cls = '') {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${id}" /></svg>`;
}

export class FileTree {
  /**
   * @param {object} opt
   *   body     树/搜索结果的容器
   *   pathText 显示当前文件夹名的元素
   *   be       backend.js 模块（readDirShallow / searchInFolder）
   *   onOpen   (path, line?) => void
   *   toast    (msg) => void
   */
  constructor(opt) {
    this.body = opt.body;
    this.pathText = opt.pathText;
    this.be = opt.be;
    this.onOpen = opt.onOpen || (() => {});
    this.toast = opt.toast || (() => {});
    this.root = '';
    this.expanded = new Set();
    this.token = 0;            // 搜索序号：慢请求回来时直接丢弃
    this.activePath = '';      // 编辑区当前文件，用来在树里点亮
  }

  setRoot(path) {
    this.root = path || '';
    this.expanded.clear();
    if (this.pathText) {
      this.pathText.textContent = this.root ? baseName(this.root) : '未打开文件夹';
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
      this.body.innerHTML = '<div class="ft-empty">还没打开文件夹。<br>点上面的「选择…」挑一个目录，<br>之后就能在这里翻文件、搜内容。</div>';
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
      err.textContent = '读不到这个目录';
      frag.append(err);
      return frag;
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'ft-empty small';
      empty.style.paddingLeft = `${18 + depth * 12}px`;
      empty.textContent = '空目录';
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

  /** 全目录搜内容；空串回退成树 */
  async search(q) {
    if (!this.root) { await this.render(); return; }
    const query = String(q || '').trim();
    if (!query) { await this.render(); return; }

    const token = ++this.token;
    this.body.innerHTML = '<div class="ft-empty">搜索中…</div>';
    let hits = [];
    try {
      hits = await this.be.searchInFolder(this.root, query, 200);
    } catch (e) {
      if (token === this.token) this.body.innerHTML = '';
      this.toast('搜索失败：' + e);
      return;
    }
    if (token !== this.token) return;   // 期间又搜了新词，这次结果作废

    this.body.innerHTML = '';
    if (!hits.length) {
      const none = document.createElement('div');
      none.className = 'ft-empty';
      none.textContent = `没有找到「${query}」`;
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
        row.querySelector('.ft-text').textContent = h.text || '（空行）';
        row.onclick = () => this.onOpen(path, h.line);
        wrap.append(row);
      }
    }
    this.body.append(wrap);
  }
}
