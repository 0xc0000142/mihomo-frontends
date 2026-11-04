'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const rl = load('view/mihomo/rules.js', { view, ui: {}, api: {}, mui: {}, header: {} });

// parseTarget 与后端 parse_target 规则一致
assert.deepStrictEqual(rl.parseTarget('www.baidu.com'), { host: 'www.baidu.com', port: 443 });
assert.deepStrictEqual(rl.parseTarget(' example.com:80 '), { host: 'example.com', port: 80 });
assert.deepStrictEqual(rl.parseTarget('[2001:db8::1]:8443'), { host: '2001:db8::1', port: 8443 });
assert.deepStrictEqual(rl.parseTarget('2001:db8::1'), { host: '2001:db8::1', port: 443 });
for (const bad of ['', 'a b', 'x.com:0', 'x.com:65536', 'http://x.com', 'x.com/p', '[::1', null])
	assert.strictEqual(rl.parseTarget(bad), null, String(bad));
assert.strictEqual(rl.parseTarget('a'.repeat(254)), null);

// 规则列表：在类型、内容、策略中搜索；extra 缺失时按未停用、0 次命中处理
const rules = [
	{ index: 0, type: 'IPCIDR', payload: '100.64.0.0/10', proxy: 'TS-Server', extra: { disabled: false, hitCount: 3, hitAt: '2026-11-04T00:00:00Z' } },
	{ index: 1, type: 'GeoSite', payload: 'google', proxy: 'Google', extra: { disabled: true, hitCount: 0, hitAt: '1970-01-01T00:00:00Z' } },
	{ index: 2, type: 'Match', payload: '', proxy: '节点选择' }
];
const v = rl.ruleView(rules, '');
assert.strictEqual(v.length, 3);
assert.deepStrictEqual([v[2].disabled, v[2].hits, v[2].hitAt], [false, 0, null]);
assert.deepStrictEqual([v[1].disabled, v[1].hitAt], [true, null]);
assert.strictEqual(v[0].hitAt, '2026-11-04T00:00:00Z');
assert.deepStrictEqual(rl.ruleView(rules, 'GOOGLE').map(r => r.index), [1]);
assert.deepStrictEqual(rl.ruleView(rules, 'ts-').map(r => r.index), [0]);
assert.deepStrictEqual(rl.ruleView(rules, '节点').map(r => r.index), [2]);
assert.deepStrictEqual(rl.ruleView(null, ''), []);

// 匹配结果的链路从策略组到最终节点
assert.strictEqual(rl.chainText(['[SSLinks]台湾 02', '台湾', '节点选择', 'Google']), 'Google → 节点选择 → 台湾 → [SSLinks]台湾 02');
assert.strictEqual(rl.chainText([]), '-');
assert.strictEqual(rl.ruleText({ rule: 'GeoSite', payload: 'CN' }), 'GeoSite(CN)');
assert.strictEqual(rl.ruleText({ rule: 'Match', payload: '' }), 'Match');
assert.strictEqual(rl.ruleText({ rule: '', payload: '' }), '未命中规则（全局或直连模式）');

// 规则文本：按最外层逗号切分，逻辑规则整体作为内容
assert.deepStrictEqual(rl.splitTop('AND,((NETWORK,UDP),(DST-PORT,443)),REJECT'), [ 'AND', '((NETWORK,UDP),(DST-PORT,443))', 'REJECT' ]);
assert.deepStrictEqual(rl.parseRule('DOMAIN-SUFFIX, example.org, 香港'),
	{ type: 'DOMAIN-SUFFIX', value: 'example.org', policy: '香港', opts: [], raw: 'DOMAIN-SUFFIX, example.org, 香港', logic: false });
assert.deepStrictEqual(rl.parseRule('IP-CIDR,100.64.0.0/10,TS-Server,no-resolve').opts, [ 'no-resolve' ]);
assert.deepStrictEqual(rl.parseRule('MATCH,节点选择'), { type: 'MATCH', value: '', policy: '节点选择', opts: [], raw: 'MATCH,节点选择', logic: false });
const lg = rl.parseRule('OR,((RULE-SET,Private-IP),(DOMAIN,lan.example)),DIRECT');
assert.deepStrictEqual([ lg.type, lg.value, lg.policy, lg.logic ], [ 'OR', '((RULE-SET,Private-IP),(DOMAIN,lan.example))', 'DIRECT', true ]);
assert.strictEqual(rl.buildRule({ type: 'MATCH', value: 'x', policy: 'P', opts: [] }), 'MATCH,P');
assert.strictEqual(rl.buildRule({ type: 'RULE-SET', value: 'CN-IP', policy: 'DIRECT', opts: [ 'no-resolve' ] }), 'RULE-SET,CN-IP,DIRECT,no-resolve');
for (const s of [ 'DOMAIN,a.com,DIRECT', 'MATCH,节点选择', 'IP-CIDR6,fd7a:115c:a1e0::/48,TS-Server,no-resolve' ])
	assert.strictEqual(rl.buildRule(rl.parseRule(s)), s, '往返不变：' + s);

// 写回的 items：未改动的只给下标，编辑过的给下标和新文本，新增的只给文本
const orig = [ 'A,1,X', 'B,2,Y', 'MATCH,Z' ];
assert.deepStrictEqual(rl.toItems([ { k: 1, v: 'B,2,Y' }, { k: null, v: 'C,3,X' }, { k: 0, v: 'A,1,Y' }, { k: 2, v: 'MATCH,Z' } ], orig),
	[ { k: 1 }, { v: 'C,3,X' }, { k: 0, v: 'A,1,Y' }, { k: 2 } ]);
assert.strictEqual(rl.isDirty(orig.map((v, k) => ({ k, v })), orig), false);
assert.strictEqual(rl.isDirty([ { k: 1, v: 'B,2,Y' }, { k: 0, v: 'A,1,X' }, { k: 2, v: 'MATCH,Z' } ], orig), true, '只调换顺序也算修改');
assert.strictEqual(rl.isDirty([ { k: 0, v: 'A,1,X' }, { k: 1, v: 'B,2,Y' } ], orig), true, '删除');

// 与运行中的规则按原下标对应；数量不一致时不对应
const runtime = [ { index: 0, extra: { hitCount: 5, disabled: true } }, { index: 1, extra: { hitCount: 1 } }, { index: 2, extra: { hitCount: 9 } } ];
let mr = rl.mergeRows([ { k: 2, v: 'MATCH,Z' }, { k: null, v: 'C,3,X' }, { k: 0, v: 'A,1,X' } ], runtime, 3);
assert.deepStrictEqual(mr.map(r => [ r.pos, r.k, r.hits, r.disabled, r.toggleable ]), [ [ 0, 2, 9, false, true ], [ 1, null, null, false, false ], [ 2, 0, 5, true, true ] ]);
assert.strictEqual(mr[0].rule.type, 'MATCH');
mr = rl.mergeRows([ { k: 0, v: 'A,1,X' } ], runtime, 1);
assert.deepStrictEqual([ mr[0].hits, mr[0].toggleable ], [ null, false ]);

assert.strictEqual(rl.refsText([ '规则第 3 条', 'DNS fake-ip-filter' ]), '正在被使用：规则第 3 条、DNS fake-ip-filter');
assert.strictEqual(rl.refsText([]), '未被引用');
