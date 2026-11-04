'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const view = { extend: o => o };
const mui = load('mihomo/ui.js', { baseclass, ui: {}, api: {} });
const su = load('view/mihomo/setup.js', { view, ui: {}, api: {}, mui, header: {}, corecard: {} });

/* 订阅行校验：空行忽略、名称可自动补、地址必须是 http(s) */
let r = su.validateSubs([ { name: ' 机场A ', url: ' https://a.example/sub?token=1 ', ua: '' }, { name: '', url: '', ua: '' } ]);
assert.deepStrictEqual(r, { ok: true, subs: [ { name: '机场A', url: 'https://a.example/sub?token=1' } ] });

r = su.validateSubs([ { name: '', url: 'https://a.example/1' }, { name: '', url: 'http://b.example/2', ua: 'clash.meta' } ]);
assert.deepStrictEqual(r.subs, [ { name: '订阅1', url: 'https://a.example/1' }, { name: '订阅2', url: 'http://b.example/2', ua: 'clash.meta' } ]);

// 自动名称避开已有名称
r = su.validateSubs([ { name: '订阅2', url: 'https://a.example/1' }, { name: '', url: 'https://b.example/2' } ]);
assert.deepStrictEqual(r.subs.map(s => s.name), [ '订阅2', '订阅3' ]);

assert.deepStrictEqual(su.validateSubs([]), { ok: false, error: '至少需要一个订阅' });
assert.deepStrictEqual(su.validateSubs([ { name: '', url: ' ' } ]), { ok: false, error: '至少需要一个订阅' });
assert.strictEqual(su.validateSubs([ { name: 'x', url: '' } ]).error, '订阅「x」缺少地址');
assert.strictEqual(su.validateSubs([ { name: 'x', url: 'ftp://a' } ]).error, '订阅「x」的地址需要以 http:// 或 https:// 开头');
assert.strictEqual(su.validateSubs([ { name: 'x', url: 'https://a b' } ]).error, '订阅「x」的地址需要以 http:// 或 https:// 开头');
assert.strictEqual(su.validateSubs([ { name: 'a/b', url: 'https://a' } ]).error, '订阅名称「a/b」无效：不能包含 / , \\，不能以 . 开头，最长 64 个字符');
assert.strictEqual(su.validateSubs([ { name: '.x', url: 'https://a' } ]).ok, false);
assert.strictEqual(su.validateSubs([ { name: 'x'.repeat(65), url: 'https://a' } ]).ok, false);
assert.strictEqual(su.validateSubs([ { name: 'x', url: 'https://a' }, { name: 'x', url: 'https://b' } ]).error, '订阅名称重复：x');
assert.strictEqual(su.validateSubs(Array.from({ length: 33 }, (_, i) => ({ name: 's' + i, url: 'https://a/' + i }))).error, '订阅过多（最多 32 个）');

/* 下联接口：可选列表与默认勾选 */
const IFS = [
	{ name: 'br-lan', kind: 'bridge', up: true, master: null, addrs: [ '192.168.77.1/24' ], is_default_upstream: false },
	{ name: 'eth0', kind: null, up: true, master: 'br-lan', addrs: [], is_default_upstream: false },
	{ name: 'wwan0', kind: null, up: true, master: null, addrs: [ '10.1.2.3/30' ], is_default_upstream: true },
	{ name: 'tailscale0', kind: 'tun', up: true, master: null, addrs: [ '100.64.0.1/32' ], is_default_upstream: false },
	// 基带的虚拟网卡：未连接或没有地址，不能作为局域网设备的网关
	{ name: 'sipa_dummy0', kind: null, up: true, master: null, addrs: [], is_default_upstream: false },
	{ name: 'sipa_eth0', kind: null, up: false, master: null, addrs: [], is_default_upstream: false }
];
assert.deepStrictEqual(su.defaultLan(IFS, [ 'br-lan' ]), [ 'br-lan' ]);
assert.deepStrictEqual(su.defaultLan(IFS, []), [ 'br-lan' ]);
assert.deepStrictEqual(su.defaultLan(IFS, [ 'gone' ]), [ 'br-lan' ]);
assert.deepStrictEqual(su.defaultLan([ { name: 'lan1', kind: 'bridge', master: null, is_default_upstream: false } ], []), [ 'lan1' ]);
assert.deepStrictEqual(su.defaultLan([], [ 'br-lan' ]), [ 'br-lan' ], '读不到接口列表时信任 network.lan');
assert.deepStrictEqual(su.defaultLan([], []), [ 'br-lan' ]);
assert.deepStrictEqual(su.defaultLan(IFS.filter(i => i.name === 'wwan0'), []), []);

// 桥接成员不单独列出；默认出口排在最后；已选但不在列表里的名称补上
const ch = su.lanChoices(IFS, [ 'br-lan', 'lan9' ]);
assert.deepStrictEqual(ch.map(c => c.name), [ 'br-lan', 'tailscale0', 'lan9', 'wwan0' ]);
assert.deepStrictEqual(ch.map(c => c.upstream), [ false, false, false, true ]);
assert.match(ch[0].label, /网桥/);
assert.match(ch[3].label, /默认出口/);
// 未连接、没有地址的接口不列出，但已选中的保留
assert.deepStrictEqual(su.lanChoices(IFS, [ 'sipa_eth0' ]).map(c => c.name), [ 'br-lan', 'tailscale0', 'sipa_eth0', 'wwan0' ]);

/* 提交参数：三种来源 */
const st = { source: 'template', subs: [ { name: 'a', url: 'https://a' } ], lan: [ 'br-lan' ], secret: ' s3 ', url: ' https://c ', ua: '', content: 'x: 1', adapt: true, start: true };
assert.deepStrictEqual(su.buildArgs(st, 'r1'),
	{ source: 'template', subs: st.subs, lan: [ 'br-lan' ], secret: 's3', start: true, rev: 'r1' });
assert.deepStrictEqual(su.buildArgs({ ...st, source: 'url' }, null),
	{ source: 'url', url: 'https://c', ua: '', adapt: true, lan: [ 'br-lan' ], start: true, rev: '' });
assert.deepStrictEqual(su.buildArgs({ ...st, source: 'import', adapt: false, start: false }, 'r2'),
	{ source: 'import', content: 'x: 1', adapt: false, lan: [], start: false, rev: 'r2' });

/* 向导停在哪一步 */
assert.strictEqual(su.firstStep({ ok: true, core: false, config: false }), 0);
assert.strictEqual(su.firstStep({ ok: true, core: true, config: false }), 1);
assert.strictEqual(su.firstStep({ ok: true, core: true, config: true }), 1);
assert.strictEqual(su.firstStep(null), 0);

/* 结果说明 */
assert.deepStrictEqual(su.resultLines({ state: 'done', adapted: [ 'eBPF 透明代理（下联 br-lan）', 'DNS' ], launched: true }),
	[ '已补全：eBPF 透明代理（下联 br-lan）、DNS', '服务已启动，并设为开机自启' ]);
assert.deepStrictEqual(su.resultLines({ state: 'done', restarted: true }), [ '服务已按新配置重启' ]);
assert.deepStrictEqual(su.resultLines({ state: 'done', note: '服务未运行，新配置将在下次启动时生效' }), [ '服务未运行，新配置将在下次启动时生效' ]);
assert.deepStrictEqual(su.resultLines({ state: 'done', adapted: [] }), [ '配置已保存' ]);
