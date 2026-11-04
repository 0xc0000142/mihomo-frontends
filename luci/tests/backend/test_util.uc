'use strict';

import * as fs from 'fs';
import * as U from 'mihomo.util';
import * as P from 'mihomo.paths';
import { ok, eq, done } from 'lib';

// 路由器上 HOME 是 /root/mlt-home；本机（WSL）由 MLT_HOME 指定
let home = getenv('MLT_HOME') ?? '/root/mlt-home';
eq(P.HOME, home, '测试环境覆盖了 HOME');
eq(P.CONFIG, home + '/config.yaml', 'CONFIG 派生自 HOME');

eq(U.run('echo hi; exit 3'), { code: 3, out: 'hi\n' }, 'run 返回退出码与合并输出');
eq(U.shq("a'b'c"), "'a'\\''b'\\''c'", 'shq 转义全部单引号');

let d = P.RUN_DIR + '/a/b';
ok(U.mkdir_p(d), 'mkdir_p 逐级创建');
eq(fs.stat(d).mode & 0o777, 0o700, 'mkdir_p 目录权限 700');

let f = P.RUN_DIR + '/w.txt';
ok(U.write_file(f, 'x'), 'write_file 成功');
eq(fs.stat(f).mode & 0o777, 0o600, 'write_file 默认权限 600');
eq(fs.readfile(f), 'x', 'write_file 内容');
ok(U.write_file(f, ''), 'write_file 可写空内容');
eq(length(filter(fs.lsdir(P.RUN_DIR), (n) => match(n, /\.tmp-/))), 0, 'write_file 不留临时文件');

ok(U.write_json(P.RUN_DIR + '/j.json', { a: [1] }), 'write_json 成功');
eq(U.read_json(P.RUN_DIR + '/j.json'), { a: [1] }, 'read_json 读回');
eq(U.read_json(P.RUN_DIR + '/missing.json'), null, '缺失文件返回 null');
fs.writefile(P.RUN_DIR + '/bad.json', '{');
eq(U.read_json(P.RUN_DIR + '/bad.json'), null, '损坏的 JSON 返回 null');

eq(U.tail_lines('1\n2\n3\n', 2), '2\n3', 'tail_lines 取末尾');
eq(U.tail_lines(null, 2), '', 'tail_lines 处理 null');

ok(match(U.file_rev(f), /^[0-9]+-[0-9]+-0$/), 'file_rev 格式为 mtime-inode-size', U.file_rev(f));
eq(U.file_rev(P.RUN_DIR + '/missing'), '', '不存在的文件 rev 为空');
let rev1 = U.file_rev(f);
U.write_file(f, '');
ok(U.file_rev(f) != rev1, '替换文件后 rev 改变');

let h = U.http('GET', '127.0.0.1', 1, '/version', { timeout: 1000 });
eq(h.status, 0, 'http 连接被拒时 status 为 0');
eq(U.http('GET', '127.0.0.1', 1, '/', { secret: 'a\r\nb' }).status, 0, 'http 拒绝含换行的 secret');

done();
