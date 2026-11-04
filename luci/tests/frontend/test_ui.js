'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const ui = load('mihomo/ui.js', { baseclass, ui: {}, api: {} });

assert.strictEqual(ui.fmtBytes(0), '0 B');
assert.strictEqual(ui.fmtBytes(1023), '1023 B');
assert.strictEqual(ui.fmtBytes(1536), '1.5 KB');
assert.strictEqual(ui.fmtBytes(200 * 1024 * 1024), '200 MB');
assert.strictEqual(ui.fmtBytes(3.25 * 1024 ** 4), '3.3 TB');
assert.strictEqual(ui.fmtBytes(null), '0 B');
assert.strictEqual(ui.fmtRate(2048), '2.0 KB/s');

assert.strictEqual(ui.fmtDuration(5), '5 秒');
assert.strictEqual(ui.fmtDuration(65), '1 分 5 秒');
assert.strictEqual(ui.fmtDuration(3 * 3600 + 120), '3 小时 2 分');
assert.strictEqual(ui.fmtDuration(2 * 86400 + 3600), '2 天 1 小时');

assert.strictEqual(ui.fmtDate(null), '-');
assert.strictEqual(ui.fmtDate('0001-01-01T00:00:00Z'), '-');
assert.match(ui.fmtDate(1700000000), /^2023-11-1[45] \d\d:\d\d$/);
assert.match(ui.fmtDate('2026-11-03T17:55:53Z'), /^2026-11-0[34] \d\d:\d\d$/);

assert.strictEqual(ui.fmtAgo(Date.now() - 30 * 1000), '刚刚');
assert.strictEqual(ui.fmtAgo(new Date(Date.now() - 5 * 60 * 1000).toISOString()), '5 分钟前');
assert.strictEqual(ui.fmtAgo('0001-01-01T00:00:00Z'), '-');

assert.strictEqual(ui.delayClass(undefined), 'none');
assert.strictEqual(ui.delayClass(0), 'bad');
assert.strictEqual(ui.delayClass(120), 'good');
assert.strictEqual(ui.delayClass(300), 'mid');
assert.strictEqual(ui.delayClass(800), 'bad');

assert.strictEqual(ui.STEPS.restart, '重启服务并等待恢复');

assert.strictEqual(ui.ifLabel({ name: 'br-lan', kind: 'bridge', up: true, addrs: [ '192.168.77.1/24' ] }), 'br-lan（网桥，192.168.77.1/24）');
assert.strictEqual(ui.ifLabel({ name: 'wan', kind: null, up: true, is_default_upstream: true, addrs: [] }), 'wan（默认出口）');
assert.strictEqual(ui.ifLabel({ name: 'usb0', up: false, addrs: [] }), 'usb0（未连接）');

/* 搜索框要带 cbi-input-text，否则主题不给边框与内边距（只剩一行占位文字） */
{
	const fs = require('fs');
	const path = require('path');
	const dir = path.join(__dirname, '../../root/www/luci-static/resources/view/mihomo');
	const bare = fs.readdirSync(dir).filter(f => f.endsWith('.js'))
		.flatMap(f => (fs.readFileSync(path.join(dir, f), 'utf8').match(/'class': '[^']*\bmh-search\b[^']*'/g) || [])
			.filter(c => !/\bcbi-input-text\b/.test(c)).map(c => f + ': ' + c));
	assert.deepStrictEqual(bare, []);
}
