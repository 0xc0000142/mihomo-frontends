#!/bin/sh
# 模板单一来源在仓库根的 shared/template.yaml，本脚本同步到 luci 的 root/ 下。
# build-apk.sh、deploy.sh、tests/preview/snapshot.sh 运行前都会调用。
set -e
cd "$(dirname "$0")/.."
SRC=../shared/template.yaml
DST=root/usr/share/mihomo-luci/template.yaml
if [ ! -f "$SRC" ]; then
	echo "缺少 $SRC（模板应放在仓库根的 shared/ 下）" >&2
	exit 1
fi
if ! cmp -s "$SRC" "$DST" 2>/dev/null; then
	mkdir -p "$(dirname "$DST")"
	cp "$SRC" "$DST"
	echo "已同步模板 shared/template.yaml → $DST"
fi
