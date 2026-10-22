// 简单记事本 - Rust 后端
// 只做网页端做不了的事：原生文件对话框、磁盘读写与编码转换、目录遍历。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
struct ReadResult {
    path: String,
    name: String,
    content: String,
    encoding: String,
    bom: bool,
    eol: String,
}

/// 用 encoding_rs 按顺序尝试解码，返回 (文本, 编码名)
fn decode_bytes(bytes: &[u8]) -> (String, String, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (s, _, _) = encoding_rs::UTF_8.decode(&bytes[3..]);
        return (s.into_owned(), "UTF-8".into(), true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return (s.into_owned(), "UTF-16LE".into(), true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return (s.into_owned(), "UTF-16BE".into(), true);
    }
    // 严格校验 UTF-8，失败则回退 GB18030（兼容 GBK/GB2312）
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "UTF-8".into(), false),
        Err(_) => {
            let (s, _, _) = encoding_rs::GB18030.decode(bytes);
            (s.into_owned(), "GBK".into(), false)
        }
    }
}

fn detect_eol(text: &str) -> String {
    if text.contains("\r\n") {
        "CRLF".into()
    } else if text.contains('\r') {
        "CR".into()
    } else {
        "LF".into()
    }
}

#[tauri::command]
fn read_text_file(path: String, encoding: Option<String>) -> Result<ReadResult, String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("无法读取文件：{e}"))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err("这是二进制文件，无法以文本方式打开".into());
    }
    let (content, encoding, bom) = match encoding.as_deref() {
        Some(enc) => {
            let has_bom = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
            let body: &[u8] = if has_bom { &bytes[3..] } else { &bytes[..] };
            let cs = match enc {
                "GBK" => encoding_rs::GB18030,
                "UTF-16LE" => encoding_rs::UTF_16LE,
                "UTF-16BE" => encoding_rs::UTF_16BE,
                _ => encoding_rs::UTF_8,
            };
            let (s, _, _) = cs.decode(body);
            (s.into_owned(), enc.to_string(), has_bom)
        }
        None => decode_bytes(&bytes),
    };
    let eol = detect_eol(&content);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(ReadResult {
        path: p.to_string_lossy().to_string(),
        name,
        content,
        encoding,
        bom,
        eol,
    })
}

#[derive(Deserialize)]
struct SaveOptions {
    path: String,
    content: String,
    encoding: String,
    bom: bool,
}

#[tauri::command]
fn save_text_file(opts: SaveOptions) -> Result<String, String> {
    let p = PathBuf::from(&opts.path);
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            fs::create_dir_all(dir).map_err(|e| format!("无法创建目录：{e}"))?;
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(opts.content.len() + 3);
    if opts.bom {
        match opts.encoding.as_str() {
            "UTF-16LE" => out.extend_from_slice(&[0xFF, 0xFE]),
            "UTF-16BE" => out.extend_from_slice(&[0xFE, 0xFF]),
            _ => out.extend_from_slice(&[0xEF, 0xBB, 0xBF]),
        }
    }
    match opts.encoding.as_str() {
        "UTF-16LE" => {
            for u in opts.content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        "UTF-16BE" => {
            for u in opts.content.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        "GBK" => {
            let (bytes, _, _) = encoding_rs::GB18030.encode(&opts.content);
            out.extend_from_slice(&bytes);
            if out.len() > 512 * 1024 * 1024 {
                return Err("文件过大".into());
            }
        }
        _ => out.extend_from_slice(opts.content.as_bytes()),
    }
    fs::write(&p, &out).map_err(|e| format!("保存失败：{e}"))?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn file_stat(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    ext: String,
    size: u64,
    mtime: u64,
}

/// 递归列出目录下所有文件（忽略隐藏文件与超大目录），用于文件夹对比
#[tauri::command]
fn list_dir_recursive(path: String, max_files: Option<usize>) -> Result<Vec<DirEntryInfo>, String> {
    let limit = max_files.unwrap_or(20000);
    let mut out = Vec::new();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("不是文件夹".into());
    }
    walk(&root, &mut out, limit, 0)?;
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<DirEntryInfo>, limit: usize, depth: usize) -> Result<(), String> {
    if out.len() >= limit || depth > 24 {
        return Ok(());
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk(&path, out, limit, depth + 1)?;
        } else {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            out.push(DirEntryInfo {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                ext,
                size: meta.len(),
                mtime,
            });
            if out.len() >= limit {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}

/// 原生菜单：菜单项点击后把命令 id 发给前端，前端统一分发
fn install_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let mut made: Vec<MenuItem<tauri::Wry>> = Vec::new();
    let mut mi = |id: &str, label: &str| -> MenuItem<tauri::Wry> {
        let item = MenuItem::with_id(app, id, label, true, None::<&str>).unwrap();
        made.push(item.clone());
        item
    };

    let sep = || PredefinedMenuItem::separator(app).unwrap();

    let quit = PredefinedMenuItem::quit(app, Some("退出"))?;
    let undo = PredefinedMenuItem::undo(app, Some("撤销"))?;
    let redo = PredefinedMenuItem::redo(app, Some("重做"))?;
    let cut = PredefinedMenuItem::cut(app, Some("剪切"))?;
    let copy = PredefinedMenuItem::copy(app, Some("复制"))?;
    let paste = PredefinedMenuItem::paste(app, Some("粘贴"))?;
    let selall = PredefinedMenuItem::select_all(app, Some("全选"))?;
    let fs = PredefinedMenuItem::fullscreen(app, Some("全屏"))?;

    let (n_new, n_open, n_save, n_saveas, n_pdf, n_reload, n_close) = (
        mi("new", "新建"), mi("open", "打开…"), mi("save", "保存"), mi("saveAs", "另存为…"),
        mi("exportPdf", "导出 PDF / 打印…"), mi("reload", "重新载入"), mi("closeTab", "关闭标签"),
    );
    let s1 = sep(); let s2 = sep(); let s3 = sep();
    let file = Submenu::with_items(app, "文件", true, &[
        &n_new, &n_open, &n_save, &n_saveas, &s1, &n_pdf, &n_reload, &s2, &n_close, &s3, &quit,
    ])?;

    let (n_find, n_rep, n_goto) = (mi("find", "查找…"), mi("replace", "替换…"), mi("gotoLine", "跳转到行…"));
    let e1 = sep(); let e2 = sep();
    let edit = Submenu::with_items(app, "编辑", true, &[
        &undo, &redo, &e1, &cut, &copy, &paste, &selall, &e2, &n_find, &n_rep, &n_goto,
    ])?;

    let (n_wys, n_editm, n_prev) = (mi("modeWysiwyg", "所见即所得"), mi("modeEdit", "编辑模式"), mi("modePreview", "预览模式"));
    let (n_layout, n_outline, n_toolbar) = (mi("toggleLayout", "单栏 / 双栏"), mi("toggleOutline", "显示 / 隐藏大纲"), mi("toggleToolbar", "显示 / 隐藏工具栏"));
    let (n_zin, n_zout, n_zreset, n_theme) = (mi("zoomIn", "放大"), mi("zoomOut", "缩小"), mi("zoomReset", "实际大小"), mi("toggleTheme", "切换主题"));
    let v1 = sep(); let v2 = sep(); let v3 = sep();
    let view = Submenu::with_items(app, "视图", true, &[
        &n_wys, &n_editm, &n_prev, &v1, &n_layout, &n_outline, &n_toolbar, &v2,
        &n_zin, &n_zout, &n_zreset, &v3, &n_theme, &fs,
    ])?;

    let (n_fmt, n_sa, n_sd, n_sn, n_dd, n_re, n_tr) = (
        mi("format", "一键格式化"), mi("sortAsc", "按行升序排序"), mi("sortDesc", "按行降序排序"),
        mi("sortNum", "按数字排序"), mi("dedupe", "去除重复行"), mi("removeEmpty", "删除空行"),
        mi("trimLines", "去除首尾空白"),
    );
    let (n_up, n_low, n_ti) = (mi("upper", "转大写"), mi("lower", "转小写"), mi("title", "首字母大写"));
    let (n_tc, n_fc, n_mg) = (mi("textCompare", "文本对比…"), mi("folderCompare", "文件夹对比…"), mi("merge", "三向合并…"));
    let (n_wc, n_enc, n_eol) = (mi("wordCount", "字数统计"), mi("encoding", "文件编码…"), mi("eol", "切换换行符"));
    let t1 = sep(); let t2 = sep(); let t3 = sep(); let t4 = sep();
    let tools = Submenu::with_items(app, "工具", true, &[
        &n_fmt, &t1, &n_sa, &n_sd, &n_sn, &n_dd, &n_re, &n_tr, &t2, &n_up, &n_low, &n_ti,
        &t3, &n_tc, &n_fc, &n_mg, &t4, &n_wc, &n_enc, &n_eol,
    ])?;

    let (n_keys, n_about) = (mi("shortcuts", "快捷键一览"), mi("about", "关于 简单记事本"));
    let help = Submenu::with_items(app, "帮助", true, &[&n_keys, &n_about])?;

    let menu = Menu::with_items(app, &[&file, &edit, &view, &tools, &help])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            save_text_file,
            file_stat,
            list_dir_recursive,
            write_binary_file
        ])
        .setup(|app| {
            install_menu(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let _ = app.emit("menu-command", event.id().0.clone());
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
