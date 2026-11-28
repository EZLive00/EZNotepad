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

/**
 * p 在 root 这棵树里的相对部分（`a/b`，前后都不带分隔符）。
 *
 * 不在里面返回 null，p 就是根本身返回空串。分隔符两种写法都认 —— 命令行传进来的
 * 目录可能是 `D:/work`，而后端读出来是 `D:\work\a.md`，只按字面比前缀会把同一棵树
 * 判成两棵（缩进全平、定位说「不在里面」）。
 */
function relInRoot(p, root) {
  if (!root) return null;
  const a = String(p).replace(/\\/g, '/');
  const b = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!b) return a.replace(/^\/+/, '');        // 根就是 `/`：一切都算在里面
  if (a === b) return '';
  return a.startsWith(b + '/') ? a.slice(b.length + 1) : null;
}

/**
 * p 是否落在 root 这棵树里。
 *
 * 三个坑都在这一个函数里收掉：① 根可以带尾部分隔符（`C:\`、`/home/a/`），
 * 直接拼 `root + '\\'` 会变成 `C:\\` 永远匹配不上；② 前缀相同不等于在里面
 * （`C:\a` 与 `C:\ab` 是两棵不同的树）；③ `/` 这种根去掉分隔符就成空串了。
 * 分隔符本身也不该参与比较，见 `relInRoot`。
 */
function inRoot(p, root) {
  return relInRoot(p, root) !== null;
}

function icon(id, cls = '') {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${id}" /></svg>`;
}

export class FileTree {
  /**
   * @param {object} opt
   *   body     树/搜索结果的容器
   *   be       backend.js 模块（readDirShallow / searchInFolder / createEntry / renameEntry / deleteEntry）
   *   onOpen   (path, line?) => void
   *   onAddFolder () => void                   空状态与右键里的「添加文件夹…」
   *   toast    (msg) => void
   *   menu     (x, y, items) => void           右键菜单（ui.js 的 contextMenu）
   *   ask      (title, label, value) => Promise<string|null>   文本输入框
   *   confirm  (title, html) => Promise<boolean>               二次确认
  *   onRenamed (oldPath, newPath) => void     让打开着的标签跟着改名
   *   onDeleted (path) => void                 让打开着的标签脱离磁盘
   *   onReveal  (path) => void                 在资源管理器里定位
   *   onCompare (leftPath, rightPath) => void  多选两个文件后右键「比较」
   *   onHistory (path, name) => void          右键「历史版本」（按被右键的路径）
   */
  constructor(opt) {
    this.body = opt.body;
    this.be = opt.be;
    this.onOpen = opt.onOpen || (() => {});
    this.onAddFolder = opt.onAddFolder || null;
    this.onRootsChanged = opt.onRootsChanged || null;
    this.toast = opt.toast || (() => {});
    this.menu = opt.menu || null;
    this.ask = opt.ask || null;
    this.confirmAsk = opt.confirm || null;
    this.onRenamed = opt.onRenamed || (() => {});
    this.onDeleted = opt.onDeleted || (() => {});
    this.onReveal = opt.onReveal || (() => {});
    this.onCompare = opt.onCompare || null;
    this.onHistory = opt.onHistory || null;
    this.onTerm = opt.onTerm || null;
    /* 多选只对文件生效：Ctrl 点击增减、Shift 点击选一段，用来挑两个文件做比较 */
    this.sel = new Set();
    this.anchor = '';
    /* 根目录可以有多个：同时盯两摊业务（项目 + 笔记）时不用来回换根，
       换了根就要把上一棵树的展开状态全丢掉。顺序就是显示顺序。 */
    this.roots = [];
    this.expanded = new Set();
    this.regex = false;        // 搜索是否按正则匹配（侧栏 ⋯ 菜单里的那个开关）
    this.caseSensitive = false;
    /* 「body 现在归谁」的代号。render 与 search 都先把它 +1 记下自己那份，
       中间每 await 一次就回头看一眼 —— 变了就说明有更新的那次已经接管了 body，
       再往 DOM 上写就成了「旧树盖新树」。 */
    this.token = 0;
    this.activePath = '';      // 编辑区当前文件，用来在树里点亮
    /* 空白处右键：多根之后「对根目录操作」这句话已经没有唯一答案了，
       所以给的是「添加文件夹 / 刷新」这两个与具体根无关的动作。挂在容器上，
       树被重画多少次都还在 */
    this.body.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest('.ft-root')) return;    // 根行自己处理
      if (ev.target.closest('.ft-row')) return;     // 行自己处理
      if (ev.target.closest('.ft-hit, .ft-hit-file')) return;
      ev.preventDefault();
      this._blankMenu(ev);
    });
  }

  /** 第一个根 —— 只给「当前能不能搜」这类判断用，别拿它当唯一根 */
  get root() { return this.roots[0] || ''; }
  get hasRoot() { return this.roots.length > 0; }

  /** 把一个路径归一成根的样子。盘符根（`C:\`）与 `/` 保持原样 —— 去掉分隔符
      会变成 `C:`（「C 盘的当前目录」）和空串，两者都不是同一个位置 */
  static _norm(p) {
    const s = String(p || '');
    if (!s) return '';
    if (s === '/' || /^[A-Za-z]:[\\/]$/.test(s)) return s;
    return s.replace(/[\\/]+$/, '');
  }

  /** 设成「只有这一个根」（旧接口 / 测试用）。传空串等于全清 */
  setRoot(path) { return this.setRoots(path ? [path] : []); }

  /**
   * 把一串根理干净：同一棵树里只留最外层那一个。
   *
   * 互为父子的两个根会让同一个路径在树里出现两行（`_rowOf` 只能返回第一行，
   * 第二棵的展开就落到了第一棵的位置上），层数也没法算 —— 一个路径到底算第几层，
   * 取决于「按哪个根算」。所以干脆不让这种状态存在：更里层的那个根被外层的吸收，
   * 顺序保留第一次出现的位置。
   */
  static _cleanRoots(list) {
    const out = [];
    for (const p of list || []) {
      const s = FileTree._norm(p);
      if (!s) continue;
      if (out.some((r) => inRoot(s, r))) continue;          // 已经在某个根下面了
      for (let i = out.length - 1; i >= 0; i--) {            // 这个根包住了先前那些
        if (inRoot(out[i], s)) out.splice(i, 1);
      }
      out.push(s);
    }
    return out;
  }

  async setRoots(list) {
    const next = FileTree._cleanRoots(list);
    this.roots = next;
    this._pruneExpanded();
    /* 根默认展开：树的意义就是看见里面有什么。收起来的根只在用户自己点过之后
       才出现（`_closeRow` 会把它从 expanded 里摘掉） */
    for (const s of next) this.expanded.add(s);
    await this.render();
    this._notifyRoots();
  }

  /** 加一个根。已经在列表里就只展开它（不重复加、不报错） */
  async addRoot(path) {
    const s = FileTree._norm(path);
    if (!s) return false;
    if (this.roots.includes(s)) { await this.render(); return false; }
    /* 加进来的目录若被某个根包着（选了个子目录），它本来就在树里 —— 不再单独成根；
       反过来，加的若是父目录，就把被它包住的旧根并进来（那些文件仍在这棵树里，
       只是深了一层）。两种情况都不能留下「一格里两行同一路径」的状态。 */
    const next = FileTree._cleanRoots([...this.roots, s]);
    if (!next.includes(s)) { await this.render(); return false; }
    this.roots = next;
    this.expanded.add(s);           // 新加进来的根默认展开：加它就是为了看里面的东西
    await this.render();
    this._notifyRoots();
    return true;
  }

  /** 从侧栏移除一个根。**只移除视图**，磁盘上的东西一个字节都不动 */
  async removeRoot(path) {
    const s = FileTree._norm(path);
    const before = this.roots.length;
    this.roots = this.roots.filter((r) => r !== s);
    if (this.roots.length === before) return false;
    this._pruneExpanded();
    await this.render();
    this._notifyRoots();
    return true;
  }

  /** 根列表变了 → 让外面把它存进设置（views 不碰 storage） */
  _notifyRoots() {
    if (this.onRootsChanged) this.onRootsChanged(this.roots.slice());
  }

  /** 展开状态里只留还在某个根下面的路径 */
  _pruneExpanded() {
    for (const p of [...this.expanded]) {
      if (!this.roots.some((r) => inRoot(p, r))) this.expanded.delete(p);
    }
  }

  /** 这个路径属于哪个根？不属于任何一个返回空串。多个根互为前缀时取最长的那一个 */
  rootOf(path) {
    const p = String(path || '');
    let best = '';
    for (const r of this.roots) {
      if (inRoot(p, r) && r.length > best.length) best = r;
    }
    return best;
  }

  /** 编辑区换文件时调用：把对应行点亮，并让「单选」一起跟着走 */
  setActive(path) {
    this.activePath = path || '';
    this.body.querySelectorAll('.ft-row.active').forEach((r) => r.classList.remove('active'));
    const row = this.activePath
      ? [...this.body.querySelectorAll('.ft-row')].find((r) => r.dataset.path === this.activePath)
      : null;
    /* 从标签栏换文件时，树里那圈 .sel 边框 + --bg-hover 灰底会留在旧文件上，
       看起来像两个选中项（而灰底又和鼠标悬浮一模一样）。单选必须跟着编辑区走；
       Ctrl/Shift 攒出来的显式多选（>= 2）不动 —— 那是正在挑两个文件做比较，
       不该被一次标签切换打断。 */
    if (this.sel.size <= 1) {
      this.sel.clear();
      if (row) { this.sel.add(this.activePath); this.anchor = this.activePath; }
    }
    if (row) row.classList.add('active');
    this._paintSel();
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
    if (!this.roots.length || !path) return 'outside';
    const p = String(path);
    /* 多个根时先问「它属于哪一棵」：只看第一个根会把第二个根下的文件判成「在外面」 */
    const root = this.rootOf(p);
    if (!root) return 'outside';

    const dirs = [];
    const rootBase = root.replace(/[\\/]+$/, '') || root;
    for (let d = parentOf(p); d && d.length > rootBase.length && inRoot(d, root); d = parentOf(d)) dirs.unshift(d);
    let opened = false;
    for (const d of dirs) if (!this.expanded.has(d)) { this.expanded.add(d); opened = true; }
    /* 根要是收着的，它下面的行根本不在 DOM 里 —— 光展开中间层不够 */
    if (!this.expanded.has(root)) { this.expanded.add(root); opened = true; }
    /* 搜索状态下 body 里是命中列表，不是树 —— 重画一次才会回到树上 */
    if (opened || !this.body.querySelector('.ft-row, .ft-root')) await this.render();

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
    const token = ++this.token;
    this.body.innerHTML = '';
    if (!this.roots.length) {
      this._emptyState();
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'ft-tree';
    /* 根行是**分组标题**，不是 .ft-row：树里的行都带动作（单击打开、Ctrl 多选），
       根行混进去会让「顶层有几项」这类判断凭空多一个，也会被 Shift 选段扫到 */
    for (const root of this.roots) tree.append(this._rootRow(root));
    this.body.append(tree);
    /* `expanded` 是「哪些目录开着」的唯一真相，整棵树重建后必须重新落到 DOM 上：
       否则刷新一次看着全收起，而标记还留着 —— 再点那一下只会把标记删掉，
       界面上什么都不发生（要按两下才收得回去）。按层级从浅到深加，
       深的目录得先有父行的子容器才找得到自己的行。根行也在这条链上。 */
    await this._replayExpanded(null, token);
    if (token !== this.token) return;          // 期间又画了一次，这份已经作废
    this.setActive(this.activePath);
    /* 行是新建的，选择状态要重画；顺手把已经不存在的路径从选择里摘掉 */
    if (this.sel.size) {
      const alive = new Set([...this.body.querySelectorAll('.ft-row')].map((r) => r.dataset.path));
      for (const p of [...this.sel]) if (!alive.has(p)) this.sel.delete(p);
      this._paintSel();
    }
  }

  /**
   * 把 `expanded` 里开着的那几层重新开一遍（重画之后调用）。
   *
   * 按层数从浅到深走：子目录的行要等父目录展开了才在 DOM 里。找不到行的
   * 标记直接摘掉（目录已在磁盘上没了），别留着一个点两下才消的死状态。
   * `under` 非空时只重放这一棵子树 —— 局部刷新走这条，不会去动别人。
   */
  async _replayExpanded(under = null, token = this.token) {
    const list = [...this.expanded]
      .filter((p) => (under === null ? true : p !== under && inRoot(p, under)))
      .sort((a, b) => this._depthOfPath(a) - this._depthOfPath(b));
    for (const p of list) {
      /* 期中有新的 render / search 接管了 body，这一份就作废。⛔ 不能继续往下走：
         此时 body 里可能根本不是树（是搜索结果），`_rowOf` 全落空，
         会把这棵树本来开着的目录从 `expanded` 里一个个抹掉。 */
      if (token !== this.token) return;
      const row = this._rowOf(p);
      if (row) await this._openRow(row, p);
      else this.expanded.delete(p);
    }
  }

  /** 一个根都没有：给一句话 + 一个明显的入口，别让人去找角落里那个小按钮 */
  _emptyState() {
    const box = document.createElement('div');
    box.className = 'ft-empty';
    box.textContent = tt('还没打开文件夹。添加一个目录，就能在这里翻文件、搜内容。');
    this.body.append(box);
    if (!this.onAddFolder) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ft-empty-btn';
    b.textContent = tt('添加文件夹…');
    b.onclick = () => this.onAddFolder();
    this.body.append(b);
  }

  /**
   * 一个根的分组行。
   *
   * 行本身可点：折叠 / 展开这一整棵（`expanded` 里根路径也在，和普通目录同一套）。
   * 右侧两颗按钮鼠标经过才显形：＋ 在这个根里新建，× 从侧栏移除（不动磁盘）。
   * 左内边距 6px 来自 CSS，正好等于「层数 0」那一档，所以它下面的顶层项缩进到
   * 18px，一眼看出归属。层数由路径算（`_depthOfPath`），⛔ 别再靠读回行上的
   * padding 反推 —— 根行的 6px 在 CSS 里，`row.style.paddingLeft` 是空串，
   * 反推会得到 NaN，整棵树重画时缩进就全平了。
   */
  _rootRow(root) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ft-root' + (this.expanded.has(root) ? ' open' : '');
    row.dataset.path = root;
    row.title = root;
    row.innerHTML = icon('chevron-right', 'ft-caret') + icon('folder', 'ft-ico') + '<span class="ft-name"></span>';
    row.querySelector('.ft-name').textContent = baseName(root) || root;
    row.onclick = () => this._toggle(row, { path: root, is_dir: true, name: baseName(root) });
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._rootRowMenu(ev, root);
    };
    row.append(
      this._rootBtn('plus', tt('在这个文件夹里新建…'), (ev) => this._addMenu(ev, { path: root, is_dir: true })),
      this._rootBtn('x', tt('从侧栏移除（磁盘上的文件不动）'), () => this._removeRootAsk(root)),
    );
    return row;
  }

  /** 根行右侧那颗小按钮：mousedown 就挡住，否则它会先把整棵树折起来再说 */
  _rootBtn(iconId, title, fn) {
    const b = document.createElement('span');
    b.className = 'ft-root-btn';
    b.setAttribute('role', 'button');
    b.title = title;
    b.innerHTML = icon(iconId);
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(ev); });
    return b;
  }

  async _removeRootAsk(root) {
    const name = baseName(root) || root;
    const ok = this.confirmAsk
      ? await this.confirmAsk(
        tt('移除文件夹'),
        tt('把 <b>{name}</b> 从侧栏移除？<br><br>磁盘上的文件一个都不会动，只是这里不再显示。', { name })
      )
      : true;
    if (!ok) return;
    if (await this.removeRoot(root)) this.toast(tt('已从侧栏移除'));
  }

  /* 读一层子项。缩进层级由 `dir` 自己在树里的层数决定 —— 不接外部传进来的
     depth：传参的那份和 `expanded` 那份迟早会不一样，缩进就跟着漂。 */
  async _children(dir) {
    const depth = this._depthOfPath(dir) + 1;
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
      if (e.is_dir) row.onclick = () => this._toggle(row, e);
      else row.onclick = (ev) => this._clickFile(row, e, ev);
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._rowMenu(ev, e);
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

  async _toggle(row, entry) {
    if (this.expanded.has(entry.path)) this._closeRow(row, entry.path);
    else await this._openRow(row, entry.path);
  }

  /** 展开一行；幂等 —— 已经挂过子容器就直接跳过（render 重放时会重复调） */
  async _openRow(row, path) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains('ft-kids')) { this.expanded.add(path); row.classList.add('open'); return; }
    this.expanded.add(path);
    row.classList.add('open');
    const kids = document.createElement('div');
    kids.className = 'ft-kids';
    kids.append(await this._children(path));
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
      /* 当前文件已由 .active 点亮，再叠一圈 .sel 边框只会让「选中」和
         「鼠标悬浮」分不清。.sel 只画给多选里额外的那些行。 */
      r.classList.toggle('sel', this.sel.has(r.dataset.path) && r.dataset.path !== this.activePath);
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
    /* 历史版本只针对文件（目录没有内容可快照）。不写省略号：点了直接列快照，
       不会再弹一个要填东西的框。 */
    if (!entry.is_dir && this.onHistory) {
      items.push({ label: tt('历史版本'), icon: 'rotate-ccw', action: () => this.onHistory(entry.path, entry.name) });
    }
    /* 与标签右键同一组、同一顺序：复制路径紧挨着「在资源管理器中显示」。
       文件与目录都给 —— 目录路径贴到终端里一样有用。 */
    items.push({ label: tt('复制文件路径'), icon: 'copy', action: () => this._copyPath(entry.path) });
    items.push({ label: tt('在资源管理器中显示'), icon: 'folder-open', action: () => this.onReveal(entry.path) });
    /* 在终端里进到这一层：目录就是它自己，文件取所在目录 ——
       「在这里打开终端」是文件管理器的常见动作，省得先复制路径再 cd 一遍。 */
    if (this.onTerm) {
      const dir = entry.is_dir ? entry.path : parentOf(entry.path);
      items.push({ label: tt('在此处打开终端'), icon: 'terminal', action: () => this.onTerm(dir) });
    }
    /* 交给系统默认程序：图片/压缩包虽然程序内能看，但「我要用 PS 改这张图」
       这条需求一直都在。放在最后，不抢主路径。 */
    if (!entry.is_dir) {
      items.push({
        label: tt('用系统程序打开'),
        icon: 'external-link',
        action: () => this.be.openExternal(entry.path).catch(() => this.toast(tt('打不开这个文件'))),
      });
    }
    this.menu(ev.clientX, ev.clientY, items);
  }

  /** 复制的是被右键那一行，不是多选的整组（菜单上写的是单数）。
      失败必须说失败：execCommand('copy') 会明确返回 false，不能无条件报「已复制」。 */
  _copyPath(path) {
    if (!path) return;
    this.toast(writeClipboard(path) ? tt('路径已复制') : tt('无法复制路径'));
  }

  /** 根行右键：这个根自己的新建 / 刷新，加上全局的「添加文件夹」 */
  _rootRowMenu(ev, root) {
    if (!this.menu) return;
    const items = [
      { label: tt('新建文件…'), icon: 'file-plus', action: () => this._create(root, false) },
      { label: tt('新建文件夹…'), icon: 'folder-plus', action: () => this._create(root, true) },
      { sep: true },
      { label: tt('刷新'), icon: 'rotate-ccw', action: () => this.render() },
    ];
    if (this.onTerm) {
      items.push({ label: tt('在此处打开终端'), icon: 'terminal', action: () => this.onTerm(root) });
    }
    if (this.onAddFolder) {
      items.push({ label: tt('添加文件夹…'), icon: 'folder-plus', action: () => this.onAddFolder() });
    }
    items.push({ sep: true });
    items.push({ label: tt('移除这个文件夹'), icon: 'x', action: () => this._removeRootAsk(root) });
    this.menu(ev.clientX, ev.clientY, items);
  }

  /**
   * 树区空白处右键。
   *
   * 原来的语义是「对根目录操作」（这里是新建文件…）。多根之后这句话没有唯一答案 ——
   * 空白到底算哪个根的？所以在这里只给与具体根无关的两件事：加根、刷新。
   * 「在某个根里新建」回到那个根自己的行上（右键或右侧 ＋）。
   */
  _blankMenu(ev) {
    if (!this.menu) return;
    const items = [];
    if (this.onAddFolder) {
      items.push({ label: tt('添加文件夹…'), icon: 'folder-plus', action: () => this.onAddFolder() });
    }
    if (this.roots.length) {
      if (items.length) items.push({ sep: true });
      items.push({ label: tt('刷新'), icon: 'rotate-ccw', action: () => this.render() });
    }
    if (!items.length) return;
    this.menu(ev.clientX, ev.clientY, items);
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
    /* 根自己那一层 = 整棵树重画最省事（多根时还牵涉根行的开合） */
    if (!dir || this.roots.includes(dir)) { await this.render(); return; }
    const row = this._rowOf(dir);
    if (!row) { await this.render(); return; }
    const kids = row.nextElementSibling;
    if (!kids || !kids.classList.contains('ft-kids')) return;   // 没展开过，没有要刷的
    const token = this.token;
    kids.innerHTML = '';
    kids.append(await this._children(dir));
    if (token !== this.token) return;
    /* 这一层下面本来开着的子目录也得重新打开：行是新建的，`expanded` 里还留着
       标记，看着却全收起了 —— 再点那一下只会把标记删掉，界面上什么都不发生
       （「要按两下才收得回去」）。只重放这一棵子树，不碰别人的展开状态。 */
    await this._replayExpanded(dir, token);
  }

  async _expandRow(dir) {
    const row = this._rowOf(dir);
    if (row) await this._openRow(row, dir);
  }

  /* 根行也算：`_expandRow(根)` / `_reloadDir(根)` 得能找到它 */
  _rowOf(path) {
    for (const r of this.body.querySelectorAll('.ft-row, .ft-root')) {
      if (r.dataset.path === path) return r;
    }
    return null;
  }

  /**
   * 一个路径在自己那棵树里的层数：根 = 0，根下第一层 = 1，依此类推。
   *
   * 以前是读 `row.style.paddingLeft` 反推（(padding - 6) / 12），可根行的 6px
   * 写在 CSS 的 `padding: 0 6px` 里，内联样式是空串 → `parseInt('')` 得 NaN →
   * 根下面整层都按 NaN 缩进（`"NaNpx"` 是无效值，浏览器直接忽略），表现为
   * **一刷新整棵树就变平**，手动折叠再展开才回来。层数本来就是从路径就能算出来的
   * 东西，不该反过来问 DOM。
   */
  _depthOfPath(p) {
    const s = String(p || '');
    const root = this.rootOf(s);
    if (!root) return 0;
    const rest = relInRoot(s, root);                 // 分隔符两种写法都归一过了
    if (!rest) return 0;                             // 根自己
    return rest.split('/').filter(Boolean).length;
  }

  /** 全目录搜内容（**所有根一起搜**）；空串回退成树 */
  async search(q) {
    if (!this.roots.length) { await this.render(); return; }
    const query = String(q || '').trim();
    if (!query) { await this.render(); return; }

    const token = ++this.token;
    this.body.innerHTML = '<div class="ft-empty">' + tt('搜索中…') + '</div>';
    const hits = [];
    let firstErr = null;
    /* 一个根读不了不该让整次搜索失败 —— 收集其它根的命中，最后再决定要不要报错 */
    for (const root of this.roots) {
      if (token !== this.token) return;
      try {
        hits.push(...await this.be.searchInFolder(root, query, 200, this.regex, this.caseSensitive));
      } catch (e) {
        firstErr = firstErr || e;
      }
    }
    if (!hits.length && firstErr) {
      if (token === this.token) this.body.innerHTML = '';
      /* 直接拼 Error 会得到「搜索失败：Error: ...」，走 errText 才是别处同一套说法 */
      this.toast(tt('搜索失败：') + errText(firstErr));
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
    const multi = this.roots.length > 1;      // 一个根时标所属是废话
    for (const [path, list] of groups) {
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'ft-hit-file';
      head.title = path;
      head.innerHTML = icon('file-text', 'ft-ico') + '<span class="ft-name"></span><span class="ft-count"></span>';
      head.querySelector('.ft-name').textContent = baseName(path);
      head.querySelector('.ft-count').textContent = list.length;
      /* 多根时在文件名后面标出所属的根：两边的同名文件光看名字分不开。
         做成组头里的一段淡字，不另起一行 —— 一个文件一行根名的话，
         十来个文件就是十来行重复 */
      if (multi) {
        const root = this.rootOf(path);
        if (root) {
          const tag = document.createElement('span');
          tag.className = 'ft-root-tag';
          tag.textContent = baseName(root) || root;
          tag.title = root;
          head.insertBefore(tag, head.querySelector('.ft-count'));
        }
      }
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
