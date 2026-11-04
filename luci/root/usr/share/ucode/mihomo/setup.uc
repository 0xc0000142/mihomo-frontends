'use strict';

// 首次设置：内置模板渲染、「补全路由器所需设置」（adapt）、setup 任务的准备与后台前置步骤。
// 任务的校验、备份、替换、启动沿用 apply.uc 的配置流程。
import * as fs from 'fs';
import * as uci from 'uci';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as Y from 'mihomo.yaml';
import * as C from 'mihomo.check';
import * as F from 'mihomo.forms';
import * as S from 'mihomo.service';
import * as CORE from 'mihomo.core';

const UI_URL = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
const FIP_URL = 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs';
const DEFAULT_UA = 'clash.meta';
const DNS_LISTEN = '0.0.0.0:1053';
const DNS_UPSTREAM = ['223.5.5.5', '119.29.29.29'];
const SOURCES = ['template', 'import', 'url'];
const MAX_SUBS = 32;
const MAX_LAN = 8;

function fail(msg) {
	return { ok: false, error: msg };
}

function obj(v) {
	return (type(v) == 'object') ? v : {};
}

function empty(v) {
	return v == null || v === '';
}

// 占位符的值写成 JSON：JSON 字符串、数组就是合法的 YAML 双引号标量与流式序列
function J(v) {
	return sprintf('%J', v);
}

/* ---------- 参数校验 ---------- */

function check_subs(subs) {
	if (type(subs) != 'array' || !length(subs))
		return fail('至少需要一个订阅');
	if (length(subs) > MAX_SUBS)
		return fail('订阅过多（最多 ' + MAX_SUBS + ' 个）');
	let out = [], seen = {};
	for (let i = 0; i < length(subs); i++) {
		let s = obj(subs[i]);
		let name = C.name(s.name);
		if (name == null)
			return fail(sprintf('第 %d 个订阅的名称无效：%s（不能为空，不能包含 / , \\，不能以 . 开头，最长 64 个字符）',
				i + 1, '' + (s.name ?? '')));
		if (seen[name])
			return fail('订阅名称重复：' + name);
		seen[name] = true;
		if (C.url(s.url) == null)
			return fail('订阅「' + name + '」的地址无效（需要 http:// 或 https:// 开头）');
		let ua = null;
		if (!empty(s.ua)) {
			ua = C.text(s.ua, 256);
			if (!ua)
				return fail('订阅「' + name + '」的 User-Agent 无效');
		}
		push(out, { name: name, url: C.url(s.url), ua: ua });
	}
	return { ok: true, list: out };
}

function check_lan(lan) {
	let l = C.list(lan, C.ifname, MAX_LAN);
	if (l == null)
		return fail('下联接口名无效');
	if (!length(l))
		return fail('请至少选择一个下联接口');
	return { ok: true, list: l };
}

// 未填写时随机生成
function check_secret(s) {
	if (empty(s))
		return { ok: true, value: U.rand_hex(16) };
	let v = C.text(s, 128);
	if (!v || index(v, ' ') >= 0)
		return fail('面板密钥不能含空格或控制字符，最长 128 个字符');
	return { ok: true, value: v };
}

// args.mirror 给出时校验并补全末尾斜杠，否则取内核下载设置里的镜像前缀
function mirror_of(args) {
	if (args.mirror == null)
		return { ok: true, value: CORE.settings().mirror };
	let m = CORE.norm_mirror(args.mirror);
	return (m == null) ? fail('镜像前缀应以 http:// 或 https:// 开头，且不含空格') : { ok: true, value: m };
}

/* ---------- 模板渲染 ---------- */

// args：subs[{ name, url, ua }]、lan[]、secret（可空）、mirror（可省略）。返回 { ok, content } 或 { ok:false, error }
function render(args) {
	args = obj(args);
	let subs = check_subs(args.subs);
	if (!subs.ok)
		return subs;
	let lan = check_lan(args.lan);
	if (!lan.ok)
		return lan;
	let secret = check_secret(args.secret);
	if (!secret.ok)
		return secret;
	let mirror = mirror_of(args);
	if (!mirror.ok)
		return mirror;
	let text = fs.readfile(P.TEMPLATE);
	if (text == null)
		return fail('缺少内置模板：' + P.TEMPLATE);
	let m = mirror.value;

	// 每个占位符生成若干行，缩进相对占位符所在列
	let blocks = {
		providers: () => {
			let lines = [];
			for (let s in subs.list) {
				push(lines, J(s.name) + ':', '  <<: *p', '  path: ' + J('./proxy_provider/' + s.name + '.yaml'),
					'  url: ' + J(s.url), '  override:', '    additional-prefix: ' + J('[' + s.name + ']'));
				if (s.ua)
					push(lines, '  header:', '    User-Agent: [' + J(s.ua) + ']');
			}
			return lines;
		},
		use: () => map(subs.list, (s) => '- ' + J(s.name)),
		secret: () => ['secret: ' + J(secret.value)],
		'ui-url': () => ['external-ui-url: ' + J(m + UI_URL)],
		// 走镜像时直连即可；直连 GitHub 不稳定，没有镜像时走代理
		'fake-ip-filter-url': () => ['url: ' + J(m + FIP_URL), 'proxy: ' + J(m ? 'DIRECT' : '节点选择')],
		lan: () => ['interface: ' + J(lan.list)]
	};
	let out = [], used = {};
	for (let line in split(text, '\n')) {
		let ph = match(line, /^( *)#@([a-z-]+)[ \t]*$/);
		if (!ph) {
			push(out, line);
			continue;
		}
		if (!blocks[ph[2]])
			return fail('模板中有未知的占位符：' + ph[2]);
		used[ph[2]] = true;
		for (let l in blocks[ph[2]]())
			push(out, ph[1] + l);
	}
	for (let k in keys(blocks))
		if (!used[k])
			return fail('模板缺少占位符：' + k);
	return { ok: true, content: join('\n', out) };
}

/* ---------- 补全 ---------- */

function has_type(list, t) {
	return type(list) == 'array' && length(filter(list, (e) => obj(e).type == t)) > 0;
}

// 在 file 上补齐路由器运行所需的设置，每项只在缺少时添加。args：lan[]、secret（可空）、mirror（可省略）。
// 返回 { ok, adapted: [中文说明…] }；不需要补全时不改动文件
function adapt(file, args) {
	args = obj(args);
	let ctx = F.context(file);
	if (!ctx)
		return fail('配置文件有语法错误，无法补全');
	let x = ctx.x;
	let mirror = mirror_of(args);
	if (!mirror.ok)
		return mirror;
	let adapted = [], ops = [], edits = [];

	// 1. eBPF 透明代理入站
	if (!has_type(x.listeners, 'ebpf')) {
		let lan = check_lan(args.lan);
		if (!lan.ok)
			return fail('需要添加 eBPF 入站，但' + lan.error);
		push(ops, { op: 'ebpf.create', interface: lan.list });
		push(adapted, '添加 eBPF 透明代理入站（下联接口：' + join('、', lan.list) + '）');
	}

	// 2. 外部控制、密钥与面板：LuCI 与 zashboard 都要从局域网连接控制器
	let basic = {};
	let ec = x['external-controller'];
	let addr = Y.parse_listen(ec != null ? '' + ec : '');
	if (!addr || addr.loopback) {
		basic['external-controller'] = '0.0.0.0:' + (addr ? addr.port : 9090);
		push(adapted, '外部控制改为监听 ' + basic['external-controller']);
	}
	if (empty(x.secret)) {
		let s = check_secret(args.secret);
		if (!s.ok)
			return s;
		basic.secret = s.value;
		push(adapted, '生成面板密钥');
	}
	if (empty(x['external-ui'])) {
		basic['external-ui'] = './dashboard';
		if (empty(x['external-ui-url']))
			basic['external-ui-url'] = mirror.value + UI_URL;
		push(adapted, '设置面板 zashboard（./dashboard）');
	}
	if (length(keys(basic)))
		push(ops, { op: 'basic.set', data: basic });

	// 3. Tun：路由器上由 eBPF 接管
	if (type(x.tun) == 'object' && x.tun.enable === true) {
		push(edits, { t: 'set', p: ['tun', 'enable'], v: false });
		push(adapted, '关闭 Tun（由 eBPF 接管）');
	}

	// 4. DNS
	let d = x.dns;
	if (d == null) {
		push(ops, { op: 'dns.set', data: { enable: true, listen: DNS_LISTEN, 'enhanced-mode': 'redir-host', nameserver: DNS_UPSTREAM } });
		push(adapted, '添加 DNS 设置（redir-host，监听 ' + DNS_LISTEN + '，国内上游）');
	} else if (type(d) != 'object')
		return fail('dns 不是映射，请在配置文件页编辑');
	else if (d.enable !== true) {
		let data = { enable: true };
		if (d.listen == null)
			data.listen = DNS_LISTEN;
		push(ops, { op: 'dns.set', data: data });
		push(adapted, '启用 DNS' + (data.listen ? '（监听 ' + DNS_LISTEN + '）' : ''));
	}

	// 5. DNS 出站：下联设备的 53 端口请求交给 dns 模块
	let px = x.proxies, rules = x.rules;
	if (px != null && type(px) != 'array')
		return fail('proxies 不是列表，请在配置文件页编辑');
	if (!has_type(px, 'dns')) {
		if (rules != null && type(rules) != 'array')
			return fail('rules 不是列表，请在配置文件页编辑');
		let taken = {};
		for (let e in [...(px ?? []), ...((type(x['proxy-groups']) == 'array') ? x['proxy-groups'] : [])])
			taken[obj(e).name] = true;
		let name = 'DNS_Hijack';
		for (let n = 2; taken[name]; n++)
			name = 'DNS_Hijack-' + n;
		let def = { name: name, type: 'dns' };
		push(edits, (px != null) ? { t: 'append', p: ['proxies'], v: def } : { t: 'set', p: ['proxies'], v: [def] });
		let rule = 'DST-PORT,53,' + name;
		if (rules != null) {
			let items = [{ v: rule }];
			for (let i = 0; i < length(rules); i++)
				push(items, { k: i });
			push(edits, { t: 'list', p: ['rules'], v: items });
		} else
			push(edits, { t: 'set', p: ['rules'], v: [rule] });
		push(adapted, '添加 DNS 出站 ' + name + ' 与首条规则 ' + rule);
	}

	if (length(edits)) {
		U.mkdir_p(P.RUN_DIR);
		let work = P.RUN_DIR + '/adapt-' + U.rand_hex(4) + '.yaml';
		let err = U.write_file(work, fs.readfile(file)) ? (Y.edit(work, edits) ?? Y.commit(file, work)) : '无法写入临时文件';
		fs.unlink(work);
		if (err)
			return fail(err);
	}
	if (length(ops)) {
		let r = F.apply_ops(file, ops);
		if (r.error)
			return fail(r.error);
	}
	return { ok: true, adapted: adapted };
}

/* ---------- 状态 ---------- */

// network.lan 的设备（通常是 br-lan），取不到时为空
function lan_default() {
	let c = uci.cursor();
	let dev = c?.get('network', 'lan', 'device');
	if (type(dev) == 'array')
		dev = dev[0];
	if (dev == null && c?.get('network', 'lan', 'type') == 'bridge')
		dev = 'br-lan';
	return C.ifname(dev) ? [dev] : [];
}

function status() {
	return {
		ok: true,
		core: fs.access(P.BIN, 'x') == true,
		config: fs.stat(P.CONFIG) != null,
		autostart: length(fs.glob('/etc/rc.d/S??' + P.SERVICE) ?? []) > 0,
		running: S.running(),
		arch_ok: CORE.asset() != null,
		lan_default: lan_default(),
		rev: U.file_rev(P.CONFIG)
	};
}

/* ---------- setup 任务 ---------- */

// 在 apply.begin 中执行（持有锁）：模板与导入来源写好候选文件，下载来源留给后台任务。
// 返回 { error } 或 { opts }；opts 只给任务进程用，job_status 不会返回
function prepare(args) {
	args = obj(args);
	if (index(SOURCES, args.source) < 0)
		return { error: '未知的配置来源' };
	let start = !!args.start;
	if (args.source == 'template') {
		let r = render(args);
		if (!r.ok)
			return { error: r.error };
		return U.write_file(P.CANDIDATE, r.content) ? { opts: { start: start } } : { error: '无法写入候选配置' };
	}
	let opts = { start: start, adapt: !!args.adapt };
	if (opts.adapt && args.lan != null) {
		let lan = check_lan(args.lan);
		if (!lan.ok)
			return { error: lan.error };
		opts.lan = lan.list;
	}
	if (args.source == 'import') {
		if (type(args.content) != 'string' || trim(args.content) == '')
			return { error: '导入的配置内容为空' };
		return U.write_file(P.CANDIDATE, args.content) ? { opts: opts } : { error: '无法写入候选配置' };
	}
	let url = C.url(args.url);
	if (url == null)
		return { error: '配置地址无效（需要 http:// 或 https:// 开头）' };
	let ua = DEFAULT_UA;
	if (!empty(args.ua)) {
		ua = C.text(args.ua, 256);
		if (!ua)
			return { error: 'User-Agent 无效' };
	}
	opts.url = url;
	opts.ua = ua;
	fs.unlink(P.CANDIDATE);
	return { opts: opts };
}

// 后台任务里、配置流程之前的步骤：下载（url 来源）与补全。返回 { adapted } 或 { error }
function job_pre(ctx, opts) {
	opts = obj(opts);
	if (opts.url) {
		ctx.step('download');
		// 订阅转换类地址不走 GitHub 镜像：服务运行时先经本机代理，再直连
		let r = CORE.fetch(opts.url, P.CANDIDATE, { routes: CORE.routes({ mirror: '' }, CORE.proxy_port()),
			args: ['-A', opts.ua ?? DEFAULT_UA] });
		if (!r.ok)
			return { error: '下载配置失败：' + r.error };
		if (!(fs.stat(P.CANDIDATE)?.size > 0)) {
			fs.unlink(P.CANDIDATE);
			return { error: '下载的配置为空' };
		}
	}
	if (!opts.adapt)
		return {};
	ctx.step('adapt');
	let r = adapt(P.CANDIDATE, { lan: opts.lan });
	return r.ok ? { adapted: r.adapted } : { error: '补全失败：' + r.error };
}

export { UI_URL, FIP_URL, render, adapt, status, prepare, job_pre };
