'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const cfg = load('view/mihomo/config.js', { view, api: {}, mui: {}, header: {} });

assert.strictEqual(cfg.lineNumbers('a\nb\nc'), '1\n2\n3');
assert.strictEqual(cfg.lineNumbers(''), '1');
assert.deepStrictEqual(cfg.indent('ab', 1, 1, false), { text: 'a  b', start: 3, end: 3 });
assert.deepStrictEqual(cfg.indent('x\ny', 0, 3, false), { text: '  x\n  y', start: 0, end: 7 });
assert.deepStrictEqual(cfg.indent('  x\n  y', 0, 7, true), { text: 'x\ny', start: 0, end: 3 });

assert.strictEqual(cfg.errorLine('校验失败：yaml: line 383: did not find expected node content'), 383);
assert.strictEqual(cfg.errorLine('proxy group 节点选择: proxy x not found'), null);
assert.strictEqual(cfg.errorLine(null), null);
assert.deepStrictEqual(cfg.lineRange('a\nbb\nccc', 2), { start: 2, end: 4 });
assert.deepStrictEqual(cfg.lineRange('a\nbb\nccc', 3), { start: 5, end: 8 });
assert.deepStrictEqual(cfg.lineRange('a\nbb', 9), { start: 2, end: 4 });
