#!/bin/sh
# 在 Linux（如 WSL）里编译 apk-tools，版本与 OpenWrt 25.12 固件相同（3.0.5），供 build-apk.sh 调用 apk mkpkg。
# 结果放在 ~/.cache/mh-tools/bin/apk（MH_TOOLS 可改）；已存在则跳过。需要 gcc、ninja、python3 与 openssl/zlib/zstd 开发文件。
set -e
TOOLS=${MH_TOOLS:-$HOME/.cache/mh-tools}
APK_REV=v3.0.5
if [ -x $TOOLS/bin/apk ]; then
	echo "已存在：$TOOLS/bin/apk"
	exit 0
fi
mkdir -p $TOOLS/bin
# meson 用独立的 venv 安装，不改动系统
[ -x $TOOLS/venv/bin/meson ] || { python3 -m venv $TOOLS/venv && $TOOLS/venv/bin/pip install -q meson; }
[ -d $TOOLS/apk-src ] || git clone -q https://gitlab.alpinelinux.org/alpine/apk-tools.git $TOOLS/apk-src
git -C $TOOLS/apk-src checkout -q $APK_REV
cd $TOOLS/apk-src
rm -rf build
$TOOLS/venv/bin/meson setup build -Ddocs=disabled -Dhelp=disabled -Dlua=disabled -Dtests=disabled \
	-Dcrypto_backend=openssl -Ddefault_library=static >/dev/null
ninja -C build >/dev/null
cp build/src/apk $TOOLS/bin/apk
$TOOLS/bin/apk --version
