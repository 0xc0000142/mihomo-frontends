'use strict';
'require view';
'require mihomo.api as api';
'require mihomo.ui as mui';
'require mihomo.header as header';

/* 配置文件：直接编辑 config.yaml，保存前校验，重启失败自动回滚；备份管理。 */

function lineNumbers(text) {
	const n = text.split('\n').length;
	let out = '1';
	for (let i = 2; i <= n; i++) out += '\n' + i;
	return out;
}

// Tab / Shift+Tab：无选区时插入两个空格；多行选区整体缩进或反缩进
function indent(text, start, end, outdent) {
	if (start === end && !outdent)
		return { text: text.slice(0, start) + '  ' + text.slice(end), start: start + 2, end: start + 2 };
	const ls = text.lastIndexOf('\n', start - 1) + 1;
	const block = text.slice(ls, end);
	const lines = block.split('\n');
	const changed = lines.map(l => outdent ? l.replace(/^ {1,2}/, '') : '  ' + l).join('\n');
	const delta = changed.length - block.length;
	const firstDelta = outdent ? -(lines[0].length - lines[0].replace(/^ {1,2}/, '').length) : 2;
	return {
		text: text.slice(0, ls) + changed + text.slice(end),
		start: start === ls ? ls : Math.max(ls, start + firstDelta),
		end: end + delta
	};
}

// mihomo 的 YAML 错误形如 "yaml: line 383: did not find expected node content"
function errorLine(msg) {
	const m = /\bline (\d+)\b/.exec(msg || '');
	return m ? +m[1] : null;
}

// 第 n 行（从 1 开始）在文本中的字符范围，超出时取最后一行
function lineRange(text, n) {
	let start = 0;
	for (let i = 1; i < n; i++) {
		const next = text.indexOf('\n', start);
		if (next < 0) break;
		start = next + 1;
	}
	const end = text.indexOf('\n', start);
	return { start: start, end: end < 0 ? text.length : end };
}

return view.extend({
	lineNumbers, indent, errorLine, lineRange,

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([ api.rpc.configRead(), api.rpc.backups() ]);
	},

	render(data) {
		mui.loadCss();
		const cfg = data[0] || {}, bk = data[1] || {};
		const root = E('div', { 'class': 'mh' }, header.render());
		if (!cfg.ok) {
			root.appendChild(mui.card('配置文件', mui.empty(cfg.error || '无法读取配置文件')));
			return root;
		}
		this.saved = cfg.content;
		this.rev = cfg.rev;

		const ta = E('textarea', { 'class': 'mh-code', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
		const gutter = E('pre', { 'class': 'mh-gutter', 'aria-hidden': 'true' });
		ta.value = cfg.content;
		this.ta = ta;
		this.badge = E('span', { 'class': 'mh-badge' }, '未保存的修改');
		this.badge.hidden = true;
		this.result = E('div', { 'class': 'mh-result' });

		const undoBtn = mui.btn('撤销全部修改', () => { ta.value = this.saved; sync(); this.result.replaceChildren(); });
		const sync = () => {
			gutter.textContent = lineNumbers(ta.value);
			gutter.scrollTop = ta.scrollTop;
			this.badge.hidden = ta.value === this.saved;
			undoBtn.disabled = ta.value === this.saved;
		};
		ta.addEventListener('input', sync);
		ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
		ta.addEventListener('keydown', ev => {
			if (ev.key === 'Tab') {
				ev.preventDefault();
				const r = indent(ta.value, ta.selectionStart, ta.selectionEnd, ev.shiftKey);
				ta.value = r.text;
				ta.setSelectionRange(r.start, r.end);
				sync();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
				ev.preventDefault();
				this.save();
			}
		});
		sync();

		window.addEventListener('beforeunload', ev => {
			if (this.ta.value !== this.saved) { ev.preventDefault(); ev.returnValue = ''; }
		});

		const editor = mui.card('编辑 config.yaml', [
			E('div', { 'class': 'mh-toolbar' }, [
				mui.btn('下载当前配置', () => this.downloadCurrent()),
				E('span', { 'class': 'mh-grow' }),
				undoBtn,
				mui.btn('校验', () => this.validate()),
				mui.btn('保存并应用', () => this.save(), 'cbi-button-apply')
			]),
			E('div', { 'class': 'mh-editor' }, [ gutter, ta ]),
			this.result
		], { tools: [ this.badge, E('span', { 'class': 'mh-sub' }, 'Tab 缩进 · Ctrl+S 保存') ] });

		this.backupBox = E('div', { 'class': 'mh-scroll-x' });
		this.renderBackups(bk.list || []);
		const backups = mui.card('备份（重启型修改前自动备份，保留最近 10 份）', this.backupBox);

		root.appendChild(editor);
		root.appendChild(backups);
		return root;
	},

	showResult(ok, title, detail) {
		const line = ok ? null : errorLine(title);
		this.result.replaceChildren(
			E('p', { 'class': ok ? 'mh-ok' : 'mh-err' }, [
				title,
				line ? [ ' ', mui.btn('跳到第 ' + line + ' 行', () => this.gotoLine(line), 'mh-btn-sm') ] : ''
			]),
			detail ? E('details', {}, [ E('summary', {}, '完整输出'), E('pre', { 'class': 'mh-pre' }, detail) ]) : ''
		);
	},

	gotoLine(n) {
		const ta = this.ta, r = lineRange(ta.value, n);
		ta.focus();
		ta.setSelectionRange(r.start, r.end);
		const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
		ta.scrollTop = Math.max(0, (n - 6) * lh);
	},

	validate() {
		this.result.replaceChildren(E('p', { 'class': 'mh-sub' }, '校验中…'));
		return api.rpc.validate(this.ta.value).then(r => {
			if (!r.ok) return this.showResult(false, r.error);
			if (r.valid) this.showResult(true, '校验通过');
			else this.showResult(false, '校验失败：' + r.error, r.detail);
		}, e => this.showResult(false, '校验请求失败：' + e.message));
	},

	save() {
		if (this.ta.value === this.saved) {
			mui.notify('没有修改');
			return;
		}
		this.result.replaceChildren();
		mui.runJob(api.rpc.saveRaw(this.ta.value, this.rev)).then(s => {
			if (s.state === 'failed' && s.error && s.error.indexOf('校验失败') === 0)
				this.showResult(false, s.error, s.detail);
			if (s.state !== 'failed') this.reload(s.state === 'done');
		});
	},

	// 保存成功（fromDisk）时用磁盘上的内容刷新编辑器；回滚时保留编辑内容，方便修改后重试
	reload(fromDisk) {
		return Promise.all([ api.rpc.configRead(), api.rpc.backups() ]).then(([ cfg, bk ]) => {
			if (cfg.ok) {
				this.saved = cfg.content;
				this.rev = cfg.rev;
				if (fromDisk) this.ta.value = cfg.content;
				this.ta.dispatchEvent(new Event('input'));
			}
			this.renderBackups(bk.list || []);
		});
	},

	downloadCurrent() {
		api.rpc.configRead().then(r => {
			if (r.ok) mui.download('config.yaml', r.content);
			else mui.notify(r.error, 'error');
		});
	},

	renderBackups(list) {
		if (!list.length) {
			this.backupBox.replaceChildren(mui.empty('还没有备份'));
			return;
		}
		this.backupBox.replaceChildren(E('table', { 'class': 'mh-table' }, [
			E('tr', {}, [ E('th', {}, '时间'), E('th', {}, '大小'), E('th', {}, '') ]),
			...list.map(b => E('tr', {}, [
				E('td', {}, mui.fmtDate(b.time)),
				E('td', {}, mui.fmtBytes(b.size)),
				E('td', { 'class': 'mh-actions' }, [
					mui.btn('恢复', () => this.restore(b), 'mh-btn-sm'), ' ',
					mui.btn('下载', () => this.downloadBackup(b), 'mh-btn-sm'), ' ',
					mui.btn('删除', () => this.removeBackup(b), 'mh-btn-sm cbi-button-negative')
				])
			]))
		]));
	},

	restore(b) {
		mui.confirm('恢复备份', '用 ' + mui.fmtDate(b.time) + ' 的备份替换当前配置并重启服务？当前配置会先自动备份。', '恢复').then(yes => {
			if (!yes) return;
			mui.runJob(api.rpc.backupRestore(b.name)).then(s => { if (s.state !== 'failed') this.reload(true); });
		});
	},

	downloadBackup(b) {
		api.rpc.backupRead(b.name).then(r => {
			if (r.ok) mui.download(b.name, r.content);
			else mui.notify(r.error, 'error');
		});
	},

	removeBackup(b) {
		mui.confirm('删除备份', '删除 ' + mui.fmtDate(b.time) + ' 的备份？', '删除', true).then(yes => {
			if (!yes) return;
			api.rpc.backupDelete(b.name).then(r => {
				if (!r.ok) mui.notify(r.error, 'error');
				return api.rpc.backups().then(bk => this.renderBackups(bk.list || []));
			});
		});
	}
});
