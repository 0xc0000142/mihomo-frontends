'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const cc = load('mihomo/corecard.js', { baseclass, ui: {}, api: {}, mui: {} });

/* 下载线路说明：服务运行时先经本机代理 */
assert.strictEqual(cc.describeRoute({ mirror: 'https://ghfast.top/' }, true), '本机代理 → 镜像 ghfast.top');
assert.strictEqual(cc.describeRoute({ mirror: 'https://ghfast.top/' }, false), '镜像 ghfast.top');
assert.strictEqual(cc.describeRoute({ mirror: '' }, false), '直连 GitHub');
assert.strictEqual(cc.describeRoute({ mirror: '' }, true), '本机代理 → 直连 GitHub');
assert.strictEqual(cc.describeRoute({ mirror: 'http://10.0.0.2:8080/gh/' }, false), '镜像 10.0.0.2:8080');
assert.strictEqual(cc.describeRoute(null, false), '直连 GitHub');

/* 任务步骤 */
assert.strictEqual(cc.stepLabel('download'), '下载内核');
assert.strictEqual(cc.stepLabel('selftest'), '试运行新内核');
assert.strictEqual(cc.stepLabel('validate'), '用新内核校验当前配置');
assert.strictEqual(cc.stepLabel('nope'), 'nope');

/* 按钮状态 */
const base = { ok: true, arch: 'aarch64', asset: 'linux-arm64', installed: true, version: 'v1', prev_version: null,
	latest: null, settings: { repo: 'liuran001/mihomo', tag: 'Prerelease-Alpha', mirror: 'https://ghfast.top/' }, free_kb: 20000, running: true };

let s = cc.updateState({ ok: false, error: '后端异常：x' });
assert.deepStrictEqual([s.ok, s.primary.enabled, s.canCheck, s.canRollback, s.hint, s.hintCls], [false, false, false, false, '后端异常：x', 'mh-err']);
assert.strictEqual(cc.updateState(null).hint, '无法读取内核信息');

s = cc.updateState({ ...base, asset: null, arch: 'mips', installed: false, version: null });
assert.deepStrictEqual([s.primary.enabled, s.canCheck, s.hintCls], [false, false, 'mh-err']);
assert.match(s.hint, /mips/);

s = cc.updateState({ ...base, installed: false, version: null });
assert.deepStrictEqual([s.primary.label, s.primary.enabled, s.primary.force, s.canRollback, s.hintCls], ['下载并安装', true, false, false, 'mh-warn']);
assert.strictEqual(s.hint, '尚未安装内核');

s = cc.updateState(base);
assert.deepStrictEqual([s.primary.label, s.primary.force, s.outdated, s.latest, s.hint], ['更新内核', false, false, null, '尚未检查更新']);

s = cc.updateState({ ...base, latest: { version: 'v2', checked: 1 } });
assert.deepStrictEqual([s.primary.label, s.primary.force, s.outdated, s.latest, s.hintCls], ['更新到 v2', false, true, 'v2', 'mh-warn']);
assert.strictEqual(s.hint, '有新版本 v2');

s = cc.updateState({ ...base, latest: { version: 'v1', checked: 1 }, prev_version: 'v0' });
assert.deepStrictEqual([s.primary.label, s.primary.force, s.outdated, s.canRollback, s.rollbackTo, s.hintCls], ['重新安装', true, false, true, 'v0', 'mh-ok']);
assert.strictEqual(s.hint, '已是最新版本');

/* 任务结果的提示文字 */
assert.strictEqual(cc.resultText({ state: 'done', version: 'v2', note: '已是最新版本' }, 'core'), '已是最新版本（v2）');
assert.strictEqual(cc.resultText({ state: 'done', version: 'v2', note: '内核已安装', restarted: false }, 'core'), '内核已安装：v2');
assert.strictEqual(cc.resultText({ state: 'done', version: 'v2', restarted: true, kept_prev: true }, 'core'), '内核已更新到 v2；服务已按新内核重启');
assert.strictEqual(cc.resultText({ state: 'done', version: 'v2', restarted: false, note: '剩余空间不足，未保留旧版本' }, 'core'),
	'内核已更新到 v2；剩余空间不足，未保留旧版本');
assert.strictEqual(cc.resultText({ state: 'done', version: 'v0', restarted: true }, 'core_rollback'), '已切换到 v0；服务已重启');

/* 卡片按钮：读取内核信息后，有上一版本时「回滚」可见且可点 */
const sync = v => ({ then(f) { return sync(f ? f(v) : v); }, catch() { return this; } });
const fakeE = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: children == null ? [] : [].concat(children),
	replaceChildren(...c) { this.children = c; } });
const fakeMui = {
	btn: (label, fn, cls) => ({ textContent: label, disabled: false, hidden: false, onclick: fn, cls }),
	card: (title, children) => ({ title, children }),
	empty: t => ({ empty: t }), row: (k, v) => ({ k, v }), fmtAgo: () => '', fmtBytes: () => ''
};
const cardOf = info => {
	const m = load('mihomo/corecard.js', { baseclass, ui: {}, E: fakeE, mui: fakeMui, api: { rpc: { coreInfo: () => sync(info) } } });
	const card = m.create();
	card.refresh();
	return card.el.children[1].children;
};
let [ btnCheck, btnBack, btnMain ] = cardOf({ ...base, prev_version: 'v0' });
assert.deepStrictEqual([btnCheck.disabled, btnMain.disabled], [false, false]);
assert.deepStrictEqual([btnBack.hidden, btnBack.disabled, btnBack.textContent], [false, false, '回滚到 v0']);
[ btnCheck, btnBack, btnMain ] = cardOf(base);
assert.deepStrictEqual([btnBack.hidden, btnBack.disabled], [true, true]);
