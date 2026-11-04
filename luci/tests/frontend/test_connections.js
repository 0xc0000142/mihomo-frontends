'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const cn = load('view/mihomo/connections.js', { view, ui: {}, api: {}, mui: {}, header: {} });

const dev = cn.deviceIndex([
	{ mac: 'aa', name: 'PC', ip4: '192.168.77.138', ip6: ['2409::1', 'fe80::1'] },
	{ mac: 'bb', name: null, ip4: '192.168.77.190', ip6: [] }
]);
assert.deepStrictEqual(dev, { '192.168.77.138': 'PC', '2409::1': 'PC', 'fe80::1': 'PC' });
assert.deepStrictEqual(cn.deviceIndex(null), {});

const t0 = Date.parse('2026-11-04T03:00:00Z');
const conn = (id, o) => Object.assign({
	id, upload: 0, download: 0, start: '2026-11-04T02:59:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '',
	metadata: { network: 'tcp', type: 'EBPF', sourceIP: '192.168.77.138', sourcePort: '50000', host: '', sniffHost: '',
		destinationIP: '1.2.3.4', destinationPort: '443', remoteDestination: '' }
}, o);

const snap1 = { connections: [
	conn('a', { download: 1000, upload: 100 }),
	conn('b', { metadata: { network: 'udp', type: 'Inner', sourceIP: '', sourcePort: '0', host: 'dns.google', destinationIP: '8.8.8.8', destinationPort: '853' },
		chains: ['[Kitty]JP 01', '日本', '节点选择'], rule: 'DomainSuffix', rulePayload: 'google' })
] };
const r1 = cn.toRows(snap1, {}, t0, dev);
assert.strictEqual(r1.rows.length, 2);
const a1 = r1.rows[0], b1 = r1.rows[1];
assert.deepStrictEqual([a1.source, a1.sourceIp, a1.target, a1.network], ['PC', '192.168.77.138', '1.2.3.4:443', 'TCP · EBPF']);
assert.deepStrictEqual([a1.dlRate, a1.ulRate, a1.duration], [0, 0, 60]);
assert.deepStrictEqual([b1.source, b1.target, b1.rule, b1.chain], ['mihomo 内部', 'dns.google:853', 'DomainSuffix(google)', '节点选择 → 日本 → [Kitty]JP 01']);
assert.strictEqual(cn.toRows({ connections: [ conn('c', { rule: 'Match', rulePayload: '' }) ] }, {}, t0, {}).rows[0].rule, 'Match');
// 没有设备名时显示 IP；sniffHost 优先于 IP
const c2 = cn.toRows({ connections: [ conn('d', { metadata: { network: 'tcp', type: 'EBPF', sourceIP: '192.168.77.5', sourcePort: '1', host: '', sniffHost: 'x.com', destinationIP: '1.1.1.1', destinationPort: '443' } }) ] }, {}, t0, dev).rows[0];
assert.deepStrictEqual([c2.source, c2.target], ['192.168.77.5', 'x.com:443']);
// IPv6 目标加方括号
const c3 = cn.toRows({ connections: [ conn('e', { metadata: { network: 'tcp', type: 'EBPF', sourceIP: '2409::1', sourcePort: '1', host: '', destinationIP: 'fd7a::1', destinationPort: '80' } }) ] }, {}, t0, dev).rows[0];
assert.deepStrictEqual([c3.source, c3.target], ['PC', '[fd7a::1]:80']);

// 第二帧：速率 = 累计差 / 时间差；消失的连接不再出现在 prev 中
const snap2 = { connections: [ conn('a', { download: 3000, upload: 600 }) ] };
const r2 = cn.toRows(snap2, r1.prev, t0 + 2000, dev);
assert.deepStrictEqual([r2.rows[0].dlRate, r2.rows[0].ulRate], [1000, 250]);
assert.deepStrictEqual(Object.keys(r2.prev), ['a']);
// 计数器回绕或时间差为 0 时速率为 0
assert.strictEqual(cn.toRows(snap2, r2.prev, t0 + 2000, dev).rows[0].dlRate, 0);
assert.strictEqual(cn.toRows({ connections: [ conn('a', { download: 10 }) ] }, r2.prev, t0 + 3000, dev).rows[0].dlRate, 0);
assert.deepStrictEqual(cn.toRows({}, {}, t0, dev).rows, []);

// 搜索：来源、目标、规则、链路，不区分大小写
assert.ok(cn.matchRow(b1, 'GOOGLE'));
assert.ok(cn.matchRow(b1, '日本'));
assert.ok(cn.matchRow(a1, 'pc'));
assert.ok(cn.matchRow(a1, '1.2.3'));
assert.ok(!cn.matchRow(a1, 'google'));
assert.ok(cn.matchRow(a1, ''));

// 排序：均为降序，start 为最新在前
const rows = [ { id: 1, start: 10, dlRate: 5, ulRate: 1, down: 7, up: 0 }, { id: 2, start: 30, dlRate: 1, ulRate: 9, down: 3, up: 8 }, { id: 3, start: 20, dlRate: 9, ulRate: 0, down: 5, up: 4 } ];
const ids = (k) => cn.sortRows(rows.slice(), k).map(r => r.id);
assert.deepStrictEqual(ids('start'), [2, 3, 1]);
assert.deepStrictEqual(ids('dlRate'), [3, 1, 2]);
assert.deepStrictEqual(ids('ulRate'), [2, 1, 3]);
assert.deepStrictEqual(ids('down'), [1, 3, 2]);
assert.deepStrictEqual(ids('up'), [2, 3, 1]);
