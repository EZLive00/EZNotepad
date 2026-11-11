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
import { errText } from './errors.js';
import { writeClipboard } from './clipboard.js';
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
   *   onCompare (leftPath, rightPath) => void  多选两个文件后右键「比较」
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
    this.onCompare = opt.onCompare || null;
    /* 多选只对文件生效：Ctrl 点击增减、Shift 点击选一段，用来挑两个文件做比较 */
    this.sel = new Set();
    this.anchor = '';
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

  /**
   * 在树里定位一个文件：把从根到它父目录的每一层都展开、滚到看得见的地方，再闪三下。
   * 照 IDEA 的 Select Opened File：用户要的是「它在目录里的哪儿」，不是「打开它」。
   *
   * 返回：
   *   'revealed' 展开并定位到了
   *   'already'  本来就在眼前（行已是当前文件）—— 仍然闪，闪本身就是回答
   *   'outside'  这个文件不在当前打开的文件夹下（或压根没打开文件夹）
   *   'gone'     路径在根目录下，但树里没有这一行（文件可能已被删/改名）
   *
   * 展开状态只认 `expanded` 这一份真相，所以这里只往集合里加、然后重画一遍 ——
   * 自己拼 DOM 会和 render 的那套（按层级深浅补开目录）漂移。
   */
  async reveal(path) {
    if (!this.root || !path) return 'outside';
    const root = this.root.replace(/[\\/]+$/, '');
    /* 前缀相同不算在里面：C:\a 与 C:\ab 是两棵不同的树 */
    const p = String(path);
    if (p !== root && !p.startsWith(root + '\\') && !p.startsWith(root + '/')) return 'outside';

    const dirs = [];
    for (let d = parentOf(p); d && d.length > root.length; d = parentOf(d)) dirs.unshift(d);
    let opened = false;
    for (const d of dirs) if (!this.expanded.has(d)) { this.expanded.add(d); opened = true; }
    /* 搜索状态下 body 里是命中列表，不是树 —— 重画一次才会回到树上 */
    if (opened || !this.body.querySelector('.ft-row')) await this.render();

    const row = this._rowOf(p);
    if (!row) return 'gone';
    const wasActive = row.classList.contains('active');
    row.classList.add('active');
    row.scrollIntoView({ block: 'nearest' });
    /* 先摘再加强制回流，动画才会从头播 —— 连按两次定位时第二次也得闪 */
    row.classList.remove('ft-flash');
    void row.offsetWidth;
    row.classList.add('ft-flash');
    clearTimeout(row._flashTimer);
    row._flashTimer = setTimeout(() => row.classList.remove('ft-flash'), 1100);
    return wasActive ? 'already' : 'revealed';
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
    /* `expanded` 是「哪些目录开着」的唯一真相，整棵树重建后必须重新落到 DOM 上：
       否则刷新一次看着全收起，而标记还留着 —— 再点那一下只会把标记删掉，
       界面上什么都不发生（要按两下才收得回去）。按层级从浅到深加，
       深的目录得先有父行的子容器才找得到自己的行。 */
    const byDepth = [...this.expanded].sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
    for (const p of byDepth) {
      const row = this._rowOf(p);
      if (row) await this._openRow(row, p, this._depthOf(row));
      else this.expanded.delete(p);      // 目录已经不在了，别留着标记
    }
    this.setActive(this.activePath);
    /* 行是新建的，选择状态要重画；顺手把已经不存在的路径从选择里摘掉 */
    if (this.sel.size) {
      const alive = new Set([...this.body.querySelectorAll('.ft-row')].map((r) => r.dataset.path));
      for (const p of [...this.sel]) if (!alive.has(p)) this.sel.delete(p);
      this._paintSel();
    }
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
      else row.onclick = (ev) => this._clickFile(row, e, ev);
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._rowMenu(ev, e, depth);
      };
      /* 文件夹右侧的「＋」：鼠标移上去才显形，点开是这个目录自己的新增菜单。
         必须是 span 而不是 button —— .ft-row 本身就是 button，button 套 button
         会被浏览器拆开，行结构当场散架。占位始终存在（只改 opacity），
         否则鼠标扫过整列文件夹时名字宽度会跟着抖。 */
      if (e.is_dir) this._addBtn(row, e);
      frag.append(row);
    }
    return frag;
  }

  /** 往文件夹行里塞那颗「＋」 */
  _addBtn(row, entry) {
    const b = document.createElement('span');
    b.className = 'ft-add';
    b.setAttribute('role', 'button');
    b.tabIndex = -1;
    b.title = tt('在这个文件夹里新建…');
    b.innerHTML = icon('plus');
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._addMenu(ev, entry);
    });
    row.appendChild(b);
  }

  /** 只放「新增」：删除仍然只在右键菜单里，行内这颗按钮不该够得着删文件 */
  _addMenu(ev, entry) {
    if (!this.menu) return;
    const r = ev.currentTarget.getBoundingClientRect();
    this.menu(r.right - 2, r.bottom + 2, [
      { label: tt('新建文件…'), icon: 'file-plus', action: () => this._create(entry.path, false) },
      { label: tt('新建文件夹…'), icon: 'folder-plus', action: () => this._create(entry.path, true) },
    ]);
  }

  async _toggle(row, entry, depth) {
    if (this.expanded.has(entry.path)) this._closeRow(row, entry.path);
    else await this._openRow(row, entry.path, depth);
  }

  /** 展开一行；幂等 —— 已经挂过子容器就直接跳过（render 重放时会重复调） */
  async _openRow(row, path, depth) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('ft-kids')) { this.expanded.add(path); row.classList.add('open'); return; }
    this.expanded.add(path);
    row.classList.add('open');
    const kids = document.createElement('div');
    kids.className = 'ft-kids';
    kids.append(await this._children(path, depth + 1));
    row.after(kids);
  }

  _closeRow(row, path) {
    this.expanded.delete(path);
    row.classList.remove('open');
    const kids = row.nextElementSibling;
    if (kids && kids.classList.contains('ft-kids')) kids.remove();
  }

  /* ---------------- 右键菜单与写操作 ----------------
     树以前是纯只读的：打开一个文件夹写笔记，想新建一个文件还得回资源管理器。
     写操作全部走后端命令，名字只允许单层（后端会再挡一次 ../）。 */

  /* ---------------- 多选 ---------------- */

  /**
   * 文件行点击。
   *   · 普通点击：只选它，并且照旧打开（打开是单击的默认动作，别为了多选把这个改掉）
   *   · Ctrl/⌘ 点击：只增减选择，不打开 —— 想比较两个文件时不该顺手弹出两个标签
   *   · Shift 点击：从锚点到这一行按可视顺序选一段
   */
  _clickFile(row, entry, ev) {
    if (ev && (ev.ctrlKey || ev.metaKey)) { this._toggleSel(entry.path); return; }
    if (ev && ev.shiftKey && this.anchor) {
      const rows = [...this.body.querySelectorAll('.ft-row')].filter((r) => !r.classList.contains('dir'));
      const a = rows.findIndex((r) => r.dataset.path === this.anchor);
      const b = rows.indexOf(row);
      if (a >= 0 && b >= 0) {
        this.sel.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.sel.add(rows[i].dataset.path);
        this._paintSel();
        return;
      }
    }
    this.sel.clear();
    this.sel.add(entry.path);
    this.anchor = entry.path;
    this._paintSel();
    this.onOpen(entry.path);
  }

  _toggleSel(path) {
    if (this.sel.has(path)) this.sel.delete(path);
    else this.sel.add(path);
    this.anchor = path;
    this._paintSel();
  }

  /** 选择状态画在行上；重画树之后要再调一次（行是新建的） */
  _paintSel() {
    this.body.querySelectorAll('.ft-row').forEach((r) => {
      r.classList.toggle('sel', this.sel.has(r.dataset.path));
    });
  }

  _rowMenu(ev, entry) {
    if (!this.menu) return;
    /* 右键落在没被选中的文件上时，把选择收束到它 —— 否则「比较」会作用在
       用户根本没看着的那两个文件上 */
    if (!entry.is_dir && !this.sel.has(entry.path)) {
      this.sel.clear();
      this.sel.add(entry.path);
      this.anchor = entry.path;
      this._paintSel();
    }
    const items = [];
    if (entry.is_dir) {
      items.push({ label: tt('新建文件…'), icon: 'file-plus', action: () => this._create(entry.path, false) });
      items.push({ label: tt('新建文件夹…'), icon: 'folder-plus', action: () => this._create(entry.path, true) });
      items.push({ sep: true });
    } else if (this.onCompare && this.sel.size === 2) {
      const other = [...this.sel].find((p) => p !== entry.path);
      if (other) {
        items.push({ label: tt('比较这两个文件'), icon: 'file-diff', action: () => this.onCompare(entry.path, other) });
        items.push({ sep: true });
      }
    }
    items.push({ label: tt('重命名…'), icon: 'pencil', action: () => this._rename(entry) });
    items.push({ label: tt('删除'), icon: 'trash-2', danger: true, action: () => this._remove(entry) });
    items.push({ sep: true });
    /* 与标签右键同一组、同一顺序：复制路径紧挨着「在资源管理器中显示」。
       文件与目录都给 —— 目录路径贴到终端里一样有用。 */
    items.push({ label: tt('复制文件路径'), icon: 'copy', action: () => this._copyPath(entry.path) });
    items.push({ label: tt('在资源管理器中显示'), icon: 'folder-open', action: () => this.onReveal(entry.path) });
    this.menu(ev.clientX, ev.clientY, items);
  }

  /** 复制的是被右键那一行，不是多选的整组（菜单上写的是单数）。
      失败必须说失败：execCommand('copy') 会明确返回 false，不能无条件报「已复制」。 */
  _copyPath(path) {
    if (!path) return;
    this.toast(writeClipboard(path) ? tt('路径已复制') : tt('无法复制路径'));
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
      /* 建完必须看得见：目录没展开时 _reloadDir 什么都不做（没有 kids 可刷），
         于是新文件只出现在标签栏、树里找不到。这里补一次展开，两种都适用。 */
      await this._expandRow(dir);
      if (!isDir) this.onOpen(p);          // 建完直接打开：新建文件的下一步就是写
    } catch (e) {
      this.toast(errText(e));
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
      this.toast(errText(e));
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
      this.toast(errText(e));
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
    if (row) await this._openRow(row, dir, this._depthOf(row));
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
