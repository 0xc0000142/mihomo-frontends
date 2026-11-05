'use strict';

// 配置引擎（webui/bridge/config.js）：解析、字段读写、导入分析与本机优化。
// 运行：node --test magisk/tests/config.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');

const bridge = path.join(__dirname, '../webui/bridge');
const context = { crypto: webcrypto };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(bridge, 'vendor/yaml.min.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(bridge, 'config.js'), 'utf8'), context);
const C = context.mihomoConfig;
const Y = context.YAML;
const plain = (content) => JSON.parse(JSON.stringify(Y.parseDocument(content, { merge: true }).toJS({ maxAliasCount: -1 })));

const template = fs.readFileSync(path.join(__dirname, '../../shared/template.yaml'), 'utf8').replace(/\r/g, '');
const rendered = template.split('\n').map((line) => {
  const match = /^(\s*)#@(\S+)/.exec(line);
  if (!match) return line;
  const indent = match[1];
  return {
    providers: `${indent}"机场":\n${indent}  <<: *p\n${indent}  url: "https://example.com/sub"\n${indent}  path: "./providers/a.yaml"`,
    use: `${indent}- "机场"`, secret: 'secret: "abc"', 'ui-url': 'external-ui-url: "https://example.com/ui.zip"','fake-ip-filter-url': `${indent}url: "https://example.com/f.mrs"`,
    lan: `${indent}interface: []`,
  }[match[2]];
}).join('\n');

const routerConfig = `# 我的路由器配置
mixed-port: 7890
tproxy-port: 7894
routing-mark: 6666
allow-lan: true
bind-address: '*'
log-level: info
external-controller: 0.0.0.0:9090
tun:
  enable: true
  stack: mixed
dns:
  enable: false
  ipv6: true
proxies:
  - {name: 香港, type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x}
proxy-groups:
  - name: 节点选择
    type: select
    proxies: [香港, DIRECT]
rule-providers:
  cncidr:
    type: http
    behavior: ipcidr
    format: mrs
    url: https://example.com/cncidr.mrs
    path: ./rule/cncidr.mrs
rules:
  - PROCESS-NAME,com.tencent.mm,DIRECT
  - GEOSITE,cn,DIRECT
  - RULE-SET,cncidr,DIRECT
  - MATCH,节点选择
`;

const host = { ipv6: false, memMb: 4096, mirror: 'https://ghfast.top/' };

function policyRender(content) {
  // 让优化结果过一遍运行时渲染（policy-yaml.awk），确保模块能接管。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-config-'));
  const source = path.join(directory, 'config.yaml');
  const packages = path.join(directory, 'packages');
  fs.writeFileSync(source, content);
  fs.writeFileSync(packages, 'com.example.bank\n');
  try {
    return execFileSync('awk', ['-v', 'tethering=1', '-v', 'interfaces=ap0,rndis0', '-v', 'packages_file=' + packages.split(path.sep).join('/'),
      '-f', path.join(__dirname, '../scripts/policy-yaml.awk'), source], { encoding: 'utf8' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('template round trips byte-for-byte and keeps anchors', () => {
  const result = C.patch(rendered, [{ op: 'set', path: ['log-level'], value: 'error' }]);
  const before = rendered.split('\n');
  const after = result.content.split('\n');
  const changed = before.filter((line, index) => line !== after[index]);
  assert.deepEqual(changed, ['log-level: warning']);
  assert.match(result.content, /^p: &p$/m);
  assert.match(result.content, /<<: \*use/);
});

test('schema exposes LuCI-aligned sections with current values', () => {
  const schema = C.schema(rendered);
  const ids = schema.sections.map((section) => section.id);
  assert.deepEqual([...ids], ['basic', 'controller', 'dns', 'ebpf']);
  const field = (section, id) => schema.sections.find((item) => item.id === section).fields.find((item) => item.id === id);
  assert.equal(field('basic', 'log-level').value, 'warning');
  assert.equal(field('dns', 'dns.enhanced-mode').value, 'redir-host');
  assert.equal(field('ebpf', '@listener.network').value, 'tcp,udp');
  assert.deepEqual([...field('ebpf', '@listener.bypass-rule-set').choices], ['CN-IP']);
  assert.equal(schema.providers[0].name, '机场');
  assert.equal(schema.providers[0].fields.find((item) => item.id === 'interval').value, 3600, 'merged anchor value is visible');
  assert.equal(schema.ruleProviders.find((item) => item.name === 'CN-IP').used, false);
  assert.equal(schema.summary.ebpf, true);
});

test('patch validates values and edits listener fields in place', () => {
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['mixed-port'], value: 70000 }]), /混合端口/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['external-controller'], value: '' }]), /不能为空/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['secret2'], value: 'x' }]), /不支持修改字段/);
  assert.throws(() => C.patch(rendered, [{ op: 'set', path: ['@listener', 'bypass-rule-set'], value: ['nope'] }]), /规则集不存在/);
  const result = C.patch(rendered, [
    { op: 'set', path: ['@listener', 'udp-timeout'], value: 120 },
    { op: 'set', path: ['@listener', 'shared', 'exclude-mac-address'], value: 'AA-BB-CC-DD-EE-FF\naa:bb:cc:dd:ee:ff' },
    { op: 'set', path: ['@listener', 'network'], value: 'tcp' },
    { op: 'set', path: ['dns', 'nameserver'], value: '223.5.5.5\n\n119.29.29.29' },
    { op: 'set', path: ['geodata-loader'], value: 'memconservative' },
    { op: 'set', path: ['unified-delay'], value: null },
  ]);
  const data = plain(result.content);
  assert.equal(data.listeners[0]['udp-timeout'], 120);
  assert.deepEqual(data.listeners[0].shared['exclude-mac-address'], ['aa:bb:cc:dd:ee:ff']);
  assert.deepEqual(data.listeners[0].network, ['tcp']);
  assert.deepEqual(data.dns.nameserver, ['223.5.5.5', '119.29.29.29']);
  assert.equal(data['geodata-loader'], 'memconservative');
  assert.equal('unified-delay' in data, false);
  assert.match(policyRender(result.content), /mode: hybrid/);
});

test('providers can be added, edited and removed while keeping group references', () => {
  let content = C.patch(rendered, [{ op: 'provider.add', name: '备用', values: { url: 'https://example.com/b', 'header.User-Agent': 'clash.meta' } }]).content;
  let data = plain(content);
  assert.equal(data['proxy-providers']['备用'].interval, 3600, 'new provider merges the shared anchor');
  assert.deepEqual(data['proxy-providers']['备用'].header, { 'User-Agent': ['clash.meta'] });
  assert.match(content, /"?备用"?:\n\s+<<: \*p/);
  assert.ok(data['proxy-groups'].find((group) => group.name === '香港').use.includes('备用'));
  content = C.patch(content, [{ op: 'provider.set', name: '备用', values: { interval: 600, 'override.additional-prefix': '[B]' } }]).content;
  data = plain(content);
  assert.equal(data['proxy-providers']['备用'].interval, 600);
  assert.equal(data['proxy-providers']['备用'].override['additional-prefix'], '[B]');
  content = C.patch(content, [{ op: 'provider.delete', name: '备用' }]).content;
  data = plain(content);
  assert.equal('备用' in data['proxy-providers'], false);
  assert.ok(!data['proxy-groups'].some((group) => (group.use || []).includes('备用')));
  assert.throws(() => C.patch(content, [{ op: 'provider.add', name: '机场', values: { url: 'https://x.y' } }]), /已存在/);
});

test('rule providers follow format/behavior rules and refuse deleting referenced sets', () => {
  assert.throws(() => C.patch(rendered, [{ op: 'ruleProvider.delete', name: 'CN-IP' }]).content.length >= 0 &&
    C.patch(C.patch(rendered, [{ op: 'ruleProvider.add', name: 'x', values: { url: 'https://e/x.mrs', format: 'mrs', behavior: 'classical' } }]).content, []),
  /classical|没有要保存/);
  const added = C.patch(rendered, [{ op: 'ruleProvider.add', name: 'ads', values: { url: 'https://e/ads.list', format: 'text', behavior: 'domain', proxy: 'DIRECT' } }]);
  const data = plain(added.content);
  assert.equal(data['rule-providers'].ads.path, './rule_provider/ads.list');
  assert.throws(() => C.patch(rendered, [{ op: 'ruleProvider.delete', name: 'AWAvenue-Ads' }]), /仍在引用/);
});

test('analyze distinguishes full configs, partial configs and raw subscriptions', () => {
  assert.equal(C.analyze(routerConfig).kind, 'config');
  assert.equal(C.analyze('mixed-port: 7890\n').kind, 'partial');
  assert.equal(C.analyze('vmess://abc\ntrojan://def@h:443\n').kind, 'subscription');
  assert.equal(C.analyze('dm1lc3M6Ly9hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODlhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg==').kind, 'subscription');
  assert.throws(() => C.analyze('a: [1, 2'), /YAML 解析失败/);
});

test('optimize adapts a router config for the phone and the runtime renderer accepts it', () => {
  const result = C.optimize(routerConfig, host);
  const ids = result.changes.map((change) => change.id);
  for (const id of ['ebpf', 'tun', 'router', 'controller', 'secret', 'dashboard', 'lan', 'dns', 'dns-hijack', 'ipv6', 'geox', 'geodata', 'log']) {
    assert.ok(ids.includes(id), 'missing change ' + id);
  }
  const data = plain(result.content);
  assert.equal(data.listeners.length, 1);
  assert.equal(data.listeners[0].type, 'ebpf');
  assert.deepEqual(data.listeners[0]['bypass-rule-set'], ['cncidr']);
  assert.equal(data.listeners[0].local.ipv6, false);
  assert.equal(data.tun.enable, false);
  assert.equal(data['tproxy-port'], undefined);
  assert.equal(data['routing-mark'], undefined);
  assert.equal(data['external-controller'], '127.0.0.1:9090');
  assert.match(data.secret, /^[0-9a-f]{32}$/);
  assert.equal(data['external-ui-url'], 'https://ghfast.top/https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip');
  assert.equal(data['allow-lan'], false);
  assert.equal(data.dns.enable, true);
  assert.equal(data.rules[0], 'DST-PORT,53,DNS_Hijack');
  assert.equal(data.proxies[0].type, 'dns');
  assert.equal(data.ipv6, false);
  assert.equal(data['find-process-mode'], undefined, 'PROCESS-NAME rule keeps process lookup default');
  assert.equal(data['geodata-loader'], 'memconservative');
  assert.match(result.content, /^# 我的路由器配置/);
  const runtime = policyRender(result.content);
  assert.match(runtime, /exclude-package: \["com\.example\.bank"\]/);
  assert.match(runtime, /interface: \["ap0", "rndis0"\]/);
});

test('optimize honours skipped optional steps but never skips required ones', () => {
  const result = C.optimize(routerConfig, host, { skip: ['lan', 'log', 'ebpf', 'secret'] });
  const data = plain(result.content);
  assert.equal(data['allow-lan'], true);
  assert.equal(data['log-level'], 'info');
  assert.equal(data.secret, undefined);
  assert.equal(data.listeners[0].type, 'ebpf', 'eBPF listener is mandatory');
  assert.equal(result.changes.find((change) => change.id === 'ebpf').optional, false);
});

test('optimize is idempotent and the template needs no mandatory changes', () => {
  const once = C.optimize(routerConfig, host).content;
  const twice = C.optimize(once, host);
  assert.equal(twice.changes.filter((change) => !change.optional).length, 0, JSON.stringify(twice.changes));
  assert.equal(twice.content, C.optimize(twice.content, host).content);
  const templateResult = C.optimize(rendered, { ipv6: true, memMb: 12000 });
  assert.equal(templateResult.changes.filter((change) => !change.optional).length, 0, JSON.stringify(templateResult.changes));
});

test('optimize replaces multiple or flow-style listeners with one block listener', () => {
  const config = 'proxies: []\nlisteners:\n  - {name: a, type: ebpf, local: {data-plane: tc, bypass-port: [22]}}\n  - name: tp\n    type: tproxy\n    port: 7894\n';
  const result = C.optimize(config, { ipv6: true });
  const data = plain(result.content);
  assert.equal(data.listeners.length, 1);
  assert.equal(data.listeners[0].local['data-plane'], 'tc', 'existing role settings are kept');
  assert.deepEqual(data.listeners[0].local['bypass-port'], [22]);
  assert.match(result.changes.find((change) => change.id === 'ebpf').detail, /移除 1 个/);
  assert.match(policyRender(result.content), /mode: hybrid/);
});

test('optimize rewrites absolute paths outside the data directory', () => {
  const config = [
    'external-ui: /path/to/ui/folder/',
    'proxies: []',
    'proxy-providers:',
    '  a: {type: http, url: "https://e/a", path: /etc/clash/a.yaml}',
    'rule-providers:',
    '  r: {type: http, behavior: domain, url: "https://e/r", path: ../r.yaml}',
    '  ok: {type: http, behavior: domain, url: "https://e/o", path: ./rules/ok.yaml}',
    'geox-path: {geoip: /opt/geoip.dat}',
    '',
  ].join('\n');
  const result = C.optimize(config, { ipv6: true });
  const change = result.changes.find((item) => item.id === 'paths');
  assert.ok(change && change.optional === false);
  const data = plain(result.content);
  assert.equal(data['external-ui'], './dashboard');
  assert.equal(data['proxy-providers'].a.path, './proxy_provider/a.yaml');
  assert.equal(data['rule-providers'].r.path, './rule_provider/r.yaml');
  assert.equal(data['rule-providers'].ok.path, './rules/ok.yaml');
  assert.equal(data['geox-path'].geoip, './geoip.dat');
  assert.equal(C.optimize(result.content, { ipv6: true }).changes.some((item) => item.id === 'paths'), false);
});
