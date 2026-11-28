// 打开「不是文本」的文件：类型探测、原始字节、压缩包浏览。
//
// 为什么要探测而不是只看扩展名：用户会把 .png 改名成 .dat，也会把 .zip 改成
// .docx 发过来。扩展名只当兜底，先认文件头。
//
// 这里所有命令都是**只读**的：压缩包只在内存里解，不往磁盘写一个字节。
// 「解压到…」是另一个功能，真做的时候要单独处理路径穿越。

use crate::error::AppError;
use crate::{b64_encode, decode_bytes};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 文件头读多少。tar 的魔数在 257 偏移，zip 的目录项也在这之内，8 KB 够用。
const HEAD: usize = 8192;
/// 文本条目最多解这么多（再大就不是「看一眼」了）
const TEXT_CAP: u64 = 512 * 1024;
/// 图片条目最多解这么多
const IMG_CAP: u64 = 8 * 1024 * 1024;
/// 十六进制视图只要开头这一段
const HEX_CAP: u64 = 64 * 1024;
/// 条目数上限。一个包里有十万个文件时，列目录会卡住界面
const MAX_ENTRIES: usize = 20000;
/// 单条目解压上限：超过就当「不看了」，不冒把内存吃穿的风险
const MAX_ENTRY: u64 = 512 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileProbe {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// 秒级时间戳，0 表示拿不到
    pub mtime: i64,
    /// text / image / archive / audio / video / font / pdf / office / binary
    pub kind: String,
    /// png / jpeg / zip / mp3 …（小写，不带点）
    pub format: String,
    pub mime: String,
    /// 能不能按文本打开（SVG 也算，它本来就是源码）
    pub text: bool,
    /// 额外能力：SVG 可以再切图片预览
    pub svg: bool,
}

#[derive(Serialize)]
pub struct ArchiveEntry {
    /// 包内路径，统一用 / 分隔
    pub name: String,
    /// 解压后大小
    pub size: u64,
    /// 压缩后大小（tar 没有这个概念，为 0）
    pub packed: u64,
    pub mtime: i64,
    pub dir: bool,
}

#[derive(Serialize)]
pub struct EntryBlob {
    /// text / image / binary
    pub kind: String,
    pub format: String,
    pub mime: String,
    pub text: Option<String>,
    pub encoding: Option<String>,
    /// 图片与二进制走 base64
    pub b64: Option<String>,
    /// 条目原本有多大
    pub size: u64,
    /// 只取了开头一段
    pub truncated: bool,
}

/* ---------------- 类型探测 ---------------- */

fn hit(head: &[u8], off: usize, pat: &[u8]) -> bool {
    head.len() >= off + pat.len() && &head[off..off + pat.len()] == pat
}

fn read_head(p: &Path, n: usize) -> Result<Vec<u8>, AppError> {
    let mut f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
    let mut buf = vec![0u8; n];
    let got = f.read(&mut buf).map_err(|e| AppError::detail("io.read", e))?;
    buf.truncate(got);
    Ok(buf)
}

fn ext_of(name_lower: &str) -> &str {
    match name_lower.rsplit_once('.') {
        Some((_, e)) => e,
        None => "",
    }
}

fn img_ext(ext: &str) -> Option<(&'static str, &'static str)> {
    Some(match ext {
        "png" => ("png", "image/png"),
        "jpg" | "jpeg" | "jfif" => ("jpeg", "image/jpeg"),
        "gif" => ("gif", "image/gif"),
        "webp" => ("webp", "image/webp"),
        "bmp" => ("bmp", "image/bmp"),
        "ico" => ("ico", "image/x-icon"),
        "tif" | "tiff" => ("tiff", "image/tiff"),
        "avif" => ("avif", "image/avif"),
        "heic" | "heif" => ("heic", "image/heic"),
        _ => return None,
    })
}

fn av_ext(ext: &str) -> Option<(&'static str, &'static str)> {
    Some(match ext {
        "mp3" => ("audio", "audio/mpeg"),
        "wav" => ("audio", "audio/wav"),
        "flac" => ("audio", "audio/flac"),
        "ogg" | "oga" | "opus" => ("audio", "audio/ogg"),
        "m4a" | "aac" => ("audio", "audio/mp4"),
        "wma" => ("audio", "audio/x-ms-wma"),
        "mp4" | "m4v" => ("video", "video/mp4"),
        "webm" => ("video", "video/webm"),
        "mkv" => ("video", "video/x-matroska"),
        "mov" => ("video", "video/quicktime"),
        "avi" => ("video", "video/x-msvideo"),
        "flv" => ("video", "video/x-flv"),
        "wmv" => ("video", "video/x-ms-wmv"),
        "mpg" | "mpeg" => ("video", "video/mpeg"),
        _ => return None,
    })
}

fn font_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ttf" => "ttf",
        "otf" => "otf",
        "woff" => "woff",
        "woff2" => "woff2",
        "ttc" => "ttc",
        _ => return None,
    })
}

/// 认文件头。返回 (kind, format, mime)；认不出来时返回 None，交给扩展名与文本判定
fn sniff(head: &[u8]) -> Option<(&'static str, &'static str, &'static str)> {
    // 图片
    if hit(head, 0, &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(("image", "png", "image/png"));
    }
    if hit(head, 0, &[0xFF, 0xD8, 0xFF]) {
        return Some(("image", "jpeg", "image/jpeg"));
    }
    if hit(head, 0, b"GIF8") {
        return Some(("image", "gif", "image/gif"));
    }
    if hit(head, 0, b"RIFF") && hit(head, 8, b"WEBP") {
        return Some(("image", "webp", "image/webp"));
    }
    if hit(head, 0, b"BM") && head.len() > 14 {
        return Some(("image", "bmp", "image/bmp"));
    }
    if hit(head, 0, &[0x00, 0x00, 0x01, 0x00]) {
        return Some(("image", "ico", "image/x-icon"));
    }
    if hit(head, 0, b"II*\0") || hit(head, 0, b"MM\0*") {
        return Some(("image", "tiff", "image/tiff"));
    }
    if hit(head, 4, b"ftyp") {
        if hit(head, 8, b"avif") || hit(head, 8, b"avis") {
            return Some(("image", "avif", "image/avif"));
        }
        if hit(head, 8, b"heic") || hit(head, 8, b"heix") || hit(head, 8, b"mif1") {
            return Some(("image", "heic", "image/heic"));
        }
        return Some(("video", "mp4", "video/mp4"));
    }

    // 压缩包
    if hit(head, 0, b"PK\x03\x04") || hit(head, 0, b"PK\x05\x06") || hit(head, 0, b"PK\x07\x08") {
        return Some(("archive", "zip", "application/zip"));
    }
    if hit(head, 257, b"ustar") {
        return Some(("archive", "tar", "application/x-tar"));
    }
    if hit(head, 0, &[0x1F, 0x8B]) {
        return Some(("archive", "gz", "application/gzip"));
    }
    if hit(head, 0, b"7z\xBC\xAF\x27\x1C") {
        return Some(("archive", "7z", "application/x-7z-compressed"));
    }
    if hit(head, 0, b"Rar!\x1A\x07") {
        return Some(("archive", "rar", "application/vnd.rar"));
    }
    if hit(head, 0, b"BZh") {
        return Some(("archive", "bz2", "application/x-bzip2"));
    }
    if hit(head, 0, &[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
        return Some(("archive", "xz", "application/x-xz"));
    }
    if hit(head, 0, &[0x28, 0xB5, 0x2F, 0xFD]) {
        return Some(("archive", "zst", "application/zstd"));
    }

    // 音视频
    if hit(head, 0, b"ID3") || (head.len() > 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0) {
        return Some(("audio", "mp3", "audio/mpeg"));
    }
    if hit(head, 0, b"RIFF") && hit(head, 8, b"WAVE") {
        return Some(("audio", "wav", "audio/wav"));
    }
    if hit(head, 0, b"fLaC") {
        return Some(("audio", "flac", "audio/flac"));
    }
    if hit(head, 0, b"OggS") {
        return Some(("audio", "ogg", "audio/ogg"));
    }
    if hit(head, 0, &[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(("video", "webm", "video/webm"));
    }

    // 文档
    if hit(head, 0, b"%PDF") {
        return Some(("pdf", "pdf", "application/pdf"));
    }

    // 字体
    if hit(head, 0, &[0x00, 0x01, 0x00, 0x00]) || hit(head, 0, b"OTTO") || hit(head, 0, b"true") || hit(head, 0, b"ttcf") {
        return Some(("font", "ttf", "font/ttf"));
    }
    if hit(head, 0, b"wOFF") {
        return Some(("font", "woff", "font/woff"));
    }
    if hit(head, 0, b"wOF2") {
        return Some(("font", "woff2", "font/woff2"));
    }

    // 可执行 / 数据库这种，知道是什么就够了，不给预览
    if hit(head, 0, b"MZ") {
        return Some(("binary", "exe", "application/vnd.microsoft.portable-executable"));
    }
    if hit(head, 0, b"SQLite format 3\0") {
        return Some(("binary", "sqlite", "application/vnd.sqlite3"));
    }
    None
}

/// 文本判定：开头没有 NUL，且 UTF-8 合法（不合法时看解码后的替换字符比例）
fn looks_text(bytes: &[u8]) -> bool {
    if bytes.iter().take(HEAD).any(|b| *b == 0) {
        return false;
    }
    if std::str::from_utf8(bytes).is_ok() {
        return true;
    }
    // 中文老文件多是 GBK：按 GB18030 解一遍，替换字符不多就当文本
    let (s, _, _) = encoding_rs::GB18030.decode(bytes);
    let bad = s.chars().filter(|c| *c == '\u{FFFD}').count();
    bad * 100 < s.chars().count().max(1) * 2
}

/// office 是 zip 容器：不拦下来会被当成压缩包列出 word/document.xml
fn office_ext(ext: &str) -> bool {
    matches!(
        ext,
        "docx" | "docm" | "dotx" | "xlsx" | "xlsm" | "xltx" | "pptx" | "pptm" | "potx" | "odt" | "ods" | "odp" | "vsdx"
    )
}

#[tauri::command]
pub fn probe_file(path: String) -> Result<FileProbe, AppError> {
    let p = PathBuf::from(&path);
    let md = fs::metadata(&p).map_err(|e| AppError::detail("io.read", e))?;
    if md.is_dir() {
        return Err(AppError::new("dir.not_folder"));
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let lower = name.to_lowercase();
    let ext = ext_of(&lower);
    let head = read_head(&p, HEAD)?;

    let (kind, format, mime, text, svg) = if office_ext(ext) {
        let mime = match ext {
            "docx" | "docm" | "dotx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" | "xlsm" | "xltx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" | "pptm" | "potx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            _ => "application/octet-stream",
        };
        ("office".to_string(), ext.to_string(), mime.to_string(), false, false)
    } else if let Some((k, f, m)) = sniff(&head) {
        (k.to_string(), f.to_string(), m.to_string(), false, false)
    } else if ext == "svg" {
        // SVG 是双身份：默认按源码打开，前端另给「图片预览」
        ("text".to_string(), "svg".to_string(), "image/svg+xml".to_string(), true, true)
    } else if let Some((f, m)) = img_ext(ext) {
        ("image".to_string(), f.to_string(), m.to_string(), false, false)
    } else if let Some((k, m)) = av_ext(ext) {
        (k.to_string(), ext.to_string(), m.to_string(), false, false)
    } else if let Some(f) = font_ext(ext) {
        ("font".to_string(), f.to_string(), "font/ttf".to_string(), false, false)
    } else if ext == "pdf" {
        ("pdf".to_string(), "pdf".to_string(), "application/pdf".to_string(), false, false)
    } else if lower.ends_with(".tar.gz") || ext == "tgz" {
        ("archive".to_string(), "targz".to_string(), "application/gzip".to_string(), false, false)
    } else if matches!(ext, "zip" | "tar" | "gz" | "7z" | "rar" | "bz2" | "xz" | "zst") {
        ("archive".to_string(), ext.to_string(), "application/octet-stream".to_string(), false, false)
    } else if looks_text(&head) {
        ("text".to_string(), if ext.is_empty() { "txt".into() } else { ext.to_string() }, "text/plain".to_string(), true, false)
    } else {
        ("binary".to_string(), if ext.is_empty() { "bin".into() } else { ext.to_string() }, "application/octet-stream".to_string(), false, false)
    };

    Ok(FileProbe {
        path: p.to_string_lossy().to_string(),
        name,
        size: md.len(),
        mtime: md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
        kind,
        format,
        mime,
        text,
        svg,
    })
}

/// 取文件的一段原始字节（十六进制视图、图片兜底都用它）。
/// 走 base64 是因为事件/返回值都是 JSON，裸字节数组会膨胀三四倍。
#[tauri::command]
pub fn read_bytes_b64(path: String, offset: Option<u64>, len: Option<usize>) -> Result<String, AppError> {
    let p = PathBuf::from(&path);
    let mut f = File::open(&p).map_err(|e| AppError::detail("io.read", e))?;
    let off = offset.unwrap_or(0);
    if off > 0 {
        f.seek(SeekFrom::Start(off)).map_err(|e| AppError::detail("io.read", e))?;
    }
    let want = len.unwrap_or(HEX_CAP as usize).min(1024 * 1024);
    let mut buf = vec![0u8; want];
    let got = f.read(&mut buf).map_err(|e| AppError::detail("io.read", e))?;
    buf.truncate(got);
    Ok(b64_encode(&buf))
}

/* ---------------- 压缩包 ---------------- */

fn is_tar_gz(p: &Path) -> Result<bool, AppError> {
    let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
    let mut dec = flate2::read::GzDecoder::new(f);
    let mut head = vec![0u8; 512];
    let mut got = 0;
    while got < head.len() {
        match dec.read(&mut head[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => return Ok(false),
        }
    }
    Ok(got >= 262 && &head[257..262] == b"ustar")
}

#[tauri::command]
pub fn archive_list(path: String) -> Result<Vec<ArchiveEntry>, AppError> {
    let p = PathBuf::from(&path);
    let head = read_head(&p, HEAD)?;
    if hit(&head, 0, b"PK\x03\x04") || hit(&head, 0, b"PK\x05\x06") {
        return list_zip(&p);
    }
    if hit(&head, 257, b"ustar") {
        return list_tar(&p, false);
    }
    if hit(&head, 0, &[0x1F, 0x8B]) {
        if is_tar_gz(&p)? {
            return list_tar(&p, true);
        }
        // 单文件 gzip：只有一个条目，名字取自文件名去掉 .gz
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let inner = name
            .strip_suffix(".gz")
            .or_else(|| name.strip_suffix(".GZ"))
            .unwrap_or(&name)
            .to_string();
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        return Ok(vec![ArchiveEntry { name: inner, size: 0, packed: size, mtime: 0, dir: false }]);
    }
    Err(AppError::new("media.unsupported"))
}

/// DOS 时间（zip 头里那 16 位日期 + 16 位时间）转 Unix 秒。
/// 时区信息在格式里没有，按本地时间理解 —— 归档列表只要看个先后，差几小时无所谓。
fn dos_to_unix(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> i64 {
    // Howard Hinnant 的 days_from_civil：把「年/月/日」换成「1970-01-01 起的天数」
    let (y, m, d) = (y as i64, mo as i64, d as i64);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = (if y2 >= 0 { y2 } else { y2 - 399 }) / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + (h as i64) * 3600 + (mi as i64) * 60 + (s as i64)
}

fn list_zip(p: &Path) -> Result<Vec<ArchiveEntry>, AppError> {
    let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| AppError::detail("media.bad_archive", e))?;
    let mut out = Vec::new();
    for i in 0..z.len() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let e = match z.by_index_raw(i) {
            Ok(x) => x,
            Err(_) => continue,
        };
        let name = e.name().replace('\\', "/");
        if name.is_empty() {
            continue;
        }
        out.push(ArchiveEntry {
            name,
            size: e.size(),
            packed: e.compressed_size(),
            mtime: e
                .last_modified()
                .map(|d| dos_to_unix(d.year(), d.month(), d.day(), d.hour(), d.minute(), d.second()))
                .unwrap_or(0),
            dir: e.is_dir(),
        });
    }
    Ok(out)
}

fn list_tar(p: &Path, gz: bool) -> Result<Vec<ArchiveEntry>, AppError> {
    let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
    let r: Box<dyn Read> = if gz {
        Box::new(flate2::read::GzDecoder::new(f))
    } else {
        Box::new(f)
    };
    let mut ar = tar::Archive::new(r);
    let mut out = Vec::new();
    let entries = ar.entries().map_err(|e| AppError::detail("media.bad_archive", e))?;
    for e in entries {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let e = match e {
            Ok(x) => x,
            Err(_) => break,
        };
        let name = match e.path() {
            Ok(x) => x.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if name.is_empty() {
            continue;
        }
        let h = e.header();
        out.push(ArchiveEntry {
            name,
            size: h.size().unwrap_or(0),
            packed: 0,
            mtime: h.mtime().unwrap_or(0) as i64,
            dir: h.entry_type().is_dir(),
        });
    }
    Ok(out)
}

/// 从包里抽一个条目。只读、只在内存里，不解压到磁盘。
#[tauri::command]
pub fn archive_read(path: String, entry: String, max_bytes: Option<usize>) -> Result<EntryBlob, AppError> {
    let p = PathBuf::from(&path);
    let cap = max_bytes.map(|n| n as u64).unwrap_or(TEXT_CAP);

    // 先按条目名猜要读多少：图片得给全，其他只给开头
    let lower = entry.to_lowercase();
    let ext = ext_of(&lower);
    let want_img = img_ext(ext).is_some();
    let limit = if want_img { cap.max(IMG_CAP) } else { cap };

    let (bytes, size) = read_entry(&p, &entry, limit)?;
    if size > MAX_ENTRY {
        return Err(AppError::var("media.too_large", "mb", MAX_ENTRY / 1024 / 1024));
    }
    let truncated = size > bytes.len() as u64;

    let sniffed = sniff(&bytes);
    let (kind, format, mime) = match sniffed {
        Some((k, f, m)) => (k.to_string(), f.to_string(), m.to_string()),
        None if looks_text(&bytes) => (
            "text".to_string(),
            if ext.is_empty() { "txt".into() } else { ext.to_string() },
            "text/plain".to_string(),
        ),
        None => ("binary".to_string(), ext.to_string(), "application/octet-stream".to_string()),
    };

    let mut blob = EntryBlob {
        kind: kind.clone(),
        format,
        mime,
        text: None,
        encoding: None,
        b64: None,
        size,
        truncated,
    };
    if kind == "text" {
        let (s, enc, _) = decode_bytes(&bytes);
        blob.text = Some(s);
        blob.encoding = Some(enc);
    } else if kind == "image" {
        if !truncated {
            blob.b64 = Some(b64_encode(&bytes));
        }
    } else {
        // 二进制只给开头一段，前端画十六进制
        let n = bytes.len().min(HEX_CAP as usize);
        blob.b64 = Some(b64_encode(&bytes[..n]));
    }
    Ok(blob)
}

fn read_entry(p: &Path, entry: &str, limit: u64) -> Result<(Vec<u8>, u64), AppError> {
    let head = read_head(p, HEAD)?;
    if hit(&head, 0, b"PK\x03\x04") || hit(&head, 0, b"PK\x05\x06") {
        let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| AppError::detail("media.bad_archive", e))?;
        /* ⛔ 别用 by_name：Windows 上打的 zip 里，目录分隔符常常是反斜杠
           （Compress-Archive 就是），而列目录时我们已经统一成 / 了 ——
           直接按 / 找必然落空，用户看到的是「这一条打不开」。
           自己按归一化后的名字找下标，再用下标取。 */
        let mut idx = None;
        for i in 0..z.len() {
            match z.by_index_raw(i) {
                Ok(e) if e.name().replace('\\', "/") == entry => { idx = Some(i); break; }
                _ => {}
            }
        }
        let i = idx.ok_or_else(|| AppError::var("media.entry_missing", "name", entry))?;
        let mut e = z
            .by_index(i)
            .map_err(|_| AppError::var("media.entry_missing", "name", entry))?;
        let size = e.size();
        if size > MAX_ENTRY {
            return Err(AppError::var("media.too_large", "mb", MAX_ENTRY / 1024 / 1024));
        }
        // zip bomb：压缩比离谱且体积不小的时候直接拒绝，别把内存吃穿
        let packed = e.compressed_size().max(1);
        if size > 10 * 1024 * 1024 && size / packed > 1000 {
            return Err(AppError::new("media.zip_bomb"));
        }
        let mut buf = Vec::with_capacity(size.min(limit) as usize);
        e.by_ref()
            .take(limit)
            .read_to_end(&mut buf)
            .map_err(|e| AppError::detail("media.bad_archive", e))?;
        return Ok((buf, size));
    }

    if hit(&head, 257, b"ustar") || (hit(&head, 0, &[0x1F, 0x8B]) && is_tar_gz(p)?) {
        let gz = hit(&head, 0, &[0x1F, 0x8B]);
        let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
        let r: Box<dyn Read> = if gz {
            Box::new(flate2::read::GzDecoder::new(f))
        } else {
            Box::new(f)
        };
        let mut ar = tar::Archive::new(r);
        let entries = ar.entries().map_err(|e| AppError::detail("media.bad_archive", e))?;
        for e in entries {
            let mut e = match e {
                Ok(x) => x,
                Err(_) => break,
            };
            let name = match e.path() {
                Ok(x) => x.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if name != entry {
                continue;
            }
            let size = e.header().size().unwrap_or(0);
            if size > MAX_ENTRY {
                return Err(AppError::var("media.too_large", "mb", MAX_ENTRY / 1024 / 1024));
            }
            let mut buf = Vec::with_capacity(size.min(limit) as usize);
            e.by_ref()
                .take(limit)
                .read_to_end(&mut buf)
                .map_err(|e| AppError::detail("media.bad_archive", e))?;
            return Ok((buf, size));
        }
        return Err(AppError::var("media.entry_missing", "name", entry));
    }

    // 单文件 gzip：条目名匹配就直接全解
    if hit(&head, 0, &[0x1F, 0x8B]) {
        let f = File::open(p).map_err(|e| AppError::detail("io.read", e))?;
        let mut dec = flate2::read::GzDecoder::new(f);
        let mut buf = Vec::new();
        dec.by_ref()
            .take(limit)
            .read_to_end(&mut buf)
            .map_err(|e| AppError::detail("media.bad_archive", e))?;
        let size = buf.len() as u64;
        return Ok((buf, size));
    }

    Err(AppError::new("media.unsupported"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_headers() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
        assert_eq!(sniff(&png).unwrap().0, "image");
        assert_eq!(sniff(&png).unwrap().1, "png");

        let zip = b"PK\x03\x04rest";
        assert_eq!(sniff(zip).unwrap().1, "zip");

        let pdf = b"%PDF-1.7\n";
        assert_eq!(sniff(pdf).unwrap().0, "pdf");

        let woff = b"wOF2....";
        assert_eq!(sniff(woff).unwrap().0, "font");

        assert!(sniff(b"hello world").is_none());
    }

    #[test]
    fn text_heuristics() {
        assert!(looks_text("普通的中文文本".as_bytes()));
        assert!(looks_text(b"fn main() {}\n"));
        // NUL 就是二进制
        assert!(!looks_text(&[0x41, 0x00, 0x42]));
        // GBK 中文也能认
        let (gbk, _, _) = encoding_rs::GB18030.encode("中文");
        assert!(looks_text(&gbk));
    }

    #[test]
    fn dos_time_to_unix() {
        // 2024-01-01 00:00:00 UTC
        assert_eq!(dos_to_unix(2024, 1, 1, 0, 0, 0), 1_704_067_200);
        // 闰年 2 月 29 日确实被算成一天
        assert_eq!(dos_to_unix(2024, 3, 1, 0, 0, 0) - dos_to_unix(2024, 2, 29, 0, 0, 0), 86400);
    }

    #[test]
    fn tar_magic_at_257() {
        let mut buf = vec![0u8; 512];
        buf[257..262].copy_from_slice(b"ustar");
        assert_eq!(sniff(&buf).unwrap().1, "tar");
    }
}
