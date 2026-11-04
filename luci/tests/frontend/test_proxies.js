'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const px = load('view/mihomo/proxies.js', { view, ui: {}, api: {}, mui: {}, header: {} });

const URL1 = 'https://cp.cloudflare.com';
const h = (...d) => d.map((delay, i) => ({ time: '2026-11-04T00:0' + i + ':00Z', delay }));

const proxies = {
	GLOBAL: { name: 'GLOBAL', type: 'Selector', now: 'DIRECT', all: ['DIRECT', '节点选择', '隐藏组', '日本', 'REJECT', '自动'] },
	'节点选择': { name: '节点选择', type: 'Selector', now: '日本', all: ['日本', '自动', 'DIRECT'], history: [] },
	'日本': { name: '日本', type: 'Smart', now: 'Smart - Select', all: ['jp1', 'jp2', 'jp3'], testUrl: URL1, history: h(120) },
	'自动': { name: '自动', type: 'URLTest', now: 'jp2', all: ['jp1', 'jp2'], testUrl: URL1 },
	'隐藏组': { name: '隐藏组', type: 'Selector', now: 'DIRECT', all: ['DIRECT'], hidden: true },
	DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
	REJECT: { name: 'REJECT', type: 'Reject', history: [] },
	jp1: { name: 'jp1', type: 'Compatible', history: [] }
};
const providers = {
	Kitty: { vehicleType: 'HTTP', proxies: [
		{ name: 'jp1', type: 'Vless', alive: true, history: h(300, 210), extra: { [URL1]: { alive: true, history: h(90) } } },
		{ name: 'jp2', type: 'Trojan', alive: false, history: h(0), extra: {} },
		{ name: 'jp3', type: 'Hysteria2', alive: true, history: [] }
	] },
	default: { vehicleType: 'Compatible', proxies: [ { name: 'DIRECT', type: 'Direct', history: [] } ] }
};

// buildIndex：订阅里的节点先放，/proxies 的条目覆盖同名项（jp1 在 /proxies 里只是 Compatible 占位时不应覆盖真实节点）
const idx = px.buildIndex(proxies, providers);
assert.strictEqual(idx.jp1.type, 'Vless');
assert.strictEqual(idx['日本'].type, 'Smart');
assert.strictEqual(idx.jp3.type, 'Hysteria2');
assert.strictEqual(idx.DIRECT.type, 'Direct');

// delayPath：顶层代理走 /proxies，订阅节点走 /providers/proxies/{订阅}/{节点}/healthcheck
const prov = px.providerMap(providers);
assert.deepStrictEqual(prov, { jp1: 'Kitty', jp2: 'Kitty', jp3: 'Kitty' });
assert.strictEqual(px.delayPath('DIRECT', proxies, prov), '/proxies/DIRECT/delay');
assert.strictEqual(px.delayPath('jp1', proxies, prov), '/providers/proxies/Kitty/jp1/healthcheck');
assert.strictEqual(px.delayPath('jp3', proxies, prov), '/providers/proxies/Kitty/jp3/healthcheck');
assert.strictEqual(px.delayPath('a b/c', {}, { 'a b/c': '订 阅' }), '/providers/proxies/%E8%AE%A2%20%E9%98%85/a%20b%2Fc/healthcheck');
assert.strictEqual(px.delayPath('unknown', {}, {}), null);

// groupList：按 GLOBAL.all 顺序，只取策略组，去掉隐藏组，GLOBAL 放最后
assert.deepStrictEqual(px.groupList(proxies), ['节点选择', '日本', '自动', 'GLOBAL']);
assert.deepStrictEqual(px.groupList({ b: { all: [] }, a: { all: [] }, x: { type: 'Direct' } }), ['a', 'b']);

// latestDelay：本页测速结果 > extra[url] > history；没有记录为 null
assert.strictEqual(px.latestDelay(idx.jp1, URL1, {}), 90);
assert.strictEqual(px.latestDelay(idx.jp1, '', {}), 210);
assert.strictEqual(px.latestDelay(idx.jp1, URL1, { [URL1]: { jp1: 55 } }), 55);
assert.strictEqual(px.latestDelay(idx.jp2, URL1, {}), 0);
assert.strictEqual(px.latestDelay(idx.jp3, URL1, {}), null);
assert.strictEqual(px.latestDelay(undefined, URL1, {}), null);

// nodeView：默认顺序、按延迟（未测与超时在最后）、按名称、隐藏不可用、搜索
const g = proxies['日本'];
const names = v => v.map(n => n.name);
assert.deepStrictEqual(names(px.nodeView(g, idx, {})), ['jp1', 'jp2', 'jp3']);
const v0 = px.nodeView(g, idx, { tested: { [URL1]: { jp3: 40 } } });
assert.deepStrictEqual(v0.map(n => [n.name, n.delay, n.alive]), [['jp1', 90, true], ['jp2', 0, false], ['jp3', 40, true]]);
assert.deepStrictEqual(names(px.nodeView(g, idx, { sort: 'delay', tested: { [URL1]: { jp3: 40 } } })), ['jp3', 'jp1', 'jp2']);
assert.deepStrictEqual(names(px.nodeView(g, idx, { sort: 'delay' })), ['jp1', 'jp2', 'jp3']);
assert.deepStrictEqual(names(px.nodeView({ all: ['b', 'A', 'c'] }, {}, { sort: 'name' })), ['A', 'b', 'c']);
assert.deepStrictEqual(names(px.nodeView(g, idx, { hideDead: true })), ['jp1', 'jp3']);
assert.deepStrictEqual(names(px.nodeView(g, idx, { q: 'JP2' })), ['jp2']);
// 当前节点：select/url-test 看 now，smart 看 fixed
assert.deepStrictEqual(px.nodeView(proxies['自动'], idx, {}).map(n => n.current), [false, true]);
assert.deepStrictEqual(px.nodeView(Object.assign({}, g, { fixed: 'jp3' }), idx, {}).map(n => n.current), [false, false, true]);
assert.deepStrictEqual(px.nodeView(g, idx, {}).map(n => n.current), [false, false, false]);
// 组成员是策略组时，类型显示为组类型
assert.strictEqual(px.nodeView(proxies['节点选择'], idx, {})[0].type, 'Smart');

// nowChain：沿 now 追到最终节点，smart 组与循环处停止
assert.deepStrictEqual(px.nowChain(proxies['节点选择'], idx), ['日本']);
assert.deepStrictEqual(px.nowChain({ now: '自动' }, idx), ['自动', 'jp2']);
assert.deepStrictEqual(px.nowChain({ now: 'a' }, { a: { all: ['b'], now: 'b' }, b: { all: ['a'], now: 'a' } }), ['a', 'b']);
assert.deepStrictEqual(px.nowChain({ now: '' }, idx), []);

// 类型名称
assert.strictEqual(px.typeLabel('Selector'), '手动选择');
assert.strictEqual(px.typeLabel('Smart'), 'Smart');
assert.strictEqual(px.typeLabel('Vless'), 'Vless');
