#!/bin/bash
# 妄想天使桌宠 - macOS 启动器（Finder 里双击即可）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装：https://nodejs.org 或 brew install node"
  read -r -p "按回车键关闭…" _
  exit 1
fi

# 首次运行自动安装依赖
if [ ! -d node_modules/electron ]; then
  echo "首次运行：正在安装依赖，请稍候…"
  npm install || { echo "依赖安装失败"; read -r -p "按回车键关闭…" _; exit 1; }
fi

echo "启动妄想天使桌宠…（关闭本窗口不会退出桌宠；退出请用菜单栏托盘图标）"
exec npx electron . >/dev/null 2>&1 &
sleep 2
