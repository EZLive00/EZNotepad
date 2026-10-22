// ============================================================
// ui.js —— 通用 UI 组件：提示条、确认框、通用对话框
// ============================================================

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

/** 通用对话框：返回 Promise<{ok:boolean}> */
export function dialog({ title = '提示', body = '', buttons = [{ id: 'ok', label: '确定', primary: true }] } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('dlgOverlay');
    const titleEl = document.getElementById('dlgTitle');
    const bodyEl = document.getElementById('dlgBody');
    const footEl = document.getElementById('dlgFoot');
    titleEl.textContent = title;
    if (typeof body === 'string') bodyEl.innerHTML = `<div class="dlg-text">${body}</div>`;
    else { bodyEl.innerHTML = ''; bodyEl.appendChild(body); }
    footEl.innerHTML = '';
    const close = (val) => { overlay.classList.add('hidden'); resolve(val); };
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'mini' + (b.primary ? ' primary' : ' ghost');
      btn.textContent = b.label;
      btn.onclick = () => close(b.id);
      footEl.appendChild(btn);
      if (b.id === 'ok' || b.primary) setTimeout(() => btn.focus(), 30);
    });
    document.getElementById('dlgClose').onclick = () => close('cancel');
    overlay.classList.remove('hidden');
    overlay.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close('cancel'); }
      if (e.key === 'Enter') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); close(p.id); }
      }
    };
    overlay.focus();
  });
}

export const confirmBox = (title, text, okLabel = '确定', cancelLabel = '取消') =>
  dialog({ title, body: text, buttons: [{ id: 'ok', label: okLabel, primary: true }, { id: 'cancel', label: cancelLabel }] }).then((r) => r === 'ok');

/** 模拟原生菜单：基于定位的浮层菜单 */
export function contextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - items.length * 30 - 20) + 'px';
  items.forEach((it) => {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      return;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    if (it.shortcut) {
      const k = document.createElement('span');
      k.className = 'ctx-kbd';
      k.textContent = it.shortcut;
      b.appendChild(k);
    }
    b.onclick = () => { menu.remove(); it.action && it.action(); };
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  const off = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); }
  };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
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
