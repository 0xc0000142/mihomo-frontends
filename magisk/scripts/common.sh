#!/system/bin/sh
# 路径与设置。被 mihomo.sh / core.sh / apply.sh / webui.sh source。
# 数据统一放 /data/adb/mihomo：模块升级只替换模块目录，内核、配置、备份都保留。

MODDIR=${MODDIR:-/data/adb/modules/mihomo-ebpf}
DATA=/data/adb/mihomo
BIN=$DATA/mihomo
BIN_PREV=$DATA/mihomo.prev
CONFIG=$DATA/config.yaml
CANDIDATE=$DATA/config.yaml.new
BACKUP_DIR=$DATA/backup
RUN_DIR=$DATA/run
PID_FILE=$RUN_DIR/pid
LOG_FILE=$RUN_DIR/mihomo.log
SETTINGS=$DATA/settings.ini
TEMPLATE=$MODDIR/webroot/template.yaml
BACKUP_KEEP=10
START_TIMEOUT=15

ensure_dirs() {
  mkdir -p "$DATA" "$BACKUP_DIR" "$RUN_DIR"
}

# settings.ini：key=value，一行一个
setting_get() {
  # $1 key  $2 default
  if [ -f "$SETTINGS" ]; then
    v=$(sed -n "s/^$1=//p" "$SETTINGS" | head -n 1)
    [ -n "$v" ] && { printf '%s' "$v"; return; }
  fi
  printf '%s' "$2"
}

setting_set() {
  # $1 key  $2 value
  ensure_dirs
  if [ -f "$SETTINGS" ] && grep -q "^$1=" "$SETTINGS"; then
    sed -i "s|^$1=.*|$1=$2|" "$SETTINGS"
  else
    printf '%s=%s\n' "$1" "$2" >>"$SETTINGS"
  fi
}

autostart() {
  [ "$(setting_get autostart 0)" = "1" ]
}

core_repo()   { setting_get core_repo "liuran001/mihomo"; }
core_tag()    { setting_get core_tag ""; }
core_mirror() { setting_get core_mirror ""; }

file_rev() {
  if [ -f "$1" ]; then
    md5sum "$1" 2>/dev/null | awk '{print $1}'
  else
    printf 'none'
  fi
}

pid_alive() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
}

json_escape() {
  # 只用于状态类短字符串（版本号、错误摘要）
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | tr '\n' ' '
}
