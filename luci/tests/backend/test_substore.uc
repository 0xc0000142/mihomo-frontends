'use strict';

import * as fs from 'fs';
import * as SS from 'mihomo.substore';
import * as P from 'mihomo.paths';
import { ok, eq, done } from 'lib';

// main.sh 把程序目录、node、服务脚本与安装脚本都指向不存在的测试路径：不会真的安装或启动
let s = SS.status();
eq([s.ok, s.mode, s.port, s.lan, s.running], [true, 'off', 3001, false, false], '默认关闭');
eq(s.installed, { node: false, backend: false, frontend: false }, '默认未安装');
eq(s.install.installing, false, '没有在安装');

ok(SS.set({ mode: 'x', port: 3001 }).error, '拒绝未知模式');
ok(SS.set({ mode: 'local', port: 80 }).error, '拒绝 1024 以下端口');
ok(SS.set({ mode: 'remote', port: 3001, url: '' }).error, '使用已有服务时需要地址');
ok(SS.set({ mode: 'remote', port: 3001, url: 'ftp://x' }).error, '地址必须是 http(s)');
ok(SS.set({ mode: 'remote', port: 3001, url: 'https://a b' }).error, '地址不能含空格');

s = SS.set({ mode: 'remote', port: 3001, lan: false, url: 'https://sub.example.com/backend/' });
eq([s.ok, s.mode, s.url], [true, 'remote', 'https://sub.example.com/backend'], '保存已有服务地址，去掉结尾 /');
eq(SS.api_base(SS.conf()), 'https://sub.example.com/backend', '已有服务的后端地址');

s = SS.set({ mode: 'local', port: 3456, lan: true, url: '' });
eq([s.ok, s.mode, s.port, s.lan, s.url], [true, 'local', 3456, true, ''], '本机模式：未安装时只保存设置');
ok(match(s.path, /^[A-Za-z0-9]{24}$/), '生成 24 位后端路径', s.path);
eq(SS.api_base(SS.conf()), 'http://127.0.0.1:3456/' + s.path, '本机的后端地址');
let old = s.path;
eq(SS.status().path, old, '路径保持不变');
s = SS.service('reset-path');
ok(s.ok && s.path != old && length(s.path) == 24, '重新生成路径');

ok(SS.service('start').error, '未安装时不能启动');
ok(SS.service('bogus').error, '拒绝未知操作');
ok(SS.install('bogus').error, '拒绝未知安装项');
ok(index(SS.install('all').error ?? '', '缺少') == 0, '缺少安装脚本时报错');

// 列表：关闭时报错；已有服务不可达时返回 curl 的错误
s = SS.service('uninstall');
eq([s.ok, s.mode], [true, 'off'], '删除程序后关闭');
ok(SS.list().error, '关闭时不能列出订阅');
SS.set({ mode: 'remote', port: 3001, url: 'http://127.0.0.1:1' });
let l = SS.list();
ok(!l.ok && index(l.error, '读取订阅失败') == 0, '服务不可达时报错', l);

// 订阅名中的空格与中文按 UTF-8 百分号编码；空名称忽略
eq(SS.entries('http://h/p', { status: 'success', data: [{ name: '机场 A', displayName: '我的机场' }, { name: '' }] }, { data: [{ name: 'all' }] }), [
	{ kind: 'sub', name: '机场 A', title: '我的机场', url: 'http://h/p/download/%E6%9C%BA%E5%9C%BA%20A?target=ClashMeta' },
	{ kind: 'collection', name: 'all', title: 'all', url: 'http://h/p/download/collection/all?target=ClashMeta' }
], '订阅与组合订阅的下载链接');
eq(SS.entries('http://h', null, null), [], '读取失败时为空');

done();
