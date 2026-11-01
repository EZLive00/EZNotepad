// EZNotepad - Rust 后端
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

/* ---------------- 文件树写操作 ----------------
   只接受**单层名字**：路径分隔符一律拒绝，免得前端传个 "../.." 就把操作范围
   伸到工作目录外面。删除走系统回收站，误点了还能捞回来。 */

fn check_simple_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名字不能为空".into());
    }
    if n.contains('/') || n.contains('\\') || n == "." || n == ".." {
        return Err("名字里不能带路径分隔符".into());
    }
    if n.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err("名字里有不允许的字符（< > : \" | ? *）".into());
    }
    Ok(n.to_string())
}

/// 在 parent 下新建空文件或空目录，返回新条目的完整路径
#[tauri::command]
fn create_entry(parent: String, name: String, dir: bool) -> Result<String, String> {
    let parent = PathBuf::from(&parent);
    if !parent.is_dir() {
        return Err("目标文件夹不存在".into());
    }
    let name = check_simple_name(&name)?;
    let p = parent.join(&name);
    if p.exists() {
        return Err(format!("「{name}」已经存在"));
    }
    if dir {
        fs::create_dir(&p)
    } else {
        fs::write(&p, b"")
    }
    .map_err(|e| format!("创建失败：{e}"))?;
    Ok(p.to_string_lossy().to_string())
}

/// 原地改名（父目录不变），返回新路径
#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("这个条目已经不存在了".into());
    }
    let name = check_simple_name(&new_name)?;
    let parent = src.parent().ok_or("找不到所在文件夹")?;
    let dst = parent.join(&name);
    if dst == src {
        return Ok(path);
    }
    if dst.exists() {
        return Err(format!("「{name}」已经存在"));
    }
    fs::rename(&src, &dst).map_err(|e| format!("重命名失败：{e}"))?;
    Ok(dst.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn delete_file_impl(p: &Path) -> Result<(), String> {
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
        return Err(format!("移入回收站失败（错误码 {rc}）"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("操作已取消".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn delete_file_impl(p: &Path) -> Result<(), String> {
    fs::remove_file(p).map_err(|e| format!("删除失败：{e}"))
}

/// 删除文件（进回收站）或空目录
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("这个条目已经不存在了".into());
    }
    if p.is_dir() {
        // 目录只删空的：递归删除风险太大，让人先在里面清干净
        return fs::remove_dir(&p).map_err(|e| format!("目录里还有东西，无法删除：{e}"));
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

#[tauri::command]
fn initial_files() -> Vec<String> {
    file_args(&std::env::args().collect::<Vec<_>>())
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
/// regex=true 时按正则匹配（写错会直接报错，不静默返回空）。
#[tauri::command]
fn search_in_folder(
    root: String,
    query: String,
    max_results: Option<usize>,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let cs = case_sensitive.unwrap_or(false);
    let pat = if regex.unwrap_or(false) {
        Some(regex::Regex::new(&query).map_err(|e| format!("正则写错了：{e}"))?)
    } else {
        None
    };
    let needle = query.to_lowercase();
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

#[derive(Serialize)]
struct ReplaceResult {
    files: usize,
    hits: usize,
    skipped: usize,
    paths: Vec<String>,
}

/// 跨文件替换。默认字面匹配、不区分大小写（和搜索一致）；regex=true 才走正则，
/// 正则写错直接返回错误，不会改到一半停下。
/// 只处理能按 UTF-8 读通的文件——GBK 那些硬转会在用户不知情时换掉整个文件的编码，
/// 宁可不改，也不悄悄改错。每个文件落盘前先留一份历史快照。
#[tauri::command]
fn replace_in_folder(
    app: tauri::AppHandle,
    root: String,
    query: String,
    replacement: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
) -> Result<ReplaceResult, String> {
    if query.is_empty() {
        return Err("要找的内容是空的".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err("不是文件夹".into());
    }
    let use_regex = regex.unwrap_or(false);
    let pat = if use_regex {
        regex::Regex::new(&query).map_err(|e| format!("正则写错了：{e}"))?
    } else {
        let src = if case_sensitive.unwrap_or(false) {
            regex::escape(&query)
        } else {
            format!("(?i){}", regex::escape(&query))
        };
        regex::Regex::new(&src).map_err(|e| format!("匹配式无效：{e}"))?
    };
    /* 字面替换里用户输的 $ 是普通字符，不该被当成捕获组引用 */
    let rep = if use_regex {
        replacement.clone()
    } else {
        replacement.replace('$', "$$")
    };

    let mut files = Vec::new();
    walk(&root_path, &mut files, 4000, 0)?;

    let mut out = ReplaceResult { files: 0, hits: 0, skipped: 0, paths: Vec::new() };
    for f in files {
        match plan_replace(&f, &pat, &rep, f.size) {
            Planned::Skip => {
                out.skipped += 1;
                continue;
            }
            Planned::Keep => continue,
            Planned::Write { prev, next, hits } => {
                let _ = write_history_snapshot(&app, &f.path, &prev);
                match fs::write(&f.path, next.as_bytes()) {
                    Ok(_) => {
                        out.files += 1;
                        out.hits += hits;
                        out.paths.push(f.path.clone());
                    }
                    Err(_) => out.skipped += 1,
                }
            }
        }
    }
    Ok(out)
}

/// 一个文件的替换结论：跳过（二进制/太大/非 UTF-8）、没命中、或者要写成什么
enum Planned {
    Skip,
    Keep,
    Write { prev: String, next: String, hits: usize },
}

/// 纯逻辑：读一个文件、判断能不能改、算出改完的内容。
/// 抽出来是为了能单测 —— 命令那层要 app handle，测不了。
fn plan_replace(f: &DirEntryInfo, pat: &regex::Regex, rep: &str, size: u64) -> Planned {
    if size > 4 * 1024 * 1024 {
        return Planned::Skip;
    }
    let bytes = match fs::read(&f.path) {
        Ok(b) => b,
        Err(_) => return Planned::Skip,
    };
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Planned::Skip;
    }
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return Planned::Skip,   // GBK 之类：宁可不动，也不悄悄改编码
    };
    let hits = pat.find_iter(&text).count();
    if hits == 0 {
        return Planned::Keep;
    }
    Planned::Write {
        prev: text.clone(),
        next: pat.replace_all(&text, rep).to_string(),
        hits,
    }
}

#[tauri::command]
fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<String, String> {
    fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;
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
fn read_file_base64(path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let size = fs::metadata(&p)
        .map_err(|e| format!("读不到文件：{e}"))?
        .len() as usize;
    let limit = max_bytes.unwrap_or(4 * 1024 * 1024);
    if size > limit {
        return Err(format!("图片超过 {}MB，没有内嵌", limit / 1024 / 1024));
    }
    let bytes = fs::read(&p).map_err(|e| format!("读不到文件：{e}"))?;
    Ok(b64_encode(&bytes))
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

fn history_dir(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("找不到应用数据目录：{e}"))?;
    Ok(base.join("history").join(format!("{:016x}", fnv1a(path))))
}

/// 留一份快照。内容和最新那份一样时直接跳过，不制造一堆重复。
fn write_history_snapshot(app: &tauri::AppHandle, path: &str, content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Ok(());
    }
    let dir = history_dir(app, path)?;
    fs::create_dir_all(&dir).map_err(|e| format!("建立历史目录失败：{e}"))?;
    // 记下来源文件名，方便在文件夹里认
    let _ = fs::write(
        dir.join("name.txt"),
        Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
    );

    let mut snaps: Vec<(u64, PathBuf)> = fs::read_dir(&dir)
        .map_err(|e| format!("读历史目录失败：{e}"))?
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
        .map_err(|e| format!("写历史快照失败：{e}"))?;

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
fn save_history(app: tauri::AppHandle, path: String, content: String) -> Result<(), String> {
    write_history_snapshot(&app, &path, &content)
}

#[tauri::command]
fn list_history(app: tauri::AppHandle, path: String) -> Result<Vec<HistoryEntry>, String> {
    let dir = history_dir(&app, &path)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<HistoryEntry> = fs::read_dir(&dir)
        .map_err(|e| format!("读历史目录失败：{e}"))?
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
fn read_history(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读快照失败：{e}"))?;
    let (text, _, _) = decode_bytes(&bytes);
    Ok(text)
}

/// 清掉某个文件的全部历史（用户主动「清除历史」时用）
#[tauri::command]
fn clear_history(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = history_dir(&app, &path)?;
    if dir.is_dir() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清除历史失败：{e}"))?;
    }
    Ok(())
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
) -> Result<usize, String> {
    use notify::{RecursiveMode, Watcher};
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;

    // 1. 先撤掉旧的监听
    *state.0.lock().map_err(|_| "监听状态锁定失败")? = None;
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
    .map_err(|e| format!("无法建立文件监听：{e}"))?;

    // 3. 每个目录只监听一层。目录不存在（文件已被删）就跳过，不是错误
    let mut n = 0;
    for d in &dirs {
        if watcher.watch(d, RecursiveMode::NonRecursive).is_ok() {
            n += 1;
        }
    }

    *state.0.lock().map_err(|_| "监听状态锁定失败")? = Some(watcher);
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
) -> Result<(), String> {
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
) -> Result<(), String> {
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
    *state.0.lock().map_err(|_| "对比请求锁定失败")? = Some((left, right));

    // 出生尺寸就按工作区给：后面的 SetWindowPos 只是把「DWM 隐形边框」那几像素
    // 也吃掉，不能指望它单独完成铺满（见 fill_work_area 的注释）
    #[cfg(target_os = "windows")]
    let (bx, by, bw, bh) = work_area();
    #[cfg(not(target_os = "windows"))]
    let (bx, by, bw, bh) = (0i32, 0i32, 1280i32, 860i32);

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "compare",
        tauri::WebviewUrl::App("compare.html".into()),
    )
    .title("文本对比")
    .inner_size(bw as f64, bh as f64)
    .position(bx as f64, by as f64)
    .min_inner_size(760.0, 460.0)
    .decorations(false)
    .shadow(true)
    .visible(true);

    // 页面加载完再补一次：tao 应用 inner_size 比我们晚，第一次铺满可能被顶回来
    let app_load = app.clone();
    builder = builder.on_page_load(move |_w, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            #[cfg(target_os = "windows")]
            fill_work_area_when_ready(app_load.clone(), "compare");
        }
    });

    // 和主窗口用同一组浏览器参数：GPU 沙箱崩溃的问题在这里一样会犯
    #[cfg(target_os = "windows")]
    {
        builder = builder.additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-sandbox",
        );
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        apply_rounded_corners(&win);
        // 先把矩形摆好（此时还不可见），页面加载完那一轮再收个尾
        fill_work_area_when_ready(app.clone(), "compare");
    }
    Ok(())
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

/// 屏幕工作区（已去掉任务栏）。取不到时回落到 1920x1080。
#[cfg(target_os = "windows")]
fn work_area() -> (i32, i32, i32, i32) {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};

    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut core::ffi::c_void, 0)
    };
    if ok == 0 || r.right <= r.left || r.bottom <= r.top {
        return (0, 0, 1920, 1080);
    }
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

/// 把窗口铺满「工作区」（屏幕减去任务栏）。
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
    let (wx, wy, ww, wh) = work_area();
    let (l, t, r, b) = frame_insets(window);
    set_window_rect(window, wx - l, wy - t, ww + l + r, wh + t + b)
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
#[cfg(target_os = "windows")]
fn fill_work_area_when_ready(app: tauri::AppHandle, label: &'static str) {
    use std::sync::mpsc;
    use std::time::Duration;

    std::thread::spawn(move || {
        let (_, _, ww, wh) = work_area();
        let mut streak = 0;
        for _ in 0..40u32 {
            let (tx, rx) = mpsc::channel();
            let a = app.clone();
            let queued = app.run_on_main_thread(move || {
                use tauri::Manager;
                let out = match a.get_webview_window(label) {
                    Some(w) => (fill_work_area(&w), visible_rect(&w)),
                    None => (false, None),
                };
                let _ = tx.send(out);
            });
            if queued.is_err() {
                return;
            }
            match rx.recv_timeout(Duration::from_millis(700)) {
                Ok((true, Some(r))) if (r.2 - ww).abs() <= 2 && (r.3 - wh).abs() <= 2 => {
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
#[tauri::command]
fn compare_set_fullscreen(app: tauri::AppHandle, fill: bool) -> Result<(), String> {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("compare") else {
        return Err("对比窗口不在".into());
    };
    #[cfg(target_os = "windows")]
    {
        let (wx, wy, ww, wh) = work_area();
        if fill {
            fill_work_area(&w);
        } else {
            // 还原：工作区正中一个 1280x860（换到小屏时按工作区收一收）
            let (l, t, r, b) = frame_insets(&w);
            let cw = 1280.min(ww - 80) + l + r;
            let ch = 860.min(wh - 80) + t + b;
            set_window_rect(&w, wx + (ww - cw) / 2, wy + (wh - ch) / 2, cw, ch);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if fill {
            w.maximize().map_err(|e| e.to_string())
        } else {
            w.unmaximize().map_err(|e| e.to_string())
        }
    }
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
        .manage(WatchState(std::sync::Mutex::new(None)))
        .manage(CompareRequest::default())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            save_text_file,
            file_stat,
            list_dir_recursive,
            read_dir_shallow,
            search_in_folder,
            replace_in_folder,
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
            open_compare_window,
            take_compare_request,
            compare_set_fullscreen
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

    app.run(|_, _| {});
}

/* ---------------- 后端单测 ----------------
   只测不依赖窗口的部分：名字校验、base64、argv 过滤、替换计划。
   命令那一层要 AppHandle（写历史快照），在 GUI 里由 probe 覆盖。 */
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str, content: &[u8]) -> DirEntryInfo {
        let dir = std::env::temp_dir().join("ez-snp-test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        DirEntryInfo {
            name: name.into(),
            path: p.to_string_lossy().to_string(),
            is_dir: false,
            ext: "md".into(),
            size: content.len() as u64,
            mtime: 0,
        }
    }

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
    fn regex_replace_expands_groups() {
        let f = tmp_file("re.md", "v1\nv2\n".as_bytes());
        let pat = regex::Regex::new("v(\\d)").unwrap();
        match plan_replace(&f, &pat, "V$1", f.size) {
            Planned::Write { next, hits, .. } => {
                assert_eq!(hits, 2);
                assert_eq!(next, "V1\nV2\n");
            }
            _ => panic!("应该要写回"),
        }
    }

    #[test]
    fn literal_replacement_keeps_dollar() {
        let f = tmp_file("dollar.md", "cost: 5\n".as_bytes());
        let pat = regex::Regex::new(&format!("(?i){}", regex::escape("cost"))).unwrap();
        // 字面替换时必须把 $ 转义，否则会被当成组引用
        let rep = "price $9".replace('$', "$$");
        match plan_replace(&f, &pat, &rep, f.size) {
            Planned::Write { next, hits, .. } => {
                assert_eq!(hits, 1);
                assert_eq!(next, "price $9: 5\n");
            }
            _ => panic!("应该要写回"),
        }
    }

    #[test]
    fn binary_and_oversize_are_skipped() {
        let f = tmp_file("bin.md", &[0u8, 1, 2, 3]);
        let pat = regex::Regex::new("a").unwrap();
        assert!(matches!(plan_replace(&f, &pat, "", f.size), Planned::Skip));

        let big = tmp_file("big.md", b"abc");
        assert!(matches!(plan_replace(&big, &pat, "", 5 * 1024 * 1024), Planned::Skip));
    }

    #[test]
    fn non_utf8_is_left_alone() {
        // GB18030 的「中文」：改成 UTF-8 会悄悄换掉整个文件的编码
        let f = tmp_file("gbk.md", &[0xD6, 0xD0, 0xCE, 0xC4]);
        let pat = regex::Regex::new("中").unwrap();
        assert!(matches!(plan_replace(&f, &pat, "", f.size), Planned::Skip));
    }

    #[test]
    fn no_hit_keeps_file() {
        let f = tmp_file("none.md", "zzz\n".as_bytes());
        let pat = regex::Regex::new("abc").unwrap();
        assert!(matches!(plan_replace(&f, &pat, "", f.size), Planned::Keep));
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
