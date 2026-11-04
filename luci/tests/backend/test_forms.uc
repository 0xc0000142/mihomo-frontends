'use strict';

import * as fs from 'fs';
import * as F from 'mihomo.forms';
import * as A from 'mihomo.apply';
import * as Y from 'mihomo.yaml';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import { ok, eq, done } from 'lib';

const FIXTURE = fs.readfile('/tmp/mlt/fixtures/full.yaml');
const tmp = P.RUN_DIR + '/forms-test.yaml';
U.mkdir_p(P.RUN_DIR);

function names(list) {
	return map(list, (x) => x.name);
}

function find(list, name) {
	for (let x in list)
		if (x.name == name)
			return x;
	return null;
}

function X() {
	return Y.query(tmp, 'explode(.)');
}

function valid() {
	let v = A.validate_file(tmp);
	if (!v.ok)
		print('# -t: ', v.error, '\n');
	return v.ok;
}

// 对 fixture 的副本执行操作；返回 apply_ops 的结果
function run(ops, src) {
	U.write_file(tmp, src ?? FIXTURE);
	return F.apply_ops(tmp, ops);
}

// 除 keys_ 外的顶层键展开后都与 fixture 相同
function others_same(keys_) {
	U.write_file(P.RUN_DIR + '/orig.yaml', FIXTURE);
	let a = Y.query(P.RUN_DIR + '/orig.yaml', 'explode(.)'), b = X();
	for (let k in uniq([...keys(a), ...keys(b)]))
		if (index(keys_, k) < 0 && !F.same(a[k], b[k]))
			return k;
	return null;
}

/* ---------- 读取 ---------- */

U.write_file(P.CONFIG, FIXTURE);
fs.unlink(P.DISABLED);
let s = F.sections(F.NAMES);
ok(s.ok && !s.parse_error, 'sections 读取成功', s.error ?? s.parse_error);
eq(s.rev, U.file_rev(P.CONFIG), 'sections 带 rev');

let pv = s.providers;
eq(names(pv.list), ['甲', '乙', 'Kitty'], '订阅列表');
let a = find(pv.list, '甲'), b = find(pv.list, '乙'), k = find(pv.list, 'Kitty');
eq([a.url, a.prefix, a.interval, a.health_check.interval, a.health_check.timeout], ['http://127.0.0.1:1/a?token=x&flag=1', '[甲]', 3600, 300, 1000], '合并后的字段值');
eq(sort(a.inherited), ['health_check', 'interval'], '标出继承自锚点的字段');
eq(a.anchor, 'p', '记录锚点名');
eq([k.inherited, k.anchor, k.interval], [[], null, 7200], '没有合并键的订阅');
eq(b.user_agent, 'clash-verge/v2.5.2', 'User-Agent');
eq(a.groups, ['香港', '全部节点', '自动选择', '单独'], '使用该订阅的策略组');
eq(pv.defaults, { interval: 3600, health_check: { enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 1000 } }, '新订阅默认值取自锚点');
eq(pv.migratable, ['香港', '全部节点', '自动选择', '单独'], '可迁移的策略组');

let g = s.groups;
eq([find(g, '香港').use_from, find(g, '单独').use_from, find(g, '节点选择').use_from], ['anchor:use', 'explicit', null], 'use 的来源');
eq(find(g, '自动选择').type, 'url-test', '显式键优先于合并键');

let e = s.ebpf;
eq([e.index, e.style, e.data.local_enable, e.data.shared_enable], [0, 'mode', true, true], 'eBPF 角色');
eq(e.legacy, ['dns-mode', 'shared.ipv6-mode'], '识别旧写法');
eq([e.data.local['dns-mode'], e.data.shared['dns-mode'], e.data.shared.ipv6], ['hijack', 'hijack', true], '旧写法展开到各角色');
eq(e.data.local['bypass-exclude'], ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], 'bypass-exclude');
eq(e.ipcidr_sets, ['CN-IP', 'Private-IP'], 'ipcidr 规则集');

eq(length(s.rules.list), 8, '规则条数');
ok(index(s.rules.policies, 'TS-Server') >= 0 && index(s.rules.policies, '节点选择') >= 0 && index(s.rules.policies, 'REJECT') >= 0, '策略列表');

let rp = s.rule_providers.list;
eq(find(rp, 'CN-IP').refs, ['规则第 7 条', '入站 ebpf-in 的 bypass-rule-set'], '规则集引用：规则与 eBPF');
eq(find(rp, 'Private-IP').refs, ['规则第 6 条'], '规则集引用：逻辑规则内部');
eq(find(rp, 'AWAvenue-Ads').refs, ['规则第 4 条', 'DNS 策略 rule-set:AWAvenue-Ads'], '规则集引用：DNS 策略');
eq(find(rp, 'Fake-IP-Filter').refs, ['DNS fake-ip-filter'], '规则集引用：fake-ip-filter');
eq([find(rp, 'Unused').refs, find(rp, 'Private-IP').size], [[], 2], '未引用的规则集与 inline 条目数');

eq([s.basic['mixed-port'], s.basic['find-process-mode'], s.basic['bind-address'], s.basic['sniffer.enable'], s.basic['profile.store-selected']],
	[17891, 'off', '*', true, true], '基础设置');
eq(map(s.dns['nameserver-policy'], (x) => [x.key, x.servers]),
	[['rule-set:AWAvenue-Ads', ['rcode://success']], ['+.tail.ts.net', ['ts://TS-Server']], ['+.lan.example', ['223.5.5.5', '119.29.29.29']]], 'DNS 策略保持顺序');
eq(s.dns.nameserver, ['https://1.1.1.1/dns-query#节点选择'], 'DNS 服务器');
eq([length(s.tailscale), s.tailscale[0].name, s.tailscale[0].hostname, s.tailscale[0]['listen-port']], [1, 'TS-Server', 'test-node', 41642], 'Tailscale');

eq(F.sections(['nope']).ok, false, '未知区段');
U.write_file(P.CONFIG, 'mode: rule\nfoo: [\n');
ok(F.sections(['basic']).parse_error != null, '语法错误时返回 parse_error');
U.write_file(P.CONFIG, FIXTURE);

/* ---------- 订阅 ---------- */

let r = run([{ op: 'provider.set', name: '甲', data: { interval: 7200, health_check: { interval: 60 } } }]);
ok(!r.error, 'provider.set 成功', r.error);
let x = X();
eq([x['proxy-providers']['甲'].interval, x['proxy-providers']['甲']['health-check'].interval, x['proxy-providers']['甲']['health-check'].url],
	[7200, 60, 'https://cp.cloudflare.com'], 'provider.set 写入继承字段');
eq([x.p.interval, x.p['health-check'].interval, x['proxy-providers']['乙'].interval], [3600, 300, 3600], '锚点与其他订阅不变');
eq(Y.query(tmp, '.["proxy-providers"]["甲"] | keys'), ['<<', 'path', 'url', 'override', 'interval', 'health-check'], '保留合并键');
eq(others_same(['proxy-providers']), null, '只改动 proxy-providers');
ok(index(fs.readfile(tmp), '  #停用的:\n  #  <<: *p') >= 0, '保留订阅之间的注释');
ok(valid(), 'provider.set 后 -t 通过');

r = run([{ op: 'provider.set', name: '乙', data: { user_agent: '', prefix: '' } }]);
x = X();
eq([x['proxy-providers']['乙'].header, x['proxy-providers']['乙'].override], [null, null], '清空 User-Agent 与前缀时删除对应字段');

U.write_file(tmp, FIXTURE);
r = F.apply_ops(tmp, [{ op: 'provider.set', name: '甲', data: { url: 'http://127.0.0.1:1/a?token=x&flag=1', interval: 3600 } }]);
eq([r.error, fs.readfile(tmp)], [null, FIXTURE], '值不变时文件不变');
ok(run([{ op: 'provider.set', name: '甲', data: { url: 'ftp://x' } }]).error, '拒绝非法链接');
ok(run([{ op: 'provider.set', name: '甲', data: { interval: -1 } }]).error, '拒绝非法间隔');
ok(run([{ op: 'provider.set', name: '无', data: {} }]).error, '拒绝不存在的订阅');
eq(run([{ op: 'provider.set', name: 'Kitty', data: { bogus: 1, interval: 3600 } }]).error, null, '忽略未知字段');
eq(X()['proxy-providers'].Kitty.bogus, null, '未知字段不写入');

r = run([{ op: 'provider.add', name: '丙', data: { url: 'http://127.0.0.1:1/c', prefix: '[丙]' } }]);
ok(!r.error, 'provider.add 成功', r.error);
x = X();
eq(x['proxy-providers']['丙'], { type: 'http', url: 'http://127.0.0.1:1/c', path: './proxy_provider/丙.yaml', interval: 3600,
	'health-check': { enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 1000 }, override: { 'additional-prefix': '[丙]' } }, 'provider.add 的定义');
eq([x.use.use, x['proxy-groups'][5].use], [['甲', '乙', 'Kitty', '丙'], ['甲', '乙', 'Kitty', '丙']], '新订阅加入包含全部订阅的 use 列表');
ok(index(fs.readfile(tmp), '#- 停用的') >= 0, '追加时保留 use 列表里的注释');
ok(valid(), 'provider.add 后 -t 通过');
r = run([{ op: 'provider.add', name: '丁', data: { url: 'http://127.0.0.1:1/d', join_groups: false } }]);
eq(X().use.use, ['甲', '乙', 'Kitty'], 'join_groups 为 false 时不加入策略组');
ok(run([{ op: 'provider.add', name: '甲', data: { url: 'http://x' } }]).error, '拒绝重名');
ok(run([{ op: 'provider.add', name: 'a/b', data: { url: 'http://x' } }]).error, '拒绝非法名称');
ok(run([{ op: 'provider.add', name: '戊', data: {} }]).error, '新增时链接必填');

r = run([{ op: 'provider.delete', name: 'Kitty' }]);
ok(!r.error, 'provider.delete 成功', r.error);
x = X();
eq([x['proxy-providers'].Kitty, x.use.use, x['proxy-groups'][5].use], [null, ['甲', '乙'], ['甲', '乙']], '删除定义与 use 引用');
eq(r.post, [{ t: 'unlink', path: P.HOME + '/proxy_provider/Kitty.yaml' }], '应用后删除缓存文件');
ok(valid(), 'provider.delete 后 -t 通过');

// 停用与启用
fs.unlink(P.DISABLED);
r = run([{ op: 'provider.toggle', name: '乙', enabled: false }]);
ok(!r.error, '停用成功', r.error);
x = X();
eq([x['proxy-providers']['乙'], x.use.use, x['proxy-groups'][5].use], [null, ['甲', 'Kitty'], ['甲', 'Kitty']], '停用时移出 use 列表');
let d = F.disabled_read()['乙'];
eq([d.def.header, d.def.interval, d.refs], [{ 'User-Agent': ['clash-verge/v2.5.2'] }, 3600, [{ anchor: 'use' }, { group: '单独' }]], '停用列表记录完整定义与所在列表');
ok(valid(), '停用后 -t 通过');
let after = fs.readfile(tmp);
r = F.apply_ops(tmp, [{ op: 'provider.toggle', name: '乙', enabled: true }]);
ok(!r.error, '启用成功', r.error);
x = X();
eq([x['proxy-providers']['乙'].header, x.use.use, x['proxy-groups'][5].use], [{ 'User-Agent': ['clash-verge/v2.5.2'] }, ['甲', 'Kitty', '乙'], ['甲', 'Kitty', '乙']], '启用时加回原来的列表');
eq(r.post, [{ t: 'disabled_remove', name: '乙' }], '启用成功后才从停用列表删除');
ok('乙' in F.disabled_read(), '应用前停用列表仍保留');
F.run_post(r.post);
eq(F.disabled_read(), {}, 'post 动作删除停用记录');
ok(run([{ op: 'provider.toggle', name: '乙', enabled: true }]).error, '已启用的订阅不能再启用');

// 停用列表中的订阅出现在 sections 里；只在停用列表里的订阅可以删除
U.write_file(P.CONFIG, after);
fs.writefile(P.DISABLED, sprintf('%J', { providers: { '乙': d } }));
let s2 = F.sections(['providers']);
eq(map(s2.providers.list, (x) => [x.name, x.enabled]), [['甲', true], ['Kitty', true], ['乙', false]], '停用的订阅排在最后');
U.write_file(tmp, after);
r = F.apply_ops(tmp, [{ op: 'provider.delete', name: '乙' }]);
eq([r.error, fs.readfile(tmp)], [null, after], '删除停用的订阅不改配置');
eq(r.post, [{ t: 'disabled_remove', name: '乙' }, { t: 'unlink', path: P.HOME + '/proxy_provider/乙.yaml' }], '删除停用的订阅：应用后移出列表并删除缓存');
U.write_file(P.CONFIG, FIXTURE);
fs.unlink(P.DISABLED);

// 迁移到 include-all-providers
r = run([{ op: 'groups.include_all' }]);
ok(!r.error, 'groups.include_all 成功', r.error);
x = X();
eq([x.use['include-all-providers'], x.use.use, x['proxy-groups'][2]['include-all-providers'], x['proxy-groups'][5]['include-all-providers'], x['proxy-groups'][5].use],
	[true, null, true, true, null], '锚点与显式列表都改为 include-all-providers');
ok(valid(), '迁移后 -t 通过');
ok(F.apply_ops(tmp, [{ op: 'groups.include_all' }]).error, '没有可迁移的组时报错');

/* ---------- eBPF ---------- */

r = run([{ op: 'ebpf.set', data: { shared_enable: false } }]);
ok(!r.error, 'ebpf.set 成功', r.error);
x = X().listeners[0];
eq([x.mode, x['dns-mode'], x.local['dns-mode'], x.shared['dns-mode'], x.shared['ipv6-mode'], x.shared.ipv6], ['local', null, 'hijack', 'hijack', null, true], '写入时规整旧写法');
ok(index(fs.readfile(tmp), '# 私网放行列表包含') >= 0, '保留入站里的注释');
eq(others_same(['listeners']), null, '只改动 listeners');
ok(valid(), 'ebpf.set 后 -t 通过');

r = run([{ op: 'ebpf.set', data: { shared: { 'exclude-mac-address': ['AA-BB-CC-DD-EE-FF'], 'bypass-exclude': [] }, 'udp-timeout': '120' } }]);
x = X().listeners[0];
eq([x.shared['exclude-mac-address'], x.shared['bypass-exclude'], x['udp-timeout']], [['aa:bb:cc:dd:ee:ff'], null, 120], 'MAC 规整、空列表删除、数字串转数字');
ok(run([{ op: 'ebpf.set', data: { local_enable: false, shared_enable: false } }]).error, '至少开启一个角色');
ok(run([{ op: 'ebpf.set', data: { shared: { interface: [] } } }]).error, '开启下联时需要网卡');
ok(run([{ op: 'ebpf.set', data: { local: { 'bypass-exclude': ['1.2.3.4/40'] } } }]).error, '拒绝非法 CIDR');
ok(run([{ op: 'ebpf.set', data: { 'bypass-rule-set': ['Nope'] } }]).error, '拒绝不存在的规则集');
ok(run([{ op: 'ebpf.create' }]).error, '已有 eBPF 入站时不能创建');
let nol = substr(FIXTURE, 0, index(FIXTURE, '# eBPF 透明入站'));
r = run([{ op: 'ebpf.create' }], nol);
ok(!r.error, 'ebpf.create 成功', r.error);
x = X().listeners[0];
eq([x.type, x.mode, x['bypass-rule-set'], x.shared.interface], ['ebpf', 'hybrid', ['CN-IP'], ['br-lan']], '默认 eBPF 入站');
eq(x.shared['bypass-exclude'], ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], '有 Tailscale 代理时 Tailnet 强制进核心');
ok(valid(), 'ebpf.create 后 -t 通过');
r = run([{ op: 'ebpf.create', interface: ['eth1', 'br-lan'] }], nol);
eq(r.error ? r.error : X().listeners[0].shared.interface, ['eth1', 'br-lan'], 'ebpf.create 指定下联接口');
ok(run([{ op: 'ebpf.create', interface: ['bad name!'] }], nol).error, '接口名非法时报错');
ok(run([{ op: 'ebpf.create', interface: [] }], nol).error, '接口列表为空时报错');
let nots = 'mixed-port: 17890\nproxies:\n  - {name: dummy, type: socks5, server: 127.0.0.1, port: 1}\nrules:\n  - MATCH,DIRECT\n';
r = run([{ op: 'ebpf.create' }], nots);
x = X().listeners[0];
eq([r.error, x.local['bypass-exclude'], x.shared['bypass-exclude'], x['bypass-rule-set']], [null, null, null, null],
	'没有 Tailscale 与 CN-IP 时不加 bypass-exclude 与 bypass-rule-set');

/* ---------- 规则 ---------- */

r = run([{ op: 'rules.set', items: [{ v: 'DOMAIN,new.example,DIRECT' }, { k: 0 }, { k: 1 }, { k: 3 }, { k: 2, v: 'DOMAIN-SUFFIX,example.org,DIRECT' }, { k: 4 }, { k: 5 }, { k: 6 }, { k: 7 }] }]);
ok(!r.error, 'rules.set 成功', r.error);
eq(slice(X().rules, 0, 5), ['DOMAIN,new.example,DIRECT', 'IP-CIDR,100.64.0.0/10,TS-Server,no-resolve', 'DST-PORT,53,DNS_Hijack', 'RULE-SET,AWAvenue-Ads,REJECT', 'DOMAIN-SUFFIX,example.org,DIRECT'], 'rules.set 结果');
let rt = fs.readfile(tmp);
ok(index(rt, "  # Tailscale 在最前\n  - IP-CIDR,100.64.0.0/10") >= 0 && index(rt, "# 局域网") >= 0, '规则注释随规则移动', rt);
ok(valid(), 'rules.set 后 -t 通过');
ok(run([{ op: 'rules.set', items: [{ k: 99 }] }]).error, '拒绝越界下标');
ok(run([{ op: 'rules.set', items: [{ v: 'MATCH' }] }]).error, '拒绝缺少策略的规则');
U.write_file(tmp, FIXTURE);
r = F.apply_ops(tmp, [{ op: 'rules.set', items: map(s.rules.list, (v, i) => ({ k: i, v: v })) }]);
eq([r.error, fs.readfile(tmp)], [null, FIXTURE], '规则不变时文件不变');

/* ---------- 规则集 ---------- */

r = run([{ op: 'rule_provider.set', name: 'CN-IP', data: { interval: 3600, proxy: 'DIRECT' } }]);
x = X()['rule-providers']['CN-IP'];
eq([r.error, x.interval, x.proxy], [null, 3600, 'DIRECT'], 'rule_provider.set');
ok(run([{ op: 'rule_provider.set', name: 'CN-IP', data: { proxy: 'Nope' } }]).error, '拒绝不存在的策略');
ok(run([{ op: 'rule_provider.set', name: 'Private-IP', data: { interval: 1 } }]).error, 'inline 规则集不能编辑');
r = run([{ op: 'rule_provider.add', name: 'New', data: { behavior: 'domain', format: 'mrs', url: 'https://example.com/n.mrs', proxy: '节点选择' } }]);
x = X()['rule-providers'].New;
eq([r.error, x.path, x.interval, x.proxy], [null, './rule_provider/New.mrs', 86400, '节点选择'], 'rule_provider.add');
ok(valid(), 'rule_provider.add 后 -t 通过');
ok(run([{ op: 'rule_provider.add', name: 'X', data: { behavior: 'classical', format: 'mrs', url: 'https://e/x' } }]).error, 'classical 不支持 mrs');
ok(run([{ op: 'rule_provider.add', name: 'CN-IP', data: { behavior: 'ipcidr', format: 'mrs', url: 'https://e/x' } }]).error, '拒绝重名规则集');
r = run([{ op: 'rule_provider.delete', name: 'CN-IP' }]);
ok(r.error && index(r.error, '规则第 7 条') >= 0, '被引用的规则集不能删除', r.error);
r = run([{ op: 'rule_provider.delete', name: 'Unused' }]);
eq([r.error, X()['rule-providers'].Unused, r.post], [null, null, [{ t: 'unlink', path: P.HOME + '/rule_provider/unused.yaml' }]], 'rule_provider.delete');

/* ---------- 基础、DNS、Tailscale ---------- */

r = run([{ op: 'basic.set', data: { 'mixed-port': '17892', 'log-level': 'info', 'sniffer.enable': false, 'geox-url.mmdb': 'https://example.com/m.mmdb', 'profile.store-selected': true } }]);
x = X();
eq([r.error, x['mixed-port'], x['log-level'], x.sniffer.enable, x['geox-url'].mmdb], [null, 17892, 'info', false, 'https://example.com/m.mmdb'], 'basic.set');
eq(others_same(['mixed-port', 'log-level', 'sniffer', 'geox-url']), null, 'basic.set 只改动目标键');
ok(valid(), 'basic.set 后 -t 通过');
ok(run([{ op: 'basic.set', data: { 'external-controller': '' } }]).error, '控制器不能为空');
ok(run([{ op: 'basic.set', data: { 'bind-address': 'x' } }]).error, '拒绝非法监听地址');
ok(run([{ op: 'basic.set', data: { 'log-level': 'verbose' } }]).error, '拒绝非法日志级别');

r = run([{ op: 'dns.set', data: { 'enhanced-mode': 'fake-ip', 'proxy-server-nameserver': [], 'nameserver-policy': [
	{ key: '+.lan.example', servers: ['223.5.5.5'] }, { key: 'rule-set:AWAvenue-Ads', servers: ['rcode://success'] }] } }]);
x = X().dns;
eq([r.error, x['enhanced-mode'], x['proxy-server-nameserver'], x['nameserver-policy']], [null, 'fake-ip', null, { '+.lan.example': '223.5.5.5', 'rule-set:AWAvenue-Ads': 'rcode://success' }], 'dns.set');
ok(valid(), 'dns.set 后 -t 通过');
U.write_file(tmp, FIXTURE);
r = F.apply_ops(tmp, [{ op: 'dns.set', data: { 'nameserver-policy': s.dns['nameserver-policy'], nameserver: s.dns.nameserver } }]);
eq([r.error, fs.readfile(tmp)], [null, FIXTURE], 'DNS 不变时文件不变');
ok(run([{ op: 'dns.set', data: { 'nameserver-policy': [{ key: 'a', servers: [] }] } }]).error, 'DNS 策略需要服务器');
ok(run([{ op: 'dns.set', data: { 'fake-ip-range': 'fc00::/18' } }]).error, 'fake-ip-range 只接受 IPv4');

r = run([{ op: 'tailscale.set', name: 'TS-Server', data: { hostname: 'new-node', 'listen-port': '', 'advertise-routes': ['192.168.77.0/24'] } }]);
x = X().proxies[1];
eq([r.error, x.hostname, x['listen-port'], x['advertise-routes'], x['auth-key']], [null, 'new-node', null, ['192.168.77.0/24'], 'tskey-test-123'], 'tailscale.set');
ok(index(fs.readfile(tmp), '# 不要填写 dialer-proxy') >= 0, '保留代理里的注释');
ok(run([{ op: 'tailscale.set', name: 'TS-Server', data: { hostname: 'a b' } }]).error, '拒绝非法主机名');
ok(run([{ op: 'tailscale.set', name: 'Nope', data: {} }]).error, '拒绝不存在的 Tailscale 代理');

/* ---------- 其他 ---------- */

r = run([{ op: 'basic.set', data: { 'log-level': 'info' } }, { op: 'mode.set', mode: 'global' }]);
x = X();
eq([r.error, x['log-level'], x.mode], [null, 'info', 'global'], '一次提交多个操作');
ok(run([{ op: 'mode.set', mode: 'x' }]).error, 'mode.set 拒绝非法值');
ok(run([{ op: 'rm' }]).error, '拒绝未知操作');
ok(run([]).error, '拒绝空操作列表');

// 校验用副本：Tailscale 换成临时状态目录、去掉 auth-key，原文件不变
U.write_file(tmp, FIXTURE);
let chk = P.RUN_DIR + '/chk.yaml';
ok(F.validation_copy(tmp, chk), 'validation_copy 成功');
let cx = Y.query(chk, 'explode(.)').proxies[1];
eq([cx['state-dir'], cx['auth-key'], cx['control-url'], fs.readfile(tmp)], ['.luci/ts-check/1', '', 'http://127.0.0.1:1', FIXTURE], '校验副本中的 Tailscale 不会用真实状态登录');
fs.unlink(chk);

eq(F.home_path('./proxy_provider/a.yaml'), P.HOME + '/proxy_provider/a.yaml', 'home_path 相对路径');
eq(F.home_path('../etc/passwd'), null, 'home_path 拒绝 ..');
eq(F.home_path('/etc/passwd'), null, 'home_path 拒绝 HOME 之外');
eq([F.rule_uses('AND,((RULE-SET,A),(NETWORK,UDP)),X', 'A'), F.rule_uses('RULE-SET,AB,X', 'A'), F.rule_uses('RULE-SET, A ,X', 'A')], [true, false, true], 'rule_uses');

fs.unlink(tmp);
fs.unlink(P.RUN_DIR + '/orig.yaml');
eq(length(filter(fs.lsdir(P.RUN_DIR), (n) => match(n, /^(forms|edit|ops)-/))), 0, '不留临时文件');
done();
