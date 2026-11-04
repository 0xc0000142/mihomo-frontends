'use strict';

// 本机测试桩：没有 ubusd，connect 一律失败（service.instance() 因此返回 null）
function connect() {
	return null;
}

function error() {
	return 'ubus 测试桩';
}

export { connect, error };
