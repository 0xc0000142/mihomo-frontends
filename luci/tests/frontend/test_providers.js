'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const pv = load('view/mihomo/providers.js', { view, ui: {}, api: {}, mui: {}, header: {} });

// 流量与到期
assert.deepStrictEqual(pv.usage({ Upload: 100, Download: 300, Total: 1000, Expire: 1800000000 }),
	{ used: 400, total: 1000, ratio: 0.4, expire: 1800000000 });
assert.deepStrictEqual(pv.usage({ Upload: 0, Download: 0, Total: 0, Expire: 1800000000 }), { used: 0, total: 0, ratio: null, expire: 1800000000 });
assert.strictEqual(pv.usage({ Upload: 5, Download: 5, Total: 0, Expire: 0 }), null, '既无总量也无到期时不显示');
assert.strictEqual(pv.usage(null), null);
assert.strictEqual(pv.usage({ Upload: 900, Download: 900, Total: 1000 }).ratio, 1, '超额时比例封顶');

// 合并运行时信息：停用的订阅不取运行时数据
const list = [
	{ name: 'A', enabled: true, url: 'https://a' },
	{ name: 'B', enabled: false, url: 'https://b' },
	{ name: 'C', enabled: true, url: 'https://c' }
];
const rt = {
	A: { proxies: [ { alive: true }, { alive: false }, { alive: true } ], updatedAt: '2026-11-04T00:00:00Z', subscriptionInfo: { Upload: 1, Download: 1, Total: 4 } },
	B: { proxies: [ { alive: true } ] }
};
const m = pv.mergeRuntime(list, rt);
assert.deepStrictEqual([ m[0].loaded, m[0].count, m[0].alive, m[0].updatedAt, m[0].usage.ratio ], [ true, 3, 2, '2026-11-04T00:00:00Z', 0.5 ]);
assert.deepStrictEqual([ m[1].loaded, m[1].count ], [ false, 0 ]);
assert.deepStrictEqual([ m[2].loaded, m[2].usage ], [ false, null ]);
assert.strictEqual(m[0].url, 'https://a', '保留原字段');
assert.strictEqual(list[0].count, undefined, '不修改输入');
assert.deepStrictEqual(pv.mergeRuntime(null, null), []);

// 表单转 data：数字字段转数字，空串保持空串（后端视为删除）
assert.deepStrictEqual(pv.formToData({
	url: ' https://x/sub?token=1 ', interval: '3600', prefix: ' [X] ', user_agent: '',
	hc_enable: true, hc_url: 'https://cp.cloudflare.com', hc_interval: '300', hc_timeout: ''
}), {
	url: 'https://x/sub?token=1', interval: 3600, prefix: '[X]', user_agent: '',
	health_check: { enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: '' }
});
assert.strictEqual(pv.formToData({ join_groups: false }).join_groups, false);
assert.ok(!('join_groups' in pv.formToData({})), '编辑时不带 join_groups');
assert.ok(Number.isNaN(pv.formToData({ interval: 'abc' }).interval), '非数字交给校验处理');

// 链接遮挡
assert.strictEqual(pv.maskUrl('https://sub.example.com/api/v1/client/subscribe?token=abc'), 'https://sub.example.com/…');
assert.strictEqual(pv.maskUrl('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
assert.strictEqual(pv.maskUrl(''), '');
assert.strictEqual(pv.maskUrl('garbage'), '…');

// 名称规则与后端一致
assert.ok(pv.validName('红魔馆网络') && pv.validName('Kitty'));
for (const bad of [ '', ' a', 'a/b', 'a,b', 'a\\b', '.x', 'a\nb', 'x'.repeat(65) ])
	assert.ok(!pv.validName(bad), JSON.stringify(bad));
