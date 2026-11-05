'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../webui/bridge/backend.js'), 'utf8');
const scriptRoot = 'sh /data/adb/modules/mihomo-ebpf/scripts/';
const operations = { onboardingState: 'onboarding.sh get', onboardingComplete: 'onboarding.sh complete' };

function result(value, errno = 0, stderr = '') {
  return { errno, stdout: JSON.stringify(value), stderr };
}

function makeBridge(handler = () => result({ ok: true })) {
  const timers = new Map();
  const events = new Map();
  let timerSequence = 0;
  let now = 0;
  const bridge = {
    calls: [], fetches: [], timers,
    async raw(operation, payload) {
      const pending = bridge.context.mihomoBridge.request(operation, payload);
      assert.equal(typeof pending.then, 'function');
      const response = await pending;
      assert.equal(typeof response, 'string');
      const parsed = JSON.parse(response);
      assert.equal(typeof parsed.ok, 'boolean');
      return parsed;
    },
    request(operation, payload = {}) {
      return bridge.raw(operation, JSON.stringify(payload));
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [timer, entry] of [...timers]) {
        if (entry.deadline <= now) {
          timers.delete(timer);
          entry.callback();
        }
      }
    },
    dispatch(name) {
      for (const callback of events.get(name) || []) callback();
    },
  };
  const sandbox = {
    setTimeout(callback, delay) {
      const timer = ++timerSequence;
      timers.set(timer, { callback, deadline: now + delay });
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    addEventListener(name, callback) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
    fetch(url) {
      bridge.fetches.push(url);
      return Promise.reject(new Error('onboarding must not access the network'));
    },
    ksu: {
      exec(command, executionOptions, callbackName) {
        const callback = bridge.context[callbackName];
        bridge.calls.push({ command, executionOptions, callbackName, callback });
        const response = handler(command);
        if (response !== null) callback(response.errno, response.stdout, response.stderr);
      },
    },
  };
  sandbox.window = sandbox;
  bridge.context = vm.createContext(sandbox);
  vm.runInContext(source, bridge.context, { filename: 'backend.js' });
  assert.equal('document' in bridge.context, false);
  assert.equal('process' in bridge.context, false);
  assert.equal('require' in bridge.context, false);
  return bridge;
}

function assertClean(bridge, commands = []) {
  assert.deepEqual(bridge.calls.map(call => call.command), commands);
  assert.deepEqual(bridge.fetches, []);
  assert.equal(bridge.timers.size, 0);
  assert.deepEqual(Object.keys(bridge.context).filter(name => name.startsWith('__mihomo_bridge_cb_')), []);
  for (const call of bridge.calls) assert.equal(call.executionOptions, '{}');
}

function assertError(response, pattern = /.+/) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(typeof response.error, 'string');
  assert.match(response.error, pattern);
  assert.equal(Object.hasOwn(response, 'has_config'), false, 'failures must not look like a fresh installation');
  assert.equal(Object.hasOwn(response, 'completed'), false, 'failures must not fabricate completion state');
}

test('onboardingState preserves every boolean state and executes only onboarding.sh get', async () => {
  for (const has_config of [false, true]) {
    for (const completed of [false, true]) {
      const expected = { ok: true, has_config, completed };
      const bridge = makeBridge(() => result(expected));
      assert.deepEqual(await bridge.request('onboardingState'), expected);
      assertClean(bridge, [scriptRoot + operations.onboardingState]);
    }
  }
});

test('onboardingComplete forwards the completion result without touching config or service', async () => {
  const expected = { ok: true, completed: true };
  const bridge = makeBridge(() => result(expected));
  assert.deepEqual(await bridge.request('onboardingComplete'), expected);
  assertClean(bridge, [scriptRoot + operations.onboardingComplete]);
});

test('state is read afresh after completion rather than cached or inferred', async () => {
  let completed = false;
  const bridge = makeBridge(command => {
    if (command === scriptRoot + operations.onboardingComplete) {
      completed = true;
      return result({ ok: true });
    }
    return result({ ok: true, has_config: false, completed });
  });
  assert.equal((await bridge.request('onboardingState')).completed, false);
  assert.deepEqual(await bridge.request('onboardingComplete'), { ok: true });
  assert.deepEqual(await bridge.request('onboardingState'), { ok: true, has_config: false, completed: true });
  assertClean(bridge, ['onboardingState', 'onboardingComplete', 'onboardingState'].map(name => scriptRoot + operations[name]));
});

for (const [operation, command] of Object.entries(operations)) {
  test(`${operation}: omitted payload defaults to an empty object`, async () => {
    const bridge = makeBridge();
    assert.deepEqual(await bridge.raw(operation, undefined), { ok: true });
    assertClean(bridge, [scriptRoot + command]);
  });

  test(`${operation}: unknown fields and prototype keys are rejected without side effects`, async () => {
    const bridge = makeBridge();
    for (const key of [
      'command', 'action', 'path', 'content', 'has_config', 'completed', 'restart',
      '__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__',
    ]) {
      const payload = `{${JSON.stringify(key)}:{"onboardingPolluted":true}}`;
      const response = await bridge.raw(operation, payload);
      assertError(response, /不支持的参数/);
      assert.ok(response.error.includes(key));
      assertClean(bridge);
    }
    assert.equal(vm.runInContext('({}).onboardingPolluted', bridge.context), undefined);
    assert.equal(vm.runInContext('Object.prototype.onboardingPolluted', bridge.context), undefined);
  });

  test(`${operation}: malformed JSON and non-object payloads never reach native code`, async () => {
    const bridge = makeBridge();
    for (const payload of ['', '{', '{} trailing', 'null', '[]', '[{}]', 'true', '0', '"{}"', null, 1, {}, []]) {
      assertError(await bridge.raw(operation, payload));
      assertClean(bridge);
    }
  });

  test(`${operation}: shell and JSON failures propagate without fallback side effects`, async context => {
    const failures = [
      ['backend error', result({ ok: false, error: 'onboarding denied' }), /onboarding denied/],
      ['nonzero exit', result({ ok: true }, 9, 'permission denied'), /permission denied/],
      ['nonzero exit with no stderr', result({ ok: true }, 7), /退出码 7/],
      ['backend error takes precedence', result({ ok: false, error: 'marker write failed' }, 1, 'stderr'), /marker write failed/],
      ['invalid exit code', result({ ok: true }, 'invalid'), /命令失败/],
      ['empty output', { errno: 1, stdout: '', stderr: 'cannot read state' }, /cannot read state/],
      ['invalid JSON', { errno: 0, stdout: 'not JSON', stderr: '' }, /不是 JSON/],
      ...[null, [], false, 123, 'text', {}, { ok: 'true' }, { ok: 1 }, { ok: false }]
        .map(value => [`invalid envelope ${JSON.stringify(value)}`, result(value), /.+/]),
    ];
    for (const [name, response, pattern] of failures) {
      await context.test(name, async () => {
        const bridge = makeBridge(() => response);
        assertError(await bridge.request(operation), pattern);
        assertClean(bridge, [scriptRoot + command]);
      });
    }
  });

  test(`${operation}: native unavailable or throwing returns an error and cleans callbacks`, async () => {
    for (const missing of [true, false]) {
      const bridge = makeBridge(() => { throw new Error('native failed'); });
      if (missing) delete bridge.context.ksu;
      assertError(await bridge.request(operation), /不可用/);
      assertClean(bridge, missing ? [] : [scriptRoot + command]);
    }
  });

  test(`${operation}: timeout and pagehide cannot become success through a late callback`, async () => {
    for (const scenario of ['timeout', 'pagehide']) {
      const bridge = makeBridge(() => null);
      const pending = bridge.request(operation);
      const callback = bridge.calls[0].callback;
      if (scenario === 'timeout') {
        bridge.advance(29999);
        assert.equal(bridge.timers.size, 1);
        bridge.advance(1);
      } else bridge.dispatch('pagehide');
      const response = await pending;
      assertError(response, scenario === 'timeout' ? /超时.*可能仍在执行/ : /页面已关闭/);
      assertClean(bridge, [scriptRoot + command]);
      callback(0, JSON.stringify({ ok: true, has_config: false, completed: true }), '');
      assert.deepEqual(await pending, response);
      assertClean(bridge, [scriptRoot + command]);
    }
  });
}

test('prototype names and onboarding command injection are not callable operations', async () => {
  const bridge = makeBridge();
  for (const operation of ['__proto__', 'constructor', 'toString', 'onboardingState;id', 'onboardingComplete get', 'onboarding.sh complete']) {
    assertError(await bridge.request(operation), /不支持的操作/);
    assertClean(bridge);
  }
});

test('concurrent state and completion calls keep independent results and clean up once', async () => {
  const bridge = makeBridge(() => null);
  const state = bridge.request('onboardingState');
  const complete = bridge.request('onboardingComplete');
  assert.notEqual(bridge.calls[0].callbackName, bridge.calls[1].callbackName);
  bridge.calls[1].callback(1, '{"ok":false,"error":"write failed"}', '');
  assertError(await complete, /write failed/);
  bridge.calls[1].callback(0, '{"ok":true}', '');
  assert.equal(bridge.timers.size, 1);
  bridge.calls[0].callback('0', '{"ok":true,"has_config":true,"completed":false}', '');
  assert.deepEqual(await state, { ok: true, has_config: true, completed: false });
  assertClean(bridge, [scriptRoot + operations.onboardingState, scriptRoot + operations.onboardingComplete]);
});
