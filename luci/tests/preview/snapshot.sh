#!/bin/sh
# 生成离线预览用的 rpc 快照（在 WSL 里运行）：sh tests/preview/snapshot.sh
# 把脱敏样例 tests/fixtures/full.yaml 放进临时目录，用真实插件读出各区段，写到 tests/preview/.cache/rpc.json。
L=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$L/../.." && pwd)
sh "$R/scripts/sync-template.sh"
TOOLS=${MH_TOOLS:-$HOME/.cache/mh-tools}
T=$(mktemp -d /tmp/mh-snap.XXXXXX) || exit 1
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/backup" "$T/run" "$T/uci" "$L/.cache"
cp "$R/tests/fixtures/full.yaml" "$T/home/config.yaml"
# 两份备份，让配置文件页的备份列表有内容
cp "$T/home/config.yaml" "$T/home/backup/config-20261103-221502.yaml"
cp "$T/home/config.yaml" "$T/home/backup/config-20261104-093011.yaml"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY
LD_LIBRARY_PATH=$TOOLS/lib MLT_REPO="$R" \
	MIHOMO_LUCI_HOME="$T/home" MIHOMO_LUCI_RUN="$T/run" MIHOMO_LUCI_UCI_DIR="$T/uci" \
	MIHOMO_LUCI_INIT=/bin/false MIHOMO_LUCI_SERVICE=mihomo-preview \
	MIHOMO_LUCI_YQ=$TOOLS/go/bin/yq MIHOMO_LUCI_BIN=$TOOLS/bin/mihomo-ebpf \
	MIHOMO_LUCI_TEMPLATE="$R/root/usr/share/mihomo-luci/template.yaml" \
	"$TOOLS/bin/ucode" -L "$R/tests/local/stubs" -L "$R/root/usr/share/ucode" -L "$TOOLS/lib/ucode" \
	"$L/snapshot.uc" > "$L/.cache/rpc.json" || exit 1
echo "已写入 $L/.cache/rpc.json"
