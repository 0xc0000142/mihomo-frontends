#!/system/bin/sh
# Magisk late_start 阶段执行：开机自启 mihomo。
MODDIR=${0%/*}

# 等网络起来再启动，最多等 60 秒
i=0
while [ $i -lt 30 ]; do
  if ping -c 1 -W 2 223.5.5.5 >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

"$MODDIR/scripts/mihomo.sh" autostart >>"$MODDIR/logs/boot.log" 2>&1
