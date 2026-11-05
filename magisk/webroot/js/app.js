function getAttr(el, name) {
  if (!el) return '';
  if (typeof el.getAttribute === 'function') return el.getAttribute(name) || '';
  if (el.attributes && el.attributes[name] != null) return el.attributes[name];
  if (el.dataset) {
    if (name.startsWith('data-')) {
      const raw = name.slice(5);
      const camel = raw.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      return el.dataset[camel] || el.dataset[raw] || '';
    }
    return el.dataset[name] || '';
  }
  return '';
}

'use strict';
/* mihomo KSU WebUI：无依赖单文件 SPA。通过 ksu.exec 调模块内 shell 脚本，通过内核 external-controller REST 管节点/连接。 */

/* ---------- KSU exec 封装 ---------- */

let _cbSeq = 0;
const _cbs = {};

// KSU WebUI 按我们传入的名字回调全局函数；每个回调名动态挂到 window 上。
function exec(command, timeout = 30000) {
  const cbName = '__mihomo_cb_' + (++_cbSeq);
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete _cbs[cbName];
      delete window[cbName];
      resolve(result);
    };
    _cbs[cbName] = finish;
    window[cbName] = (errno, stdout, stderr) => finish({
      errno: Number.isFinite(Number(errno)) ? Number(errno) : -1,
      stdout: String(stdout == null ? '' : stdout),
      stderr: String(stderr == null ? '' : stderr),
    });
    timer = setTimeout(() => finish({ errno: -1, stdout: '', stderr: '回调超时；命令可能仍在执行，请刷新确认实际状态，勿重复提交' }), timeout);
    try {
      if (typeof ksu === 'undefined' || !ksu.exec) {
        finish({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：请在 KernelSU/Magisk WebUI 中打开' });
        return;
      }
      ksu.exec(command, '{}', cbName);
    } catch (e) {
      finish({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：' + e.message });
    }
  });
}

window.addEventListener('pagehide', () => {
  Object.values(_cbs).forEach((finish) => finish({ errno: -1, stdout: '', stderr: '页面已关闭，操作结果未知' }));
});

const MODDIR = '/data/adb/modules/mihomo-ebpf';
const SH = 'sh ' + MODDIR + '/scripts/';
const DATA = '/data/adb/mihomo';
const CONFIG = DATA + '/config.yaml';
const DEFAULT_INTERFACES = 'ap0,wlan1,rndis0,usb0,bt-pan';
const MAX_CONFIG_BASE64 = 120000;

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

function configPayload(content) {
  const encoded = b64encode(content);
  if (encoded.length > MAX_CONFIG_BASE64) return { ok: false, error: '配置过大：UTF-8 Base64 编码后为 ' + encoded.length + ' 字节，上限为 ' + MAX_CONFIG_BASE64 + ' 字节；请精简配置以避免 Android 参数长度限制' };
  return { ok: true, encoded };
}

function isSSIDPaused(status) {
  return status.ok && status.running === false && status.allowed === false && ['manual', 'auto'].includes(status.desired);
}

function ssidPauseMessage(status) {
  return '服务已启用，因 SSID 策略暂停；当前 SSID：' + (status.current_ssid || '（未连接或无法获取）') + '。策略允许后自动恢复';
}

/* ---------- 后端操作 ---------- */

async function sh(cmd) {
  const r = await exec(cmd);
  return r;
}

async function shJson(cmd, timeout) {
  const r = await exec(cmd, timeout);
  try {
    const data = JSON.parse(r.stdout.trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 对象缺失');
    if (r.errno !== 0) return { ok: false, error: data.error || r.stderr || ('命令失败（退出码 ' + r.errno + '）') };
    return data;
  } catch (e) {
    return { ok: false, error: r.stderr || ('输出不是 JSON：' + r.stdout.slice(0, 200)) };
  }
}

const api = {
  status:      () => shJson(SH + 'mihomo.sh status'),
  service:     async (action) => {
    if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, error: '不支持的服务操作' };
    const result = await exec(SH + 'mihomo.sh ' + action, 120000);
    if (result.errno !== 0) return { ok: false, error: result.stderr.trim() || result.stdout.trim() || ('服务操作失败（退出码 ' + result.errno + '）') };
    const status = await api.status();
    if (!status.ok) return { ok: false, error: '操作已返回，但无法确认服务状态：' + (status.error || '读取失败') };
    if (action !== 'stop' && isSSIDPaused(status)) return { ok: true, paused: true, message: ssidPauseMessage(status) };
    if (action === 'stop' && ['manual', 'auto'].includes(status.desired)) return { ok: false, error: '服务仍处于启用状态，自动恢复意图未取消，请刷新确认' };
    if (status.running !== (action !== 'stop')) return { ok: false, error: action === 'stop' ? '服务仍在运行' : '服务未运行，请检查 SSID 策略和日志' };
    return { ok: true, message: action === 'stop' ? '服务已停止' : '服务已启动' };
  },
  coreInfo:    () => shJson(SH + 'core.sh info'),
  coreGetSet:  () => shJson(SH + 'core.sh get_settings'),
  coreSet:     (repo, tag, mirror) => shJson(SH + 'core.sh settings ' + shq(repo || '-') + ' ' + shq(tag || '-') + ' ' + shq(mirror || '-')),
  coreUpdate:  () => shJson(SH + 'core.sh download', 1320000),
  coreRollback:() => shJson(SH + 'core.sh rollback'),
  configRead:  async () => {
    const r = await exec('base64 -w 0 ' + shq(CONFIG) + ' 2>/dev/null || base64 ' + shq(CONFIG) + ' | tr -d "\\n"');
    if (r.errno !== 0 || !r.stdout.trim()) return { ok: false, error: '读取配置失败（文件不存在？）' };
    return { ok: true, content: b64decode(r.stdout.trim()) };
  },
  validate:    async (content) => {
    const payload = configPayload(content);
    if (!payload.ok) return payload;
    const r = await exec('(tmp=$(mktemp) || exit 1; trap \'rm -f "$tmp"\' EXIT; printf %s ' + shq(payload.encoded) + ' | base64 -d > "$tmp" && /data/adb/mihomo/mihomo -d ' + shq(DATA) + ' -f "$tmp" -t)', 120000);
    return { ok: r.errno === 0, error: r.errno === 0 ? null : (r.stderr || r.stdout || '校验失败').trim().split('\n').slice(-5).join('\n') };
  },
  apply:       async (content, restart) => {
    const payload = configPayload(content);
    if (!payload.ok) return payload;
    const result = await shJson(SH + 'apply.sh ' + shq(payload.encoded) + (restart ? ' restart' : ''), 120000);
    if (!result.ok || !restart) return result;
    const status = await api.status();
    if (!status.ok) return { ok: false, error: '配置已保存，但无法确认服务状态：' + (status.error || '读取失败') };
    if (isSSIDPaused(status)) return { ...result, paused: true, message: ssidPauseMessage(status) };
    if (!status.running) return { ok: false, error: '配置已保存，但服务未运行；请检查 SSID 策略和日志' };
    return { ...result, paused: false, message: '已确认服务运行中' };
  },
  backups:     () => shJson(SH + 'backup.sh list'),
  backupRead:  async (name) => {
    const r = await exec(SH + 'backup.sh read ' + shq(name));
    if (!r.stdout.trim() || r.stdout.includes('"ok":false')) return { ok: false, error: '读取失败' };
    return { ok: true, content: b64decode(r.stdout.trim()) };
  },
  backupDel:   (name) => shJson(SH + 'backup.sh delete ' + shq(name)),
  backupRestore: (name) => shJson(SH + 'backup.sh restore ' + shq(name)),
  logs:        (lines) => sh('tail -n ' + (lines || 200) + ' ' + shq(DATA + '/run/mihomo.log') + ' 2>/dev/null; logcat -d -s mihomo:* 2>/dev/null | tail -n 50'),
  policyGet:   () => shJson(SH + 'policy.sh get'),
  policySet:   (settings) => shJson(SH + 'policy.sh set ' + [
    settings.autostart ? '1' : '0', settings.tethering ? '1' : '0',
    shq(b64encode(settings.tethering_interfaces)), shq(b64encode(settings.bypass_packages)),
    shq(settings.wifi_mode), shq(b64encode(settings.wifi_ssids)),
  ].join(' '), 120000),
  discoveryInterfaces: () => shJson(SH + 'discovery.sh interfaces', 15000),
  discoveryApps:       () => shJson(SH + 'discovery.sh apps', 30000),
};

/* ---------- mihomo 控制器 REST ---------- */

let controller = { addr: null, secret: '' };

function yamlScalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    const match = /^"(?:[^"\\]|\\.)*"/.exec(text);
    if (!match || !/^\s*(?:#.*)?$/.test(text.slice(match[0].length))) throw new Error('控制器配置引号无效');
    return JSON.parse(match[0]);
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
    if (!match) throw new Error('控制器配置引号无效');
    return match[1].replace(/''/g, "'");
  }
  const plain = text.replace(/\s+#.*$/, '').trim();
  if (/^[|>&*!{\[]/.test(plain)) throw new Error('控制器地址和密钥请使用单行字符串');
  return /^(?:null|~)$/i.test(plain) ? '' : plain;
}

async function detectController() {
  controller = { addr: null, secret: '' };
  const r = await exec('grep -E "^(external-controller|secret):" ' + shq(CONFIG) + ' 2>/dev/null');
  if (r.errno !== 0 && r.errno !== 1) throw new Error(r.stderr || '读取控制器配置失败');
  let addr = null, secret = '';
  r.stdout.split('\n').forEach((line) => {
    const match = /^(external-controller|secret):\s*(.*)$/.exec(line);
    if (!match) return;
    if (match[1] === 'external-controller') addr = yamlScalar(match[2]);
    else secret = yamlScalar(match[2]);
  });
  if (addr) {
    if (!/^(?:\[[\da-fA-F:]+\]|[\w.*-]*):\d{1,5}$/.test(addr)) throw new Error('external-controller 地址无效');
    addr = addr.replace(/^(?:0\.0\.0\.0|\[::\]|\*|)(?=:)/, '127.0.0.1');
    if (/[\r\n\0]/.test(secret)) throw new Error('控制器密钥不能包含换行');
    controller = { addr: 'http://' + addr, secret };
  } else {
    controller = { addr: null, secret: '' };
  }
  return controller;
}

async function ctl(path, opts) {
  if (!controller.addr) throw new Error('配置中没有 external-controller');
  if (!/^\/(?:version|proxies|connections)(?:[/?]|$)/.test(path)) throw new Error('不支持的控制器接口（不读取流接口）');
  const method = (opts && opts.method) || 'GET';
  if (!['GET', 'PUT', 'DELETE'].includes(method)) throw new Error('不支持的控制器操作');
  const args = ['--disable', '--silent', '--show-error', '--globoff', '--noproxy', '*',
    '--connect-timeout', '3', '--max-time', '8', '--request', method,
    '--header', 'Authorization: Bearer ' + controller.secret,
    '--write-out', '\n__MIHOMO_HTTP__:%{http_code}'];
  if (opts && opts.body !== undefined) args.push('--header', 'Content-Type: application/json', '--data-binary', opts.body);
  args.push('--url', controller.addr + path);
  const command = '(if [ -x /system/bin/curl ]; then curl_bin=/system/bin/curl; else curl_bin=$(command -v curl 2>/dev/null); fi; ' +
    'if [ -z "$curl_bin" ] || [ ! -x "$curl_bin" ]; then printf \'%s\\n\' \'未找到可执行的 curl：/system/bin/curl 不可用，PATH 中也未找到；请安装 curl 模块\' >&2; exit 127; fi; ' +
    '"$curl_bin" ' + args.map(shq).join(' ') + ')';
  const result = await exec(command, 15000);
  if (result.errno !== 0) throw new Error('控制器 curl 失败：' + (result.stderr || ('退出码 ' + result.errno + '')));
  const match = /\n__MIHOMO_HTTP__:(\d{3})\s*$/.exec(result.stdout);
  if (!match) throw new Error('控制器响应缺少 HTTP 状态码');
  const status = Number(match[1]);
  const body = result.stdout.slice(0, match.index).trim();
  if (status < 200 || status >= 300) throw new Error('控制器 HTTP ' + status + (body ? '：' + body.slice(0, 200) : ''));
  if (status === 204 || !body) return null;
  try { return JSON.parse(body); } catch (error) { throw new Error('控制器响应不是 JSON'); }
}

/* ---------- 小组件 ---------- */

const view = document.getElementById('view');
let pageSequence = 0;

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
  const sequence = ++pageSequence;
  h('<p class="dim" style="margin-top:20px"><span class="spin"></span> ' + esc(msg || '加载中…') + '</p>');
  return () => sequence === pageSequence;
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
  pill.title = isSSIDPaused(st) ? ssidPauseMessage(st) : '';
  if (!st.ok) {
    pill.textContent = '状态未知'; pill.className = 'pill';
  } else if (st.running) {
    pill.textContent = '运行中'; pill.className = 'pill on';
  } else if (isSSIDPaused(st)) {
    pill.textContent = 'SSID 暂停'; pill.className = 'pill paused';
  } else {
    pill.textContent = '已停止'; pill.className = 'pill off';
  }
  const fullVersion = String(ci.version || '').trim();
  ver.title = ci.ok && ci.installed ? fullVersion : '';
  ver.textContent = !ci.ok ? '内核信息读取失败' : ci.installed ? (fullVersion.replace(/^mihomo(?:\s+meta)?\s+/i, '').split(/\s+/)[0] || '未知版本') : '未安装内核';
}

/* ---------- 页面 ---------- */

const routes = [
  { path: 'overview', name: '概览', render: renderOverview },
  { path: 'proxies', name: '代理', render: renderProxies },
  { path: 'connections', name: '连接', render: renderConnections },
  { path: 'config', name: '配置', render: renderConfig },
  { path: 'settings', name: '设置', render: renderSettings },
  { path: 'backups', name: '备份', render: renderBackups },
  { path: 'core', name: '内核', render: renderCore },
  { path: 'setup', name: '向导', render: renderSetup },
  { path: 'logs', name: '日志', render: renderLogs },
];

/* --- 概览 --- */
async function renderOverview() {
  const active = loading();
  const [st, ci, policy] = await Promise.all([api.status(), api.coreInfo(), api.policyGet()]);
  if (!active()) return;
  const paused = isSSIDPaused(st);
  let ctlHtml = '';
  if (paused) {
    ctlHtml = '<div class="row"><span class="dim">控制器</span><span class="dim">SSID 策略暂停，服务恢复后可用</span></div>';
  } else try {
    await detectController();
    const v = await ctl('/version');
    ctlHtml =
      '<div class="row"><span class="dim">控制器</span><span>' + esc(controller.addr) + '</span></div>' +
      '<div class="row"><span class="dim">内核版本</span><span>' + esc(v.version || '-') + '</span></div>';
  } catch (e) {
    ctlHtml = '<div class="row"><span class="dim">控制器</span><span class="dim">不可用（' + esc(e.message) + '）</span></div>';
  }
  if (!active()) return;
  h(
    '<div class="card"><h2>服务</h2>' +
      '<div class="row"><span class="dim">状态</span><span>' + (!st.ok ? '读取失败：' + esc(st.error) : st.running ? '运行中（pid ' + esc(st.pid) + '）' : paused ? '已启用（SSID 暂停）' : '已停止') + '</span></div>' +
      (paused ? '<p class="dim" style="margin-top:10px;white-space:pre-wrap">' + esc(ssidPauseMessage(st)) + '</p>' : '') +
      (st.running ? '<div class="row"><span class="dim">内存</span><span>' + fmtBytes((st.rss_kb || 0) * 1024) + '</span><span class="dim">运行时长</span><span>' + fmtUptime(st.uptime) + '</span></div>' : '') +
      '<div class="row"><span class="dim">开机自启</span><span>' + (policy.ok ? (policy.autostart ? '开' : '关') : '读取失败：' + esc(policy.error)) + '</span></div>' +
      '<div class="row">' +
        (st.running || paused
          ? '<button data-a="restart">重启</button><button data-a="stop" class="danger">' + (paused ? '停止（取消自动恢复）' : '停止') + '</button>'
          : '<button data-a="start" class="primary">启动</button>') +
        '<button data-go="settings">自启与网络设置</button>' +
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
      view.querySelectorAll('[data-a]').forEach((button) => { button.disabled = true; });
      const result = await api.service(b.dataset.a);
      toast(result.ok ? result.message : result.error, result.ok ? 'ok' : 'err');
      if (active()) renderOverview();
      refreshHeader();
    };
  });
}

/* ---------- 接口标签映射与应用查询 ---------- */

const INTERFACE_LABELS = {
  ap0: 'Wi-Fi 热点 (ap0)',
  wlan1: '从 Wi-Fi (wlan1)',
  rndis0: 'USB 共享 (rndis0)',
  usb0: 'USB 网络 (usb0)',
  'bt-pan': '蓝牙共享 (bt-pan)',
};

let _cachedApps = null;
let _cachedAppsPromise = null;

async function getInstalledApps(forceRefresh = false) {
  if (_cachedApps && !forceRefresh) return _cachedApps;
  if (_cachedAppsPromise && !forceRefresh) return _cachedAppsPromise;
  _cachedAppsPromise = (async () => {
    try {
      if (typeof ksu !== 'undefined' && typeof ksu.listPackages === 'function' && typeof ksu.getPackagesInfo === 'function') {
        const pkgs = await ksu.listPackages('all');
        if (Array.isArray(pkgs) && pkgs.length > 0) {
          const infos = await ksu.getPackagesInfo(pkgs);
          if (Array.isArray(infos) && infos.length > 0) {
            _cachedApps = infos.map((info) => ({
              packageName: String(info.packageName || ''),
              appLabel: String(info.appLabel || info.packageName || ''),
              isSystem: Boolean(info.isSystem),
              uid: Number.isFinite(info.uid) ? info.uid : null,
              icon: 'ksu://icon/' + encodeURIComponent(info.packageName || ''),
            })).filter((app) => app.packageName);
            return _cachedApps;
          }
        }
      }
    } catch (e) {}

    try {
      const res = await api.discoveryApps();
      if (res && res.ok && Array.isArray(res.apps)) {
        _cachedApps = res.apps.map((app) => ({
          packageName: String(app.packageName || ''),
          appLabel: String(app.appLabel || app.packageName || ''),
          isSystem: Boolean(app.isSystem),
          uid: Number.isFinite(app.uid) ? app.uid : null,
          icon: typeof ksu !== 'undefined' ? ('ksu://icon/' + encodeURIComponent(app.packageName || '')) : null,
        })).filter((app) => app.packageName);
        return _cachedApps;
      }
    } catch (e) {}
    return [];
  })();
  try {
    return await _cachedAppsPromise;
  } finally {
    _cachedAppsPromise = null;
  }
}

function showAppPickerModal(selectedSet, onConfirm) {
  let container = document.getElementById('modal-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'modal-container';
    container.attributes = { id: 'modal-container' };
    (document.body || document.getElementById('app') || view).appendChild(container);
  }

  const tempSelected = new Set(selectedSet);
  let currentTab = 'user';
  let searchQuery = '';
  let allApps = [];

  container.innerHTML =
    '<div class="modal-overlay" id="app-modal-root" role="dialog" aria-modal="true">' +
      '<div class="modal-sheet">' +
        '<div class="modal-header">' +
          '<h3>选择绕过应用</h3>' +
          '<button type="button" class="modal-close" id="app-modal-close" title="关闭">✕</button>' +
        '</div>' +
        '<div class="modal-search">' +
          '<input type="search" id="app-modal-search" placeholder="搜索应用名称或包名…">' +
        '</div>' +
        '<div class="modal-tabs" id="app-modal-tabs">' +
          '<button type="button" class="modal-tab active" data-tab="user">用户应用</button>' +
          '<button type="button" class="modal-tab" data-tab="selected">已选 (<span id="modal-tab-sel-count">0</span>)</button>' +
          '<button type="button" class="modal-tab" data-tab="all">全部应用</button>' +
          '<button type="button" class="modal-tab" data-tab="system">系统应用</button>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<span id="app-modal-stats" class="dim">加载中…</span>' +
          '<div><a id="app-modal-toggle-all">全选当前筛选</a></div>' +
        '</div>' +
        '<div class="modal-list" id="app-modal-list">' +
          '<p class="dim" style="text-align:center;padding:32px 14px"><span class="spin"></span> 正在读取已安装应用…</p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button type="button" id="app-modal-cancel">取消</button>' +
          '<button type="button" class="primary" id="app-modal-confirm">确定 (<span id="app-modal-confirm-count">0</span>)</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  const modal = document.getElementById('app-modal-root');
  const searchInput = document.getElementById('app-modal-search');
  const tabsContainer = document.getElementById('app-modal-tabs');
  const listEl = document.getElementById('app-modal-list');
  const statsEl = document.getElementById('app-modal-stats');
  const toggleAllBtn = document.getElementById('app-modal-toggle-all');
  const selCountTab = document.getElementById('modal-tab-sel-count');
  const selCountConfirm = document.getElementById('app-modal-confirm-count');
  const cancelBtn = document.getElementById('app-modal-cancel');
  const confirmBtn = document.getElementById('app-modal-confirm');
  const closeBtn = document.getElementById('app-modal-close');

  const closeModal = () => {
    container.innerHTML = '';
  };

  if (cancelBtn) cancelBtn.onclick = closeModal;
  if (closeBtn) closeBtn.onclick = closeModal;
  if (modal) modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  const updateCounts = () => {
    if (selCountTab) selCountTab.textContent = String(tempSelected.size);
    if (selCountConfirm) selCountConfirm.textContent = String(tempSelected.size);
  };
  updateCounts();

  let visibleApps = [];

  const renderAppRows = () => {
    updateCounts();
    const query = searchQuery.trim().toLowerCase();
    visibleApps = allApps.filter((app) => {
      if (currentTab === 'user' && app.isSystem) return false;
      if (currentTab === 'system' && !app.isSystem) return false;
      if (currentTab === 'selected' && !tempSelected.has(app.packageName)) return false;
      if (!query) return true;
      return app.appLabel.toLowerCase().includes(query) || app.packageName.toLowerCase().includes(query);
    });

    if (statsEl) {
      statsEl.textContent = '显示 ' + visibleApps.length + ' / 共 ' + allApps.length + ' 个应用';
    }

    if (visibleApps.length === 0) {
      if (listEl) {
        listEl.innerHTML = '<p class="dim" style="text-align:center;padding:32px 14px">' +
          (allApps.length === 0 ? '未检测到应用列表（可稍后重试或手动输入包名）' : '无匹配的应用') + '</p>';
      }
      return;
    }

    const rowsHtml = visibleApps.map((app) => {
      const isChecked = tempSelected.has(app.packageName);
      const iconHtml = (app.icon ? '<img src="' + esc(app.icon) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
        '<span>' + esc((app.appLabel || 'A').charAt(0).toUpperCase()) + '</span>';
      return (
        '<div class="app-item' + (isChecked ? ' sel' : '') + '" data-pkg="' + esc(app.packageName) + '">' +
          '<input type="checkbox"' + (isChecked ? ' checked' : '') + ' data-pkg="' + esc(app.packageName) + '" tabindex="-1">' +
          '<div class="app-icon">' + iconHtml + '</div>' +
          '<div class="app-info">' +
            '<div class="app-title">' +
              '<span class="app-name-text">' + esc(app.appLabel) + '</span>' +
              (app.isSystem ? '<span class="badge-sys">系统</span>' : '') +
            '</div>' +
            '<div class="app-sub">' + esc(app.packageName) + (app.uid != null ? ' · UID ' + app.uid : '') + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    if (listEl) listEl.innerHTML = rowsHtml;
  };

  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.app-item');
      if (!item) return;
      const pkg = getAttr(item, 'data-pkg');
      if (!pkg) return;
      const cb = item.querySelector('input[type=checkbox]');
      const isNowSel = !tempSelected.has(pkg);
      if (isNowSel) tempSelected.add(pkg);
      else tempSelected.delete(pkg);
      item.classList.toggle('sel', isNowSel);
      if (cb) cb.checked = isNowSel;
      updateCounts();
    });
  }

  if (toggleAllBtn) {
    toggleAllBtn.onclick = () => {
      if (!visibleApps.length) return;
      const allSelected = visibleApps.every((app) => tempSelected.has(app.packageName));
      if (allSelected) {
        visibleApps.forEach((app) => tempSelected.delete(app.packageName));
      } else {
        visibleApps.forEach((app) => tempSelected.add(app.packageName));
      }
      renderAppRows();
    };
  }

  if (searchInput) {
    searchInput.oninput = (e) => {
      searchQuery = (e && e.target && e.target.value) || searchInput.value || '';
      renderAppRows();
    };
  }

  if (tabsContainer) {
    tabsContainer.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.modal-tab');
      if (!tabBtn) return;
      currentTab = getAttr(tabBtn, 'data-tab');
      tabsContainer.querySelectorAll('.modal-tab').forEach((b) => {
        b.classList.toggle('active', getAttr(b, 'data-tab') === currentTab);
      });
      renderAppRows();
    });
  }

  if (confirmBtn) {
    confirmBtn.onclick = () => {
      onConfirm(Array.from(tempSelected));
      closeModal();
    };
  }

  getInstalledApps().then((apps) => {
    allApps = apps;
    renderAppRows();
  }).catch((err) => {
    if (listEl) {
      listEl.innerHTML = '<p class="dim" style="text-align:center;padding:32px 14px">读取应用列表失败：' + esc(err.message || '未知错误') + '</p>';
    }
  });
}

/* --- 设置 --- */
async function renderSettings() {
  const active = loading();
  const settings = await api.policyGet();
  if (!active()) return;
  if (!settings.ok) {
    h('<div class="card"><h2>设置</h2><p class="dim">读取失败：' + esc(settings.error || '未知错误') + '</p><button id="policy-retry">重试</button></div>');
    document.getElementById('policy-retry').onclick = renderSettings;
    return;
  }
  const defaultIfs = DEFAULT_INTERFACES.split(',');
  h(
    '<div class="card"><h2>服务与网络共享</h2>' +
      '<div class="switch-item" id="row-autostart">' +
        '<div class="switch-info">' +
          '<div class="switch-title">开机自启</div>' +
          '<div class="switch-desc">设备启动进入系统后自动运行 mihomo 服务</div>' +
        '</div>' +
        '<input id="autostart" type="checkbox"' + (settings.autostart ? ' checked' : '') + '>' +
      '</div>' +
      '<div class="switch-item" id="row-tethering">' +
        '<div class="switch-info">' +
          '<div class="switch-title">网络共享代理</div>' +
          '<div class="switch-desc">接管热点、USB 网络共享等下联设备的流量并走代理</div>' +
        '</div>' +
        '<input id="tethering" type="checkbox"' + (settings.tethering ? ' checked' : '') + '>' +
      '</div>' +
      '<div class="card-section-title">共享下联接口</div>' +
      '<p class="dim">选择由代理接管的网络共享网卡接口（点击标签切换勾选）：</p>' +
      '<div class="chips" id="interface-chips"></div>' +
      '<label class="field dim">自定义接口输入（逗号分隔）：<input id="tethering-interfaces" type="text" value="' + esc(settings.tethering_interfaces == null ? DEFAULT_INTERFACES : settings.tethering_interfaces) + '"></label>' +
      '<div class="card-section-title" style="margin-top:16px">绕过应用与包名</div>' +
      '<p class="dim">选中的应用将直连绕过代理，不受代理规则限制：</p>' +
      '<div class="row" style="margin-top:8px">' +
        '<button type="button" class="primary" id="btn-select-apps">＋ 选择应用 (<span id="selected-apps-count">0</span>)</button>' +
        '<button type="button" id="btn-clear-apps">清空已选</button>' +
      '</div>' +
      '<div class="pkg-chips" id="selected-apps-chips"></div>' +
      '<details class="fold" style="margin-top:10px"><summary>高级：直接编辑包名文本（一行一个）</summary>' +
        '<textarea id="bypass-packages" rows="5" spellcheck="false">' + esc(settings.bypass_packages) + '</textarea>' +
      '</details>' +
    '</div>' +
    '<div class="card"><h2>Wi-Fi 策略</h2>' +
      '<label class="field">SSID 模式<select id="wifi-mode">' +
        [['off', 'off · 不限制'], ['only', 'only · 仅允许列表'], ['exclude', 'exclude · 排除列表']].map(([value, label]) =>
          '<option value="' + value + '"' + (settings.wifi_mode === value ? ' selected' : '') + '>' + label + '</option>').join('') +
      '</select></label>' +
      '<label class="field">精确 SSID（一行一个，区分大小写，保留首尾空格）<textarea id="wifi-ssids" rows="5" spellcheck="false">' + esc(settings.wifi_ssids) + '</textarea></label>' +
      '<p class="dim">按名称精确匹配，不使用通配符或正则。当前允许状态由后台策略判定，不等于服务正在运行。</p>' +
      '<div class="row"><span class="dim">当前 SSID</span><span id="current-ssid" style="white-space:pre-wrap"></span></div>' +
      '<div class="row"><span class="dim">策略状态</span><span id="wifi-allowed"></span><button id="policy-refresh">刷新状态</button></div></div>' +
    '<div class="card"><p class="dim">设置统一交由后台处理；源配置保留在 config.yaml，运行配置为 run/config.yaml。</p>' +
      '<div class="row"><button id="policy-save" class="primary">保存设置</button></div>' +
      '<pre id="policy-out" class="mono" role="status" aria-live="polite" style="display:none;margin-top:10px"></pre></div>'
  );

  const fields = {
    autostart: document.getElementById('autostart'), tethering: document.getElementById('tethering'),
    interfaces: document.getElementById('tethering-interfaces'), packages: document.getElementById('bypass-packages'),
    mode: document.getElementById('wifi-mode'), ssids: document.getElementById('wifi-ssids'),
  };
  const currentSSID = document.getElementById('current-ssid');
  const allowed = document.getElementById('wifi-allowed');
  const out = document.getElementById('policy-out');
  const save = document.getElementById('policy-save');
  const refresh = document.getElementById('policy-refresh');
  const ifChipsContainer = document.getElementById('interface-chips');
  const pkgChipsContainer = document.getElementById('selected-apps-chips');
  const selectAppsBtn = document.getElementById('btn-select-apps');
  const clearAppsBtn = document.getElementById('btn-clear-apps');
  const selectedAppsCountEl = document.getElementById('selected-apps-count');

  const rowAutostart = document.getElementById('row-autostart');
  if (rowAutostart) {
    rowAutostart.onclick = (e) => {
      if (e.target !== fields.autostart) {
        fields.autostart.checked = !fields.autostart.checked;
      }
    };
  }
  const rowTethering = document.getElementById('row-tethering');
  if (rowTethering) {
    rowTethering.onclick = (e) => {
      if (e.target !== fields.tethering) {
        fields.tethering.checked = !fields.tethering.checked;
      }
    };
  }

  let candidateIfs = [...defaultIfs];
  const parseSelectedIfs = () => {
    return new Set(fields.interfaces.value.split(',').map((s) => s.trim()).filter(Boolean));
  };

  const renderInterfaceChips = () => {
    if (!ifChipsContainer) return;
    const selectedSet = parseSelectedIfs();
    ifChipsContainer.innerHTML = candidateIfs.map((name) => {
      const isSel = selectedSet.has(name);
      const friendlyLabel = INTERFACE_LABELS[name] || name;
      return '<span class="chip' + (isSel ? ' sel' : '') + '" data-if="' + esc(name) + '">' +
        esc(friendlyLabel) +
      '</span>';
    }).join('');
  };

  renderInterfaceChips();

  if (ifChipsContainer) {
    ifChipsContainer.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip || !chip.dataset.if) return;
      const ifName = chip.dataset.if;
      const currentSet = parseSelectedIfs();
      if (currentSet.has(ifName)) {
        currentSet.delete(ifName);
      } else {
        currentSet.add(ifName);
      }
      fields.interfaces.value = Array.from(currentSet).join(',');
      renderInterfaceChips();
    });
  }

  fields.interfaces.addEventListener('input', renderInterfaceChips);

  api.discoveryInterfaces().then((res) => {
    if (!active() || !res || !res.ok || !Array.isArray(res.interfaces)) return;
    const presentNames = res.interfaces
      .filter((it) => it && it.name && !it.upstream && it.name !== 'lo')
      .map((it) => it.name);
    candidateIfs = Array.from(new Set([...candidateIfs, ...presentNames]));
    renderInterfaceChips();
  }).catch(() => {});

  const parseSelectedPackages = () => {
    return new Set(fields.packages.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  };

  const renderSelectedAppChips = (appsList) => {
    const pkgsSet = parseSelectedPackages();
    if (selectedAppsCountEl) selectedAppsCountEl.textContent = String(pkgsSet.size);
    if (!pkgChipsContainer) return;

    if (pkgsSet.size === 0) {
      pkgChipsContainer.innerHTML = '<span class="dim" style="font-size:12.5px;padding:4px 0">未选择应用（默认代理所有应用流量）</span>';
      return;
    }

    const appMap = new Map();
    if (Array.isArray(appsList)) {
      appsList.forEach((app) => appMap.set(app.packageName, app));
    }

    const chipsHtml = Array.from(pkgsSet).map((pkg) => {
      const app = appMap.get(pkg);
      const label = app ? app.appLabel : pkg;
      const iconHtml = (app && app.icon ? '<img src="' + esc(app.icon) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
        '<span>' + esc(label.charAt(0).toUpperCase()) + '</span>';
      return (
        '<span class="pkg-chip" title="' + esc(pkg) + '">' +
          '<span class="pkg-avatar">' + iconHtml + '</span>' +
          '<span class="pkg-chip-label">' + esc(label) + '</span>' +
          (app ? '<span class="pkg-chip-id">' + esc(pkg) + '</span>' : '') +
          '<span class="pkg-chip-del" data-del-pkg="' + esc(pkg) + '" title="移除">✕</span>' +
        '</span>'
      );
    }).join('');

    pkgChipsContainer.innerHTML = chipsHtml;
  };

  renderSelectedAppChips(_cachedApps);
  getInstalledApps().then((apps) => {
    if (active()) renderSelectedAppChips(apps);
  }).catch(() => {});

  if (pkgChipsContainer) {
    pkgChipsContainer.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-del-pkg]');
      if (!delBtn) return;
      const pkgToRemove = getAttr(delBtn, 'data-del-pkg');
      const currentPkgs = parseSelectedPackages();
      currentPkgs.delete(pkgToRemove);
      fields.packages.value = Array.from(currentPkgs).join('\n');
      renderSelectedAppChips(_cachedApps);
    });
  }

  if (clearAppsBtn) {
    clearAppsBtn.onclick = () => {
      fields.packages.value = '';
      renderSelectedAppChips(_cachedApps);
    };
  }

  fields.packages.addEventListener('input', () => {
    renderSelectedAppChips(_cachedApps);
  });

  if (selectAppsBtn) {
    selectAppsBtn.onclick = () => {
      const currentPkgs = parseSelectedPackages();
      showAppPickerModal(currentPkgs, (newPkgs) => {
        fields.packages.value = newPkgs.join('\n');
        renderSelectedAppChips(_cachedApps);
      });
    };
  }

  const showStatus = (policy) => {
    currentSSID.textContent = policy.ok ? (policy.current_ssid || '（未连接或无法获取）') : '读取失败';
    allowed.textContent = policy.ok ? (policy.allowed ? '允许' : '不允许') : (policy.error || '未知');
  };
  showStatus(settings);
  refresh.onclick = async () => {
    refresh.disabled = true;
    const policy = await api.policyGet();
    if (active()) showStatus(policy);
    refresh.disabled = false;
  };
  save.onclick = async () => {
    if (save.disabled) return;
    const payload = {
      autostart: fields.autostart.checked, tethering: fields.tethering.checked,
      tethering_interfaces: fields.interfaces.value.split(',').map((name) => name.trim()).filter(Boolean).join(',') || DEFAULT_INTERFACES,
      bypass_packages: fields.packages.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).join('\n'),
      wifi_mode: fields.mode.value,
      wifi_ssids: fields.ssids.value.replace(/\r\n?/g, '\n').split('\n').filter((ssid) => ssid.length > 0).join('\n'),
    };
    out.style.display = 'block';
    if (!['off', 'only', 'exclude'].includes(payload.wifi_mode)) { out.textContent = '✗ 无效的 SSID 模式'; return; }
    const controls = [...Object.values(fields), save, refresh];
    controls.forEach((control) => { control.disabled = true; });
    out.textContent = '保存中…';
    try {
      const result = await api.policySet(payload);
      if (!active()) return;
      out.textContent = result.ok ? '✓ 设置已保存' : '✗ ' + (result.error || '保存失败');
      toast(result.ok ? '设置已保存' : (result.error || '保存失败'), result.ok ? 'ok' : 'err');
      if (result.ok) {
        const policy = await api.policyGet();
        if (active()) showStatus(policy);
        refreshHeader();
      }
    } catch (error) {
      out.textContent = '✗ ' + error.message;
    } finally {
      controls.forEach((control) => { control.disabled = false; });
    }
  };
}

/* --- 代理 --- */
async function renderProxies() {
  const active = loading();
  let data;
  try {
    await detectController();
    data = await ctl('/proxies');
  } catch (e) {
    if (!active()) return;
    h('<div class="card"><p class="dim">无法连接控制器：' + esc(e.message) + '。请确认服务已启动且配置含 external-controller。</p></div>');
    return;
  }
  if (!active()) return;
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
        if (active()) renderProxies();
      } catch (e) {
        toast('切换失败：' + e.message, 'err');
      }
    };
  });
}

/* --- 连接 --- */
async function renderConnections() {
  const active = loading();
  let data;
  try {
    await detectController();
    data = await ctl('/connections');
  } catch (e) {
    if (!active()) return;
    h('<div class="card"><p class="dim">无法连接控制器：' + esc(e.message) + '</p></div>');
    return;
  }
  if (!active()) return;
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
      b.disabled = true;
      try {
        await ctl('/connections/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
        if (active()) b.closest('tr').remove();
      } catch (error) { toast('断开失败：' + error.message, 'err'); }
      finally { b.disabled = false; }
    };
  });
  document.getElementById('close-all').onclick = async () => {
    try {
      await ctl('/connections', { method: 'DELETE' });
      if (active()) renderConnections();
    } catch (error) { toast('断开失败：' + error.message, 'err'); }
  };
}

/* --- 配置文件 --- */
async function renderConfig() {
  const active = loading();
  const r = await api.configRead();
  if (!active()) return;
  const content = r.ok ? r.content : '';
  h(
    '<div class="card"><h2>配置文件（' + esc(CONFIG) + '）</h2>' +
      (r.ok ? '' : '<p class="dim">' + esc(r.error) + '，可在此新建。</p>') +
      '<textarea id="cfg" class="mono" spellcheck="false">' + esc(content) + '</textarea>' +
      '<div class="row" style="margin-top:10px">' +
        '<button id="v">校验</button>' +
        '<button id="s" class="primary">保存并启动/重启</button>' +
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
    const buttons = ['s', 's2', 'v'].map((name) => document.getElementById(name));
    if (buttons[0].disabled) return;
    buttons.forEach((button) => { button.disabled = true; });
    out.style.display = 'block'; out.textContent = '保存中…';
    try {
      const ar = await api.apply(ta.value, restart);
      if (ar.ok) {
        out.textContent = '✓ 已保存' + (restart ? '，' + ar.message : '');
        toast(ar.paused ? ar.message : '已保存', 'ok');
        refreshHeader();
      } else {
        out.textContent = '✗ ' + (ar.error || '保存失败');
      }
    } catch (error) {
      out.textContent = '✗ ' + error.message;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  };
  document.getElementById('s').onclick = () => save(true);
  document.getElementById('s2').onclick = () => save(false);
}

/* --- 备份 --- */
async function renderBackups() {
  const active = loading();
  const r = await api.backups();
  if (!active()) return;
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
      if (active()) renderBackups();
    };
  });
}

/* --- 内核 --- */
async function renderCore() {
  const active = loading();
  const [info, set] = await Promise.all([api.coreInfo(), api.coreGetSet()]);
  if (!active()) return;
  h(
    '<div class="card"><h2>当前内核</h2>' +
      '<div class="row"><span class="dim">状态</span><span>' + (info.installed ? '已安装' : '未安装') + '</span></div>' +
      (info.platform ? '<div class="row"><span class="dim">平台</span><span>' + esc(info.platform) + '</span></div>' : '') +
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
    if (active()) renderCore();
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
  const lines = tpl.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === '#@providers') {
      subs.forEach((s) => {
        out.push('  ' + JSON.stringify(s.name) + ':');
        out.push('    <<: *p');
        out.push('    url: ' + JSON.stringify(s.url));
        if (s.ua) out.push('    header: {User-Agent: [' + JSON.stringify(s.ua) + ']}');
        out.push('    path: ' + JSON.stringify('./providers/' + encodeURIComponent(s.name) + '.yaml'));
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
      out.push('      interface: [' + lanIfs.map((name) => JSON.stringify(name)).join(', ') + ']');
    } else if (/^external-controller:/.test(line)) {
      out.push('external-controller: 127.0.0.1:9090');
    } else if (/^allow-lan:/.test(line)) {
      out.push('allow-lan: false');
    } else if (/^bind-address:/.test(line)) {
      out.push('bind-address: 127.0.0.1');
    } else if (/^    mode: hybrid\s*(?:#.*)?$/.test(line)) {
      out.push('    mode: local');
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

async function renderSetup() {
  const active = loading();
  let tpl = '';
  try {
    const response = await fetch('template.yaml');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    tpl = await response.text();
  } catch (e) {
    if (!active()) return;
    h('<div class="card"><p class="dim">模板加载失败：' + esc(e.message) + '</p></div>');
    return;
  }
  if (!active()) return;
  const subRows = [0].map(() =>
    '<div class="sub-item"><input name="sname" type="text" placeholder="名称" value="订阅1">' +
    '<input name="surl" type="text" class="grow" placeholder="https://…">' +
    '<input name="sua" type="text" placeholder="UA（可空）">' +
    '<button data-del type="button">✕</button></div>'
  ).join('');
  h(
    '<div class="card"><h2>设置向导</h2>' +
      '<p class="dim">生成 Android 本机 eBPF local 配置 + Smart 策略组 + zashboard 面板，控制器仅监听 127.0.0.1。网络共享与 SSID 策略统一在「设置」页管理，后台按策略生成运行配置。</p></div>' +
    '<div class="card"><h2>1. 内核</h2><div id="core-state" class="dim">检查中…</div></div>' +
    '<div class="card"><h2>2. 订阅</h2><div id="subs">' + subRows + '</div>' +
      '<div class="row" style="margin-top:10px"><button id="add-sub">+ 添加订阅</button></div></div>' +
    '<div class="card"><h2>3. 选项</h2>' +
      '<label class="field">面板密钥（留空自动生成）<input id="secret" type="text"></label>' +
      '<label class="field">面板地址<input id="uiurl" type="text" value="https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip"></label>' +
      '<div class="row" style="margin-top:10px">' +
        '<button id="gen" class="primary">生成配置并启动</button>' +
        '<button id="genonly">仅生成配置</button>' +
      '</div><pre id="sout" class="mono" style="display:none;margin-top:10px"></pre></div>'
  );

  api.coreInfo().then((ci) => {
    if (!active()) return;
    const el = document.getElementById('core-state');
    if (!ci.ok) {
      el.textContent = '内核检查失败：' + (ci.error || '未知错误');
    } else if (ci.installed) {
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
    const generate = document.getElementById('gen');
    const generateOnly = document.getElementById('genonly');
    if (generate.disabled) return;
    const subs = [];
    let err = null;
    subsEl.querySelectorAll('.sub-item').forEach((it) => {
      const name = it.querySelector('[name=sname]').value.trim();
      const url = it.querySelector('[name=surl]').value.trim();
      const ua = it.querySelector('[name=sua]').value.trim();
      if (!name || !url) { err = '订阅名称与地址不能为空'; return; }
      if (!/^https?:\/\//.test(url)) { err = '订阅地址需要 http:// 或 https:// 开头'; return; }
      if (subs.some((subscription) => subscription.name === name)) { err = '订阅名称不能重复'; return; }
      subs.push({ name, url, ua: ua || null });
    });
    const sout = document.getElementById('sout');
    sout.style.display = 'block';
    if (err || !subs.length) { sout.textContent = '✗ ' + (err || '请添加订阅'); return; }
    generate.disabled = true;
    generateOnly.disabled = true;
    try {
      let secret = document.getElementById('secret').value.trim();
      if (!secret) {
        secret = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
        document.getElementById('secret').value = secret;
      }
      const uiUrl = document.getElementById('uiurl').value.trim();
      const fipUrl = 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs';
      const content = renderTemplate(tpl, subs, [], secret, uiUrl, fipUrl);
      sout.textContent = '检查内核…';
      const core = await api.coreInfo();
      if (!active()) return;
      if (!core.ok) { sout.textContent = '✗ 内核检查失败：' + (core.error || '未知错误'); return; }
      if (start && !core.installed) { sout.textContent = '✗ 请先安装内核，再生成并启动；也可选择仅生成配置'; return; }
      if (core.installed) {
        sout.textContent = '校验中…';
        const validation = await api.validate(content);
        if (!active()) return;
        if (!validation.ok) { sout.textContent = '✗ 校验失败：\n' + validation.error; return; }
      }
      sout.textContent = '保存中…';
      const result = await api.apply(content, start);
      if (result.ok) {
        sout.textContent = '✓ 配置已生成' + (start ? '，' + result.message + '。面板密钥：' + secret : '，未启动服务' + (core.installed ? '' : '（内核未安装，未校验）'));
        toast(result.paused ? result.message : '完成', 'ok');
        refreshHeader();
      } else {
        sout.textContent = '✗ ' + (result.error || '保存失败');
      }
    } catch (error) {
      sout.textContent = '✗ ' + error.message;
    } finally {
      generate.disabled = false;
      generateOnly.disabled = false;
    }
  };
  document.getElementById('gen').onclick = () => gen(true);
  document.getElementById('genonly').onclick = () => gen(false);
}

/* --- 日志 --- */
async function renderLogs() {
  const active = loading();
  const r = await api.logs(300);
  if (!active()) return;
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
  const pending = r.render();
  const sequence = pageSequence;
  return pending.catch((error) => {
    if (sequence === pageSequence) h('<div class="card"><p class="dim">加载失败：' + esc(error.message) + '</p></div>');
  });
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
