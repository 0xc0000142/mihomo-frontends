#!/bin/sh
# 开发用部署（直接复制文件，不经过软件包）：./deploy.sh [root@192.168.77.1]
# 环境变量 SSH 可替换 ssh 命令（例如带密码助手的包装脚本）。正式安装请用 scripts/build-apk.sh 生成的软件包。
set -e
cd "$(dirname "$0")"
sh scripts/sync-template.sh
ROUTER=${1:-${ROUTER:-root@192.168.77.1}}
SSH=${SSH:-ssh}

sum() { find "$@" -type f | sort | xargs cat | md5sum | cut -d' ' -f1; }
# 后端文件有变化时才重启 rpcd：重启会让已登录的 LuCI 会话失效
BACKEND=$(sum root/usr/share/rpcd root/usr/share/ucode root/usr/libexec)
# 前端文件有变化时更新 LuCI 的缓存版本号：LuCI 用 apk 数据库的修改时间作为 ?v= 参数，
# 正式安装软件包时会自然更新；这里直接复制文件，所以手动 touch，避免浏览器继续使用旧的 JS/CSS
FRONTEND=$(sum root/www root/usr/share/luci)
# UCI 文件只在路由器上不存在时写入，不覆盖已保存的下载设置
UCI=$(cat root/etc/config/mihomo)

tar -C root --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' -cf - usr www lib etc/init.d | $SSH "$ROUTER" "
set -e
S=/usr/share/mihomo-luci
old_backend=\$(cat \$S/backend.md5 2>/dev/null || true)
old_frontend=\$(cat \$S/frontend.md5 2>/dev/null || true)
tar -C / -xf -
[ -f /etc/config/mihomo ] || cat > /etc/config/mihomo <<'UCI_EOF'
$UCI
UCI_EOF
for p in yq curl ca-bundle; do apk info -e \$p >/dev/null 2>&1 || apk add \$p </dev/null; done
chmod 755 /usr/libexec/mihomo-luci/apply-job /usr/libexec/mihomo-luci/substore-install /etc/init.d/mihomo /etc/init.d/mihomo-substore
mkdir -p \$S
echo $BACKEND > \$S/backend.md5
echo $FRONTEND > \$S/frontend.md5
rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
if [ \"\$old_frontend\" != $FRONTEND ]; then touch /lib/apk/db/installed; echo '前端已更新'; fi
if [ \"\$old_backend\" != $BACKEND ]; then /etc/init.d/rpcd restart; echo 'rpcd 已重启（LuCI 需要重新登录）'; fi
echo '部署完成'
"
