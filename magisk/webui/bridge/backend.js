(function (root) {
  'use strict';

  const DATA = '/data/adb/mihomo';
  const CONFIG = DATA + '/config.yaml';
  const SH = 'sh /data/adb/modules/mihomo-ebpf/scripts/';
  const DEFAULT_INTERFACES = 'ap0,wlan1,rndis0,usb0,bt-pan';
  const MAX_CONFIG_BASE64 = 120000;
  const PACKAGE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(?![\s\S])/;
  const callbacks = new Map();
  const icons = new Map();
  let callbackSequence = 0;
  let cachedApps = null;
  let pendingApps = null;
  let appsGeneration = 0;

  function shq(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function bytesBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function b64encode(value) {
    return bytesBase64(new TextEncoder().encode(value));
  }

  function b64decode(value) {
    const encoded = value.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('读取内容不是有效 Base64');
    }
    const binary = atob(encoded);
    if (btoa(binary) !== encoded) throw new Error('读取内容不是有效 Base64');
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  }

  const MAX_CONFIG_BYTES = 4194304;
  const STAGE_CHUNK = 96000;

  function configPayload(content) {
    const encoded = b64encode(content);
    if (encoded.length > MAX_CONFIG_BASE64) {
      throw new Error('配置过大：UTF-8 Base64 编码后为 ' + encoded.length + ' 字节，上限为 ' + MAX_CONFIG_BASE64 + ' 字节；请精简配置以避免 Android 参数长度限制');
    }
    return encoded;
  }

  // 超过单条命令参数上限的配置分段写入 run/stage.b64，返回在 shell 中引用暂存内容的方式。
  async function stageConfig(content) {
    const encoded = b64encode(content);
    if (encoded.length <= MAX_CONFIG_BASE64) return { inline: encoded };
    if (new TextEncoder().encode(content).length > MAX_CONFIG_BYTES) throw new Error('配置超过 4 MB，无法写入');
    for (let index = 0, offset = 0; offset < encoded.length; index++, offset += STAGE_CHUNK) {
      await shJson('host.sh', ['stage', String(index), encoded.slice(offset, offset + STAGE_CHUNK)], 30000);
    }
    return { staged: true };
  }

  function exec(command, timeout = 30000) {
    const callbackName = '__mihomo_bridge_cb_' + (++callbackSequence);
    return new Promise((resolve) => {
      let timer;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callbacks.delete(callbackName);
        delete root[callbackName];
        resolve(result);
      };
      callbacks.set(callbackName, finish);
      root[callbackName] = (errno, stdout, stderr) => finish({
        errno: Number.isFinite(Number(errno)) ? Number(errno) : -1,
        stdout: String(stdout == null ? '' : stdout),
        stderr: String(stderr == null ? '' : stderr),
      });
      timer = setTimeout(() => finish({ errno: -1, stdout: '', stderr: '回调超时；命令可能仍在执行，请刷新确认实际状态，勿重复提交' }), timeout);
      try {
        if (!root.ksu || (typeof root.ksu.spawn !== 'function' && typeof root.ksu.exec !== 'function')) throw new Error('请在 KernelSU/Magisk WebUI 中打开');
        // KernelSU 的 ksu.exec 在 JS 接口方法里同步执行命令，期间页面主线程（也是界面渲染线程）被阻塞；
        // ksu.spawn 只同步创建 shell，命令在后台执行，按行回传输出，界面不会因轮询而卡顿。
        if (typeof root.ksu.spawn === 'function') {
          const out = [];
          const err = [];
          root[callbackName] = {
            stdout: { emit: (event, data) => { if (event === 'data') out.push(String(data)); } },
            stderr: { emit: (event, data) => { if (event === 'data') err.push(String(data)); } },
            emit: (event, code) => {
              if (event === 'exit') finish({ errno: Number.isFinite(Number(code)) ? Number(code) : -1, stdout: out.join('\n'), stderr: err.join('\n') });
            },
          };
          root.ksu.spawn(command, '[]', '{}', callbackName);
          return;
        }
        root.ksu.exec(command, '{}', callbackName);
      } catch (error) {
        finish({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：' + error.message });
      }
    });
  }

  // 网页管理（mihomo-webd）：没有 ksu 时经同源 api/run 调用脚本子命令；只允许 SCRIPTS 中的脚本，不执行任意 shell。
  const SCRIPTS = ['apply.sh', 'backup.sh', 'core.sh', 'discovery.sh', 'host.sh', 'mihomo.sh', 'onboarding.sh', 'policy.sh', 'tailscale.sh', 'webui.sh'];
  const ENV_NAMES = ['MIHOMO_SECRET'];

  function remoteMode() {
    return !root.ksu && !!root.location && /^https?:$/.test(root.location.protocol);
  }

  async function remoteRun(script, args, timeout, env) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => abort && abort.abort(), timeout + 5000);
    try {
      const response = await root.fetch('api/run', {
        method: 'POST', credentials: 'same-origin', signal: abort ? abort.signal : undefined,
        headers: { 'Content-Type': 'application/json', 'X-Mihomo-Request': '1' },
        body: JSON.stringify({ script, args, env, timeout }),
      });
      if (response.status === 401) {
        root.location.href = 'login?next=' + encodeURIComponent(root.location.pathname + root.location.hash);
        return { errno: -1, stdout: '', stderr: '登录已失效，请重新登录' };
      }
      const body = await response.json().catch(() => null);
      if (!body || typeof body !== 'object') return { errno: -1, stdout: '', stderr: '网页服务 HTTP ' + response.status };
      if (!response.ok) return { errno: -1, stdout: '', stderr: String(body.error || ('网页服务 HTTP ' + response.status)) };
      return { errno: Number(body.errno), stdout: String(body.stdout || ''), stderr: String(body.stderr || '') };
    } catch (error) {
      return { errno: -1, stdout: '', stderr: abort && abort.signal.aborted ? '请求超时；命令可能仍在执行，请刷新确认实际状态，勿重复提交' : '网页服务不可达：' + error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // 调用模块脚本子命令：script 为 SCRIPTS 之一，args 为字符串参数，env 只允许 ENV_NAMES。
  function run(script, args = [], timeout = 30000, env = {}) {
    if (!SCRIPTS.includes(script)) return Promise.resolve({ errno: -1, stdout: '', stderr: '不允许的脚本：' + script });
    for (const name of Object.keys(env)) {
      if (!ENV_NAMES.includes(name)) return Promise.resolve({ errno: -1, stdout: '', stderr: '不允许的环境变量：' + name });
    }
    const list = args.map(String);
    if (remoteMode()) return remoteRun(script, list, timeout, env);
    const prefix = Object.entries(env).map(([name, value]) => name + '=' + shq(value) + ' ').join('');
    // 子命令（首个参数）是固定的小写单词，不加引号，便于在日志里辨认
    const words = list.map((arg, index) => (index === 0 && /^[a-z][a-z_-]*$/.test(arg) ? arg : shq(arg)));
    return exec(prefix + SH + script + words.map((word) => ' ' + word).join(''), timeout);
  }

  root.addEventListener('pagehide', () => {
    for (const finish of callbacks.values()) finish({ errno: -1, stdout: '', stderr: '页面已关闭，操作结果未知' });
  });

  async function shJson(script, args, timeout, env) {
    const result = await run(script, args, timeout, env);
    let data;
    try {
      data = JSON.parse(result.stdout.trim());
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 对象缺失');
    } catch (error) {
      throw new Error(result.stderr || ('输出不是 JSON：' + result.stdout.slice(0, 200)));
    }
    if (result.errno !== 0 || data.ok !== true) {
      throw new Error(data.error || result.stderr || ('命令失败（退出码 ' + result.errno + '）'));
    }
    return data;
  }

  function isSSIDPaused(status) {
    return status.ok && status.running === false && status.allowed === false && ['manual', 'auto'].includes(status.desired);
  }

  function ssidPauseMessage(status) {
    return '服务已启用，因 SSID 策略暂停；当前 SSID：' + (status.current_ssid || '（未连接或无法获取）') + '。策略允许后自动恢复';
  }

  async function readStatus(prefix) {
    try { return await shJson('mihomo.sh', ['status']); }
    catch (error) { throw new Error(prefix + error.message); }
  }

  async function service(action) {
    const result = await run('mihomo.sh', [action], 120000);
    if (result.errno !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || ('服务操作失败（退出码 ' + result.errno + '）'));
    const status = await readStatus('操作已返回，但无法确认服务状态：');
    if (action !== 'stop' && isSSIDPaused(status)) return { ok: true, paused: true, message: ssidPauseMessage(status) };
    if (action === 'stop' && ['manual', 'auto'].includes(status.desired)) throw new Error('服务仍处于启用状态，自动恢复意图未取消，请刷新确认');
    if (status.running !== (action !== 'stop')) throw new Error(action === 'stop' ? '服务仍在运行' : '服务未运行，请检查 SSID 策略和日志');
    return { ok: true, paused: false, message: action === 'stop' ? '服务已停止' : '服务已启动' };
  }

  async function apply(content, restart) {
    controllerCache = null;
    const staged = await stageConfig(content);
    const result = await shJson('apply.sh', [staged.inline || '--staged'].concat(restart ? ['restart'] : []), 120000);
    if (!restart) return result;
    const status = await readStatus('配置已保存，但无法确认服务状态：');
    if (isSSIDPaused(status)) return { ...result, paused: true, message: ssidPauseMessage(status) };
    if (status.running !== true) throw new Error('配置已保存，但服务未运行；请检查 SSID 策略和日志');
    return { ...result, paused: false, message: '已确认服务运行中' };
  }

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
    const result = await run('host.sh', ['controller']);
    if (result.errno !== 0 && result.errno !== 1) throw new Error(result.stderr || '读取控制器配置失败');
    let address = null;
    let secret = '';
    let ui = '';
    for (const line of result.stdout.split('\n')) {
      const match = /^(external-controller|secret|external-ui):\s*(.*)$/.exec(line);
      if (!match) continue;
      if (match[1] === 'external-controller') address = yamlScalar(match[2]);
      else if (match[1] === 'secret') secret = yamlScalar(match[2]);
      else ui = yamlScalar(match[2]);
    }
    if (!address) throw new Error('配置中没有 external-controller');
    if (!/^(?:\[[\da-fA-F:]+\]|[\w.*-]*):\d{1,5}$/.test(address)) throw new Error('external-controller 地址无效');
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new Error('external-controller 端口无效');
    address = address.replace(/^(?:0\.0\.0\.0|\[::\]|\*|)(?=:)/, '127.0.0.1');
    if (/[\r\n\0]/.test(secret)) throw new Error('控制器密钥不能包含换行');
    return { address: 'http://' + address, secret, ui };
  }

  // 控制器地址与密钥缓存一小段时间：轮询时不必每次都读配置（每次读都要起一个 shell）
  const CONTROLLER_TTL = 15000;
  let controllerCache = null;

  async function cachedController() {
    const now = Date.now();
    if (controllerCache && now - controllerCache.at < CONTROLLER_TTL) return controllerCache.value;
    const value = await detectController();
    controllerCache = { value, at: now };
    return value;
  }

  // 先由页面直接请求本机控制器（mihomo 默认允许跨域与私网访问），失败时再经 curl；
  // 直连失败而脚本成功时，两分钟内不再尝试直连。网页管理下经同源 /clash/ 反向代理访问。
  let directBlockedUntil = 0;

  function controllerResult(status, body) {
    if (status < 200 || status >= 300) throw new Error('控制器 HTTP ' + status + (body ? '：' + body.slice(0, 200) : ''));
    if (status === 204 || !body) return { ok: true, data: null };
    try { return { ok: true, data: JSON.parse(body) }; }
    catch (error) { throw new Error('控制器响应不是 JSON'); }
  }

  async function controllerFetch(base, detected, payload) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => abort && abort.abort(), 10000);
    try {
      const headers = { Authorization: 'Bearer ' + detected.secret };
      const init = { method: payload.method || 'GET', headers, credentials: 'omit', cache: 'no-store', signal: abort ? abort.signal : undefined };
      if (payload.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
      }
      const response = await root.fetch(base + payload.path, init);
      if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') throw new Error('无效响应');
      // 网页服务的登录失效等错误不是控制器的响应，交给脚本通道处理
      if (response.status === 401 && remoteMode()) throw new Error('网页服务 401');
      return { status: response.status, body: String(await response.text()).trim() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function controller(payload) {
    const detected = await cachedController();
    let direct = null;
    if (Date.now() >= directBlockedUntil && typeof root.fetch === 'function') {
      try {
        direct = await controllerFetch(remoteMode() ? root.location.origin + '/clash' : detected.address, detected, payload);
      } catch (error) {
        direct = null; // 被拦截、连不上或超时：改经脚本，脚本成功说明直连不可用
      }
    }
    if (direct) {
      if (direct.status === 401) controllerCache = null;
      return controllerResult(direct.status, direct.body);
    }
    const viaScript = await controllerScript(detected, payload);
    directBlockedUntil = Date.now() + 120000;
    return viaScript;
  }

  async function controllerScript(detected, payload) {
    const args = [payload.method || 'GET', detected.address + payload.path];
    if (payload.body !== undefined) args.push(typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body));
    const result = await run('host.sh', ['api'].concat(args), 15000, { MIHOMO_SECRET: detected.secret });
    if (result.errno !== 0) throw new Error('控制器 curl 失败：' + (result.stderr || ('退出码 ' + result.errno + '')));
    const match = /\n__MIHOMO_HTTP__:(\d{3})\s*$/.exec(result.stdout);
    if (!match) throw new Error('控制器响应缺少 HTTP 状态码');
    return controllerResult(Number(match[1]), result.stdout.slice(0, match.index).trim());
  }

  function renderTemplate(template, payload) {
    const output = [];
    for (const line of template.split(/\r?\n/)) {
      const marker = line.trim();
      if (marker === '#@providers') {
        // 与 LuCI 向导一致：沿用 p 锚点、./proxy_provider/ 路径、节点名加 [订阅名] 前缀
        for (const subscription of payload.subscriptions) {
          output.push('  ' + JSON.stringify(subscription.name) + ':', '    <<: *p',
            '    path: ' + JSON.stringify('./proxy_provider/' + encodeURIComponent(subscription.name) + '.yaml'),
            '    url: ' + JSON.stringify(subscription.url),
            '    override:', '      additional-prefix: ' + JSON.stringify('[' + subscription.name + ']'));
          if (subscription.ua) output.push('    header:', '      User-Agent: [' + JSON.stringify(subscription.ua) + ']');
        }
      } else if (marker === '#@use') {
        for (const subscription of payload.subscriptions) output.push('    - ' + JSON.stringify(subscription.name));
      } else if (marker === '#@secret') {
        if (payload.secret) output.push('secret: ' + JSON.stringify(payload.secret));
      } else if (marker === '#@ui-url') {
        if (payload.uiUrl) output.push('external-ui-url: ' + JSON.stringify(payload.uiUrl));
      } else if (marker === '#@fake-ip-filter-url') {
        output.push('    url: ' + JSON.stringify(payload.rulesUrl));
      } else if (marker === '#@lan') {
        output.push('      interface: []');
      } else if (/^external-controller:/.test(line)) {
        output.push('external-controller: 127.0.0.1:9090');
      } else if (/^allow-lan:/.test(line)) {
        output.push('allow-lan: false');
      } else if (/^bind-address:/.test(line)) {
        output.push('bind-address: 127.0.0.1');
      } else if (/^    mode: hybrid\s*(?:#.*)?$/.test(line)) {
        output.push('    mode: local');
      } else {
        output.push(line);
      }
    }
    return output.join('\n');
  }

  async function fetchResource(url, consume) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await root.fetch(url, abort ? { signal: abort.signal } : undefined);
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return consume(response);
        })(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            if (abort) abort.abort();
            reject(new Error('资源读取超时'));
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function packageArray(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error('应用列表不是 JSON 数组');
    return parsed;
  }

  function packageProviders() {
    const providers = [];
    if (root.ksu) {
      try {
        const manager = typeof root.ksu.pm === 'function' ? root.ksu.pm() : root.ksu.pm;
        if (manager && manager.support !== false) providers.push(manager);
      } catch (error) {}
      providers.push(root.ksu);
    }
    return providers;
  }

  async function appLabel(info, providers) {
    for (const label of [info.appLabel, info.label, info.getLabel]) {
      if (typeof label === 'string' && label.trim() && label !== info.packageName) return label;
    }
    if (typeof info.getLabel === 'function') {
      try {
        const label = await info.getLabel();
        if (typeof label === 'string' && label.trim()) return label;
      } catch (error) {}
    }
    for (const provider of providers) {
      if (typeof provider.getLabel !== 'function') continue;
      try {
        const label = await provider.getLabel(info.packageName);
        if (typeof label === 'string' && label.trim()) return label;
      } catch (error) {}
    }
    return info.packageName;
  }

  async function normalizeApps(infos, providers) {
    const apps = [];
    const seen = new Set();
    for (const info of infos) {
      if (!info || typeof info.packageName !== 'string' || !PACKAGE_NAME.test(info.packageName) || info.packageName.length > 255 || seen.has(info.packageName)) continue;
      seen.add(info.packageName);
      const uid = typeof info.uid === 'number' ? info.uid : null;
      const cachedIcon = icons.get(info.packageName);
      apps.push({
        packageName: info.packageName,
        appLabel: await appLabel(info, providers),
        isSystem: info.isSystem === true || info.isSystem === 1 || info.isSystem === 'true',
        uid: Number.isSafeInteger(uid) && uid >= 0 ? uid : null,
        icon: typeof cachedIcon === 'string' ? cachedIcon : null,
      });
    }
    return apps;
  }

  async function loadApps() {
    const providers = packageProviders();
    for (const provider of providers) {
      if (typeof provider.listPackages !== 'function' || typeof provider.getPackagesInfo !== 'function') continue;
      try {
        const rawPackages = await provider.listPackages('all');
        const packages = [...new Set(packageArray(rawPackages).filter((name) => typeof name === 'string' && PACKAGE_NAME.test(name) && name.length <= 255))];
        if (!packages.length) continue;
        const infos = new Map();
        for (let offset = 0; offset < packages.length; offset += 100) {
          if (typeof root.requestAnimationFrame === 'function') {
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          const batch = packages.slice(offset, offset + 100);
          const records = packageArray(await provider.getPackagesInfo(typeof rawPackages === 'string' ? JSON.stringify(batch) : batch));
          for (const info of records) {
            if (info && !info.error && batch.includes(info.packageName) && !infos.has(info.packageName)) infos.set(info.packageName, info);
          }
        }
        if (!infos.size) continue;
        return { ok: true, apps: await normalizeApps(packages.map((packageName) => infos.get(packageName) || { packageName }), providers), source: 'kernelsu' };
      } catch (error) {}
    }
    const discovered = await shJson('discovery.sh', ['apps']);
    if (!Array.isArray(discovered.apps)) throw new Error('应用列表不是 JSON 数组');
    return { ok: true, apps: await normalizeApps(discovered.apps, providers), source: 'package-manager' };
  }

  async function getInstalledApps(refresh) {
    if (!refresh && cachedApps) return cachedApps;
    if (!refresh && pendingApps) return pendingApps;
    if (refresh) {
      cachedApps = null;
      icons.clear();
    }
    const generation = ++appsGeneration;
    const pending = loadApps();
    pendingApps = pending;
    try {
      const result = await pending;
      if (generation === appsGeneration) cachedApps = result;
      return result;
    } finally {
      if (pendingApps === pending) pendingApps = null;
    }
  }

  async function iconDataURI(blob) {
    const type = (blob.type || 'image/png').toLowerCase();
    if (!/^image\/(?:png|jpeg|webp|gif|bmp|avif|x-icon|vnd\.microsoft\.icon)$/.test(type) || blob.size > 2097152 || blob.size === 0) throw new Error('应用图标类型或大小无效');
    if (typeof blob.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length || bytes.length > 2097152) throw new Error('应用图标大小无效');
      return 'data:' + type + ';base64,' + bytesBase64(bytes);
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取应用图标失败'));
      reader.onload = () => {
        if (typeof reader.result !== 'string' || !reader.result.startsWith('data:' + type + ';base64,')) reject(new Error('应用图标数据无效'));
        else resolve(reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function xhrIcon(url) {
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      let settled = false;
      let timer;
      const finish = (icon) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.onload = request.onerror = request.ontimeout = request.onabort = null;
        resolve(icon);
      };
      timer = setTimeout(() => {
        finish(null);
        request.abort();
      }, 15000);
      try {
        request.open('GET', url, true);
        request.responseType = 'blob';
        request.timeout = 15000;
        request.onload = async () => {
          try {
            if (request.status !== 0 && (request.status < 200 || request.status >= 300)) throw new Error('图标 HTTP ' + request.status);
            finish(await iconDataURI(request.response));
          } catch (error) { finish(null); }
        };
        request.onerror = request.ontimeout = request.onabort = () => finish(null);
        request.send();
      } catch (error) { finish(null); }
    });
  }

  async function readIcon(packageName) {
    const url = 'ksu://icon/' + encodeURIComponent(packageName);
    try {
      return await fetchResource(url, async (response) => iconDataURI(await response.blob()));
    } catch (error) {
      if (typeof XMLHttpRequest === 'function') {
        try { return await xhrIcon(url); } catch (xhrError) {}
      }
      return null;
    }
  }

  async function appIcon(packageName) {
    if (!icons.has(packageName)) {
      const pending = readIcon(packageName);
      icons.set(packageName, pending);
      const icon = await pending;
      if (icons.get(packageName) === pending) {
        icons.set(packageName, icon);
        if (cachedApps) {
          const app = cachedApps.apps.find((entry) => entry.packageName === packageName);
          if (app) app.icon = icon;
        }
      }
      return { ok: true, packageName, icon };
    }
    return { ok: true, packageName, icon: await icons.get(packageName) };
  }

  // ---------- 策略组图标 ----------
  // 先由浏览器直接下载（多数图标站允许跨域），失败时由模块脚本下载；结果缓存在 localStorage。
  const ICON_LIMIT = 262144;
  const ICON_CACHE_PREFIX = 'mihomo.icon:';
  const proxyIcons = new Map();

  function iconMime(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp';
    const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
    if (/^(<\?xml|<svg|<!--)/i.test(head) && /<svg/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'image/svg+xml';
    return '';
  }

  function iconCache(url, value) {
    try {
      const storage = root.localStorage;
      if (!storage) return '';
      if (value === undefined) return storage.getItem(ICON_CACHE_PREFIX + url) || '';
      storage.setItem(ICON_CACHE_PREFIX + url, value);
    } catch (error) {
      // 存储已满或被禁用时只用内存缓存
    }
    return '';
  }

  async function downloadIcon(url) {
    try {
      const response = await root.fetch(url, { mode: 'cors', credentials: 'omit' });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length && bytes.length <= ICON_LIMIT) return bytes;
      }
    } catch (error) {
      // 跨域或网络失败，改由模块下载
    }
    const result = await run('host.sh', ['icon', url], 20000);
    if (result.errno !== 0) throw new Error(result.stderr.trim() || '下载图标失败');
    return b64bytes(result.stdout);
  }

  function b64bytes(value) {
    const binary = atob(value.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function readProxyIcon(url) {
    if (url.startsWith('data:')) return url;
    const cached = iconCache(url);
    if (cached) return cached;
    const bytes = await downloadIcon(url);
    const mime = iconMime(bytes);
    if (!mime) throw new Error('不是图片');
    const icon = 'data:' + mime + ';base64,' + bytesBase64(bytes);
    iconCache(url, icon);
    return icon;
  }

  async function proxyIcon(url) {
    if (!proxyIcons.has(url)) {
      const pending = readProxyIcon(url).catch((error) => {
        proxyIcons.delete(url);
        throw error;
      });
      proxyIcons.set(url, pending);
    }
    return { ok: true, icon: await proxyIcons.get(url) };
  }

  function assertObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是 JSON 对象');
  }

  function onlyKeys(value, keys) {
    assertObject(value);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error('不支持的参数：' + key);
  }

  function text(value, name, optional = false) {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(name + ' 必须为不含 NUL 的字符串');
    return value;
  }

  function boolean(value, name, optional = false) {
    if (optional && value === undefined) return;
    if (typeof value !== 'boolean') throw new Error(name + ' 必须为布尔值');
  }

  function oneOf(value, values, name) {
    if (!values.includes(value)) throw new Error('不支持的 ' + name);
  }

  function httpUrl(value, name, optional = false) {
    text(value, name);
    if (optional && value === '') return;
    if (!/^https?:\/\//.test(value) || /[\x00-\x20\x7f]/.test(value)) throw new Error(name + ' 必须为 http:// 或 https:// 地址');
    try {
      const parsed = new URL(value);
      if (!parsed.hostname) throw new Error('缺少主机名');
    } catch (error) { throw new Error(name + ' 地址无效'); }
  }

  function validPackage(value) {
    text(value, 'packageName');
    if (!PACKAGE_NAME.test(value) || value.length > 255) throw new Error('包名格式无效');
  }

  function validBackup(value) {
    text(value, 'name');
    if (!/^config-[A-Za-z0-9_.-]*\.yaml(?![\s\S])/.test(value) || value.length > 255) throw new Error('备份文件名无效');
  }

  function validPolicy(payload) {
    boolean(payload.autostart, 'autostart');
    boolean(payload.tethering, 'tethering');
    oneOf(payload.wifi_mode, ['off', 'only', 'exclude'], 'wifi_mode');
    for (const name of ['tethering_interfaces', 'bypass_packages', 'wifi_ssids']) {
      text(payload[name], name);
      payload[name] = payload[name].replace(/\r\n?/g, '\n');
      if (/[\x00-\x09\x0b-\x1f\x7f]/.test(payload[name]) || new TextEncoder().encode(payload[name]).length > 32768) throw new Error(name + ' 过长或含控制字符');
    }
    payload.tethering_interfaces = payload.tethering_interfaces || DEFAULT_INTERFACES;
    if (payload.tethering_interfaces.split(',').some((name) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}(?![\s\S])/.test(name))) throw new Error('接口须为逗号分隔的有效网卡名称');
    if (payload.bypass_packages.split('\n').some((name) => name && (!PACKAGE_NAME.test(name) || !name.includes('.')))) throw new Error('包名格式无效');
    if (payload.wifi_ssids.split('\n').some((name) => new TextEncoder().encode(name).length > 32)) throw new Error('SSID 不能超过 32 字节');
  }

  function validController(payload) {
    text(payload.path, 'path');
    if (!/^\/(?:version|proxies|connections|group\/[^/?]+\/delay)(?:[/?]|$)/.test(payload.path) || /[\x00-\x20\x7f#\\]/.test(payload.path)) throw new Error('不支持的控制器接口（不读取流接口）');
    const pathname = payload.path.split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(pathname); }
    catch (error) { throw new Error('控制器路径编码无效'); }
    if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('控制器路径无效');
    oneOf(payload.method === undefined ? 'GET' : payload.method, ['GET', 'PUT', 'DELETE'], '控制器操作');
    if (payload.body !== undefined) {
      const body = typeof payload.body === 'string' ? text(payload.body, 'body') : JSON.stringify(payload.body);
      try { JSON.parse(body); } catch (error) { throw new Error('控制器 body 必须为 JSON'); }
      if (new TextEncoder().encode(body).length > 90000) throw new Error('控制器 body 过大');
    }
    if (payload.path.length > 8192) throw new Error('控制器路径过长');
  }

  function validTemplate(payload) {
    if (!Array.isArray(payload.subscriptions) || !payload.subscriptions.length) throw new Error('请添加订阅');
    const names = new Set();
    for (const subscription of payload.subscriptions) {
      onlyKeys(subscription, ['name', 'url', 'ua']);
      text(subscription.name, '订阅名称');
      if (!subscription.name.trim() || /[\r\n]/.test(subscription.name) || names.has(subscription.name)) throw new Error('订阅名称不能为空或重复');
      names.add(subscription.name);
      httpUrl(subscription.url, '订阅地址');
      if (subscription.ua != null) {
        text(subscription.ua, 'UA');
        if (/[\r\n]/.test(subscription.ua)) throw new Error('UA 不能包含换行');
      }
    }
    payload.secret = text(payload.secret, 'secret', true);
    if (/[\r\n]/.test(payload.secret)) throw new Error('控制器密钥不能包含换行');
    if (!payload.secret) payload.secret = Array.from(root.crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    payload.uiUrl = payload.uiUrl === undefined ? 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip' : payload.uiUrl;
    payload.rulesUrl = payload.rulesUrl === undefined ? 'https://github.com/DustinWin/ruleset_geodata/raw/refs/heads/mihomo-ruleset/fakeip-filter.mrs' : payload.rulesUrl;
    httpUrl(payload.uiUrl, 'uiUrl', true);
    httpUrl(payload.rulesUrl, 'rulesUrl');
  }

  const operations = Object.create(null);

  function register(name, keys, validate, run) {
    operations[name] = { keys, validate, run };
  }

  const noValidation = () => {};
  for (const [name, command, timeout] of [
    ['status', 'mihomo.sh status'], ['coreGetSet', 'core.sh get_settings'],
    ['coreUpdate', 'core.sh download', 1320000], ['coreRollback', 'core.sh rollback'],
    ['backups', 'backup.sh list'], ['policyGet', 'policy.sh get'],
    ['discoveryInterfaces', 'discovery.sh interfaces', 15000],
    ['onboardingState', 'onboarding.sh get'], ['onboardingComplete', 'onboarding.sh complete'],
  ]) register(name, [], noValidation, () => shJson(command.split(' ')[0], command.split(' ').slice(1), timeout));

  register('service', ['action'], (payload) => oneOf(payload.action, ['start', 'stop', 'restart'], '服务操作'), (payload) => service(payload.action));
  register('coreInfo', [], noValidation, async () => {
    const info = await shJson('core.sh', ['info']);
    return { ...info, installed: info.installed === true, version: String(info.version || ''), can_rollback: info.can_rollback === true || info.can_rollback === 'yes' };
  });
  register('coreSet', ['repo', 'tag', 'mirror'], (payload) => {
    for (const name of ['repo', 'tag', 'mirror']) {
      payload[name] = text(payload[name], name, true);
      if (/[\r\n]/.test(payload[name]) || payload[name].length > 4096) throw new Error('下载设置格式无效');
    }
    if (payload.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repo)) throw new Error('仓库格式须为 owner/repo');
    httpUrl(payload.mirror, 'mirror', true);
  }, (payload) => shJson('core.sh', ['settings'].concat([payload.repo, payload.tag, payload.mirror].map((value) => value || '-'))));
  register('configRead', [], noValidation, async () => {
    const result = await run('host.sh', ['read-config']);
    if (result.errno !== 0 || !result.stdout.trim()) throw new Error(result.stderr || '读取配置失败（文件不存在？）');
    return { ok: true, content: b64decode(result.stdout) };
  });
  register('validate', ['content'], (payload) => text(payload.content, 'content'), async (payload) => {
    const staged = await stageConfig(payload.content);
    const result = await run('host.sh', ['validate', staged.inline || '--staged'], 120000);
    if (result.errno !== 0) throw new Error((result.stderr || result.stdout || '校验失败').trim().split('\n').slice(-5).join('\n'));
    return { ok: true };
  });
  register('apply', ['content', 'restart'], (payload) => { text(payload.content, 'content'); boolean(payload.restart, 'restart', true); }, (payload) => apply(payload.content, payload.restart));
  for (const [name, command] of [['backupDel', 'delete'], ['backupRestore', 'restore']]) {
    register(name, ['name'], (payload) => validBackup(payload.name), (payload) => shJson('backup.sh', [command, payload.name]));
  }
  register('backupRead', ['name'], (payload) => validBackup(payload.name), async (payload) => {
    const result = await run('backup.sh', ['read', payload.name]);
    if (result.errno !== 0 || !result.stdout.trim() || result.stdout.trim().startsWith('{')) {
      let message = result.stderr || '读取备份失败';
      try { message = JSON.parse(result.stdout).error || message; } catch (error) {}
      throw new Error(message);
    }
    return { ok: true, content: b64decode(result.stdout) };
  });
  register('logs', ['lines'], (payload) => {
    if (payload.lines !== undefined && (!Number.isInteger(payload.lines) || payload.lines < 1 || payload.lines > 10000)) throw new Error('lines 必须为 1–10000 的整数');
  }, async (payload) => {
    const result = await run('host.sh', ['logs', String(payload.lines || 200)]);
    if (result.errno !== 0) throw new Error(result.stderr || '读取日志失败');
    return { ok: true, content: result.stdout || result.stderr || '' };
  });
  register('policySet', ['autostart', 'tethering', 'tethering_interfaces', 'bypass_packages', 'wifi_mode', 'wifi_ssids'], validPolicy, (payload) => shJson('policy.sh', ['set',
    payload.autostart ? '1' : '0', payload.tethering ? '1' : '0', b64encode(payload.tethering_interfaces),
    b64encode(payload.bypass_packages), payload.wifi_mode, b64encode(payload.wifi_ssids),
  ], 120000));
  register('controller', ['path', 'method', 'body'], validController, controller);
  register('apps', ['refresh'], (payload) => boolean(payload.refresh, 'refresh', true), (payload) => getInstalledApps(payload.refresh));
  register('appIcon', ['packageName'], (payload) => validPackage(payload.packageName), (payload) => appIcon(payload.packageName));
  register('proxyIcon', ['url'], (payload) => {
    text(payload.url, 'url');
    if (payload.url.length > 2048 || !/^(https?:\/\/[^\s]+|data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)$/i.test(payload.url)) throw new Error('图标地址无效');
  }, (payload) => proxyIcon(payload.url));
  register('template', ['subscriptions', 'secret', 'uiUrl', 'rulesUrl'], validTemplate, async (payload) => ({
    ok: true, content: renderTemplate(await fetchResource('template.yaml', (response) => response.text()), payload),
  }));

  const engine = () => {
    if (!root.mihomoConfig) throw new Error('配置引擎未加载，请重新安装完整模块');
    return root.mihomoConfig;
  };
  register('hostProbe', [], noValidation, () => shJson('host.sh', ['probe'], 20000));
  register('importUrl', ['url', 'ua'], (payload) => {
    httpUrl(payload.url, '链接');
    payload.ua = text(payload.ua, 'UA', true);
    if (/[\r\n]/.test(payload.ua) || payload.ua.length > 256) throw new Error('UA 无效');
  }, async (payload) => {
    await shJson('host.sh', ['fetch', payload.url, payload.ua || 'clash.meta'], 90000);
    const result = await run('host.sh', ['import-read'], 30000);
    if (result.errno !== 0 || !result.stdout.trim()) throw new Error(result.stderr || '读取下载内容失败');
    return { ok: true, content: b64decode(result.stdout.trim()) };
  });
  register('configSchema', ['content'], (payload) => text(payload.content, 'content'), (payload) => engine().schema(payload.content));
  register('configAnalyze', ['content'], (payload) => text(payload.content, 'content'), (payload) => engine().analyze(payload.content));
  register('configPatch', ['content', 'ops'], (payload) => {
    text(payload.content, 'content');
    if (!Array.isArray(payload.ops)) throw new Error('ops 必须为数组');
  }, (payload) => engine().patch(payload.content, payload.ops));
  register('configOptimize', ['content', 'host', 'skip'], (payload) => {
    text(payload.content, 'content');
    if (payload.host !== undefined) assertObject(payload.host);
    if (payload.skip !== undefined && (!Array.isArray(payload.skip) || payload.skip.some((item) => typeof item !== 'string'))) throw new Error('skip 必须为字符串数组');
  }, (payload) => engine().optimize(payload.content, payload.host || {}, { skip: payload.skip || [] }));

  // ---------- Tailscale ----------
  // 登录状态来自状态目录里的 tailscaled.state（只解码 _current-profile 与 _profiles，与 LuCI system.uc 一致）。

  // 与 mihomo 一致：缺省为 tailscale，相对路径相对于数据目录；只接受数据目录之内的路径
  function tailscaleDir(stateDir) {
    const dir = stateDir || 'tailscale';
    const full = (dir.startsWith('/') ? dir : DATA + '/' + dir.replace(/^(?:\.\/)+/, '')).replace(/\/+$/, '');
    if (('/' + full + '/').includes('/../') || ('/' + full + '/').includes('/./') || !full.startsWith(DATA + '/')) return null;
    return full;
  }

  function tailscaleProfile(state) {
    const empty = { loggedIn: false, login: null, tailnet: null, magicDns: null };
    if (!state || !state.exists || !state.current || !state.profiles) return empty;
    let current;
    let profiles;
    try {
      current = b64decode(state.current);
      profiles = JSON.parse(b64decode(state.profiles));
    } catch (error) {
      return empty;
    }
    if (!profiles || typeof profiles !== 'object') return empty;
    const profile = Object.entries(profiles).map(([id, item]) => (item && typeof item === 'object' && (item.Key === current || 'profile-' + id === current) ? item : null)).find(Boolean);
    if (!profile) return empty;
    return {
      loggedIn: typeof profile.NodeID === 'string' && profile.NodeID !== '',
      login: (profile.UserProfile && profile.UserProfile.LoginName) || null,
      tailnet: (profile.NetworkProfile && profile.NetworkProfile.DomainName) || null,
      magicDns: (profile.NetworkProfile && profile.NetworkProfile.MagicDNSName) || null,
    };
  }

  async function tailscaleEntries() {
    const read = await operations.configRead.run({});
    return engine().schema(read.content).tailscale;
  }

  async function tailscaleEntry(name) {
    const entry = (await tailscaleEntries()).find((item) => item.name === name);
    if (!entry) throw new Error('配置中没有名为 ' + name + ' 的 Tailscale 出站');
    const dir = tailscaleDir(entry.stateDir);
    if (!dir) throw new Error('state-dir 必须在数据目录之内');
    return { entry, dir };
  }

  const tailscaleName = (payload) => {
    payload.name = text(payload.name, 'name');
    if (!payload.name || payload.name.length > 128 || /[\r\n]/.test(payload.name)) throw new Error('出站名无效');
  };

  register('tailscaleStatus', [], noValidation, async () => {
    const list = [];
    for (const entry of await tailscaleEntries()) {
      const dir = tailscaleDir(entry.stateDir);
      const state = dir ? await shJson('tailscale.sh', ['state', dir]) : null;
      list.push({ name: entry.name, stateDir: dir, authKey: entry.used, ...tailscaleProfile(state) });
    }
    return { ok: true, list };
  });
  register('tailscaleLogin', ['name', 'wait'], (payload) => {
    tailscaleName(payload);
    if (payload.wait !== undefined && (!Number.isInteger(payload.wait) || payload.wait < 5 || payload.wait > 60)) throw new Error('wait 必须为 5–60 的整数');
  }, async (payload) => {
    await tailscaleEntry(payload.name);
    const detected = await detectController();
    const wait = payload.wait || 20;
    const path = encodeURIComponent(payload.name).replace(/[!'()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase());
    return shJson('tailscale.sh', ['login', detected.address, path, JSON.stringify(payload.name).slice(1, -1), String(wait)],
      (wait + 20) * 1000, { MIHOMO_SECRET: detected.secret });
  });
  register('tailscaleLogout', ['name'], tailscaleName, async (payload) => {
    const { dir } = await tailscaleEntry(payload.name);
    return shJson('tailscale.sh', ['logout', dir], 120000);
  });
  register('openUrl', ['url'], (payload) => httpUrl(payload.url, 'url'), (payload) => {
    // 网页管理时在当前浏览器打开；在管理器里用系统浏览器打开
    if (remoteMode()) {
      root.open(payload.url, '_blank', 'noopener');
      return { ok: true };
    }
    return shJson('tailscale.sh', ['open', payload.url]);
  });
  register('qrCode', ['text'], (payload) => {
    text(payload.text, 'text');
    if (!payload.text || payload.text.length > 1024) throw new Error('二维码内容须为 1–1024 个字符');
  }, async (payload) => {
    if (typeof root.qrcode !== 'function') throw new Error('二维码组件未加载，请重新安装完整模块');
    const code = root.qrcode(0, 'M');
    code.addData(payload.text, 'Byte');
    code.make();
    const size = code.getModuleCount();
    const rows = [];
    for (let row = 0; row < size; row++) {
      let line = '';
      for (let column = 0; column < size; column++) line += code.isDark(row, column) ? '1' : '0';
      rows.push(line);
    }
    return { ok: true, size, rows };
  });

  // ---------- 网页管理 ----------
  const WEBUI_KEYS = ['enabled', 'port', 'lan', 'allow_cidrs', 'require_password', 'tailscale', 'tailscale_no_password', 'tailscale_users', 'session_hours'];

  register('webuiStatus', [], noValidation, () => shJson('webui.sh', ['status'], 20000));
  register('webuiSet', ['settings'], (payload) => {
    assertObject(payload.settings);
    for (const [key, value] of Object.entries(payload.settings)) {
      if (!WEBUI_KEYS.includes(key)) throw new Error('不支持的设置：' + key);
      if (['enabled', 'lan', 'require_password', 'tailscale', 'tailscale_no_password'].includes(key)) boolean(value, key);
      else if (key === 'port' || key === 'session_hours') {
        if (!Number.isInteger(value)) throw new Error(key + ' 必须为整数');
      } else if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || /[\s,]/.test(item) || item.length > 254)) {
        throw new Error(key + ' 必须为不含空白的字符串列表');
      }
    }
  }, (payload) => shJson('webui.sh', ['set', b64encode(JSON.stringify(payload.settings))], 30000));
  register('webuiPasswd', ['password'], (payload) => {
    text(payload.password, 'password');
    if (payload.password && (payload.password.length < 6 || payload.password.length > 256)) throw new Error('密码须为 6–256 个字符');
  }, (payload) => shJson('webui.sh', ['passwd', b64encode(payload.password)], 30000));
  // 当前页面是否经网页管理打开，以及来源（lan / tailscale / local）
  register('webuiSession', [], noValidation, async () => {
    if (!remoteMode()) return { ok: true, remote: false };
    const response = await root.fetch('api/session', { credentials: 'same-origin', headers: { 'X-Mihomo-Request': '1' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ('网页服务 HTTP ' + response.status));
    return { ok: true, remote: true, via: String(body.via || ''), login: String(body.login || ''), passwordless: body.passwordless === true };
  });
  register('webuiLogout', [], noValidation, async () => {
    if (!remoteMode()) return { ok: true };
    await root.fetch('api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Mihomo-Request': '1' } });
    root.location.href = 'login';
    return { ok: true };
  });

  // zashboard：内核在 /ui/ 提供面板；setup 参数让面板自动添加并连接本机控制器
  register('dashboard', [], noValidation, async () => {
    const detected = await detectController();
    if (!detected.ui) return { ok: true, available: false, reason: '配置里没有 external-ui，面板未启用' };
    const params = new URLSearchParams({ disableUpgradeCore: '1' });
    if (detected.secret) params.set('secret', detected.secret);
    if (remoteMode()) {
      // 经网页管理的 /clash/ 反向代理访问控制器
      const location = root.location;
      const https = location.protocol === 'https:';
      params.set('hostname', location.hostname);
      params.set('port', location.port || (https ? '443' : '80'));
      params.set('secondaryPath', '/clash');
      params.set(https ? 'https' : 'http', '1');
      return { ok: true, available: true, url: location.origin + '/clash/ui/#/setup?' + params.toString() };
    }
    const port = detected.address.slice(detected.address.lastIndexOf(':') + 1);
    const host = detected.address.slice('http://'.length, detected.address.lastIndexOf(':')).replace(/^\[|\]$/g, '');
    params.set('hostname', host);
    params.set('port', port);
    return { ok: true, available: true, url: detected.address + '/ui/#/setup?' + params.toString() };
  });

  root.mihomoBridge = Object.freeze({
    async request(operation, payloadJson = '{}') {
      try {
        if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(operations, operation)) throw new Error('不支持的操作');
        if (typeof payloadJson !== 'string') throw new Error('payloadJson 必须为 JSON 字符串');
        const payload = JSON.parse(payloadJson);
        const handler = operations[operation];
        onlyKeys(payload, handler.keys);
        handler.validate(payload);
        return JSON.stringify(await handler.run(payload));
      } catch (error) {
        return JSON.stringify({ ok: false, error: String(error && error.message || error || '未知错误') });
      }
    },
  });
})(window);
