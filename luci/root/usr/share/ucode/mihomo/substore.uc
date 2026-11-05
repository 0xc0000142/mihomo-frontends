'use strict';

// Sub-Store：使用已有服务（remote），或在路由器上运行（local，按需安装 node 与 Sub-Store）。
// 设置在 UCI mihomo.substore：mode off|local|remote、port、lan、url（remote 的后端地址）、path（local 的后端路径）。

import * as fs from 'fs';
import * as uci from 'uci';
import * as ubus from 'ubus';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';

const MODES = ['off', 'local', 'remote'];
const WHAT = ['all', 'node', 'backend', 'frontend'];
const SERVICE = 'mihomo-substore';
const PATH_RE = /^[A-Za-z0-9]{16,64}$/;
const URL_RE = /^https?:\/\/[^ \t\r\n"'<>]+$/;

function cursor() {
	return uci.cursor(P.UCI_DIR);
}

function conf() {
	let s = cursor().get_all(P.UCI_CONF, 'substore');
	s = type(s) == 'object' ? s : {};
	let port = int(s.port ?? 3001);
	return {
		mode: (s.mode in MODES) ? s.mode : 'off',
		port: (port >= 1024 && port <= 65535) ? port : 3001,
		lan: s.lan == '1',
		url: (type(s.url) == 'string' && match(s.url, URL_RE)) ? s.url : '',
		path: (type(s.path) == 'string' && match(s.path, PATH_RE)) ? s.path : ''
	};
}

function save(values) {
	let c = cursor();
	if (c.get(P.UCI_CONF, 'substore') == null)
		c.set(P.UCI_CONF, 'substore', 'substore');
	for (let k, v in values) {
		if (v == null || v == '')
			c.delete(P.UCI_CONF, 'substore', k);
		else
			c.set(P.UCI_CONF, 'substore', k, '' + v);
	}
	return c.commit(P.UCI_CONF);
}

// 后端路径：只有知道它的人才能访问接口（合并模式下前端在根路径，接口在 /路径 下）
function ensure_path(c) {
	if (c.path != '')
		return c.path;
	let p = '';
	for (let ch in split(U.rand_hex(32), ''))
		p += (length(p) % 3 == 0) ? uc(ch) : ch;
	p = substr(replace(p, /[^A-Za-z0-9]/g, ''), 0, 24);
	save({ path: p });
	c.path = p;
	return p;
}

function svc(action) {
	if (!fs.access(P.SUBSTORE_INIT, 'x'))
		return { code: 1, out: '缺少 ' + P.SUBSTORE_INIT };
	return U.run(U.shq(P.SUBSTORE_INIT) + ' ' + action);
}

function instance() {
	let c = ubus.connect();
	if (!c)
		return null;
	let r = c.call('service', 'list', { name: SERVICE });
	c.disconnect();
	for (let k, inst in (r?.[SERVICE]?.instances ?? {}))
		return inst;
	return null;
}

function read_trim(path) {
	let t = fs.readfile(path);
	return t == null ? null : trim(t);
}

function node_version() {
	if (!fs.access(P.NODE, 'x'))
		return null;
	let r = U.run(U.shq(P.NODE) + ' -v', { stderr: false });
	return r.code == 0 ? trim(r.out) : null;
}

function pid_alive(pid) {
	return pid > 0 && fs.stat('/proc/' + pid) != null;
}

// 后台安装的进度：installing 为 true 时前端每隔几秒刷新一次
function install_state() {
	let pid = int(read_trim(P.RUN_DIR + '/substore-install.pid') ?? 0);
	let result = read_trim(P.RUN_DIR + '/substore-install.result');
	let log = fs.readfile(P.RUN_DIR + '/substore-install.log');
	return {
		installing: pid_alive(pid),
		result: result,
		log: log == null ? null : U.tail_lines(log, 30)
	};
}

function arch() {
	return trim(U.run('uname -m', { stderr: false }).out);
}

function free_kb(path) {
	let r = U.run('df -k ' + U.shq(path) + " | awk 'NR==2 {print $4}'", { stderr: false });
	let n = int(trim(r.out));
	return n > 0 ? n : null;
}

function status() {
	let c = conf();
	if (c.mode == 'local')
		ensure_path(c);
	let inst = instance();
	let dir = P.SUBSTORE_DIR;
	return {
		ok: true,
		mode: c.mode, port: c.port, lan: c.lan, url: c.url, path: c.path,
		arch: arch(),
		free_kb: free_kb(fs.stat(dir) ? dir : P.HOME),
		running: !!inst?.running,
		installed: {
			node: node_version() != null,
			backend: (fs.stat(dir + '/sub-store.bundle.js')?.size ?? 0) > 0,
			frontend: fs.stat(dir + '/frontend/index.html') != null
		},
		versions: {
			node: node_version(),
			backend: read_trim(dir + '/backend.version'),
			frontend: read_trim(dir + '/frontend.version')
		},
		install: install_state()
	};
}

function ready() {
	return node_version() != null && (fs.stat(P.SUBSTORE_DIR + '/sub-store.bundle.js')?.size ?? 0) > 0;
}

// 启用并（重新）启动；等接口能访问再返回，最多约 15 秒
function start(c) {
	if (!ready())
		return { ok: false, error: '还没有下载 node 或 Sub-Store' };
	svc('enable');
	let r = svc('restart');
	if (r.code != 0)
		return { ok: false, error: '启动失败', detail: U.tail_lines(r.out, 10) };
	for (let i = 0; i < 30; i++) {
		let h = U.http('GET', '127.0.0.1', c.port, '/' + c.path + '/api/utils/env', { timeout: 500 });
		if (h.status == 200)
			return { ok: true };
		system('sleep 0.5');
	}
	return { ok: false, error: 'Sub-Store 未能在 15 秒内启动，请查看系统日志' };
}

function stop() {
	svc('stop');
	svc('disable');
}

function set(a) {
	let mode = a?.mode, port = int(a?.port ?? 0), url = trim('' + (a?.url ?? ''));
	if (!(mode in MODES))
		return { ok: false, error: '模式无效' };
	if (!(port >= 1024 && port <= 65535))
		return { ok: false, error: '端口须为 1024–65535' };
	url = replace(url, /\/+$/, '');
	if (url != '' && !match(url, URL_RE))
		return { ok: false, error: '地址必须以 http:// 或 https:// 开头，且不能含空白或引号' };
	if (mode == 'remote' && url == '')
		return { ok: false, error: '请填写 Sub-Store 后端地址' };
	if (!save({ mode: mode, port: port, lan: a?.lan ? '1' : '0', url: url }))
		return { ok: false, error: '保存设置失败' };
	let c = conf();
	if (mode == 'local') {
		ensure_path(c);
		if (ready()) {
			let r = start(c);
			if (!r.ok)
				return r;
		}
	} else
		stop();
	return status();
}

function install(what) {
	what ??= 'all';
	if (!(what in WHAT))
		return { ok: false, error: '参数无效' };
	if (install_state().installing)
		return { ok: false, error: '正在安装，请稍候' };
	if (!fs.access(P.SUBSTORE_INSTALLER, 'x'))
		return { ok: false, error: '缺少 ' + P.SUBSTORE_INSTALLER };
	U.mkdir_p(P.RUN_DIR);
	// 脱离 rpcd：下载与安装 node 可能要几分钟，前端轮询 status 看进度
	system(sprintf('(setsid %s %s </dev/null >/dev/null 2>&1 &)', U.shq(P.SUBSTORE_INSTALLER), what));
	for (let i = 0; i < 10 && !install_state().installing && install_state().result == null; i++)
		system('sleep 0.1');
	return status();
}

function service(action) {
	let c = conf();
	switch (action) {
	case 'start':
	case 'restart':
		if (c.mode != 'local')
			return { ok: false, error: '当前不是「在本机运行」模式' };
		ensure_path(c);
		let r = start(c);
		return r.ok ? status() : r;
	case 'stop':
		svc('stop');
		return status();
	case 'reset-path':
		save({ path: '' });
		c.path = '';
		ensure_path(c);
		if (c.mode == 'local' && instance()?.running)
			start(c);
		return status();
	case 'uninstall':
		stop();
		save({ mode: 'off' });
		let d = P.SUBSTORE_DIR;
		for (let f in ['sub-store.bundle.js', 'backend.version', 'frontend.version'])
			fs.unlink(d + '/' + f);
		U.rm_tree(d + '/frontend');
		return status();
	}
	return { ok: false, error: '不支持的操作：' + action };
}

// 当前模式下的后端地址：mihomo 与 Sub-Store 在同一台路由器上，本机模式用 127.0.0.1
function api_base(c) {
	if (c.mode == 'local')
		return c.path != '' ? sprintf('http://127.0.0.1:%d/%s', c.port, c.path) : null;
	if (c.mode == 'remote')
		return c.url != '' ? c.url : null;
	return null;
}

function fetch_json(url) {
	let r = U.run(sprintf('%s -fsS -m 15 %s', U.shq(P.CURL), U.shq(url)));
	if (r.code != 0)
		return { error: trim(r.out) || ('curl 退出码 ' + r.code) };
	try {
		return { data: json(r.out) };
	} catch (e) {
		return { error: '返回的不是 JSON' };
	}
}

// 订阅名按 UTF-8 字节百分号编码
function enc(name) {
	return replace(name, /[^A-Za-z0-9_.~-]/g, (ch) => {
		let h = '';
		for (let b in split(ch, ''))
			h += sprintf('%%%02X', ord(b));
		return h;
	});
}

// /api/subs 与 /api/collections 的结果 → 带下载链接（target=ClashMeta）的列表
function entries(base, subs, cols) {
	let out = [];
	let add = (kind, arr) => {
		for (let e in (type(arr) == 'array' ? arr : [])) {
			if (type(e?.name) != 'string' || e.name == '')
				continue;
			push(out, {
				kind: kind, name: e.name, title: (type(e.displayName) == 'string' && e.displayName != '') ? e.displayName : e.name,
				url: base + '/download/' + (kind == 'collection' ? 'collection/' : '') + enc(e.name) + '?target=ClashMeta'
			});
		}
	};
	add('sub', type(subs) == 'object' ? subs.data : subs);
	add('collection', type(cols) == 'object' ? cols.data : cols);
	return out;
}

// Sub-Store 里的订阅与组合订阅
function list() {
	let c = conf();
	let base = api_base(c);
	if (base == null)
		return { ok: false, error: '没有启用 Sub-Store' };
	let subs = fetch_json(base + '/api/subs');
	if (subs.error)
		return { ok: false, error: '读取订阅失败：' + subs.error };
	let cols = fetch_json(base + '/api/collections');
	return { ok: true, list: entries(base, subs.data, cols.data) };
}

export { conf, status, set, install, service, list, api_base, entries };
