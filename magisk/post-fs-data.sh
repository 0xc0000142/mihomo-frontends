#!/system/bin/sh
# 数据分区解锁后尽快就绪：建立运行目录。
MODDIR=${0%/*}
mkdir -p "$MODDIR/logs" "$MODDIR/run"
