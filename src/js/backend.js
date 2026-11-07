// ============================================================
// backend.js —— 与 Rust 后端（Tauri 命令）的桥接
// 所有磁盘读写、原生对话框都在这里集中出口
// ============================================================
import { invoke as rawInvoke } from '../vendor/api/core.js';
import { getVersion } from '../vendor/api/app.js';
import { open as openDialog, save as saveDialog } from '../vendor/plugin-dialog/dist-js/index.js';
import { openPath as openWithDefault } from '../vendor/plugin-opener/dist-js/index.js';
import { tt } from './i18n.js';
import { localizeError } from './errors.js';

/* 对话框过滤器名称要跟着界面语言走，所以在调用时才构建 */
const fileFilters = () => [
  { name: tt('文本与代码'), extensions: ['md', 'markdown', 'txt', 'json', 'log', 'csv', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'ini', 'sh', 'sql', 'rs', 'go', 'java', 'c', 'cpp'] },
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: 'JSON', extensions: ['json'] },
  /* PDF 不是文本：选中后会交给系统默认阅读器（见 app.js::openPath）。
     没有这一项的话，「打开文件」对话框里根本点不到 PDF。 */
  { name: 'PDF', extensions: ['pdf'] },
  { name: tt('所有文件'), extensions: ['*'] },
];

/* 后端只回 { code, vars, detail }（见 src-tauri/src/error.rs），
   在这个唯一出口翻成界面语言：所有命令都从这儿过，
   调用方 catch 到的一定是带人话 message 的 Error。 */
const invoke = (cmd, args) => rawInvoke(cmd, args).catch((e) => { throw localizeError(e); });

export const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
export const dirName = (p) => {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join('/');
};

export async function pickFile(title = tt('打开文件')) {
  const r = await openDialog({ title, multiple: false, directory: false, filters: fileFilters() });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

/** 用系统关联程序打开一个文件。权限已由 capabilities 的 opener:allow-open-path 给出；
 *  调用方必须先把路径限制在白名单（见 externalFileKind），别拿它当任意启动器。 */
export const openExternal = (path) => openWithDefault(path);

export async function pickFolder(title = tt('选择文件夹')) {
  const r = await openDialog({ title, directory: true, multiple: false });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

export async function pickSavePath(defaultName = tt('未命名.md'), filters = null) {
  return (await saveDialog({ title: tt('另存为'), defaultPath: defaultName, filters: filters || fileFilters() })) || null;
}

export const readText = (path, encoding = null) => invoke('read_text_file', { path, encoding });
export const readTextAs = (path, encoding) => invoke('read_text_file', { path, encoding });
/** 只问大小，不读内容：对比窗口在读入前先判上限 */
export const fileSize = (path) => invoke('file_size', { path });
export const saveText = (opts) => invoke('save_text_file', { opts });
export const listDir = (path) => invoke('list_dir_recursive', { path, maxFiles: 20000 });
/** 整批比对文件内容：pairs 是 [[左, 右], …]，回一组布尔（逐字节是否相同） */
export const compareFilePairs = (pairs) => invoke('compare_file_pairs', { pairs });
/** 只列一层：侧栏文件树按需展开用 */
export const readDirShallow = (path) => invoke('read_dir_shallow', { path });

/* ---------------- 对比窗口 ----------------
   文本对比跑在独立窗口里（两栏并排 + 预览条），窗口由 Rust 侧创建：
   前端创建窗口要额外开权限，而且拿不到「已存在就复用」的语义。
   左右路径不走 URL，改成开窗前登记、新窗口加载完自己取一次。 */
export const openCompareWindow = (left, right) =>
  invoke('open_compare_window', { left: left || null, right: right || null });
export const takeCompareRequest = () => invoke('take_compare_request');
/* 文件夹对比：独立窗口。两边可以都不带（打开后自己选目录） */
export const openFolderCompareWindow = (left, right) =>
  invoke('open_folder_compare_window', { left: left || null, right: right || null });
export const takeFolderCompareRequest = () => invoke('take_folder_compare_request');
/** 工具窗口 → 主窗口：在编辑器里打开这个文件 */
export const openInMain = (path) => invoke('open_in_main', { path });
/** 工具窗口（文本对比 / 文件夹对比）的「最大化 / 还原」：无边框窗口没有系统
    最大化状态，改成两个矩形。label 是窗口标识（"compare" / "foldercmp"） */
export const setToolFill = (label, fill) => invoke('tool_set_fullscreen', { label, fill: !!fill });
/** 全目录搜文本（在 Rust 里扫，别把每个文件都搬到前端）。regex=true 按正则匹配 */
export const searchInFolder = (root, query, maxResults = 300, regex = false, caseSensitive = false) =>
  invoke('search_in_folder', { root, query, maxResults, regex, caseSensitive });

export const writeBinary = (path, bytes) => invoke('write_binary_file', { path, bytes: Array.from(bytes) });
/** 读文件转 base64（导出 HTML 时把图片内嵌成 data URI 用） */
export const readFileBase64 = (path, maxBytes = 4 * 1024 * 1024) =>
  invoke('read_file_base64', { path, maxBytes });

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];

/** 选一张本地图片（不复制，只返回路径） */
export async function pickImage() {
  const r = await openDialog({
    title: tt('选择图片'),
    multiple: false,
    directory: false,
    filters: [{ name: tt('图片'), extensions: IMAGE_EXTS }],
  });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

/** 把图片复制到文档同目录的 assets/ 下，返回相对路径 */
export const copyImageToAssets = (srcPath, docPath) =>
  invoke('copy_image_to_assets', { srcPath, docPath });

/** 把内存里的图片字节写进 assets/（剪贴板截图、拖进来的 blob 走这条） */
export const saveImageBytes = (docPath, bytes, ext) =>
  invoke('save_image_bytes', { docPath, bytes: Array.from(bytes), ext });

/** 路径是不是图片（拖拽进来的文件按这个分流：图片插进文档，其它当文档打开） */
export const isImagePath = (p) => IMAGE_EXTS.includes(String(p).split('.').pop().toLowerCase());

/** 文件修改时间（毫秒）；文件不存在时为 null。用于发现外部改动 */
export const fileMtime = (path) => invoke('file_mtime', { path });

/**
 * 让后端重新布置文件监听：传进来的是所有已存在磁盘上的文档路径。
 * 后端只盯这些文件各自所在的**目录这一层**，别处的改动不会推过来。
 * 传空数组等于全撤。
 */
export const watchFiles = (paths) => invoke('watch_files', { paths });

/* ---------------- 文件树的写操作 ----------------
   名字只允许单层，路径分隔符由后端拒绝；删除进系统回收站。 */
export const createEntry = (parent, name, dir) => invoke('create_entry', { parent, name, dir });
export const renameEntry = (path, newName) => invoke('rename_entry', { path, newName });
export const deleteEntry = (path) => invoke('delete_entry', { path });

/** 启动参数里带的文件（双击 .md 打开时由系统传进来） */
export const initialFiles = () => invoke('initial_files');
export const confirmAppExit = () => invoke('confirm_app_exit');

/** 应用版本：取自 tauri.conf.json（编译期注入），前端不写死，免得跟版本号脱节 */
export const appVersion = () => getVersion().catch(() => '');

/* ---------------- 导出 PDF ----------------
   打印走不了（WebView2 没有实现浏览器的打印面板），改由 Rust 侧调
   WebView2 的 PrintToPdf：页面按打印样式渲染成 PDF 直接落盘。 */
export const exportPdf = (path) => invoke('export_pdf', { path });

/* ---------------- 速记 ----------------
   速记的文件位置由后端决定（应用数据目录下固定一份），前端不拼路径：
   这样「换个平台数据目录该在哪」只有一处答案，也不需要用户选位置。 */
export const quickNotePath = () => invoke('quick_note_path');

/* ---------------- 本地历史 ----------------
   每次保存前把旧内容留一份，存在应用数据目录（不进文档目录，不污染仓库） */
export const saveHistory = (path, content) => invoke('save_history', { path, content });
export const listHistory = (path) => invoke('list_history', { path });
export const readHistory = (path) => invoke('read_history', { path });
export const clearHistory = (path) => invoke('clear_history', { path });
