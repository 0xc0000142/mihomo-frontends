// 配置引擎：在 WebView 内解析/修改 mihomo YAML，保留注释与锚点。
// 依赖 vendor/yaml.min.js 暴露的 globalThis.YAML。对外暴露 globalThis.mihomoConfig（纯函数，无 I/O）。
// 字段清单参照 LuCI（luci/root/usr/share/ucode/mihomo/forms.uc），并去掉由模块策略接管的字段：
//   listener.mode / local.dns-mode / local.exclude-package / shared.interface 由「设置」页的共享与绕过策略生成。
(function (root) {
  'use strict';

  const Y = root.YAML;
  const PARSE = { merge: true, uniqueKeys: true, prettyErrors: false, strict: false };
  const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false, indentSeq: true };
  const MAX_LIST = 1024;
  const ZASHBOARD = 'https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip';
  const GEOX = {
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
  };
  const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'];

  // ---------- 基础工具 ----------

  function parse(content) {
    const text = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new Error('配置为空');
    const doc = Y.parseDocument(text, PARSE);
    if (doc.errors.length) {
      const error = doc.errors[0];
      const line = error.linePos && error.linePos[0] ? '第 ' + error.linePos[0].line + ' 行：' : '';
      throw new Error('YAML 解析失败，' + line + String(error.message).split('\n')[0]);
    }
    if (!Y.isMap(doc.contents)) throw new Error('配置顶层必须是 YAML 映射');
    return doc;
  }

  function dump(doc) {
    return doc.toString(STRINGIFY);
  }

  function plain(doc) {
    return doc.toJS({ maxAliasCount: -1 }) || {};
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function getPath(object, path) {
    let current = object;
    for (const key of path) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  function nodeAt(doc, path) {
    return path.length ? doc.getIn(path, true) : doc.contents;
  }

  // 写入时若中间映射不存在则逐级创建（块风格）。
  function setIn(doc, path, value) {
    for (let index = 1; index < path.length; index++) {
      const parent = path.slice(0, index);
      const node = nodeAt(doc, parent);
      if (node === undefined || node === null || (Y.isScalar(node) && node.value == null)) {
        doc.setIn(parent, doc.createNode({}));
      } else if (!Y.isMap(node) && !Y.isSeq(node)) {
        throw new Error(parent.join('.') + ' 不是映射，无法写入子字段');
      }
    }
    const node = doc.createNode(value);
    if (Y.isCollection(node)) node.flow = Array.isArray(value) && value.length > 0 && value.length <= 6 &&
      value.every((item) => typeof item !== 'object' && String(item).length <= 24);
    doc.setIn(path, node);
  }

  function isMergeKey(key) {
    if (!Y.isScalar(key)) return false;
    const value = key.value;
    return value === '<<' || (typeof value === 'symbol' && value.description === '<<');
  }

  function deleteIn(doc, path) {
    if (nodeAt(doc, path) !== undefined) doc.deleteIn(path);
  }

  function randomHex(bytes) {
    const buffer = new Uint8Array(bytes);
    (root.crypto || globalThis.crypto).getRandomValues(buffer);
    return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 校验 ----------

  const check = {
    port(value, zero) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < (zero ? 0 : 1) || number > 65535) throw new Error('端口须为 ' + (zero ? 0 : 1) + '–65535');
      return number;
    },
    int(value, min, max) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) throw new Error('须为 ' + min + '–' + max + ' 的整数');
      return number;
    },
    url(value) {
      const text = String(value).trim();
      if (!/^https?:\/\/[^/?#\s]+/.test(text) || /\s/.test(text) || text.length > 2048) throw new Error('须为 http(s) 链接');
      return text;
    },
    listen(value) {
      const text = String(value).trim();
      if (!/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.*-]*):\d{1,5}$/.test(text)) throw new Error('格式须为 地址:端口，例如 127.0.0.1:9090');
      check.port(text.slice(text.lastIndexOf(':') + 1));
      return text;
    },
    name(value) {
      const text = String(value).trim();
      if (!text || text.length > 64 || /[/,\\\n\r]/.test(text) || text.startsWith('.')) throw new Error('名称须为 1–64 个字符，不能含 / , \\ 或以 . 开头');
      return text;
    },
    cidr(value) {
      const text = String(value).trim();
      if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(text)) throw new Error('无效的 CIDR：' + text);
      return text;
    },
    mac(value) {
      const text = String(value).trim().toLowerCase().replace(/-/g, ':');
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) throw new Error('无效的 MAC：' + value);
      return text;
    },
    text(value, max) {
      const text = String(value);
      if (text.length > (max || 256) || /[\n\r\0]/.test(text)) throw new Error('文本过长或含换行');
      return text;
    },
  };

  function listValue(value, item, limit) {
    const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
    const result = [];
    for (const raw of items) {
      const text = String(raw).trim();
      if (!text) continue;
      const checked = item ? item(text) : check.text(text);
      if (!result.includes(checked)) result.push(checked);
    }
    if (result.length > (limit || MAX_LIST)) throw new Error('最多 ' + (limit || MAX_LIST) + ' 项');
    return result;
  }

  // ---------- 字段清单（对齐 LuCI） ----------
  // type: bool | enum | int | text | secret | url | listen | list
  // path 以 L 开头时相对 eBPF listener。

  const L = '@listener';
  const SECTIONS = [
    {
      id: 'basic', title: '基础', summary: '端口、运行模式与日志',
      fields: [
        { path: ['mode'], label: '运行模式', type: 'enum', options: [['rule', '规则'], ['global', '全局'], ['direct', '直连']], def: 'rule' },
        { path: ['mixed-port'], label: '混合端口', summary: 'HTTP/SOCKS5 入站，0 为关闭', type: 'int', min: 0, max: 65535 },
        { path: ['allow-lan'], label: '允许局域网连接', summary: '公共 Wi-Fi 下建议关闭', type: 'bool', def: false },
        { path: ['bind-address'], label: '监听地址', type: 'text', placeholder: '*' },
        { path: ['ipv6'], label: 'IPv6', type: 'bool', def: true },
        { path: ['log-level'], label: '日志级别', type: 'enum', options: [['silent', '静默'], ['error', '错误'], ['warning', '警告'], ['info', '信息'], ['debug', '调试']], def: 'info' },
        { path: ['find-process-mode'], label: '查找进程', summary: '按应用分流时需要；off 更省电', type: 'enum', options: [['always', '总是'], ['strict', '按需'], ['off', '关闭']], def: 'strict' },
        { path: ['tcp-concurrent'], label: 'TCP 并发', summary: '同时连接解析出的多个 IP，取最快', type: 'bool', def: false },
        { path: ['unified-delay'], label: '统一延迟', summary: '测速时扣除握手耗时', type: 'bool', def: false },
        { path: ['sniffer', 'enable'], label: '域名嗅探', type: 'bool', def: false },
        { path: ['profile', 'store-selected'], label: '记住手动选择的节点', type: 'bool', def: false },
        { path: ['geodata-loader'], label: 'GEO 加载方式', summary: '低内存设备建议省内存', type: 'enum', options: [['standard', '标准'], ['memconservative', '省内存']], def: 'standard' },
      ],
    },
    {
      id: 'controller', title: '控制器与面板', summary: 'RESTful API 与网页面板',
      fields: [
        { path: ['external-controller'], label: '控制器地址', summary: '仅本机使用时保持 127.0.0.1', type: 'listen', required: true },
        { path: ['secret'], label: '控制器密钥', type: 'secret' },
        { path: ['external-ui'], label: '面板目录', type: 'text', placeholder: './dashboard' },
        { path: ['external-ui-url'], label: '面板下载地址', type: 'url' },
        { path: ['geox-url', 'geoip'], label: 'GeoIP 下载地址', type: 'url' },
        { path: ['geox-url', 'geosite'], label: 'GeoSite 下载地址', type: 'url' },
        { path: ['geox-url', 'mmdb'], label: 'MMDB 下载地址', type: 'url' },
        { path: ['geo-auto-update'], label: '自动更新 GEO 数据', type: 'bool', def: false },
      ],
    },
    {
      id: 'dns', title: 'DNS', summary: '解析模式与上游服务器',
      fields: [
        { path: ['dns', 'enable'], label: '启用 DNS', type: 'bool', def: false },
        { path: ['dns', 'listen'], label: '监听地址', type: 'listen', placeholder: '127.0.0.1:1053' },
        { path: ['dns', 'enhanced-mode'], label: '模式', type: 'enum', options: [['redir-host', 'redir-host'], ['fake-ip', 'fake-ip'], ['normal', 'normal']], def: 'redir-host' },
        { path: ['dns', 'ipv6'], label: '返回 IPv6 地址（AAAA）', type: 'bool', def: false },
        { path: ['dns', 'fake-ip-range'], label: 'FakeIP 地址段（IPv4）', type: 'text', placeholder: '198.18.0.1/16' },
        { path: ['dns', 'default-nameserver'], label: '引导服务器', summary: '用于解析其它 DNS 服务器的域名', type: 'list', limit: 32 },
        { path: ['dns', 'nameserver'], label: '默认服务器', type: 'list', limit: 32 },
        { path: ['dns', 'proxy-server-nameserver'], label: '代理节点域名的服务器', type: 'list', limit: 32 },
        { path: ['dns', 'direct-nameserver'], label: '直连域名的服务器', type: 'list', limit: 32 },
        { path: ['dns', 'fake-ip-filter'], label: '不使用 FakeIP 的域名', type: 'list', limit: 1024 },
      ],
    },
    {
      id: 'ebpf', title: 'eBPF 透明代理', summary: '协议、内核直连与数据面',
      fields: [
        { path: [L, 'network'], label: '协议', type: 'enum', options: [['tcp,udp', 'TCP + UDP'], ['tcp', '仅 TCP'], ['udp', '仅 UDP']], def: 'tcp,udp', joined: true },
        { path: [L, 'udp-timeout'], label: 'UDP 会话超时（秒）', type: 'int', min: 5, max: 86400, placeholder: '300' },
        { path: [L, 'bypass-rule-set'], label: '内核直连的规则集', summary: '命中的目标不进入 mihomo，省电', type: 'list', ruleSets: 'ipcidr', limit: 32 },
        { path: [L, 'fakeip-icmp'], label: 'FakeIP 的 ICMP', type: 'enum', options: [['off', '关闭'], ['reply', '本地应答']], def: 'off' },
        { path: [L, 'bypass-tun-direct'], label: 'TUN 共存直连', summary: '与其它 VPN 应用共存', type: 'bool', def: true },
        { path: [L, 'local', 'data-plane'], label: '本机数据面', type: 'enum', options: [['cgroup', 'cgroup'], ['tc', 'tc']], def: 'cgroup' },
        { path: [L, 'local', 'ipv6'], label: '本机处理 IPv6', type: 'bool', def: true },
        { path: [L, 'local', 'bypass-private-address'], label: '本机私网地址直连', type: 'bool', def: true },
        { path: [L, 'local', 'bypass-exclude'], label: '本机强制进入 mihomo 的地址段', type: 'list', item: 'cidr', limit: 256 },
        { path: [L, 'local', 'bypass-port'], label: '本机直连的目标端口', type: 'list', item: 'port', limit: 256 },
        { path: [L, 'shared', 'data-plane'], label: '共享数据面', type: 'enum', options: [['packet_rewrite', 'packet_rewrite'], ['socket_assign', 'socket_assign']], def: 'packet_rewrite' },
        { path: [L, 'shared', 'dns-mode'], label: '共享设备 DNS', type: 'enum', options: [['hijack', '劫持'], ['respect_policy', '按规则'], ['off', '关闭']], def: 'hijack' },
        { path: [L, 'shared', 'ipv6'], label: '共享处理 IPv6', type: 'bool', def: true },
        { path: [L, 'shared', 'bypass-private-address'], label: '共享私网地址直连', type: 'bool', def: true },
        { path: [L, 'shared', 'include-mac-address'], label: '只代理这些设备（MAC）', type: 'list', item: 'mac', limit: 256 },
        { path: [L, 'shared', 'exclude-mac-address'], label: '不代理这些设备（MAC）', type: 'list', item: 'mac', limit: 256 },
        { path: [L, 'shared', 'include-source-cidr'], label: '只代理这些来源地址', type: 'list', item: 'cidr', limit: 256 },
        { path: [L, 'shared', 'exclude-source-cidr'], label: '不代理这些来源地址', type: 'list', item: 'cidr', limit: 256 },
      ],
    },
  ];

  const PROVIDER_FIELDS = [
    { key: ['url'], label: '订阅链接', type: 'url', required: true },
    { key: ['interval'], label: '更新间隔（秒）', type: 'int', min: 0, max: 31536000, placeholder: '3600' },
    { key: ['header', 'User-Agent'], label: 'User-Agent', type: 'text', list: true, placeholder: 'clash.meta' },
    { key: ['override', 'additional-prefix'], label: '节点名前缀', type: 'text' },
    { key: ['health-check', 'enable'], label: '健康检查', type: 'bool', def: false },
    { key: ['health-check', 'url'], label: '测速地址', type: 'url' },
    { key: ['health-check', 'interval'], label: '测速间隔（秒）', type: 'int', min: 0, max: 86400 },
    { key: ['health-check', 'timeout'], label: '超时（毫秒）', type: 'int', min: 1, max: 60000 },
  ];

  const RULE_PROVIDER_FIELDS = [
    { key: ['behavior'], label: '类型', type: 'enum', options: [['domain', '域名'], ['ipcidr', 'IP 段'], ['classical', '经典']], def: 'domain' },
    { key: ['format'], label: '格式', type: 'enum', options: [['mrs', 'mrs'], ['yaml', 'yaml'], ['text', 'text']], def: 'yaml' },
    { key: ['url'], label: '链接', type: 'url', required: true },
    { key: ['interval'], label: '更新间隔（秒）', type: 'int', min: 0, max: 31536000, placeholder: '86400' },
    { key: ['proxy'], label: '下载经由', type: 'policy', def: 'DIRECT' },
  ];

  function ebpfIndex(data) {
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    return listeners.findIndex((item) => isObject(item) && item.type === 'ebpf');
  }

  function resolvePath(data, path) {
    if (path[0] !== L) return path;
    const index = ebpfIndex(data);
    if (index < 0) return null;
    return ['listeners', index].concat(path.slice(1));
  }

  function displayValue(field, value) {
    if (field.joined && Array.isArray(value)) return value.join(',');
    return value;
  }

  function fieldState(field, data, raw, extra) {
    const path = resolvePath(data, field.path || field.key);
    const value = path ? getPath(data, path) : undefined;
    const state = {
      id: (field.path || field.key).join('.'), path: field.path || field.key, label: field.label, type: field.type,
      summary: field.summary || '', placeholder: field.placeholder || '', required: !!field.required,
      options: field.options ? field.options.map(([id, title]) => ({ id, title })) : undefined,
      value: value === undefined ? null : displayValue(field, value), def: field.def === undefined ? null : field.def,
      available: !!path, min: field.min, max: field.max,
    };
    if (field.type === 'list' && field.ruleSets) {
      state.choices = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {})
        .filter(([, item]) => isObject(item) && item.behavior === field.ruleSets).map(([name]) => name);
    }
    if (field.type === 'policy') state.choices = (extra && extra.policies) || BUILTIN_POLICIES;
    if (field.type === 'secret' && typeof state.value === 'string' && state.value) state.masked = true;
    void raw;
    return state;
  }

  function policies(data) {
    const groups = Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : [];
    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return BUILTIN_POLICIES.concat(groups.concat(proxies).filter(isObject).map((item) => String(item.name || '')).filter(Boolean));
  }

  function schema(content) {
    const doc = parse(content);
    const data = plain(doc);
    const extra = { policies: policies(data) };
    const sections = SECTIONS.map((section) => ({
      id: section.id, title: section.title, summary: section.summary,
      available: section.id !== 'ebpf' || ebpfIndex(data) >= 0,
      fields: section.fields.map((field) => fieldState(field, data, null, extra)),
    }));
    const providers = Object.entries(isObject(data['proxy-providers']) ? data['proxy-providers'] : {}).map(([name, item]) => ({
      name, type: isObject(item) ? String(item.type || '') : '', editable: isObject(item) && item.type === 'http',
      fields: PROVIDER_FIELDS.map((field) => ({ ...fieldState(field, isObject(item) ? item : {}, null, extra), id: field.key.join('.'), path: field.key })),
    }));
    const ruleProviders = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {}).map(([name, item]) => ({
      name, type: isObject(item) ? String(item.type || '') : '', editable: isObject(item) && item.type === 'http',
      used: (Array.isArray(data.rules) ? data.rules : []).some((rule) => typeof rule === 'string' && ruleUses(rule, name)),
      fields: RULE_PROVIDER_FIELDS.map((field) => ({ ...fieldState(field, isObject(item) ? item : {}, null, extra), id: field.key.join('.'), path: field.key })),
    }));
    return { ok: true, sections, providers, ruleProviders, providerFields: PROVIDER_FIELDS.map((field) => fieldState(field, {}, null, extra)),
      ruleProviderFields: RULE_PROVIDER_FIELDS.map((field) => fieldState(field, {}, null, extra)), summary: summarize(doc, data) };
  }

  function ruleUses(rule, name) {
    return rule.split(',').map((part) => part.trim().replace(/^\(+|\)+$/g, '')).includes(name) && /RULE-SET/.test(rule);
  }

  function findField(path) {
    const id = path.join('.');
    for (const section of SECTIONS) for (const field of section.fields) if (field.path.join('.') === id) return field;
    return null;
  }

  function normalizeValue(field, value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
    switch (field.type) {
      case 'bool':
        if (typeof value !== 'boolean') throw new Error(field.label + ' 必须为开或关');
        return value;
      case 'enum': {
        const id = String(value);
        if (!field.options.some(([option]) => option === id)) throw new Error(field.label + ' 取值无效');
        return field.joined ? id.split(',') : id;
      }
      case 'int':
        try { return check.int(value, field.min, field.max); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'url':
        try { return check.url(value); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'listen':
        try { return check.listen(value); } catch (error) { throw new Error(field.label + ' ' + error.message); }
      case 'secret': {
        const text = String(value);
        if (/\s/.test(text) || text.length > 128) throw new Error(field.label + ' 不能含空白，且不超过 128 字符');
        return text;
      }
      case 'policy':
        return check.text(value, 128);
      case 'list': {
        const item = field.item === 'cidr' ? check.cidr : field.item === 'mac' ? check.mac
          : field.item === 'port' ? (text) => check.port(text) : (text) => check.text(text, 256);
        try { return listValue(value, item, field.limit); } catch (error) { throw new Error(field.label + '：' + error.message); }
      }
      default:
        if (field.list) return [check.text(value, 256)];
        try { return check.text(value, 256); } catch (error) { throw new Error(field.label + ' ' + error.message); }
    }
  }

  // ---------- 修改 ----------
  // ops: [{op:'set', path:[...], value}] 由 SECTIONS 字段约束；
  //      {op:'provider.set', name, values:{'url':..}} / {op:'provider.add', name, values} / {op:'provider.delete', name}
  //      {op:'ruleProvider.set|add|delete', ...}

  function patch(content, ops) {
    if (!Array.isArray(ops) || !ops.length) throw new Error('没有要保存的修改');
    if (ops.length > 256) throw new Error('一次修改过多');
    const doc = parse(content);
    for (const op of ops) {
      if (!isObject(op)) throw new Error('修改项无效');
      const data = plain(doc);
      if (op.op === 'set') applySet(doc, data, op);
      else if (/^(provider|ruleProvider)\.(set|add|delete)$/.test(op.op)) applyCollection(doc, data, op);
      else throw new Error('不支持的修改：' + op.op);
    }
    const output = dump(doc);
    parse(output);
    return { ok: true, content: output };
  }

  function applySet(doc, data, op) {
    if (!Array.isArray(op.path)) throw new Error('字段路径无效');
    const field = findField(op.path);
    if (!field) throw new Error('不支持修改字段：' + op.path.join('.'));
    const path = resolvePath(data, field.path);
    if (!path) throw new Error('配置里没有 eBPF listener，请先执行「本机优化」');
    const value = normalizeValue(field, op.value);
    if (value === null) {
      if (field.required) throw new Error(field.label + ' 不能为空');
      deleteIn(doc, path);
    } else {
      if (field.ruleSets) {
        const sets = isObject(data['rule-providers']) ? data['rule-providers'] : {};
        for (const name of value) if (!isObject(sets[name])) throw new Error('规则集不存在：' + name);
      }
      setIn(doc, path, value);
    }
  }

  function collectionInfo(kind) {
    return kind === 'provider'
      ? { key: 'proxy-providers', fields: PROVIDER_FIELDS, dir: './proxy_provider/', title: '订阅' }
      : { key: 'rule-providers', fields: RULE_PROVIDER_FIELDS, dir: './rule_provider/', title: '规则集' };
  }

  function providerAnchor(doc, key) {
    const map = doc.get(key, true);
    if (!Y.isMap(map)) return null;
    for (const pair of map.items) {
      if (!Y.isMap(pair.value)) continue;
      for (const inner of pair.value.items) {
        if (isMergeKey(inner.key) && Y.isAlias(inner.value)) return inner.value.source;
      }
    }
    return null;
  }

  function applyCollection(doc, data, op) {
    const [kind, action] = op.op.split('.');
    const info = collectionInfo(kind);
    const name = check.name(op.name);
    const items = isObject(data[info.key]) ? data[info.key] : {};
    if (action === 'delete') {
      if (!(name in items)) throw new Error(info.title + '不存在：' + name);
      if (kind === 'ruleProvider' && (Array.isArray(data.rules) ? data.rules : []).some((rule) => typeof rule === 'string' && ruleUses(rule, name))) {
        throw new Error('规则仍在引用规则集 ' + name + '，请先在配置原文中删除相关规则');
      }
      doc.deleteIn([info.key, name]);
      if (kind === 'provider') unlinkProvider(doc, data, name);
      return;
    }
    if (action === 'add' && name in items) throw new Error(info.title + '已存在：' + name);
    if (action === 'set' && !(name in items)) throw new Error(info.title + '不存在：' + name);
    if (action === 'set' && items[name].type !== 'http') throw new Error('只能编辑 http 类型的' + info.title);
    const values = isObject(op.values) ? op.values : {};
    if (action === 'add') {
      const anchor = kind === 'provider' ? providerAnchor(doc, info.key) : null;
      const node = doc.createNode({});
      if (anchor) node.items.push(doc.createPair(new Y.Scalar(Symbol.for('<<')), new Y.Alias(anchor)));
      if (!anchor || kind !== 'provider') node.set('type', 'http');
      if (!Y.isMap(doc.get(info.key, true))) doc.set(info.key, doc.createNode({}));
      doc.get(info.key, true).set(name, node);
      if (kind === 'provider') {
        if (!anchor) {
          node.set('interval', 3600);
          node.set('health-check', doc.createNode({ enable: true, url: 'https://cp.cloudflare.com', interval: 300, timeout: 5000 }));
        }
        node.set('path', info.dir + name + '.yaml');
        if (op.join !== false) joinProvider(doc, data, name);
      }
    }
    for (const field of info.fields) {
      const id = field.key.join('.');
      if (!(id in values)) continue;
      const value = normalizeValue(field, values[id]);
      const path = [info.key, name].concat(field.key);
      if (value === null) {
        if (field.required) throw new Error(field.label + ' 不能为空');
        deleteIn(doc, path);
      } else setIn(doc, path, value);
    }
    if (kind === 'ruleProvider') {
      const item = plain(doc)[info.key][name];
      if (item.behavior === 'classical' && item.format === 'mrs') throw new Error('mrs 格式不支持 classical 类型');
      if (!item.behavior) setIn(doc, [info.key, name, 'behavior'], 'domain');
      const extension = item.format === 'mrs' ? '.mrs' : item.format === 'text' ? '.list' : '.yaml';
      setIn(doc, [info.key, name, 'path'], info.dir + name + extension);
    }
    const final = plain(doc)[info.key][name];
    if (!final.url) throw new Error('链接不能为空');
  }

  // 新订阅加入「引用了全部订阅」的策略组（与 LuCI join_groups 一致）。
  function joinProvider(doc, data, name) {
    const all = Object.keys(isObject(data['proxy-providers']) ? data['proxy-providers'] : {});
    if (!all.length) return;
    visitUseLists(doc, (seq) => {
      const names = seq.items.map((item) => (Y.isScalar(item) ? String(item.value) : ''));
      if (all.every((provider) => names.includes(provider)) && !names.includes(name)) seq.add(doc.createNode(name));
    });
  }

  function unlinkProvider(doc, data, name) {
    visitUseLists(doc, (seq) => {
      seq.items = seq.items.filter((item) => !(Y.isScalar(item) && String(item.value) === name));
    });
    void data;
  }

  function visitUseLists(doc, visit) {
    const seen = new Set();
    Y.visit(doc, {
      Pair(_, pair) {
        if (Y.isScalar(pair.key) && pair.key.value === 'use' && Y.isSeq(pair.value) && !seen.has(pair.value)) {
          seen.add(pair.value);
          visit(pair.value);
        }
      },
    });
  }

  // ---------- 分析 ----------

  function looksLikeSubscription(text) {
    const trimmed = text.trim();
    if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 64 && !/:\s/.test(trimmed)) return true;
    const lines = trimmed.split(/\n/).filter(Boolean);
    return lines.length > 0 && lines.every((line) => /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|anytls|wireguard|socks5?|https?):\/\//i.test(line.trim()));
  }

  function summarize(doc, data) {
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    const ebpf = listeners.filter((item) => isObject(item) && item.type === 'ebpf');
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const providers = isObject(data['proxy-providers']) ? Object.keys(data['proxy-providers']) : [];
    return {
      proxies: (Array.isArray(data.proxies) ? data.proxies : []).filter((item) => isObject(item) && item.type !== 'dns').length,
      providers: providers.length,
      providerNames: providers.slice(0, 16),
      groups: (Array.isArray(data['proxy-groups']) ? data['proxy-groups'] : []).length,
      rules: rules.length,
      ruleProviders: isObject(data['rule-providers']) ? Object.keys(data['rule-providers']).length : 0,
      mode: String(data.mode || 'rule'),
      ebpf: ebpf.length === 1 && listeners.length === 1,
      listeners: listeners.length,
      tun: !!(isObject(data.tun) && data.tun.enable),
      dns: !!(isObject(data.dns) && data.dns.enable),
      dnsMode: isObject(data.dns) ? String(data.dns['enhanced-mode'] || '') : '',
      controller: typeof data['external-controller'] === 'string' ? data['external-controller'] : '',
      anchors: doc ? countAnchors(doc) : 0,
    };
  }

  function countAnchors(doc) {
    let count = 0;
    Y.visit(doc, { Node(_, node) { if (node.anchor) count++; } });
    return count;
  }

  function analyze(content) {
    const text = String(content == null ? '' : content);
    if (!text.trim()) throw new Error('内容为空');
    if (looksLikeSubscription(text)) {
      return { ok: true, kind: 'subscription', message: '这是节点订阅而不是完整配置，可作为订阅加入内置模板。' };
    }
    const doc = parse(text);
    const data = plain(doc);
    const summary = summarize(doc, data);
    const full = summary.proxies + summary.providers > 0 || summary.groups > 0 || summary.rules > 0;
    return { ok: true, kind: full ? 'config' : 'partial', summary,
      message: full ? '' : '没有找到节点、订阅、策略组或规则，导入后可能无法上网。' };
  }

  // ---------- 本机优化 ----------
  // host: { ipv6, interfaces:[name], memMb, sdk, mirror }
  // options.skip: [id]。返回 changes: [{id, title, detail, optional}]，content 为应用了未跳过项后的结果。

  function hasRuleType(rules, pattern) {
    return rules.some((rule) => typeof rule === 'string' && pattern.test(rule));
  }

  // 旧写法（与 LuCI ebpf_normalize 一致）：顶层 dns-mode / bypass-private-address 作为各角色缺省值，ipv6-mode 换成 ipv6。
  const LISTENER_LEGACY = ['dns-mode', 'bypass-private-address', 'ipv6-mode', 'tcp-splice'];

  function legacyListenerKeys(listener) {
    if (!isObject(listener)) return [];
    const keys = LISTENER_LEGACY.filter((key) => listener[key] !== undefined);
    for (const role of ['local', 'shared']) if (isObject(listener[role]) && listener[role]['ipv6-mode'] !== undefined) keys.push(role + '.ipv6-mode');
    return keys;
  }

  function tailnetPresent(data) {
    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return proxies.some((item) => isObject(item) && item.type === 'tailscale');
  }

  const TAILNET_CIDRS = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

  function buildListener(data, current, host) {
    const ipcidr = Object.entries(isObject(data['rule-providers']) ? data['rule-providers'] : {})
      .filter(([, item]) => isObject(item) && item.behavior === 'ipcidr').map(([name]) => name);
    const base = isObject(current) ? current : {};
    const tailnet = tailnetPresent(data);
    const role = (name, defaults) => {
      const source = isObject(base[name]) ? base[name] : {};
      const result = Object.assign({}, defaults);
      for (const key of ['dns-mode', 'bypass-private-address']) if (base[key] !== undefined) result[key] = base[key];
      for (const [key, value] of Object.entries(source)) {
        if (['enable', 'enabled', 'interface', 'exclude-package', 'ipv6-mode'].includes(key)) continue;
        result[key] = value;
      }
      if (source['ipv6-mode'] !== undefined && source.ipv6 === undefined) result.ipv6 = source['ipv6-mode'] !== 'off';
      // 本机 DNS 由模块按「应用绕过」策略生成（respect_policy），这里不保留
      if (name === 'local') delete result['dns-mode'];
      if (host && host.ipv6 === false) result.ipv6 = false;
      // 有 Tailscale 出站时，Tailnet 地址段必须进入 mihomo，不能当作私网在内核直连
      if (tailnet) {
        const exclude = Array.isArray(result['bypass-exclude']) ? result['bypass-exclude'].slice() : [];
        for (const cidr of TAILNET_CIDRS) if (!exclude.includes(cidr)) exclude.push(cidr);
        result['bypass-exclude'] = exclude;
      }
      return result;
    };
    const listener = { name: String(base.name || 'ebpf-in'), type: 'ebpf' };
    listener.network = Array.isArray(base.network) && base.network.length ? base.network : ['tcp', 'udp'];
    listener['udp-timeout'] = Number.isInteger(base['udp-timeout']) ? base['udp-timeout'] : 300;
    const bypass = Array.isArray(base['bypass-rule-set']) ? base['bypass-rule-set'].filter((name) => ipcidr.includes(name))
      : ipcidr.filter((name) => /^(cn|cn-?ip|china.?ip|cncidr|geoip-cn)$/i.test(name));
    if (bypass.length) listener['bypass-rule-set'] = bypass;
    for (const key of ['fakeip-icmp', 'bypass-tun-direct', 'tc-priority']) if (base[key] !== undefined) listener[key] = base[key];
    listener.local = role('local', { 'data-plane': 'cgroup', ipv6: true, 'bypass-private-address': true });
    listener.shared = role('shared', { 'data-plane': 'packet_rewrite', 'dns-mode': 'hijack', ipv6: true, 'bypass-private-address': true });
    return listener;
  }

  function optimize(content, host, options) {
    const doc = parse(content);
    const skip = new Set(options && Array.isArray(options.skip) ? options.skip : []);
    const info = host || {};
    const changes = [];
    const step = (id, title, detail, optional, run) => {
      changes.push({ id, title, detail, optional: optional !== false, applied: !skip.has(id) || optional === false });
      if (!skip.has(id) || optional === false) run();
    };
    let data = plain(doc);
    const rules = Array.isArray(data.rules) ? data.rules : [];
    const refresh = () => { data = plain(doc); };

    // 1. eBPF listener：模块唯一的透明代理入口（必需）。
    const listeners = Array.isArray(data.listeners) ? data.listeners : [];
    const ebpf = listeners.filter((item) => isObject(item) && item.type === 'ebpf');
    const listenerNode = doc.get('listeners', true);
    let listenerFlow = false;
    if (Y.isSeq(listenerNode)) {
      // policy-yaml.awk 要求 listener 与 local/shared 为块映射，且不含锚点/别名；流式列表可以保留。
      Y.visit(listenerNode, {
        Map(_, node) { if (node.flow || node.anchor) listenerFlow = true; },
        Seq(_, node) { if (node.anchor) listenerFlow = true; },
        Scalar(_, node) { if (node.anchor || (typeof node.value === 'string' && node.value.includes('\n'))) listenerFlow = true; },
        Alias() { listenerFlow = true; },
      });
      for (const item of listenerNode.items) {
        if (Y.isMap(item)) for (const pair of item.items) if (isMergeKey(pair.key)) listenerFlow = true;
      }
    }
    const legacy = ebpf.length === 1 ? legacyListenerKeys(ebpf[0]) : [];
    const tailnetMissing = ebpf.length === 1 && tailnetPresent(data) && ['local', 'shared'].some((role) => {
      const exclude = isObject(ebpf[0][role]) && Array.isArray(ebpf[0][role]['bypass-exclude']) ? ebpf[0][role]['bypass-exclude'] : [];
      return !TAILNET_CIDRS.every((cidr) => exclude.includes(cidr));
    });
    const listenerOk = ebpf.length === 1 && listeners.length === 1 && !listenerFlow && !legacy.length && !tailnetMissing;
    if (!listenerOk) {
      const removed = listeners.length - ebpf.length;
      const detail = !ebpf.length ? '新增 eBPF 透明代理入口（本机 cgroup + 共享 packet_rewrite）'
        : legacy.length ? '把旧写法 ' + legacy.join('、') + ' 展开到 local/shared' + (tailnetMissing ? '，并让 Tailnet 地址进入 mihomo' : '')
        : tailnetMissing ? 'Tailnet 地址（100.64.0.0/10）加入 bypass-exclude，避免被当作私网直连'
        : '整理为模块可接管的单个 eBPF listener';
      step('ebpf', ebpf.length ? '规范 eBPF 入站' : '添加 eBPF 入站',
        detail + (removed > 0 ? '，移除 ' + removed + ' 个不适用于手机的 listener' : ''), false, () => {
          const built = buildListener(data, ebpf[0], info);
          const node = doc.createNode([built]);
          node.flow = false;
          Y.visit(node, { Seq(_, seq) { if (seq !== node) seq.flow = true; } });
          doc.set('listeners', node);
          refresh();
        });
    } else if (info.ipv6 === false && (ebpf[0].local && ebpf[0].local.ipv6 !== false)) {
      step('ebpf-ipv6', '关闭 eBPF 的 IPv6 处理', '本机没有可用的 IPv6 出口', true, () => {
        const index = ebpfIndex(data);
        setIn(doc, ['listeners', index, 'local', 'ipv6'], false);
        setIn(doc, ['listeners', index, 'shared', 'ipv6'], false);
        refresh();
      });
    }

    // 2. 关闭 TUN：与 eBPF 透明代理二选一，同时开启会抢占路由。
    if (isObject(data.tun) && data.tun.enable) {
      step('tun', '关闭 TUN', 'eBPF 已接管透明代理，TUN 会与其冲突', false, () => { setIn(doc, ['tun', 'enable'], false); refresh(); });
    }

    // 3. 去掉路由器专用字段。
    const routerKeys = ['tproxy-port', 'redir-port', 'routing-mark', 'interface-name', 'iptables', 'ebpf', 'auto-redirect'].filter((key) => data[key] !== undefined);
    if (routerKeys.length) {
      step('router', '移除路由器专用字段', routerKeys.join('、') + ' 在手机上无效或会让出站绑定到不存在的网卡', true, () => {
        for (const key of routerKeys) doc.delete(key);
        refresh();
      });
    }

    // 4. 控制器：只监听本机，并确保有密钥。
    const controller = typeof data['external-controller'] === 'string' ? data['external-controller'] : '';
    const port = /:(\d{1,5})$/.exec(controller);
    if (!controller) {
      step('controller', '启用本机控制器', '模块通过 127.0.0.1:9090 管理内核', false, () => { doc.set('external-controller', '127.0.0.1:9090'); refresh(); });
    } else if (!/^(127\.0\.0\.1|localhost|\[::1\]):/.test(controller)) {
      step('controller', '控制器只监听本机', controller + ' 会在公共 Wi-Fi 下暴露管理接口，改为 127.0.0.1:' + (port ? port[1] : '9090'), true, () => {
        doc.set('external-controller', '127.0.0.1:' + (port ? port[1] : '9090'));
        refresh();
      });
    }
    if (!data.secret) {
      step('secret', '生成控制器密钥', '防止本机其它应用调用控制接口', true, () => { doc.set('secret', randomHex(16)); refresh(); });
    }
    // 内核只允许数据目录内的路径（SAFE_PATHS）；导入的路由器配置常带 /etc/... 等绝对路径。
    const pathFixes = [];
    const relative = (value, fallback) => {
      const base = String(value).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).pop();
      return './' + (fallback ? fallback + '/' : '') + (base || 'file');
    };
    const isUnsafe = (value) => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes('..'));
    if (isUnsafe(data['external-ui'])) pathFixes.push([['external-ui'], './dashboard']);
    for (const [section, dir] of [['proxy-providers', 'proxy_provider'], ['rule-providers', 'rule_provider']]) {
      const items = isObject(data[section]) ? data[section] : {};
      for (const [name, item] of Object.entries(items)) {
        if (isObject(item) && isUnsafe(item.path)) pathFixes.push([[section, name, 'path'], relative(item.path, dir)]);
      }
    }
    for (const key of ['geoip', 'geosite', 'mmdb', 'asn']) {
      if (isObject(data['geox-path']) && isUnsafe(data['geox-path'][key])) pathFixes.push([['geox-path', key], relative(data['geox-path'][key])]);
    }
    if (pathFixes.length) {
      step('paths', '改写数据目录外的路径', pathFixes.map(([path]) => path.join('.')).slice(0, 4).join('、') +
        (pathFixes.length > 4 ? ' 等 ' + pathFixes.length + ' 项' : '') + ' 指向数据目录外，内核会拒绝加载，改为相对路径', false, () => {
        for (const [path, value] of pathFixes) {
          const node = doc.getIn(path.slice(0, -1), true);
          // 带合并键的条目直接在条目层写入，避免改到锚点
          if (Y.isMap(node)) node.set(path[path.length - 1], value); else setIn(doc, path, value);
        }
        refresh();
      });
    }
    if (!data['external-ui']) {
      step('dashboard', '配置网页面板', '使用 zashboard，首次访问时自动下载', true, () => {
        doc.set('external-ui', './dashboard');
        if (!data['external-ui-url']) doc.set('external-ui-url', (info.mirror || '') + ZASHBOARD);
        refresh();
      });
    }

    // 5. 局域网入站：手机共享走 eBPF，不需要对外开放混合端口。
    if (data['allow-lan'] === true && !info.keepLan) {
      step('lan', '关闭局域网入站', '热点/USB 共享由 eBPF 接管，关闭后公共 Wi-Fi 下更安全', true, () => {
        doc.set('allow-lan', false);
        if (data['bind-address'] !== undefined) doc.delete('bind-address');
        refresh();
      });
    }

    // 6. DNS：eBPF 劫持 53 端口后交给 DNS 出站处理。
    const dns = isObject(data.dns) ? data.dns : null;
    if (!dns) {
      step('dns', '启用 DNS 模块', 'redir-host 模式，国内上游 223.5.5.5 / 119.29.29.29', false, () => {
        doc.set('dns', doc.createNode({ enable: true, ipv6: info.ipv6 === true, listen: '127.0.0.1:1053', 'enhanced-mode': 'redir-host',
          'default-nameserver': ['223.5.5.5', '119.29.29.29'], nameserver: ['223.5.5.5', '119.29.29.29'] }));
        refresh();
      });
    } else if (!dns.enable || !dns.listen) {
      step('dns', '启用 DNS 模块', '原配置的 DNS 未启用或缺少监听地址', false, () => {
        setIn(doc, ['dns', 'enable'], true);
        if (!dns.listen) setIn(doc, ['dns', 'listen'], '127.0.0.1:1053');
        refresh();
      });
    }
    const dnsProxy = (Array.isArray(data.proxies) ? data.proxies : []).find((item) => isObject(item) && item.type === 'dns');
    const hijackRule = dnsProxy && rules.some((rule) => typeof rule === 'string' && /^DST-PORT\s*,\s*53\s*,/.test(rule.trim()));
    if (!dnsProxy || !hijackRule) {
      step('dns-hijack', '接管 53 端口 DNS', '添加 DNS 出站与 DST-PORT,53 规则，避免应用绕过 DNS 设置', false, () => {
        let name = dnsProxy ? String(dnsProxy.name) : 'DNS_Hijack';
        if (!dnsProxy) {
          const taken = new Set(policies(data));
          for (let index = 2; taken.has(name); index++) name = 'DNS_Hijack-' + index;
          if (!Y.isSeq(doc.get('proxies', true))) doc.set('proxies', doc.createNode([]));
          const node = doc.createNode({ name, type: 'dns' });
          node.flow = true;
          doc.get('proxies', true).items.unshift(node);
        }
        if (!hijackRule) {
          if (!Y.isSeq(doc.get('rules', true))) doc.set('rules', doc.createNode([]));
          doc.get('rules', true).items.unshift(doc.createNode('DST-PORT,53,' + name));
        }
        refresh();
      });
    }

    // 7. IPv6：本机没有 IPv6 出口时关闭，避免连接先走 IPv6 超时。
    if (info.ipv6 === false && data.ipv6 !== false) {
      step('ipv6', '关闭 IPv6', '当前网络没有 IPv6 默认路由，避免 AAAA 解析导致的连接等待', true, () => {
        doc.set('ipv6', false);
        if (isObject(data.dns) && data.dns.ipv6) setIn(doc, ['dns', 'ipv6'], false);
        refresh();
      });
    }

    // 8. 进程匹配：Android 上按包名分流需要 find-process-mode；不用时关闭以省电。
    const usesProcess = hasRuleType(rules, /^(AND|OR|NOT|SUB-RULE)?.*\b(PROCESS-NAME|PROCESS-PATH|PROCESS-NAME-REGEX|PROCESS-PATH-REGEX|UID)\b/);
    if (usesProcess && data['find-process-mode'] === 'off') {
      step('process', '开启进程匹配', '规则里有 PROCESS-NAME/UID，Android 上按包名匹配需要 strict', true, () => { doc.set('find-process-mode', 'strict'); refresh(); });
    } else if (!usesProcess && data['find-process-mode'] === undefined) {
      step('process', '关闭进程查找', '规则没有按应用分流，关闭可降低 CPU 占用', true, () => { doc.set('find-process-mode', 'off'); refresh(); });
    }

    // 9. GEO 数据：使用 jsDelivr 镜像，低内存设备用省内存加载。
    const usesGeo = hasRuleType(rules, /\b(GEOSITE|GEOIP|SRC-GEOIP)\b/) || JSON.stringify(data.dns || {}).includes('geosite:');
    if (usesGeo && !isObject(data['geox-url'])) {
      step('geox', '设置 GEO 数据下载镜像', 'GitHub 直连不稳定时也能下载 geoip/geosite', true, () => { doc.set('geox-url', doc.createNode(GEOX)); refresh(); });
    }
    if (usesGeo && Number(info.memMb) > 0 && Number(info.memMb) < 6144 && data['geodata-loader'] === undefined) {
      step('geodata', 'GEO 数据省内存加载', '本机内存 ' + Math.round(Number(info.memMb) / 1024) + ' GB，减少常驻内存', true, () => {
        doc.set('geodata-loader', 'memconservative');
        refresh();
      });
    }

    // 10. 体验与功耗。
    if (data['log-level'] === 'debug' || data['log-level'] === 'info' || data['log-level'] === undefined) {
      step('log', '降低日志级别', '改为 warning，减少写入与耗电', true, () => { doc.set('log-level', 'warning'); refresh(); });
    }
    if (data['tcp-concurrent'] === undefined) {
      step('tcp', '开启 TCP 并发', '同时连接多个解析结果，移动网络下更快', true, () => { doc.set('tcp-concurrent', true); refresh(); });
    }
    if (!isObject(data.profile) || data.profile['store-selected'] === undefined) {
      step('profile', '记住手动选择的节点', '重启内核后保留选择', true, () => { setIn(doc, ['profile', 'store-selected'], true); refresh(); });
    }
    if (!isObject(data.sniffer)) {
      step('sniffer', '开启域名嗅探', '从 TLS/HTTP 中识别域名，提升规则命中率', true, () => {
        doc.set('sniffer', doc.createNode({ enable: true, sniff: { HTTP: { ports: [80, '8080-8880'] }, TLS: { ports: [443, 8443] }, QUIC: { ports: [443, 8443] } } }));
        refresh();
      });
    }

    const output = dump(doc);
    parse(output);
    return { ok: true, content: output, changes, summary: summarize(parse(output), plain(parse(output))) };
  }

  // 订阅转配置时，把多个订阅写进内置模板之后统一走 optimize。
  root.mihomoConfig = Object.freeze({ parse: (content) => { parse(content); return { ok: true }; }, schema, patch, analyze, optimize, check });
})(typeof window !== 'undefined' ? window : globalThis);
