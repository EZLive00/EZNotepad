// ============================================================
// history.js —— 本地历史版本面板
//
// 只负责「列快照」和「把选中的交给调用方」。真正的动作由 app.js 决定：
// 打开成新标签、或写回编辑器（不落盘）。
// 和文件对比、三向合并同一个原则：回滚绝不直接覆盖磁盘上的文件。
// ============================================================

import { dialog, toast } from './ui.js';
import * as be from './backend.js';

const pad = (n) => String(n).padStart(2, '0');

function label(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

const size = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * @param {object} o
 *   path     文档路径
 *   onOpen   async (snap) => void   在只读标签里打开这一版
 *   onApply  (text) => void         写回编辑器（不落盘）
 */
export async function showHistory(o) {
  const list = await be.listHistory(o.path).catch((e) => {
    toast(String(e));
    return [];
  });

  const box = document.createElement('div');
  box.className = 'hist';

  if (!list.length) {
    box.innerHTML = '<div class="dlg-text">还没有历史版本。<br>保存过一次之后，每次保存前的内容会自动留一份在这里。</div>';
    return dialog({ title: '历史版本', body: box, buttons: [{ id: 'ok', label: '知道了', primary: true }] });
  }

  const hint = document.createElement('div');
  hint.className = 'dlg-text';
  hint.textContent = `${list.length} 个版本（最多保留 60 个）。「恢复」只写进编辑器，按 Ctrl+S 才会改动文件。`;
  box.append(hint);

  const listEl = document.createElement('div');
  listEl.className = 'hist-list';
  list.forEach((snap, i) => {
    const row = document.createElement('div');
    row.className = 'hist-item';
    row.innerHTML = '<span class="hist-time"></span><span class="hist-size"></span>';
    row.querySelector('.hist-time').textContent = label(snap.time) + (i === 0 ? '（最近）' : '');
    row.querySelector('.hist-size').textContent = size(snap.size);

    const acts = document.createElement('span');
    acts.className = 'hist-acts';

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'hist-btn';
    view.textContent = '查看';
    view.onclick = async () => {
      try {
        const text = await be.readHistory(snap.path);
        o.onOpen({ ...snap, text });
      } catch (e) {
        toast(String(e));
      }
    };

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'hist-btn primary';
    apply.textContent = '恢复';
    apply.onclick = async () => {
      try {
        const text = await be.readHistory(snap.path);
        o.onApply(text);
      } catch (e) {
        toast(String(e));
      }
    };

    acts.append(view, apply);
    row.append(acts);
    listEl.append(row);
  });
  box.append(listEl);

  return dialog({
    title: '历史版本',
    body: box,
    buttons: [{ id: 'ok', label: '关闭', primary: true }],
  });
}
