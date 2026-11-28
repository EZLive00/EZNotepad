// ============================================================
// viewer.js —— 非文本文件的查看器：图片 / 音视频 / 字体 / 压缩包 / 十六进制
//
// 它不是编辑器：标签上带 `t.viewer` 的那些，正文区换成这里的 DOM，
// 保存、查找、格式化、大纲全都不参与（由 app.js 统一让路）。
//
// 压缩包只在内存里解，不解压到磁盘 —— 「解压到…」是另一个功能，
// 真做的时候要单独处理路径穿越。
// ============================================================
import * as be from './backend.js';
import { tt } from './i18n.js';
import { toast } from './ui.js';
import { iconHTML } from './icons.js';

/* ---------------- 小工具 ---------------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** 1024 进制；不到 1 KB 就按整数 B */
export function sizeText(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (x >= 100 ? Math.round(x) : x.toFixed(1)) + ' ' + u[i];
}

const KIND_LABEL = {
  image: '图片', audio: '音频', video: '视频', font: '字体',
  archive: '压缩包', pdf: 'PDF 文档', office: 'Office 文档',
  binary: '二进制文件', text: '文本',
};

/** 只要类型名（「图片」）。状态栏左边用它，格式交给右边的徽章 —— 两边都写
    「PNG 图片」，同一句话在一行里出现两次，看着像 bug */
export function kindName(info) {
  return tt((info && KIND_LABEL[info.kind]) || '文件');
}

/** 「PNG 图片」：提示语和空态里用 */
export function kindText(info) {
  const base = kindName(info);
  const f = ((info && info.format) || '').toUpperCase();
  return f && f.length <= 5 ? f + ' ' + base : base;
}

/**
 * 程序内到底能浏览哪些压缩格式（media.rs 的 archive_list 只认这三种）。
 *
 * 白名单必须和 Rust 那边一致，而且要在这里被**打开文件之前**用到：
 * openPath 靠它决定「直接进查看器」还是「先问一句要不要交系统」。
 * 两边各写一份的话，会出现「问了一句、点确定、结果还是打不开」这种怪事。
 */
export const BROWSE_FORMATS = ['zip', 'tar', 'gz'];

export function canBrowseArchive(info) {
  if (!info || info.kind !== 'archive') return false;
  return BROWSE_FORMATS.includes(String(info.format || '').toLowerCase());
}

/** asset 协议的原生 URL。转换器不在（离线测试页）就原样返回 */
export function assetUrl(p) {
  const conv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.convertFileSrc;
  try { return conv ? conv(p, 'asset') : p; } catch { return p; }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 十六进制 dump。一行 16 字节：地址 + 十六进制 + ASCII 侧栏。
 * 导出出来是为了单测 —— 这个格式错了很难靠肉眼看出来。
 */
export function hexDump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, Math.min(i + 16, bytes.length));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(i.toString(16).padStart(8, '0').toUpperCase() + '  ' + hex.padEnd(47) + '  |' + ascii.padEnd(16) + '|');
  }
  return lines.join('\n');
}

/**
 * 归档列表按「当前目录」切开：只显示这一层的直接子项。
 * 目录单独去重（zip 里不一定有显式的目录条目）。
 */
export function visibleEntries(entries, prefix = '', filter = '') {
  const pre = prefix || '';
  const seen = new Set();
  const dirs = [];
  const files = [];
  const q = String(filter || '').trim().toLowerCase();
  for (const e of entries) {
    const name = e.name;
    if (!name.startsWith(pre)) continue;
    const rest = name.slice(pre.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const dirName = pre + rest.slice(0, slash + 1);
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      if (q && !dirName.toLowerCase().includes(q)) continue;
      dirs.push({ name: dirName, dir: true, size: 0, packed: 0, mtime: 0 });
    } else {
      if (q && !name.toLowerCase().includes(q)) continue;
      files.push({ name, dir: false, size: e.size, packed: e.packed, mtime: e.mtime });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return dirs.concat(files);
}

/** 归档里的条目路径拆成面包屑 */
export function crumbsOf(full) {
  const parts = String(full || '').split('/').filter(Boolean);
  const out = [];
  let acc = '';
  for (const p of parts) {
    acc += p + '/';
    out.push({ label: p, prefix: acc });
  }
  return out;
}

function dateText(secs) {
  if (!secs) return '';
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 对外入口 ---------------- */

export function render(t, host) {
  if (!t || !t.viewer) return;
  const v = t.viewer;
  const key = [t.id, t.path, v.entry || '', v.prefix || '', v.filter || ''].join('|');
  if (host.__vwKey === key && host.firstChild) return;
  host.__vwKey = key;
  host.innerHTML = '';
  const root = el('div', 'vw vw-' + v.info.kind);
  host.appendChild(root);
  const k = v.info.kind;
  if (k === 'image') paintImage(t, root);
  else if (k === 'audio' || k === 'video') paintMedia(t, root);
  else if (k === 'font') paintFont(t, root);
  else if (k === 'archive') paintArchive(t, root);
  else paintBinary(t, root);
}

export function clear(host) {
  if (!host) return;
  /* img / video 的 src 要先撤：大图和大视频不撤的话，关掉标签后
     解码后的位图还挂在 DOM 节点上占内存 */
  host.querySelectorAll('img,video,audio').forEach((n) => {
    try { n.pause && n.pause(); } catch {}
    n.removeAttribute('src');
    if (n.load) { try { n.load(); } catch {} }
  });
  host.innerHTML = '';
  host.__vwKey = null;
}

export function statusText(t) {
  const v = t && t.viewer;
  if (!v) return '';
  const info = v.info;
  if (info.kind === 'image') {
    const n = t.vstate && t.vstate.natural;
    return (n ? `${n.w} × ${n.h} · ` : '') + sizeText(info.size);
  }
  if (info.kind === 'archive') {
    const n = (v.entries || []).length;
    return (n ? tt('{n} 个条目', { n }) + ' · ' : '') + sizeText(info.size);
  }
  return sizeText(info.size) + (info.format ? ' · ' + info.format.toUpperCase() : '');
}

/* ---------------- 公共头尾 ---------------- */

function bar(actions = []) {
  const b = el('div', 'vw-bar');
  for (const a of actions) {
    if (a.spacer) { b.appendChild(el('span', 'vw-spacer')); continue; }
    const btn = el('button', 'vw-btn');
    btn.type = 'button';
    if (a.html) btn.innerHTML = a.html;
    else btn.textContent = a.label || '';
    if (a.title) btn.title = a.title;
    if (a.act) btn.dataset.act = a.act;
    b.appendChild(btn);
  }
  return b;
}

function foot(parts) {
  const f = el('div', 'vw-foot');
  f.textContent = parts.filter(Boolean).join(' · ');
  return f;
}

function systemBtn(t) {
  return {
    label: tt('用系统程序打开'),
    act: 'system',
    title: tt('交给系统里默认关联的程序'),
  };
}

function folderBtn(t) {
  return {
    label: tt('在文件夹中显示'),
    act: 'folder',
    title: be.dirName(t.path),
  };
}

/** 在资源管理器里选中这个文件。插件不在（离线测试页）就退回打开目录 */
async function reveal(p) {
  try {
    const { revealItemInDir } = await import('../vendor/plugin-opener/dist-js/index.js');
    await revealItemInDir(p);
  } catch {
    be.openExternal(be.dirName(p)).catch(() => {});
  }
}

function bindCommon(t, root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'system') be.openExternal(t.path).catch(() => toast(tt('打不开这个文件')));
    else if (act === 'folder') reveal(t.path);
  });
}

/* ---------------- 图片 ---------------- */

function paintImage(t, root) {
  const st = t.vstate || (t.vstate = { scale: 0, fit: true, natural: null });
  const b = bar([
    { label: '−', act: 'zoom-out', title: tt('缩小') },
    { label: '100%', act: 'zoom-reset', title: tt('实际大小') },
    { label: '+', act: 'zoom-in', title: tt('放大') },
    { label: tt('适应窗口'), act: 'fit' },
    { spacer: true },
    folderBtn(t),
    systemBtn(t),
  ]);
  const pct = b.querySelector('[data-act="zoom-reset"]');
  const stage = el('div', 'vw-stage');
  const img = new Image();
  img.className = 'vw-img';
  img.alt = t.name;
  img.draggable = false;
  stage.appendChild(img);
  root.appendChild(b);
  root.appendChild(stage);

  const ft = foot([]);
  root.appendChild(ft);

  const fitScale = () => {
    if (!st.natural) return 1;
    const sw = stage.clientWidth - 24;
    const sh = stage.clientHeight - 24;
    if (sw <= 0 || sh <= 0) return 1;
    return Math.min(sw / st.natural.w, sh / st.natural.h, 1);
  };

  const apply = () => {
    if (!st.natural) return;
    const s = st.scale || fitScale();
    img.style.width = Math.max(1, Math.round(st.natural.w * s)) + 'px';
    img.style.height = Math.max(1, Math.round(st.natural.h * s)) + 'px';
    pct.textContent = Math.round(s * 100) + '%';
    pct.title = tt('实际大小');
  };

  img.addEventListener('load', () => {
    st.natural = { w: img.naturalWidth, h: img.naturalHeight };
    st.scale = st.fit ? fitScale() : (st.scale || fitScale());
    apply();
    ft.textContent = [st.natural.w + ' × ' + st.natural.h, sizeText(t.viewer.info.size), (t.viewer.info.format || '').toUpperCase()]
      .filter(Boolean).join(' · ');
    /* 尺寸是解码之后才知道的，而状态栏在 render 的同一帧就刷过了。
       这里补一发，让它把「200 × 120」写上 —— 否则状态栏永远只有体积。 */
    window.dispatchEvent(new CustomEvent('ez:viewer-stats'));
  });
  img.addEventListener('error', () => {
    stage.innerHTML = '';
    const box = el('div', 'vw-empty');
    box.appendChild(el('div', 'vw-empty-t', tt('这张图片打不开')));
    box.appendChild(el('div', 'vw-empty-s', tt('格式可能不受支持，或者文件已损坏。')));
    const go = el('button', 'vw-btn primary', tt('用系统程序打开'));
    go.onclick = () => be.openExternal(t.path).catch(() => toast(tt('打不开这个文件')));
    box.appendChild(go);
    stage.appendChild(box);
  });
  img.src = assetUrl(t.path);

  const zoomTo = (s) => {
    st.fit = false;
    st.scale = Math.min(Math.max(0.05, s), 40);
    apply();
  };
  b.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'zoom-in') zoomTo((st.scale || fitScale()) * 1.25);
    else if (act === 'zoom-out') zoomTo((st.scale || fitScale()) / 1.25);
    else if (act === 'zoom-reset') zoomTo(1);
    else if (act === 'fit') { st.fit = true; st.scale = fitScale(); apply(); }
  });
  /* Ctrl+滚轮缩放；不按 Ctrl 就是普通滚动（可预期，和浏览器一致） */
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo((st.scale || fitScale()) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  /* 拖拽平移：放大后图片超出舞台，鼠标拖着走比来回摸滚动条顺手 */
  let drag = null;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
    stage.classList.add('grabbing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    stage.scrollLeft = drag.l - (e.clientX - drag.x);
    stage.scrollTop = drag.t - (e.clientY - drag.y);
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    stage.classList.remove('grabbing');
  });
  /* 窗口变大变小，处于「适应」状态时要跟着重算 */
  const onResize = () => {
    if (!st.fit) return;
    st.scale = fitScale();
    apply();
  };
  window.addEventListener('resize', onResize);
  root.__onCleanup = () => window.removeEventListener('resize', onResize);

  bindCommon(t, root);
}

/* ---------------- 音视频 ---------------- */

function paintMedia(t, root) {
  const info = t.viewer.info;
  const b = bar([{ spacer: true }, folderBtn(t), systemBtn(t)]);
  const stage = el('div', 'vw-stage');
  const node = document.createElement(info.kind === 'audio' ? 'audio' : 'video');
  node.controls = true;
  node.preload = 'metadata';
  node.className = info.kind === 'audio' ? 'vw-audio' : 'vw-video';
  node.src = assetUrl(t.path);
  stage.appendChild(node);
  root.appendChild(b);
  root.appendChild(stage);
  root.appendChild(foot([sizeText(info.size), (info.format || '').toUpperCase()]));
  bindCommon(t, root);
}

/* ---------------- 字体 ---------------- */

async function paintFont(t, root) {
  const info = t.viewer.info;
  const b = bar([{ spacer: true }, folderBtn(t), systemBtn(t)]);
  const stage = el('div', 'vw-font-stage');
  const sample = el('div', 'vw-font');
  const fam = 'vwnote-face-' + t.id;
  const text = el('div', 'vw-font-text');
  const rows = [
    [72, '汉 Handgloves'],
    [36, '永和九年，岁在癸丑'],
    [24, 'The quick brown fox jumps over the lazy dog'],
    [16, '0123456789 · ABCDEFGHIJKLMNOPQRSTUVWXYZ · abcdefghijklmnopqrstuvwxyz'],
  ];
  for (const [size, s] of rows) {
    const d = el('div', 'vw-font-row', s);
    d.style.fontSize = size + 'px';
    text.appendChild(d);
  }
  sample.appendChild(text);
  stage.appendChild(sample);
  root.appendChild(b);
  root.appendChild(stage);
  root.appendChild(foot([sizeText(info.size), (info.format || '').toUpperCase()]));

  try {
    const face = new FontFace(fam, `url("${assetUrl(t.path)}")`);
    await face.load();
    document.fonts.add(face);
    sample.style.fontFamily = `"${fam}", serif`;
    /* 真实字体名要等浏览器解析完 CSS 才拿得到，取不到就退回文件名 */
    const name = face.family && face.family !== fam ? face.family : t.name;
    const h = el('div', 'vw-font-name', name);
    stage.insertBefore(h, sample);
  } catch {
    sample.style.fontFamily = 'serif';
    const h = el('div', 'vw-font-name', tt('这个字体加载不了，下面是系统衬线字体的样张'));
    stage.insertBefore(h, sample);
  }
  bindCommon(t, root);
}

/* ---------------- 压缩包 ---------------- */

function paintArchive(t, root) {
  const v = t.viewer;
  const b = bar([]);
  const crumb = el('div', 'vw-crumbs');
  const back = el('button', 'vw-btn', '←');
  back.type = 'button';
  back.title = tt('返回上一层');
  const filter = el('input', 'vw-filter');
  filter.type = 'search';
  filter.placeholder = tt('筛选条目');
  filter.value = v.filter || '';
  const count = el('span', 'vw-count');
  b.appendChild(back);
  b.appendChild(crumb);
  b.appendChild(el('span', 'vw-spacer'));
  b.appendChild(filter);
  b.appendChild(count);
  const body = el('div', 'vw-list');
  root.appendChild(b);
  root.appendChild(body);

  const updateCrumb = () => {
    crumb.innerHTML = '';
    const rootBtn = el('button', 'vw-crumb', t.name);
    rootBtn.type = 'button';
    rootBtn.onclick = () => { v.prefix = ''; v.entry = null; repaint(); };
    crumb.appendChild(rootBtn);
    for (const c of crumbsOf(v.prefix || '')) {
      crumb.appendChild(el('span', 'vw-crumb-sep', '/'));
      const btn = el('button', 'vw-crumb', c.label);
      btn.type = 'button';
      btn.onclick = () => { v.prefix = c.prefix; v.entry = null; repaint(); };
      crumb.appendChild(btn);
    }
  };

  const repaint = () => {
    hostKeyReset();
    updateCrumb();
    paintList();
  };

  /* 状态一变就换 key，让 render() 的幂等判断失效 —— 这里是内部重画，
     不能回头再走一遍 render（会重建整个 DOM，滚动位置全丢） */
  function hostKeyReset() {
    const host = root.parentElement;
    if (host) host.__vwKey = null;
  }

  function paintList() {
    body.className = 'vw-list';
    body.innerHTML = '';
    const rows = visibleEntries(v.entries || [], v.prefix || '', v.filter || '');
    count.textContent = tt('{n} 个条目', { n: rows.length });
    if (!rows.length) {
      body.appendChild(el('div', 'vw-empty', (v.entries || []).length ? tt('这个文件夹是空的') : tt('这个压缩包是空的')));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const row = el('button', 'ar-row' + (r.dir ? ' dir' : ''));
      row.type = 'button';
      row.dataset.name = r.name;
      row.appendChild(iconSpan(r.dir ? 'folder' : 'file-text'));
      const nm = el('span', 'ar-name', r.dir ? r.name.slice((v.prefix || '').length).replace(/\/$/, '') : r.name.slice((v.prefix || '').length));
      row.appendChild(nm);
      row.appendChild(el('span', 'ar-size', r.dir ? '' : sizeText(r.size)));
      row.appendChild(el('span', 'ar-time', dateText(r.mtime)));
      frag.appendChild(row);
    }
    body.appendChild(frag);
  }

  function iconSpan(id) {
    const s = el('span', 'ar-ico');
    s.innerHTML = iconHTML(id);
    return s;
  }

  body.addEventListener('click', async (e) => {
    const row = e.target.closest('.ar-row');
    if (!row) return;
    const name = row.dataset.name;
    if (row.classList.contains('dir')) {
      v.prefix = name.endsWith('/') ? name : name + '/';
      v.entry = null;
      repaint();
      return;
    }
    showEntry(name);
  });

  filter.addEventListener('input', () => {
    v.filter = filter.value;
    paintList();
  });
  filter.addEventListener('keydown', (e) => { e.stopPropagation(); });
  back.addEventListener('click', () => {
    if (v.entry) { v.entry = null; repaint(); return; }
    const pre = (v.prefix || '').replace(/[^/]+\/$/, '');
    v.prefix = pre;
    v.entry = null;
    repaint();
  });

  async function showEntry(name) {
    v.entry = name;
    /* 「N 个条目」是列表的计数，正看某一条时它没有意义 */
    count.textContent = '';
    body.className = 'vw-entry';
    body.innerHTML = '';
    const head = el('div', 'vw-entry-head');
    const nm = el('span', 'vw-entry-name', name.slice((v.prefix || '').length));
    head.appendChild(nm);
    body.appendChild(head);
    const box = el('div', 'vw-entry-body');
    body.appendChild(box);

    const loading = el('div', 'vw-empty', tt('正在解压这一条…'));
    box.appendChild(loading);
    updateCrumb();
    const crumbEntry = el('span', 'vw-crumb', name.slice((v.prefix || '').length));
    crumb.appendChild(el('span', 'vw-crumb-sep', '/'));
    crumb.appendChild(crumbEntry);

    let blob;
    try {
      blob = await be.archiveRead(t.path, name);
    } catch (err) {
      loading.remove();
      const box2 = el('div', 'vw-empty');
      box2.appendChild(el('div', 'vw-empty-t', tt('这一条打不开')));
      box2.appendChild(el('div', 'vw-empty-s', tt('可能是加密条目，或者解压时出错了。')));
      box.appendChild(box2);
      return;
    }
    loading.remove();
    if (blob.truncated) {
      box.appendChild(el('div', 'vw-note', tt('这个条目太大，只显示了开头一部分（共 {size}）。', { size: sizeText(blob.size) })));
    }
    if (blob.kind === 'text') {
      const pre = el('pre', 'ar-text', blob.text || '');
      box.appendChild(pre);
      head.appendChild(el('span', 'vw-entry-meta', [sizeText(blob.size), blob.encoding].filter(Boolean).join(' · ')));
    } else if (blob.kind === 'image' && blob.b64) {
      const img = new Image();
      img.className = 'vw-img in-archive';
      img.src = 'data:' + (blob.mime || 'image/png') + ';base64,' + blob.b64;
      box.appendChild(img);
      head.appendChild(el('span', 'vw-entry-meta', sizeText(blob.size)));
    } else {
      const bytes = blob.b64 ? b64ToBytes(blob.b64) : new Uint8Array(0);
      box.appendChild(el('pre', 'ar-hex', hexDump(bytes)));
      head.appendChild(el('span', 'vw-entry-meta', [sizeText(blob.size), tt('二进制')].join(' · ')));
    }
  }

  updateCrumb();
  if (!v.entries) {
    body.appendChild(el('div', 'vw-empty', tt('正在读取压缩包…')));
    count.textContent = '';
    be.archiveList(t.path)
      .then((list) => {
        v.entries = list;
        if (t.viewer !== v) return;    // 期间标签换了，别往旧 DOM 上画
        paintList();
      })
      .catch((e) => {
        body.innerHTML = '';
        const box = el('div', 'vw-empty');
        box.appendChild(el('div', 'vw-empty-t', tt('这个压缩包打不开')));
        /* 按格式判，不去猜错误串：错误对象经过 i18n 之后已经是中文了，
           拿 media.unsupported 去 match 永远落空。
           （7z/rar 这些在 openPath 就被拦下问过了，走到这里的是「认得出是
           zip/tar，但内容坏了」—— 所以两条文案要分开，别再说「不支持」。） */
        const known = !canBrowseArchive(t.viewer.info);
        box.appendChild(el('div', 'vw-empty-s', known ? tt('目前支持 zip、tar、tar.gz。') : errText(e)));
        const go = el('button', 'vw-btn primary', tt('用系统程序打开'));
        go.onclick = () => be.openExternal(t.path).catch(() => toast(tt('打不开这个文件')));
        box.appendChild(go);
        body.appendChild(box);
      });
  } else {
    paintList();
  }
  bindCommon(t, root);
}

function errText(e) {
  return (e && (e.message || e.code)) || String(e || '');
}

/* ---------------- 十六进制 / 未知二进制 ---------------- */

async function paintBinary(t, root) {
  const info = t.viewer.info;
  const b = bar([
    { label: tt('复制十六进制'), act: 'copy-hex' },
    { spacer: true },
    folderBtn(t),
    systemBtn(t),
  ]);
  const note = el('div', 'vw-note');
  note.hidden = true;
  const stage = el('div', 'vw-hex-stage');
  const pre = el('pre', 'ar-hex');
  pre.textContent = tt('正在读取…');
  stage.appendChild(pre);
  root.appendChild(b);
  root.appendChild(note);
  root.appendChild(stage);
  root.appendChild(foot([sizeText(info.size), (info.format || '').toUpperCase()]));

  let lastHex = '';
  try {
    const b64 = await be.readBytesB64(t.path, 0, 64 * 1024);
    const bytes = b64ToBytes(b64);
    lastHex = hexDump(bytes);
    pre.textContent = lastHex;
    if (info.size > bytes.length) {
      note.hidden = false;
      note.textContent = tt('只显示前 {n}，完整内容请用系统程序打开。', { n: sizeText(bytes.length) });
    }
  } catch (e) {
    pre.textContent = errText(e);
  }

  b.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'copy-hex') {
      try { await navigator.clipboard.writeText(lastHex); toast(tt('已复制')); } catch { toast(tt('复制失败')); }
    }
  });
  bindCommon(t, root);
}
