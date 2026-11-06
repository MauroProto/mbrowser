import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtensionTransport } from '../lib/extension-transport.js';

function fakeBridge() {
  return {
    browserId: 'extension:fixture-browser-A',
    permissions: { enabled: true, allowExistingTabs: false, allowedOrigins: ['http://127.0.0.1:9876'] },
    calls: [], response: undefined, failure: null, disposed: false,
    async status() { return { connected: true, paired: true }; },
    async request(method, params, options) {
      this.calls.push({ method, params, options });
      if (this.failure) throw this.failure;
      return this.response;
    },
    async dispose() { this.disposed = true; },
  };
}

test('extension transport exposes live browser identity and permission grant, never credential material', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  assert.equal(transport.kind, 'extension');
  assert.equal(transport.browserId, 'extension:fixture-browser-A');
  bridge.browserId = 'extension:fixture-browser-B';
  assert.equal(transport.browserId, 'extension:fixture-browser-B');
  bridge.permissions = { ...bridge.permissions, enabled: false };
  assert.equal(transport.permissions.enabled, false);
  assert.deepEqual(await transport.status(), { connected: true, paired: true });
  assert.throws(() => new ExtensionTransport(), { code: 'INVALID_BRIDGE' });
});

test('extension transport maps canonical tab operations, background default and abort options', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  bridge.response = [{ id: 'ext:123', title: 'Local fixture', url: 'http://127.0.0.1:9876/fixture', active: false, owned: true, ignored: 'untrusted extra data' }];
  const options = { signal: new AbortController().signal, timeoutMs: 200 };
  const tabs = await transport.listTabs(options);
  assert.deepEqual(tabs, [{ id: 'ext:123', title: 'Local fixture', url: 'http://127.0.0.1:9876/fixture', active: false, owned: true }]);
  assert.deepEqual(bridge.calls.at(-1), { method: 'tabs', params: {}, options });
  bridge.response = tabs[0];
  assert.equal((await transport.createTab({ url: tabs[0].url }, options)).id, 'ext:123');
  assert.deepEqual(bridge.calls.at(-1), { method: 'open', params: { url: tabs[0].url, visible: false }, options });
  await transport.createTab({ url: tabs[0].url, visible: true });
  assert.equal(bridge.calls.at(-1).params.visible, true);
  bridge.response = { closed: 'ext:123' };
  assert.deepEqual(await transport.closeTab('ext:123', options), { closed: 'ext:123' });
  assert.deepEqual(bridge.calls.at(-1), { method: 'close', params: { tab_id: 'ext:123' }, options });
  bridge.response = { detached: true };
  await transport.detach('ext:123', options);
  assert.deepEqual(bridge.calls.at(-1), { method: 'detach', params: { tab_id: 'ext:123' }, options });
});

test('extension transport permits only required page CDP methods and canonical Chrome tab IDs', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  const options = { timeoutMs: 200 };
  const params = { expression: '1+1', returnByValue: true };
  bridge.response = { result: { type: 'number', value: 2 } };
  assert.deepEqual(await transport.send('ext:123', 'Runtime.evaluate', params, options), bridge.response);
  assert.deepEqual(bridge.calls.at(-1), { method: 'send', params: { tab_id: 'ext:123', method: 'Runtime.evaluate', params }, options });
  const count = bridge.calls.length;
  for (const method of ['Browser.close', 'Target.closeTarget', 'Target.createTarget', 'Network.getCookies', 'Runtime.addBinding', 'Page.bringToFront']) {
    await assert.rejects(transport.send('ext:123', method, {}), { code: 'UNSUPPORTED_CDP' });
  }
  for (const id of ['123', 'ext:0', 'ext:01', 'ext:-1', 'ext:123/x', 'ext:Infinity', '', null, 123]) {
    await assert.rejects(transport.send(id, 'Runtime.evaluate', {}), { code: 'INVALID_TAB' });
    await assert.rejects(transport.closeTab(id), { code: 'INVALID_TAB' });
    await assert.rejects(transport.detach(id), { code: 'INVALID_TAB' });
  }
  assert.equal(bridge.calls.length, count, 'Rejected methods/IDs must never reach the bridge');
});

test('extension transport forwards reversible native focus emulation without activating a tab', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  const options = { signal: new AbortController().signal, timeoutMs: 200 };
  bridge.response = {};
  for (const enabled of [true, false]) {
    assert.deepEqual(await transport.send('ext:123', 'Emulation.setFocusEmulationEnabled', { enabled }, options), {});
    assert.deepEqual(bridge.calls.at(-1), { method: 'send', params: { tab_id: 'ext:123', method: 'Emulation.setFocusEmulationEnabled', params: { enabled } }, options });
  }
  assert.equal(bridge.calls.length, 2);
});

test('extension transport bounds and validates extension-supplied tab data', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  for (const response of [null, {}, 'tabs', Array(10001).fill({ id: 'ext:1' })]) {
    bridge.response = response;
    await assert.rejects(transport.listTabs(), { code: 'INVALID_RESPONSE' });
  }
  bridge.response = [null];
  await assert.rejects(transport.listTabs(), { code: 'INVALID_RESPONSE' });
  bridge.response = [{ id: 'not-canonical' }];
  await assert.rejects(transport.listTabs(), { code: 'INVALID_TAB' });
  bridge.response = [{ id: 'ext:7', title: 't'.repeat(1100), url: 'u'.repeat(9000), active: 'true', owned: 1 }];
  const [tab] = await transport.listTabs();
  assert.equal(tab.title.length, 1000);
  assert.equal(tab.url.length, 8192);
  assert.equal(tab.active, false);
  assert.equal(tab.owned, false);
});

test('extension disconnect errors propagate without direct-CDP fallback; dispose does not revoke shared device', async () => {
  const bridge = fakeBridge();
  const transport = new ExtensionTransport({ bridge });
  const error = Object.assign(new Error('The extension is disconnected'), { code: 'EXTENSION_DISCONNECTED' });
  bridge.failure = error;
  await assert.rejects(transport.listTabs(), (actual) => actual === error);
  assert.equal(bridge.calls.length, 1, 'No retry or alternate transport may be silently invoked');
  await transport.dispose();
  await transport.dispose();
  assert.equal(bridge.disposed, false, 'A session transport must not dispose the profile-owned bridge');
  for (const action of [() => transport.listTabs(), () => transport.createTab({ url: 'http://127.0.0.1:9876' }), () => transport.send('ext:1', 'Page.enable'), () => transport.closeTab('ext:1'), () => transport.detach('ext:1')]) {
    await assert.rejects(action(), { code: 'DISPOSED' });
  }
  assert.equal(bridge.calls.length, 1);
});
