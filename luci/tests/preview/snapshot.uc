'use strict';

// 离线预览的 rpc 快照：用真实插件的只读方法读样例配置，结果按方法名写成 JSON（stdout）。
// 由 tests/preview/snapshot.sh 在 WSL 里调用；依赖系统状态的方法（status、devices 等）在本机拿不到真实数据，
// 由 tests/preview/mock.js 补成样例。
const ROOT = getenv('MLT_REPO') + '/root';
let methods = loadfile(ROOT + '/usr/share/rpcd/ucode/luci.mihomo.uc')()['luci.mihomo'];
let call = (m, args) => {
	try {
		return methods[m].call({ args: args ?? {} });
	} catch (e) {
		return { ok: false, error: 'snapshot: ' + e.message };
	}
};

let out = {
	config_read: call('config_read'),
	backups: call('backups'),
	sections: call('sections', { names: [] }),
	core_info: call('core_info'),
	setup_status: call('setup_status'),
	interfaces: call('interfaces')
};
print(sprintf('%.J\n', out));
