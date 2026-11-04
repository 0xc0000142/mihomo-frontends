'use strict';

import * as fs from 'fs';
import * as socket from 'socket';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';

/* 规则匹配测试：经 mixed-port 对目标发起一次真实的 HTTP CONNECT，在 /connections 中按源端口找到这条连接，
 * 读出命中的规则与链路后断开。节点拨号失败时连接不会被记录，退而从 logread 的拨号失败日志中查找。 */

const TIMEOUT_MS = 5000;
const PROBE_EXPR = '{"mp": .["mixed-port"], "allow": .["allow-lan"], "bind": .["bind-address"]}';

// ucode 的正则是 POSIX ERE：字面量 ] 写成 []]，字面量括号写成 \(
const DIAL_MATCH_RE = regexp('[]] dial (.+) \\(match ([^/)]+)/([^)]*)\\) .* error: (.*)$');
const DIAL_RE = regexp('[]] dial (.+) [^ ]+:[0-9]+(\\([^)]*\\))? --> .* error: (.*)$');

function now_ms() {
	let c = clock(true);
	return c[0] * 1000 + int(c[1] / 1000000);
}

// host、host:port、IPv4[:port]、[IPv6]:port、裸 IPv6；默认端口 443
function parse_target(s) {
	if (type(s) != 'string')
		return null;
	s = trim(s);
	let host = null, port = '443', m;
	if ((m = match(s, /^\[([0-9A-Fa-f:.]+)\]:([0-9]+)$/))) {
		host = m[1];
		port = m[2];
	} else if (match(s, /^[0-9A-Fa-f:.]+$/) && length(split(s, ':')) > 2)
		host = s;
	else if ((m = match(s, /^([A-Za-z0-9._-]+):([0-9]+)$/))) {
		host = m[1];
		port = m[2];
	} else if (match(s, /^[A-Za-z0-9._-]+$/))
		host = s;
	if (host == null || length(host) > 253 || length(port) > 5)
		return null;
	port = +port;
	if (port < 1 || port > 65535)
		return null;
	return { host: host, port: port };
}

// 在 logread 文本中找源端口为 port 的最后一条拨号失败日志
function parse_dial_log(text, port) {
	let src = regexp(':' + port + '[ (]');
	let found = null;
	for (let line in split(text ?? '', '\n')) {
		if (index(line, '] dial ') < 0 || !match(line, src))
			continue;
		line = replace(line, /"[ \t]*$/, '');
		let m = match(line, DIAL_MATCH_RE);
		if (m) {
			found = { proxy: m[1], rule: m[2], payload: m[3], error: m[4] };
			continue;
		}
		m = match(line, DIAL_RE);
		if (m)
			found = { proxy: m[1], rule: null, payload: null, error: m[3] };
	}
	return found;
}

function config_info() {
	let v = Y.query(P.CONFIG, PROBE_EXPR);
	if (v == null) {
		let text = fs.readfile(P.CONFIG);
		if (text == null)
			return null;
		v = { mp: Y.top_scalar(text, 'mixed-port'), allow: Y.top_scalar(text, 'allow-lan'), bind: Y.top_scalar(text, 'bind-address') };
	}
	return v;
}

// 与 mihomo 的监听规则一致：allow-lan 关闭时只监听 127.0.0.1，否则监听 bind-address（* 表示全部）
function probe_host(v) {
	let b = (v.bind != null) ? '' + v.bind : '*';
	if (v.allow === false || v.allow == 'false' || b == '*' || b == '' || b == '0.0.0.0' || b == '::')
		return '127.0.0.1';
	return b;
}

function read_head(s, deadline) {
	let head = '';
	while (index(head, '\r\n\r\n') < 0 && now_ms() < deadline) {
		let ev = socket.poll(deadline - now_ms(), [s, socket.POLLIN]);
		if (!length(ev) || !ev[0][1])
			break;
		let chunk = s.recv(1024);
		if (chunk == null || chunk == '')
			break;
		head += chunk;
	}
	let m = match(head, /^HTTP\/1\.[01] ([0-9]+)/);
	return m ? +m[1] : 0;
}

function find_conn(ctl, local) {
	let r = U.http('GET', ctl.host, ctl.port, '/connections', ctl.opts);
	let d = null;
	try {
		d = json(r.body ?? '');
	} catch (e) {
		return null;
	}
	for (let c in d?.connections ?? [])
		if (c.metadata?.sourcePort == '' + local.port && c.metadata?.sourceIP == local.address)
			return c;
	return null;
}

// 本次测试的连接仍未出现时，若 mihomo 已关闭这条连接（拨号失败）就提前结束
function peer_closed(s, wait) {
	let ev = socket.poll(wait, [s, socket.POLLIN]);
	if (!length(ev) || !ev[0][1])
		return false;
	let chunk = s.recv(1024);
	return chunk == null || chunk == '';
}

function rule_test(target) {
	let t = parse_target(target);
	if (!t)
		return { ok: false, error: '目标格式不对，应为 host 或 host:port' };
	let v = config_info();
	if (!v)
		return { ok: false, error: '无法读取配置文件' };
	let mp = +(v.mp ?? 0);
	if (!(mp > 0))
		return { ok: false, error: '配置中没有开启 mixed-port，无法进行匹配测试' };
	let c = Y.controller_of(P.CONFIG);
	if (!c?.addr)
		return { ok: false, error: '无法读取控制器地址' };
	let ctl = { host: Y.local_host(c.addr), port: c.addr.port, opts: { secret: c.secret, timeout: 1500 } };

	let start = now_ms(), deadline = start + TIMEOUT_MS;
	let s = socket.connect(probe_host(v), '' + mp, null, 2000);
	if (!s)
		return { ok: false, error: '无法连接 mixed-port：' + socket.error() };
	let local = s.sockname();
	let hp = (index(t.host, ':') >= 0 ? '[' + t.host + ']' : t.host) + ':' + t.port;
	s.send(sprintf('CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n', hp, hp));
	let code = read_head(s, deadline);
	if (code != 200) {
		s.close();
		if (code == 407)
			return { ok: false, error: 'mixed-port 开启了认证，暂不支持匹配测试' };
		return { ok: false, error: code ? 'mixed-port 返回 HTTP ' + code : 'mixed-port 没有响应' };
	}

	let found = null, closed = false;
	while (now_ms() < deadline) {
		found = find_conn(ctl, local);
		if (found)
			break;
		if (peer_closed(s, 150)) {
			closed = true;
			break;
		}
	}
	s.close();
	let res = { ok: true, host: t.host, port: t.port, elapsed_ms: now_ms() - start };

	if (found) {
		if (match(found.id ?? '', /^[0-9A-Za-z-]+$/))
			U.http('DELETE', ctl.host, ctl.port, '/connections/' + found.id, ctl.opts);
		let md = found.metadata ?? {};
		let chains = found.chains ?? [];
		// 经代理时 remoteDestination 是代理服务器的地址，只有直连时才是目标的地址
		let ip = md.destinationIP || ((chains[0] == 'DIRECT') ? md.remoteDestination : null) || null;
		return { ...res, rule: found.rule ?? '', payload: found.rulePayload ?? '', chains: chains, ip: ip, via: 'connections' };
	}

	// 拨号失败的日志由 procd 转给 logd，稍等片刻再读
	sleep(300);
	let lg = parse_dial_log(U.run('logread -e ' + U.shq(P.LOG_TAG) + ' | tail -n 300', { stderr: false }).out, local.port);
	if (lg)
		return { ...res, rule: lg.rule ?? '', payload: lg.payload ?? '', chains: [lg.proxy], ip: null, via: 'log', error: lg.error };
	return { ok: false, error: closed
		? 'mihomo 关闭了测试连接（多为节点拨号失败）；日志中没有对应记录，log-level 需为 warning 或更详细才能看到命中的规则'
		: '5 秒内没有在连接列表中找到测试连接（节点无响应，或目标被 DNS 劫持等内部处理，这类连接不出现在列表中）' };
}

export { parse_target, parse_dial_log, rule_test };
