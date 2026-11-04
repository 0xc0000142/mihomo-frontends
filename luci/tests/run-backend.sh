#!/bin/sh
# 在电脑上运行：把后端测试同步到路由器 /tmp/mlt 并执行。需要先 ./deploy.sh。
set -e
cd "$(dirname "$0")"
ROUTER=${ROUTER:-root@192.168.77.1}
SSH=${SSH:-ssh}
tar -cf - backend fixtures | $SSH "$ROUTER" "rm -rf /tmp/mlt && mkdir -p /tmp/mlt && tar -C /tmp/mlt -xf - && sh /tmp/mlt/backend/main.sh $*"
