'use strict';
const assert = require('assert');
const { load } = require('./harness');

const view = { extend: o => o };
const logs = load('view/mihomo/logs.js', { view, ui: {}, api: {}, mui: {}, header: {} });

assert.strictEqual(logs.matches({ type: 'info', payload: '[TCP] dial Google' }, 'google'), true);
assert.strictEqual(logs.matches({ type: 'info', payload: '[TCP] dial Google' }, 'baidu'), false);
assert.strictEqual(logs.matches({ type: 'warning', payload: 'x' }, ''), true);
assert.strictEqual(logs.matches({ type: 'warning', payload: 'x' }, 'warn'), true);
assert.strictEqual(logs.MAX_LINES, 1000);

// 诊断信息打码：链接、密钥、tskey、公网 IP；局域网与 Tailnet 地址保留
const red = logs.redact('url: https://sub.example.com/api?token=abc\nsecret: hunter2\nauth-key: tskey-auth-xyz\npeer 1.2.3.4 lan 192.168.1.1 ts 100.101.1.2');
assert.ok(!/sub\.example\.com|hunter2|tskey-auth|1\.2\.3\.4/.test(red), red);
assert.ok(red.includes('https://***') && red.includes('1.2.x.x') && red.includes('192.168.1.1') && red.includes('100.101.1.2'), red);
