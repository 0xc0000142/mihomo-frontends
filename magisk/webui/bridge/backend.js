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
      await shJson(SH + 'host.sh stage ' + index + ' ' + shq(encoded.slice(offset, offset + STAGE_CHUNK)), 30000);
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
        if (!root.ksu || typeof root.ksu.exec !== 'function') throw new Error('请在 KernelSU/Magisk WebUI 中打开');
        root.ksu.exec(command, '{}', callbackName);
      } catch (error) {
        finish({ errno: -1, stdout: '', stderr: 'ksu.exec 不可用：' + error.message });
      }
    });
  }

  root.addEventListener('pagehide', () => {
    for (const finish of callbacks.values()) finish({ errno: -1, stdout: '', stderr: '页面已关闭，操作结果未知' });
  });

  async function shJson(command, timeout) {
    const result = await exec(command, timeout);
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
    try { return await shJson(SH + 'mihomo.sh status'); }
    catch (error) { throw new Error(prefix + error.message); }
  }

  async function service(action) {
    const result = await exec(SH + 'mihomo.sh ' + action, 120000);
    if (result.errno !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || ('服务操作失败（退出码 ' + result.errno + '）'));
    const status = await readStatus('操作已返回，但无法确认服务状态：');
    if (action !== 'stop' && isSSIDPaused(status)) return { ok: true, paused: true, message: ssidPauseMessage(status) };
    if (action === 'stop' && ['manual', 'auto'].includes(status.desired)) throw new Error('服务仍处于启用状态，自动恢复意图未取消，请刷新确认');
    if (status.running !== (action !== 'stop')) throw new Error(action === 'stop' ? '服务仍在运行' : '服务未运行，请检查 SSID 策略和日志');
    return { ok: true, paused: false, message: action === 'stop' ? '服务已停止' : '服务已启动' };
  }

  async function apply(content, restart) {
    const staged = await stageConfig(content);
    const source = staged.inline ? shq(staged.inline) : '--staged';
    const result = await shJson(SH + 'apply.sh ' + source + (restart ? ' restart' : ''), 120000);
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
    const result = await exec('grep -E "^(external-controller|secret):" ' + shq(CONFIG) + ' 2>/dev/null');
    if (result.errno !== 0 && result.errno !== 1) throw new Error(result.stderr || '读取控制器配置失败');
    let address = null;
    let secret = '';
    for (const line of result.stdout.split('\n')) {
      const match = /^(external-controller|secret):\s*(.*)$/.exec(line);
      if (!match) continue;
      if (match[1] === 'external-controller') address = yamlScalar(match[2]);
      else secret = yamlScalar(match[2]);
    }
    if (!address) throw new Error('配置中没有 external-controller');
    if (!/^(?:\[[\da-fA-F:]+\]|[\w.*-]*):\d{1,5}$/.test(address)) throw new Error('external-controller 地址无效');
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) throw new Error('external-controller 端口无效');
    address = address.replace(/^(?:0\.0\.0\.0|\[::\]|\*|)(?=:)/, '127.0.0.1');
    if (/[\r\n\0]/.test(secret)) throw new Error('控制器密钥不能包含换行');
    return { address: 'http://' + address, secret };
  }

  async function controller(payload) {
    const detected = await detectController();
    const args = ['--disable', '--silent', '--show-error', '--globoff', '--noproxy', '*',
      '--connect-timeout', '3', '--max-time', '8', '--request', payload.method || 'GET',
      '--header', 'Authorization: Bearer ' + detected.secret,
      '--write-out', '\n__MIHOMO_HTTP__:%{http_code}'];
    if (payload.body !== undefined) {
      args.push('--header', 'Content-Type: application/json', '--data-binary', typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body));
    }
    args.push('--url', detected.address + payload.path);
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
    if (status === 204 || !body) return { ok: true, data: null };
    try { return { ok: true, data: JSON.parse(body) }; }
    catch (error) { throw new Error('控制器响应不是 JSON'); }
  }

  function renderTemplate(template, payload) {
    const output = [];
    for (const line of template.split(/\r?\n/)) {
      const marker = line.trim();
      if (marker === '#@providers') {
        for (const subscription of payload.subscriptions) {
          output.push('  ' + JSON.stringify(subscription.name) + ':', '    <<: *p', '    url: ' + JSON.stringify(subscription.url));
          if (subscription.ua) output.push('    header: {User-Agent: [' + JSON.stringify(subscription.ua) + ']}');
          output.push('    path: ' + JSON.stringify('./providers/' + encodeURIComponent(subscription.name) + '.yaml'));
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
    const discovered = await shJson(SH + 'discovery.sh apps');
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
    if (!/^\/(?:version|proxies|connections)(?:[/?]|$)/.test(payload.path) || /[\x00-\x20\x7f#\\]/.test(payload.path)) throw new Error('不支持的控制器接口（不读取流接口）');
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
  ]) register(name, [], noValidation, () => shJson(SH + command, timeout));

  register('service', ['action'], (payload) => oneOf(payload.action, ['start', 'stop', 'restart'], '服务操作'), (payload) => service(payload.action));
  register('coreInfo', [], noValidation, async () => {
    const info = await shJson(SH + 'core.sh info');
    return { ...info, installed: info.installed === true, version: String(info.version || ''), can_rollback: info.can_rollback === true || info.can_rollback === 'yes' };
  });
  register('coreSet', ['repo', 'tag', 'mirror'], (payload) => {
    for (const name of ['repo', 'tag', 'mirror']) {
      payload[name] = text(payload[name], name, true);
      if (/[\r\n]/.test(payload[name]) || payload[name].length > 4096) throw new Error('下载设置格式无效');
    }
    if (payload.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(payload.repo)) throw new Error('仓库格式须为 owner/repo');
    httpUrl(payload.mirror, 'mirror', true);
  }, (payload) => shJson(SH + 'core.sh settings ' + [payload.repo, payload.tag, payload.mirror].map((value) => shq(value || '-')).join(' ')));
  register('configRead', [], noValidation, async () => {
    const result = await exec('base64 -w 0 ' + shq(CONFIG) + ' 2>/dev/null || base64 ' + shq(CONFIG) + ' | tr -d "\\n"');
    if (result.errno !== 0 || !result.stdout.trim()) throw new Error(result.stderr || '读取配置失败（文件不存在？）');
    return { ok: true, content: b64decode(result.stdout) };
  });
  register('validate', ['content'], (payload) => text(payload.content, 'content'), async (payload) => {
    const staged = await stageConfig(payload.content);
    const input = staged.inline ? 'printf %s ' + shq(staged.inline) + ' | base64 -d' : 'base64 -d < ' + shq(DATA + '/run/stage.b64');
    const cleanup = staged.inline ? '' : ' rm -f ' + shq(DATA + '/run/stage.b64') + ';';
    const result = await exec('(tmp=$(mktemp) || exit 1; trap \'rm -f "$tmp";' + cleanup + '\' EXIT; ' + input + ' > "$tmp" && /data/adb/mihomo/mihomo -d ' + shq(DATA) + ' -f "$tmp" -t)', 120000);
    if (result.errno !== 0) throw new Error((result.stderr || result.stdout || '校验失败').trim().split('\n').slice(-5).join('\n'));
    return { ok: true };
  });
  register('apply', ['content', 'restart'], (payload) => { text(payload.content, 'content'); boolean(payload.restart, 'restart', true); }, (payload) => apply(payload.content, payload.restart));
  for (const [name, command] of [['backupDel', 'delete'], ['backupRestore', 'restore']]) {
    register(name, ['name'], (payload) => validBackup(payload.name), (payload) => shJson(SH + 'backup.sh ' + command + ' ' + shq(payload.name)));
  }
  register('backupRead', ['name'], (payload) => validBackup(payload.name), async (payload) => {
    const result = await exec(SH + 'backup.sh read ' + shq(payload.name));
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
    const result = await exec('tail -n ' + (payload.lines || 200) + ' ' + shq(DATA + '/run/mihomo.log') + ' 2>/dev/null; logcat -d -s mihomo:* 2>/dev/null | tail -n 50');
    if (result.errno !== 0) throw new Error(result.stderr || '读取日志失败');
    return { ok: true, content: result.stdout || result.stderr || '' };
  });
  register('policySet', ['autostart', 'tethering', 'tethering_interfaces', 'bypass_packages', 'wifi_mode', 'wifi_ssids'], validPolicy, (payload) => shJson(SH + 'policy.sh set ' + [
    payload.autostart ? '1' : '0', payload.tethering ? '1' : '0', shq(b64encode(payload.tethering_interfaces)),
    shq(b64encode(payload.bypass_packages)), shq(payload.wifi_mode), shq(b64encode(payload.wifi_ssids)),
  ].join(' '), 120000));
  register('controller', ['path', 'method', 'body'], validController, controller);
  register('apps', ['refresh'], (payload) => boolean(payload.refresh, 'refresh', true), (payload) => getInstalledApps(payload.refresh));
  register('appIcon', ['packageName'], (payload) => validPackage(payload.packageName), (payload) => appIcon(payload.packageName));
  register('template', ['subscriptions', 'secret', 'uiUrl', 'rulesUrl'], validTemplate, async (payload) => ({
    ok: true, content: renderTemplate(await fetchResource('template.yaml', (response) => response.text()), payload),
  }));

  const engine = () => {
    if (!root.mihomoConfig) throw new Error('配置引擎未加载，请重新安装完整模块');
    return root.mihomoConfig;
  };
  register('hostProbe', [], noValidation, () => shJson(SH + 'host.sh probe', 20000));
  register('importUrl', ['url', 'ua'], (payload) => {
    httpUrl(payload.url, '链接');
    payload.ua = text(payload.ua, 'UA', true);
    if (/[\r\n]/.test(payload.ua) || payload.ua.length > 256) throw new Error('UA 无效');
  }, async (payload) => {
    await shJson(SH + 'host.sh fetch ' + shq(payload.url) + ' ' + shq(payload.ua || 'clash.meta'), 90000);
    const file = shq(DATA + '/run/import.yaml');
    const result = await exec('(base64 -w 0 ' + file + ' 2>/dev/null || base64 ' + file + ' | tr -d "\\n"); status=$?; rm -f ' + file + '; exit $status', 30000);
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
