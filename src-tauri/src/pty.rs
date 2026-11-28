//! 内嵌终端的后端：一个 pty 会话 = 一个 id。
//!
//! 为什么不是「起个子进程读 stdout」：交互式 shell 要的是一个**伪终端**。
//! 走管道的话 PowerShell 不出提示符、行编辑 / 方向键 / Tab 补全全废，
//! vim、less 这类全屏程序直接不能用 —— 那是能跑但不对的做法。
//! Windows 上对应的系统设施是 ConPTY（Win10 1809+），portable-pty 把它
//! 和 Unix 的 forkpty 收成了同一套接口。
//!
//! 两种会话：
//!   · 普通权限 —— ConPTY 就在本进程里，读写端直接挂在 Term 上；
//!   · 管理员  —— ConPTY 必须活在**高完整性进程**里（提权只能发生在进程
//!     创建那一刻，一个进程没法把自己变成管理员）。所以主进程用
//!     ShellExecuteEx(runas) 拉起自己（`--pty-host` 模式），由那个进程建
//!     ConPTY 跑 shell，两边用一条本机 TCP 连接对传字节。
//!
//! 为什么不是命名管道：管道当然更「Windows」，但它要自己写
//! CreateNamedPipeW / ConnectNamedPipe 的 FFI，错误路径全靠返回值猜；
//! 而这里要传的只是字节流，TCP 回环 + 一次性令牌能达到同样的隔离
//! （只绑 127.0.0.1、连上先验令牌），而且**整条协议可以不开 UAC 直接跑**，
//! 这是它最好的一点：helper 的收发、重排、退出都能自动验证。
//!
//! 数据怎么走：
//!   读侧 → base64 分块 → `pty:data` 事件（带 id）→ 前端 xterm 写屏
//!   前端按键 → `pty_write` → pty 写入端（管理员模式走帧协议）
//!   面板尺寸 → `pty_resize` → ConPTY 重排
//!
//! ⚠️ pty 归属**窗口**（`owner`）：主窗内嵌面板和拖出来的独立窗口读写
//! 同一个 pty，拆窗时只改 owner，进程不重启、回滚缓冲不丢。

use base64::Engine as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const CHUNK: usize = 16 * 1024;

/* 帧类型（两个方向共用一套头：1 字节类型 + 4 字节小端长度） */
const F_DATA: u8 = 1;
const F_RESIZE: u8 = 2;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// 写入端：普通会话直接写 pty，管理员会话往 TCP 里塞帧
enum Sink {
    Pty(Box<dyn Write + Send>),
    /// 连上之前是 None：UAC 框还开着时用户不可能已经在打字，
    /// 这期间的数据丢掉即可，不需要缓冲
    Pipe(Arc<Mutex<Option<TcpStream>>>),
}

impl Sink {
    fn data(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        match self {
            Sink::Pty(w) => w.write_all(bytes).and_then(|_| w.flush()),
            Sink::Pipe(cell) => {
                let guard = cell.lock().unwrap_or_else(|p| p.into_inner());
                match guard.as_ref() {
                    Some(s) => {
                        let mut s = s.try_clone()?;
                        write_frame(&mut s, F_DATA, bytes)
                    }
                    None => Ok(()),
                }
            }
        }
    }

    fn resize(&mut self, cols: u16, rows: u16) -> Result<(), AppError> {
        match self {
            Sink::Pty(_) => Ok(()),   // 由 Term 上的 master 直接办
            Sink::Pipe(cell) => {
                let guard = cell.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(s) = guard.as_ref() {
                    let mut s = s.try_clone().map_err(|e| AppError::detail("term.resize", e))?;
                    let mut payload = [0u8; 4];
                    payload[0..2].copy_from_slice(&cols.to_le_bytes());
                    payload[2..4].copy_from_slice(&rows.to_le_bytes());
                    write_frame(&mut s, F_RESIZE, &payload).map_err(|e| AppError::detail("term.resize", e))?;
                }
                Ok(())
            }
        }
    }
}

/// 一个活着的终端会话
pub struct Term {
    sink: Sink,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    /// 当前订阅这路数据的窗口标签。拆窗时改它，读线程每一块都现取。
    owner: Arc<Mutex<String>>,
    pid: Option<u32>,
}

/// 注册表：跨窗口共享（compare / 拆窗窗口都从同一个 app handle 拿）
#[derive(Clone, Default)]
pub struct PtyState(pub Arc<Mutex<HashMap<String, Term>>>);

#[derive(Serialize, Clone)]
struct Chunk {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
}

#[derive(Deserialize)]
pub struct OpenOpts {
    /// 见 `pty_shells` 返回的 id（powershell / pwsh / cmd / bash）
    pub shell: String,
    /// 起始目录；空则用用户主目录
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// 归哪扇窗（主窗是 "main"）
    pub owner: String,
    /// 管理员权限（Windows 上会弹 UAC）
    #[serde(default)]
    pub admin: bool,
}

/* ---------------- 帧协议 ---------------- */

fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut head = [0u8; 5];
    head[0] = kind;
    head[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let n = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    // 上限拦一下：协议自己出的错不该让进程按一个天文数字去分配内存
    if n > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok((head[0], buf))
}

/* ---------------- shell ---------------- */

/// 可用 shell 的 id 列表。前端按这个渲染下拉，缺的不出现（而不是灰着让人纳闷）
#[tauri::command]
pub fn pty_shells() -> Vec<String> {
    ["powershell", "pwsh", "cmd", "bash"]
        .into_iter()
        .filter(|s| shell_program(s).is_some())
        .map(str::to_string)
        .collect()
}

fn shell_program(id: &str) -> Option<String> {
    match id {
        "powershell" => Some("powershell.exe".to_string()),
        "cmd" => Some("cmd.exe".to_string()),
        "pwsh" => which("pwsh.exe").or_else(|| {
            let p = r"C:\Program Files\PowerShell\7\pwsh.exe";
            std::path::Path::new(p).exists().then(|| p.to_string())
        }),
        "bash" => which("bash.exe").or_else(|| {
            let p = r"C:\Program Files\Git\bin\bash.exe";
            std::path::Path::new(p).exists().then(|| p.to_string())
        }),
        _ => None,
    }
}

/// 在 PATH 里找一个可执行文件
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn shell_args(id: &str) -> Vec<String> {
    match id {
        "powershell" | "pwsh" => vec!["-NoLogo".to_string()],
        // 切代码页；`>nul` 把 chcp 自己的提示吞掉，别糊在屏幕第一行
        "cmd" => vec!["/k".to_string(), "chcp".to_string(), "65001>nul".to_string()],
        "bash" => vec!["-i".to_string(), "-l".to_string()],
        _ => Vec::new(),
    }
}

/// 建一个 ConPTY 并起 shell。两种模式（本进程 / 提权 helper）共用这一段。
fn open_session(
    shell: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>, Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>), AppError> {
    let program = shell_program(shell).ok_or_else(|| AppError::new("term.no_shell"))?;
    let size = PtySize {
        // 0 行 0 列会让 ConPTY 报错；面板刚展开时前端可能还没量到尺寸
        rows: rows.max(2),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| AppError::detail("term.spawn", e))?;

    let mut cmd = CommandBuilder::new(program);
    for a in shell_args(shell) {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        let p = std::path::Path::new(dir);
        if p.is_dir() {
            cmd.cwd(p);
        }
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::detail("term.spawn", e))?;
    // 子进程已经拿到它那一端的句柄，这一端留着只会让 ConPTY 以为还有人在等
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::detail("term.spawn", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::detail("term.spawn", e))?;
    Ok((reader, writer, pair.master, child))
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    opts: OpenOpts,
) -> Result<String, AppError> {
    let mut guard = state.0.lock().map_err(|_| AppError::new("state.lock"))?;
    let id = format!("t{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let owner = Arc::new(Mutex::new(opts.owner.clone()));

    if opts.admin {
        /* 提权：先把本进程的监听端准备好，再去拉 helper。
           ShellExecuteEx 会一直卡到用户点掉 UAC —— 取消就从这里返回错误，
           不会留下一个「标签在、进程不在」的空壳。 */
        #[cfg(target_os = "windows")]
        {
            let term = admin::start(&opts)?;
            /* 提权会话没有本地 Child（shell 是另一个进程里的孙子），
               收尾靠 taskkill /PID <helper> /T —— kill_tree 里本来就分两步，
               第一步（Child::kill）在这是空操作，第二步把整棵进程树带走。 */
            guard.insert(
                id.clone(),
                Term {
                    sink: Sink::Pipe(term.writer),
                    master: None,
                    child: None,
                    owner: owner.clone(),
                    pid: Some(term.pid),
                },
            );
            drop(guard);
            spawn_pump(app, state.0.clone(), id.clone(), term.reader, owner);
            return Ok(id);
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(AppError::new("term.no_admin"));
        }
    }

    let (reader, writer, master, child) = open_session(&opts.shell, opts.cwd.as_deref(), opts.cols, opts.rows)?;
    let pid = child.process_id();
    guard.insert(
        id.clone(),
        Term { sink: Sink::Pty(writer), master: Some(master), child: Some(child), owner: owner.clone(), pid },
    );
    /* 读线程在锁外起：它第一件事就要 emit，而 emit 可能反过来等前端 ——
       握着注册表的锁去做这件事，写入端会跟着一起卡住。 */
    drop(guard);
    spawn_pump(app, state.0.clone(), id.clone(), reader, owner);
    Ok(id)
}

/// 读线程：pty（或 TCP）→ 前端。一块一块发，不做行缓冲 ——
/// 全屏程序（vim）靠的就是「一个字节都不许攒着」。
fn spawn_pump(
    app: AppHandle,
    map: Arc<Mutex<HashMap<String, Term>>>,
    id: String,
    mut reader: Box<dyn Read + Send>,
    owner: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = B64.encode(&buf[..n]);
                    let label = owner.lock().map(|s| s.clone()).unwrap_or_default();
                    if !label.is_empty() {
                        let _ = app.emit_to(label.as_str(), "pty:data", Chunk { id: id.clone(), data });
                    }
                }
            }
        }
        /* 结束有三条来路：shell 自己 exit、我们 kill、窗口关了。
           三条都要通知前端（把「运行中」改成「已退出」），并且把自己从
           注册表摘掉 —— 不摘的话每关一个终端就留一个死句柄。 */
        let label = owner.lock().map(|s| s.clone()).unwrap_or_default();
        if !label.is_empty() {
            let _ = app.emit_to(label.as_str(), "pty:exit", ExitPayload { id: id.clone() });
        }
        let mut guard = match map.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        guard.remove(&id);
    });
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: String, data: String) -> Result<(), AppError> {
    let mut guard = state.0.lock().map_err(|_| AppError::new("state.lock"))?;
    let t = guard.get_mut(&id).ok_or_else(|| AppError::new("term.missing"))?;
    t.sink.data(data.as_bytes()).map_err(|e| AppError::detail("term.write", e))
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let mut guard = state.0.lock().map_err(|_| AppError::new("state.lock"))?;
    let t = guard.get_mut(&id).ok_or_else(|| AppError::new("term.missing"))?;
    let size = PtySize { rows: rows.max(2), cols: cols.max(20), pixel_width: 0, pixel_height: 0 };
    /* MasterPty::resize 收 &self：ConPTY 的尺寸是句柄上的属性，不需要可变借用 */
    if let Some(m) = t.master.as_ref() {
        m.resize(size).map_err(|e| AppError::detail("term.resize", e))?;
    }
    t.sink.resize(size.cols, size.rows)
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), AppError> {
    let mut guard = state.0.lock().map_err(|_| AppError::new("state.lock"))?;
    if let Some(mut t) = guard.remove(&id) {
        kill_tree(&mut t);
    }
    Ok(())
}

/// 拆窗：把订阅改到另一扇窗。pty 进程不动，前端那边是一条新的 xterm 重画
#[tauri::command]
pub fn pty_retarget(state: tauri::State<'_, PtyState>, id: String, owner: String) -> Result<(), AppError> {
    let guard = state.0.lock().map_err(|_| AppError::new("state.lock"))?;
    if let Some(t) = guard.get(&id) {
        if let Ok(mut o) = t.owner.lock() {
            *o = owner;
        }
    }
    Ok(())
}
/// 关应用前收干净：否则 powershell.exe 会一批批留在后台
pub fn kill_all(state: &PtyState) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    for (_, mut t) in guard.drain() {
        kill_tree(&mut t);
    }
}

/// 主窗口关了但应用还活着（拆窗窗口还在）时，把它的终端一起收掉
pub fn kill_owned_by(state: &PtyState, label: &str) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let ids: Vec<String> = guard
        .iter()
        .filter(|(_, t)| t.owner.lock().map(|o| o.as_str() == label).unwrap_or(false))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(mut t) = guard.remove(&id) {
            kill_tree(&mut t);
        }
    }
}

/// 杀 shell 及其子孙。`Child::kill` 只结束直接子进程 —— 在 shell 里跑的
/// `npm run dev` 会觉得「关掉了终端怎么还在跑」，所以 Windows 上再补一刀 /T。
fn kill_tree(t: &mut Term) {
    if let Some(c) = t.child.as_mut() {
        let _ = c.kill();
    }
    #[cfg(target_os = "windows")]
    if let Some(pid) = t.pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    if let Some(c) = t.child.as_mut() {
        let _ = c.wait();
    }
}

/* ============================================================
   管理员模式
   ============================================================ */

/// 一次性令牌：只用来证明「连上来的就是我刚拉起的那个 helper」。
/// 不要求密码学强度，但也不能可猜 —— 时间纳秒 + pid 混一次乘法，
/// 够本地同时段不可预测。
fn nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let seed = (n as u64) ^ ((std::process::id() as u64) << 32);
    let x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{x:016x}{:08x}", (n >> 7) as u32)
}

#[cfg(target_os = "windows")]
mod admin {
    use super::*;

    pub struct Started {
        pub reader: Box<dyn Read + Send>,
        pub writer: Arc<Mutex<Option<TcpStream>>>,
        pub pid: u32,
    }

    /// 拉起提权 helper；UAC 被拒绝时返回错误（不会留下空壳会话）
    ///
    /// 用**两条**连接而不是一条 TCP 连接的两个克隆：Windows 上
    /// `TcpStream::try_clone()` 出来的句柄，一个线程阻塞在 recv 时另一个线程
    /// send，实测会拿到 WSAECONNABORTED(10053) —— 连接被本地协议栈掐掉。
    /// 分成「输出一条、输入一条」之后，两边各自只管一个方向，不需要克隆，
    /// 顺带把帧协议省了一半：输出方向就是裸字节流，EOF 即进程结束。
    pub fn start(opts: &OpenOpts) -> Result<Started, AppError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| AppError::detail("term.spawn", e))?;
        let port = listener.local_addr().map_err(|e| AppError::detail("term.spawn", e))?.port();
        let token = nonce();

        let exe = std::env::current_exe().map_err(|e| AppError::detail("term.spawn", e))?;
        let mut args: Vec<String> = vec![
            "--pty-host".to_string(),
            port.to_string(),
            token.clone(),
            opts.shell.clone(),
            opts.cols.to_string(),
            opts.rows.to_string(),
        ];
        if let Some(d) = opts.cwd.as_deref().filter(|d| !d.is_empty()) {
            args.push(d.to_string());
        }

        /* 测试缝：自动化测试里没人能点 UAC，设了这个环境变量就直接
           （不提权地）拉起 helper。它只会让权限**更低**，不是后门；
           而且提权那一步本身只是一句 ShellExecuteExW，链路上真正会出错的
           是握手、两条连接、帧格式和收尾，那些在没有 UAC 的这一侧同样走一遍。 */
        let pid = if std::env::var_os("EZNOTEPAD_PTY_NO_ELEVATE").is_some() {
            spawn_plain(&exe, &args)?
        } else {
            shell_execute_runas(&exe, &args)?
        };

        let out = accept_with_token(&listener, &token)?;
        let mut inp = accept_with_token(&listener, &token)?;
        // 两条都验过才放行：helper 收到这个才会去建 ConPTY
        inp.write_all(b"ok").map_err(|e| AppError::detail("term.spawn", e))?;

        Ok(Started { reader: Box::new(out), writer: Arc::new(Mutex::new(Some(inp))), pid })
    }

    /// 接一条连接并验令牌。不匹配的连接直接丢弃再等 —— 端口是随机开的，
    /// 真有别人连上来也拿不到令牌。
    fn accept_with_token(listener: &TcpListener, token: &str) -> Result<TcpStream, AppError> {
        for _ in 0..8 {
            let (s, _) = listener.accept().map_err(|e| AppError::detail("term.spawn", e))?;
            let mut r = s;
            let (kind, tok) = match read_frame(&mut r) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if kind == F_DATA && String::from_utf8_lossy(&tok) == token {
                return Ok(r);
            }
        }
        Err(AppError::new("term.bad_helper"))
    }

    /// 不提权地拉起 helper（只给测试用，见 `start()` 里的说明）
    fn spawn_plain(exe: &std::path::Path, args: &[String]) -> Result<u32, AppError> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = std::process::Command::new(exe)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| AppError::detail("term.spawn", e))?;
        // 句柄一丢进程照跑；收尾靠 kill_tree 里的 taskkill /T
        Ok(child.id())
    }

    /// ShellExecuteExW + "runas"，返回新进程 pid
    fn shell_execute_runas(exe: &std::path::Path, args: &[String]) -> Result<u32, AppError> {
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS};

        /* ShellExecuteEx 只收一整条命令行，所以带空格的参数（cwd）要自己加引号。
           我们的参数里不会有引号字符，按「含空白就整体包裹」处理就够。 */
        let quote = |a: &str| -> String {
            if a.is_empty() || a.contains(|c: char| c.is_whitespace()) {
                format!("\"{a}\"")
            } else {
                a.to_string()
            }
        };
        let params = args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");

        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let file = wide(&exe.to_string_lossy());
        let verb = wide("runas");
        let args = wide(&params);

        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = args.as_ptr();
        // SW_SHOWNORMAL：helper 自己不建窗口，这里只是别让它以最小化启动
        info.nShow = 1;

        let ok = unsafe { ShellExecuteExW(&mut info) };
        if ok == 0 {
            // 用户在 UAC 上点「否」也走这里（ERROR_CANCELLED = 1223）
            let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            return Err(if code == 1223 {
                AppError::new("term.elevate_cancelled")
            } else {
                /* detail 要一直有：模板是「无法以管理员身份启动终端：{detail}」，
                   留空会剩一个孤零零的冒号 */
                AppError::detail("term.elevate", format!("Win32 {code}"))
            });
        }
        use windows_sys::Win32::System::Threading::GetProcessId;
        let pid = unsafe { GetProcessId(info.hProcess) };
        if pid == 0 {
            return Err(AppError::detail("term.elevate", "GetProcessId = 0"));
        }
        Ok(pid)
    }
}

/* ============================================================
   helper：`EZNotepad.exe --pty-host <port> <token> <shell> <cols> <rows> [cwd]`
   这个模式不建窗口、不跑 Tauri，只把 ConPTY 和那条 TCP 连起来。
   ============================================================ */

pub struct HostArgs {
    port: u16,
    token: String,
    shell: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
}

/// 命令行是不是 helper 模式；是就把参数解出来
pub fn host_args<I: Iterator<Item = String>>(argv: I) -> Option<HostArgs> {
    let mut it = argv;
    if it.next()? != "--pty-host" {
        return None;
    }
    let port = it.next()?.parse().ok()?;
    let token = it.next()?;
    let shell = it.next()?;
    let cols = it.next().and_then(|s| s.parse().ok()).unwrap_or(120);
    let rows = it.next().and_then(|s| s.parse().ok()).unwrap_or(30);
    let cwd = it.next().filter(|s| !s.trim().is_empty());
    Some(HostArgs { port, token, shell, cols, rows, cwd })
}

/// helper 主体：连回主进程 → 建 ConPTY → 双向搬字节，shell 退出就收工
pub fn run_host(args: HostArgs) -> ! {
    let code = run_host_inner(args).unwrap_or(1);
    std::process::exit(code);
}

/// helper 主体：连回主进程 → 建 ConPTY → 双向搬字节，shell 退出就收工
///
/// 两条连接各管一个方向（见 admin::start 的注释）：`out` 只写（pty 的输出），
/// `inp` 只读（按键与重排），谁都不用 try_clone。
fn run_host_inner(args: HostArgs) -> Option<i32> {
    let mut out = TcpStream::connect(("127.0.0.1", args.port)).ok()?;
    write_frame(&mut out, F_DATA, args.token.as_bytes()).ok()?;

    let mut inp = TcpStream::connect(("127.0.0.1", args.port)).ok()?;
    write_frame(&mut inp, F_DATA, args.token.as_bytes()).ok()?;

    // 主进程验完两条连接的令牌才回 "ok"：没这个就不该起 shell
    let mut ack = [0u8; 2];
    inp.read_exact(&mut ack).ok()?;
    if &ack != b"ok" {
        return Some(1);
    }

    let (mut from_pty, mut to_pty, master, child) =
        open_session(&args.shell, args.cwd.as_deref(), args.cols, args.rows).ok()?;
    let _child = child;   // 只要它活着（句柄一关 ConPTY 就以为 shell 没了）

    /* 重排必须在这一侧做：ConPTY 的 master 在这个进程手里，
       主进程只能通过帧告诉我们「现在是 140×40」。resize 收 &self，
       所以整个 master 直接搬进线程就够了，不用再套一层锁。 */
    std::thread::spawn(move || loop {
        match read_frame(&mut inp) {
            Ok((F_DATA, data)) => {
                if to_pty.write_all(&data).is_err() {
                    break;
                }
                let _ = to_pty.flush();
            }
            Ok((F_RESIZE, p)) if p.len() == 4 => {
                let cols = u16::from_le_bytes([p[0], p[1]]).max(20);
                let rows = u16::from_le_bytes([p[2], p[3]]).max(2);
                let _ = master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 });
            }
            _ => break,
        }
    });

    let mut buf = vec![0u8; CHUNK];
    loop {
        match from_pty.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.write_all(&buf[..n]).is_err() {
                    break;
                }
                let _ = out.flush();
            }
        }
    }
    Some(0)
}
