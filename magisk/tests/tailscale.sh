#!/bin/sh
# tailscale.sh：状态读取、登录链接提取、退出登录与路径校验（curl / mihomo.sh 用测试桩）。
set -eu

ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
mkdir -p "$TEST_DIR/module/scripts" "$TEST_DIR/bin" "$TEST_DIR/data/run"
for script in common.sh tailscale.sh; do
  tr -d '\r' <"$ROOT/scripts/$script" >"$TEST_DIR/module/scripts/$script"
done
export MODDIR=$TEST_DIR/module SCRIPTS=$TEST_DIR/module/scripts MIHOMO_DATA=$TEST_DIR/data TEST_DIR
export PATH=$TEST_DIR/bin:$PATH
D=$TEST_DIR/data
passed=0
check() { if "$@"; then passed=$((passed+1)); else echo "FAIL: $*" >&2; exit 1; fi; }
has() { grep -Fq -- "$2" "$1"; }
ts() { sh "$SCRIPTS/tailscale.sh" "$@" >"$TEST_DIR/out" 2>"$TEST_DIR/err" || true; }

# 服务脚本测试桩：记录调用，fake-running 表示运行中
cat >"$SCRIPTS/mihomo.sh" <<'EOF'
#!/bin/sh
echo "$1" >>"$TEST_DIR/service.calls"
case "$1" in
  status) if [ -f "$TEST_DIR/fake-running" ]; then echo '{"ok":true,"running":true}'; else echo '{"ok":true,"running":false}'; fi ;;
  stop) [ -d "$TEST_DIR/data/tailscale" ] && echo 'still-present-at-stop' >>"$TEST_DIR/service.calls"; rm -f "$TEST_DIR/fake-running" ;;
  start) touch "$TEST_DIR/fake-running" ;;
esac
EOF
# curl 测试桩：/logs 输出 $TEST_DIR/stream 后保持连接；/delay 记录请求后立即返回
cat >"$TEST_DIR/bin/curl" <<'EOF'
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    Authorization:*) echo "$arg" >>"$TEST_DIR/curl.auth" ;;
    */logs\?level=info) cat "$TEST_DIR/stream"; sleep 30; exit 0 ;;
    */delay\?*) echo "$arg" >>"$TEST_DIR/curl.delay"; exit 0 ;;
  esac
done
EOF
chmod +x "$TEST_DIR/bin/curl"

# ---------- state ----------
ts state "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"exists":false}'
mkdir -p "$D/tailscale"
cat >"$D/tailscale/tailscaled.state" <<'EOF'
{
  "_current-profile": "cHJvZmlsZS1kZWE4",
  "_machinekey": "bWFjaGluZWtleS1zZWNyZXQ=",
  "_profiles": "eyJkZWE4Ijp7fX0=",
  "profile-dea8": "cHJpdmF0ZQ=="
}
EOF
ts state "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"exists":true,"current":"cHJvZmlsZS1kZWE4","profiles":"eyJkZWE4Ijp7fX0="}'
check sh -c "! grep -q 'bWFjaGluZWtleS' '$TEST_DIR/out'"
printf '{"_current-profile":"YQ==","_profiles":"Yg=="}' >"$D/tailscale/tailscaled.state"
ts state "$D/tailscale"
check has "$TEST_DIR/out" '"current":"YQ==","profiles":"Yg=="'
for bad in /etc/ts "$D" "$D/../x" "$D/a/../../x" relative; do
  ts state "$bad"
  check has "$TEST_DIR/out" '"ok":false'
done

# ---------- login ----------
cat >"$TEST_DIR/stream" <<'EOF'
{"type":"info","payload":"[Tailscale](Other) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/other"}
{"type":"info","payload":"[Tailscale](TS B) LocalBackend state is NeedsLogin; running StartLoginInteractive..."}
{"type":"info","payload":"[Tailscale](TS B) To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/10972d5101d712"}
EOF
MIHOMO_SECRET='s3 cret' ts login http://127.0.0.1:9090 TS%20B 'TS B' 5
check has "$TEST_DIR/out" '{"ok":true,"url":"https://login.tailscale.com/a/10972d5101d712"}'
check has "$TEST_DIR/curl.auth" 'Authorization: Bearer s3 cret'
check has "$TEST_DIR/curl.delay" 'http://127.0.0.1:9090/proxies/TS%20B/delay?url=http%3A%2F%2F100.100.100.100&timeout=8000'
check sh -c "! ls '$D/run'/ts-login.* >/dev/null 2>&1"
printf '%s\n' '{"type":"info","payload":"[Tailscale](TS B) AuthLoop: state is Running; done"}' >"$TEST_DIR/stream"
ts login http://127.0.0.1:9090 TS%20B 'TS B' 5
check has "$TEST_DIR/out" '{"ok":true,"url":null,"running":true}'
: >"$TEST_DIR/stream"
ts login http://127.0.0.1:9090 TS 'TS' 5
check has "$TEST_DIR/out" '{"ok":true,"url":null,"running":false}'
ts login http://10.0.0.1:9090 TS TS 5
check has "$TEST_DIR/out" '控制器地址必须是本机'
ts login http://127.0.0.1:9090 'a/b' TS 5
check has "$TEST_DIR/out" '出站名编码无效'
ts login http://127.0.0.1:9090 TS TS 'x'
check has "$TEST_DIR/out" '等待时间无效'

# ---------- logout ----------
mkdir -p "$D/tailscale"; touch "$D/tailscale/tailscaled.state"
rm -f "$TEST_DIR/service.calls" "$TEST_DIR/fake-running"
ts logout "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"restarted":false}'
check test ! -e "$D/tailscale"
mkdir -p "$D/tailscale"; touch "$TEST_DIR/fake-running"; rm -f "$TEST_DIR/service.calls"
ts logout "$D/tailscale"
check has "$TEST_DIR/out" '{"ok":true,"restarted":true}'
check test ! -e "$D/tailscale"
check test -f "$TEST_DIR/fake-running"
check test "$(tr '\n' ' ' <"$TEST_DIR/service.calls")" = 'status stop still-present-at-stop start '
ts logout /data/adb
check has "$TEST_DIR/out" '"ok":false'

# ---------- open ----------
ts open 'javascript:alert(1)'
check has "$TEST_DIR/out" '链接无效'

echo "PASS: $passed tailscale checks"
