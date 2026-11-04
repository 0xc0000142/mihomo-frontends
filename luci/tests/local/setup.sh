#!/bin/sh
# 在 WSL（archlinux）里准备本机后端测试所需的工具，放在 ~/.cache/mh-tools（WSL 的 /tmp 在重启后会清空），已存在则跳过；删除该目录即可清理：
# - ucode：与 OpenWrt 25.12 固件相同的提交 85922056，只编译 fs、io、math、socket、struct、log 模块
# - yq 4.54.1（与路由器相同）
# - mihomo-ebpf：从本机的分支仓库编译（MIHOMO_SRC，默认 /mnt/e/repos/mihomo），只读取源码
# - geo 数据：从 MH_GEO_DIR（默认 Mihomo Party 的 work 目录）复制到 geo/
# 下载 Go 模块不顺时可复用 Windows 上的模块缓存，例如：
#   env -u https_proxy GOPROXY=file:///mnt/c/Users/<用户>/go/pkg/mod/cache/download,https://goproxy.cn,direct GOSUMDB=off sh setup.sh
set -e
TOOLS=${MH_TOOLS:-$HOME/.cache/mh-tools}
UCODE_REV=85922056
MIHOMO_SRC=${MIHOMO_SRC:-/mnt/e/repos/mihomo}
export GOPATH=$TOOLS/go GOMODCACHE=$TOOLS/go/mod GOCACHE=$TOOLS/go/cache GOFLAGS=-modcacherw CGO_ENABLED=0
mkdir -p $TOOLS

if [ ! -x $TOOLS/bin/ucode ]; then
	[ -d $TOOLS/src ] || git clone -q https://github.com/jow-/ucode $TOOLS/src
	git -C $TOOLS/src checkout -q $UCODE_REV
	mkdir -p $TOOLS/src/build
	cd $TOOLS/src/build
	cmake .. -DCMAKE_INSTALL_PREFIX=$TOOLS -DCMAKE_C_FLAGS=-Wno-error=discarded-qualifiers \
		-DUBUS_SUPPORT=OFF -DUCI_SUPPORT=OFF -DULOOP_SUPPORT=OFF -DRTNL_SUPPORT=OFF -DNL80211_SUPPORT=OFF \
		-DRESOLV_SUPPORT=OFF -DDIGEST_SUPPORT=OFF -DZLIB_SUPPORT=OFF -DFFI_SUPPORT=OFF -DSERIAL_SUPPORT=OFF \
		-DDEBUG_SUPPORT=OFF >/dev/null
	make -j8 >/dev/null
	make install >/dev/null
fi

[ -x $TOOLS/go/bin/yq ] || go install github.com/mikefarah/yq/v4@v4.54.1

if [ ! -x $TOOLS/bin/mihomo-ebpf ]; then
	cd $MIHOMO_SRC
	go build -buildvcs=false -trimpath -tags "with_gvisor with_ebpf" \
		-ldflags "-s -w -X github.com/metacubex/mihomo/constant.Version=alpha-smart-local-ebpf" \
		-o $TOOLS/bin/mihomo-ebpf .
fi

# geo 数据（模板的 GEOSITE/GEOIP 规则校验要用）：从本机已有的 mihomo 目录复制，找不到时测试会让内核自行下载
GEO_SRC=${MH_GEO_DIR:-$(ls -d /mnt/c/Users/*/AppData/Roaming/mihomo-party/work 2>/dev/null | head -1)}
if [ ! -d $TOOLS/geo ] && [ -n "$GEO_SRC" ] && [ -d "$GEO_SRC" ]; then
	mkdir -p $TOOLS/geo
	for f in "$GEO_SRC"/*; do
		case $(basename "$f" | tr A-Z a-z) in
			geosite.dat|geoip.dat|geoip.metadb|country.mmdb) cp "$f" $TOOLS/geo/ ;;
		esac
	done
fi
echo "工具就绪：$TOOLS"
