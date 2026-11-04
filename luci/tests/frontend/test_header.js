'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const hd = load('mihomo/header.js', { baseclass, api: {}, mui: {} });

// 顶部提示的优先级：缺内核 → 缺配置 → 服务未运行 → 控制器不可达 → 连接断开
const run = { running: true, version: 'v1', config_present: true };
assert.deepStrictEqual(hd.bannerFor({ ...run, version: null, running: false, config_present: false }, null, null),
	{ text: '尚未安装 mihomo 内核。设置向导会下载适配本机的内核并生成配置。', kind: 'setup' });
assert.deepStrictEqual(hd.bannerFor({ ...run, running: false, config_present: false }, null, null),
	{ text: '还没有配置文件。可以在设置向导里用内置模板生成，或下载、导入已有配置。', kind: 'setup' });
assert.deepStrictEqual(hd.bannerFor({ ...run, running: false }, null, null),
	{ text: '服务未运行，实时数据不可用。可点击右上角「启动」。', kind: 'info' });
assert.deepStrictEqual(hd.bannerFor(run, '只监听本机', true), { text: '只监听本机', kind: 'warn' });
assert.deepStrictEqual(hd.bannerFor(run, null, false), { text: '与 mihomo 控制器的连接已断开，正在重连…', kind: 'info' });
assert.strictEqual(hd.bannerFor(run, null, true), null);
assert.strictEqual(hd.bannerFor(null, null, null), null);
// 向导页自身不再提示去向导
assert.deepStrictEqual(hd.bannerFor({ ...run, running: false, config_present: false }, null, null, true),
	{ text: '服务未运行，实时数据不可用。可点击右上角「启动」。', kind: 'info' });
// 旧版后端的 status 没有 config_present 字段：不能当成缺配置
assert.strictEqual(hd.bannerFor({ running: true, version: 'v1' }, null, true), null);
