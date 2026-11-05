#!/system/bin/sh
# 真机/AVD 上的后台冒烟：以 root 运行，只读探测 + 暂存写入往返，不改动 config.yaml。
#   adb push magisk/tests/device-check.sh /data/local/tmp/ && adb shell su -c sh /data/local/tmp/device-check.sh
S=/data/adb/modules/mihomo-ebpf/scripts
R=/data/adb/mihomo/run
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS $*"; }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

echo "== host.sh probe"
probe=$(sh "$S/host.sh" probe)
echo "$probe"
case "$probe" in '{"ok":true'*) ok probe ;; *) bad probe ;; esac
for key in abi kernel sdk mem_mb btf cgroup2 kernel_ok ipv6 upstream core root; do
  case "$probe" in *"\"$key\":"*) ;; *) bad "probe missing $key" ;; esac
done

echo "== onboarding / status"
sh "$S/onboarding.sh" get
sh "$S/mihomo.sh" status

echo "== stage round trip"
# 与 bridge 一致：每段 96000 字符作为单个命令参数传入
work=/data/local/tmp/mihomo-stage-test
mkdir -p "$work"
head -c 216000 /dev/urandom | base64 | tr -d '\n' >"$work/all"
index=0
offset=0
size=$(wc -c <"$work/all" | tr -d ' ')
while [ "$offset" -lt "$size" ]; do
  dd if="$work/all" of="$work/chunk" bs=96000 skip="$index" count=1 2>/dev/null
  sh "$S/host.sh" stage "$index" "$(cat "$work/chunk")" >/dev/null || bad "stage chunk $index"
  index=$((index + 1))
  offset=$((offset + 96000))
done
if cmp -s "$work/all" "$R/stage.b64"; then ok "stage $size bytes in $index chunks"; else bad 'stage content mismatch'; fi
rm -rf "$work" "$R/stage.b64"

echo "== fetch rejects non-http"
case "$(sh "$S/host.sh" fetch file:///etc/hosts)" in *'"ok":false'*) ok 'fetch rejects file://' ;; *) bad 'fetch accepted file://' ;; esac

echo "== fetch (network)"
result=$(sh "$S/host.sh" fetch "${FETCH_URL:-https://raw.githubusercontent.com/MetaCubeX/mihomo/Meta/docs/config.yaml}" clash.meta)
echo "$result"
case "$result" in
  '{"ok":true'*) ok fetch; head -c 120 "$R/import.yaml"; echo; rm -f "$R/import.yaml" ;;
  *) echo "SKIP fetch（网络不可达时属正常）" ;;
esac

echo "== discovery interfaces"
sh "$S/discovery.sh" interfaces | head -c 600; echo

echo "RESULT pass=$pass fail=$fail"
[ "$fail" = 0 ]
