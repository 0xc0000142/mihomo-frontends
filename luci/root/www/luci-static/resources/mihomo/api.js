'use strict';
'require baseclass';
'require rpc';

/* 两条数据通道：
 * - rpc：LuCI 会话 → rpcd 对象 luci.mihomo（读写配置、校验、服务启停等需要 root 的操作）
 * - 控制器：浏览器直连 mihomo REST/WebSocket（实时数据与运行时操作），方式与 zashboard 相同 */

const OBJECT = 'luci.mihomo';

function declare(method, params) {
	return rpc.declare({ object: OBJECT, method: method, params: params || [] });
}

const SETUP_APPLY = ['source', 'subs', 'lan', 'secret', 'content', 'url', 'ua', 'adapt', 'start', 'rev'];
const SETUP_RENDER = ['subs', 'lan', 'secret'];
const CORE_SETTINGS = ['repo', 'tag', 'mirror'];

const rpcs = {
	status: declare('status'),
	controller: declare('controller'),
	configRead: declare('config_read'),
	backups: declare('backups'),
	backupRead: declare('backup_read', ['name']),
	logs: declare('logs', ['lines']),
	devices: declare('devices'),
	sections: declare('sections', ['names']),
	interfaces: declare('interfaces'),
	tailscale: declare('tailscale'),
	applyStatus: declare('apply_status', ['job']),
	validate: declare('validate', ['content']),
	saveRaw: declare('save_raw', ['content', 'rev']),
	patch: declare('patch', ['ops', 'rev']),
	providerToggle: declare('provider_toggle', ['name', 'enabled', 'rev']),
	migrateIncludeAll: declare('migrate_include_all', ['rev']),
	backupRestore: declare('backup_restore', ['name']),
	backupDelete: declare('backup_delete', ['name']),
	service: declare('service', ['action']),
	ruleTest: declare('rule_test', ['target']),
	coreInfo: declare('core_info'),
	coreCheck: declare('core_check'),
	coreUpdate: declare('core_update', ['force']),
	coreRollback: declare('core_rollback'),
	coreSettings: declare('core_settings', CORE_SETTINGS),
	setupStatus: declare('setup_status'),
	setupRender: declare('setup_render', SETUP_RENDER),
	setupApply: declare('setup_apply', SETUP_APPLY)
};

// 参数较多的方法按对象传参：按声明顺序展开，缺省的键为 undefined，序列化时省略，由插件取默认值
function named(method, params) {
	return a => rpcs[method].apply(null, params.map(k => (a || {})[k]));
}
const setupApply = named('setupApply', SETUP_APPLY);
const setupRender = named('setupRender', SETUP_RENDER);
const coreSettings = named('coreSettings', CORE_SETTINGS);

const HTTPS_REASON = '当前以 https 打开 LuCI，浏览器会拦截到控制器的 http 连接；实时功能请改用 http 访问 LuCI，或为控制器配置 TLS';

function baseUrl(c, protocol, hostname) {
	let host = c.host || hostname;
	if (host.indexOf(':') >= 0 && host[0] !== '[') host = '[' + host + ']';
	return 'http://' + host + ':' + c.port;
}

// zashboard 的地址，带上自动连接后端的参数（secret 在 # 之后，不会发给服务器）。
// LuCI 以 https 打开时实时功能不可用，但面板本身走 http，仍然给出链接。
function dashboardUrl(c, hostname) {
	if (!c || !c.ok) return { url: null, reason: (c && c.error) || '无法读取控制器设置' };
	if (!c.ui) return { url: null, reason: '配置中没有面板目录（external-ui），可在 设置 → 基础 → 控制器与面板 填写，例如 ./dashboard' };
	if (!c.reachable) return { url: null, reason: c.reason };
	const host = c.host || hostname.replace(/^\[(.*)\]$/, '$1');
	const path = '/ui/' + (c.ui_name ? encodeURIComponent(c.ui_name) + '/' : '');
	let q = 'hostname=' + encodeURIComponent(host) + '&port=' + c.port;
	if (c.secret) q += '&secret=' + encodeURIComponent(c.secret);
	return { url: baseUrl(c, 'http:', hostname) + path + '#/setup?' + q, reason: null };
}

function withToken(path, secret) {
	if (!secret) return path;
	return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(secret);
}

let ctl = null;          // Promise<{ base, secret, reason }>
let current = { base: null, secret: '', reason: null };
let online = null;
const stateListeners = [];

function setOnline(v) {
	if (online === v) return;
	online = v;
	stateListeners.forEach(f => f(v));
}

function onState(f) {
	stateListeners.push(f);
	if (online !== null) f(online);
}

function controller(force) {
	if (ctl && !force) return ctl;
	ctl = rpcs.controller().then(c => {
		let reason = null, base = null;
		if (!c || !c.ok) reason = (c && c.error) || '无法读取控制器设置';
		else if (!c.reachable) reason = c.reason;
		else if (location.protocol === 'https:') reason = HTTPS_REASON;
		else base = baseUrl(c, location.protocol, location.hostname);
		current = { base: base, secret: (c && c.secret) || '', reason: reason, raw: c };
		return current;
	}, e => {
		// rpc 失败不缓存，下次调用时重试
		ctl = null;
		current = { base: null, secret: '', reason: '无法读取控制器设置：' + e.message };
		return current;
	});
	return ctl;
}

function request(method, path, body, opts) {
	opts = opts || {};
	return controller().then(c => {
		if (!c.base) throw new Error(c.reason);
		const init = { method: method, headers: {} };
		if (c.secret) init.headers.Authorization = 'Bearer ' + c.secret;
		if (body !== undefined) {
			init.headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), opts.timeout || 10000);
		init.signal = abort.signal;
		return fetch(c.base + path, init).then(r => {
			clearTimeout(timer);
			setOnline(true);
			if (r.status === 204) return null;
			return r.text().then(txt => {
				let data = txt;
				try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* 非 JSON 响应原样返回 */ }
				if (!r.ok) {
					const err = new Error((data && data.message) || ('HTTP ' + r.status));
					err.status = r.status;
					throw err;
				}
				return data;
			});
		}, e => {
			clearTimeout(timer);
			if (e.name === 'AbortError') throw new Error('请求超时');
			setOnline(false);
			throw new Error('无法连接 mihomo 控制器');
		});
	});
}

// WebSocket 流：断开后每 3 秒重连。返回 { close() }。
function stream(path, onMessage) {
	let ws = null, closed = false, timer = null;
	const retry = () => { if (!closed) timer = setTimeout(open, 3000); };
	function open() {
		controller().then(c => {
			if (closed) return;
			if (!c.base) return retry();
			ws = new WebSocket(c.base.replace(/^http/, 'ws') + withToken(path, c.secret));
			ws.onopen = () => setOnline(true);
			ws.onmessage = ev => {
				let d;
				try { d = JSON.parse(ev.data); } catch (e) { return; }
				onMessage(d);
			};
			ws.onclose = () => {
				ws = null;
				if (closed) return;
				setOnline(false);
				retry();
			};
		});
	}
	open();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			if (ws) ws.close();
		}
	};
}

return baseclass.extend({
	rpc: rpcs,
	baseUrl, withToken, dashboardUrl, controller, request, stream, onState,
	setupApply, setupRender, coreSettings,
	// 面板链接 { url, reason }
	dashboard: () => controller().then(c => dashboardUrl(c.raw, location.hostname)),
	reason: () => current.reason,
	isOnline: () => online,
	get: (p, opts) => request('GET', p, undefined, opts),
	put: (p, b) => request('PUT', p, b),
	post: (p, b) => request('POST', p, b),
	patch: (p, b) => request('PATCH', p, b),
	del: p => request('DELETE', p)
});
