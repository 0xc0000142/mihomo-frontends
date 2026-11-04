'use strict';

// 本机测试桩：UCI 数据存放在 confdir（默认 /tmp/mlt/uci）下的 stub.json，结构为 { 配置: { 节名: { '.type': 类型, 选项: 值 } } }。
// 只实现插件用到的 get / get_all / set / delete / foreach / commit；set、delete 写入内存，commit 时落盘。
import * as fs from 'fs';

function store(confdir) {
	return (confdir ?? '/tmp/mlt/uci') + '/stub.json';
}

function load(path) {
	let s = fs.readfile(path);
	try {
		return s ? json(s) : {};
	} catch (e) {
		return {};
	}
}

function cursor(confdir) {
	let path = store(confdir);
	let data = load(path);
	return {
		get: function(conf, sec, opt) {
			let s = (data[conf] ?? {})[sec];
			if (s == null)
				return null;
			return (opt == null) ? s['.type'] : s[opt];
		},
		get_all: function(conf, sec) {
			return (sec == null) ? data[conf] : (data[conf] ?? {})[sec];
		},
		set: function(conf, sec, opt, val) {
			data[conf] ??= {};
			if (val == null) {
				// set(conf, sec, type)：创建命名节
				data[conf][sec] ??= {};
				data[conf][sec]['.type'] = opt;
				return true;
			}
			if (data[conf][sec] == null)
				return false;
			data[conf][sec][opt] = val;
			return true;
		},
		delete: function(conf, sec, opt) {
			let c = data[conf] ?? {};
			if (opt == null)
				delete c[sec];
			else if (c[sec])
				delete c[sec][opt];
			return true;
		},
		foreach: function(conf, t, cb) {
			for (let name, s in (data[conf] ?? {}))
				if (t == null || s['.type'] == t)
					cb({ ...s, '.name': name });
			return true;
		},
		commit: function(conf) {
			return fs.writefile(path, sprintf('%J', data)) != null;
		},
		unload: function() {
			return true;
		}
	};
}

export { cursor };
