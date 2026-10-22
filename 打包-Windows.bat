@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 简单记事本 - Windows 打包
cd /d "%~dp0"

echo ============================================================
echo   简单记事本 - Windows 打包
echo ============================================================

set MISS=0

where node >nul 2>nul
if errorlevel 1 (
    echo [X] 未检测到 Node.js
    echo     下载: https://nodejs.org  ^(选 LTS^)
    set /a MISS+=1
) else (
    for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v
)

where cargo >nul 2>nul
if errorlevel 1 (
    echo [X] 未检测到 Rust
    echo     下载: https://rustup.rs
    set /a MISS+=1
) else (
    for /f "delims=" %%v in ('rustc -V') do echo [OK] %%v
)

:: 检测 C++ 生成工具（link.exe 不一定在 PATH 中，改用 vswhere 查安装路径）
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if exist "!VSWHERE!" (
    for /f "delims=" %%p in ('"!VSWHERE!" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul') do set VCPATH=%%p
    if defined VCPATH (
        echo [OK] C++ 生成工具: !VCPATH!
    ) else (
        echo [X] 未检测到 Visual Studio C++ 生成工具
        echo     下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/
        echo     安装时勾选「使用 C++ 的桌面开发」，右侧务必包含 Windows SDK
        set /a MISS+=1
    )
) else (
    echo [X] 未检测到 Visual Studio Installer，C++ 生成工具很可能没装
    echo     下载: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    set /a MISS+=1
)

if !MISS! GTR 0 (
    echo.
    echo ============================================================
    echo   环境不完整，缺少 !MISS! 项。可先双击 环境检查-Windows.bat 看详情
    echo ============================================================
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo [..] 未检测到 pnpm，自动安装...
    call npm install -g pnpm
)

echo.
echo [1/2] 安装前端依赖...
call pnpm install
if errorlevel 1 (echo [X] 依赖安装失败 & pause & exit /b 1)

echo.
echo [2/2] 编译打包（首次约 5-10 分钟，会从 GitHub 下载 NSIS，需联网）...
call pnpm tauri build
if errorlevel 1 (echo [X] 打包失败，请把上面的报错发给我 & pause & exit /b 1)

echo.
echo ============================================================
echo   完成！产物位置：
echo     安装版：src-tauri\target\release\bundle\nsis\
echo     免安装：src-tauri\target\release\simple-notepad.exe
echo ============================================================
if exist "src-tauri\target\release\bundle\nsis" explorer "src-tauri\target\release\bundle\nsis"
pause
