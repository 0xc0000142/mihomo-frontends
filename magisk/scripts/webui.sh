#!/system/bin/sh
# 网页管理（局域网 / Tailscale 访问模块网页）。
#   webui.sh status          {"ok":true,"installed":bool,"running":bool,"settings":{...,"addrs":[...]}}
#   webui.sh set B64JSON     保存设置（字段见 mihomo-webd set），并按 enabled 启停服务；
#                            端口或局域网监听变化时延迟 1 秒重启，好让本次请求先返回
#   webui.sh passwd B64      设置密码（空串清除）
#   webui.sh start|stop|restart
#   webui.sh boot            开机时由 service.sh 调用：启用时启动
. "${0%/*}/common.sh"
. "$SCRIPTS/webui-lib.sh"

fail() { json_error "$1"; exit 1; }

webd_cli() {
  [ -x "$WEBD" ] || fail "缺少 $WEBD，请重新安装完整模块"
  # 选项须在位置参数之前（Go flag 遇到第一个位置参数即停止解析）
  sub=$1; shift
  "$WEBD" "$sub" -c "$WEBD_CONF" "$@" 2>&1
}

status() {
  installed=false; [ -x "$WEBD" ] && installed=true
  settings=
  [ "$installed" = true ] && settings=$("$WEBD" get -c "$WEBD_CONF" 2>/dev/null | head -n 1)
  [ -n "$settings" ] || settings=null
  running=false; webd_alive && running=true
  printf '{"ok":true,"installed":%s,"running":%s,"settings":%s}\n' "$installed" "$running" "$settings"
}

# 监听相关的设置（端口、是否监听局域网）；其它设置服务会自动重新读取
listen_key() {
  [ -x "$WEBD" ] || return 0
  "$WEBD" get -c "$WEBD_CONF" 2>/dev/null | head -n 1 | grep -o '"lan":[a-z]*\|"port":[0-9]*' | tr -d '\n'
}

# 设置变化后让服务与 enabled 一致；监听地址与端口只在启动时读取，变了才重启
reconcile() {
  if webd_enabled; then
    if webd_alive; then
      [ "$1" = "$(listen_key)" ] && return 0
      # 网页管理发起的请求还没返回，延迟重启（新会话里执行，不受本进程退出影响）
      (
        close_inherited_fds
        tool setsid sh -c 'sleep 1; exec sh "$0" restart' "$SCRIPTS/webui.sh" </dev/null >/dev/null 2>&1
      ) </dev/null >/dev/null 2>&1 &
    else
      error=$(webd_start 2>&1) || fail "$error"
    fi
  else
    webd_stop
  fi
}

case "$1" in
  status) status ;;
  set)
    [ "$#" -eq 2 ] || fail '参数无效'
    before=$(listen_key)
    out=$(webd_cli set "$2") || { printf '%s\n' "$out"; exit 1; }
    reconcile "$before"
    status
    ;;
  passwd)
    [ "$#" -eq 2 ] || fail '参数无效'
    out=$(webd_cli passwd "$2") || { printf '%s\n' "$out"; exit 1; }
    printf '%s\n' "$out"
    ;;
  start) webd_start || exit 1; status ;;
  stop) webd_stop; status ;;
  restart) webd_stop; webd_start || exit 1; status ;;
  boot) if webd_enabled; then webd_start; fi ;;
  *) fail '用法: webui.sh status|set|passwd|start|stop|restart|boot' ;;
esac
