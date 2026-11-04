#!/bin/sh
# 在 Windows 的 Git Bash 里运行：把后端测试交给 WSL（archlinux）执行，不需要路由器。
# 用法：sh tests/run-local.sh [test_xxx.uc ...]；首次运行会在 WSL 的 ~/.cache/mh-tools 编译 ucode、yq 与 mihomo。
# MH_SKIP_SETUP=1 跳过工具检查。
cd "$(dirname "$0")/.."
DISTRO=${WSL_DISTRO:-archlinux}
DIR=$(wsl -d "$DISTRO" -- wslpath -a "$(pwd -W)")
# 关闭 Git Bash 的路径转换，否则 /mnt/... 会被改写成 Windows 路径
MSYS_NO_PATHCONV=1 exec wsl -d "$DISTRO" -- env MH_SKIP_SETUP="$MH_SKIP_SETUP" sh "$DIR/tests/local/main.sh" "$@"
