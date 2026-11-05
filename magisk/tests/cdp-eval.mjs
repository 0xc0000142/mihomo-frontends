// 测试辅助：通过 CDP 在真机/AVD 的模块 WebUI 中执行表达式（需先 adb forward 到 9333）。
//   node cdp-eval.mjs '表达式'          结果以 JSON 输出；表达式可为 Promise
const port = process.env.CDP_PORT || 9333;
const expression = process.argv[2];
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.type === 'page' && t.url.includes('kernelsu')) || targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const reply = new Promise((resolve) => {
  ws.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id === 1) resolve(message); };
});
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 120000 } }));
const message = await reply;
console.log(JSON.stringify(message.result?.result?.value ?? message.result?.exceptionDetails ?? message.error, null, 1));
ws.close();
