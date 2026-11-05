#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/bin" "$TEST_DIR/data/run" "$TEST_DIR/net"
for script in common.sh policy-lib.sh policy-ssid.awk discovery.sh discovery-apps.awk discovery-interfaces.awk discovery-routes.awk; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/module/scripts/$script"
done
export TEST_DIR
export MODDIR=$TEST_DIR/module
export SCRIPTS=$MODDIR/scripts
export MIHOMO_DATA=$TEST_DIR/data
export MIHOMO_DISCOVERY_SYS_NET=$TEST_DIR/net
export PATH=$TEST_DIR/bin:$PATH
checks=0

check() {
  if "$@"; then checks=$((checks+1)); else echo "FAIL: $*" >&2; exit 1; fi
}
contains() { grep -Fq -e "$2" "$1"; }
absent() { ! grep -Fq -e "$2" "$1"; }
run_discovery() { sh "$SCRIPTS/discovery.sh" "$@" >"$TEST_DIR/result"; }
expect_failure() {
  if run_discovery "$@"; then echo "unexpected success: $*" >&2; return 1; fi
  contains "$TEST_DIR/result" '"ok":false'
}
fixture_interface() {
  mkdir -p "$TEST_DIR/net/$1"
  printf '%s\n' "$2" >"$TEST_DIR/net/$1/operstate"
  printf '%s\n' "${3:-1}" >"$TEST_DIR/net/$1/type"
}

cat >"$TEST_DIR/bin/timeout" <<'EOF'
#!/bin/sh
printf 'timeout %s\n' "$*" >>"$TEST_DIR/calls"
case "$1" in 5|12) shift ;; *) exit 99 ;; esac
case "${1:-}" in pm|cmd|dumpsys|ip) ;; *) exit 98 ;; esac
exec "$@"
EOF
cat >"$TEST_DIR/bin/pm" <<'EOF'
#!/bin/sh
exec "$TEST_DIR/bin/package-fixture" pm "$@"
EOF
cat >"$TEST_DIR/bin/cmd" <<'EOF'
#!/bin/sh
if [ "$*" = 'wifi status' ]; then echo 'Unknown command: status'; exit 0; fi
[ "$1" = package ] || exit 99
shift
exec "$TEST_DIR/bin/package-fixture" cmd "$@"
EOF
cat >"$TEST_DIR/bin/package-fixture" <<'EOF'
#!/bin/sh
provider=$1
shift
printf '%s %s\n' "$provider" "$*" >>"$TEST_DIR/calls"
[ "$1 $2" = 'list packages' ] || exit 99
scope=all
has_uids=0
for argument in "$@"; do
  [ "$argument" != -s ] || scope=system
  [ "$argument" != -U ] || has_uids=1
done
scenario=$(cat "$TEST_DIR/scenario")
case "$scenario" in
  cmd_fallback) if [ "$provider" = pm ]; then echo 'Unknown command: list'; exit 0; fi ;;
  no_uid) if [ "$has_uids" = 1 ]; then echo 'Error: Unknown option: -U'; exit 0; fi ;;
  fail) echo 'Permission denied' >&2; exit 1 ;;
  timeout) printf 'package:partial.app uid:10000\n'; exit 124 ;;
  bad_system) if [ "$scope" = system ]; then echo 'Error: permission denied'; exit 0; fi ;;
  invalid) if [ "$scope" = all ]; then printf 'package:com.bad"injection uid:10000\n'; exit 0; fi ;;
  malformed_uid) if [ "$scope" = all ]; then printf 'package:com.example.app uid:12;reboot\n'; exit 0; fi ;;
  uid_overflow) if [ "$scope" = all ]; then printf 'package:com.example.app uid:4294967295\n'; exit 0; fi ;;
esac
cat "$TEST_DIR/$scope"
EOF
cat >"$TEST_DIR/bin/dumpsys" <<'EOF'
#!/bin/sh
printf 'dumpsys %s\n' "$*" >>"$TEST_DIR/calls"
[ "$*" = wifi ] || exit 99
cat "$TEST_DIR/wifi"
EOF
cat >"$TEST_DIR/bin/ip" <<'EOF'
#!/bin/sh
printf 'ip %s\n' "$*" >>"$TEST_DIR/calls"
case "$*" in
  '-4 route show table all') cat "$TEST_DIR/route4" ;;
  '-6 route show table all') cat "$TEST_DIR/route6" ;;
  *) exit 99 ;;
esac
[ ! -f "$TEST_DIR/ip-fail" ] || exit 1
EOF
chmod +x "$TEST_DIR/bin/"*
: >"$TEST_DIR/calls"
printf '%s\n' normal >"$TEST_DIR/scenario"
cat >"$TEST_DIR/all" <<'EOF'
package:android uid:1000
package:com.android.systemui uid:10001
package:com.example.user uid:10234
package:com.example.nouid
package:com.example.user uid:10234
EOF
cat >"$TEST_DIR/system" <<'EOF'
package:android uid:1000
package:com.android.systemui uid:10001
EOF
check run_discovery apps
cat >"$TEST_DIR/expected" <<'EOF'
{"ok":true,"apps":[{"packageName":"android","appLabel":"android","isSystem":true,"uid":1000},{"packageName":"com.android.systemui","appLabel":"com.android.systemui","isSystem":true,"uid":10001},{"packageName":"com.example.user","appLabel":"com.example.user","isSystem":false,"uid":10234},{"packageName":"com.example.nouid","appLabel":"com.example.nouid","isSystem":false,"uid":null}],"source":"package-manager"}
EOF
check cmp "$TEST_DIR/result" "$TEST_DIR/expected"
check test "$(grep -c '^pm ' "$TEST_DIR/calls")" = 2
check absent "$TEST_DIR/calls" dumpsys
check test ! -e "$MIHOMO_DATA/run/backend.lock"

printf '%s\n' cmd_fallback >"$TEST_DIR/scenario"
check run_discovery apps
check cmp "$TEST_DIR/result" "$TEST_DIR/expected"
check contains "$TEST_DIR/calls" 'cmd list packages -s -U'
printf '%s\n' no_uid >"$TEST_DIR/scenario"
printf 'package:android\npackage:com.example.user\n' >"$TEST_DIR/all"
printf 'package:android\n' >"$TEST_DIR/system"
check run_discovery apps
check contains "$TEST_DIR/result" '"isSystem":true,"uid":null'
check contains "$TEST_DIR/result" '"isSystem":false,"uid":null'
check contains "$TEST_DIR/calls" 'pm list packages -s'

for scenario in fail timeout invalid malformed_uid uid_overflow bad_system; do
  printf '%s\n' "$scenario" >"$TEST_DIR/scenario"
  check expect_failure apps
  check absent "$TEST_DIR/result" '"apps":['
done
printf '%s\n' normal >"$TEST_DIR/scenario"
: >"$TEST_DIR/all"
check expect_failure apps
printf 'package:com.example.user uid:010234\npackage:com.example.conflict uid:10\npackage:com.example.conflict uid:20\n' >"$TEST_DIR/all"
: >"$TEST_DIR/system"
check run_discovery apps
check contains "$TEST_DIR/result" '"isSystem":false,"uid":10234'
check contains "$TEST_DIR/result" '"packageName":"com.example.conflict","appLabel":"com.example.conflict","isSystem":false,"uid":null'

awk 'BEGIN {for (number=1; number<=12000; number++) printf "package:com.example.app%s uid:%s\n",number,10000+number}' >"$TEST_DIR/all"
check run_discovery apps
check test "$(wc -c <"$TEST_DIR/result")" -gt 1000000
check test "$(awk '{print gsub(/"packageName":/,"&")}' "$TEST_DIR/result")" = 12000
check contains "$TEST_DIR/result" '"packageName":"com.example.app12000"'

for interface_name in ap0 wlan0 wlan1 rndis0 usb0 bt-pan softap0 ap_br_wlan1 bnep0 eth0 rmnet_data0; do
  fixture_interface "$interface_name" up
done
fixture_interface wlan1 down
fixture_interface usb0 dormant
fixture_interface mystery0 unknown
fixture_interface malformed0 'up"garbage'
fixture_interface 'bad"name' up
for interface_name in lo tun0 tap0 ip6tnl0 sit0 gre0 veth0 ifb0 dummy0 wg0 tailscale0 p2p0 aware0; do
  fixture_interface "$interface_name" up
done
fixture_interface strange_tunnel up 65534
cat >"$TEST_DIR/wifi" <<'EOF'
history 01:00 mWifiInfo SSID: "OldWifi", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED
mWifiInfo SSID: "Cafe, "A"", BSSID: 00:13:10:85:fe:01, Supplicant state: COMPLETED
EOF
cat >"$TEST_DIR/route4" <<'EOF'
default via 10.0.0.1 dev rmnet_data0 table 1002
default via 192.168.1.1 dev eth0 table 1003
10.10.0.0/16 dev wlan1 table 1004
unreachable default dev rndis0 table 1005
EOF
cat >"$TEST_DIR/route6" <<'EOF'
default via fe80::1 dev ap0 table 1006
EOF
check run_discovery interfaces
check contains "$TEST_DIR/result" '"name":"wlan0","kind":"wifi","present":true,"state":"up","upstream":true,"suggested":false'
check contains "$TEST_DIR/result" '"name":"wlan1","kind":"wifi","present":true,"state":"down","upstream":false,"suggested":true'
check contains "$TEST_DIR/result" '"name":"ap0","kind":"wifi","present":true,"state":"up","upstream":true,"suggested":false'
check contains "$TEST_DIR/result" '"name":"usb0","kind":"usb","present":true,"state":"unknown","upstream":false,"suggested":true'
check contains "$TEST_DIR/result" '"name":"rndis0","kind":"usb","present":true,"state":"up","upstream":false,"suggested":true'
check contains "$TEST_DIR/result" '"name":"bt-pan","kind":"bluetooth"'
check contains "$TEST_DIR/result" '"name":"ap_br_wlan1","kind":"wifi"'
check contains "$TEST_DIR/result" '"name":"softap0","kind":"wifi"'
check contains "$TEST_DIR/result" '"name":"eth0","kind":"other","present":true,"state":"up","upstream":true,"suggested":false'
check contains "$TEST_DIR/result" '"name":"mystery0","kind":"other","present":true,"state":"unknown","upstream":false,"suggested":false'
check contains "$TEST_DIR/result" '"current_ssid":"Cafe, \"A\""'
for interface_name in lo tun0 tap0 ip6tnl0 sit0 gre0 veth0 ifb0 dummy0 wg0 tailscale0 p2p0 aware0 strange_tunnel; do
  check absent "$TEST_DIR/result" "\"name\":\"$interface_name\""
done
check absent "$TEST_DIR/result" 'bad'
check contains "$TEST_DIR/calls" 'timeout 5 dumpsys wifi'
check contains "$TEST_DIR/calls" 'ip -6 route show table all'

cat >"$TEST_DIR/route4" <<'EOF'
default proto static
    nexthop via 10.0.0.1 dev rndis0 weight 1
    nexthop via 10.0.0.2 dev bt-pan weight 1
192.168.0.0/16 dev wlan1
EOF
check run_discovery interfaces
check contains "$TEST_DIR/result" '"name":"rndis0","kind":"usb","present":true,"state":"up","upstream":true,"suggested":false'
check contains "$TEST_DIR/result" '"name":"bt-pan","kind":"bluetooth","present":true,"state":"up","upstream":true,"suggested":false'
touch "$TEST_DIR/ip-fail"
check run_discovery interfaces
check absent "$TEST_DIR/result" '"suggested":true'
check contains "$TEST_DIR/result" '"name":"wlan0","kind":"wifi","present":true,"state":"up","upstream":true,"suggested":false'
rm -f "$TEST_DIR/ip-fail"
: >"$TEST_DIR/route4"
: >"$TEST_DIR/route6"
printf '%s\n' 'mWifiInfo SSID: <unknown ssid>, BSSID: <none>, Supplicant state: DISCONNECTED' >"$TEST_DIR/wifi"
check run_discovery interfaces
check contains "$TEST_DIR/result" '"name":"wlan0","kind":"wifi","present":true,"state":"up","upstream":false,"suggested":false'
check contains "$TEST_DIR/result" '"current_ssid":""'
mkdir "$TEST_DIR/empty-net"
export MIHOMO_DISCOVERY_SYS_NET=$TEST_DIR/empty-net
check run_discovery interfaces
check test "$(cat "$TEST_DIR/result")" = '{"ok":true,"interfaces":[],"current_ssid":""}'
export MIHOMO_DISCOVERY_SYS_NET=$TEST_DIR/missing-net
check expect_failure interfaces
check expect_failure unexpected
check absent "$TEST_DIR/calls" 'ip link'
check absent "$TEST_DIR/calls" 'dumpsys package'
check test ! -e "$MIHOMO_DATA/run/backend.lock"
check test -z "$(find "$MIHOMO_DATA/run" -mindepth 1 -maxdepth 1 -name 'discovery.*' -print)"
check sh -n "$SCRIPTS/discovery.sh"
printf 'PASS: %s discovery checks (only temporary fixtures; no device/network/package changes)\n' "$checks"
