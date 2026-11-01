#!/bin/bash
# 双击运行即可打包 macOS 版（.dmg + .app）
cd "$(dirname "$0")"

echo "============================================"
echo "  EZNotepad - macOS 打包"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org"
  read -p "按回车退出"; exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "[错误] 未检测到 Rust，请执行：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  read -p "按回车退出"; exit 1
fi
if ! xcode-select -p >/dev/null 2>&1; then
  echo "[提示] 正在安装 Xcode 命令行工具..."
  xcode-select --install
fi

command -v pnpm >/dev/null 2>&1 || npm install -g pnpm

echo ""
echo "[1/2] 安装依赖..."
pnpm install || { echo "依赖安装失败"; read -p "按回车退出"; exit 1; }

echo ""
echo "[2/2] 编译打包（首次约 5-10 分钟）..."
pnpm tauri build || { echo "打包失败"; read -p "按回车退出"; exit 1; }

echo ""
echo "============================================"
echo "  完成！产物位置："
echo "  src-tauri/target/release/bundle/dmg/     （安装镜像 dmg）"
echo "  src-tauri/target/release/bundle/macos/   （免安装 app）"
echo "============================================"
open src-tauri/target/release/bundle
read -p "按回车退出"
