'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(__dirname, '../../dist/ui-review');

function previewBackend() {
  const policy = { ok: true, autostart: false, tethering: false, tethering_interfaces: 'ap0,wlan1,rndis0,usb0,bt-pan', bypass_packages: 'com.android.settings\ncom.example.music', wifi_mode: 'off', wifi_ssids: '家庭 Wi-Fi', current_ssid: '家庭 Wi-Fi', allowed: true };
  const apps = [
    { packageName: 'com.android.settings', appLabel: '设置', isSystem: true, uid: 1000 },
    { packageName: 'com.example.music', appLabel: '音乐', isSystem: false, uid: 10111 },
    { packageName: 'com.example.chat', appLabel: '聊天', isSystem: false, uid: 10112 },
    { packageName: 'com.example.browser', appLabel: '浏览器', isSystem: false, uid: 10113 },
  ];
  window.__uiCalls = [];
  window.mihomoBridge = { request: async (operation, raw = '{}') => {
    const payload = JSON.parse(raw);
    window.__uiCalls.push({ operation, payload });
    let result = { ok: true };
    if (operation === 'onboardingState') result = { ok: true, has_config: true, completed: false };
    else if (operation === 'policyGet') result = policy;
    else if (operation === 'policySet') Object.assign(policy, payload);
    else if (operation === 'apps') result = { ok: true, apps };
    else if (operation === 'appIcon') result = { ok: true, icon: null };
    else if (operation === 'discoveryInterfaces') result = { ok: true, interfaces: [
      { name: 'ap0', kind: 'wifi', present: true, state: 'up', upstream: false, suggested: true },
      { name: 'wlan0', kind: 'wifi', present: true, state: 'up', upstream: true, suggested: false },
    ] };
    else if (operation === 'status') result = { ok: true, running: true, pid: 2471, rss_kb: 46336, uptime: null, desired: 'manual', allowed: true, current_ssid: policy.current_ssid };
    else if (operation === 'coreInfo') result = { ok: true, installed: true, version: 'mihomo alpha-smart', can_rollback: true };
    else if (operation === 'configRead') result = { ok: true, content: 'external-controller: 127.0.0.1:9090\nsecret: preview' };
    else if (operation === 'coreSettingsGet') result = { ok: true, repo: 'liuran001/mihomo', tag: '', mirror: '' };
    else if (operation === 'controller') result = { ok: true, data: { version: 'alpha-smart' } };
    else result = { ok: false, error: `未模拟 ${operation}` };
    return JSON.stringify(result);
  } };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const external = [];
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).hostname !== '127.0.0.1') {
        external.push(route.request().url());
        await route.abort();
      } else if (route.request().url().endsWith('/backend.js')) {
        await route.fulfill({ contentType: 'application/javascript', body: `(${previewBackend.toString()})();` });
      } else await route.continue();
    });
    const page = await context.newPage();
    async function tap(name) {
      const target = page.getByRole('button', { name, exact: true });
      await target.waitFor();
      await page.waitForTimeout(500);
      await target.click({ force: true });
      await page.waitForTimeout(600);
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.WEBUI_URL || 'http://127.0.0.1:8765', { waitUntil: 'domcontentloaded' });
    await page.locator('#loading').waitFor({ state: 'detached', timeout: 60000 });
    await page.getByRole('button', { name: '设置', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'overview-light.png') });
    await tap('设置');
    await page.getByRole('button', { name: '管理 2 个绕过应用', exact: true }).waitFor();
    const helpBounds = await page.getByRole('button', { name: '设置帮助', exact: true }).boundingBox();
    const wifiBounds = await page.getByRole('button', { name: '仅所列', exact: true }).boundingBox();
    const saveBounds = await page.getByRole('button', { name: '保存设置', exact: true }).boundingBox();
    await page.screenshot({ path: path.join(output, 'settings-light.png') });
    const tethering = page.getByRole('button', { name: '共享代理 热点 · USB · 蓝牙', exact: true });
    const tetheringBounds = await tethering.boundingBox();
    await tethering.click({ force: true });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, 'interfaces-light.png') });
    await page.mouse.click(tetheringBounds.x + tetheringBounds.width / 2, tetheringBounds.y + tetheringBounds.height / 2);
    await page.waitForTimeout(600);
    await tap('管理 2 个绕过应用');
    await page.getByRole('button', { name: '确认 2 项', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'apps-light.png') });
    await tap('取消');
    await page.screenshot({ path: path.join(output, 'after-cancel.png') });
    await page.mouse.click(helpBounds.x + helpBounds.width / 2, helpBounds.y + helpBounds.height / 2);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, 'help-light.png') });
    await tap('知道了');
    await page.mouse.click(wifiBounds.x + wifiBounds.width / 2, wifiBounds.y + wifiBounds.height / 2);
    await page.waitForTimeout(600);
    await page.mouse.move(200, 610);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, 'wifi-light.png') });
    await page.mouse.click(saveBounds.x + saveBounds.width / 2, saveBounds.y + saveBounds.height / 2);
    await page.waitForFunction(() => window.__uiCalls.some(call => call.operation === 'policySet'));
    const saved = await page.evaluate(() => window.__uiCalls.find(call => call.operation === 'policySet').payload);
    assert.equal(saved.wifi_mode, 'only');
    assert.equal(saved.wifi_ssids, '家庭 Wi-Fi');
    assert.equal(saved.bypass_packages, 'com.android.settings\ncom.example.music');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, 'settings-dark.png') });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(output, 'settings-320.png') });
    assert.deepEqual(errors, []);
    assert.deepEqual(external.filter(url => !url.includes('.kaspersky-labs.com/')), [], 'UI should load without external fonts or resources');
    console.log(JSON.stringify({ result: 'PASS', screenshots: output, backend: 'mocked', errors, external }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
