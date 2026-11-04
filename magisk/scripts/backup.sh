#!/system/bin/sh
# 备份列表 / 读取 / 删除 / 恢复。
. "${0%/*}/common.sh"

case "$1" in
  list)
    ensure_dirs
    printf '{"ok":true,"list":['
    first=1
    for f in $(ls -1t "$BACKUP_DIR"/config-*.yaml 2>/dev/null); do
      b=$(basename "$f")
      sz=$(wc -c <"$f" | tr -d ' ')
      [ $first -eq 0 ] && printf ','
      first=0
      printf '{"name":"%s","size":%s}' "$b" "$sz"
    done
    printf ']}\n'
    ;;
  read)
    f="$BACKUP_DIR/$(basename "$2")"
    [ -f "$f" ] || { echo '{"ok":false,"error":"备份不存在"}'; exit 1; }
    base64 -w 0 "$f" 2>/dev/null || base64 "$f" | tr -d '\n'
    echo
    ;;
  delete)
    rm -f "$BACKUP_DIR/$(basename "$2")" && echo '{"ok":true}' || echo '{"ok":false,"error":"删除失败"}'
    ;;
  restore)
    f="$BACKUP_DIR/$(basename "$2")"
    [ -f "$f" ] || { echo '{"ok":false,"error":"备份不存在"}'; exit 1; }
    cp -f "$f" "$CONFIG"
    if pid_alive; then
      "${0%/*}/mihomo.sh" restart >/dev/null 2>&1 || {
        echo '{"ok":false,"error":"恢复后启动失败"}'
        exit 1
      }
    fi
    echo '{"ok":true}'
    ;;
  *) echo "用法: $0 {list|read|delete|restore}" >&2; exit 2 ;;
esac
