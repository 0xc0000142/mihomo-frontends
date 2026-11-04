#!/bin/sh
# 通过 ubus 冒烟测试 rpcd 插件（在路由器上运行，只调用只读方法、无副作用的 validate 与在校验阶段就会被拒绝的写方法；core_check 会联网并写版本缓存）
fail=0
check() { # 名称 期望出现的文本 命令...
	name=$1; want=$2; shift 2
	out=$("$@" 2>&1)
	case "$out" in
		*"$want"*) echo "ok - $name" ;;
		*) echo "not ok - $name :: $out" | head -c 400; echo; fail=1 ;;
	esac
}
check '对象已注册' 'config_read' ubus -v list luci.mihomo
check 'status' '"ok": true' ubus call luci.mihomo status
check 'controller' '"reachable"' ubus call luci.mihomo controller
check 'config_read' '"rev"' ubus call luci.mihomo config_read
check 'backups' '"list"' ubus call luci.mihomo backups
check 'logs' '"text"' ubus call luci.mihomo logs '{"lines":5}'
check 'validate 非法内容' '"valid": false' ubus call luci.mihomo validate '{"content":"foo: [\n"}'
check 'apply_status 校验编号' '任务编号无效' ubus call luci.mihomo apply_status '{"job":"../x"}'
check 'devices' '"list"' ubus call luci.mihomo devices
check 'sections' '"providers"' ubus call luci.mihomo sections '{"names":["providers","basic"]}'
check 'sections 拒绝未知区段' '未知的区段' ubus call luci.mihomo sections '{"names":["nope"]}'
check 'interfaces' '"br-lan"' ubus call luci.mihomo interfaces
check 'tailscale' '"list"' ubus call luci.mihomo tailscale
check 'provider_toggle 校验 rev' '配置已在别处修改' ubus call luci.mihomo provider_toggle '{"name":"x","enabled":true,"rev":"stale"}'
check 'migrate_include_all 校验 rev' '配置已在别处修改' ubus call luci.mihomo migrate_include_all '{"rev":"stale"}'
check 'rule_test 拒绝非法目标' '目标格式不对' ubus call luci.mihomo rule_test '{"target":"a b"}'
check 'service 白名单' '不支持的操作' ubus call luci.mihomo service '{"action":"reboot"}'
check 'ACL 文件为合法 JSON' 'luci-app-mihomo' jsonfilter -i /usr/share/rpcd/acl.d/luci-app-mihomo.json -e '@["luci-app-mihomo"].description' -e '$' 
check '菜单含订阅与设置' 'mihomo/settings' jsonfilter -i /usr/share/luci/menu.d/luci-app-mihomo.json -e '@["admin/services/mihomo/settings"].action.path'
check '菜单为合法 JSON' 'mihomo/overview' jsonfilter -i /usr/share/luci/menu.d/luci-app-mihomo.json -e '@["admin/services/mihomo/overview"].action.path'
check 'core_info' '"asset"' ubus call luci.mihomo core_info
check 'core_check（只写版本缓存）' '"latest"' ubus call luci.mihomo core_check
check 'core_settings 校验仓库' '仓库应写成' ubus call luci.mihomo core_settings '{"repo":"bad","tag":"x","mirror":""}'
check 'setup_status' '"lan_default"' ubus call luci.mihomo setup_status
check 'setup_render' '"content"' ubus call luci.mihomo setup_render '{"subs":[{"name":"t","url":"https://example.com/s"}],"lan":["br-lan"]}'
check 'setup_render 校验订阅' '至少需要一个订阅' ubus call luci.mihomo setup_render '{"subs":[],"lan":["br-lan"]}'
check 'setup_apply 校验 rev' '配置已在别处修改' ubus call luci.mihomo setup_apply '{"source":"import","content":"x: 1","rev":"stale"}'
check '菜单含内核与向导' 'mihomo/setup' jsonfilter -i /usr/share/luci/menu.d/luci-app-mihomo.json -e '@["admin/services/mihomo/core"].action.path' -e '@["admin/services/mihomo/setup"].action.path'
[ $fail = 0 ] && echo "RPC SMOKE PASSED" || { echo "RPC SMOKE FAILED"; exit 1; }
