#!/system/bin/sh
# 本机信息探测与远程配置下载。只读，不改动配置与策略。
#   host.sh probe          输出 JSON：架构、SDK、内存、eBPF/BTF、IPv6、上游/共享网卡
#   host.sh fetch URL UA   下载远程配置到 run/import.yaml，输出 {"ok":true,"size":N}
#   host.sh stage N B64    把第 N 段 base64 追加到暂存文件（N=0 时清空），供大配置分段写入
. "${0%/*}/common.sh"
. "$SCRIPTS/policy-lib.sh"

STAGE=$RUN_DIR/stage.b64
IMPORT=$RUN_DIR/import.yaml
MAX_IMPORT=4194304

fail() { json_error "$1"; exit 1; }

json_bool() { if "$@"; then printf true; else printf false; fi; }

has_btf() { [ -r /sys/kernel/btf/vmlinux ]; }

has_cgroup2() {
  awk '$3=="cgroup2"{found=1} END{exit !found}' /proc/mounts 2>/dev/null
}

has_bpf_fs() {
  awk '$3=="bpf"{found=1} END{exit !found}' /proc/mounts 2>/dev/null
}

kernel_at_least() {
  # $1 major $2 minor
  release=$(uname -r 2>/dev/null)
  major=${release%%.*}
  rest=${release#*.}
  minor=${rest%%[!0-9]*}
  case "$major$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$1" ] || { [ "$major" -eq "$1" ] && [ "$minor" -ge "$2" ]; }
}

ipv6_upstream() {
  tool timeout 3 ip -6 route show default 2>/dev/null | grep -q . && return 0
  tool timeout 3 ip -6 route show table all 2>/dev/null | grep -q '^default '
}

ipv4_upstream() {
  tool timeout 3 ip -4 route show table all 2>/dev/null | awk '$1=="default"{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}'
}

mem_mb() {
  awk '/^MemTotal:/{printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null
}

prop() { getprop "$1" 2>/dev/null | tr -d '\r\n"\\'; }

probe() {
  release=$(uname -r 2>/dev/null)
  machine=$(uname -m 2>/dev/null)
  sdk=$(prop ro.build.version.sdk)
  case "$sdk" in ''|*[!0-9]*) sdk=0 ;; esac
  cpus=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)
  case "$cpus" in ''|*[!0-9]*) cpus=0 ;; esac
  memory=$(mem_mb)
  case "$memory" in ''|*[!0-9]*) memory=0 ;; esac
  upstream=$(ipv4_upstream)
  case "$upstream" in *[!a-zA-Z0-9_.-]*) upstream='' ;; esac
  core_ok=false
  if [ -x "$BIN" ] && "$BIN" -v 2>/dev/null | grep -q ' android '; then core_ok=true; fi
  root_impl=unknown
  if [ -d /data/adb/ksu ]; then root_impl=kernelsu
  elif [ -d /data/adb/ap ]; then root_impl=apatch
  elif [ -d /data/adb/magisk ]; then root_impl=magisk
  fi
  printf '{"ok":true,"abi":"%s","kernel":"%s","sdk":%s,"android":"%s","model":"%s","cpus":%s,"mem_mb":%s,' \
    "$(json_escape "$machine")" "$(json_escape "$release")" "$sdk" "$(json_escape "$(prop ro.build.version.release)")" \
    "$(json_escape "$(prop ro.product.model)")" "$cpus" "$memory"
  printf '"btf":%s,"cgroup2":%s,"bpffs":%s,"kernel_ok":%s,"ipv6":%s,"upstream":"%s","ssid":"%s","core":%s,"root":"%s","mirror":"%s","has_config":%s}\n' \
    "$(json_bool has_btf)" "$(json_bool has_cgroup2)" "$(json_bool has_bpf_fs)" "$(json_bool kernel_at_least 5 10)" \
    "$(json_bool ipv6_upstream)" "$upstream" "$(json_escape "$(current_ssid_quiet)")" "$core_ok" "$root_impl" \
    "$(json_escape "$(core_mirror)")" "$(json_bool test -s "$CONFIG")"
}

current_ssid_quiet() { current_ssid 2>/dev/null; }

fetch() {
  url=$1
  agent=${2:-clash.meta}
  case "$url" in http://*|https://*) ;; *) fail '只支持 http(s) 链接' ;; esac
  case "$url$agent" in *'
'*|*"$(printf '\r')"*) fail '链接不能含换行' ;; esac
  [ "${#url}" -le 4096 ] && [ "${#agent}" -le 256 ] || fail '链接或 UA 过长'
  command -v curl >/dev/null 2>&1 || fail '缺少 curl，无法下载'
  ensure_dirs || fail '无法创建数据目录'
  tmp=$RUN_DIR/import.$$.tmp
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --compressed -m 60 --max-filesize "$MAX_IMPORT" -A "$agent" -o "$tmp" -- "$url" 2>"$tmp.err" || {
    detail=$(tail -n 1 "$tmp.err" 2>/dev/null); rm -f "$tmp.err"
    fail "下载失败：${detail:-网络错误}"
  }
  rm -f "$tmp.err"
  [ -s "$tmp" ] || fail '下载内容为空'
  size=$(wc -c <"$tmp" | tr -d ' ')
  [ "$size" -le "$MAX_IMPORT" ] || fail '下载内容超过 4 MB'
  mv -f "$tmp" "$IMPORT" || fail '保存下载内容失败'
  trap - EXIT
  printf '{"ok":true,"size":%s}\n' "$size"
}

stage() {
  index=$1
  chunk=$2
  case "$index" in ''|*[!0-9]*) fail '分段序号无效' ;; esac
  case "$chunk" in ''|*[!a-zA-Z0-9+/=]*) fail '分段内容不是 base64' ;; esac
  [ "${#chunk}" -le 100000 ] || fail '分段过大'
  ensure_dirs || fail '无法创建数据目录'
  if [ "$index" = 0 ]; then : >"$STAGE" || fail '无法创建暂存文件'; fi
  [ -f "$STAGE" ] || fail '暂存文件丢失，请重试'
  printf '%s' "$chunk" >>"$STAGE" || fail '写入暂存文件失败'
  size=$(wc -c <"$STAGE" | tr -d ' ')
  [ "$size" -le $((MAX_IMPORT * 2)) ] || { rm -f "$STAGE"; fail '配置超过 4 MB'; }
  printf '{"ok":true,"size":%s}\n' "$size"
}

case "${1:-}" in
  probe) probe ;;
  fetch) [ "$#" -ge 2 ] || fail '缺少链接'; fetch "$2" "${3:-}" ;;
  stage) [ "$#" -eq 3 ] || fail '参数无效'; stage "$2" "$3" ;;
  *) fail '用法: host.sh probe|fetch|stage' ;;
esac
