'use strict';

// 预览服务器的 ubus 桥（在路由器上运行）：每行读入一个 JSON 请求 {id, object, method, args}，每行回一个 {id, code, data}
import * as fs from 'fs';
import * as ubus from 'ubus';

let conn = ubus.connect();
for (let line = fs.stdin.read('line'); line != null && line != ''; line = fs.stdin.read('line')) {
	let req;
	try {
		req = json(line);
	} catch (e) {
		continue;
	}
	let data = conn.call(req.object, req.method, req.args ?? {});
	let err = (data == null) ? ubus.error(true) : null;
	fs.stdout.write(sprintf('%J\n', { id: req.id, code: err ?? 0, data: data }));
	fs.stdout.flush();
}
