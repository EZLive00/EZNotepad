// ============================================================
// appmenu.js —— 自绘菜单栏（替代原生菜单）
// 窗口是无边框的，菜单必须自己画：菜单项仍然只产出「命令 id」，
// 由 app.js 的 commands 表统一执行，和快捷键走同一条路径。
// ============================================================
import { iconHTML } from './icons.js';

const CHECK = iconHTML('check');

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
    menu.items.forEach((it) => {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'am-sep';
        panel.appendChild(s);
        rows.push(null);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'am-item';
      b.setAttribute('role', 'menuitem');
      if (it.disabled && it.disabled()) b.disabled = true;

      const chk = document.createElement('span');
      chk.className = 'am-check';
      if (it.checked && it.checked()) chk.innerHTML = CHECK;

      const lab = document.createElement('span');
      lab.className = 'am-label';
      lab.textContent = it.label;

      b.append(chk, lab);
      if (it.kbd) {
        const k = document.createElement('span');
        k.className = 'am-kbd';
        k.textContent = it.kbd;
        b.appendChild(k);
      }
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('mousemove', () => hot(rows.indexOf(b)));
      b.addEventListener('click', () => {
        if (b.disabled) return;
        close();
        run(it.id);
      });
      panel.appendChild(b);
      rows.push(b);
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
