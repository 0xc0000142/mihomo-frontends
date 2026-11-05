#!/system/bin/sh
# Tailscale（内核 tailscale 出站，tsnet）登录辅助。
#   tailscale.sh state DIR                 读取 DIR/tailscaled.state 中的登录资料（只输出 _current-profile 与 _profiles，不碰 _machinekey）
#   tailscale.sh login CTL PATH NAME [S]   订阅控制器日志并发起一次测速唤醒 tsnet，等待最多 S 秒（默认 20）：
#                                          输出 {"ok":true,"url":"https://…"} 或 {"ok":true,"url":null,"running":true|false}
#                                          CTL 为 http://127.0.0.1:端口，PATH 为 URL 编码后的出站名，NAME 为日志中 JSON 转义后的出站名；
#                                          控制器密钥通过环境变量 MIHOMO_SECRET 传入
#   tailscale.sh logout DIR                删除状态目录（服务运行时先停止、删除后再启动）
#   tailscale.sh open URL                  用系统浏览器打开链接
. "${0%/*}/common.sh"

fail() { json_error "$1"; exit 1; }

# 状态目录必须在数据目录之内
safe_dir() {
  case "$1" in "$DATA"/?*) ;; *) return 1 ;; esac
  case "$1/" in */../*|*/./*) return 1 ;; esac
}

b64_value() {
  # 取 JSON 中 "$1": "<base64>" 的值；文件可能是单行或缩进格式
  grep -o "\"$1\": *\"[A-Za-z0-9+/=]*\"" "$2" 2>/dev/null | head -n 1 | sed 's/.*: *"\([^"]*\)"/\1/'
}

curl_bin() {
  if [ -x /system/bin/curl ]; then echo /system/bin/curl; else command -v curl 2>/dev/null; fi
}

running() { "$SCRIPTS/mihomo.sh" status 2>/dev/null | grep -q '"running":true'; }

case "$1" in
  state)
    dir=$2
    safe_dir "$dir" || fail '状态目录必须在数据目录之内'
    file=$dir/tailscaled.state
    if [ ! -f "$file" ]; then
      printf '{"ok":true,"exists":false}\n'
      exit 0
    fi
    printf '{"ok":true,"exists":true,"current":"%s","profiles":"%s"}\n' "$(b64_value _current-profile "$file")" "$(b64_value _profiles "$file")"
    ;;
  login)
    ctl=$2 path=$3 name=$4 wait=${5:-20}
    case "$ctl" in http://127.0.0.1:[0-9]*|http://localhost:[0-9]*|'http://[::1]:'[0-9]*) ;; *) fail '控制器地址必须是本机' ;; esac
    case "$path" in ''|*[!A-Za-z0-9%._~-]*) fail '出站名编码无效' ;; esac
    case "$wait" in ''|*[!0-9]*) fail '等待时间无效' ;; esac
    [ -n "$name" ] || fail '缺少出站名'
    curl=$(curl_bin)
    [ -n "$curl" ] && [ -x "$curl" ] || fail '未找到 curl'
    ensure_dirs
    log=$RUN_DIR/ts-login.$$.log
    : >"$log" || fail '无法写入临时文件'
    auth="Authorization: Bearer $MIHOMO_SECRET"
    # 有订阅者时内核会输出 info 日志，与配置中的 log-level 无关；tsnet 只在首次连接时启动，所以先订阅再测速
    "$curl" -sN --noproxy '*' --max-time "$wait" -H "$auth" "$ctl/logs?level=info" >"$log" 2>/dev/null &
    logs=$!
    sleep 1
    "$curl" -s --noproxy '*' --max-time 10 -H "$auth" "$ctl/proxies/$path/delay?url=http%3A%2F%2F100.100.100.100&timeout=8000" >/dev/null 2>&1 &
    probe=$!
    url='' state=false tick=0
    while [ "$tick" -lt $((wait * 2)) ]; do
      lines=$(grep -F "[Tailscale]($name) " "$log" 2>/dev/null)
      url=$(printf '%s\n' "$lines" | grep -o 'go to: https\{0,1\}://[^" \\]*' | tail -n 1 | sed 's/^go to: //')
      [ -n "$url" ] && break
      if printf '%s\n' "$lines" | grep -q 'AuthLoop: state is Running'; then state=true; break; fi
      kill -0 "$logs" 2>/dev/null || break
      sleep 0.5
      tick=$((tick + 1))
    done
    kill "$logs" "$probe" 2>/dev/null
    wait 2>/dev/null
    rm -f "$log"
    if [ -n "$url" ]; then
      printf '{"ok":true,"url":"%s"}\n' "$(json_escape "$url")"
    else
      printf '{"ok":true,"url":null,"running":%s}\n' "$state"
    fi
    ;;
  logout)
    dir=$2
    safe_dir "$dir" || fail '状态目录必须在数据目录之内'
    was=false
    if running; then
      was=true
      "$SCRIPTS/mihomo.sh" stop >/dev/null 2>&1 || fail '停止服务失败'
    fi
    rm -rf "$dir" || fail '删除状态目录失败'
    if [ "$was" = true ]; then
      "$SCRIPTS/mihomo.sh" start >/dev/null 2>&1 || fail '已退出登录，但启动服务失败'
    fi
    printf '{"ok":true,"restarted":%s}\n' "$was"
    ;;
  open)
    url=$2
    case "$url" in https://?*|http://?*) ;; *) fail '链接无效' ;; esac
    am start -a android.intent.action.VIEW -d "$url" >/dev/null 2>&1 || fail '无法打开浏览器'
    printf '{"ok":true}\n'
    ;;
  *) echo '用法: tailscale.sh state|login|logout|open ...' >&2; exit 2 ;;
esac
