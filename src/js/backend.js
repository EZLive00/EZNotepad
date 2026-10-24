// ============================================================
// backend.js —— 与 Rust 后端（Tauri 命令）的桥接
// 所有磁盘读写、原生对话框都在这里集中出口
// ============================================================
import { invoke } from '../vendor/api/core.js';
import { open as openDialog, save as saveDialog } from '../vendor/plugin-dialog/dist-js/index.js';

const FILTERS = [
  { name: '文本与代码', extensions: ['md', 'markdown', 'txt', 'json', 'log', 'csv', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yml', 'yaml', 'ini', 'sh', 'sql', 'rs', 'go', 'java', 'c', 'cpp'] },
  { name: 'Markdown', extensions: ['md', 'markdown'] },
  { name: 'JSON', extensions: ['json'] },
  { name: '所有文件', extensions: ['*'] },
];

export const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
export const dirName = (p) => {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join('/');
};

export async function pickFile(title = '打开文件') {
  const r = await openDialog({ title, multiple: false, directory: false, filters: FILTERS });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

export async function pickFolder(title = '选择文件夹') {
  const r = await openDialog({ title, directory: true, multiple: false });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

export async function pickSavePath(defaultName = '未命名.md') {
  return (await saveDialog({ title: '另存为', defaultPath: defaultName, filters: FILTERS })) || null;
}

export const readText = (path, encoding = null) => invoke('read_text_file', { path, encoding });
export const readTextAs = (path, encoding) => invoke('read_text_file', { path, encoding });
export const saveText = (opts) => invoke('save_text_file', { opts });
export const listDir = (path) => invoke('list_dir_recursive', { path, maxFiles: 20000 });
export const writeBinary = (path, bytes) => invoke('write_binary_file', { path, bytes: Array.from(bytes) });

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];

/** 选一张本地图片（不复制，只返回路径） */
export async function pickImage() {
  const r = await openDialog({
    title: '选择图片',
    multiple: false,
    directory: false,
    filters: [{ name: '图片', extensions: IMAGE_EXTS }],
  });
  return typeof r === 'string' ? r : (r && r.path) || null;
}

/** 把图片复制到文档同目录的 assets/ 下，返回相对路径 */
export const copyImageToAssets = (srcPath, docPath) =>
  invoke('copy_image_to_assets', { srcPath, docPath });
