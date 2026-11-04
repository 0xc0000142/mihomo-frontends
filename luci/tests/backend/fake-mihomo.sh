#!/bin/sh
# 假内核（内核管理测试用，由 test_core.uc 替换 @VERSION@ 与 @MODE@ 后发布）：
# -v 打印版本；-t 校验配置（文件含 FAKE_INVALID 时失败）；其他参数时常驻，@MODE@ 为 exit 时立刻退出
VERSION='@VERSION@'
MODE='@MODE@'
file= prev=
for a in "$@"; do
	[ "$prev" = "-f" ] && file=$a
	prev=$a
done
for a in "$@"; do
	case "$a" in
		-v) echo "Mihomo Meta $VERSION linux test with go1.26 unknown time"; exit 0 ;;
		-t)
			if [ -n "$file" ] && grep -q FAKE_INVALID "$file"; then
				echo 'time="x" level=error msg="fake: invalid config"'
				exit 1
			fi
			echo "configuration file $file test is successful"
			exit 0 ;;
	esac
done
[ "$MODE" = exit ] && exit 1
exec sleep 100000
