'use strict';
'require baseclass';
'require ui';
'require mihomo.api as api';
'require mihomo.ui as mui';

/* 内核卡片：当前版本、架构、下载线路，以及检查更新、安装/更新、回滚。内核页与向导共用。 */

const STEPS = {
	queued: '排队中',
	check: '获取最新版本',
	download: '下载内核',
	verify: '校验 sha256',
	unpack: '解压',
	selftest: '试运行新内核',
	validate: '用新内核校验当前配置',
	replace: '替换内核文件',
	restart: '重启服务并等待恢复',
	rollback: '启动失败，正在恢复旧版本',
	done: '完成'
};

function mirrorHost(m) {
	const r = /^https?:\/\/([^/]+)/i.exec(m || '');
	return r ? r[1] : '';
}

// 与后端 core.uc 的 routes() 一致：服务运行时先经本机代理，再走镜像（没有镜像时直连）
function describeRoute(settings, running) {
	const host = mirrorHost(settings && settings.mirror);
	const tail = host ? '镜像 ' + host : '直连 GitHub';
	return running ? '本机代理 → ' + tail : tail;
}

function stepLabel(step) {
	return STEPS[step] || step;
}

// 由 core_info 的结果得出按钮与提示：primary 是主按钮（安装 / 更新 / 重新安装），force 表示即使版本相同也重新下载
function updateState(info) {
	const off = (hint) => ({
		ok: false, installed: false, version: null, latest: null, outdated: false,
		primary: { label: '更新内核', enabled: false, force: false },
		canCheck: false, canRollback: false, rollbackTo: null, hint: hint, hintCls: 'mh-err'
	});
	if (!info || !info.ok) return off((info && info.error) || '无法读取内核信息');
	if (!info.asset) {
		const st = off('该架构（' + (info.arch || '未知') + '）没有 eBPF 构建，无法自动安装内核');
		st.ok = true;
		st.installed = !!info.installed;
		st.version = info.version || null;
		return st;
	}
	const latest = (info.latest && info.latest.version) || null;
	const st = {
		ok: true, installed: !!info.installed, version: info.version || null, latest: latest, outdated: false,
		canCheck: true, canRollback: !!(info.installed && info.prev_version), rollbackTo: info.prev_version || null
	};
	if (!info.installed)
		return Object.assign(st, { primary: { label: '下载并安装', enabled: true, force: false }, hint: '尚未安装内核', hintCls: 'mh-warn' });
	if (!latest)
		return Object.assign(st, { primary: { label: '更新内核', enabled: true, force: false }, hint: '尚未检查更新', hintCls: '' });
	if (latest !== info.version)
		return Object.assign(st, { outdated: true, primary: { label: '更新到 ' + latest, enabled: true, force: false }, hint: '有新版本 ' + latest, hintCls: 'mh-warn' });
	return Object.assign(st, { primary: { label: '重新安装', enabled: true, force: true }, hint: '已是最新版本', hintCls: 'mh-ok' });
}

// 任务成功后的提示文字；kind 为 core 或 core_rollback
function resultText(s, kind) {
	if (kind === 'core_rollback')
		return '已切换到 ' + s.version + (s.restarted ? '；服务已重启' : '');
	if (s.note === '已是最新版本')
		return '已是最新版本（' + s.version + '）';
	const parts = [ (s.note === '内核已安装' ? '内核已安装：' : '内核已更新到 ') + s.version ];
	if (s.restarted) parts.push('服务已按新内核重启');
	if (s.note && s.note !== '内核已安装') parts.push(s.note);
	return parts.join('；');
}

const BADGE = { 'mh-ok': 'ok', 'mh-warn': 'warn', 'mh-err': 'err', '': 'muted' };

// opts.title：卡片标题；opts.onChange(info)：每次读取内核信息后回调
function create(opts) {
	opts = opts || {};
	let info = null;
	const body = E('div', { 'class': 'mh-core-body' }, mui.empty('读取中…'));
	const btnCheck = mui.btn('检查更新', () => check(), 'mh-btn-sm');
	const btnBack = mui.btn('回滚', () => rollback(), 'mh-btn-sm');
	const btnMain = mui.btn('更新内核', () => update(), 'mh-btn-sm cbi-button-action');
	btnBack.hidden = true;
	[ btnCheck, btnBack, btnMain ].forEach(b => { b.disabled = true; });
	const el = mui.card(opts.title || '内核', [ body, E('div', { 'class': 'mh-actions' }, [ btnCheck, btnBack, btnMain ]) ], { cls: 'mh-core' });

	function draw() {
		const st = updateState(info);
		btnCheck.disabled = !st.canCheck;
		btnMain.textContent = st.primary.label;
		btnMain.disabled = !st.primary.enabled;
		btnBack.hidden = !st.canRollback;
		btnBack.disabled = !st.canRollback;
		btnBack.textContent = '回滚到 ' + (st.rollbackTo || '');
		if (!info || !info.ok) {
			body.replaceChildren(mui.empty(st.hint));
			return;
		}
		const s = info.settings || {};
		const latest = info.latest;
		body.replaceChildren(
			E('div', { 'class': 'mh-core-hero' }, [
				E('div', { 'class': 'mh-core-ver' }, [
					E('div', { 'class': 'mh-kpi-label' }, '当前版本'),
					E('div', { 'class': 'mh-big mh-ellipsis', title: info.version || '' }, info.version || '未安装')
				]),
				E('span', { 'class': 'mh-badge ' + BADGE[st.hintCls] }, st.hint)
			]),
			mui.row('架构', (info.arch || '-') + ' · ' + (info.asset || '不支持')),
			mui.row('最新版本', latest && latest.version ? latest.version + ' · 检查于 ' + mui.fmtAgo(latest.checked) : '未检查'),
			mui.row('上一版本', info.prev_version || '无'),
			mui.row('发布源', (s.repo || '-') + ' @ ' + (s.tag || '-')),
			mui.row('下载线路', describeRoute(s, info.running)),
			info.free_kb != null ? mui.row('可用空间', mui.fmtBytes(info.free_kb * 1024)) : ''
		);
	}

	function refresh() {
		return api.rpc.coreInfo().then(i => { info = i; }, e => { info = { ok: false, error: '无法读取内核信息：' + e.message }; }).then(() => {
			draw();
			if (opts.onChange) opts.onChange(info);
			return info;
		});
	}

	function check() {
		btnCheck.disabled = true;
		btnCheck.textContent = '检查中…';
		api.rpc.coreCheck().then(r => {
			if (!r || !r.ok) throw new Error((r && r.error) || '未知错误');
			mui.notify(r.update_available ? '有新版本 ' + r.latest + '（经' + r.route + '获取）' : '已是最新版本 ' + r.latest);
		}).catch(e => mui.notify('检查更新失败：' + e.message, 'error')).then(() => {
			btnCheck.textContent = '检查更新';
			return refresh();
		});
	}

	function update() {
		const st = updateState(info);
		const text = info.running
			? '将下载新内核并校验 sha256，替换后重启服务，期间网络会中断几秒；新内核启动失败时自动恢复旧版本。继续？'
			: '将下载内核并校验 sha256。继续？';
		mui.confirm(st.primary.label, text, '继续').then(yes => {
			if (!yes) return;
			return mui.runJob(api.rpc.coreUpdate(st.primary.force), {
				title: st.primary.label, steps: STEPS, success: s => resultText(s, 'core'), failTitle: '内核更新失败'
			}).then(() => refresh());
		});
	}

	function rollback() {
		const st = updateState(info);
		const text = '将切换回 ' + st.rollbackTo + '，当前版本保留为可回滚的版本' + (info.running ? '，服务会重启' : '') + '。继续？';
		mui.confirm('回滚内核', text, '回滚').then(yes => {
			if (!yes) return;
			return mui.runJob(api.rpc.coreRollback(), {
				title: '回滚内核', steps: STEPS, success: s => resultText(s, 'core_rollback'), failTitle: '回滚失败'
			}).then(() => refresh());
		});
	}

	return { el: el, refresh: refresh, info: () => info };
}

return baseclass.extend({
	STEPS, describeRoute, stepLabel, updateState, resultText, create
});
