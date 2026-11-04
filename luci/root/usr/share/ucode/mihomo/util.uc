'use strict';

import * as fs from 'fs';
import * as socket from 'socket';

// 单引号包裹，只用于命令行里的内部路径与常量；用户数据不进入命令行。
function shq(s) {
	return "'" + replace('' + s, "'", "'\\''") + "'";
}

// 运行固定命令，默认合并 stdout 与 stderr；opts.stderr 为 false 时丢弃 stderr（输出要当数据解析时用）。
function run(cmd, opts) {
	let p = fs.popen(cmd + ((opts?.stderr === false) ? ' 2>/dev/null' : ' 2>&1'), 'r');
	if (!p)
		return { code: -1, out: '' + fs.error() };
	let out = p.read('all') ?? '';
	let code = p.close();
	return { code: code, out: out };
}

function rand_hex(bytes) {
	return hexenc(fs.readfile('/dev/urandom', bytes));
}

function mkdir_p(dir) {
	let cur = '';
	for (let part in split(dir, '/')) {
		if (part == '')
			continue;
		cur += '/' + part;
		if (!fs.stat(cur))
			fs.mkdir(cur, 0o700);
	}
	return fs.stat(dir)?.type == 'directory';
}

// 先写同目录临时文件再改名，权限默认 600。
function write_file(path, data, mode) {
	mode ??= 0o600;
	let tmp = path + '.tmp-' + rand_hex(4);
	let f = fs.open(tmp, 'w', mode);
	if (!f)
		return false;
	let written = f.write(data ?? '');
	f.close();
	if (written == null || !fs.chmod(tmp, mode) || !fs.rename(tmp, path)) {
		fs.unlink(tmp);
		return false;
	}
	return true;
}

// 递归删除目录（不跟随符号链接）；只用于内部固定路径
function rm_tree(path) {
	let st = fs.lstat(path);
	if (!st)
		return true;
	if (st.type == 'directory') {
		for (let n in (fs.lsdir(path) ?? []))
			rm_tree(path + '/' + n);
		return fs.rmdir(path);
	}
	return fs.unlink(path);
}

function read_json(path) {
	let s = fs.readfile(path);
	if (s == null)
		return null;
	try {
		return json(s);
	} catch (e) {
		return null;
	}
}

function write_json(path, obj) {
	return write_file(path, sprintf('%J', obj));
}

function tail_lines(text, n) {
	let lines = split(rtrim(text ?? '', '\n'), '\n');
	if (length(lines) > n)
		lines = slice(lines, -n);
	return join('\n', lines);
}

// 配置文件版本号：每次保存都是改名替换，inode 必变；手工就地编辑则 mtime/size 改变。
function file_rev(path) {
	let st = fs.stat(path);
	return st ? sprintf('%d-%d-%d', st.mtime, st.inode, st.size) : '';
}

// 极简 HTTP/1.0 客户端，只用于访问本机的 mihomo 控制器。
function http(method, host, port, path, opts) {
	opts ??= {};
	let timeout = opts.timeout ?? 3000;
	if (opts.secret && match(opts.secret, /[\r\n]/))
		return { status: 0, error: 'secret 含换行' };
	let s = socket.connect(host, '' + port, null, timeout);
	if (!s)
		return { status: 0, error: '' + socket.error() };
	let req = sprintf('%s %s HTTP/1.0\r\nHost: %s\r\n', method, path, host);
	if (opts.secret)
		req += 'Authorization: Bearer ' + opts.secret + '\r\n';
	if (opts.body != null)
		req += 'Content-Type: application/json\r\nContent-Length: ' + length(opts.body) + '\r\n';
	req += '\r\n' + (opts.body ?? '');
	s.send(req);
	let data = '';
	let deadline = time() + int(timeout / 1000) + 1;
	while (time() <= deadline) {
		let ev = socket.poll(timeout, [s, socket.POLLIN]);
		if (!length(ev) || !ev[0][1])
			break;
		let chunk = s.recv(8192);
		if (chunk == null || chunk == '')
			break;
		data += chunk;
	}
	s.close();
	let m = match(data, /^HTTP\/1\.[01] ([0-9]+)/);
	let i = index(data, '\r\n\r\n');
	return { status: m ? +m[1] : 0, body: i >= 0 ? substr(data, i + 4) : '' };
}

export { shq, run, rand_hex, mkdir_p, write_file, rm_tree, read_json, write_json, tail_lines, file_rev, http };
