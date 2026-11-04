'use strict';
// 在 Node 中加载 LuCI 资源文件：LuCI 把 'require x as y' 声明的模块作为函数参数注入，这里手工注入假的依赖
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../root/www/luci-static/resources');

function source(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function load(rel, deps) {
	deps = deps || {};
	const names = Object.keys(deps);
	const fn = new Function(...names, source(rel));
	return fn(...names.map(n => deps[n]));
}

const baseclass = { extend: o => o };

module.exports = { ROOT, source, load, baseclass };
