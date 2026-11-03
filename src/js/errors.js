// ============================================================
// errors.js —— 后端（Rust）错误码 → 界面文案
//
// Rust 那边只回 { code, vars, detail } 三样东西：
//   code    稳定错误码（io.read / entry.exists …）
//   vars    模板参数（{name} / {rc} / {mb}）
//   detail  系统自己给的细节（std::io / Win32 的报错文本）
//
// 文案在这里拼，因为**只有前端知道界面现在是哪种语言**。后端只有一份进程，
// 不可能为用户刚切成法语重新加载一套文案；也正因为如此，它绝不能回成品句子
// （曾经那样做过：前端拿中文串去匹配翻译，后端补个标点就整条失配）。
//
// 下面每一条都是完整的句子 + {detail} 占位，不做「前缀 + 冒号 + 尾巴」的拼接：
// 冒号在中/日是全角、法语的冒号前还要加空格，拼接出来的东西每种语言都是错的。
// 这些键同时也是 i18n 词条表的键，走 tt() 取译文。
// ============================================================

import { tt } from './i18n.js';

export const ERR_TEXT = {
  /* ---- 读写文件 ---- */
  'io.read': '无法读取文件：{detail}',
  'io.stat': '无法读取文件信息：{detail}',
  'io.write': '写入失败：{detail}',
  'io.save': '保存失败：{detail}',
  'io.mkdir': '无法创建目录：{detail}',
  'io.create': '创建失败：{detail}',
  'io.rename': '重命名失败：{detail}',
  'io.delete': '删除失败：{detail}',
  'io.copy': '复制图片失败：{detail}',
  'io.write_image': '写入图片失败：{detail}',

  /* ---- 目录 ---- */
  'dir.missing': '目标文件夹不存在',
  'dir.not_folder': '不是文件夹',
  'dir.read': '读取目录失败：{detail}',
  'dir.not_empty': '目录里还有东西，无法删除：{detail}',
  'dir.assets': '创建 assets 目录失败：{detail}',
  'dir.history': '建立历史目录失败：{detail}',
  'dir.history_read': '读历史目录失败：{detail}',

  /* ---- 新建 / 改名 / 删除 ---- */
  'entry.exists': '「{name}」已经存在',
  'entry.missing': '这个条目已经不存在了',
  'entry.no_parent': '找不到所在文件夹',
  'name.empty': '名字不能为空',
  'name.path_sep': '名字里不能带路径分隔符',
  'name.invalid_chars': '名字里有不允许的字符（< > : " | ? *）',
  'recycle.failed': '移入回收站失败（错误码 {rc}）',
  'op.cancelled': '操作已取消',

  /* ---- 文件内容 ---- */
  'file.binary': '这是二进制文件，无法以文本方式打开',
  'file.is_dir': '这是一个文件夹，不能当文件比较',
  'file.too_large': '文件过大',

  /* ---- 搜索 / 替换 ---- */
  'search.empty': '要找的内容是空的',
  'regex.invalid': '正则写错了：{detail}',
  'regex.bad_pattern': '匹配式无效：{detail}',

  /* ---- 图片 ---- */
  'image.missing': '图片文件不存在',
  'image.name_invalid': '图片文件名无效',
  'image.target_invalid': '目标文件名无效',
  'image.empty': '图片内容为空',
  'image.too_many': '同名图片太多了，换个文件名吧',
  'image.too_large_clip': '图片超过 64 MB，挡住它比较好',
  'image.too_large_embed': '图片超过 {mb}MB，没有内嵌',
  'path.invalid': '文档路径无效',

  /* ---- 历史版本 ---- */
  'appdata.missing': '找不到应用数据目录：{detail}',
  'io.snapshot': '读快照失败：{detail}',
  'io.history_write': '写历史快照失败：{detail}',
  'io.history_clear': '清除历史失败：{detail}',

  /* ---- 监听 / 窗口 / 内部 ---- */
  'watch.create': '无法建立文件监听：{detail}',
  'file.stat': '读取文件信息失败：{detail}',
  'win.create': '无法打开对比窗口：{detail}',
  'win.state': '无法切换窗口状态：{detail}',
  'win.compare_missing': '对比窗口不在',
  'win.main_missing': '主窗口不在',
  'app.emit': '无法把文件交给主窗口：{detail}',
  'state.lock': '内部状态异常，请重试',
};

/* 后端错误对象的判据：有 code、没有 message。用过的 Error（含这里翻过的）
   一定带 message，所以不会被二次翻译 —— 二次翻译会把 detail 弄丢。 */
const isBackend = (e) =>
  !!e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message !== 'string';

/**
 * 把后端错误对象转成一个正常的 Error（message 已经是界面语言）。
 * 不是后端错误的（前端自己抛的、字符串）原样返回 —— 调用方不用先判断来源。
 */
export function localizeError(e) {
  if (!isBackend(e)) return e;
  const code = e.code;
  const tpl = ERR_TEXT[code];
  const detail = e.detail || '';
  /* 没收录的码就把码自身露出去。宁可让用户看到 io.foo 这种怪东西，
     也不要静默吞掉 —— 至少能顺着码找到是哪条命令。 */
  const msg = tpl
    ? tt(tpl, Object.assign({}, e.vars, { detail }))
    : '[' + code + ']' + (detail ? ' ' + detail : '');
  const err = new Error(msg);
  err.code = code;
  return err;
}

/**
 * 出错提示的唯一出口：不管拿到的是后端对象、Error、还是字符串，
 * 都只回一句干净的、已翻译的话（不带 "Error: " 前缀）。
 */
export function errText(e) {
  const err = isBackend(e) ? localizeError(e) : e;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return String(err);
}
