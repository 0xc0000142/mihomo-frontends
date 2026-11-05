#!/system/bin/sh
. "${0%/*}/common.sh"

case "${1:-get}" in
  get)
    [ "$#" -le 1 ] || { json_error '不支持的参数'; exit 1; }
    has_config=false
    completed=false
    if [ -e "$CONFIG" ] || [ -L "$CONFIG" ]; then
      [ -f "$CONFIG" ] && [ -r "$CONFIG" ] || { json_error '现有配置不可读，请检查权限'; exit 1; }
      [ ! -s "$CONFIG" ] || has_config=true
    fi
    [ ! -f "$DATA/onboarding.done" ] || completed=true
    printf '{"ok":true,"has_config":%s,"completed":%s}\n' "$has_config" "$completed"
    ;;
  complete)
    [ "$#" -eq 1 ] || { json_error '不支持的参数'; exit 1; }
    ensure_dirs || { json_error '无法创建数据目录'; exit 1; }
    lock_backend || { json_error '后台忙，请稍后重试'; exit 1; }
    trap 'unlock_backend' EXIT
    [ ! -L "$DATA/onboarding.done" ] || { json_error '向导标记不能是符号链接'; exit 1; }
    printf '1\n' > "$DATA/onboarding.done" || { json_error '无法保存向导状态'; exit 1; }
    printf '{"ok":true}\n'
    ;;
  *) json_error '不支持的向导操作'; exit 1 ;;
esac
