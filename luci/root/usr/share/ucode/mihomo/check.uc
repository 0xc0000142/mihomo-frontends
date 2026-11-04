'use strict';

// 表单输入的校验与规整：全部是纯函数，成功返回规整后的值，失败返回 null。

function int(v, min, max) {
	if (type(v) == 'string') {
		v = trim(v);
		if (!match(v, /^-?[0-9]+$/))
			return null;
		v = +v;
	}
	if (type(v) != 'int')
		return null;
	return (v < min || v > max) ? null : v;
}

function port(v) {
	return int(v, 1, 65535);
}

function port0(v) {
	return int(v, 0, 65535);
}

function bool(v) {
	if (v === true || v === '1' || v === 'true')
		return true;
	if (v === false || v === '0' || v === 'false')
		return false;
	return null;
}

function oneof(v, list) {
	return (type(v) == 'string' && index(list, v) >= 0) ? v : null;
}

// ucode 的正则是 POSIX 语法，方括号里不能用反斜杠转义，所以控制字符与空白逐字节检查
const URL_RE = regexp('^https?://[^/?#]+');
const HOSTPORT_RE = regexp('^([^]:[]*):([0-9]+)$');

function has_ctrl(v) {
	for (let i = 0; i < length(v); i++) {
		let c = ord(v, i);
		if (c < 32 || c == 127)
			return true;
	}
	return false;
}

function text(v, max) {
	if (type(v) != 'string')
		return null;
	v = trim(v);
	return (length(v) > max || has_ctrl(v)) ? null : v;
}

function url(v) {
	v = text(v, 2048);
	if (v == null || index(v, ' ') >= 0 || !match(v, URL_RE))
		return null;
	return v;
}

// 地址交给 iptoarr 解析，返回规范写法（IPv6 小写并压缩）
function ip(v) {
	if (type(v) != 'string' || index(v, '/') >= 0)
		return null;
	let a = iptoarr(trim(v));
	return a ? arrtoip(a) : null;
}

function cidr(v) {
	if (type(v) != 'string')
		return null;
	let m = match(trim(v), /^([^\/]+)(\/([0-9]{1,3}))?$/);
	if (!m)
		return null;
	let a = iptoarr(m[1]);
	if (!a)
		return null;
	let max = length(a) * 8;
	let bits = (m[3] != null) ? +m[3] : max;
	if (bits > max)
		return null;
	return arrtoip(a) + '/' + bits;
}

function mac(v) {
	if (type(v) != 'string')
		return null;
	v = lc(replace(trim(v), /-/g, ':'));
	return match(v, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/) ? v : null;
}

function ifname(v) {
	return (type(v) == 'string' && match(v, /^[A-Za-z0-9._@-]{1,15}$/)) ? v : null;
}

// mihomo 的监听地址：host:port、:port、[IPv6]:port
function listen(v) {
	if (type(v) != 'string')
		return null;
	v = trim(v);
	let m = match(v, /^\[([0-9a-fA-F:.]+)\]:([0-9]+)$/) ?? match(v, HOSTPORT_RE);
	if (!m || port(m[2]) == null)
		return null;
	if (m[1] != '' && m[1] != 'localhost' && !iptoarr(m[1]))
		return null;
	return v;
}

// 订阅、规则集等的名称：会出现在规则（逗号分隔）、文件名与 URL 路径里
function name(v) {
	if (type(v) != 'string' || v == '' || v != trim(v) || length(v) > 64)
		return null;
	if (has_ctrl(v) || index(v, '/') >= 0 || index(v, ',') >= 0 || index(v, '\\') >= 0 || substr(v, 0, 1) == '.')
		return null;
	return v;
}

function list(v, fn, max) {
	if (type(v) != 'array' || length(v) > max)
		return null;
	let out = [], seen = {};
	for (let x in v) {
		let y = fn(x);
		if (y == null)
			return null;
		let k = sprintf('%J', y);
		if (seen[k])
			continue;
		seen[k] = true;
		push(out, y);
	}
	return out;
}

export { int, port, port0, bool, oneof, text, url, ip, cidr, mac, ifname, listen, name, list };
