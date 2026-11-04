#!/system/bin/sh
# 安装时由 magiskboot 环境执行。ABI 变量由安装器给出。
ui_print "- 安装 mihomo（smart + eBPF）模块"

case "$ARCH" in
  arm64|x64) ;;
  *)
    ui_print "! 仅支持 arm64 / x86_64，当前架构：$ARCH"
    abort
    ;;
esac

ui_print "- 内核二进制不随模块分发，装好后在 WebUI「内核」页下载"
