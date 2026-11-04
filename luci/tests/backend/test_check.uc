'use strict';

import * as C from 'mihomo.check';
import { ok, eq, done } from 'lib';

eq(C.int(8, 0, 10), 8, 'int 数字');
eq(C.int('08', 0, 10), 8, 'int 数字串');
eq(C.int(' 7 ', 0, 10), 7, 'int 去空白');
eq(C.int('1e3', 0, 5000), null, 'int 拒绝指数');
eq(C.int(1.5, 0, 10), null, 'int 拒绝小数');
eq(C.int(11, 0, 10), null, 'int 上限');
eq(C.int(-1, 0, 10), null, 'int 下限');
eq(C.int('', 0, 10), null, 'int 空串');
eq(C.int(true, 0, 10), null, 'int 拒绝布尔');
eq(C.port(7890), 7890, 'port');
eq(C.port(0), null, 'port 不含 0');
eq(C.port0(0), 0, 'port0 含 0');
eq(C.port('65536'), null, 'port 越界');

eq(C.bool(true), true, 'bool true');
eq(C.bool('0'), false, "bool '0'");
eq(C.bool('true'), true, "bool 'true'");
eq(C.bool('yes'), null, 'bool 拒绝 yes');
eq(C.bool(1), null, 'bool 拒绝数字');

eq(C.oneof('hijack', ['hijack', 'off']), 'hijack', 'oneof');
eq(C.oneof('x', ['hijack', 'off']), null, 'oneof 拒绝');

eq(C.url('https://a.example/x?b=1&c=2'), 'https://a.example/x?b=1&c=2', 'url');
eq(C.url('  http://a  '), 'http://a', 'url 去空白');
eq(C.url('ftp://a'), null, 'url 只允许 http/https');
eq(C.url('http://a b'), null, 'url 拒绝空白');
eq(C.url('http://'), null, 'url 需要主机');
eq(C.url("http://a\n"), 'http://a', 'url 去掉首尾换行');
eq(C.url("http://a\nb"), null, 'url 拒绝中间换行');

eq(C.cidr('192.168.1.1'), '192.168.1.1/32', 'cidr 裸 IPv4');
eq(C.cidr('100.64.0.0/10'), '100.64.0.0/10', 'cidr IPv4');
eq(C.cidr('1.2.3.4/33'), null, 'cidr 前缀越界');
eq(C.cidr('256.1.1.1/8'), null, 'cidr 非法地址');
eq(C.cidr('1.2.3/8'), null, 'cidr 段数不足');
eq(C.cidr('FD7A:115C:A1E0::/48'), 'fd7a:115c:a1e0::/48', 'cidr IPv6 小写');
eq(C.cidr('::1'), '::1/128', 'cidr 裸 IPv6');
eq(C.cidr('fe80::/129'), null, 'cidr IPv6 前缀越界');
eq(C.cidr('fe80:::1/64'), null, 'cidr 非法 IPv6');
eq(C.cidr('1:2:3:4:5:6:7:8:9/64'), null, 'cidr IPv6 段数过多');
eq(C.ip('10.0.0.1'), '10.0.0.1', 'ip');
eq(C.ip('10.0.0.1/8'), null, 'ip 不带前缀');

eq(C.mac('AA-BB-CC-DD-EE-FF'), 'aa:bb:cc:dd:ee:ff', 'mac 规整');
eq(C.mac('aa:bb:cc:dd:ee'), null, 'mac 长度');
eq(C.ifname('br-lan'), 'br-lan', 'ifname');
eq(C.ifname('a b'), null, 'ifname 空格');
eq(C.ifname('abcdefghijklmnop'), null, 'ifname 长度');

eq(C.listen('0.0.0.0:9090'), '0.0.0.0:9090', 'listen');
eq(C.listen(':1053'), ':1053', 'listen 省略主机');
eq(C.listen('[::]:53'), '[::]:53', 'listen IPv6');
eq(C.listen('a:b'), null, 'listen 非法');

eq(C.text('  a b  ', 10), 'a b', 'text 去首尾空白');
eq(C.text("a\nb", 10), null, 'text 拒绝换行');
eq(C.text('abcdef', 3), null, 'text 长度');
eq(C.text('', 3), '', 'text 允许空串');
eq(C.text(5, 3), null, 'text 拒绝非字符串');

eq(C.name('Kitty'), 'Kitty', 'name');
eq(C.name('红魔馆网络'), '红魔馆网络', 'name 中文');
eq(C.name('a/b'), null, 'name 拒绝 /');
eq(C.name('a,b'), null, 'name 拒绝逗号');
eq(C.name('.hidden'), null, 'name 拒绝 . 开头');
eq(C.name(''), null, 'name 拒绝空');
eq(C.name(' x '), null, 'name 拒绝首尾空白');

eq(C.list(['a', 'b', 'a'], (x) => C.text(x, 5), 10), ['a', 'b'], 'list 去重保序');
eq(C.list(['a', 'toolong'], (x) => C.text(x, 5), 10), null, 'list 任一项非法');
eq(C.list('a', (x) => x, 10), null, 'list 需要数组');
eq(C.list([1, 2, 3], (x) => x, 2), null, 'list 数量上限');
eq(C.list([], (x) => x, 2), [], 'list 空数组');

done();
