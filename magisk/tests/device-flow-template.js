// 测试辅助：在真机 WebUI 内跑「订阅 → 内置模板 → 按本机优化 → 内核校验」，以及路由器风格配置的「导入 → 优化 → 校验」。不写入 config.yaml。
(async () => {
  const call = async (operation, payload = {}) => JSON.parse(await window.mihomoBridge.request(operation, JSON.stringify(payload)));
  const host = await call('hostProbe');
  const hostPayload = { ipv6: host.ipv6, memMb: host.mem_mb, sdk: host.sdk, mirror: host.mirror };
  const result = {};
  const template = await call('template', { subscriptions: [{ name: '测试订阅', url: 'https://example.com/sub' }] });
  if (!template.ok) return { templateError: template.error };
  const optimizedTemplate = await call('configOptimize', { content: template.content, host: hostPayload });
  result.template = {
    changes: optimizedTemplate.changes.map((change) => (change.optional ? '·' : '!') + change.id),
    validate: (await call('validate', { content: optimizedTemplate.content })).ok || 'failed',
  };
  const router = [
    'mixed-port: 7890', 'tproxy-port: 7894', 'routing-mark: 6666', 'allow-lan: true', 'external-controller: 0.0.0.0:9090',
    'external-ui: /etc/openclash/ui', 'log-level: debug', 'tun:', '  enable: true', '  stack: system',
    'proxies:', '  - {name: 香港, type: ss, server: 1.2.3.4, port: 443, cipher: aes-128-gcm, password: test}',
    'proxy-groups:', '  - {name: 节点选择, type: select, proxies: [香港, DIRECT]}',
    'rule-providers:', '  cn: {type: http, behavior: ipcidr, format: mrs, url: "https://example.com/cn.mrs", path: /etc/openclash/rule/cn.mrs}',
    'rules:', '  - PROCESS-NAME,com.tencent.mm,DIRECT', '  - RULE-SET,cn,DIRECT', '  - MATCH,节点选择', '',
  ].join('\n');
  const optimizedRouter = await call('configOptimize', { content: router, host: hostPayload });
  const validation = await call('validate', { content: optimizedRouter.content });
  result.router = {
    changes: optimizedRouter.changes.map((change) => (change.optional ? '·' : '!') + change.id),
    validate: validation.ok || validation.error.split('\n').filter((line) => /error|failed/.test(line)).join(' | '),
  };
  return result;
})()
