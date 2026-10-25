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

/// 列一层目录（不递归）。侧栏文件树按需展开，一次只读一层，
/// 打开一个大仓库也不会先把几万个文件全读进来。
#[tauri::command]
fn read_dir_shallow(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("不是文件夹".into());
    }
    let rd = fs::read_dir(&root).map_err(|e| format!("读取目录失败：{e}"))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        out.push(DirEntryInfo {
            name,
            path: p.to_string_lossy().to_string(),
            is_dir,
            ext,
            size: if is_dir { 0 } else { meta.len() },
            mtime,
        });
    }
    // 目录在前、同类按名字排：和资源管理器一致
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: u32,
    text: String,
}

/// 在整个文件夹里搜文本。放在 Rust 里做是为了不把每个文件都通过 IPC 搬到前端
/// 再丢掉——一个几百个文件的目录走前端搜索会明显卡顿。
/// 跳过二进制（含 NUL 字节）、跳过超大文件、单次最多返回 limit 条。
#[tauri::command]
fn search_in_folder(
    root: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("不是文件夹".into());
    }
    let limit = max_results.unwrap_or(300);
    let mut files = Vec::new();
    walk(&root_path, &mut files, 4000, 0)?;

    let mut hits = Vec::new();
    for f in files {
        if f.size > 4 * 1024 * 1024 {
            continue;
        }
        let bytes = match fs::read(&f.path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.iter().take(8000).any(|b| *b == 0) {
            continue;   // 二进制文件里搜到的「行」没有意义
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: f.path.clone(),
                    name: f.name.clone(),
                    line: (i + 1) as u32,
                    text: line.trim().chars().take(180).collect(),
                });
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}

/// 把一张图片复制到「文档同目录 / assets」下，返回相对路径（assets/xxx.png）。
/// 用相对路径而不是绝对路径，文档连着 assets 一起拷走才还能显示。
/// 同名文件不覆盖，自动加 -1、-2 后缀。
#[tauri::command]
fn copy_image_to_assets(src_path: String, doc_path: String) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err("图片文件不存在".into());
    }
    let doc = PathBuf::from(&doc_path);
    let dir = doc
        .parent()
        .ok_or("文档路径无效")?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 assets 目录失败：{e}"))?;

    let name = src
        .file_name()
        .ok_or("图片文件名无效")?
        .to_string_lossy()
        .to_string();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };

    let mut target = dir.join(&name);
    let mut i = 1;
    while target.exists() {
        target = dir.join(format!("{stem}-{i}{ext}"));
        i += 1;
        if i > 999 {
            return Err("同名图片太多了，换个文件名吧".into());
        }
    }
    fs::copy(&src, &target).map_err(|e| format!("复制图片失败：{e}"))?;

    let file = target
        .file_name()
        .ok_or("目标文件名无效")?
        .to_string_lossy()
        .to_string();
    Ok(format!("assets/{file}"))
}

/// 文件的修改时间（毫秒）。用来发现「磁盘上的文件被别人改过了」：
/// 打开/保存时记下，窗口重新获得焦点时再读一次，不一致就提示。
/// 文件不存在返回 None（不是错误——用户可能刚把它删了）。
#[tauri::command]
fn file_mtime(path: String) -> Result<Option<u64>, String> {
    match fs::metadata(&path) {
        Ok(m) => Ok(m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取文件信息失败：{e}")),
    }
}

/// 把「字节形态」的图片（剪贴板截图、拖进来的 blob）写进 assets/，返回相对路径。
/// 和 copy_image_to_assets 的区别：那边源是磁盘上的文件，这边源是内存里的字节，
/// 所以名字由我们来起（img-<时间戳>），不沿用原文件名。
#[tauri::command]
fn save_image_bytes(doc_path: String, bytes: Vec<u8>, ext: Option<String>) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("图片超过 64 MB，挡住它比较好".into());
    }
    let doc = PathBuf::from(&doc_path);
    let dir = doc
        .parent()
        .ok_or("文档路径无效")?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 assets 目录失败：{e}"))?;

    // 只认这几种扩展名，其余一律按 png 存（剪贴板里的图基本都是 png）
    let ext = match ext.as_deref() {
        Some("jpg") | Some("jpeg") => "jpg",
        Some("gif") => "gif",
        Some("webp") => "webp",
        Some("bmp") => "bmp",
        Some("svg") => "svg",
        _ => "png",
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut name = format!("img-{stamp}.{ext}");
    let mut i = 1;
    while dir.join(&name).exists() {
        name = format!("img-{stamp}-{i}.{ext}");
        i += 1;
        if i > 999 {
            return Err("同名图片太多了，换个文件名吧".into());
        }
    }
    fs::write(dir.join(&name), &bytes).map_err(|e| format!("写入图片失败：{e}"))?;
    Ok(format!("assets/{name}"))
}

/// Windows 11：给无边框窗口套上系统自带的圆角。
/// 走 DWM 原生属性，不需要把窗口设为 transparent —— 圆角之外由系统裁剪，
/// 阴影、拖动缩放全都还是系统那一套。Win10 及更早版本不认识这个属性，
/// 调用会失败（返回错误码），窗口保持直角，不影响任何功能。
#[cfg(target_os = "windows")]
fn apply_rounded_corners(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

    // DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2（Win11 SDK）
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: i32 = 2;

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return };
    let hwnd = win32.hwnd.get() as *mut core::ffi::c_void;

    let pref = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const i32 as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

/// 原生菜单已移除：窗口改为无边框自绘标题栏（decorations=false），
/// 菜单由前端 appmenu.js 渲染，命令仍统一走前端 commands 表。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            save_text_file,
            file_stat,
            list_dir_recursive,
            read_dir_shallow,
            search_in_folder,
            write_binary_file,
            copy_image_to_assets,
            save_image_bytes,
            file_mtime
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                apply_rounded_corners(&w);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, _| {});
}
