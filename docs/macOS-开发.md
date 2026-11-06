# macOS 独立分支开发笔记

> **分支**：`platform/macos`，从 `main` 的 1.1.10 切出。
> **定位**：独立产品线，**不回合并 main**。业务需求与 Windows 版一致，
> 但允许为平台差异改动配置与外壳，不必顾虑对 main 的兼容。
> 这份文件是**分支工作笔记**，不参与「四份正式文档各司其职」的约束；
> 功能承诺仍以《功能设计》为准，移植清单仍以《实现规格》§10.4 为准。

## 一、必须承认的一个限制

开发机是 Windows，没有 macOS SDK，`*-apple-darwin` 目标**无法在本机编译，
也无法运行真机探针**。所以：

- Rust 里的 `#[cfg(target_os = "macos")]` 分支在本机**不会被类型检查**；
- `tauri.conf.json` 的 `titleBarStyle` / `bundle.targets` 在本机**不会被校验**；
- 交通灯、WKWebView 的剪贴板/拖放/打印行为在本机**看不到**。

真实的编译验证靠 `.github/workflows/macos-check.yml`：推一次分支，
`macos-latest` 会 `tauri build --target aarch64-apple-darwin --bundles app`
并断言 `EZNotepad.app` 真的生成。**改了配置或 Rust 一定要看这条 CI，
不要只看本机的绿条。**

保留 Windows 的 `#[cfg]` 分支不是舍不得删，而是删掉之后本机就完全失去
回归能力了：共用代码（约 1.4 万行前端 + 大部分 Rust 命令）改坏了没人报。
现在本机离线套件与真机探针仍可全量跑。

## 二、已完成

### M1 能编译打包

| 项 | 改动 |
|---|---|
| 打包目标 | `bundle.targets`: `["nsis"]` → `["app","dmg"]`，删掉 NSIS / WebView2 安装段 |
| 交通灯 | 主窗口 `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`；前端 `html[data-os="mac"]` 隐藏自绘 `-□×`、标题栏左留 88px |
| 最低系统 | `11.0`（WKWebView 的分页打印 API 需要 11+；10.15 上会缺功能） |
| WebView2 参数 | **保留** `additionalBrowserArgs`（`--disable-gpu-sandbox`）：wry 在非 Windows 平台用 `#[cfg(windows)]` 包着、会忽略它；但删掉之后本机 Windows 上第二个 WebView 就创建不出来（见下「踩过的坑」） |
| 构建入口 | `打包-macOS.command` 支持 `EZ_ARCH=aarch64/x86_64/universal`，自动 `rustup target add`；`package.json` 加 `build:mac:arm` / `build:mac:intel` |
| CI | `macos-check.yml`（推分支即真机编译）、`release.yml` 换成 macOS 通用包发版 |

### M2 数据安全与文件打开

| 项 | 改动 |
|---|---|
| 删除进废纸篓 | 非 Windows 分支从 `fs::remove_file`（**永久删除**）换成 `trash` crate；macOS 走 `NSFileManager.trashItemAtURL`，「放回原处」元数据不丢。错误模板统一成 `{detail}` |
| 编码回退 | 非法 UTF-8 不再一律按 GB18030 解（会解出假中文、一存就毁原文件）：Windows 仍 GBK，macOS/Linux 回退 `windows-1252`，并加进「重新打开 / 另存为」编码选项 |
| Finder 双击打开 | `RunEvent::Opened { urls }` 接住 Apple Event。`OpenedFiles` 状态按「前端有没有来取过 `initial_files`」分两路：没取过先暂存，取过了直接 emit `open-files`，**互斥，不会开两次标签**；前端一行没改 |
| 文件名校验 | Windows 那串 `<>:"\|?*` 不再照搬（APFS 上大多是合法字符），macOS 只禁 `:` 与 NUL |
| POSIX 绝对路径 | `resolveDocImg` 认 `/Users/...` 和 UNC，不再拼成相对路径 |
| ⌘Q 守卫 | `RunEvent::ExitRequested` 拦下应用级退出，emit `app-exit-request`，前端跑完同一套 `confirmQuit` 守卫才调 `confirm_app_exit` 放行；有放行标记，不会和 `app.exit()` 死循环 |

### M3 / M5 外壳与文案

- `enable_macos_default_menu(false)`：去掉系统默认菜单，保留自绘菜单栏（它承载动态「最近打开」、勾选状态、右键药丸行，换成原生菜单会丢功能）。⌘Q 由上面的守卫承接。
- 工具窗口：不再写死 `(0,0,1280,860)`（macOS 坐标原点不同、会压在菜单栏下），改成 `.center()` + 出生即 `maximized(true)`，与前端 `filled=true` 的初值一致。
- **快捷键显示**：`i18n.js` 里加唯一的平台渲染出口 —— `kbdToCombo()` / `kbdLabel()` / `localizeShortcuts()`。数据层仍写 `Ctrl+S`，mac 上显示 `⌘S`；菜单、右键、命令面板、帮助表、HTML title、九语言词条、欢迎文档全部走这一处。按键匹配层依旧 `ctrlKey || metaKey`，没有行为分叉。
- 按键行为**本来就是跨平台的**，这部分一行没动（CM6 用 `Mod-` 抽象，17 处 `ctrlKey` 都配了 `metaKey`）。

## 三、未完成（别当成已支持）

### M4：导出 PDF —— **目前返回「这个平台还不支持导出 PDF」**

这不是遗漏，是没有目标机器就不能假装做完了。

已确认的 API（`objc2-web-kit 0.3.2` / `objc2 0.6.5`，与 wry 传递依赖同版本）：
`with_webview(|wv| &*wv.inner().cast::<WKWebView>())` 能拿到 WKWebView，
`createPDFWithConfiguration_completionHandler` 给一个 `NSData`（需要
`WKPDFConfiguration` + `block2` + `objc2-app-kit` features，macOS 11+）。

**但这个方法生成的是当前页面 bounds 的单页 PDF**，而 Windows 版
`ICoreWebView2_7::PrintToPdf` 走完整打印管线、按 CSS `@page` 分页成多页 A4。
直接换上去，用户拿到的是一张长图 —— 看着像能用，实际不是同一个功能。

要真正对齐，得走 `WKWebView.printOperation(with:)` → `NSPrintOperation`
设 `NSPrintJobSavingURL` 落盘，并在 Mac 上验证分页、页边距（一律由 `@page` 给，
不读系统打印设置）、背景色（代码块底色要打出来）。
前端 `pdf.js` 的 `exportPdfTo(path, tab)` 与 `@media print` 规则都不用改，
平台差异只落在 `export_pdf` 这一条命令里。

⛔ 不要用「命令返回成功但没生成文件」或「改成导出 HTML」来假装支持。
宁可明确说不支持，也不给用户一个空文件或名不副实的菜单项。

### M3 真机回归（本轮只能写方案，不能验）

- `decorations:true` + Overlay 下 `data-tauri-drag-region` 是否仍可拖窗口；
- 交通灯的实际占位（88px 是估值，Retina / 全屏下要量）；
- 双击标题栏最大化、四边缩放、F11、专注模式、深浅色切换；
- 工具窗口仍是 `decorations(false)` + 自绘按钮（`WebviewWindowBuilder` 没有
  `titleBarStyle` 的 Rust setter），**没有交通灯**。要么接受，要么用
  `from_config` 或 wry 拿 `NSWindow` 补 Overlay —— 这是 M3 已知差异；
- WKWebView 下要逐一回归：原生拖放真实路径、`navigator.clipboard.writeText`
  （Windows 上会抛 NotAllowedError，项目已走 `execCommand` 兜底）、
  CSS Custom Highlight、canvas `roundRect`。

### M6 分发

- 未签名、未公证：`bundle.macOS.signingIdentity` / `entitlements` 没配，
  CI 里也没放 5 个 secrets。首次打开要「右键 → 打开」或 `xattr -cr`。
- 九份 `README*.md` 仍写 "Windows x64 only" 且快捷键表是 Ctrl，尚未按平台更新。
- 真机测试套件 `test/real/*.ps1` 是 Windows UIA 专用，Mac 上要用
  AppleScript / `cliclick` / `screencapture` 重写输入层（断言层 CDP 可复用）。

### 踩过的坑：`--disable-gpu-sandbox` 不能顺手删

一开始为了「清理 Windows 专属配置」把主窗口的 `additionalBrowserArgs` 从
`tauri.conf.json` 去掉了，结果本机真机探针里**第一次创建对比窗口就失败**：

```
WebView2 error: WindowsError(HRESULT(0x8007139F), "组或资源的状态不是执行请求操作的正确状态")
```

主窗口能起，第二个 WebView 起不来 —— 工具窗口自己还带着那串参数，两个 WebView
的 GPU 沙箱设置不一致。做了三轮对照才锁定（换回 `decorations` 无效、换回
`lib.rs` 无效、换回完整 main 配置才通过）。

结论：**平台专属字段不等于可以删**。wry 在 macOS 上本来就忽略这个字段，
留着零成本；删掉却让 Windows 回归环境直接失去对比窗口，测不出真问题。
分支自检 `test/run-macos.mjs` 里有一条断言专门钉住它。

## 四、在 Mac 上逐条勾

```
[ ] pnpm install --frozen-lockfile && pnpm tauri dev  起窗口，界面不闪白
[ ] 冷启动 < 2s；打开 UTF-8 / BOM / CRLF / GBK 各一份，保存后字节不变
[ ] 一份 Latin-1 文件打开不是中文乱码，状态栏显示 WINDOWS-1252
[ ] 删掉一个文件，废纸篓里找得到，右键「放回原处」可用
[ ] Finder 双击 .md：未启动时能开；已启动时在**已有窗口**新开标签，不重复
[ ] ⌘Q 弹出未保存确认；取消后应用还在；确认后真的退出
[ ] ⌘S / ⌘O / ⌘P 菜单里显示的是 ⌘ 而不是 Ctrl，按下去有效
[ ] 标题栏：交通灯不被品牌标挡住、拖标题栏能移动、双击最大化、四边能缩放
[ ] /Users/me/a.png 这类绝对路径图片能显示
[ ] 拖文档开标签、拖图片落 assets/
[ ] 文本对比 / 文件夹对比窗口：出生是最大化、按钮图标与实际状态一致
[ ] pnpm exec tauri build --target aarch64-apple-darwin --bundles app,dmg 出包
```

## 五、常用命令

```bash
# 本机（Windows）：只验证共用代码没被改坏
cargo check
node test/run.mjs && node test/run-app.mjs && node test/run-probe.mjs

# Mac：开发 / 打包
pnpm tauri dev
./打包-macOS.command                      # 默认 aarch64
EZ_ARCH=universal ./打包-macOS.command   # 通用包
```
