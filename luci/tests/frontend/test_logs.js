'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const logs = load('view/mihomo/logs.js', { view, api: {}, mui: {}, header: {} });

assert.strictEqual(logs.matches({ type: 'info', payload: '[TCP] dial Google' }, 'google'), true);
assert.strictEqual(logs.matches({ type: 'info', payload: '[TCP] dial Google' }, 'baidu'), false);
assert.strictEqual(logs.matches({ type: 'warning', payload: 'x' }, ''), true);
assert.strictEqual(logs.matches({ type: 'warning', payload: 'x' }, 'warn'), true);
assert.strictEqual(logs.MAX_LINES, 1000);
