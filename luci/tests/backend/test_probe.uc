'use strict';

import * as fs from 'fs';
import * as P from 'mihomo.paths';
import * as U from 'mihomo.util';
import * as S from 'mihomo.service';
import * as PR from 'mihomo.probe';
import { ok, eq, done } from 'lib';

/* ---------- parse_target ---------- */

eq(PR.parse_target('www.baidu.com'), { host: 'www.baidu.com', port: 443 }, '只有主机名时默认 443');
eq(PR.parse_target(' example.com:80 '), { host: 'example.com', port: 80 }, '主机名加端口，去掉首尾空白');
eq(PR.parse_target('1.1.1.1:53'), { host: '1.1.1.1', port: 53 }, 'IPv4 加端口');
eq(PR.parse_target('[2001:db8::1]:8443'), { host: '2001:db8::1', port: 8443 }, '方括号 IPv6 加端口');
eq(PR.parse_target('2001:db8::1'), { host: '2001:db8::1', port: 443 }, '裸 IPv6');
eq(PR.parse_target('my_host.lan'), { host: 'my_host.lan', port: 443 }, '允许下划线');
for (let bad in ['', '   ', 'a b.com', 'x.com:0', 'x.com:65536', 'x.com:abc', 'x.com\r\nHost: y', '[::1', 'http://x.com', 'x.com/path', null, 42])
	eq(PR.parse_target(bad), null, '拒绝非法目标：' + sprintf('%J', bad));
eq(PR.parse_target(join('', map(split(sprintf('%254s', ''), ''), () => 'a'))), null, '拒绝超过 253 字符的主机名');

/* ---------- parse_dial_log ---------- */

let log = join('\n', [
	'Tue Nov  4 03:00:00 2026 daemon.warn mihomo-ebpf[1]: time="..." level=warning msg="[TCP] dial 节点选择 (match DomainSuffix/example.com) 127.0.0.1:40001 --> example.com:443 error: connect failed"',
	'Tue Nov  4 03:00:01 2026 daemon.warn mihomo-ebpf[1]: time="..." level=warning msg="[TCP] dial 节点选择 (match DomainSuffix/example.com) 127.0.0.1:40002 --> example.com:443 error: first"',
	'Tue Nov  4 03:00:02 2026 daemon.warn mihomo-ebpf[1]: time="..." level=warning msg="[TCP] dial DIRECT 127.0.0.1:40002 --> example.com:443 error: second"',
	''
]);
eq(PR.parse_dial_log(log, 40001), { proxy: '节点选择', rule: 'DomainSuffix', payload: 'example.com', error: 'connect failed' }, '按源端口取出规则与错误');
eq(PR.parse_dial_log(log, 40002), { proxy: 'DIRECT', rule: null, payload: null, error: 'second' }, '取最后一条；没有 match 段时 rule 为 null');
eq(PR.parse_dial_log(log, 4000), null, '端口必须完整匹配');
eq(PR.parse_dial_log(null, 1), null, '没有日志时返回 null');

/* ---------- rule_test（测试实例：mixed-port 17890，控制器 127.0.0.1:19090） ---------- */

eq(PR.rule_test('bad target').ok, false, '非法目标直接拒绝');

S.action('start');
let up = false;
for (let i = 0; i < 30 && !up; i++) {
	sleep(200);
	up = U.http('GET', '127.0.0.1', 19090, '/version', { secret: 'test-secret' }).status == 200;
}
ok(up, '测试实例已启动');

let t0 = time();
let r = PR.rule_test('127.0.0.1:19090');
ok(r.ok, '匹配测试成功', r);
eq([r.rule, r.chains, r.via, r.host, r.port], ['Match', ['DIRECT'], 'connections', '127.0.0.1', 19090], '命中 MATCH 规则，链路为 DIRECT');
ok(r.elapsed_ms >= 0 && r.elapsed_ms < 5000, '用时在 5 秒内', r.elapsed_ms);
sleep(300);
let conns = json(U.http('GET', '127.0.0.1', 19090, '/connections', { secret: 'test-secret' }).body ?? '{}');
eq(length(filter(conns.connections ?? [], (c) => c.metadata?.destinationPort == '19090')), 0, '测试连接已断开');

let f = PR.rule_test('example.com');
eq(f.ok, false, '节点拨号失败时测试连接不会出现在 /connections 中');
ok(time() - t0 <= 12, '两次测试都在超时内结束', time() - t0);
ok(type(f.error) == 'string' && f.error != '', '给出原因', f);

// mixed-port 缺失
let text = fs.readfile(P.CONFIG);
U.write_file(P.CONFIG, replace(text, /mixed-port: [0-9]+\n/, ''));
let m = PR.rule_test('127.0.0.1:19090');
eq(m.ok, false, '没有 mixed-port 时拒绝');
ok(index(m.error, 'mixed-port') >= 0, '提示 mixed-port', m.error);
U.write_file(P.CONFIG, text);

S.action('stop');
done();
