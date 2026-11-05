// 测试辅助：在真机 WebUI 内（经 CDP 注入）跑「下载 → 分析 → 按本机优化 → 内核校验」，不写入 config.yaml。
(async () => {
  const call = async (operation, payload = {}) => JSON.parse(await window.mihomoBridge.request(operation, JSON.stringify(payload)));
  const out = {};
  const host = await call('hostProbe');
  out.host = { ipv6: host.ipv6, mem: host.mem_mb, upstream: host.upstream, btf: host.btf };
  const imported = await call('importUrl', { url: window.__flowUrl, ua: '' });
  if (!imported.ok) return { ...out, importError: imported.error };
  out.importLength = imported.content.length;
  const analysis = await call('configAnalyze', { content: imported.content });
  out.kind = analysis.kind;
  out.summary = analysis.summary;
  const optimized = await call('configOptimize', {
    content: imported.content,
    host: { ipv6: host.ipv6, memMb: host.mem_mb, sdk: host.sdk, mirror: host.mirror },
  });
  if (!optimized.ok) return { ...out, optimizeError: optimized.error };
  out.changes = optimized.changes.map((change) => `${change.optional ? '·' : '!'} ${change.id}`);
  out.optimizedLength = optimized.content.length;
  const started = Date.now();
  const validation = await call('validate', { content: optimized.content });
  out.validate = validation.ok ? `ok (${Date.now() - started} ms)` : validation.error;
  const again = await call('configOptimize', { content: optimized.content, host: { ipv6: host.ipv6, memMb: host.mem_mb } });
  out.idempotentRequired = again.changes.filter((change) => !change.optional).map((change) => change.id);
  return out;
})()
