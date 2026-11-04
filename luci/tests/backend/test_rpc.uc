'use strict';

import * as fs from 'fs';
import { ok, eq, done } from 'lib';

// 直接加载 rpcd 插件（路由器上是已部署的文件，本机是仓库里的文件），检查方法表与 ACL 一致
const ROOT = getenv('MLT_REPO') ? getenv('MLT_REPO') + '/root' : '';
let plugin = loadfile(ROOT + '/usr/share/rpcd/ucode/luci.mihomo.uc')();
let methods = plugin['luci.mihomo'];
ok(type(methods) == 'object', '插件导出 luci.mihomo');

let acl = json(fs.readfile(ROOT + '/usr/share/rpcd/acl.d/luci-app-mihomo.json'))['luci-app-mihomo'];
let granted = [...acl.read.ubus['luci.mihomo'], ...acl.write.ubus['luci.mihomo']];
eq(sort([...granted]), sort(keys(methods)), 'ACL 与插件的方法一一对应');
eq(length(uniq(granted)), length(granted), 'ACL 中没有重复的方法');
for (let m in ['core_check', 'core_update', 'core_rollback', 'core_settings', 'setup_apply'])
	ok(index(acl.write.ubus['luci.mihomo'], m) >= 0, m + ' 需要写权限');
for (let m, d in methods)
	ok(type(d.call) == 'function', m + ' 可调用');

let call = (m, args) => methods[m].call({ args: args });
let st = call('setup_status');
ok(st.ok && type(st.lan_default) == 'array', 'setup_status', st);
let ci = call('core_info');
ok(ci.ok && 'installed' in ci && 'settings' in ci, 'core_info', ci);
let r = call('setup_render', { subs: [{ name: 't', url: 'https://example.com/s' }], lan: ['br-lan'] });
ok(r.ok && index(r.content, '"t"') >= 0, 'setup_render', r.error);
eq(call('setup_render', { subs: [], lan: ['br-lan'] }).error, '至少需要一个订阅', 'setup_render 校验');
eq(call('core_settings', { repo: 'bad', tag: 'x', mirror: '' }).ok, false, 'core_settings 校验');

done();
