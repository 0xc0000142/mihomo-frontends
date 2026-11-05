'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const artifactRoot = path.resolve(process.env.WEBUI_ROOT || path.join(__dirname, '../webui/build/dist/wasmJs/productionExecutable'));
const reviewRoot = path.resolve(__dirname, '../../dist/ui-review');
const previewURL = new URL(process.env.WEBUI_URL || 'http://127.0.0.1:8765/');
const policy = {
  autostart: false, tethering: false, tethering_interfaces: 'ap0,usb0',
  bypass_packages: 'com.android.settings\ncom.example.music', wifi_mode: 'only', wifi_ssids: '家庭 Wi-Fi',
};
const generatedConfig = 'external-controller: 127.0.0.1:9090\nsecret: "onboarding-smoke"\nmode: rule\n';
const writes = ['coreSet', 'coreUpdate', 'coreRollback', 'validate', 'apply', 'policySet', 'service', 'onboardingComplete'];

function previewBackend(options) {
  const storageKey = '__onboarding_smoke_state';
  const stored = window.localStorage.getItem(storageKey);
  const state = stored ? JSON.parse(stored) : {
    has_config: options.has_config ?? false, completed: options.completed ?? false,
    installed: options.installed ?? true, policy: { ...options.policy },
    content: options.has_config ? options.content : '',
  };
  const mock = window.__onboardingMock = {
    calls: [], unexpected: [], failures: { ...options.failures }, state,
    stateOverride: options.stateOverride,
  };
  const persist = () => window.localStorage.setItem(storageKey, JSON.stringify(state));
  window.mihomoBridge = Object.freeze({ request: async (operation, raw = '{}') => {
    const payload = JSON.parse(raw);
    const call = { operation, payload };
    mock.calls.push(call);
    let response;
    if (mock.failures[operation] > 0) {
      mock.failures[operation]--;
      response = { ok: false, error: `mock ${operation} failed` };
    } else if (operation === 'onboardingState') {
      response = mock.stateOverride ?? { ok: true, has_config: state.has_config, completed: state.completed };
    } else if (operation === 'onboardingComplete') {
      state.completed = true;
      persist();
      response = { ok: true, completed: true };
    } else if (operation === 'coreInfo') {
      response = { ok: true, installed: state.installed, version: state.installed ? 'mihomo smoke' : '', can_rollback: false };
    } else if (operation === 'coreGetSet') {
      response = { ok: true, repo: 'liuran001/mihomo', tag: '', mirror: '' };
    } else if (operation === 'coreUpdate') {
      state.installed = true;
      persist();
      response = { ok: true, message: 'mock core installed' };
    } else if (operation === 'policyGet') {
      response = { ok: true, ...state.policy, current_ssid: '家庭 Wi-Fi', allowed: true };
    } else if (operation === 'policySet') {
      state.policy = { ...payload };
      persist();
      response = { ok: true };
    } else if (operation === 'configRead') {
      response = state.has_config ? { ok: true, content: state.content } : { ok: false, error: 'mock config does not exist' };
    } else if (operation === 'template') {
      response = { ok: true, content: options.content };
    } else if (operation === 'validate') {
      response = { ok: true };
    } else if (operation === 'apply') {
      state.content = payload.content;
      state.has_config = true;
      persist();
      response = { ok: true, message: 'mock config saved' };
    } else if (operation === 'service') {
      response = { ok: true, paused: options.paused === true, message: options.paused ? 'SSID 策略暂停' : 'mock service started' };
    } else if (operation === 'status') {
      response = { ok: true, running: false, desired: 'stopped', allowed: true, current_ssid: '家庭 Wi-Fi' };
    } else if (operation === 'controller') {
      response = { ok: true, data: { version: 'smoke' } };
    } else {
      mock.unexpected.push(operation);
      response = { ok: false, error: `unmocked operation: ${operation}` };
    }
    call.response = response;
    return JSON.stringify(response);
  } });
}

function mockOptions(options = {}) {
  return { policy, content: generatedConfig, ...options };
}

function backendScript(options) {
  return `(${previewBackend.toString()})(${JSON.stringify(mockOptions(options))});`;
}

async function checkMock() {
  const storage = new Map();
  const sandbox = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const request = async (operation, payload = {}) => JSON.parse(await context.mihomoBridge.request(operation, JSON.stringify(payload)));
  vm.runInContext(backendScript({ failures: { onboardingState: 1, onboardingComplete: 1 } }), context);
  assert.equal((await request('onboardingState')).ok, false);
  assert.deepEqual(await request('onboardingState'), { ok: true, has_config: false, completed: false });
  assert.equal((await request('onboardingComplete')).ok, false);
  assert.equal((await request('onboardingState')).completed, false);
  assert.equal((await request('configRead')).ok, false);
  await request('apply', { content: generatedConfig, restart: false });
  await request('policySet', policy);
  await request('onboardingComplete');
  vm.runInContext(backendScript({}), context);
  assert.deepEqual(await request('onboardingState'), { ok: true, has_config: true, completed: true });
  assert.deepEqual(await request('configRead'), { ok: true, content: generatedConfig });
  assert.deepEqual((await request('policyGet')).bypass_packages, policy.bypass_packages);
  assert.equal((await request('exec', { command: 'id' })).ok, false);
  assert.deepEqual(Array.from(context.__onboardingMock.unexpected), ['exec']);
  console.log('PASS smoke mock self-check (VM only; browser UI not exercised)');
}

async function installRoutes(context, options, external) {
  const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json', '.yaml': 'text/plain',
    '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
  };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== previewURL.origin) {
      external.push(url.href);
      return route.abort();
    }
    if (request.method() !== 'GET') return route.abort();
    if (url.pathname.endsWith('/backend.js')) {
      return route.fulfill({ contentType: mime['.js'], body: backendScript(options) });
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const extension = path.extname(relative);
    if (!mime[extension]) return route.abort();
    if (process.env.WEBUI_URL) return route.continue();
    const filename = path.resolve(artifactRoot, relative);
    const withinRoot = path.relative(artifactRoot, filename);
    if (withinRoot.startsWith('..') || path.isAbsolute(withinRoot)) return route.abort();
    try {
      return await route.fulfill({ contentType: mime[extension], body: await fs.promises.readFile(filename) });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing prebuilt WebUI asset; build outside this smoke test.' });
    }
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
  } else {
    await context.addInitScript(() => {
      window.WebSocket = class { constructor() { throw new Error('WebSocket disabled by onboarding smoke'); } };
    });
  }
}

function button(page, name) {
  return page.getByRole('button', { name, exact: true });
}

async function tap(page, name) {
  const target = button(page, name);
  await reveal(page, target);
  await page.waitForTimeout(250);
  assert.equal(await target.isEnabled(), true, `${name} must be enabled`);
  await target.click({ force: true });
}

async function reveal(page, target) {
  const viewport = page.viewportSize();
  let reset = false;
  for (let attempt = 0; attempt < 32; attempt++) {
    let distance = 180;
    if (await target.isVisible()) {
      const bounds = await target.boundingBox();
      if (bounds && bounds.y >= 8 && bounds.y + bounds.height <= viewport.height - 8) return;
      if (bounds && bounds.y < 8) distance = -180;
    }
    if (!reset) {
      distance = -5000;
      reset = true;
    }
    const pointer = { x: viewport.width / 2, y: viewport.height * 0.65 };
    if (process.env.ONBOARDING_TRACE_REVEAL === '1') {
      const hit = await page.evaluate(point => {
        const chain = [];
        let element = document.elementFromPoint(point.x, point.y);
        while (element) {
          chain.push(element.tagName);
          const nested = element.shadowRoot?.elementFromPoint(point.x, point.y);
          if (!nested || nested === element) break;
          element = nested;
        }
        return chain;
      }, pointer);
      console.log(JSON.stringify({ reveal: String(target), attempt, distance, pointer, hit, bounds: await target.boundingBox() }));
    }
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, distance);
    await page.waitForTimeout(250);
  }
  throw new Error(`Unable to reveal ${target} within the viewport after scrolling`);
}

async function calls(page) {
  return page.evaluate(() => window.__onboardingMock.calls);
}

async function assertNoWrites(page, allowed = []) {
  const actual = (await calls(page)).filter(call => writes.includes(call.operation) && !allowed.includes(call.operation));
  assert.deepEqual(actual, [], 'routing and validation must not mutate config, policy, core or service');
}

async function overview(page) {
  await button(page, '设置').waitFor({ state: 'visible' });
  assert.equal(await button(page, '稍后设置').count(), 0, 'QuickSetup must not remain open');
  await page.waitForFunction(() => window.__onboardingMock.calls.some(call => call.operation === 'status'));
}

async function wizard(page) {
  await button(page, '稍后设置').waitFor({ state: 'visible' });
  await button(page, '下一步').waitFor({ state: 'visible' });
  assert.equal(await button(page, '设置').count(), 0, 'fresh installations must enter QuickSetup, not overview');
}

async function captureStep(page, filename) {
  await page.mouse.move(200, 650);
  await page.mouse.wheel(0, -5000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(reviewRoot, filename), animations: 'disabled' });
}

async function toPolicy(page, capture = false) {
  await wizard(page);
  if (capture) await captureStep(page, 'onboarding-1-core.png');
  await tap(page, '下一步');
  const address = page.getByRole('textbox').first();
  await address.waitFor({ state: 'visible' });
  await address.click({ force: true });
  await page.keyboard.insertText('https://subscription.invalid/onboarding-smoke');
  await page.keyboard.press('Tab');
  if (capture) await captureStep(page, 'onboarding-2-subscription.png');
  await tap(page, '下一步');
  await button(page, '仅保存').waitFor({ state: 'visible' });
  if (capture) await captureStep(page, 'onboarding-3-policy.png');
}

async function finish(page, start = false) {
  await toPolicy(page, !start);
  await tap(page, start ? '保存并启动' : '仅保存');
  await button(page, '返回概览').waitFor({ state: 'visible' });
  const records = await calls(page);
  const stages = records.filter(call => ['template', 'validate', 'apply', 'policySet', 'service', 'onboardingComplete'].includes(call.operation));
  assert.deepEqual(stages.map(call => call.operation), ['template', 'validate', 'apply', 'policySet', ...(start ? ['service'] : []), 'onboardingComplete']);
  assert.deepEqual(records.find(call => call.operation === 'apply').payload, { content: generatedConfig, restart: false });
  assert.deepEqual(records.find(call => call.operation === 'validate').payload, { content: generatedConfig });
  assert.deepEqual(records.find(call => call.operation === 'policySet').payload, policy, 'preserve existing SSID, bypass packages and interfaces');
  assert.equal(records.find(call => call.operation === 'template').payload.subscriptions[0].url, 'https://subscription.invalid/onboarding-smoke');
  if (start) assert.deepEqual(records.find(call => call.operation === 'service').payload, { action: 'start' });
  await tap(page, '返回概览');
  await overview(page);
}

const scenarios = [
  { name: 'fresh-skip', run: async page => {
    await wizard(page);
    await assertNoWrites(page);
    await tap(page, '稍后设置');
    await overview(page);
    await assertNoWrites(page, ['onboardingComplete']);
    assert.equal((await calls(page)).filter(call => call.operation === 'onboardingComplete').length, 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await overview(page);
    await assertNoWrites(page);
  } },
  ...[[true, false], [false, true], [true, true]].map(([has_config, completed]) => ({
    name: `overview-config-${has_config}-completed-${completed}`, options: { has_config, completed },
    run: async page => { await overview(page); await assertNoWrites(page); },
  })),
  ...[false, true].map(has_config => ({
    name: `state-retry-config-${has_config}`, options: { has_config, failures: { onboardingState: 1 } },
    run: async page => {
      await button(page, '重试检查').waitFor({ state: 'visible' });
      await button(page, '直接进入').waitFor({ state: 'visible' });
      assert.equal(await button(page, '稍后设置').count(), 0);
      await assertNoWrites(page);
      await tap(page, '重试检查');
      if (has_config) await overview(page); else await wizard(page);
      assert.ok((await calls(page)).filter(call => call.operation === 'onboardingState').length >= 2);
      await assertNoWrites(page);
    },
  })),
  { name: 'state-error-direct-entry', options: { failures: { onboardingState: 10 } }, run: async page => {
    await button(page, '重试检查').waitFor({ state: 'visible' });
    await tap(page, '直接进入');
    await overview(page);
    await assertNoWrites(page);
    assert.equal((await calls(page)).filter(call => call.operation === 'onboardingState').length, 1);
  } },
  ...[{ ok: true }, { ok: true, has_config: 'false', completed: false }, { ok: true, has_config: false, completed: null }].map((stateOverride, index) => ({
    name: `malformed-state-${index}`, options: { stateOverride }, run: async page => {
      await button(page, '重试检查').waitFor({ state: 'visible' });
      await button(page, '直接进入').waitFor({ state: 'visible' });
      assert.equal(await button(page, '稍后设置').count(), 0, 'invalid state must not be treated as a fresh install');
      await assertNoWrites(page);
    },
  })),
  { name: 'skip-completion-error', options: { failures: { onboardingComplete: 1 } }, run: async page => {
    await wizard(page);
    await tap(page, '稍后设置');
    await reveal(page, page.getByText('mock onboardingComplete failed', { exact: true }).first());
    await wizard(page);
    assert.equal(await page.evaluate(() => window.__onboardingMock.state.completed), false);
    await assertNoWrites(page, ['onboardingComplete']);
    await tap(page, '稍后设置');
    await overview(page);
    assert.equal((await calls(page)).filter(call => call.operation === 'onboardingComplete').length, 2);
  } },
  { name: 'core-install-explicit', options: { installed: false }, run: async page => {
    await wizard(page);
    await button(page, '下载内核').waitFor();
    await tap(page, '下一步');
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole('textbox').count(), 0, 'missing core must prevent moving to subscription');
    await button(page, '下载内核').waitFor();
    await assertNoWrites(page);
    await tap(page, '下载内核');
    await page.waitForFunction(() => window.__onboardingMock.state.installed);
    await page.waitForFunction(() => window.__onboardingMock.calls.some(call => call.operation === 'coreInfo' && call.response?.installed === true));
    await button(page, '下载内核').waitFor({ state: 'hidden' });
    await page.getByText('内核已安装', { exact: true }).waitFor({ state: 'visible' });
    await tap(page, '下一步');
    await page.getByRole('textbox').first().waitFor();
    await assertNoWrites(page, ['coreUpdate']);
    assert.equal((await calls(page)).filter(call => call.operation === 'coreUpdate').length, 1);
  } },
  { name: 'three-steps-save-only', run: page => finish(page) },
  { name: 'three-steps-save-start', run: page => finish(page, true) },
  ...['template', 'validate', 'apply', 'policySet', 'service', 'onboardingComplete'].map(operation => ({
    name: `save-error-${operation}`, options: { failures: { [operation]: 1 } }, run: async page => {
      await toPolicy(page);
      await tap(page, '保存并启动');
      await reveal(page, page.getByText(`mock ${operation} failed`, { exact: true }).first());
      if (operation === 'template') await page.screenshot({ path: path.join(reviewRoot, 'onboarding-template-progress.png') });
      assert.equal(await button(page, '返回概览').count(), 0);
      const stages = ['template', 'validate', 'apply', 'policySet', 'service', 'onboardingComplete'];
      const before = (await calls(page)).filter(call => stages.includes(call.operation));
      assert.deepEqual(before.map(call => call.operation), stages.slice(0, stages.indexOf(operation) + 1), 'failure must stop later stages');
      assert.equal(await page.evaluate(() => window.__onboardingMock.state.completed), false);
      await tap(page, '确认重试并继续');
      await button(page, '返回概览').waitFor();
      const after = (await calls(page)).filter(call => stages.includes(call.operation));
      for (const stage of stages) assert.equal(after.filter(call => call.operation === stage).length, stage === operation ? 2 : 1, `retry must not repeat successful ${stage}`);
      await tap(page, '返回概览');
      await overview(page);
    },
  })),
];

async function main() {
  if (process.argv.includes('--check')) return checkMock();
  fs.mkdirSync(reviewRoot, { recursive: true });
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(previewURL.hostname), 'WEBUI_URL must be a loopback preview, not a real device');
  assert.ok(['http:', 'https:'].includes(previewURL.protocol));
  if (!process.env.WEBUI_URL) assert.ok(fs.existsSync(path.join(artifactRoot, 'mihomo.js')), 'Prebuilt WebUI missing: set WEBUI_ROOT or WEBUI_URL; this test never runs Gradle.');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-background-networking'] });
  const selected = scenarios.filter(scenario => !process.env.ONBOARDING_SCENARIOS || new RegExp(process.env.ONBOARDING_SCENARIOS).test(scenario.name));
  const results = [];
  try {
    assert.ok(selected.length, 'ONBOARDING_SCENARIOS matched no scenarios');
    for (const scenario of selected) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
      const external = [];
      const errors = [];
      let page;
      try {
        context.setDefaultTimeout(12000);
        await installRoutes(context, scenario.options || {}, external);
        page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(previewURL.href, { waitUntil: 'domcontentloaded' });
        await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
        try {
          await page.waitForFunction(() => window.__onboardingMock?.calls.some(call => call.operation === 'onboardingState'), null, { timeout: 5000 });
        } catch {
          const observed = await page.evaluate(() => window.__onboardingMock?.calls.map(call => call.operation) || []);
          throw new Error(`Loaded WebUI never requested onboardingState; use updated artifacts via WEBUI_ROOT/WEBUI_URL (no build is run). Observed: ${observed.join(', ') || 'none'}`);
        }
        await scenario.run(page);
        const records = await calls(page);
        for (const call of records.filter(call => ['onboardingState', 'onboardingComplete'].includes(call.operation))) assert.deepEqual(call.payload, {});
        assert.deepEqual(await page.evaluate(() => window.__onboardingMock.unexpected), []);
        assert.equal(await page.evaluate(() => typeof window.ksu), 'undefined', 'native bridge is never installed or invoked');
        assert.deepEqual(errors, []);
        assert.deepEqual(external, [], 'all external requests are aborted and reported');
        results.push({ name: scenario.name, result: 'PASS' });
      } catch (error) {
        let evidence;
        if (page && !page.isClosed()) {
          evidence = path.join(reviewRoot, `onboarding-failure-${scenario.name}`);
          await page.screenshot({ path: evidence + '.png' }).catch(() => {});
          const diagnostics = await page.evaluate(() => ({
            calls: window.__onboardingMock?.calls,
            text: document.body.innerText,
          })).catch(() => ({}));
          diagnostics.buttons = await page.getByRole('button').evaluateAll(elements => elements.map(element => ({
            text: element.textContent, html: element.outerHTML,
          }))).catch(() => []);
          await fs.promises.writeFile(evidence + '.json', JSON.stringify(diagnostics, null, 2));
        }
        results.push({ name: scenario.name, result: 'FAIL', error: error.message, errors, external, evidence });
      } finally {
        await context.close();
      }
      console.log(JSON.stringify(results.at(-1)));
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter(result => result.result === 'FAIL').length;
  console.log(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', passed: results.length - failed, failed, backend: 'mocked', network: 'external-aborted', artifacts: process.env.WEBUI_URL || artifactRoot }));
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { previewBackend, backendScript, scenarios };
