'use strict';
/* mihomo KSU WebUI：无依赖单文件 SPA。通过 ksu.exec 调模块内 shell 脚本，通过内核 external-controller REST 管节点/连接。 */

/* ---------- KSU exec 封装 ---------- */

let _cbSeq = 0;
const _cbs = {};

// KSU WebUI 按我们传入的名字回调全局函数；每个回调名动态挂到 window 上。
function exec(command) {
  const cbName = '__mihomo_cb_' + (++_cbSeq);
  return new Promise((resolve) => {
    _cbs[cbName] = resolve;
    window[cbName] = function (data) {
      delete _cbs[cbName];
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      resolve(data);
    };
    setTimeout(() => {
      if (_cbs[cbName]) {
        delete _cbs[cbName];
        resolve({ errno: -1, stdout: '', stderr: '回调超时（未在 KernelSU WebUI 中运行？）' });
      }
    }, 600000);
    try {
      if (typeof ksu === 'undefined' || !ksu.exec) {
        delete _cbs[cbName];
        resolve({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：请在 KernelSU/Magisk WebUI 中打开' });
        return;
      }
      ksu.exec(command, '{}', cbName);
    } catch (e) {
      delete _cbs[cbName];
      resolve({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：' + e.message });
    }
  });
}

const MODDIR = '/data/adb/modules/mihomo-ebpf';
const SH = 'sh ' + MODDIR + '/scripts/';
const DATA = '/data/adb/mihomo';
const CONFIG = DATA + '/config.yaml';

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- 后端操作 ---------- */

async function sh(cmd) {
  const r = await exec(cmd);
  return r;
}

async function shJson(cmd) {
  const r = await exec(cmd);
  try {
    return JSON.parse(r.stdout.trim());
  } catch (e) {
    return { ok: false, error: r.stderr || ('输出不是 JSON：' + r.stdout.slice(0, 200)) };
  }
}

const api = {
  status:      () => shJson(SH + 'mihomo.sh status'),
  service:     (a) => shJson(SH + 'mihomo.sh ' + a + ' >/dev/null 2>&1; echo "{\\"ok\\":true}"'),
  svcText:     (a) => sh(SH + 'mihomo.sh ' + a),
  coreInfo:    () => shJson(SH + 'core.sh info'),
  coreGetSet:  () => shJson(SH + 'core.sh get_settings'),
  coreSet:     (repo, tag, mirror) => shJson(SH + 'core.sh settings ' + shq(repo || '-') + ' ' + shq(tag || '-') + ' ' + shq(mirror || '-')),
  coreUpdate:  () => shJson(SH + 'core.sh download'),
  coreRollback:() => shJson(SH + 'core.sh rollback'),
  configRead:  async () => {
    const r = await exec('base64 -w 0 ' + shq(CONFIG) + ' 2>/dev/null || base64 ' + shq(CONFIG) + ' | tr -d "\\n"');
    if (r.errno !== 0 || !r.stdout.trim()) return { ok: false, error: '读取配置失败（文件不存在？）' };
    return { ok: true, content: b64decode(r.stdout.trim()) };
  },
  validate:    async (content) => {
    const r = await exec('tmp=$(mktemp) && printf %s ' + shq(b64encode(content)) + ' | base64 -d > $tmp && /data/adb/mihomo/mihomo -d ' + shq(DATA) + ' -f $tmp -t 2>&1; c=$?; rm -f $tmp; echo "EXIT:$c"');
    const m = /EXIT:(\d+)/.exec(r.stdout);
    const code = m ? +m[1] : r.errno;
    const out = r.stdout.replace(/EXIT:\d+/, '').trim();
    return { ok: code === 0, error: code === 0 ? null : out.split('\n').slice(-5).join('\n') };
  },
  apply:       (content, restart) => shJson(SH + 'apply.sh ' + shq(b64encode(content)) + (restart ? ' restart' : '')),
  backups:     () => shJson(SH + 'backup.sh list'),
  backupRead:  async (name) => {
    const r = await exec(SH + 'backup.sh read ' + shq(name));
    if (!r.stdout.trim() || r.stdout.includes('"ok":false')) return { ok: false, error: '读取失败' };
    return { ok: true, content: b64decode(r.stdout.trim()) };
  },
  backupDel:   (name) => shJson(SH + 'backup.sh delete ' + shq(name)),
  backupRestore: (name) => shJson(SH + 'backup.sh restore ' + shq(name)),
  logs:        (lines) => sh('tail -n ' + (lines || 200) + ' ' + shq(DATA + '/run/mihomo.log') + ' 2>/dev/null; logcat -d -s mihomo:* 2>/dev/null | tail -n 50'),
  getAutostart: async () => {
    const r = await exec('cat ' + shq(DATA + '/settings.ini') + ' 2>/dev/null');
    return /(^|\n)autostart=1/.test(r.stdout);
  },
};

/* ---------- mihomo 控制器 REST ---------- */

let controller = { addr: null, secret: '' };

async function detectController() {
  const r = await exec('grep -E "^(external-controller|secret):" ' + shq(CONFIG) + ' 2>/dev/null');
  let addr = null, secret = '';
  r.stdout.split('\n').forEach((line) => {
    let m = /^external-controller:\s*"?([^"\s]+)/.exec(line);
    if (m) addr = m[1];
    m = /^secret:\s*"?([^"\s]*)/.exec(line);
    if (m) secret = m[1];
  });
  if (addr) {
    if (addr.startsWith('0.0.0.0')) addr = '127.0.0.1' + addr.slice(7);
    controller = { addr: 'http://' + addr, secret };
  } else {
    controller = { addr: null, secret: '' };
  }
  return controller;
}

async function ctl(path, opts) {
  if (!controller.addr) throw new Error('配置中没有 external-controller');
  const res = await fetch(controller.addr + path, {
    method: (opts && opts.method) || 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + controller.secret }, (opts && opts.headers) || {}),
    body: opts && opts.body,
  });
  if (!res.ok) throw new Error('控制器 ' + res.status);
  return res.json();
}

/* ---------- 小组件 ---------- */

const view = document.getElementById('view');

function h(html) {
  view.innerHTML = html;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
}

function loading(msg) {
  h('<p class="dim" style="margin-top:20px"><span class="spin"></span> ' + esc(msg || '加载中…') + '</p>');
}

function fmtBytes(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtUptime(s) {
  if (s == null) return '-';
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return (d ? d + '天 ' : '') + (hh ? hh + '时 ' : '') + mm + '分';
}

async function refreshHeader() {
  const [st, ci] = await Promise.all([api.status(), api.coreInfo()]);
  const pill = document.getElementById('svc-pill');
  const ver = document.getElementById('ver-pill');
  if (st.ok && st.running) {
    pill.textContent = '运行中'; pill.className = 'pill on';
  } else {
    pill.textContent = '已停止'; pill.className = 'pill off';
  }
  ver.textContent = (ci.ok && ci.installed) ? ci.version : '未安装内核';
}

/* ---------- 页面 ---------- */

const routes = [
  { path: 'overview', name: '概览', render: renderOverview },
  { path: 'proxies', name: '代理', render: renderProxies },
  { path: 'connections', name: '连接', render: renderConnections },
  { path: 'config', name: '配置', render: renderConfig },
  { path: 'backups', name: '备份', render: renderBackups },
  { path: 'core', name: '内核', render: renderCore },
  { path: 'setup', name: '向导', render: renderSetup },
  { path: 'logs', name: '日志', render: renderLogs },
];

/* --- 概览 --- */
async function renderOverview() {
  loading();
  const [st, ci, auto] = await Promise.all([api.status(), api.coreInfo(), api.getAutostart()]);
  let ctlHtml = '';
  try {
    await detectController();
    const v = await ctl('/version');
    const traffic = await ctl('/traffic').catch(() => null);
    ctlHtml =
      '<div class="row"><span class="dim">控制器</span><span>' + esc(controller.addr) + '</span></div>' +
      '<div class="row"><span class="dim">内核版本</span><span>' + esc(v.version || '-') + '</span></div>';
  } catch (e) {
    ctlHtml = '<div class="row"><span class="dim">控制器</span><span class="dim">不可用（' + esc(e.message) + '）</span></div>';
  }
  h(
    '<div class="card"><h2>服务</h2>' +
      '<div class="row"><span class="dim">状态</span><span>' + (st.running ? '运行中（pid ' + st.pid + '）' : '已停止') + '</span></div>' +
      (st.running ? '<div class="row"><span class="dim">内存</span><span>' + fmtBytes((st.rss_kb || 0) * 1024) + '</span><span class="dim">运行时长</span><span>' + fmtUptime(st.uptime) + '</span></div>' : '') +
      '<div class="row"><span class="dim">开机自启</span><span>' + (auto ? '开' : '关') + '</span></div>' +
      '<div class="row">' +
        (st.running
          ? '<button data-a="restart">重启</button><button data-a="stop" class="danger">停止</button>'
          : '<button data-a="start" class="primary">启动</button>') +
        '<button data-a="toggle-auto">' + (auto ? '关闭自启' : '开启自启') + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="card"><h2>内核</h2>' +
      '<div class="row"><span class="dim">已安装</span><span>' + (ci.installed ? esc(ci.version) : '未安装（去「内核」页下载）') + '</span></div>' +
      ctlHtml +
    '</div>' +
    '<div class="card"><h2>快捷入口</h2><div class="row">' +
      '<button data-go="setup">设置向导</button><button data-go="proxies">代理</button><button data-go="config">配置文件</button><button data-go="logs">日志</button>' +
    '</div></div>'
  );
  view.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      const a = b.dataset.a;
      if (a === 'toggle-auto') {
        await api.svcText(auto ? 'disable' : 'enable');
      } else {
        const r = await api.svcText(a);
        if (a !== 'stop') toast(r.stdout.trim() || r.stderr.trim(), r.errno === 0 ? 'ok' : 'err');
      }
      renderOverview();
      refreshHeader();
    };
  });
}

/* --- 代理 --- */
async function renderProxies() {
  loading();
  await detectController();
  let data;
  try {
    data = await ctl('/proxies');
  } catch (e) {
    h('<div class="card"><p class="dim">无法连接控制器：' + esc(e.message) + '。请确认服务已启动且配置含 external-controller。</p></div>');
    return;
  }
  const groups = Object.values(data.proxies || {}).filter((p) => ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Smart'].includes(p.type));
  const groupsHtml = groups.map((g) => {
    const opts = (g.all || []).map((n) => {
      const sel = n === g.now ? ' sel' : '';
      return '<span class="chip' + sel + '" data-g="' + esc(g.name) + '" data-n="' + esc(n) + '">' + esc(n) + '</span>';
    }).join('');
    return '<div class="card"><h2>' + esc(g.name) + ' <span class="dim" style="font-weight:400">' + esc(g.type) + '</span></h2><div class="chips">' + opts + '</div></div>';
  }).join('');
  h(groupsHtml || '<div class="card"><p class="dim">没有可选择的策略组</p></div>');
  view.querySelectorAll('.chip').forEach((c) => {
    c.onclick = async () => {
      try {
        await ctl('/proxies/' + encodeURIComponent(c.dataset.g), { method: 'PUT', body: JSON.stringify({ name: c.dataset.n }) });
        renderProxies();
      } catch (e) {
        toast('切换失败：' + e.message, 'err');
      }
    };
  });
}

/* --- 连接 --- */
async function renderConnections() {
  loading();
  await detectController();
  let data;
  try {
    data = await ctl('/connections');
  } catch (e) {
    h('<div class="card"><p class="dim">无法连接控制器：' + esc(e.message) + '</p></div>');
    return;
  }
  const rows = (data.connections || []).slice(-200).reverse().map((c) => {
    const meta = c.metadata || {};
    const host = meta.host || meta.destinationIP || '';
    return '<tr><td>' + esc(meta.network || '') + '</td><td style="word-break:break-all">' + esc(host) + ':' + esc(meta.destinationPort || '') +
      '<div class="dim">' + esc(meta.sourceIP || '') + '</div></td>' +
      '<td style="word-break:break-all">' + esc((c.chains || []).join(' ← ')) + '</td>' +
      '<td>↑' + fmtBytes(c.upload) + '<br>↓' + fmtBytes(c.download) + '</td>' +
      '<td><button data-id="' + esc(c.id) + '">断</button></td></tr>';
  }).join('');
  h('<div class="card"><h2>活动连接（' + (data.connections || []).length + '）' +
    ' <button id="close-all" class="danger" style="float:right">全部断开</button></h2>' +
    '<div style="overflow-x:auto"><table class="list"><tr><th>协议</th><th>目标</th><th>链</th><th>流量</th><th></th></tr>' + rows + '</table></div></div>');
  view.querySelectorAll('[data-id]').forEach((b) => {
    b.onclick = async () => {
      await ctl('/connections/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }).catch(() => {});
      b.closest('tr').remove();
    };
  });
  document.getElementById('close-all').onclick = async () => {
    await ctl('/connections', { method: 'DELETE' }).catch(() => {});
    renderConnections();
  };
}

/* --- 配置文件 --- */
async function renderConfig() {
  loading();
  const r = await api.configRead();
  const content = r.ok ? r.content : '';
  h(
    '<div class="card"><h2>配置文件（' + esc(CONFIG) + '）</h2>' +
      (r.ok ? '' : '<p class="dim">' + esc(r.error) + '，可在此新建。</p>') +
      '<textarea id="cfg" class="mono" spellcheck="false">' + esc(content) + '</textarea>' +
      '<div class="row" style="margin-top:10px">' +
        '<button id="v">校验</button>' +
        '<button id="s" class="primary">保存并重启</button>' +
        '<button id="s2">仅保存</button>' +
      '</div><pre id="out" class="mono" style="display:none;margin-top:10px"></pre></div>'
  );
  const ta = document.getElementById('cfg');
  const out = document.getElementById('out');
  document.getElementById('v').onclick = async () => {
    out.style.display = 'block'; out.textContent = '校验中…';
    const vr = await api.validate(ta.value);
    out.textContent = vr.ok ? '✓ 配置有效' : '✗ ' + vr.error;
  };
  const save = async (restart) => {
    out.style.display = 'block'; out.textContent = '保存中…';
    const ar = await api.apply(ta.value, restart);
    if (ar.ok) {
      out.textContent = '✓ 已保存' + (restart ? '并重启' : '');
      toast('已保存', 'ok');
      refreshHeader();
    } else {
      out.textContent = '✗ ' + (ar.error || '保存失败');
    }
  };
  document.getElementById('s').onclick = () => save(true);
  document.getElementById('s2').onclick = () => save(false);
}

/* --- 备份 --- */
async function renderBackups() {
  loading();
  const r = await api.backups();
  const list = (r.ok && r.list) || [];
  const rows = list.map((b) =>
    '<tr><td>' + esc(b.name) + '</td><td>' + fmtBytes(b.size) + '</td><td class="row">' +
    '<button data-restore="' + esc(b.name) + '">恢复</button>' +
    '<button data-del="' + esc(b.name) + '" class="danger">删除</button></td></tr>'
  ).join('');
  h('<div class="card"><h2>配置备份（保留最近 10 份）</h2>' +
    (rows ? '<table class="list"><tr><th>名称</th><th>大小</th><th></th></tr>' + rows + '</table>' : '<p class="dim">暂无备份</p>') +
    '</div>');
  view.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('恢复到 ' + b.dataset.restore + '？当前配置会先备份。')) return;
      const r2 = await api.backupRestore(b.dataset.restore);
      toast(r2.ok ? '已恢复' : (r2.error || '恢复失败'), r2.ok ? 'ok' : 'err');
      refreshHeader();
    };
  });
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      await api.backupDel(b.dataset.del);
      renderBackups();
    };
  });
}

/* --- 内核 --- */
async function renderCore() {
  loading();
  const [info, set] = await Promise.all([api.coreInfo(), api.coreGetSet()]);
  h(
    '<div class="card"><h2>当前内核</h2>' +
      '<div class="row"><span class="dim">状态</span><span>' + (info.installed ? '已安装' : '未安装') + '</span></div>' +
      (info.installed ? '<div class="row"><span class="dim">版本</span><span>' + esc(info.version) + '</span></div>' : '') +
      '<div class="row"><button id="upd" class="primary">' + (info.installed ? '检查并更新' : '下载内核') + '</button>' +
      (info.can_rollback ? '<button id="rb">回滚到上一版本</button>' : '') +
      '</div><pre id="cout" class="mono" style="display:none;margin-top:10px"></pre></div>' +
    '<div class="card"><h2>下载设置</h2>' +
      '<label class="field">GitHub 仓库<input id="repo" type="text" value="' + esc(set.repo || 'liuran001/mihomo') + '"></label>' +
      '<label class="field">版本标签（留空 = latest）<input id="tag" type="text" value="' + esc(set.tag || '') + '"></label>' +
      '<label class="field">镜像前缀（可空，如 https://ghproxy.net/）<input id="mirror" type="text" value="' + esc(set.mirror || '') + '"></label>' +
      '<div class="row" style="margin-top:10px"><button id="saveset">保存设置</button></div></div>'
  );
  const out = document.getElementById('cout');
  document.getElementById('upd').onclick = async () => {
    out.style.display = 'block'; out.textContent = '下载中（可能需几分钟）…';
    const r = await api.coreUpdate();
    out.textContent = r.ok ? '✓ 已安装 ' + (r.version || r.tag || '') : '✗ ' + (r.error || '下载失败');
    if (r.ok) { toast('内核已更新，重启服务后生效', 'ok'); refreshHeader(); }
  };
  const rb = document.getElementById('rb');
  if (rb) rb.onclick = async () => {
    const r = await api.coreRollback();
    toast(r.ok ? '已回滚' : (r.error || '回滚失败'), r.ok ? 'ok' : 'err');
    renderCore();
  };
  document.getElementById('saveset').onclick = async () => {
    const r = await api.coreSet(
      document.getElementById('repo').value.trim(),
      document.getElementById('tag').value.trim(),
      document.getElementById('mirror').value.trim()
    );
    toast(r.ok ? '已保存' : '保存失败', r.ok ? 'ok' : 'err');
  };
}

/* --- 设置向导（前端渲染模板） --- */

function renderTemplate(tpl, subs, lanIfs, secret, uiUrl, fipUrl) {
  const lines = tpl.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '#@providers') {
      subs.forEach((s) => {
        out.push('  ' + JSON.stringify(s.name) + ':');
        out.push('    <<: *p');
        out.push('    url: ' + JSON.stringify(s.url));
        if (s.ua) out.push('    header: {User-Agent: [' + JSON.stringify(s.ua) + ']}');
        out.push('    path: ./providers/' + JSON.stringify(s.name + '.yaml'));
      });
    } else if (t === '#@use') {
      subs.forEach((s) => out.push('    - ' + JSON.stringify(s.name)));
    } else if (t === '#@secret') {
      if (secret) out.push('secret: ' + JSON.stringify(secret));
    } else if (t === '#@ui-url') {
      if (uiUrl) out.push('external-ui-url: ' + JSON.stringify(uiUrl));
    } else if (t === '#@fake-ip-filter-url') {
      out.push('    url: ' + JSON.stringify(fipUrl));
    } else if (t === '#@lan') {
      out.push('      interface-name: [' + lanIfs.map((x) => JSON.stringify(x)).join(', ') + ']');
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

async function renderSetup() {
  loading();
  let tpl = '';
  try {
    tpl = await (await fetch('template.yaml')).text();
  } catch (e) {
    h('<div class="card"><p class="dim">模板加载失败：' + esc(e.message) + '</p></div>');
    return;
  }
  const subRows = [0].map(() =>
    '<div class="sub-item"><input name="sname" type="text" placeholder="名称" value="订阅1">' +
    '<input name="surl" type="text" class="grow" placeholder="https://…">' +
    '<input name="sua" type="text" placeholder="UA（可空）">' +
    '<button data-del type="button">✕</button></div>'
  ).join('');
  h(
    '<div class="card"><h2>设置向导</h2>' +
      '<p class="dim">用内置模板生成配置：eBPF hybrid 透明代理 + Smart 策略组 + zashboard 面板。生成后可在「配置」页继续修改。</p></div>' +
    '<div class="card"><h2>1. 内核</h2><div id="core-state" class="dim">检查中…</div></div>' +
    '<div class="card"><h2>2. 订阅</h2><div id="subs">' + subRows + '</div>' +
      '<div class="row" style="margin-top:10px"><button id="add-sub">+ 添加订阅</button></div></div>' +
    '<div class="card"><h2>3. 选项</h2>' +
      '<label class="field">面板密钥（留空自动生成）<input id="secret" type="text"></label>' +
      '<label class="field">下联接口（逗号分隔，热点一般是 ap0；不需要填 wlan0）<input id="lan" type="text" value="ap0"></label>' +
      '<label class="field">面板地址<input id="uiurl" type="text" value="https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip"></label>' +
      '<div class="row" style="margin-top:10px">' +
        '<button id="gen" class="primary">生成配置并启动</button>' +
        '<button id="genonly">仅生成配置</button>' +
      '</div><pre id="sout" class="mono" style="display:none;margin-top:10px"></pre></div>'
  );

  api.coreInfo().then((ci) => {
    const el = document.getElementById('core-state');
    if (ci.installed) {
      el.innerHTML = '✓ 已安装 ' + esc(ci.version);
    } else {
      el.innerHTML = '未安装内核。<button id="dl">现在下载</button>';
      document.getElementById('dl').onclick = async () => {
        el.textContent = '下载中…';
        const r = await api.coreUpdate();
        el.textContent = r.ok ? ('✓ 已安装 ' + (r.version || '')) : ('下载失败：' + (r.error || ''));
        refreshHeader();
      };
    }
  });

  const subsEl = document.getElementById('subs');
  subsEl.addEventListener('click', (e) => {
    if (e.target.dataset.del !== undefined && subsEl.children.length > 1) {
      e.target.closest('.sub-item').remove();
    }
  });
  document.getElementById('add-sub').onclick = () => {
    const n = subsEl.children.length + 1;
    const div = document.createElement('div');
    div.className = 'sub-item';
    div.innerHTML = '<input name="sname" type="text" placeholder="名称" value="订阅' + n + '">' +
      '<input name="surl" type="text" class="grow" placeholder="https://…">' +
      '<input name="sua" type="text" placeholder="UA（可空）">' +
      '<button data-del type="button">✕</button>';
    subsEl.appendChild(div);
  };

  const gen = async (start) => {
    const subs = [];
    let err = null;
    subsEl.querySelectorAll('.sub-item').forEach((it) => {
      const name = it.querySelector('[name=sname]').value.trim();
      const url = it.querySelector('[name=surl]').value.trim();
      const ua = it.querySelector('[name=sua]').value.trim();
      if (!name || !url) { err = '订阅名称与地址不能为空'; return; }
      if (!/^https?:\/\//.test(url)) { err = '订阅地址需要 http:// 或 https:// 开头'; return; }
      subs.push({ name, url, ua: ua || null });
    });
    const sout = document.getElementById('sout');
    sout.style.display = 'block';
    if (err) { sout.textContent = '✗ ' + err; return; }
    let secret = document.getElementById('secret').value.trim();
    if (!secret) {
      secret = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('');
      document.getElementById('secret').value = secret;
    }
    const lan = document.getElementById('lan').value.split(',').map((s) => s.trim()).filter(Boolean);
    const uiUrl = document.getElementById('uiurl').value.trim();
    const fipUrl = 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs';
    const content = renderTemplate(tpl, subs, lan.length ? lan : ['ap0'], secret, uiUrl, fipUrl);
    sout.textContent = '校验中…';
    const hasCore = (await api.coreInfo()).installed;
    if (hasCore) {
      const v = await api.validate(content);
      if (!v.ok) { sout.textContent = '✗ 校验失败：\n' + v.error; return; }
    }
    sout.textContent = '保存中…';
    const r = await api.apply(content, start);
    if (r.ok) {
      sout.textContent = '✓ 配置已生成' + (start ? '，服务已启动。面板密钥：' + secret : '');
      toast('完成', 'ok');
      refreshHeader();
    } else {
      sout.textContent = '✗ ' + (r.error || '保存失败');
    }
  };
  document.getElementById('gen').onclick = () => gen(true);
  document.getElementById('genonly').onclick = () => gen(false);
}

/* --- 日志 --- */
async function renderLogs() {
  loading();
  const r = await api.logs(300);
  h('<div class="card"><h2>日志</h2><div class="row"><button id="re">刷新</button></div>' +
    '<pre class="mono" style="margin-top:10px">' + esc(r.stdout || r.stderr || '（无日志）') + '</pre></div>');
  document.getElementById('re').onclick = renderLogs;
}

/* ---------- 路由 ---------- */

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  return routes.find((r) => r.path === hash) || routes[0];
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.innerHTML = routes.map((r) =>
    '<a href="#/' + r.path + '" data-p="' + r.path + '">' + r.name + '</a>'
  ).join('');
}

function route() {
  const r = currentRoute();
  document.querySelectorAll('nav.tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.p === r.path);
  });
  r.render();
}

document.getElementById('btn-refresh').onclick = () => { route(); refreshHeader(); };
window.addEventListener('hashchange', route);

document.addEventListener('click', (e) => {
  const g = e.target.dataset && e.target.dataset.go;
  if (g) location.hash = '#/' + g;
});

renderTabs();
route();
refreshHeader();
