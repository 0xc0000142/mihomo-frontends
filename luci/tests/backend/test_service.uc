'use strict';

import * as fs from 'fs';
import * as S from 'mihomo.service';
import * as SY from 'mihomo.system';
import { ok, eq, done } from 'lib';

eq(S.action('rm -rf /').ok, false, '拒绝白名单外的操作');
ok(match(S.version() ?? '', /^[^ ]+$/), '能读到版本号', S.version());

let st = S.status();
eq(st.running, false, '测试服务名不在 procd 中时为未运行');
ok(st.config_rev != '', 'status 含配置 rev');
eq(st.yq_present, true, 'status 报告 yq');
eq(st.config_present, true, 'status 报告配置文件存在');

let c = S.controller();
eq([c.ok, c.reachable, c.port], [true, false, null], '回环控制器标记为浏览器不可直连');
ok(index(c.reason, '0.0.0.0:19090') >= 0, '提示正确写法', c.reason);
ok('ui' in c && 'ui_name' in c, 'controller 返回面板目录字段');

eq(S.action('start').ok, true, '通过 init 脚本启动');
sleep(1500);
ok(S.running(), 'running() 为真');
eq(S.action('stop').ok, true, '停止');
ok(!S.running(), 'running() 为假');

let pi = S.proc_info(+fs.readlink('/proc/self'));
ok(pi.uptime >= 0 && pi.rss_kb > 0, 'proc_info 解析运行时长与内存', pi);

let lg = SY.logs(5);
ok(lg.ok && length(split(lg.text, '\n')) <= 5, 'logs 按行数截取');
eq(SY.logs(99999).ok, true, 'logs 行数越界时使用默认值');

done();
