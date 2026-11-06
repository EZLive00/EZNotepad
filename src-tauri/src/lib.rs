// EZNotepad - Rust 后端
// 只做网页端做不了的事：原生文件对话框、磁盘读写与编码转换、目录遍历。

mod error;

use error::AppError;
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

/* 严格 UTF-8 校验失败时拿什么兜底，按平台分：
   Windows 中文环境的系统 ANSI 就是 GBK 系，GB18030 是对的；
   macOS / Linux 上一个非法 UTF-8 文件更可能是 Latin-1 或二进制误判，
   继续按 GB18030 解会解出「看起来像中文的乱码」—— 用户看不出异常，
   一保存就把原文件覆盖了。windows-1252 是 Latin-1 超集，永不失败，
   而且状态栏会显示当前编码，用户可以用「以…编码重新打开」纠正。 */
#[cfg(target_os = "windows")]
fn fallback_decode(bytes: &[u8]) -> (String, &'static str) {
    let (s, _, _) = encoding_rs::GB18030.decode(bytes);
    (s.into_owned(), "GBK")
}

#[cfg(not(target_os = "windows"))]
fn fallback_decode(bytes: &[u8]) -> (String, &'static str) {
    let (s, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    (s.into_owned(), "WINDOWS-1252")
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
    // 严格校验 UTF-8，失败交给按平台选的兜底编码（见 fallback_decode）
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "UTF-8".into(), false),
        Err(_) => {
            let (s, enc) = fallback_decode(bytes);
            (s, enc.into(), false)
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

/// 只取文件大小。对比窗口在读入之前先判上限：几百 MB 的文件读进内存再放弃，
/// 代价比一次 metadata 调用高得多。
#[tauri::command]
fn file_size(path: String) -> Result<u64, AppError> {
    let meta = fs::metadata(&path).map_err(|e| AppError::detail("io.stat", e))?;
    if meta.is_dir() {
        return Err(AppError::new("file.is_dir"));
    }
    Ok(meta.len())
}

#[tauri::command]
fn read_text_file(path: String, encoding: Option<String>) -> Result<ReadResult, AppError> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| AppError::detail("io.read", e))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(AppError::new("file.binary"));
    }
    let (content, encoding, bom) = match encoding.as_deref() {
        Some(enc) => {
            let has_bom = bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
            let body: &[u8] = if has_bom { &bytes[3..] } else { &bytes[..] };
            let cs = match enc {
                "GBK" => encoding_rs::GB18030,
                "WINDOWS-1252" => encoding_rs::WINDOWS_1252,
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
fn save_text_file(opts: SaveOptions) -> Result<String, AppError> {
    let p = PathBuf::from(&opts.path);
    if let Some(dir) = p.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            fs::create_dir_all(dir).map_err(|e| AppError::detail("io.mkdir", e))?;
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
        "WINDOWS-1252" => {
            let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode(&opts.content);
            out.extend_from_slice(&bytes);
        }
        "GBK" => {
            let (bytes, _, _) = encoding_rs::GB18030.encode(&opts.content);
            out.extend_from_slice(&bytes);
            if out.len() > 512 * 1024 * 1024 {
                return Err(AppError::new("file.too_large"));
            }
        }
        _ => out.extend_from_slice(opts.content.as_bytes()),
    }
    fs::write(&p, &out).map_err(|e| AppError::detail("io.save", e))?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn file_stat(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&path).is_dir())
}

/* ---------------- 文件树写操作 ----------------
   只接受**单层名字**：路径分隔符一律拒绝，免得前端传个 "../.." 就把操作范围
   伸到工作目录外面。删除走系统回收站，误点了还能捞回来。 */

#[cfg(target_os = "windows")]
fn illegal_name_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
}

#[cfg(not(target_os = "windows"))]
fn illegal_name_char(c: char) -> bool {
    c == ':' || c == '\0'
}

fn check_simple_name(name: &str) -> Result<String, AppError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::new("name.empty"));
    }
    if n.contains('/') || n.contains('\\') || n == "." || n == ".." {
        return Err(AppError::new("name.path_sep"));
    }
    if n.chars().any(illegal_name_char) {
        return Err(AppError::new("name.invalid_chars"));
    }
    Ok(n.to_string())
}

/// 在 parent 下新建空文件或空目录，返回新条目的完整路径
#[tauri::command]
fn create_entry(parent: String, name: String, dir: bool) -> Result<String, AppError> {
    let parent = PathBuf::from(&parent);
    if !parent.is_dir() {
        return Err(AppError::new("dir.missing"));
    }
    let name = check_simple_name(&name)?;
    let p = parent.join(&name);
    if p.exists() {
        return Err(AppError::var("entry.exists", "name", &name));
    }
    if dir {
        fs::create_dir(&p)
    } else {
        fs::write(&p, b"")
    }
    .map_err(|e| AppError::detail("io.create", e))?;
    Ok(p.to_string_lossy().to_string())
}

/// 原地改名（父目录不变），返回新路径
#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<String, AppError> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(AppError::new("entry.missing"));
    }
    let name = check_simple_name(&new_name)?;
    let parent = src.parent().ok_or_else(|| AppError::new("entry.no_parent"))?;
    let dst = parent.join(&name);
    if dst == src {
        return Ok(path);
    }
    if dst.exists() {
        return Err(AppError::var("entry.exists", "name", &name));
    }
    fs::rename(&src, &dst).map_err(|e| AppError::detail("io.rename", e))?;
    Ok(dst.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn delete_file_impl(p: &Path) -> Result<(), AppError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, SHFILEOPSTRUCTW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI,
        FOF_SILENT, FO_DELETE,
    };

    let mut from: Vec<u16> = p.as_os_str().encode_wide().collect();
    from.push(0);
    from.push(0); // 双 NUL 结尾，这是 SHFileOperationW 的硬要求
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI) as u16;
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(AppError::detail("recycle.failed", format!("Win32 error {rc}")));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err(AppError::new("op.cancelled"));
    }
    Ok(())
}

/// 非 Windows：走系统废纸篓。`trash` 在 macOS 调 NSFileManager.trashItemAtURL，
/// 会一并写好「放回原处」的元数据；直接 rename 到 ~/.Trash 会丢这份元数据，
/// 而且在新系统上有 TCC 权限问题。界面上这个动作叫「删除（进回收站）」，
/// 悄悄改成永久删除是不能接受的。
#[cfg(not(target_os = "windows"))]
fn delete_file_impl(p: &Path) -> Result<(), AppError> {
    trash::delete(p).map_err(|e| AppError::detail("recycle.failed", e))
}

/// 删除文件（进回收站）或空目录
#[tauri::command]
fn delete_entry(path: String) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::new("entry.missing"));
    }
    if p.is_dir() {
        // 目录只删空的：递归删除风险太大，让人先在里面清干净
        return fs::remove_dir(&p).map_err(|e| AppError::detail("dir.not_empty", e));
    }
    delete_file_impl(&p)
}

/// 启动参数里带的文件（双击 .md 时系统会把路径塞进来）
fn file_args(argv: &[String]) -> Vec<String> {
    // `--compare a.md b.md`：这两个是给对比窗口的，主窗口别再各开一个标签
    let mut skip = (usize::MAX, usize::MAX);
    if let Some(p) = argv.iter().position(|a| a == "--compare") {
        skip = (p + 1, p + 2);
    }
    argv.iter()
        .enumerate()
        .skip(1) // argv[0] 是 exe 自己
        .filter(|(i, _)| *i != skip.0 && *i != skip.1)
        .filter(|(_, a)| !a.starts_with('-') && Path::new(a).is_file())
        .map(|(_, a)| a.clone())
        .collect()
}

/// `--compare 左 右`：直接开对比窗口，不开主窗口（命令行 / 快捷方式用）
fn compare_args(argv: &[String]) -> Option<(Option<String>, Option<String>)> {
    let p = argv.iter().position(|a| a == "--compare")?;
    let at = |i: usize| argv.get(i).filter(|a| Path::new(a).is_file()).cloned();
    let left = at(p + 1);
    let right = at(p + 2);
    if left.is_none() && right.is_none() {
        return None;
    }
    Some((left, right))
}

/* macOS 的「双击 .md 打开」不走 argv：LaunchServices 发 Apple Event，
   RunEvent::Opened 里才有 URL，而且冷启动时可能早于前端监听器注册。
   两条路按「前端来取过没有」互斥：没来过就暂存，来过了直接 emit，
   同一个文件不会被开两次。前端的 initial_files() 那次调用正是就绪信号，
   所以业务层一行都不用改。 */
#[derive(Default)]
struct OpenedFiles {
    pending: std::sync::Mutex<Vec<String>>,
    ready: std::sync::atomic::AtomicBool,
}

static EXIT_ALLOWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn initial_files(app: tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<OpenedFiles>();
    state.ready.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut files = file_args(&std::env::args().collect::<Vec<_>>());
    if let Ok(mut g) = state.pending.lock() {
        for p in g.drain(..) {
            if !files.contains(&p) {
                files.push(p);
            }
        }
    }
    files
}

/* ⌘Q 走应用级退出，不经过窗口的 onCloseRequested，未保存的标签会被绕过。
   Rust 先拦下来问前端，前端跑完同一套守卫后再调这个命令放行。
   不这么做的话 app.exit() 会再次触发 ExitRequested，形成死循环。 */
#[tauri::command]
fn confirm_app_exit(app: tauri::AppHandle) {
    EXIT_ALLOWED.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/// 两两比对文件内容，返回同长度的「是否逐字节相同」。
///
/// 为什么必须读内容：文件夹对比原先只看「大小 + 修改时间」。大小一样、时间
/// 又挨着的一对文件，改过也会被判成「相同」—— 而界面上「只看差异」默认是勾着
/// 的，等于把改动藏起来。常见得离谱：把「一」改成「二」、把 3 改成 5，字节数
/// 一模一样。
///
/// 一次 IPC 拿走整批，逐块读、一旦不同立刻返回：内容真一样时是唯一要把两个
/// 文件都读完的情况，其余绝大多数在第一个不同的块就停了。
#[tauri::command]
fn compare_file_pairs(pairs: Vec<(String, String)>) -> Vec<bool> {
    pairs
        .into_iter()
        .map(|(a, b)| files_equal(Path::new(&a), Path::new(&b)).unwrap_or(false))
        .collect()
}

fn files_equal(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut fa = fs::File::open(a)?;
    let mut fb = fs::File::open(b)?;
    if fa.metadata()?.len() != fb.metadata()?.len() {
        return Ok(false);
    }
    let mut ba = vec![0u8; 256 * 1024];
    let mut bb = vec![0u8; 256 * 1024];
    loop {
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
        if ba[..na] != bb[..nb] {
            return Ok(false);
        }
    }
}

/// 一次 read 可能只回来几个字节（网络盘、被别的进程写着的文件），读到满或 EOF
fn read_full(f: &mut fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(n)
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
fn list_dir_recursive(path: String, max_files: Option<usize>) -> Result<Vec<DirEntryInfo>, AppError> {
    let limit = max_files.unwrap_or(20000);
    let mut out = Vec::new();
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::new("dir.not_folder"));
    }
    walk(&root, &mut out, limit, 0)?;
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<DirEntryInfo>, limit: usize, depth: usize) -> Result<(), AppError> {
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
fn read_dir_shallow(path: String) -> Result<Vec<DirEntryInfo>, AppError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::new("dir.not_folder"));
    }
    let rd = fs::read_dir(&root).map_err(|e| AppError::detail("dir.read", e))?;
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
/// regex=true 时按正则匹配（写错会直接报错，不静默返回空）。
#[tauri::command]
fn search_in_folder(
    root: String,
    query: String,
    max_results: Option<usize>,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchHit>, AppError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let cs = case_sensitive.unwrap_or(false);
    let pat = if regex.unwrap_or(false) {
        Some(regex::Regex::new(&query).map_err(|e| AppError::detail("regex.invalid", e))?)
    } else {
        None
    };
    let needle = query.to_lowercase();
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(AppError::new("dir.not_folder"));
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
            let hit = match &pat {
                Some(p) => p.is_match(line),
                None => if cs { line.contains(&query) } else { line.to_lowercase().contains(&needle) },
            };
            if hit {
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
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<String, AppError> {
    fs::write(&path, &bytes).map_err(|e| AppError::detail("io.write", e))?;
    Ok(path)
}

/* 导出单文件 HTML 时把图片内嵌成 data URI：不内嵌的话，
   另存到别处就只剩一堆断链。手写编码，省一个依赖。 */
fn b64_encode(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = ((chunk[0] as u32) << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 读二进制文件转 base64（导出 HTML 内嵌图片用）。超限直接报错，不静默截断。
#[tauri::command]
fn read_file_base64(path: String, max_bytes: Option<usize>) -> Result<String, AppError> {
    let p = PathBuf::from(&path);
    let size = fs::metadata(&p)
        .map_err(|e| AppError::detail("io.read", e))?
        .len() as usize;
    let limit = max_bytes.unwrap_or(4 * 1024 * 1024);
    if size > limit {
        return Err(AppError::var("image.too_large_embed", "mb", limit / 1024 / 1024));
    }
    let bytes = fs::read(&p).map_err(|e| AppError::detail("io.read", e))?;
    Ok(b64_encode(&bytes))
}

/// 把一张图片复制到「文档同目录 / assets」下，返回相对路径（assets/xxx.png）。
/// 用相对路径而不是绝对路径，文档连着 assets 一起拷走才还能显示。
/// 同名文件不覆盖，自动加 -1、-2 后缀。
#[tauri::command]
fn copy_image_to_assets(src_path: String, doc_path: String) -> Result<String, AppError> {
    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err(AppError::new("image.missing"));
    }
    let doc = PathBuf::from(&doc_path);
    let dir = doc
        .parent()
        .ok_or_else(|| AppError::new("path.invalid"))?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| AppError::detail("dir.assets", e))?;

    let name = src
        .file_name()
        .ok_or_else(|| AppError::new("image.name_invalid"))?
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
            return Err(AppError::new("image.too_many"));
        }
    }
    fs::copy(&src, &target).map_err(|e| AppError::detail("io.copy", e))?;

    let file = target
        .file_name()
        .ok_or_else(|| AppError::new("image.target_invalid"))?
        .to_string_lossy()
        .to_string();
    Ok(format!("assets/{file}"))
}

/// 文件的修改时间（毫秒）。用来发现「磁盘上的文件被别人改过了」：
/// 打开/保存时记下，窗口重新获得焦点时再读一次，不一致就提示。
/// 文件不存在返回 None（不是错误——用户可能刚把它删了）。
#[tauri::command]
fn file_mtime(path: String) -> Result<Option<u64>, AppError> {
    match fs::metadata(&path) {
        Ok(m) => Ok(m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::detail("file.stat", e)),
    }
}

/// 把「字节形态」的图片（剪贴板截图、拖进来的 blob）写进 assets/，返回相对路径。
/// 和 copy_image_to_assets 的区别：那边源是磁盘上的文件，这边源是内存里的字节，
/// 所以名字由我们来起（img-<时间戳>），不沿用原文件名。
#[tauri::command]
fn save_image_bytes(doc_path: String, bytes: Vec<u8>, ext: Option<String>) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Err(AppError::new("image.empty"));
    }
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(AppError::new("image.too_large_clip"));
    }
    let doc = PathBuf::from(&doc_path);
    let dir = doc
        .parent()
        .ok_or_else(|| AppError::new("path.invalid"))?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| AppError::detail("dir.assets", e))?;

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
            return Err(AppError::new("image.too_many"));
        }
    }
    fs::write(dir.join(&name), &bytes).map_err(|e| AppError::detail("io.write_image", e))?;
    Ok(format!("assets/{name}"))
}

/* ---------------- 本地历史 ----------------
   每保存一次，就把**保存前**的内容留一份在应用数据目录里。
   自动保存、一键格式化、排序去重、批量替换之后想反悔，Ctrl+Z 已经翻不回去了，
   这是最后一道。快照只写不读原文件，回滚永远是「开成新标签 / 写回编辑器」，
   绝不直接覆盖磁盘。 */

#[derive(Serialize)]
struct HistoryEntry {
    path: String,
    time: u64,
    size: u64,
}

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn history_dir(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::detail("appdata.missing", e))?;
    Ok(base.join("history").join(format!("{:016x}", fnv1a(path))))
}

/// 留一份快照。内容和最新那份一样时直接跳过，不制造一堆重复。
fn write_history_snapshot(app: &tauri::AppHandle, path: &str, content: &str) -> Result<(), AppError> {
    if content.is_empty() {
        return Ok(());
    }
    let dir = history_dir(app, path)?;
    fs::create_dir_all(&dir).map_err(|e| AppError::detail("dir.history", e))?;
    // 记下来源文件名，方便在文件夹里认
    let _ = fs::write(
        dir.join("name.txt"),
        Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    );

    let mut snaps: Vec<(u64, PathBuf)> = fs::read_dir(&dir)
        .map_err(|e| AppError::detail("dir.history_read", e))?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            let ts: u64 = name.strip_suffix(".txt")?.parse().ok()?;
            if ts == 0 {
                return None;
            }
            Some((ts, p))
        })
        .collect();
    snaps.sort_by(|a, b| b.0.cmp(&a.0));

    // 和最新那份一模一样就不存了（自动保存会反复触发）
    if let Some((_, newest)) = snaps.first() {
        if let Ok(prev) = fs::read_to_string(newest) {
            if prev == content {
                return Ok(());
            }
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    fs::write(dir.join(format!("{stamp}.txt")), content.as_bytes())
        .map_err(|e| AppError::detail("io.history_write", e))?;

    // 只留最近 60 份，再按总量 20MB 兜一道
    snaps.insert(0, (stamp, dir.join(format!("{stamp}.txt"))));
    let mut total: u64 = 0;
    for (i, (_, p)) in snaps.iter().enumerate() {
        let size = fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        total += size;
        if i >= 60 || total > 20 * 1024 * 1024 {
            let _ = fs::remove_file(p);
        }
    }
    Ok(())
}

#[tauri::command]
fn save_history(app: tauri::AppHandle, path: String, content: String) -> Result<(), AppError> {
    write_history_snapshot(&app, &path, &content)
}

#[tauri::command]
fn list_history(app: tauri::AppHandle, path: String) -> Result<Vec<HistoryEntry>, AppError> {
    let dir = history_dir(&app, &path)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<HistoryEntry> = fs::read_dir(&dir)
        .map_err(|e| AppError::detail("dir.history_read", e))?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            let ts: u64 = name.strip_suffix(".txt")?.parse().ok()?;
            if ts == 0 { return None; }
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            Some(HistoryEntry { path: p.to_string_lossy().to_string(), time: ts, size })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    Ok(out)
}

#[tauri::command]
fn read_history(path: String) -> Result<String, AppError> {
    let bytes = fs::read(&path).map_err(|e| AppError::detail("io.snapshot", e))?;
    let (text, _, _) = decode_bytes(&bytes);
    Ok(text)
}

/// 清掉某个文件的全部历史（用户主动「清除历史」时用）
#[tauri::command]
fn clear_history(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let dir = history_dir(&app, &path)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| AppError::detail("io.history_clear", e))?;
    }
    Ok(())
}

/// 速记文件的位置：固定在应用数据目录里，跟着应用走，不跟着文档走。
///
/// 「固定」是功能的一半：速记不需要用户选位置、也不需要保存对话框，
/// 关掉软件再打开还是同一份内容。
///
/// 环境变量 `EZNOTEPAD_QUICKNOTE` 可以把路径整个换掉。真机探针必须用它 ——
/// 探针会往速记里打字，绝不能碰用户真正的那份笔记（那是用户的私有内容，
/// 覆盖掉无从恢复）。
#[tauri::command]
fn quick_note_path(app: tauri::AppHandle) -> Result<String, AppError> {
    if let Ok(raw) = std::env::var("EZNOTEPAD_QUICKNOTE") {
        let p = raw.trim();
        if !p.is_empty() {
            if let Some(dir) = Path::new(p).parent() {
                fs::create_dir_all(dir).map_err(|e| AppError::detail("io.mkdir", e))?;
            }
            return Ok(p.to_string());
        }
    }
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::detail("appdata.missing", e))?;
    fs::create_dir_all(&base).map_err(|e| AppError::detail("io.mkdir", e))?;
    Ok(base.join("quicknote.md").to_string_lossy().to_string())
}

/* ---------------- 文件变化监听 ----------------
   设计原则是「尽量少看」：只监听已打开文档所在的**那一层目录**（非递归），
   事件到达时先拿文件名去比对，不在名单里的直接丢掉。
   所以在一个有几万文件的目录里打开一个 md，也不会有事件涌到前端；
   底层是系统的 ReadDirectoryChangesW / inotify，空闲时不占 CPU。 */

/// 当前活着的 watcher。换成新的时旧的自动 drop（监听句柄随之释放）。
struct WatchState(std::sync::Mutex<Option<notify::RecommendedWatcher>>);

/// 让 Rust 侧重新布置监听：传进来的是所有「已存在磁盘上」的文档路径。
/// 返回真正被监听的目录数（纯粹给前端记日志，不影响功能）。
#[tauri::command]
fn watch_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<usize, AppError> {
    use notify::{RecursiveMode, Watcher};
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;

    // 1. 先撤掉旧的监听
    *state.0.lock().map_err(|_| AppError::new("state.lock"))? = None;
    if paths.is_empty() {
        return Ok(0);
    }

    // 2. 关心的文件名（小写）→ 原始完整路径。
    //    Windows 大小写不敏感，事件里给的名字大小写未必和打开时一致，所以统一降为小写比对。
    let mut wanted: HashMap<String, String> = HashMap::new();
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    for p in &paths {
        let pb = PathBuf::from(p);
        let Some(name) = pb.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { continue };
        wanted.insert(name, p.clone());
        if let Some(d) = pb.parent() {
            dirs.insert(d.to_path_buf());
        }
    }
    if dirs.is_empty() {
        return Ok(0);
    }

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        // 读文件也会产生 Access 事件（我们自己读一遍就算），只看内容真的变了的那几种
        if !matches!(
            ev.kind,
            notify::EventKind::Modify(_) | notify::EventKind::Create(_) | notify::EventKind::Remove(_)
        ) {
            return;
        }
        let mut hit: Vec<String> = Vec::new();
        for p in &ev.paths {
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { continue };
            if let Some(orig) = wanted.get(&name) {
                if !hit.contains(orig) {
                    hit.push(orig.clone());
                }
            }
        }
        if !hit.is_empty() {
            // 一次写入可能拆成好几个事件（>4KB 的包），去重和合并交给前端做
            let _ = app.emit("fs-change", hit);
        }
    })
    .map_err(|e| AppError::detail("watch.create", e))?;

    // 3. 每个目录只监听一层。目录不存在（文件已被删）就跳过，不是错误
    let mut n = 0;
    for d in &dirs {
        if watcher.watch(d, RecursiveMode::NonRecursive).is_ok() {
            n += 1;
        }
    }

    *state.0.lock().map_err(|_| AppError::new("state.lock"))? = Some(watcher);
    Ok(n)
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

/* ---------------- 对比窗口 ----------------
   文本对比要独占屏幕：两栏并排 + 预览条，塞在主窗口的浮层里永远不够宽。
   所以单独开一个窗口，主窗口不用管它，关掉就没了。

   左右路径不走 URL 传递：中文路径要转义、Tauri 的 App 协议还会再编码一次，
   两边对不上就会出现「打开的文件不存在」。改成进程内挂一个待取请求，
   新窗口加载完主动取一次。 */

#[derive(Default)]
struct CompareRequest(std::sync::Mutex<Option<(Option<String>, Option<String>)>>);

#[derive(Serialize, Clone)]
struct ComparePayload {
    left: Option<String>,
    right: Option<String>,
}

#[tauri::command]
async fn open_compare_window(
    app: tauri::AppHandle,
    left: Option<String>,
    right: Option<String>,
) -> Result<(), AppError> {
    // 必须是 async 命令。同步命令由 Tauri 在主线程上执行，而建窗口时要等
    // WebView2 那边回调，得让主线程继续转 —— 主线程被自己占着，build() 就
    // 卡在那儿不返回：窗口壳子出来了（标题、尺寸都对），页面永远不加载，
    // 整扇窗子停在纯白，连 <title> 里的静态文字都不显示（实测，日志停在
    // "building" 之后再无下文）。async 命令跑在运行时线程上，主线程继续转，
    // 一切正常。命令行 --compare 走的是 setup()，天生不受这个影响。
    spawn_compare_window(&app, left, right)
}

fn spawn_compare_window(
    app: &tauri::AppHandle,
    left: Option<String>,
    right: Option<String>,
) -> Result<(), AppError> {
    use tauri::{Emitter, Manager};

    // 已经开着就复用：把新的一对文件推过去，而不是再开一个窗口
    if let Some(w) = app.get_webview_window("compare") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("compare:load", ComparePayload { left, right });
        return Ok(());
    }

    let state = app.state::<CompareRequest>();
    *state.0.lock().map_err(|_| AppError::new("state.lock"))? = Some((left, right));

    create_tool_window(app, "compare", "compare.html", "文本对比", 760.0, 460.0)
}

/* 工具窗口（文本对比 / 文件夹对比）共用同一套建窗：无边框、铺满工作区、
   同一组浏览器参数、同一个收尾流程。两处各抄一遍的话，改一个忘一个。 */
fn create_tool_window(
    app: &tauri::AppHandle,
    label: &'static str,
    page: &str,
    title: &str,
    min_w: f64,
    min_h: f64,
) -> Result<(), AppError> {
    use tauri::Manager;

    // 出生尺寸就按工作区给：后面的 SetWindowPos 只是把「DWM 隐形边框」那几像素
    // 也吃掉，不能指望它单独完成铺满（见 fill_work_area 的注释）
    //
    // 屏幕取**主窗口所在的那块**：用户在副屏上点「对比」，窗口跑到主屏去，
    // 等于让他自己再把窗口拖回来。注意 builder 收的是逻辑像素。
    #[cfg(target_os = "windows")]
    let screen = app
        .get_webview_window("main")
        .and_then(|w| raw_hwnd(&w))
        .and_then(screen_of)
        .unwrap_or_else(primary_screen);
    #[cfg(target_os = "windows")]
    let (bx, by, bw, bh) = screen.logical();
    #[cfg(not(target_os = "windows"))]
    let (bw, bh) = (1280f64, 860f64);

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(page.into()))
            .title(title)
            .inner_size(bw, bh)
            .min_inner_size(min_w, min_h)
            .decorations(false)
            .shadow(true)
            .visible(true);

    #[cfg(target_os = "windows")]
    { builder = builder.position(bx, by); }
    #[cfg(not(target_os = "windows"))]
    { builder = builder.center(); }
    /* 前端工具窗口的 filled 初值是 true（按钮显示「还原」），出生就得是最大化态。
       macOS 有原生最大化，不需要 Win32 那套 DWM 隐形边框补偿。 */
    #[cfg(target_os = "macos")]
    { builder = builder.maximized(true); }

    // 页面加载完再补一次：tao 应用 inner_size 比我们晚，第一次铺满可能被顶回来
    let app_load = app.clone();
    builder = builder.on_page_load(move |_w, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            #[cfg(target_os = "windows")]
            fill_work_area_when_ready(app_load.clone(), label);
        }
    });

    // 和主窗口用同一组浏览器参数：GPU 沙箱崩溃的问题在这里一样会犯
    #[cfg(target_os = "windows")]
    {
        builder = builder.additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox",
        );
    }

    let win = builder.build().map_err(|e| AppError::detail("win.create", e))?;
    #[cfg(target_os = "windows")]
    {
        apply_rounded_corners(&win);
        // 先把矩形摆好（此时还不可见），页面加载完那一轮再收个尾
        fill_work_area_when_ready(app.clone(), label);
    }
    Ok(())
}

/* ---------------- 文件夹对比窗口 ----------------
   以前它挤在主窗口的浮层里，只列一栏「状态 / 路径 / 大小」—— 看不出左右两侧
   各自是什么，也点不进两侧目录。改成独立窗口后左右各列自己那一侧的文件。 */
#[derive(Default)]
struct FolderCompareRequest(std::sync::Mutex<Option<(Option<String>, Option<String>)>>);

#[derive(Serialize, Clone)]
struct FolderComparePayload {
    left: Option<String>,
    right: Option<String>,
}

#[tauri::command]
async fn open_folder_compare_window(
    app: tauri::AppHandle,
    left: Option<String>,
    right: Option<String>,
) -> Result<(), AppError> {
    // 同 open_compare_window：必须 async，否则主线程被自己占住，页面永远不加载
    spawn_folder_compare_window(&app, left, right)
}

fn spawn_folder_compare_window(
    app: &tauri::AppHandle,
    left: Option<String>,
    right: Option<String>,
) -> Result<(), AppError> {
    use tauri::{Emitter, Manager};

    if let Some(w) = app.get_webview_window("foldercmp") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("foldercmp:load", FolderComparePayload { left, right });
        return Ok(());
    }

    let state = app.state::<FolderCompareRequest>();
    *state.0.lock().map_err(|_| AppError::new("state.lock"))? = Some((left, right));

    create_tool_window(app, "foldercmp", "foldercmp.html", "文件夹对比", 720.0, 420.0)
}

/// 从工具窗口把文件交回主窗口打开。走的是主窗口已有的 `open-files` 事件
/// （单实例那条路也是它），不另开一条通道。
#[tauri::command]
fn open_in_main(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    use tauri::{Emitter, Manager};
    let Some(w) = app.get_webview_window("main") else {
        return Err(AppError::new("win.main_missing"));
    };
    let _ = w.unminimize();
    let _ = w.set_focus();
    w.emit("open-files", vec![path]).map_err(|e| AppError::detail("app.emit", e))
}

/// 新窗口加载完取走待处理的文件夹对比请求（取一次就清空）
#[tauri::command]
fn take_folder_compare_request(app: tauri::AppHandle) -> FolderComparePayload {
    use tauri::Manager;
    let state = app.state::<FolderCompareRequest>();
    let taken = state.0.lock().ok().and_then(|mut g| g.take());
    match taken {
        Some((left, right)) => FolderComparePayload { left, right },
        None => FolderComparePayload { left: None, right: None },
    }
}

/// 新窗口加载完取走待处理的对比请求（取一次就清空）
#[tauri::command]
fn take_compare_request(app: tauri::AppHandle) -> ComparePayload {
    use tauri::Manager;
    let state = app.state::<CompareRequest>();
    let taken = state
        .0
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    match taken {
        Some((left, right)) => ComparePayload { left, right },
        None => ComparePayload { left: None, right: None },
    }
}

/// 取窗口句柄并直接改窗口矩形。Windows 上无边框窗口（WS_POPUP）没法靠
/// maximize() 完成铺满，只能自己算矩形。
#[cfg(target_os = "windows")]
fn set_window_rect(window: &tauri::WebviewWindow, x: i32, y: i32, w: i32, h: i32) -> bool {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
    };

    let Ok(handle) = window.window_handle() else { return false };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return false };
    let hwnd = win32.hwnd.get() as *mut core::ffi::c_void;
    if hwnd.is_null() {
        return false;
    }
    unsafe {
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
    }
    true
}

/// 一块屏幕的可用区域（物理像素，已减掉任务栏）以及这块屏的 DPI 缩放。
///
/// 为什么不再用 `SystemParametersInfoW(SPI_GETWORKAREA)`：那个 API 只认**主屏**。
/// 多屏机器上主程序在副屏时，对比窗口依然出生在主屏；拖到副屏再点最大化，
/// 又被一把拽回主屏 —— 用户看到的就是「窗口总在别的屏幕上，放大也不对」。
#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct Screen {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    scale: f64,
}

#[cfg(target_os = "windows")]
impl Screen {
    /// 窗口构建用的是逻辑像素（Tauri 的 `position` / `inner_size` 都是逻辑单位），
    /// 这里换算一次。不换算的话，150% 缩放的屏幕上窗口会生出来就有 1.5 倍大。
    fn logical(&self) -> (f64, f64, f64, f64) {
        let s = if self.scale > 0.1 { self.scale } else { 1.0 };
        (self.x as f64 / s, self.y as f64 / s, self.w as f64 / s, self.h as f64 / s)
    }
}

/// 窗口所在显示器的工作区。`MONITOR_DEFAULTTONEAREST`：窗口跨两块屏时取
/// 交叠面积更大的那块 —— 正是用户心理上「这个窗口在哪块屏上」的判断。
#[cfg(target_os = "windows")]
fn screen_of(hwnd: *mut core::ffi::c_void) -> Option<Screen> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    if hwnd.is_null() {
        return None;
    }
    let mon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if mon.is_null() {
        return None;
    }
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(mon, &mut info) } == 0 {
        return None;
    }
    let RECT { left, top, right, bottom } = info.rcWork;
    if right <= left || bottom <= top {
        return None;
    }
    Some(Screen {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
        scale: dpi_scale(hwnd),
    })
}

/// 主屏工作区，只在拿不到窗口句柄时兜底（正常路径一定先问窗口自己）。
#[cfg(target_os = "windows")]
fn primary_screen() -> Screen {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};

    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut core::ffi::c_void, 0)
    };
    if ok == 0 || r.right <= r.left || r.bottom <= r.top {
        return Screen { x: 0, y: 0, w: 1920, h: 1080, scale: 1.0 };
    }
    Screen {
        x: r.left,
        y: r.top,
        w: r.right - r.left,
        h: r.bottom - r.top,
        scale: dpi_scale(std::ptr::null_mut()),
    }
}

#[cfg(target_os = "windows")]
fn dpi_scale(hwnd: *mut core::ffi::c_void) -> f64 {
    use windows_sys::Win32::UI::HiDpi::{GetDpiForSystem, GetDpiForWindow};

    let mut dpi = 0u32;
    if !hwnd.is_null() {
        dpi = unsafe { GetDpiForWindow(hwnd) };
    }
    if dpi == 0 {
        dpi = unsafe { GetDpiForSystem() };
    }
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// 某个窗口所在屏幕的工作区。取不到就退回主屏。
#[cfg(target_os = "windows")]
fn work_area_of(window: &tauri::WebviewWindow) -> Screen {
    raw_hwnd(window).and_then(screen_of).unwrap_or_else(primary_screen)
}

/// 把窗口铺满「它自己所在那块屏」的工作区（屏幕减去任务栏）。
///
/// 为什么不用 maximize()：tao 的 `WindowState` 在窗口还没 VISIBLE 时会把
/// MAXIMIZED 标志位写成 true，却跳过 `ShowWindow(SW_MAXIMIZE)`，之后任何
/// maximize 都因为「标志位没变化」被直接忽略。实测 builder / 建完立刻 /
/// 页面加载完三种时序窗口都停在 1280x860。这里完全绕开 tao 的窗口状态。
///
/// 尺寸按「可见那圈」对齐：Windows 给带阴影的无边框窗口留了一圈透明边
/// （GetWindowRect 比看得见的范围大 8px 左右），系统最大化时这圈是溢出到屏幕
/// 外的。所以这里把窗口矩形按隐形边扩出去，让内容正好贴住工作区。
#[cfg(target_os = "windows")]
fn fill_work_area(window: &tauri::WebviewWindow) -> bool {
    let screen = work_area_of(window);
    let (l, t, r, b) = frame_insets(window);
    set_window_rect(window, screen.x - l, screen.y - t, screen.w + l + r, screen.h + t + b)
}

/// 隐形边框厚度：(左, 上, 右, 下)。量不出来就当 0。
#[cfg(target_os = "windows")]
fn frame_insets(window: &tauri::WebviewWindow) -> (i32, i32, i32, i32) {
    let Some((ox, oy, ow, oh)) = outer_rect(window) else { return (0, 0, 0, 0) };
    let Some((vx, vy, vw, vh)) = visible_rect(window) else { return (0, 0, 0, 0) };
    let l = vx - ox;
    let t = vy - oy;
    let r = (ox + ow) - (vx + vw);
    let b = (oy + oh) - (vy + vh);
    // 离谱值（还没画出来时 DWM 会返回 0 矩形）直接放弃，别把窗口撑飞
    if !(0..=40).contains(&l) || !(0..=40).contains(&t) || !(0..=40).contains(&r) || !(0..=40).contains(&b) {
        return (0, 0, 0, 0);
    }
    (l, t, r, b)
}

/// 读窗口矩形（含隐形边框），用来核对 SetWindowPos 到底生没生效
#[cfg(target_os = "windows")]
fn outer_rect(window: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = raw_hwnd(window)?;
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
        return None;
    }
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

/// 读「看得见的那圈」矩形，取不到就退回 GetWindowRect
#[cfg(target_os = "windows")]
fn visible_rect(window: &tauri::WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::DwmGetWindowAttribute;

    // DWMWA_EXTENDED_FRAME_BOUNDS = 9
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    let hwnd = raw_hwnd(window)?;
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if hr < 0 || r.right <= r.left || r.bottom <= r.top {
        return outer_rect(window);
    }
    Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
}

#[cfg(target_os = "windows")]
fn raw_hwnd(window: &tauri::WebviewWindow) -> Option<*mut core::ffi::c_void> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?;
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return None };
    let hwnd = win32.hwnd.get() as *mut core::ffi::c_void;
    if hwnd.is_null() {
        None
    } else {
        Some(hwnd)
    }
}

/// 从命令里建窗口时，`build()` 返回的句柄对应的原生窗口可能还没创建出来
/// （创建被排到事件循环里），这时 window_handle() 拿不到 HWND，铺满会静默失败。
/// 而且 tao 把 builder 上的 inner_size 应用得比我们晚 —— 从菜单打开时实测，
/// SetWindowPos 明明已经改成 1860x973，稍后又被 inner_size 顶回 1876x982。
/// 所以这里不认「一次成功」，要看到连续几次观测都是工作区尺寸才收工；
/// 每次真正动手都丢回主线程执行，跨线程改别人的窗口容易碰上消息泵的时序问题。
///
/// 「工作区尺寸」每轮都按窗口**当时所在那块屏**重新算：拿主屏尺寸去比副屏上的
/// 窗口永远对不上，于是这轮循环会把窗口反复拽回主屏尺寸 —— 也就是拖到副屏后
/// 一按最大化就出错的那个现象。
#[cfg(target_os = "windows")]
fn fill_work_area_when_ready(app: tauri::AppHandle, label: &'static str) {
    use std::sync::mpsc;
    use std::time::Duration;

    std::thread::spawn(move || {
        let mut streak = 0;
        for _ in 0..40u32 {
            let (tx, rx) = mpsc::channel();
            let a = app.clone();
            let queued = app.run_on_main_thread(move || {
                use tauri::Manager;
                let out = match a.get_webview_window(label) {
                    Some(w) => {
                        let filled = fill_work_area(&w);
                        let want = work_area_of(&w);
                        (filled, (want.w, want.h), visible_rect(&w))
                    }
                    None => (false, (0, 0), None),
                };
                let _ = tx.send(out);
            });
            if queued.is_err() {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(700)) {
                Ok((true, want, Some(r))) if (r.2 - want.0).abs() <= 2 && (r.3 - want.1).abs() <= 2 => {
                    streak += 1;
                    if streak >= 3 {
                        return;
                    }
                }
                _ => streak = 0,
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

/// 对比窗口的「最大化 / 还原」。
///
/// 无边框窗口没有系统标题栏，也没有真正的最大化状态可切，所以这一对动作
/// 就是两个矩形：铺满工作区，或者居中一个 1280x860 的常规尺寸。
/// 「工作区」取窗口当时所在的那块屏 —— 拖到副屏后最大化，就该铺满副屏。
#[tauri::command]
fn tool_set_fullscreen(app: tauri::AppHandle, label: String, fill: bool) -> Result<(), AppError> {
    use tauri::Manager;
    let Some(w) = app.get_webview_window(&label) else {
        return Err(AppError::new("win.compare_missing"));
    };
    #[cfg(target_os = "windows")]
    {
        if fill {
            fill_work_area(&w);
        } else {
            // 还原：工作区正中一个 1280x860（换到小屏时按工作区收一收）
            let screen = work_area_of(&w);
            let (l, t, r, b) = frame_insets(&w);
            let s = if screen.scale > 0.1 { screen.scale } else { 1.0 };
            let cw = ((1280.0 * s) as i32).min(screen.w - 80) + l + r;
            let ch = ((860.0 * s) as i32).min(screen.h - 80) + t + b;
            set_window_rect(
                &w,
                screen.x + (screen.w - cw) / 2,
                screen.y + (screen.h - ch) / 2,
                cw,
                ch,
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if fill {
            w.maximize().map_err(|e| AppError::detail("win.state", e))
        } else {
            w.unmaximize().map_err(|e| AppError::detail("win.state", e))
        }
    }
}

/* ---------------- 导出 PDF ----------------
   以前是 window.open('') + win.print()：在真机上「喊不醒打印窗口」。
   原因是 WebView2 **没有实现**浏览器那套打印面板 —— 嵌入式 WebView 里调用
   window.print() 既不弹框也不报错，用户看到的就是「点了没反应」。

   改用 WebView2 自己的 PrintToPdf：按打印样式（@media print）把当前页面渲染成
   PDF 直接写到指定路径。不需要打印机、不需要系统对话框、也不会弹窗。

   页面侧的约定很窄：前端把要导出的内容渲染进 `#printRoot`，打印样式隐藏其余一切，
   然后调这个命令。这里只做三件事：拿接口 → 设纸张 → 等它写完。 */

#[cfg(target_os = "windows")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), AppError> {
    use std::sync::mpsc;
    use std::time::Duration;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::Interface;

    let (tx, rx) = mpsc::channel::<bool>();
    let target = path.clone();

    window
        .with_webview(move |wv| {
            /* 这个闭包在主线程跑：WebView2 的接口都只能在 GUI 线程调用 */
            let fail = |tx: &mpsc::Sender<bool>| {
                let _ = tx.send(false);
            };
            unsafe {
                let core = match wv.controller().CoreWebView2() {
                    Ok(c) => c,
                    Err(_) => return fail(&tx),
                };
                /* PrintToPdf 在 ICoreWebView2_7（2021 年的运行时就有）：
                   老运行时转不过去，按「失败」返回，不假装成功 */
                let core7: ICoreWebView2_7 = match core.cast() {
                    Ok(c) => c,
                    Err(_) => return fail(&tx),
                };
                let env6: ICoreWebView2Environment6 = match wv.environment().cast() {
                    Ok(e) => e,
                    Err(_) => return fail(&tx),
                };
                let settings = match env6.CreatePrintSettings() {
                    Ok(s) => s,
                    Err(_) => return fail(&tx),
                };
                /* A4（英寸）；边距交给页面自己的 @page，这里给 0 —— 双重边距会把
                   正文挤得比预览窄一截，看起来像「导出错了」 */
                let _ = settings.SetPageWidth(8.27);
                let _ = settings.SetPageHeight(11.69);
                let _ = settings.SetMarginTop(0.0);
                let _ = settings.SetMarginBottom(0.0);
                let _ = settings.SetMarginLeft(0.0);
                let _ = settings.SetMarginRight(0.0);
                /* 底色要打：代码块的浅灰、引用条都靠背景色，不打开会全白 */
                let _ = settings.SetShouldPrintBackgrounds(true);

                let file = windows_core::HSTRING::from(target.as_str());
                let done = tx.clone();
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                    let _ = done.send(hr.is_ok() && ok);
                    Ok(())
                }));
                if core7.PrintToPdf(&file, &settings, &handler).is_err() {
                    let _ = tx.send(false);
                }
            }
        })
        .map_err(|e| AppError::detail("pdf.failed", e))?;

    let written = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(180)).unwrap_or(false)
    })
    .await
    .unwrap_or(false);

    if written && std::path::Path::new(&path).exists() {
        Ok(())
    } else {
        Err(AppError::new("pdf.failed"))
    }
}

/* macOS 的导出 PDF 还没落地，这里**故意**返回「不支持」而不是伪造成功。

   已确认的技术路径（objc2-web-kit 0.3.2 / objc2 0.6.5，与 wry 传递依赖同版本）：
   `with_webview(|wv| &*wv.inner().cast::<WKWebView>())` 能拿到 WKWebView，
   `createPDFWithConfiguration_completionHandler` 给一个 NSData。但这个方法生成的是
   **当前页面 bounds 的单页 PDF**，而 Windows 版 PrintToPdf 走完整打印管线、
   按 CSS `@page` 分页成多页 A4 —— 直接用它，业务行为并不一致。
   要真对齐得走 `WKWebView.printOperation(with:)` → NSPrintOperation 设
   NSPrintJobSavingURL 落盘（macOS 11+），且必须在目标机器上验证分页与边距。

   前端 pdf.js 的 exportPdfTo(path, tab) 与 @media print 规则都不用改，
   平台差异只落在这条命令里。见 docs/macOS-开发.md 的 M4。 */
#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn export_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), AppError> {
    Err(AppError::new("pdf.unsupported"))
}

/// 原生菜单已移除：窗口改为无边框自绘标题栏（decorations=false），
/// 菜单由前端 appmenu.js 渲染，命令仍统一走前端 commands 表。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        /* 单实例要第一个装：得赶在窗口创建前认出「已经有一个在跑」，
           否则第二次双击会老老实实再起一个进程，两个窗口改同一个文件 */
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::{Emitter, Manager};
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let files = file_args(&argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        /* 自绘 menubar 承载了动态「最近打开」、勾选状态与右键药丸行；
           macOS 默认还会建一套系统菜单，两套并排且无处显示快捷键。
           留自绘、关系统菜单（其它平台是 no-op）。⌘Q 由下面的 ExitRequested 守卫。 */
        .enable_macos_default_menu(false)
        .manage(OpenedFiles::default())
        .manage(WatchState(std::sync::Mutex::new(None)))
        .manage(CompareRequest::default())
        .manage(FolderCompareRequest::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            file_size,
            save_text_file,
            file_stat,
            list_dir_recursive,
            compare_file_pairs,
            read_dir_shallow,
            search_in_folder,
            write_binary_file,
            read_file_base64,
            copy_image_to_assets,
            save_image_bytes,
            file_mtime,
            watch_files,
            create_entry,
            rename_entry,
            delete_entry,
            initial_files,
            save_history,
            list_history,
            read_history,
            clear_history,
            quick_note_path,
            open_compare_window,
            take_compare_request,
            open_folder_compare_window,
            take_folder_compare_request,
            open_in_main,
            export_pdf,
            confirm_app_exit,
            tool_set_fullscreen
        ])
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                apply_rounded_corners(&w);
            }
            // 命令行直接对比：--compare 左 右
            let argv: Vec<String> = std::env::args().collect();
            if let Some((left, right)) = compare_args(&argv) {
                let handle = app.handle().clone();
                let _ = spawn_compare_window(&handle, left, right);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        match event {
            tauri::RunEvent::Opened { urls } => {
                use tauri::{Emitter, Manager};
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| Path::new(p).is_file())
                    .collect();
                if files.is_empty() {
                    return;
                }
                let state = app.state::<OpenedFiles>();
                if state.ready.load(std::sync::atomic::Ordering::SeqCst) {
                    let _ = app.emit("open-files", files);
                } else if let Ok(mut g) = state.pending.lock() {
                    for p in files {
                        if !g.contains(&p) {
                            g.push(p);
                        }
                    }
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                use tauri::Emitter;
                if !EXIT_ALLOWED.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    /* 前端跑完 confirmQuit 守卫后调 confirm_app_exit 放行；
                       不在这里直接 exit，否则未保存的标签会被绕过 */
                    let _ = app.emit("app-exit-request", ());
                }
            }
            _ => {}
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

/* ---------------- 后端单测 ----------------
   只测不依赖窗口的部分：名字校验、base64、argv 过滤、替换计划。
   命令那一层要 AppHandle（写历史快照），在 GUI 里由 probe 覆盖。 */
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_names_reject_paths() {
        assert!(check_simple_name("笔记.md").is_ok());
        assert!(check_simple_name("  ").is_err());
        assert!(check_simple_name("../x.md").is_err());
        assert!(check_simple_name("a/b.md").is_err());
        assert!(check_simple_name("a\\b.md").is_err());
        assert!(check_simple_name("a:b.md").is_err());
        assert!(check_simple_name("..").is_err());
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"a"), "YQ==");
        assert_eq!(b64_encode(b"ab"), "YWI=");
        assert_eq!(b64_encode(b"abc"), "YWJj");
        assert_eq!(b64_encode(b"abcd"), "YWJjZA==");
        assert_eq!(b64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn file_args_skips_flags_and_missing() {
        let args = vec![
            "app.exe".to_string(),
            "--flag".to_string(),
            "Cargo.toml".to_string(),
            "definitely-missing.xyz".to_string(),
        ];
        let got = file_args(&args);
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(got[0].ends_with("Cargo.toml"));
    }

    #[test]
    fn compare_args_take_two_files_and_hide_them_from_tabs() {
        let args = vec![
            "app.exe".to_string(),
            "--compare".to_string(),
            "Cargo.toml".to_string(),
            "build.rs".to_string(),
        ];
        assert_eq!(file_args(&args).len(), 0, "给对比窗口的两个文件不该再开标签");
        let (l, r) = compare_args(&args).unwrap();
        assert!(l.unwrap().ends_with("Cargo.toml"));
        assert!(r.unwrap().ends_with("build.rs"));
        // 只有一个文件也行：另一侧留空
        let one = vec!["app.exe".to_string(), "--compare".to_string(), "Cargo.toml".to_string()];
        let (l, r) = compare_args(&one).unwrap();
        assert!(l.is_some());
        assert!(r.is_none());
        // 没有 --compare 就不是对比启动
        assert!(compare_args(&["app.exe".to_string()]).is_none());
    }

    #[test]
    fn create_then_rename() {
        let base = std::env::temp_dir().join("ez-snp-test");
        fs::create_dir_all(&base).unwrap();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!("t{stamp}.md");
        let p = create_entry(base.to_string_lossy().to_string(), name, false).unwrap();
        assert!(Path::new(&p).is_file());

        let np = rename_entry(p.clone(), format!("r{stamp}.md")).unwrap();
        assert!(np.ends_with(&format!("r{stamp}.md")));
        assert!(!Path::new(&p).exists());
        fs::remove_file(&np).unwrap();
    }
}
