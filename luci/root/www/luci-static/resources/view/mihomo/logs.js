'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 日志：实时日志（控制器 /logs WebSocket）与系统日志（logread）。 */

const MAX_LINES = 1000;
const LEVELS = [ ['debug', '调试'], ['info', '信息'], ['warning', '警告'], ['error', '错误'] ];

function matches(entry, q) {
	if (!q) return true;
	q = q.toLowerCase();
	return entry.payload.toLowerCase().indexOf(q) >= 0 || entry.type.toLowerCase().indexOf(q) >= 0;
}

function clock() {
	const d = new Date();
	return [ d.getHours(), d.getMinutes(), d.getSeconds() ].map(n => (n < 10 ? '0' : '') + n).join(':');
}

return view.extend({
	matches, MAX_LINES,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.resolve();
	},

	render() {
		mui.loadCss();
		this.paused = false;
		this.pending = [];
		this.query = '';
		this.level = localStorage.getItem('mihomo.logs.level') || 'info';

		this.box = E('div', { 'class': 'mh-logbox' });
		this.sysBox = E('pre', { 'class': 'mh-logbox' });
		this.sysBox.hidden = true;

		const levelSel = E('select', { 'class': 'cbi-input-select', 'change': ev => this.setLevel(ev.target.value) },
			LEVELS.map(l => E('option', { value: l[0] }, l[1])));
		levelSel.value = this.level;
		const search = E('input', { 'class': 'cbi-input-text mh-search', type: 'search', placeholder: '搜索日志', 'input': ev => this.setQuery(ev.target.value) });
		this.pauseBtn = mui.btn('暂停', () => this.togglePause(), 'mh-btn-sm');
		this.liveTools = E('span', { 'class': 'mh-tools' }, [ levelSel, search, this.pauseBtn, mui.btn('清空', () => this.box.replaceChildren(), 'mh-btn-sm') ]);
		this.sysTools = E('span', { 'class': 'mh-tools' }, [ mui.btn('刷新', () => this.loadSystem(), 'mh-btn-sm') ]);
		this.sysTools.hidden = true;

		const tabLive = E('button', { 'class': 'mh-seg-btn active', 'click': () => this.switchTab(true) }, '实时日志');
		const tabSys = E('button', { 'class': 'mh-seg-btn', 'click': () => this.switchTab(false) }, '系统日志');
		this.tabs = [ tabLive, tabSys ];

		const root = E('div', { 'class': 'mh' }, [
			header.render(),
			mui.card(null, [
				E('div', { 'class': 'mh-toolbar' }, [ E('div', { 'class': 'mh-tabs' }, this.tabs), E('span', { 'class': 'mh-grow' }), this.liveTools, this.sysTools ]),
				this.box,
				this.sysBox
			])
		]);
		this.connect();
		return root;
	},

	connect() {
		if (this.stream) this.stream.close();
		this.stream = api.stream('/logs?level=' + this.level, d => this.add({ type: d.type || 'info', payload: String(d.payload || ''), time: clock() }));
	},

	setLevel(level) {
		this.level = level;
		localStorage.setItem('mihomo.logs.level', level);
		this.connect();
	},

	setQuery(q) {
		this.query = q;
		Array.prototype.forEach.call(this.box.children, el => { el.hidden = !matches(el._entry, q); });
	},

	togglePause() {
		this.paused = !this.paused;
		this.pauseBtn.textContent = this.paused ? '继续（' + this.pending.length + '）' : '暂停';
		if (!this.paused) {
			const list = this.pending;
			this.pending = [];
			list.forEach(e => this.add(e));
		}
	},

	add(entry) {
		if (this.paused) {
			this.pending.push(entry);
			if (this.pending.length > MAX_LINES) this.pending.shift();
			this.pauseBtn.textContent = '继续（' + this.pending.length + '）';
			return;
		}
		const box = this.box;
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		const el = E('div', { 'class': 'mh-log-row lv-' + entry.type }, [
			E('time', {}, entry.time),
			E('span', { 'class': 'mh-log-lv' }, entry.type),
			E('span', {}, entry.payload)
		]);
		el._entry = entry;
		el.hidden = !matches(entry, this.query);
		box.appendChild(el);
		while (box.children.length > MAX_LINES) box.firstChild.remove();
		if (atBottom) box.scrollTop = box.scrollHeight;
	},

	switchTab(live) {
		this.tabs[0].classList.toggle('active', live);
		this.tabs[1].classList.toggle('active', !live);
		this.box.hidden = !live;
		this.liveTools.hidden = !live;
		this.sysBox.hidden = live;
		this.sysTools.hidden = live;
		if (!live) this.loadSystem();
	},

	loadSystem() {
		this.sysBox.textContent = '读取中…';
		api.rpc.logs(500).then(r => {
			this.sysBox.textContent = r.ok ? (r.text || '（没有日志）') : r.error;
			this.sysBox.scrollTop = this.sysBox.scrollHeight;
		}, e => { this.sysBox.textContent = '读取失败：' + e.message; });
	}
});
