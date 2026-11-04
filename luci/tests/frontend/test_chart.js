'use strict';
const assert = require('assert');
const { load, baseclass } = require('./harness');

const chart = load('mihomo/chart.js', { baseclass });

assert.strictEqual(chart.niceMax(0), 1024);
assert.strictEqual(chart.niceMax(1500), 2048);
assert.strictEqual(chart.niceMax(3 * 1024 * 1024), 4 * 1024 * 1024);
assert.strictEqual(chart.niceMax(900 * 1024 * 1024), 1024 * 1024 * 1024);

assert.deepStrictEqual(chart.points([1, 2], 3, 100, 10, 2), [[50, 5], [100, 0]]);
assert.deepStrictEqual(chart.points([4], 2, 100, 10, 2), [[100, 0]]);
assert.strictEqual(chart.linePath([[0, 1], [2, 3]]), 'M0,1L2,3');
assert.strictEqual(chart.linePath([]), '');
assert.strictEqual(chart.areaPath([[0, 1], [2, 3]], 10), 'M0,1L2,3L2,10L0,10Z');

// 迷你图纵轴：按数据的最小、最大值留白，平稳的值画在中间而不是顶到上沿
assert.deepStrictEqual(chart.sparkRange([]), { lo: 0, hi: 1 });
assert.deepStrictEqual(chart.sparkRange([5, 5, 5]), { lo: 4, hi: 6 });
assert.deepStrictEqual(chart.sparkRange([100, 100]), { lo: 90, hi: 110 });
assert.deepStrictEqual(chart.sparkRange([0, 10]), { lo: 0, hi: 11.5 });
assert.deepStrictEqual(chart.sparkRange([20, 30]), { lo: 18.5, hi: 31.5 });
// points 支持下限
assert.deepStrictEqual(chart.points([1, 3], 2, 100, 10, 3, 1), [[0, 10], [100, 0]]);
assert.deepStrictEqual(chart.points([5], 2, 100, 10, 6, 4), [[100, 5]]);
