'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../webroot/js/app.js'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '../../shared/template.yaml'), 'utf8');
const indexHTML = fs.readFileSync(path.join(__dirname, '../webroot/index.html'), 'utf8');
const defaultPolicy = {
  ok: true, autostart: false, tethering: false,
  tethering_interfaces: 'ap0,wlan1,rndis0,usb0,bt-pan', bypass_packages: '',
  wifi_mode: 'off', wifi_ssids: '', current_ssid: '家庭 Wi-Fi', allowed: true,
};

function decodeHTML(text) {
  return text.replace(/&(amp|lt|gt|quot);/g, (match, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[name]));
}

class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tag = tag;
    this.attributes = attributes;
    this.id = attributes.id;
    this.className = attributes.class || '';
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    }
    this.children = [];
    this.style = {};
    this.disabled = 'disabled' in attributes;
    this.checked = 'checked' in attributes;
    this.value = attributes.value || '';
    this.text = '';
    this.classList = {
      add: (n) => { const s = new Set(this.className.split(' ').filter(Boolean)); s.add(n); this.className = Array.from(s).join(' '); },
      remove: (n) => { const s = new Set(this.className.split(' ').filter(Boolean)); s.delete(n); this.className = Array.from(s).join(' '); },
      toggle: (n, f) => { const s = new Set(this.className.split(' ').filter(Boolean)); const a = f !== undefined ? f : !s.has(n); if (a) s.add(n); else s.delete(n); this.className = Array.from(s).join(' '); },
      contains: (n) => this.className.split(' ').filter(Boolean).includes(n),
    };
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }

  addEventListener(name, handler) {
    this['on' + name] = handler;
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:=([^\]]+))?\]$/.exec(selector);
    if (attribute) {
      const expected = attribute[2] !== undefined ? attribute[2].replace(/^["']|["']$/g, '') : undefined;
      return attribute[1] in this.attributes && (expected === undefined || this.attributes[attribute[1]] === expected);
    }
    return this.tag === selector;
  }

  closest(selector) {
    return this.matches(selector) ? this : this.parent && this.parent.closest(selector);
  }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  set textContent(value) {
    this.children = [];
    this.text = String(value);
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(html) {
    this.html = html;
    this.children = [];
    this.text = '';
    const stack = [this];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
      } else if (token.startsWith('<')) {
        const tag = /^<([\w-]+)/.exec(token);
        if (!tag) continue;
        const attributes = {};
        const attributeText = token.slice(tag[0].length, -1);
        for (const match of attributeText.matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s>]+))?/g)) {
          attributes[match[1]] = decodeHTML(match[2] ?? match[3] ?? '');
        }
        const child = new Element(tag[1], attributes);
        stack.at(-1).appendChild(child);
        if (!['input', 'br', 'hr', 'meta', 'img'].includes(child.tag)) stack.push(child);
      } else {
        const current = stack.at(-1);
        current.text += decodeHTML(token);
        if (current.tag === 'textarea') current.value += decodeHTML(token);
      }
    }
    for (const select of this.querySelectorAll('select')) {
      const options = select.querySelectorAll('option');
      select.value = (options.find((option) => 'selected' in option.attributes) || options[0] || {}).value;
    }
  }

  get innerHTML() {
    return this.html || '';
  }
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quoted = false;
  let present = false;
  for (let offset = 0; offset < command.length; offset++) {
    const char = command[offset];
    if (char === "'") { quoted = !quoted; present = true; }
    else if (char === '\\' && !quoted) { word += command[++offset]; present = true; }
    else if (/\s/.test(char) && !quoted) {
      if (present) words.push(word);
      word = ''; present = false;
    } else { word += char; present = true; }
  }
  assert.equal(quoted, false, 'shell quotes must balance');
  if (present) words.push(word);
  return words;
}

function jsonResult(value, errno = 0) {
  return { errno, stdout: JSON.stringify(value), stderr: '' };
}

function httpResult(body, status = 200) {
  return { errno: 0, stdout: (body == null ? '' : JSON.stringify(body)) + '\n__MIHOMO_HTTP__:' + status, stderr: '' };
}

function isCurlCommand(command) {
  return command.startsWith('(if [ -x /system/bin/curl ];');
}

function curlArguments(command) {
  assert.ok(isCurlCommand(command));
  const marker = '; "$curl_bin" ';
  const offset = command.indexOf(marker);
  assert.notEqual(offset, -1);
  assert.ok(command.endsWith(')'));
  return shellWords(command.slice(offset + marker.length, -1));
}

async function makeApp(options = {}) {
  const body = new Element('body');
  body.innerHTML = '<div id="view"></div><nav id="tabs"></nav><span id="svc-pill"></span><span id="ver-pill"></span><button id="btn-refresh"></button><div id="modal-container"></div>';
  const timers = new Map();
  const events = {};
  const commands = [];
  const fetches = [];
  let timerSequence = 0;
  let context;
  const app = {
    body, timers, events, commands, fetches, handler: options.handler,
    policy: { ...defaultPolicy, ...options.policy }, running: false,
    status: { desired: 'stopped', allowed: true, current_ssid: '', ...options.status },
    version: options.version || 'test',
    installed: options.installed ?? true, fetchStatus: options.fetchStatus || 200,
    element: (id) => [body, ...body.querySelectorAll('[id]')].find((element) => element.id === id) || null,
    run: (code) => vm.runInContext(code, context),
    flush: async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); },
    pendingCallbacks: () => Object.keys(context).filter((name) => name.startsWith('__mihomo_cb_')),
    advance: (milliseconds) => {
      for (const [timer, entry] of [...timers]) {
        if (entry.delay <= milliseconds) { timers.delete(timer); entry.callback(); }
      }
    },
  };
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    location: { hash: '#/logs' }, confirm: () => true,
    setTimeout: (callback, delay) => { const timer = ++timerSequence; timers.set(timer, { callback, delay }); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    addEventListener: (name, callback) => { events[name] = callback; },
    document: { body, getElementById: app.element, createElement: (tag) => new Element(tag), querySelectorAll: () => [], addEventListener() {} },
    fetch: async (url) => {
      fetches.push(url);
      assert.equal(url, 'template.yaml', 'controller requests must not use WebView fetch');
      return { ok: app.fetchStatus === 200, status: app.fetchStatus, text: async () => template };
    },
    ksu: {
      exec(command, opts, callbackName) {
        commands.push(command);
        assert.equal(opts, '{}');
        let result = app.handler && app.handler(command, callbackName);
        if (result === null) return;
        if (result === undefined) {
          if (command.endsWith('mihomo.sh status')) result = jsonResult({ ok: true, running: app.running, pid: 123, ...app.status });
          else if (command.endsWith('core.sh info')) result = jsonResult({ ok: true, installed: app.installed, version: app.version, platform: 'android' });
          else if (command.endsWith('policy.sh get')) result = jsonResult(app.policy);
          else if (command.includes('policy.sh set')) result = jsonResult({ ok: true });
          else if (command.startsWith('grep -E')) result = { errno: 0, stdout: 'external-controller: 127.0.0.1:9090\nsecret: "test"', stderr: '' };
          else if (isCurlCommand(command)) result = httpResult({ version: 'test', proxies: {}, connections: [] });
          else if (command.includes('apply.sh ')) { app.running = command.endsWith(' restart') || app.running; result = jsonResult({ ok: true }); }
          else if (command.endsWith('discovery.sh interfaces')) result = jsonResult({ ok: true, interfaces: [{ name: 'ap0', kind: 'wifi', present: true, state: 'up', upstream: false, suggested: true }], current_ssid: app.policy.current_ssid });
          else if (command.endsWith('discovery.sh apps')) result = jsonResult({ ok: true, apps: [{ packageName: 'com.example.app', appLabel: '示例应用', isSystem: false, uid: 10001 }, { packageName: 'com.android.settings', appLabel: '设置', isSystem: true, uid: 1000 }], source: 'package-manager' });
          else result = { errno: 0, stdout: '', stderr: '' };
        }
        context[callbackName](result.errno, result.stdout, result.stderr);
      },
    },
  };
  sandbox.window = sandbox;
  context = vm.createContext(sandbox);
  app.context = context;
  vm.runInContext(source, context, { filename: 'app.js' });
  await app.flush();
  commands.length = 0;
  return app;
}

function assertCleanBridge(app) {
  assert.deepEqual(app.pendingCallbacks(), []);
  assert.equal(app.run('Object.keys(_cbs).length'), 0);
  assert.equal(app.timers.size, 0);
}

test('native exec receives errno/stdout/stderr and clears callback and timeout', async () => {
  const app = await makeApp();
  app.handler = () => ({ errno: 7, stdout: '输出', stderr: '失败' });
  const result = await app.run("exec('sample')");
  assert.deepEqual({ ...result }, { errno: 7, stdout: '输出', stderr: '失败' });
  assertCleanBridge(app);
});

test('exec cleans up on timeout, duplicate callbacks, missing bridge, throw and pagehide', async () => {
  for (const scenario of ['timeout', 'missing', 'throw', 'pagehide']) {
    const app = await makeApp();
    let callback;
    app.handler = (command, callbackName) => { callback = app.context[callbackName]; return null; };
    if (scenario === 'missing') delete app.context.ksu;
    if (scenario === 'throw') app.handler = () => { throw new Error('bridge failure'); };
    const pending = app.run("exec('sample', 20)");
    if (scenario === 'timeout') app.advance(20);
    if (scenario === 'pagehide') app.events.pagehide();
    const result = await pending;
    assert.equal(result.errno, -1, scenario);
    assert.ok(result.stderr.length > 0);
    assertCleanBridge(app);
    if (callback) { callback(0, 'late', ''); assert.equal(result.errno, -1); assertCleanBridge(app); }
  }
});

test('concurrent exec requests clean up independently', async () => {
  const app = await makeApp();
  const callbacks = [];
  app.handler = (command, callbackName) => { callbacks.push(app.context[callbackName]); return null; };
  const first = app.run("exec('first', 10)");
  const second = app.run("exec('second', 20)");
  callbacks[1](0, 'second', '');
  assert.equal((await second).stdout, 'second');
  assert.equal(app.timers.size, 1);
  app.advance(10);
  assert.equal((await first).errno, -1);
  assertCleanBridge(app);
});

test('shJson never turns nonzero exit or invalid JSON into success', async () => {
  const app = await makeApp();
  for (const response of [jsonResult({ ok: true }, 1), jsonResult({ ok: false, error: '策略失败' }, 2), { errno: 0, stdout: 'null', stderr: '' }, { errno: 0, stdout: 'not json', stderr: '' }]) {
    app.handler = () => response;
    const result = await app.run("shJson('sample')");
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
  assertCleanBridge(app);
});

test('controller reads source config, handles quoted scalars, wildcard and IPv6', async () => {
  const app = await makeApp();
  for (const [config, address, secret] of [
    ['external-controller: 0.0.0.0:9090 # local\nsecret: "a b\\\"c" # comment', '127.0.0.1:9090', 'a b"c'],
    ["external-controller: '[::]:9091'\nsecret: 'it''s # exact'", '127.0.0.1:9091', "it's # exact"],
    ['external-controller: "[::1]:9090"\nsecret: bare#hash', '[::1]:9090', 'bare#hash'],
    ['external-controller: :9090\nsecret: ""', '127.0.0.1:9090', ''],
  ]) {
    app.handler = () => ({ errno: 0, stdout: config, stderr: '' });
    const result = await app.run('detectController()');
    assert.equal(result.addr, 'http://' + address);
    assert.equal(result.secret, secret);
    assert.ok(app.commands.at(-1).includes("'/data/adb/mihomo/config.yaml'"));
    assert.ok(!app.commands.at(-1).includes('/run/config.yaml'));
  }
  app.handler = () => ({ errno: 0, stdout: 'external-controller: 127.0.0.1:9090\nsecret: "bad\\nheader"', stderr: '' });
  await assert.rejects(app.run('detectController()'), /换行/);
  assert.equal(app.run('controller.addr'), null);
});

test('bridge curl handles JSON and 204, quotes payloads and bypasses proxy/CORS', async () => {
  const app = await makeApp();
  await app.run('detectController()');
  app.run('controller.secret = "it\'s $(not-a-command)"');
  const payload = JSON.stringify({ name: "节点 ' ; $(echo bad)\n换行" });
  app.context.payload = payload;
  app.handler = () => httpResult(null, 204);
  assert.equal(await app.run("ctl('/proxies/selector', {method:'PUT',body:payload})"), null);
  const args = curlArguments(app.commands.at(-1));
  const option = (name) => args[args.indexOf(name) + 1];
  assert.equal(args[0], '--disable');
  assert.equal(option('--noproxy'), '*');
  assert.equal(option('--max-time'), '8');
  assert.equal(option('--connect-timeout'), '3');
  assert.equal(option('--header'), "Authorization: Bearer it's $(not-a-command)");
  assert.ok(args.includes('Content-Type: application/json'));
  assert.equal(option('--data-binary'), payload);
  assert.equal(option('--url'), 'http://127.0.0.1:9090/proxies/selector');
  assert.equal(await app.run("ctl('/connections/id', {method:'DELETE'})"), null);
  app.handler = () => httpResult({ version: 'test' });
  assert.equal((await app.run("ctl('/version')")).version, 'test');
  assert.deepEqual(app.fetches, []);
  assertCleanBridge(app);
});

test('curl prefers executable system binary, falls back to PATH and reports missing binaries', async () => {
  const app = await makeApp();
  await app.run('detectController()');
  await app.run("ctl('/version')");
  const command = app.commands.at(-1);
  assert.ok(command.startsWith('(if [ -x /system/bin/curl ]; then curl_bin=/system/bin/curl; else curl_bin=$(command -v curl 2>/dev/null); fi; '));
  assert.ok(command.includes('if [ -z "$curl_bin" ] || [ ! -x "$curl_bin" ]; then '));
  assert.ok(command.includes(' >&2; exit 127; fi; "$curl_bin" '));
  const args = curlArguments(command);
  assert.equal(args[0], '--disable');
  assert.equal(args[args.indexOf('--noproxy') + 1], '*');
  const message = /printf '%s\\n' '([^']+)' >&2; exit 127/.exec(command);
  assert.ok(message);
  assert.match(message[1], /未找到可执行的 curl.*PATH.*安装 curl 模块/);
  app.handler = () => ({ errno: 127, stdout: '', stderr: message[1] });
  await assert.rejects(app.run("ctl('/version')"), /控制器 curl 失败：未找到可执行的 curl.*安装 curl 模块/);
  assertCleanBridge(app);
});

test('controller surfaces transport, HTTP and parse errors and rejects streaming APIs', async () => {
  const app = await makeApp();
  await app.run('detectController()');
  for (const [response, message] of [
    [{ errno: 28, stdout: 'partial', stderr: 'timeout' }, /timeout/],
    [{ errno: 127, stdout: '', stderr: 'curl missing' }, /curl missing/],
    [httpResult({ message: 'Unauthorized' }, 401), /401/],
    [{ errno: 0, stdout: 'bad\n__MIHOMO_HTTP__:200', stderr: '' }, /不是 JSON/],
    [{ errno: 0, stdout: '{}', stderr: '' }, /状态码/],
  ]) {
    app.handler = () => response;
    await assert.rejects(app.run("ctl('/version')"), message);
  }
  app.commands.length = 0;
  for (const endpoint of ['/traffic', '/traffic?interval=1', '/logs', '/memory']) {
    await assert.rejects(app.run(`ctl(${JSON.stringify(endpoint)})`), /流接口/);
  }
  assert.deepEqual(app.commands, []);
});

test('overview completes without traffic stream and routes settings centrally', async () => {
  const app = await makeApp();
  await app.run('renderOverview()');
  assert.match(app.element('view').innerHTML, /自启与网络设置/);
  assert.ok(app.commands.some((command) => command.includes('/version')));
  assert.ok(!app.commands.some((command) => command.includes('/traffic')));
  assert.ok(!app.element('view').innerHTML.includes('toggle-auto'));
  assertCleanBridge(app);
});

test('service checks shell exit and actual running state, including stop failures', async () => {
  const app = await makeApp();
  app.handler = (command) => command.endsWith('mihomo.sh start') ? { errno: 1, stdout: '', stderr: '启动失败' } : undefined;
  assert.equal((await app.run("api.service('start')")).error, '启动失败');
  assert.ok(!app.commands.some((command) => command.includes('echo')));
  app.handler = undefined;
  assert.equal((await app.run("api.service('start')")).ok, false);
  app.running = true;
  assert.equal((await app.run("api.service('restart')")).ok, true);
  assert.equal((await app.run("api.service('stop')")).ok, false);
  app.running = false;
  assert.equal((await app.run("api.service('stop')")).ok, true);
  const count = app.commands.length;
  assert.equal((await app.run("api.service('start; false')")).ok, false);
  assert.equal(app.commands.length, count);
});

test('apply restart confirms running, propagates failure, and never starts twice', async () => {
  const app = await makeApp();
  assert.equal((await app.run("api.apply('config', true)")).ok, true);
  assert.equal(app.commands.filter((command) => command.includes('apply.sh ')).length, 1);
  assert.ok(!app.commands.some((command) => /mihomo.sh (start|restart)$/.test(command)));
  app.running = false;
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: true }) : undefined;
  assert.match((await app.run("api.apply('config', true)")).error, /服务未运行/);
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: false, error: '新配置失败，已回滚' }, 1) : undefined;
  assert.equal((await app.run("api.apply('config', true)")).error, '新配置失败，已回滚');
});

test('settings round trip uses agreed argument order and exact multiline UTF-8 base64', async () => {
  const app = await makeApp({ policy: { autostart: true, current_ssid: '<家> & "Wi-Fi"', allowed: false } });
  await app.run('renderSettings()');
  assert.equal(app.element('autostart').checked, true);
  assert.equal(app.element('tethering-interfaces').value, defaultPolicy.tethering_interfaces);
  assert.equal(app.element('current-ssid').textContent, '<家> & "Wi-Fi"');
  assert.equal(app.element('wifi-allowed').textContent, '不允许');
  app.element('autostart').checked = false;
  app.element('tethering').checked = true;
  app.element('tethering-interfaces').value = ' ap0, rndis0 ,usb0 ';
  app.element('bypass-packages').value = ' com.example.app \r\ncom.example.second\n';
  app.element('wifi-mode').value = 'only';
  app.element('wifi-ssids').value = ' 家里 \r\nCafe\'s #1\n.*\n"精确"\n';
  await app.element('policy-save').onclick();
  const args = shellWords(app.commands.find((command) => command.includes('policy.sh set')));
  assert.deepEqual(args.slice(0, 5), ['sh', '/data/adb/modules/mihomo-ebpf/scripts/policy.sh', 'set', '0', '1']);
  assert.equal(Buffer.from(args[5], 'base64').toString(), 'ap0,rndis0,usb0');
  assert.equal(Buffer.from(args[6], 'base64').toString(), 'com.example.app\ncom.example.second');
  assert.equal(args[7], 'only');
  assert.equal(Buffer.from(args[8], 'base64').toString(), ' 家里 \nCafe\'s #1\n.*\n"精确"');
  assert.equal(args.length, 9);
  assert.match(app.element('policy-out').textContent, /设置已保存/);
  assert.equal(app.element('policy-save').disabled, false);
  app.advance(6000);
  assertCleanBridge(app);
});

test('settings off/exclude and empty values preserve payload shape and defaults', async () => {
  const app = await makeApp();
  for (const mode of ['off', 'exclude']) {
    await app.run('renderSettings()');
    app.element('tethering-interfaces').value = '';
    app.element('wifi-mode').value = mode;
    await app.element('policy-save').onclick();
    const command = app.commands.filter((entry) => entry.includes('policy.sh set')).at(-1);
    const args = shellWords(command);
    assert.equal(Buffer.from(args[5], 'base64').toString(), defaultPolicy.tethering_interfaces);
    assert.equal(args[6], '');
    assert.equal(args[7], mode);
    assert.equal(args[8], '');
  }
});

test('settings errors never overwrite unread settings and refresh preserves edits', async () => {
  const app = await makeApp();
  app.handler = (command) => command.endsWith('policy.sh get') ? jsonResult({ ok: false, error: '策略不可读' }, 1) : undefined;
  await app.run('renderSettings()');
  assert.match(app.element('view').textContent, /策略不可读/);
  assert.equal(app.element('policy-save'), null);
  app.handler = undefined;
  await app.element('policy-retry').onclick();
  app.element('wifi-ssids').value = 'unsaved';
  app.policy.current_ssid = '新网络';
  await app.element('policy-refresh').onclick();
  assert.equal(app.element('current-ssid').textContent, '新网络');
  assert.equal(app.element('wifi-ssids').value, 'unsaved');
  app.handler = (command) => command.includes('policy.sh set') ? jsonResult({ ok: false, error: '无效包名' }, 1) : undefined;
  await app.element('policy-save').onclick();
  assert.match(app.element('policy-out').textContent, /无效包名/);
  assert.equal(app.element('policy-save').disabled, false);
});

test('template is Android local, loopback controller, valid quoted provider paths and interface', async () => {
  const app = await makeApp();
  app.context.tpl = template;
  app.context.subscriptions = [{ name: '订阅1', url: 'https://example.com/sub', ua: 'test' }, { name: '../危险/"订阅', url: 'https://example.com/2' }];
  const content = app.run("renderTemplate(tpl, subscriptions, [], 'secret', 'https://example.com/ui.zip', 'https://example.com/rules.mrs')");
  assert.match(content, /^external-controller: 127\.0\.0\.1:9090$/m);
  assert.match(content, /^allow-lan: false$/m);
  assert.match(content, /^bind-address: 127\.0\.0\.1$/m);
  assert.match(content, /^    mode: local$/m);
  assert.match(content, /^      interface: \[\]$/m);
  assert.doesNotMatch(content, /interface-name:|^    mode: hybrid|^\s*#@\w+/m);
  const paths = [...content.matchAll(/^    path: (".+")$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(paths.length, 2);
  assert.equal(paths[0], './providers/' + encodeURIComponent('订阅1') + '.yaml');
  assert.equal(paths[1], './providers/' + encodeURIComponent('../危险/"订阅') + '.yaml');
  assert.equal(paths[1].split('/').length, 3);
  const withInterfaces = app.run("renderTemplate(tpl, [], ['ap0', 'usb0'], '', '', '')");
  assert.match(withInterfaces, /^      interface: \["ap0", "usb0"\]$/m);
  assert.match(template, /^external-controller: 0\.0\.0\.0:9090\r?$/m);
  assert.match(template, /^    mode: hybrid\r?$/m);
  app.context.tpl = template.replace(/\r?\n/g, '\r\n');
  assert.equal(app.run("renderTemplate(tpl, subscriptions, [], 'secret', 'https://example.com/ui.zip', 'https://example.com/rules.mrs')"), content);
});

async function prepareWizard(app) {
  await app.run('renderSetup()');
  await app.flush();
  app.element('subs').querySelector('[name=surl]').value = 'https://example.com/sub';
  app.element('secret').value = 'test-secret';
}

test('wizard checks missing core, allows generate-only and has no tethering controls', async () => {
  const app = await makeApp({ installed: false });
  await prepareWizard(app);
  assert.equal(app.element('lan'), null);
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /请先安装内核/);
  assert.ok(!app.commands.some((command) => command.includes('apply.sh ')));
  await app.element('genonly').onclick();
  assert.match(app.element('sout').textContent, /未启动服务.*未校验/);
  assert.ok(!app.commands.find((command) => command.includes('apply.sh ')).endsWith(' restart'));
});

test('wizard generate/start validates, calls apply restart once and verifies actual service', async () => {
  const app = await makeApp();
  await prepareWizard(app);
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /已确认服务运行中/);
  const apply = app.commands.filter((command) => command.includes('apply.sh '));
  assert.equal(apply.length, 1);
  assert.ok(apply[0].endsWith(' restart'));
  assert.ok(app.commands.some((command) => command.includes(' -t)')));
  assert.ok(!app.commands.some((command) => /mihomo.sh (start|restart)$/.test(command)));
  const content = Buffer.from(shellWords(apply[0])[2], 'base64').toString();
  assert.match(content, /^    mode: local$/m);
  assert.match(content, /^      interface: \[\]$/m);
  assert.equal(app.element('gen').disabled, false);
  app.running = false;
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: true }) : undefined;
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /服务未运行/);
  assert.doesNotMatch(app.element('sout').textContent, /已确认服务运行中/);
});

test('wizard stops on validation failure, duplicate subscriptions and template HTTP error', async () => {
  const app = await makeApp();
  await prepareWizard(app);
  app.handler = (command) => command.startsWith('(tmp=') ? { errno: 1, stdout: '', stderr: '配置错误' } : undefined;
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /校验失败.*\n配置错误/);
  assert.ok(!app.commands.some((command) => command.includes('apply.sh ')));
  app.element('add-sub').onclick();
  const rows = app.element('subs').querySelectorAll('.sub-item');
  rows[1].querySelector('[name=sname]').value = '订阅1';
  rows[1].querySelector('[name=surl]').value = 'https://example.com/other';
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /名称不能重复/);
  app.fetchStatus = 404;
  await app.run('renderSetup()');
  assert.match(app.element('view').textContent, /模板加载失败.*404/);
});

test('late page loads and wizard core callbacks cannot overwrite another route', async () => {
  const app = await makeApp();
  let callback;
  app.handler = (command, name) => {
    if (command.endsWith('policy.sh get')) { callback = app.context[name]; return null; }
  };
  const pending = app.run('renderSettings()');
  await app.run('renderLogs()');
  callback(0, JSON.stringify(app.policy), '');
  await pending;
  assert.match(app.element('view').textContent, /日志/);
  app.handler = (command, name) => {
    if (command.endsWith('core.sh info')) { callback = app.context[name]; return null; }
  };
  await app.run('renderSetup()');
  await app.run('renderLogs()');
  callback(0, JSON.stringify({ ok: true, installed: true }), '');
  await app.flush();
  assert.match(app.element('view').textContent, /日志/);
  assertCleanBridge(app);
});

test('settings save blocks duplicate requests and restores controls after bridge timeout', async () => {
  const app = await makeApp();
  await app.run('renderSettings()');
  app.handler = (command) => command.includes('policy.sh set') ? null : undefined;
  const save = app.element('policy-save');
  const pending = save.onclick();
  assert.equal(save.disabled, true);
  assert.equal(app.element('wifi-ssids').disabled, true);
  await save.onclick();
  assert.equal(app.commands.filter((command) => command.includes('policy.sh set')).length, 1);
  app.advance(120000);
  await pending;
  assert.match(app.element('policy-out').textContent, /超时/);
  assert.equal(save.disabled, false);
  assert.equal(app.element('wifi-ssids').disabled, false);
  app.advance(6000);
  assertCleanBridge(app);
});

test('controller and core download use bounded but different bridge deadlines', async () => {
  const app = await makeApp();
  await app.run('detectController()');
  app.handler = () => null;
  const controllerRequest = app.run("ctl('/version')");
  const controllerError = assert.rejects(controllerRequest, /超时/);
  app.advance(15000);
  await controllerError;
  assertCleanBridge(app);
  const download = app.run('api.coreUpdate()');
  assert.equal([...app.timers.values()][0].delay, 1320000);
  app.advance(1200000);
  assert.equal(app.pendingCallbacks().length, 1);
  assert.equal(app.timers.size, 1);
  app.advance(1320000);
  assert.equal((await download).ok, false);
  assertCleanBridge(app);
});

test('core download completion after the old deadline clears the extended timer', async () => {
  const app = await makeApp();
  let callback;
  app.handler = (command, name) => { callback = app.context[name]; return null; };
  const download = app.run('api.coreUpdate()');
  app.advance(600000);
  assert.equal(app.pendingCallbacks().length, 1);
  callback(0, JSON.stringify({ ok: true, version: 'downloaded' }), '');
  assert.equal((await download).version, 'downloaded');
  assertCleanBridge(app);
});

test('connection UI removes rows only on successful 204 and reports failed deletes', async () => {
  const app = await makeApp();
  let status = 500;
  app.handler = (command) => {
    if (!isCurlCommand(command)) return;
    if (curlArguments(command).includes('DELETE')) return httpResult(null, status);
    return httpResult({ connections: [{ id: 'test-id', metadata: { network: 'tcp', host: 'example.com' }, upload: 0, download: 0 }] });
  };
  await app.run('renderConnections()');
  const button = app.element('view').querySelector('[data-id]');
  await button.onclick();
  assert.equal(app.element('view').querySelectorAll('[data-id]').length, 1);
  assert.match(app.body.textContent, /断开失败.*500/);
  status = 204;
  await button.onclick();
  assert.equal(app.element('view').querySelectorAll('[data-id]').length, 0);
  await app.element('close-all').onclick();
  await app.flush();
  assert.match(app.element('view').textContent, /活动连接/);
});

test('header uses version token with full title and single-line ellipsis styling', async () => {
  const version = 'Mihomo Meta alpha-smart-e272b9d-ebpf android arm64 with go1.26.10 Mon Nov 2 09:31:02 UTC 2026';
  const app = await makeApp({ version });
  assert.equal(app.element('ver-pill').textContent, 'alpha-smart-e272b9d-ebpf');
  assert.equal(app.element('ver-pill').title, version);
  app.version = 'v1.20.0';
  await app.run('refreshHeader()');
  assert.equal(app.element('ver-pill').textContent, 'v1.20.0');
  assert.equal(app.element('ver-pill').title, 'v1.20.0');
  app.installed = false;
  await app.run('refreshHeader()');
  assert.equal(app.element('ver-pill').textContent, '未安装内核');
  assert.equal(app.element('ver-pill').title, '');
  assert.match(indexHTML, /\.pill\s*\{[^}]*white-space:\s*nowrap;/);
  assert.match(indexHTML, /\.pill\.grow\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/);
  assert.match(indexHTML, /\.grow\s*\{[^}]*min-width:\s*0;/);
});

test('SSID-denied manual and automatic intents count as successful enabled but paused starts', async () => {
  const app = await makeApp();
  for (const desired of ['manual', 'auto']) {
    app.status = { desired, allowed: false, current_ssid: ' 家里 ' };
    for (const action of ['start', 'restart']) {
      const result = await app.run(`api.service('${action}')`);
      assert.equal(result.ok, true);
      assert.equal(result.paused, true);
      assert.match(result.message, /服务已启用，因 SSID 策略暂停/);
      assert.ok(result.message.includes(' 家里 '));
      assert.match(result.message, /策略允许后自动恢复/);
    }
  }
  app.status.current_ssid = '';
  assert.match((await app.run("api.service('start')")).message, /未连接或无法获取/);
  app.handler = (command) => command.endsWith('mihomo.sh start') ? { errno: 1, stdout: '', stderr: '实际启动失败' } : undefined;
  assert.equal((await app.run("api.service('start')")).error, '实际启动失败');
  assertCleanBridge(app);
});

test('SSID pause detection is strict and stop must cancel intent', async () => {
  const app = await makeApp();
  for (const status of [
    { desired: 'stopped', allowed: false },
    { desired: 'manual', allowed: true },
    { desired: true, allowed: false },
    { desired: 'auto', allowed: 'false' },
    { allowed: false },
  ]) {
    app.status = status;
    assert.equal((await app.run("api.service('start')")).ok, false);
  }
  app.status = { desired: 'manual', allowed: false, current_ssid: 'blocked' };
  assert.match((await app.run("api.service('stop')")).error, /自动恢复意图未取消/);
  app.status.desired = 'stopped';
  const stopped = await app.run("api.service('stop')");
  assert.equal(stopped.ok, true);
  assert.equal(stopped.message, '服务已停止');
});

test('header and overview describe expected SSID pause without querying controller', async () => {
  const app = await makeApp({ status: { desired: 'auto', allowed: false, current_ssid: '<家> & "Wi-Fi"' } });
  assert.equal(app.element('svc-pill').textContent, 'SSID 暂停');
  assert.equal(app.element('svc-pill').className, 'pill paused');
  assert.match(app.element('svc-pill').title, /策略允许后自动恢复/);
  await app.run('renderOverview()');
  assert.match(app.element('view').textContent, /已启用（SSID 暂停）/);
  assert.match(app.element('view').textContent, /当前 SSID：<家> & "Wi-Fi"/);
  assert.match(app.element('view').innerHTML, /&lt;家&gt; &amp; &quot;Wi-Fi&quot;/);
  assert.equal(app.element('view').querySelector('[data-a=start]'), null);
  assert.match(app.element('view').querySelector('[data-a=stop]').textContent, /取消自动恢复/);
  assert.ok(!app.commands.some(isCurlCommand));
  await app.element('view').querySelector('[data-a=restart]').onclick();
  await app.flush();
  assert.equal(app.body.querySelectorAll('.toast').at(-1).className, 'toast ok');
  assert.match(app.body.querySelectorAll('.toast').at(-1).textContent, /因 SSID 策略暂停/);
  app.running = true;
  app.status.allowed = true;
  await app.run('refreshHeader()');
  assert.equal(app.element('svc-pill').textContent, '运行中');
  assert.equal(app.element('svc-pill').title, '');
  app.running = false;
  app.status.desired = 'stopped';
  app.status.allowed = false;
  await app.run('refreshHeader()');
  await app.run('renderOverview()');
  assert.equal(app.element('svc-pill').textContent, '已停止');
  assert.ok(app.element('view').querySelector('[data-a=start]'));
  assert.doesNotMatch(app.element('view').textContent, /自动恢复/);
});

test('apply restart accepts expected SSID pause but never masks apply failure', async () => {
  const app = await makeApp({ status: { desired: 'manual', allowed: false, current_ssid: 'blocked' } });
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: true }) : undefined;
  const result = await app.run("api.apply('config', true)");
  assert.equal(result.ok, true);
  assert.equal(result.paused, true);
  assert.match(result.message, /服务已启用，因 SSID 策略暂停/);
  assert.equal(app.commands.filter((command) => command.includes('apply.sh ')).length, 1);
  assert.ok(!app.commands.some((command) => /mihomo.sh (start|restart)$/.test(command)));
  app.commands.length = 0;
  const saved = await app.run("api.apply('config', false)");
  assert.equal(saved.ok, true);
  assert.equal(saved.paused, undefined);
  assert.equal(app.commands.length, 1);
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: false, error: '写入失败' }, 1) : undefined;
  assert.equal((await app.run("api.apply('config', true)")).error, '写入失败');
  assertCleanBridge(app);
});

test('wizard and config save show success with SSID pause instead of claiming running', async () => {
  const app = await makeApp({ status: { desired: 'manual', allowed: false, current_ssid: 'blocked' } });
  app.handler = (command) => command.includes('apply.sh ') ? jsonResult({ ok: true }) : undefined;
  await prepareWizard(app);
  await app.element('gen').onclick();
  assert.match(app.element('sout').textContent, /^✓ 配置已生成.*服务已启用，因 SSID 策略暂停/);
  assert.doesNotMatch(app.element('sout').textContent, /已确认服务运行中|失败/);
  assert.equal(app.body.querySelectorAll('.toast').at(-1).className, 'toast ok');
  await app.run('renderConfig()');
  app.element('cfg').value = 'config';
  await app.element('s').onclick();
  assert.match(app.element('out').textContent, /^✓ 已保存.*服务已启用，因 SSID 策略暂停/);
  assert.doesNotMatch(app.element('out').textContent, /已确认服务运行中|失败/);
  assert.equal(app.element('s').disabled, false);
});

test('validate and apply reject oversized UTF-8 base64 before any bridge command', async () => {
  const app = await makeApp();
  for (const content of ['a'.repeat(90001), '界'.repeat(30001), '😀'.repeat(22501)]) {
    const encodedLength = Buffer.from(content, 'utf8').toString('base64').length;
    assert.ok(encodedLength > 120000);
    app.context.content = content;
    for (const operation of ['api.validate(content)', 'api.apply(content, false)', 'api.apply(content, true)']) {
      const result = await app.run(operation);
      assert.equal(result.ok, false);
      assert.match(result.error, /配置过大.*120000.*Android/);
      assert.ok(result.error.includes(String(encodedLength)));
      assert.deepEqual(app.commands, []);
      assertCleanBridge(app);
    }
  }
});

test('validate and apply permit exactly 120000 base64 bytes for ASCII and Unicode', async () => {
  const app = await makeApp();
  for (const content of ['a'.repeat(90000), '界'.repeat(30000), '😀'.repeat(22500)]) {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    assert.equal(encoded.length, 120000);
    app.context.content = content;
    for (const operation of ['api.validate(content)', 'api.apply(content, false)']) {
      app.commands.length = 0;
      const result = await app.run(operation);
      assert.equal(result.ok, true);
      assert.equal(app.commands.length, 1);
      assert.ok(app.commands[0].includes("'" + encoded + "'"));
      assertCleanBridge(app);
    }
  }
});

test('config UI surfaces oversized configuration without issuing shell commands', async () => {
  const app = await makeApp();
  await app.run('renderConfig()');
  app.element('cfg').value = '界'.repeat(30001);
  app.commands.length = 0;
  await app.element('v').onclick();
  assert.match(app.element('out').textContent, /^✗ 配置过大/);
  await app.element('s').onclick();
  assert.match(app.element('out').textContent, /^✗ 配置过大/);
  assert.equal(app.element('s').disabled, false);
  assert.deepEqual(app.commands, []);
  assertCleanBridge(app);
});

test('settings interface chips toggle modifies tethering-interfaces input', async () => {
  const app = await makeApp();
  await app.run('renderSettings()');
  await app.flush();

  const chipsContainer = app.element('interface-chips');
  assert.ok(chipsContainer);
  
  const ap0Chip = chipsContainer.querySelector('[data-if=ap0]');
  assert.ok(ap0Chip);
  assert.match(ap0Chip.className, /sel/);

  // Click ap0 chip to toggle off
  chipsContainer.onclick({ target: ap0Chip });
  assert.ok(!chipsContainer.querySelector('[data-if=ap0]').className.includes('sel'));
  assert.ok(!app.element('tethering-interfaces').value.includes('ap0'));

  // Click ap0 chip again to toggle on
  chipsContainer.onclick({ target: chipsContainer.querySelector('[data-if=ap0]') });
  assert.match(chipsContainer.querySelector('[data-if=ap0]').className, /sel/);
  assert.ok(app.element('tethering-interfaces').value.includes('ap0'));

  // Typing in input updates chip state
  app.element('tethering-interfaces').value = 'rndis0,usb0';
  app.element('tethering-interfaces').oninput();
  assert.ok(!chipsContainer.querySelector('[data-if=ap0]').className.includes('sel'));
  assert.match(chipsContainer.querySelector('[data-if=rndis0]').className, /sel/);
});

test('settings app picker modal lists apps, toggles selection, and confirms into bypass-packages', async () => {
  const app = await makeApp();
  await app.run('renderSettings()');
  await app.flush();

  assert.equal(app.element('selected-apps-count').textContent, '0');
  const btnSelect = app.element('btn-select-apps');
  assert.ok(btnSelect);

  // Open modal
  btnSelect.onclick();
  await app.flush();
  await Promise.resolve();
  await app.flush();

  const modal = app.element('app-modal-root');
  assert.ok(modal);
  const listEl = app.element('app-modal-list');
  assert.ok(listEl);
  

  // Check that com.example.app item is rendered
  const appItem = listEl.querySelector('[data-pkg="com.example.app"]');
  assert.ok(appItem);
  assert.match(appItem.textContent, /示例应用/);

  // Toggle selection on com.example.app
  listEl.onclick({ target: appItem });
  assert.equal(app.element('app-modal-confirm-count').textContent, '1');

  // Confirm
  app.element('app-modal-confirm').onclick();
  assert.equal(app.element('bypass-packages').value.trim(), 'com.example.app');
  assert.equal(app.element('selected-apps-count').textContent, '1');
  assert.ok(!app.element('app-modal-root'));
});

test('settings app chips delete button and clear button remove packages', async () => {
  const app = await makeApp({ policy: { bypass_packages: 'com.example.app\ncom.second.app' } });
  await app.run('renderSettings()');
  await app.flush();

  assert.equal(app.element('selected-apps-count').textContent, '2');
  const chipsContainer = app.element('selected-apps-chips');
  assert.ok(chipsContainer);

  // Delete first app
  const delBtn = chipsContainer.querySelector('[data-del-pkg="com.example.app"]');
  assert.ok(delBtn);
  chipsContainer.onclick({ target: delBtn });
  assert.equal(app.element('selected-apps-count').textContent, '1');
  assert.equal(app.element('bypass-packages').value.trim(), 'com.second.app');

  // Clear all apps
  app.element('btn-clear-apps').onclick();
  assert.equal(app.element('selected-apps-count').textContent, '0');
  assert.equal(app.element('bypass-packages').value.trim(), '');
});

test('getInstalledApps uses ksu listPackages and getPackagesInfo when available', async () => {
  const app = await makeApp();
  app.context.ksu.listPackages = async (type) => ['com.native.app'];
  app.context.ksu.getPackagesInfo = async (pkgs) => [{
    packageName: 'com.native.app',
    appLabel: '原生应用',
    isSystem: false,
    uid: 10099,
  }];

  const apps = await app.run('getInstalledApps(true)');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].packageName, 'com.native.app');
  assert.equal(apps[0].appLabel, '原生应用');
  assert.equal(apps[0].uid, 10099);
  assert.equal(apps[0].icon, 'ksu://icon/com.native.app');
});