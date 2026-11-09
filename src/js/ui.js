// ============================================================
// ui.js —— 通用 UI 组件：提示条、确认框、通用对话框
// ============================================================
import { iconHTML } from './icons.js';
import { tt } from './i18n.js';

export function toast(msg, ms = 2200) {
  const wrap = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/**
 * 通用对话框：返回 Promise<{ok:boolean}>
 *
 * `focus`：初始焦点元素。不给就落在主按钮上（回车即确认，是大多数对话框
 * 想要的手感）；给了就落在它身上 —— 「新建文档」的类型网格要靠方向键走，
 * 焦点一开始就得在格子里，否则方向键按下去没有任何反应。
 */
export function dialog({ title = tt('提示'), body = '', buttons = [{ id: 'ok', label: tt('确定'), primary: true }], wide = false, focus = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('dlgOverlay');
    const titleEl = document.getElementById('dlgTitle');
    const bodyEl = document.getElementById('dlgBody');
    const footEl = document.getElementById('dlgFoot');
    /* 宽版：设置这种「左分类 + 右内容」的面板需要横向空间，
       默认 620px 会被挤成两条窄柱子 */
    overlay.querySelector('.modal').classList.toggle('wide', !!wide);
    titleEl.textContent = title;
    if (typeof body === 'string') bodyEl.innerHTML = `<div class="dlg-text">${body}</div>`;
    else { bodyEl.innerHTML = ''; bodyEl.appendChild(body); }
    footEl.innerHTML = '';
    /* 初始焦点是延时设的。对话框可能在 30ms 内就被回车关掉（新建文档走键盘
       时正是这条路径），那时定时器还没跑 —— 关窗一并作废，别让已关闭的弹层
       再回头动焦点：对隐藏元素调 focus 的结果各版本并不一致。 */
    let focusTimer = 0;
    const close = (val) => { clearTimeout(focusTimer); overlay.classList.add('hidden'); resolve(val); };
    /* 按钮可以声明单键快捷键（b.key：'Y' / 'N' / 'Esc'）。键帽直接画在按钮上，
       不用猜；「未保存」那类三选一对话框靠它才能全程键盘走完。 */
    const keyMap = new Map();
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'mini' + (b.primary ? ' primary' : ' ghost');
      btn.textContent = b.label;
      if (b.key) {
        const k = String(b.key).toLowerCase();
        const isEsc = k === 'esc' || k === 'escape';
        keyMap.set(isEsc ? 'escape' : k, b.id);
        btn.dataset.key = isEsc ? 'Esc' : b.key;
        btn.classList.add('btn-key');
        btn.setAttribute('aria-keyshortcuts', isEsc ? 'Escape' : b.key);
      }
      btn.onclick = () => close(b.id);
      footEl.appendChild(btn);
    });
    // 初始焦点只设一次：给了 focus 就听它的，否则落在主按钮（没有主按钮时落最后一个）
    const first = focus || footEl.querySelector('.primary') || footEl.lastElementChild;
    if (first) focusTimer = setTimeout(() => first.focus(), 30);
    // body 里带 data-dialog-close 的元素点一下就关闭并把它的值交回去
    // （「新建文档」的类型网格用这个，省得自建一套弹层）
    bodyEl.onclick = (e) => {
      const hit = e.target.closest && e.target.closest('[data-dialog-close]');
      if (!hit) return;
      e.preventDefault();
      close(hit.dataset.dialogClose);
    };
    document.getElementById('dlgClose').onclick = () => close('cancel');
    overlay.classList.remove('hidden');
    overlay.onkeydown = (e) => {
      const k = (e.key || '').toLowerCase();
      const hit = keyMap.get(k);
      /* 字母键归输入框自己：弹层里带输入框时敲 y 不该把弹层关掉。组字中、
         带 Ctrl/Alt/Meta 的键也不接管；Escape 例外，它本来就是取消。 */
      const typing = !!(e.target && (e.target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')));
      if (hit && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey
          && (k === 'escape' || !typing)) {
        e.preventDefault();
        e.stopPropagation();
        close(hit);
        return;
      }
      if (e.key === 'Escape') { e.stopPropagation(); close('cancel'); }
      if (e.key === 'Enter') {
        /* 焦点停在「点了会返回某个值」的元素上（新建文档的类型格子），
           回车认的是它，不是主按钮 —— 否则方向键选了半天，回车还是建上次那个类型。
           这里必须 preventDefault：回车在按钮上的默认动作就是 click，
           不拦住会先 click 一次再走下面，同一格被确认两遍。 */
        const hit = e.target && e.target.closest && e.target.closest('[data-dialog-close]');
        if (hit) { e.preventDefault(); close(hit.dataset.dialogClose); return; }
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); close(p.id); }
      }
    };
    overlay.focus();
  });
}

export const confirmBox = (title, text, okLabel = tt('确定'), cancelLabel = tt('取消')) =>
  dialog({ title, body: text, buttons: [{ id: 'ok', label: okLabel, primary: true }, { id: 'cancel', label: cancelLabel }] }).then((r) => r === 'ok');

/**
 * 模拟原生菜单：基于定位的浮层菜单
 *
 * items 里每一项可以是：
 *   { label, shortcut?, icon?, action, disabled?, danger? }   普通项
 *   { head: '分组名' }                                         分组小标题
 *   { sep: true }                                              分隔线
 *   { row: [...], lead?: '插入行', danger?: true }              一行多个药丸
 *     药丸项在普通项基础上多两个字段：checked?（点亮当前项）、iconOnly（只画图标）
 *
 * 定位一律以实测尺寸为准，四边都夹在窗口内；菜单比窗口还高时限高并允许滚动。
 *
 * 第四个参数 `{ stayOnScroll }`：锚点是固定控件（不随内容滚动而移动）时传 true，
 * 否则页面里任何一处滚动都会把菜单收掉。
 */
/* 当前浮层菜单的关闭函数。换菜单时必须走它自己的 close()：
   Escape / mousedown 的监听挂在 document 的 capture 上，不跟着 DOM 一起消失，
   只 remove 节点会留下「幽灵菜单」，把之后每一次 Esc 都吞掉 —— 未保存提示的
   「Esc 取消」就是这么失效的。 */
let openMenuClose = null;

export function contextMenu(x, y, items, { stayOnScroll = false } = {}) {
  if (openMenuClose) openMenuClose();
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');

  const run = (it) => {
    close();
    if (typeof it.action === 'function') it.action();
  };

  const mkBtn = (cls, it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls + (it.danger ? ' danger' : '');
    if (it.disabled) b.disabled = true;
    // 菜单项文字少，光看「删行」猜不出上下文，靠 title 补一句完整说法
    b.title = (it.hint || it.label) + (it.shortcut ? `　${it.shortcut}` : '');
    if (it.label) b.setAttribute('aria-label', it.label);
    // 保住编辑区焦点与选区，否则「加粗」这类命令会找不到目标
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.onclick = () => run(it);
    return b;
  };

  items.forEach((it) => {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      return;
    }

    // 分组小标题：和主菜单共用一套样式，长菜单才有「段落感」
    if (it.head) {
      const h = document.createElement('div');
      h.className = 'am-head';
      h.textContent = it.head;
      menu.appendChild(h);
      return;
    }

    // 一行多个：成组的动作（加粗/斜体/…、增删行列、对齐）横排，
    // 比竖着排省掉一大半高度，也不会让人以为它们各管一摊
    if (Array.isArray(it.row)) {
      const wrap = document.createElement('div');
      wrap.className = 'ctx-row';
      if (it.lead) {
        const l = document.createElement('span');
        l.className = 'ctx-lead';
        l.textContent = it.lead;
        wrap.appendChild(l);
      }
      it.row.forEach((p) => {
        if (p.hidden && p.hidden()) return;
        // danger 可以标在整行上（「删除」一组的三个动作都危险），也可以标在单个药丸上
        const b = mkBtn('ctx-pill' + (it.danger || p.danger ? ' danger' : ''), p);
        if (p.checked && p.checked()) b.classList.add('on');
        b.innerHTML = (p.icon ? iconHTML(p.icon) : '') + (p.iconOnly ? '' : `<span>${p.label}</span>`);
        wrap.appendChild(b);
      });
      if (wrap.children.length > (it.lead ? 1 : 0)) menu.appendChild(wrap);
      return;
    }

    const b = mkBtn('ctx-item', it);
    b.innerHTML = '<span class="ctx-label"></span>';
    b.firstChild.textContent = it.label;
    if (it.shortcut) {
      const k = document.createElement('span');
      k.className = 'ctx-kbd';
      k.textContent = it.shortcut;
      b.appendChild(k);
    }
    menu.appendChild(b);
  });

  /* 先隐形挂上去量真实尺寸，再决定放哪儿。
     以前用 items.length * 30 估高度，表格菜单 23 项估成 710px，
     小窗口下 top 直接被算成负数 —— 菜单上半截跑到窗口外面去了 */
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = menu.offsetWidth;
  let h = menu.offsetHeight;

  // 菜单比窗口还高：限高 + 滚动，否则无论怎么夹都有一截看不见
  const maxH = vh - pad * 2;
  if (h > maxH) {
    menu.style.maxHeight = maxH + 'px';
    h = maxH;
  }

  let left = Math.min(x, vw - pad - w);
  if (left < pad) left = pad;

  let top = y;
  if (top + h > vh - pad) top = y - h;      // 下方放不下 → 翻到鼠标上方
  if (top < pad) top = pad;                 // 上方也放不下 → 贴顶

  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.visibility = '';

  /* 别拿 menu.isConnected 当「已经关过了」：外部（或下一份菜单）直接摘掉
     DOM 时它同样为 false，那时监听还得清。用显式标志，且重复调用是安全的。 */
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', off, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    menu.remove();
    if (openMenuClose === close) openMenuClose = null;
  }
  openMenuClose = close;

  const off = (e) => { if (!menu.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };

  setTimeout(() => {
    /* 菜单可能在注册监听之前就被下一份菜单顶掉了（同一帧里连开两次）。
       那时 close() 已经跑过，别再把已关菜单的监听挂回 document。 */
    if (closed) return;
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', onKey, true);
    /* 滚动会让菜单和它指向的那个格子错位，直接收掉。
       但锚在**固定控件**上的菜单（标签条右侧那颗「全部标签」）不跟内容走：
       滚动事件是排队派发的 —— 标签条刚被滚过（切换标签时 syncTabOverflow
       也会滚），紧接着点按钮，菜单会在一帧后被那条迟到的 scroll 收掉，
       表现成「点了没反应」。这种菜单传 stayOnScroll。 */
    if (!stayOnScroll) {
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
    }
    window.addEventListener('blur', close);
  }, 0);
}

export const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
};

export const fmtTime = (ms) => {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
