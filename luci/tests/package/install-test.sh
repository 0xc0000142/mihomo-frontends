#!/bin/sh
# 安装测试（Linux/WSL）：sh tests/package/install-test.sh dist/luci-app-mihomo-ebpf-<版本>.apk
# 依赖用空的占位包代替，在临时根目录里安装（不运行安装脚本）、检查文件与权限，再卸载。
set -e
PKG=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
APK=${APK:-$(command -v apk 2>/dev/null || echo "${MH_TOOLS:-$HOME/.cache/mh-tools}/bin/apk")}
W=/tmp/mh-apk-test
rm -rf $W
mkdir -p $W/root $W/stubs $W/empty
deps=$(unshare -r "$APK" adbdump "$PKG" | awk '/^  depends:/{d=1;next} d&&/^    - /{print $2;next} {d=0}')
for d in $deps; do
	unshare -r "$APK" mkpkg --info "name:$d" --info "version:0-r0" --info "arch:noarch" --files $W/empty --output $W/stubs/$d.apk
done
Q="unshare -r $APK --root $W/root --no-network --force-no-chroot"
A="$Q --allow-untrusted --no-scripts --force-non-repository"
$A --initdb add $W/stubs/*.apk "$PKG" >$W/add.log 2>&1 || { cat $W/add.log; exit 1; }
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; fail=1; fi; }
R=$W/root
mode() { stat -c %a "$R$1"; }
check '已安装' "$Q info -e luci-app-mihomo-ebpf >/dev/null"
check 'init 脚本可执行' "[ \$(mode /etc/init.d/mihomo) = 755 ]"
check 'apply-job 可执行' "[ \$(mode /usr/libexec/mihomo-luci/apply-job) = 755 ]"
check 'UCI 默认文件' "grep -q \"option repo 'liuran001/mihomo'\" $R/etc/config/mihomo"
check '模板' "[ -s $R/usr/share/mihomo-luci/template.yaml ]"
check 'rpcd 插件与 ACL' "[ -s $R/usr/share/rpcd/ucode/luci.mihomo.uc ] && [ -s $R/usr/share/rpcd/acl.d/luci-app-mihomo.json ]"
check '前端页面' "[ -s $R/www/luci-static/resources/view/mihomo/overview.js ]"
check 'sysupgrade 保留清单' "grep -qx /etc/mihomo/ $R/lib/upgrade/keep.d/luci-app-mihomo-ebpf"
check '文件清单' "grep -qx /etc/init.d/mihomo $R/lib/apk/packages/luci-app-mihomo-ebpf.list"
check '普通文件 644' "[ \$(mode /usr/share/ucode/mihomo/apply.uc) = 644 ]"
$A del luci-app-mihomo-ebpf >$W/del.log 2>&1
check '卸载后删除插件文件' "[ ! -e $R/usr/share/ucode/mihomo/apply.uc ]"
rm -rf $W
[ $fail = 0 ] && echo "PACKAGE TEST PASSED" || { echo "PACKAGE TEST FAILED"; exit 1; }
