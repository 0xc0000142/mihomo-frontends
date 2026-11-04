#!/bin/sh
# 本机测试用的 apply-job：用 setup.sh 编译的 ucode 和仓库里的模块运行（环境变量由 main.sh 导出，经 setsid 继承）
exec $UCODE $UCODE_ARGS "$MLT_REPO/root/usr/libexec/mihomo-luci/apply-job" "$@"
