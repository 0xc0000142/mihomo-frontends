#!/system/bin/sh
# 配置写入：base64 入参 → 内核 -t 校验 → 备份 → 原子替换 → 按需重启，失败自动回滚。
# 用法: apply.sh <base64 配置> [restart]
. "${0%/*}/common.sh"

fail() {
  printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$1")"
  exit 1
}

[ -n "$1" ] || fail "缺少配置内容"
ensure_dirs

tmp="$RUN_DIR/candidate.tmp"
printf '%s' "$1" | base64 -d >"$tmp" 2>/dev/null || fail "base64 解码失败"
[ -s "$tmp" ] || fail "配置为空"

if [ -x "$BIN" ]; then
  out=$("$BIN" -d "$DATA" -f "$tmp" -t 2>&1)
  code=$?
  if [ $code -ne 0 ]; then
    detail=$(printf '%s' "$out" | tail -n 5)
    rm -f "$tmp"
    fail "配置校验失败：$detail"
  fi
fi

# 备份（只保留最近 BACKUP_KEEP 份）
if [ -f "$CONFIG" ]; then
  name="config-$(date +%Y%m%d-%H%M%S).yaml"
  cp -f "$CONFIG" "$BACKUP_DIR/$name"
  ls -1t "$BACKUP_DIR"/config-*.yaml 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r f; do rm -f "$f"; done
fi

mv -f "$tmp" "$CONFIG"

restart="no"
[ "$2" = "restart" ] && restart="yes"
if pid_alive && [ "$restart" = "yes" ]; then
  out=$("${0%/*}/mihomo.sh" restart 2>&1)
  if [ $? -ne 0 ]; then
    # 回滚
    if [ -f "$BACKUP_DIR/$name" ]; then
      cp -f "$BACKUP_DIR/$name" "$CONFIG"
      "${0%/*}/mihomo.sh" restart >/dev/null 2>&1
    fi
    fail "新配置启动失败，已回滚到上一份配置"
  fi
fi

echo '{"ok":true}'
