'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const ov = load('view/mihomo/overview.js', { view, api: {}, mui: {}, chart: {}, header: {} });

const proxies = {
	'其他': { type: 'Selector', now: '节点选择', all: ['节点选择', 'DIRECT'] },
	'节点选择': { type: 'Selector', now: '台湾', all: ['台湾', '香港'] },
	'台湾': { type: 'Smart', now: 'Smart - Select', all: ['a', 'b'] },
	'自动': { type: 'URLTest', now: 'node-1', all: ['node-1'] },
	'node-1': { type: 'Vmess' },
	DIRECT: { type: 'Direct' }
};
assert.deepStrictEqual(ov.exitChain(proxies, '其他'), { chain: ['其他', '节点选择', '台湾'], smart: true });
assert.deepStrictEqual(ov.exitChain(proxies, '自动'), { chain: ['自动', 'node-1'], smart: false });
assert.deepStrictEqual(ov.exitChain({ a: { all: ['b'], now: 'b', type: 'Selector' }, b: { all: ['a'], now: 'a', type: 'Selector' } }, 'a').chain, ['a', 'b']);
assert.deepStrictEqual(ov.exitChain(proxies, null), { chain: [], smart: false });

const sub = ov.subSummary({
	name: 'Kitty', vehicleType: 'HTTP', updatedAt: '2026-11-03T17:59:01Z',
	proxies: [ { alive: true }, { alive: false }, { alive: true } ],
	subscriptionInfo: { Upload: 1, Download: 3, Total: 8, Expire: 1823310965 }
});
assert.deepStrictEqual([sub.alive, sub.total, sub.used, sub.quota, sub.ratio], [2, 3, 4, 8, 0.5]);
assert.strictEqual(ov.subSummary({ proxies: [], subscriptionInfo: { Total: 0, Expire: 0 } }).ratio, null);

const ms = ov.mapSummary({ status: 'pass', maps: [
	{ name: 'a', category: 'runtime', supported: true, entries: 10, max_entries: 100, pressure: 'healthy' },
	{ name: 'b', category: 'configured_policy', supported: true, entries: 90, max_entries: 100, pressure: 'configured' },
	{ name: 'c', category: 'runtime', supported: false, max_entries: 1, pressure: 'not_applicable' }
] });
assert.deepStrictEqual([ms.cls, ms.pressured, ms.busiest], ['mh-ok', [], { name: 'a', ratio: 0.1 }]);
assert.strictEqual(ms.text, '正常 · 3 个');
const mw = ov.mapSummary({ status: 'warning', maps: [ { name: 'x', category: 'runtime', supported: true, entries: 90, max_entries: 100, pressure: 'warning' } ] });
assert.deepStrictEqual([mw.cls, mw.pressured, mw.text], ['mh-warn', ['x'], '接近上限 · 1 个 · 1 个接近上限']);
assert.strictEqual(ov.mapSummary(null).busiest, null);

const now = Date.UTC(2026, 10, 4);
assert.strictEqual(ov.expireClass(0, now), '');
assert.strictEqual(ov.expireClass(now / 1000 - 1, now), 'mh-err');
assert.strictEqual(ov.expireClass(now / 1000 + 4 * 86400, now), 'mh-warn');
assert.strictEqual(ov.expireClass(now / 1000 + 30 * 86400, now), '');
