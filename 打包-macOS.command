#!/bin/bash
# 双击运行即可打包 macOS 版（.app + .dmg）
# 默认 Apple 芯片；Intel 或通用包用环境变量：
#   EZ_ARCH=x86_64  ./打包-macOS.command
#   EZ_ARCH=universal ./打包-macOS.command
cd "$(dirname "$0")" || exit 1

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
  echo "[提示] 正在安装 Xcode 命令行工具，装完后重跑本脚本"
  xcode-select --install
  read -p "按回车退出"; exit 1
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm

ARCH="${EZ_ARCH:-aarch64}"
case "$ARCH" in
  aarch64)   TARGET="aarch64-apple-darwin";  RUST_TARGETS="aarch64-apple-darwin" ;;
  x86_64)    TARGET="x86_64-apple-darwin";   RUST_TARGETS="x86_64-apple-darwin" ;;
  universal) TARGET="universal-apple-darwin"; RUST_TARGETS="aarch64-apple-darwin x86_64-apple-darwin" ;;
  *) echo "[错误] EZ_ARCH 只能是 aarch64 / x86_64 / universal"; read -p "按回车退出"; exit 1 ;;
esac
echo "      架构：$ARCH  →  $TARGET"

echo ""
echo "[1/3] 安装 Rust 目标..."
# universal 要两个 target 都装好，否则 tauri build 直接报缺 lipo 输入
rustup target add $RUST_TARGETS || { echo "Rust 目标安装失败"; read -p "按回车退出"; exit 1; }

echo ""
echo "[2/3] 安装前端依赖..."
pnpm install --frozen-lockfile || { echo "依赖安装失败"; read -p "按回车退出"; exit 1; }

echo ""
echo "[3/3] 编译打包（首次约 5-10 分钟）..."
pnpm exec tauri build --target "$TARGET" --bundles app,dmg || { echo "打包失败"; read -p "按回车退出"; exit 1; }

OUT="src-tauri/target/$TARGET/release/bundle"
echo ""
echo "============================================"
echo "  完成！产物位置："
echo "  $OUT/dmg/     （安装镜像 dmg）"
echo "  $OUT/macos/   （免安装 app）"
echo ""
echo "  未签名未公证：本机首次打开用「右键 → 打开」；"
echo "  要分发给他人，需 Apple 开发者账号配置签名 + 公证。"
echo "============================================"
open "$OUT"
read -p "按回车退出"
