@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title EZNotepad - Windows 构建环境检查
cd /d "%~dp0"

echo ============================================================
echo   EZNotepad - Windows 构建环境检查
echo ============================================================
echo.

set FAIL=0
set WARN=0

:: ---------- 1. 系统版本 ----------
echo [1/6] 操作系统
for /f "tokens=4-5 delims=. " %%i in ('ver') do set WINVER=%%i.%%j
echo      Windows !WINVER!
echo.

:: ---------- 2. Node.js ----------
echo [2/6] Node.js（需要 ^>= 18）
where node >nul 2>nul
if errorlevel 1 (
    echo      [X] 未安装
    echo          请到 https://nodejs.org 下载 LTS 版本安装
    set /a FAIL+=1
) else (
    for /f "delims=" %%v in ('node -v 2^>nul') do echo      [OK] %%v
)
echo.

:: ---------- 3. pnpm ----------
echo [3/6] pnpm（包管理器）
where pnpm >nul 2>nul
if errorlevel 1 (
    echo      [!] 未安装，自动执行: npm install -g pnpm
    call npm install -g pnpm >nul 2>nul
    where pnpm >nul 2>nul
    if errorlevel 1 (
        echo      [X] 自动安装失败，请手动运行: npm install -g pnpm
        set /a FAIL+=1
    ) else (
        echo      [OK] 已安装
    )
    set /a WARN+=1
) else (
    for /f "delims=" %%v in ('pnpm -v 2^>nul') do echo      [OK] %%v
)
echo.

:: ---------- 4. Rust ----------
:: 注意：下面所有 if/else 块必须整块解析，不能出现空 else，且 !VAR! 只在已赋值时使用
echo [4/6] Rust（需要 MSVC 工具链）
where rustc >nul 2>nul
if errorlevel 1 (
    echo      [X] 未安装
    echo          请到 https://rustup.rs 下载 rustup-init.exe 安装
    echo          安装时默认选项即可（会选 x86_64-pc-windows-msvc）
    set /a FAIL+=1
) else (
    for /f "delims=" %%v in ('rustc -V 2^>nul') do echo      [OK] %%v
    for /f "delims=" %%t in ('rustup show active-toolchain 2^>nul') do (
        echo      [i] %%t
        echo %%t | findstr /i "msvc" >nul
        if errorlevel 1 (
            echo      [!] 当前不是 MSVC 工具链，请执行:
            echo          rustup default stable-x86_64-pc-windows-msvc
            set /a FAIL+=1
        )
    )
)
echo.

:: ---------- 5. MSVC 链接器（最常见的坑） ----------
echo [5/6] Visual Studio C++ 生成工具（MSVC 链接器 link.exe）
where link.exe >nul 2>nul
if errorlevel 1 (
    echo      [!] 当前命令行环境里找不到 link.exe
    echo          这不一定是没装 —— 需要确认已安装以下工作负载：
    echo            "使用 C++ 的桌面开发" + Windows 10/11 SDK
    echo.
    echo          检查是否已安装:
    if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
        "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>nul
        if errorlevel 1 (
            echo          [X] 未检测到 C++ 生成工具，必须安装
            set /a FAIL+=1
        ) else (
            echo          [OK] 已安装 C++ 生成工具
            echo          [i] 提示：打包时 Tauri 会自动调用 vcvars，无需手动配置
        )
    ) else (
        echo          [X] 未检测到 Visual Studio Installer
        set /a FAIL+=1
    )
    echo.
    echo          安装地址: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo          勾选「使用 C++ 的桌面开发」，右侧确保包含 Windows SDK
) else (
    for /f "delims=" %%v in ('where link.exe') do echo      [OK] %%v
)
echo.

:: ---------- 6. WebView2 ----------
echo [6/6] WebView2 运行时
set WV2=
if exist "%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application" set WV2=1
if exist "%ProgramFiles%\Microsoft\EdgeWebView\Application" set WV2=1
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" >nul 2>nul && set WV2=1
reg query "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" >nul 2>nul && set WV2=1
if defined WV2 (
    echo      [OK] 已安装（Windows 11 自带）
) else (
    echo      [!] 未检测到 WebView2 运行时
    echo          不影响打包（安装包会自动下载），但本机运行需要它
    echo          下载: https://developer.microsoft.com/microsoft-edge/webview2/
    set /a WARN+=1
)
echo.

:: ---------- 汇总 ----------
echo ============================================================
if %FAIL%==0 (
    echo   结论：必需环境齐全，可以直接打包
    if %WARN% gtr 0 echo   （有 %WARN% 项提醒，见上方 [!]）
    echo.
    echo   接下来：双击 打包-Windows.bat
) else (
    echo   结论：缺少 %FAIL% 项必需环境，请按上面 [X] 的提示安装后重跑本脚本
)
echo ============================================================
echo.
pause
