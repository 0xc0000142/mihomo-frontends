#!/bin/sh
# 本机后端测试（在 WSL 里运行）：sh tests/local/main.sh [test_xxx.uc ...]
# 与路由器上相同的测试文件和 /tmp/mlt 布局；ubus、uci 换成 stubs 里的测试桩，内核与 yq 用 setup.sh 准备的版本。
L=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$L/../.." && pwd)
TOOLS=${MH_TOOLS:-$HOME/.cache/mh-tools}
# MH_SKIP_SETUP=1：工具已就绪（或正在另一个终端里编译）时跳过检查
[ -n "$MH_SKIP_SETUP" ] || sh "$L/setup.sh" >/dev/null || exit 1
rm -rf /tmp/mlt
mkdir -p /tmp/mlt
cp -r "$R/tests/backend" "$R/tests/fixtures" /tmp/mlt/
cp "$L/apply-job.sh" /tmp/mlt/apply-job
chmod 755 /tmp/mlt/apply-job
# WSL 可能继承 Windows 的代理变量；路由器上的 rpcd 没有这些变量，测试里也不要有
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY
export LD_LIBRARY_PATH=$TOOLS/lib \
	UCODE=$TOOLS/bin/ucode \
	UCODE_ARGS="-L $L/stubs -L $R/root/usr/share/ucode -L $TOOLS/lib/ucode" \
	MLT_HOME=/tmp/mlt-home \
	MLT_REPO="$R" \
	MIHOMO_LUCI_JOB=/tmp/mlt/apply-job \
	MIHOMO_LUCI_YQ=$TOOLS/go/bin/yq \
	MIHOMO_LUCI_BIN=$TOOLS/bin/mihomo-ebpf \
	MIHOMO_LUCI_TEMPLATE="$R/root/usr/share/mihomo-luci/template.yaml" \
	MLT_GEO=$TOOLS/geo \
	MIHOMO_TEST_LOCAL=1
exec sh /tmp/mlt/backend/main.sh "$@"
