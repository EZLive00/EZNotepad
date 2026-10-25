// ============================================================
// appmenu.js —— 自绘菜单栏（替代原生菜单）
// 窗口是无边框的，菜单必须自己画：菜单项仍然只产出「命令 id」，
// 由 app.js 的 commands 表统一执行，和快捷键走同一条路径。
// ============================================================
import { iconHTML } from './icons.js';

const CHECK = iconHTML('check', 'check');

/**
 * @param {object} opt
 * @param {HTMLElement} opt.bar      放菜单按钮的容器
 * @param {Array} opt.menus          [{ label, items: [{ id, label, kbd, checked?, disabled? } | { sep:true }] }]
 * @param {(id:string)=>void} opt.run 执行命令
 */
export function createAppMenu({ bar, menus, run }) {
  const panel = document.createElement('div');
  panel.className = 'appmenu';
  panel.setAttribute('role', 'menu');
  panel.hidden = true;
  document.body.appendChild(panel);

  const buttons = [];
  let openIndex = -1;
  let rows = [];      // 与 items 等长，分隔符位置为 null
  let hotIndex = -1;

  menus.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'am-btn';
    b.textContent = m.label;
    // 阻止默认行为以保住编辑区焦点（否则「粘贴」「撤销」会找不到目标）
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openIndex === i) close();
      else open(i);
    });
    b.addEventListener('mouseenter', () => { if (openIndex >= 0 && openIndex !== i) open(i); });
    bar.appendChild(b);
    buttons.push(b);
  });

  function render(menu) {
    panel.innerHTML = '';
    rows = [];

    /** 统一造一个「可点、可键盘走」的按钮 */
    function makeBtn(cls, it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.setAttribute('role', 'menuitem');
      if (it.disabled && it.disabled()) b.disabled = true;
      if (it.hint) b.title = it.hint;
      // 阻止默认行为以保住编辑区焦点（否则「粘贴」「撤销」会找不到目标）
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('mousemove', () => hot(rows.indexOf(b)));
      b.addEventListener('click', () => {
        if (b.disabled) return;
        close();
        // action 用于「最近打开」这种条目：它们不是固定命令，而是带着一个路径的闭包
        if (typeof it.action === 'function') it.action();
        else run(it.id);
      });
      rows.push(b);
      return b;
    }

    // items 可以是函数：最近打开这类内容每次展开都可能不一样，
    // 固定数组只能渲染出「打开时的样子」
    const items = typeof menu.items === 'function' ? menu.items() : menu.items;
    items.forEach((it) => {
      if (it.hidden && it.hidden()) return;

      // 分组小标题：不参与键盘导航，只负责把长菜单切成几段
      if (it.head) {
        const h = document.createElement('div');
        h.className = 'am-head';
        h.textContent = it.head;
        panel.appendChild(h);
        return;
      }

      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'am-sep';
        panel.appendChild(s);
        return;
      }

      // 说明性小字：比把整片菜单变灰好——灰只会让人以为「坏了」，
      // 一句话能说清为什么现在不能用、去哪儿用
      if (it.note) {
        const n = document.createElement('div');
        n.className = 'am-note';
        n.textContent = it.note;
        panel.appendChild(n);
        return;
      }

      // 一行多个：标题级别这种「互斥且平级」的选项，横排比竖排少占 3 行，
      // 而且一眼就能看出它们是同一组里的单选题
      if (Array.isArray(it.row)) {
        const wrap = document.createElement('div');
        wrap.className = 'am-row';
        it.row.forEach((p) => {
          if (p.hidden && p.hidden()) return;
          const b = makeBtn('am-pill', p);
          if (p.checked && p.checked()) b.classList.add('on');
          b.innerHTML = (p.icon ? iconHTML(p.icon) : '') + `<span>${p.label}</span>`;
          b.title = (p.hint || p.label) + (p.kbd ? `　${p.kbd}` : '');
          wrap.appendChild(b);
        });
        if (wrap.children.length) {
          // makeBtn 已经把按钮记进 rows 了，但这里按 DOM 顺序重排一次，
          // 否则键盘上下走的顺序和眼睛看到的顺序对不上
          const start = rows.length - wrap.children.length;
          rows.splice(start, wrap.children.length, ...wrap.children);
          panel.appendChild(wrap);
        }
        return;
      }

      const b = makeBtn('am-item', it);

      // 左侧 16px 槽：有勾显示勾，没勾显示图标 —— 两者共用一个位置，
      // 所以带图标的项和带勾的项左边永远对得齐
      const slot = document.createElement('span');
      slot.className = 'am-slot';
      if (it.checked && it.checked()) slot.innerHTML = CHECK;
      else if (it.icon) slot.innerHTML = iconHTML(it.icon);

      const lab = document.createElement('span');
      lab.className = 'am-label';
      lab.textContent = typeof it.label === 'function' ? it.label() : it.label;

      b.append(slot, lab);
      if (it.kbd) {
        const k = document.createElement('span');
        k.className = 'am-kbd';
        k.textContent = it.kbd;
        b.appendChild(k);
      }
      panel.appendChild(b);
    });
  }

  function place(i) {
    const r = buttons[i].getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let x = r.left;
    let y = r.bottom + 4;
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - 8 - w);
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 4);
    panel.style.left = Math.round(x) + 'px';
    panel.style.top = Math.round(y) + 'px';
  }

  function open(i) {
    openIndex = i;
    buttons.forEach((b, n) => b.classList.toggle('open', n === i));
    render(menus[i]);
    panel.hidden = false;
    place(i);
    hot(-1);
  }

  function close() {
    openIndex = -1;
    hotIndex = -1;
    panel.hidden = true;
    panel.innerHTML = '';
    buttons.forEach((b) => b.classList.remove('open'));
  }

  function hot(i) {
    hotIndex = i;
    rows.forEach((b, n) => b && b.classList.toggle('hot', n === i && !b.disabled));
  }

  function step(dir) {
    const n = rows.length;
    if (!n) return;
    let i = hotIndex;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (rows[i] && !rows[i].disabled) { hot(i); return; }
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (openIndex < 0) return;
    if (panel.contains(e.target) || bar.contains(e.target)) return;
    close();
  }, true);

  window.addEventListener('blur', close);
  window.addEventListener('resize', () => { if (openIndex >= 0) close(); });

  document.addEventListener('keydown', (e) => {
    if (openIndex < 0) return;
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (k === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); open((openIndex + 1) % menus.length); }
    else if (k === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); open((openIndex - 1 + menus.length) % menus.length); }
    else if ((k === 'Enter' || k === ' ') && hotIndex >= 0 && rows[hotIndex]) {
      e.preventDefault(); e.stopPropagation();
      rows[hotIndex].click();
    }
  }, true);

  return { close };
}
