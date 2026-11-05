'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const artifactRoot = path.resolve(process.env.WEBUI_ROOT || path.join(__dirname, '../webui/build/dist/wasmJs/productionExecutable'));
const previewURL = new URL('http://127.0.0.1:8765/');
const nodeCount = 2000;
const connectionCount = 240;
const maxMountedNodes = 128;

function previewBackend(options) {
  const nodes = Array.from({ length: options.nodeCount }, (_, index) => `QA-NODE-${String(index).padStart(4, '0')}`);
  const proxies = { 'QA-SELECTOR': { name: 'QA-SELECTOR', type: 'Selector', now: nodes[0], all: nodes } };
  for (let group = 0; group < 3; group++) {
    const name = `QA-BALANCE-${group}`;
    proxies[name] = { name, type: 'LoadBalance', all: Array.from({ length: 4 }, (_, index) => `QA-LB-${group}-${index}`) };
  }
  const connections = Array.from({ length: options.connectionCount }, (_, index) => {
    const duplicate = index >= options.connectionCount - 8;
    return {
      id: index % 3 === 0 ? '' : duplicate ? 'duplicate-tail-id' : index % 3 === 1 ? 'duplicate-id' : `id-${index}`,
      start: duplicate ? '2026-01-01T00:00:00Z' : `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
      metadata: {
        network: 'tcp', sourceIP: '192.0.2.1', sourcePort: duplicate ? '45000' : String(40000 + index),
        destinationIP: '198.51.100.1', destinationPort: '443', host: `qa-conn-${String(index).padStart(4, '0')}.invalid`,
      },
      upload: index * 1024, download: index * 2048, chains: ['QA-SELECTOR'],
    };
  });
  const mock = window.__liveMock = { calls: [], writes: [], unexpected: [], pending: {}, hold: {}, failures: {}, reads: {} };
  mock.release = endpoint => {
    const resolve = mock.pending[endpoint];
    if (!resolve) throw new Error(`No pending request for ${endpoint}`);
    delete mock.pending[endpoint];
    resolve();
  };
  window.mihomoBridge = Object.freeze({ request: async (operation, raw = '{}') => {
    const payload = JSON.parse(raw);
    const call = { operation, payload, completed: false };
    mock.calls.push(call);
    let response;
    if (operation === 'controller') {
      const endpoint = payload.path;
      const method = payload.method || 'GET';
      if (method !== 'GET') {
        mock.writes.push({ operation, payload });
        response = { ok: false, error: 'Smoke test forbids controller writes' };
      } else if (['/proxies', '/connections', '/version'].includes(endpoint)) {
        mock.reads[endpoint] = (mock.reads[endpoint] || 0) + 1;
        if (mock.hold[endpoint]) {
          delete mock.hold[endpoint];
          await new Promise(resolve => { mock.pending[endpoint] = resolve; });
        }
        if (mock.failures[endpoint] > 0) {
          mock.failures[endpoint]--;
          response = { ok: false, error: `mock ${endpoint} refresh failed` };
        } else if (endpoint === '/proxies') {
          response = { ok: true, data: { proxies } };
        } else if (endpoint === '/connections') {
          response = { ok: true, data: {
            connections: connections.map(connection => ({ ...connection, upload: connection.upload + mock.reads[endpoint] })),
            uploadTotal: 123456, downloadTotal: 789012,
          } };
        } else response = { ok: true, data: { version: 'live-smoke' } };
      } else {
        mock.unexpected.push({ operation, payload });
        response = { ok: false, error: `Unmocked controller endpoint: ${endpoint}` };
      }
    } else if (operation === 'onboardingState') {
      response = { ok: true, has_config: true, completed: true };
    } else if (operation === 'status') {
      response = { ok: true, running: false, desired: 'stopped', allowed: true, current_ssid: '' };
    } else if (operation === 'coreInfo') {
      response = { ok: true, installed: true, version: 'live-smoke', can_rollback: false };
    } else if (operation === 'policyGet') {
      response = { ok: true, autostart: false, tethering: false, tethering_interfaces: 'ap0', bypass_packages: '', wifi_mode: 'off', wifi_ssids: '', allowed: true, current_ssid: '' };
    } else if (operation === 'configRead') {
      response = { ok: true, content: 'external-controller: 127.0.0.1:9090\nsecret: live-smoke\n' };
    } else {
      mock.unexpected.push({ operation, payload });
      mock.writes.push({ operation, payload });
      response = { ok: false, error: `Unmocked operation: ${operation}` };
    }
    call.completed = true;
    call.ok = response.ok;
    return JSON.stringify(response);
  } });
}

async function installRoutes(context, external, missing) {
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.yaml': 'text/plain',
    '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== previewURL.origin || request.method() !== 'GET') {
      external.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (url.pathname === '/backend.js') {
      return route.fulfill({ contentType: mime['.js'], body: `(${previewBackend.toString()})(${JSON.stringify({ nodeCount, connectionCount })});` });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filename = path.resolve(artifactRoot, relative);
    const withinRoot = path.relative(artifactRoot, filename);
    if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return route.abort();
    try {
      return await route.fulfill({ contentType: mime[path.extname(filename)] || 'application/octet-stream', body: await fs.promises.readFile(filename) });
    } catch {
      missing.push(relative);
      return route.fulfill({ status: 404, body: 'Missing prebuilt WebUI asset; build outside this smoke test.' });
    }
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
  } else {
    await context.addInitScript(() => {
      window.WebSocket = class { constructor() { throw new Error('WebSocket disabled by live smoke'); } };
    });
  }
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const node = (page, name) => button(page, name);

async function until(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

async function click(page, target) {
  await target.waitFor({ state: 'visible' });
  await until(() => target.isEnabled(), 'control enabled');
  await target.click({ force: true });
  await page.waitForTimeout(180);
}

async function wheel(page, amount) {
  await page.mouse.move(195, 560);
  await page.mouse.wheel(0, amount);
  await page.waitForTimeout(250);
}

async function seek(page, target, amount, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await target.isVisible()) {
      const bounds = await target.boundingBox();
      if (bounds) {
        const midY = bounds.y + bounds.height / 2;
        if (bounds.y >= 80 && midY < 770) return;
      }
    }
    await wheel(page, amount);
  }
  throw new Error(`Scroll target not in viewport: ${target}`);
}

async function assertNoWrites(page) {
  assert.deepEqual(await page.evaluate(() => window.__liveMock.writes), [], 'read-only/disabled controls must not call write APIs');
}

async function tryDisabled(page, target) {
  await target.waitFor({ state: 'visible' });
  const bounds = await target.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, 'disabled control must remain rendered');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await target.dispatchEvent('click');
  await page.waitForTimeout(150);
  await assertNoWrites(page);
}

async function mountedNodes(page) {
  return page.getByRole('button', { name: /^QA-NODE-\d{4}$/, includeHidden: true }).evaluateAll(elements => elements.map(element =>
    `${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`,
  ).filter(label => /QA-NODE-\d{4}/.test(label)));
}

async function boundedNodes(page) {
  const names = await mountedNodes(page);
  assert.ok(names.length > 0 && names.length < maxMountedNodes, `Expected < ${maxMountedNodes} mounted node semantics for ${nodeCount} nodes; got ${names.length}`);
  return names;
}

async function holdFailure(page, endpoint) {
  await page.evaluate(endpoint => {
    window.__liveMock.hold[endpoint] = true;
    window.__liveMock.failures[endpoint] = 1;
  }, endpoint);
}

async function awaitPending(page, endpoint) {
  await page.waitForFunction(endpoint => typeof window.__liveMock.pending[endpoint] === 'function', endpoint);
}

async function releaseFailure(page, endpoint) {
  await page.evaluate(endpoint => window.__liveMock.release(endpoint), endpoint);
  await page.getByText('快照已过期 · 请刷新后操作', { exact: true }).waitFor({ state: 'visible' });
}

async function proxyScenario(page) {
  const started = Date.now();
  await click(page, button(page, '网络'));
  await node(page, 'QA-NODE-0001').waitFor({ state: 'visible' });
  await until(() => node(page, 'QA-NODE-0001').isEnabled(), 'fresh proxy snapshot writable');
  const initial = await boundedNodes(page);
  const firstReadyMs = Date.now() - started;
  await wheel(page, 2400);
  await until(async () => {
    const current = await mountedNodes(page);
    return current.some(name => !initial.includes(name)) && initial.some(name => !current.includes(name));
  }, 'scroll composes different nodes and unmounts offscreen nodes');
  const scrolled = await boundedNodes(page);
  assert.ok(initial.some(name => !scrolled.includes(name)), 'offscreen node semantics must leave the mounted set');
  const scrollMax = Math.max(...scrolled.map(name => Number(name.match(/QA-NODE-(\d{4})/)[1])));
  assert.ok(scrollMax > 10, 'scroll must reveal nodes beyond the initial rows');
  await seek(page, button(page, '刷新代理组'), -1000000);
  await holdFailure(page, '/proxies');
  await click(page, button(page, '刷新代理组'));
  await awaitPending(page, '/proxies');
  await page.getByText('刷新中 · 显示上次快照', { exact: true }).waitFor({ state: 'visible' });
  await tryDisabled(page, node(page, 'QA-NODE-0001'));
  await releaseFailure(page, '/proxies');
  await tryDisabled(page, node(page, 'QA-NODE-0001'));
  await boundedNodes(page);
  await click(page, button(page, '刷新代理组'));
  await until(() => node(page, 'QA-NODE-0001').isEnabled(), 'successful retry restores proxy writes');
  await seek(page, node(page, 'QA-LB-2-3'), 1000000);
  await tryDisabled(page, node(page, 'QA-LB-2-3'));
  await assertNoWrites(page);
  return { firstReadyMs, nodeCount, initialMountedNodeSemantics: initial.length, scrolledMountedNodeSemantics: scrolled.length, scrollMax, loadBalanceReadOnly: true };
}

async function connectionScenario(page) {
  await click(page, button(page, '网络'));
  await node(page, 'QA-NODE-0001').waitFor({ state: 'visible' });
  await click(page, button(page, '连接'));
  const newest = page.getByText('qa-conn-0239.invalid:443', { exact: true });
  await newest.waitFor({ state: 'visible' });
  await until(() => button(page, '全部断开').isEnabled(), 'fresh connections snapshot writable');
  const closeButtons = button(page, '断开连接');
  await seek(page, page.getByText('qa-conn-0234.invalid:443', { exact: true }), 260);
  assert.ok(await closeButtons.count() > 1, 'multiple duplicate/empty-ID rows must coexist');
  // Verify empty-ID row (qa-conn-0234) does not trigger disconnect writes
  const emptyIdCloseBtn = closeButtons.nth(2);
  await tryDisabled(page, emptyIdCloseBtn);
  // Verify usable duplicate-ID row (qa-conn-0235) attempts close write
  const duplicateIdCloseBtn = closeButtons.nth(1);
  await click(page, duplicateIdCloseBtn);
  const writes = await page.evaluate(() => window.__liveMock.writes);
  assert.ok(writes.length > 0 && writes[0].payload.path.includes('duplicate'), 'duplicate-ID row must trigger disconnect write');
  // Reset writes so later assertNoWrites passes
  await page.evaluate(() => { window.__liveMock.writes.length = 0; });
  await seek(page, page.getByText('qa-conn-0040.invalid:443', { exact: true }), 1000000);
  assert.equal(await page.getByText('qa-conn-0039.invalid:443', { exact: true }).count(), 0, 'only latest 200 of 240 records are rendered');
  await seek(page, button(page, '刷新连接'), -1000000);
  await holdFailure(page, '/connections');
  await click(page, button(page, '刷新连接'));
  await awaitPending(page, '/connections');
  await newest.waitFor({ state: 'visible' });
  await tryDisabled(page, button(page, '全部断开'));
  await tryDisabled(page, closeButtons.first());
  await releaseFailure(page, '/connections');
  await newest.waitFor({ state: 'visible' });
  await tryDisabled(page, button(page, '全部断开'));
  await tryDisabled(page, closeButtons.first());
  await click(page, button(page, '刷新连接'));
  await until(() => button(page, '全部断开').isEnabled(), 'successful retry restores connection writes');
  await newest.waitFor({ state: 'visible' });
  await assertNoWrites(page);
  return { connectionCount, displayedLimit: 200, duplicateAndEmptyIds: true, retainedOnFailure: true };
}

const scenarios = [
  { name: 'proxies-2000-lazy-refresh-loadbalance', run: proxyScenario },
  { name: 'connections-240-duplicate-ids-refresh', run: connectionScenario },
];

async function main() {
  assert.ok(fs.existsSync(path.join(artifactRoot, 'mihomo.js')), 'Prebuilt WebUI missing: set WEBUI_ROOT; this smoke test never runs Gradle or starts a server.');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const selected = scenarios.filter(scenario => !process.env.LIVE_SCENARIOS || new RegExp(process.env.LIVE_SCENARIOS).test(scenario.name));
  assert.ok(selected.length, 'LIVE_SCENARIOS matched no scenarios');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-background-networking'] });
  const results = [];
  try {
    for (const scenario of selected) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
      const errors = [];
      const warnings = [];
      const external = [];
      const missing = [];
      let page;
      try {
        context.setDefaultTimeout(20000);
        await installRoutes(context, external, missing);
        page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (message.text().startsWith('Accessing `memory` via `wasmExports` is deprecated.')) {
            warnings.push(message.text());
            return;
          }
          if (message.type() === 'error' || /(?:duplicate|already used|same key|key.*used)/i.test(message.text())) errors.push(message.text());
        });
        await page.goto(previewURL.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
        await button(page, '网络').waitFor({ state: 'visible' });
        const metrics = await scenario.run(page);
        await assertNoWrites(page);
        assert.deepEqual(await page.evaluate(() => window.__liveMock.unexpected), []);
        assert.equal(await page.evaluate(() => typeof window.ksu), 'undefined');
        assert.deepEqual(missing, []);
        assert.deepEqual(external, []);
        assert.deepEqual(errors, [], 'no runtime or duplicate-key errors');
        results.push({ name: scenario.name, result: 'PASS', ...metrics, warnings });
      } catch (error) {
        const observed = page && !page.isClosed() ? await page.evaluate(() => ({
          calls: window.__liveMock?.calls, writes: window.__liveMock?.writes,
          text: document.body.innerText.slice(-5000),
          semantics: Array.from(document.querySelectorAll('[role]')).slice(0, 40).map(element => ({
            role: element.getAttribute('role'), label: element.getAttribute('aria-label'), text: element.textContent,
          })),
        })).catch(() => null) : null;
        const accessibility = page && !page.isClosed() ? await page.locator('body').ariaSnapshot().catch(() => '') : '';
        results.push({ name: scenario.name, result: 'FAIL', error: error.message, errors, warnings, external, missing, observed, accessibility });
      } finally {
        await context.close();
      }
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter(result => result.result === 'FAIL').length;
  console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', passed: results.length - failed, failed,
    artifacts: artifactRoot, backend: 'mocked', server: 'none', network: 'external-aborted',
    virtualizationEvidence: 'mounted node button semantics including hidden nodes; not an instrumented Compose recomposition counter',
  }));
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { previewBackend, scenarios };
