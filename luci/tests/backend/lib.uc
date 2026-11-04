'use strict';

// 极简 TAP 风格断言，失败时以非零退出码结束
let count = 0, failures = 0;

function ok(cond, name, extra) {
	count++;
	if (cond) {
		print('ok ', count, ' - ', name, '\n');
	} else {
		failures++;
		print('not ok ', count, ' - ', name, extra != null ? ' :: ' + sprintf('%J', extra) : '', '\n');
	}
}

function eq(got, want, name) {
	ok(sprintf('%J', got) == sprintf('%J', want), name, { got: got, want: want });
}

function done() {
	print(failures ? 'FAILED ' : 'PASSED ', count - failures, '/', count, '\n');
	exit(failures ? 1 : 0);
}

export { ok, eq, done };
