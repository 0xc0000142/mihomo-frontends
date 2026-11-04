'use strict';
'require baseclass';

/* 纯 SVG 图表：实时网速折线图与迷你图。 */

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
	const el = document.createElementNS(NS, tag);
	for (const k in attrs) el.setAttribute(k, attrs[k]);
	return el;
}

// 纵轴上限：按 1024 进位的单位取整到 1/2/4/5/8 倍，最小 1 KB/s
function niceMax(v) {
	v = Math.max(Number(v) || 0, 1024);
	let unit = 1;
	while (v / unit >= 1024) unit *= 1024;
	const x = v / unit;
	for (const s of [1, 2, 4, 5, 8, 10, 20, 40, 50, 80, 100, 200, 400, 500, 800, 1024])
		if (s >= x) return s * unit;
	return 1024 * unit;
}

// 右对齐：最新值在最右侧，不足 n 个点时左侧留空；纵轴从 min（默认 0）到 max
function points(values, n, w, h, max, min) {
	const step = w / (n - 1), off = n - values.length, lo = min || 0, span = max - lo;
	return values.map((v, i) => [ +((off + i) * step).toFixed(1), +(h - Math.max(0, Math.min((v - lo) / span, 1)) * h).toFixed(1) ]);
}

// 迷你图纵轴：上下各留 15% 的空白；数值不变时上下各放宽 10%（至少 1），线画在中间
function sparkRange(values) {
	if (!values.length) return { lo: 0, hi: 1 };
	const lo = Math.min(...values), hi = Math.max(...values);
	if (hi === lo) {
		const d = Math.max(Math.abs(lo) * 0.1, 1);
		return { lo: lo - d, hi: hi + d };
	}
	const pad = (hi - lo) * 0.15;
	return { lo: Math.max(0, +(lo - pad).toFixed(6)), hi: +(hi + pad).toFixed(6) };
}

let gradId = 0;

function linePath(pts) {
	return pts.length ? 'M' + pts.map(p => p[0] + ',' + p[1]).join('L') : '';
}

function areaPath(pts, h) {
	if (!pts.length) return '';
	return linePath(pts) + 'L' + pts[pts.length - 1][0] + ',' + h + 'L' + pts[0][0] + ',' + h + 'Z';
}

// opts: { series: [{ label, cls }], points, height, format }
function lineChart(opts) {
	const n = opts.points || 60, W = 600, H = 100, fmt = opts.format || String;
	const data = opts.series.map(() => []);
	const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'class': 'mh-chart-svg' });
	const grid = root.appendChild(svg('g', { 'class': 'mh-chart-grid' }));
	const areas = opts.series.map(s => root.appendChild(svg('path', { 'class': 'mh-area ' + s.cls })));
	const lines = opts.series.map(s => root.appendChild(svg('path', { 'class': 'mh-line ' + s.cls, 'vector-effect': 'non-scaling-stroke' })));
	const labels = E('div', { 'class': 'mh-chart-labels' });
	const legend = E('div', { 'class': 'mh-chart-legend' }, opts.series.map(s => E('span', { 'class': s.cls }, s.label)));
	const el = E('div', { 'class': 'mh-chart', style: 'height:' + (opts.height || 160) + 'px' }, [ labels, E('div', { 'class': 'mh-chart-plot' }, root), legend ]);

	function draw() {
		const max = niceMax(Math.max(0, ...data.flat()));
		grid.innerHTML = '';
		labels.innerHTML = '';
		[1, 0.5, 0].forEach(f => {
			const y = (H - f * H).toFixed(1);
			grid.appendChild(svg('line', { x1: 0, x2: W, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' }));
			labels.appendChild(E('span', { style: 'top:' + ((1 - f) * 100) + '%' }, f ? fmt(max * f) : '0'));
		});
		opts.series.forEach((s, i) => {
			const pts = points(data[i], n, W, H, max);
			lines[i].setAttribute('d', linePath(pts));
			areas[i].setAttribute('d', areaPath(pts, H));
		});
	}

	draw();
	return {
		el,
		push(values) {
			values.forEach((v, i) => {
				data[i].push(Number(v) || 0);
				if (data[i].length > n) data[i].shift();
			});
			draw();
		},
		clear() {
			data.forEach(d => { d.length = 0; });
			draw();
		}
	};
}

function sparkline(values, opts) {
	opts = opts || {};
	const W = 120, H = 32, n = Math.max(opts.points || values.length, 2);
	const vals = values.slice(-n), r = sparkRange(vals);
	const pts = points(vals, n, W, H, r.hi, r.lo);
	const id = 'mh-spark-g' + (++gradId);
	const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'class': 'mh-spark ' + (opts.cls || '') });
	// 面积用自上而下渐隐的填充，避免平稳的数据看起来像一块色块
	const grad = root.appendChild(svg('defs', {})).appendChild(svg('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }));
	grad.appendChild(svg('stop', { offset: 0, 'stop-opacity': 0.28 }));
	grad.appendChild(svg('stop', { offset: 1, 'stop-opacity': 0 }));
	root.appendChild(svg('path', { 'class': 'mh-spark-area', d: areaPath(pts, H), fill: 'url(#' + id + ')' }));
	root.appendChild(svg('path', { 'class': 'mh-line', d: linePath(pts), 'vector-effect': 'non-scaling-stroke' }));
	return root;
}

return baseclass.extend({ niceMax, points, sparkRange, linePath, areaPath, lineChart, sparkline });
