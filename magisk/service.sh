#!/system/bin/sh
MODDIR=${0%/*}
SCRIPTS=$MODDIR/scripts
export MODDIR SCRIPTS
. "$SCRIPTS/common.sh"
ensure_dirs || exit 1
(
  close_inherited_fds
  trap '' HUP
  tool setsid sh "$SCRIPTS/policy.sh" watch </dev/null >>"$RUN_DIR/boot.log" 2>&1
) </dev/null >/dev/null 2>&1 &
# 网页管理（启用时才启动）
sh "$SCRIPTS/webui.sh" boot </dev/null >>"$RUN_DIR/boot.log" 2>&1 &
