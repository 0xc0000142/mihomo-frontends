#!/system/bin/sh
# mihomo 进程管理：start / stop / restart / status / autostart。
# 透明代理规则（eBPF 入站由内核自动挂载 cgroup/bpf，无需 iptables）由内核自身完成。
. "${0%/*}/common.sh"

start() {
  ensure_dirs
  if pid_alive; then
    echo "mihomo 已在运行（pid $(cat "$PID_FILE")）"
    return 0
  fi
  if [ ! -x "$BIN" ]; then
    echo "未安装内核 $BIN，请在 WebUI「内核」页下载" >&2
    return 1
  fi
  if [ ! -s "$CONFIG" ]; then
    echo "缺少配置 $CONFIG，请在 WebUI「向导」页生成" >&2
    return 1
  fi
  ulimit -n 65535 2>/dev/null
  nohup "$BIN" -d "$DATA" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  i=0
  while [ $i -lt "$START_TIMEOUT" ]; do
    pid_alive || break
    # 控制器就绪视为启动成功
    secret=$(grep '^secret:' "$CONFIG" 2>/dev/null | sed 's/^secret: *//; s/"//g')
    addr=$(grep '^external-controller:' "$CONFIG" 2>/dev/null | sed 's/^external-controller: *//; s/"//g')
    [ -z "$addr" ] && addr="127.0.0.1:9090"
    if curl -fsS -m 1 -H "Authorization: Bearer $secret" "http://$addr/version" >/dev/null 2>&1; then
      echo "mihomo 已启动（pid $(cat "$PID_FILE")）"
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  if pid_alive; then
    echo "mihomo 已启动（控制器尚未就绪，pid $(cat "$PID_FILE")）"
    return 0
  fi
  echo "mihomo 启动失败，见 $LOG_FILE" >&2
  rm -f "$PID_FILE"
  return 1
}

stop() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      i=0
      while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
        i=$((i + 1)); sleep 1
      done
      kill -9 "$pid" 2>/dev/null
    fi
    rm -f "$PID_FILE"
    echo "mihomo 已停止"
  else
    # 兜底：按进程名清一遍（pid 文件丢失时）
    pkill -f "$BIN -d $DATA" 2>/dev/null
    echo "mihomo 未在运行"
  fi
}

status() {
  if pid_alive; then
    pid=$(cat "$PID_FILE")
    rss=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null)
    up=$(awk '{print int($1)}' /proc/uptime)
    start_ticks=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)
    hertz=100
    uptime=""
    if [ -n "$start_ticks" ]; then
      uptime=$((up - start_ticks / hertz))
    fi
    printf '{"ok":true,"running":true,"pid":%s,"rss_kb":%s,"uptime":%s}\n' \
      "$pid" "${rss:-null}" "${uptime:-null}"
  else
    printf '{"ok":true,"running":false,"pid":null,"rss_kb":null,"uptime":null}\n'
  fi
}

case "$1" in
  start)    start ;;
  stop)     stop ;;
  restart)  stop; sleep 1; start ;;
  status)   status ;;
  autostart)
    if autostart; then
      start
    else
      echo "未开启开机自启，跳过"
    fi
    ;;
  enable)
    setting_set autostart 1
    echo "已开启开机自启"
    ;;
  disable)
    setting_set autostart 0
    echo "已关闭开机自启"
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|autostart|enable|disable}" >&2
    exit 2
    ;;
esac
