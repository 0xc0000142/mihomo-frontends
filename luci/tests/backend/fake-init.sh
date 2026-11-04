#!/bin/sh
# 测试用 init 脚本，实现 /etc/init.d/mihomo 的 start/stop/restart/running 子集
T=/tmp/mlt
PID=$T/run/test.pid
BIN=${MIHOMO_LUCI_BIN:-/usr/bin/mihomo-ebpf}
H=${MIHOMO_LUCI_HOME:-$T/home}

running() { [ -f $PID ] && kill -0 "$(cat $PID)" 2>/dev/null; }

case "$1" in
	start)
		running && exit 0
		mkdir -p $T/run
		if command -v start-stop-daemon >/dev/null; then
			start-stop-daemon -S -b -m -p $PID -x $BIN -- -d $H
		else
			setsid $BIN -d $H </dev/null >/dev/null 2>&1 &
			echo $! > $PID
		fi
		;;
	stop)
		if running; then
			kill "$(cat $PID)"
			for i in 1 2 3 4 5; do running || break; sleep 1; done
		fi
		rm -f $PID
		;;
	restart) "$0" stop; "$0" start ;;
	running) running ;;
	enable|disable) : ;;
	*) exit 1 ;;
esac
