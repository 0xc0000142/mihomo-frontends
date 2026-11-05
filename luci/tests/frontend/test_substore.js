'use strict';
const assert = require('assert');
const { load } = require('./harness');

const ss = load('view/mihomo/substore.js', { view: { extend: o => o }, ui: {}, api: {}, mui: {}, header: {} });

const local = { mode: 'local', lan: true, port: 3001, path: 'AbC123', installed: { frontend: true } };
assert.strictEqual(ss.openUrl(local, '192.168.1.1'), 'http://192.168.1.1:3001/?api=' + encodeURIComponent('http://192.168.1.1:3001/AbC123'));
assert.strictEqual(ss.openUrl(Object.assign({}, local, { installed: { frontend: false } }), 'fd00::1'),
	'https://sub-store.vercel.app/?api=' + encodeURIComponent('http://[fd00::1]:3001/AbC123'), '没有本地前端时用在线前端；IPv6 加方括号');
assert.strictEqual(ss.openUrl(Object.assign({}, local, { lan: false }), '192.168.1.1'), null, '未开放局域网时浏览器连不上');
assert.strictEqual(ss.openUrl({ mode: 'remote', url: 'https://s.example.com/p' }, 'x'), 'https://sub-store.vercel.app/?api=' + encodeURIComponent('https://s.example.com/p'));
assert.strictEqual(ss.openUrl({ mode: 'off' }, 'x'), null);

assert.strictEqual(ss.providerName('机场/A,B'), '机场_A_B');
assert.strictEqual(ss.providerName('..x'), 'x');
assert.strictEqual(ss.providerName(''), 'Sub-Store');
