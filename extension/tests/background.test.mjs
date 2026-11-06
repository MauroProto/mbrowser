import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { PROTOCOL, newNonce, proofMessage } from '../auth.js';
import { BackgroundController } from '../background.js';

const LOCAL = 'mbrowser.device.v2';
const SESSION = 'mbrowser.session.v2';
const TOKEN = 'a'.repeat(64);
const CODE = 'ABCD-1234-ABCD-5678-0123-4567-89AB-CDEF';
const RAW_CODE = CODE.replaceAll('-', '');
const ORIGIN = 'https://allowed.example';
const ID = 'fjgcljkoolmpniiomfmdjkplelohggna';
const clone = value => structuredClone(value);
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function sign(key, purpose, port, ...fields) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(proofMessage(purpose, port, ID, ...fields)).digest('hex');
}

function replyTo(url, options, key = TOKEN) {
  const port = Number(new URL(url).port);
  const request = JSON.parse(options.body);
  if (url.endsWith('/pair')) {
    const nonce = 'f'.repeat(64);
    assert.equal(request.proof, sign(RAW_CODE, 'pair/request', port, request.nonce));
    return new Response(JSON.stringify({ protocol: PROTOCOL, nonce, proof: sign(RAW_CODE, 'pair/response', port, request.nonce, nonce) }));
  }
  const revokeKey = sign(key, 'revoke/key', port);
  assert.equal(request.proof, sign(revokeKey, 'revoke/request', port, request.nonce));
  return new Response(JSON.stringify({ ok: true, proof: sign(revokeKey, 'revoke/response', port, request.nonce) }));
}

function pairedKey(url, options) {
  return sign(RAW_CODE, 'pair/device', Number(new URL(url).port), JSON.parse(options.body).nonce, 'f'.repeat(64));
}

class Event {
  listeners = new Set();
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  async emit(...args) { await Promise.all([...this.listeners].map(listener => listener(...args))); }
}

function persisted({ enabled = true, existing = false, origins = [ORIGIN] } = {}) {
  return {
    schema: 1, port: 43127, token: TOKEN, consentVersion: 1,
    approvedAt: '2026-11-05T19:00:00.000Z',
    grant: { enabled, allowExistingTabs: existing, allowedOrigins: origins },
    pendingRevocation: null,
  };
}

function harness({
  device = persisted(), now = Date.now,
  session = device?.grant.enabled ? {
    schema: 1, instanceId: '99999999-0000-0000-0000-111111111111', activeUntil: now() + 120_000,
  } : null,
  fetchImpl, fetchHook, createHook, attachHook, cdpHook, storageHook,
} = {}) {
  const local = device ? { [LOCAL]: clone(device) } : {};
  const sessionData = session ? { [SESSION]: clone(session) } : {};
  const instances = [];
  const calls = { fetch: [], create: [], remove: [], attach: [], detach: [], cdp: [], broadcasts: [], access: [] };
  const alarms = new Map();
  const tabs = new Map([
    [1, { id: 1, title: 'USER PRIVATE TITLE', url: `${ORIGIN}/account`, active: true, incognito: false }],
    [2, { id: 2, title: 'FORBIDDEN PRIVATE TITLE', url: 'https://forbidden.example/private', active: false, incognito: false }],
    [3, { id: 3, title: 'Chrome settings', url: 'chrome://settings/', active: false, incognito: false }],
  ]);
  const attached = new Set();
  let nextTab = 100;
  let nextContext = 50;
  const storage = (data, name) => ({
    async setAccessLevel(value) { calls.access.push([name, value.accessLevel]); },
    async get(key) { return { [key]: clone(data[key]) }; },
    async set(value) {
      if (storageHook) await storageHook(name, value);
      Object.assign(data, clone(value));
    },
  });
  const chrome = {
    runtime: {
      id: ID,
      getURL: path => 'chrome-extension://' + ID + '/' + path,
      async sendMessage(message) { calls.broadcasts.push(clone(message)); },
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    storage: { local: storage(local, 'local'), session: storage(sessionData, 'session') },
    alarms: {
      async create(name, options) { alarms.set(name, clone(options)); },
      async clear(name) { return alarms.delete(name); },
    },
    tabs: {
      onUpdated: new Event(), onRemoved: new Event(), onReplaced: new Event(), onActivated: new Event(),
      async query() { return [...tabs.values()].map(clone); },
      async get(id) {
        if (!tabs.has(id)) throw new Error('No tab with given id');
        return clone(tabs.get(id));
      },
      async update(id, options) {
        Object.assign(tabs.get(id), options);
        return clone(tabs.get(id));
      },
      async create(options) {
        calls.create.push(clone(options));
        const tab = createHook ? await createHook(options) : {
          id: nextTab++, title: 'Automation page', url: options.url, active: options.active, incognito: false,
        };
        tabs.set(tab.id, clone(tab));
        return clone(tab);
      },
      async remove(id) {
        calls.remove.push(id);
        if (!tabs.has(id)) throw new Error('No tab');
        tabs.delete(id);
        if (attached.delete(id)) await chrome.debugger.onDetach.emit({ tabId: id }, 'target_closed');
        await chrome.tabs.onRemoved.emit(id, { isWindowClosing: false });
      },
    },
    debugger: {
      onDetach: new Event(),
      async attach(target, protocol) {
        calls.attach.push({ ...target, protocol });
        if (attachHook) await attachHook(target);
        attached.add(target.tabId);
      },
      async detach(target) {
        calls.detach.push(clone(target));
        attached.delete(target.tabId);
        // Native API completion never waits for an asynchronous extension event listener (especially during startup).
        void chrome.debugger.onDetach.emit(target, 'canceled_by_user');
      },
      async sendCommand(target, method, params) {
        calls.cdp.push({ target: clone(target), method, params: clone(params) });
        if (!attached.has(target.tabId)) throw new Error('Debugger is not attached');
        if (cdpHook) {
          const result = cdpHook(target, method, params);
          if (result !== undefined) return await result;
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `main-${target.tabId}`, loaderId: 'loader-1', url: tabs.get(target.tabId)?.url } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: nextContext++ };
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'safe result' } };
        if (method === 'Page.captureScreenshot') return { data: 'test-only-png-base64' };
        if (method === 'Page.navigate') {
          const tab = tabs.get(target.tabId);
          tab.url = params.url;
          await chrome.tabs.onUpdated.emit(target.tabId, { url: params.url, status: 'loading' }, clone(tab));
          return { frameId: `main-${target.tabId}` };
        }
        return {};
      },
    },
  };
  class Socket {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    observers = new Set();
    constructor(url) { this.url = url; instances.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(text) {
      const message = JSON.parse(text);
      this.sent.push(message);
      for (const observer of this.observers) observer(message);
    }
    close(code = 1000, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
    server(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    text(text) { this.onmessage?.({ data: text }); }
  }
  const fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    const reply = () => replyTo(url, options, local[LOCAL]?.pendingRevocation?.token);
    if (fetchHook) return await fetchHook(url, options, reply);
    return reply();
  };
  const controller = new BackgroundController({ chrome, fetch: fetchImpl ?? fetch, WebSocket: Socket, now });
  chrome.tabs.onUpdated.addListener((...args) => controller.handleTabUpdated(...args));
  chrome.tabs.onActivated.addListener(({ tabId }) => controller.handleTabActivated(tabId));
  chrome.tabs.onRemoved.addListener((...args) => controller.handleTabRemoved(...args));
  chrome.debugger.onDetach.addListener((...args) => controller.handleDebuggerDetach(...args));
  const sender = { id: ID, url: `chrome-extension://${ID}/options.html`, origin: `chrome-extension://${ID}` };
  let requestId = 0;
  async function ui(action, extras = {}) {
    return await controller.handleUi({ action, ...extras }, sender);
  }
  async function pair({ code = CODE, port = 43127, beforeConsume } = {}) {
    await controller.ready;
    const origin = 'http://127.0.0.1:' + port;
    const url = origin + '/mbrowser/connect';
    const tab = { id: 4, url, incognito: false };
    tabs.set(tab.id, tab);
    try { await controller.handleHandoff({ code: code.replaceAll('-', '') }, { id: ID, tab, frameId: 0, origin, url }); }
    catch (error) { return { ok: false, error: { code: error.code } }; }
    assert.equal(tabs.get(tab.id).url, sender.url);
    await beforeConsume?.();
    return controller.handleUi({ action: 'consumeLink' }, { ...sender, tab });
  }
  async function decideSite(allow, id = controller.status().siteRequest?.id) {
    return controller.handleUi({ action: 'decideSite', id, allow }, { ...sender, url: chrome.runtime.getURL('panel.html') });
  }
  async function connected() {
    await controller.ready;
    if (!controller.status().paired) assert.equal((await pair()).ok, true);
    if (!instances.length) {
      assert.equal((await ui('resume', { revision: controller.status().revision, accepted: true })).ok, true);
    }
    const socket = instances.at(-1);
    socket.open();
    const { nonce: clientNonce } = socket.sent.at(-1);
    const hostNonce = newNonce();
    const port = Number(new URL(socket.url).port);
    const hello = new Promise(resolve => {
      const observer = message => {
        if (message.type !== 'hello') return;
        socket.observers.delete(observer);
        resolve(message);
      };
      socket.observers.add(observer);
    });
    const key = local[LOCAL].token;
    socket.server({ type: 'proof', protocol: PROTOCOL, nonce: hostNonce, proof: sign(key, 'socket/host', port, clientNonce, hostNonce) });
    const verified = await hello;
    assert.equal(verified.proof, sign(key, 'socket/extension', port, clientNonce, hostNonce, verified.instanceId, verified.permissions));
    socket.server({ type: 'welcome', protocol: PROTOCOL });
    await settle();
    assert.equal(controller.status().connection, 'connected');
    return socket;
  }
  function command(socket, method, params = {}, id = `r${++requestId}`) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.observers.delete(observer); reject(new Error(`No result for ${method} (${id})`)); }, 1500);
      const observer = message => {
        if (message.type === 'result' && message.id === id) {
          clearTimeout(timeout);
          socket.observers.delete(observer);
          resolve(message);
        }
      };
      socket.observers.add(observer);
      socket.server({ type: 'command', id, method, params });
    });
  }
  const cdp = (socket, tab, method, params = {}) => command(socket, 'send', { tab_id: `ext:${tab}`, method, params });
  async function own(socket) {
    const reply = await command(socket, 'open', { url: `${ORIGIN}/page` });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return Number(reply.result.id.slice(4));
  }
  async function world(socket, id) {
    assert.equal((await cdp(socket, id, 'Page.getFrameTree')).ok, true);
    const result = await cdp(socket, id, 'Page.createIsolatedWorld', { frameId: `main-${id}`, worldName: 'mbrowser', grantUniveralAccess: false });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result.executionContextId;
  }
  return { controller, chrome, local, sessionData, calls, alarms, tabs, attached, instances, sender, ui, pair, decideSite, connected, command, cdp, own, world };
}

const evaluation = contextId => ({ expression: 'document.title', contextId, awaitPromise: true, returnByValue: true, userGesture: false, timeout: 1000 });

test('no network before receiving a link; trusted sender only; safe empty grant', async () => {
  const h = harness({ device: null });
  await h.controller.ready;
  assert.equal(h.instances.length, 0);
  assert.equal(h.calls.fetch.length, 0);
  assert.deepEqual(h.calls.access, [['local', 'TRUSTED_CONTEXTS'], ['session', 'TRUSTED_CONTEXTS']]);
  assert.equal((await h.pair({ code: 'invalid' })).error.code, 'INVALID_PAIR_CODE');
  assert.equal(h.calls.fetch.length, 0);
  for (const sender of [
    { id: ID, url: 'https://allowed.example/', origin: 'https://allowed.example' },
    { id: 'other-extension', url: `chrome-extension://${ID}/options.html` },
    { id: ID, url: `chrome-extension://${ID}/popup.html#spoof` },
    { id: ID, url: `chrome-extension://${ID}/options.html`, origin: 'https://evil.test' },
  ]) {
    const response = await h.controller.handleUi({ action: 'getStatus' }, sender);
    assert.equal(response.error.code, 'UNTRUSTED_SENDER');
    assert.equal(response.status, undefined);
  }
  assert.equal((await h.pair({ beforeConsume: async () => {
    assert.equal((await h.ui('consumeLink')).status.paired, false);
    assert.equal(h.calls.fetch.length, 0, 'another tab cannot consume the handoff');
  } })).ok, true);
  assert.equal(h.controller.status().enabled, false);
  assert.equal(h.instances.length, 0);
  const response = await h.ui('getStatus');
  const key = h.local[LOCAL].token;
  assert.equal(JSON.stringify(response).includes(key), false);
  assert.equal(JSON.stringify(h.calls.broadcasts).includes(key), false);
  assert.equal(JSON.stringify(response).includes(CODE), false);
  assert.equal(h.local[LOCAL].grant.allowExistingTabs, false);
  assert.deepEqual(h.local[LOCAL].grant.allowedOrigins, []);
  const { url, options } = h.calls.fetch[0];
  assert.equal(url, 'http://127.0.0.1:43127/pair');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(h.local[LOCAL].token, pairedKey(url, options));
  assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['nonce', 'proof']);
  assert.ok(!options.body.includes(RAW_CODE));
  assert.equal((await h.ui('consumeLink', { code: CODE, bridgeUrl: 'http://evil.test' })).error.code, 'INVALID_ARGUMENT');
});

test('native fetch callbacks receive no controller receiver during pairing or revocation', async () => {
  const requests = [];
  let key;
  const h = harness({ device: null, fetchImpl: async function (url, options) {
    // Arrow functions and Node's fetch hide the native WebIDL receiver requirement.
    if (this !== undefined) throw new TypeError('Illegal invocation');
    requests.push({ url, options });
    if (url.endsWith('/pair')) key = pairedKey(url, options);
    return replyTo(url, options, key);
  } });
  await h.controller.ready;
  assert.equal(requests.length, 0, 'no network before explicit consent');
  const paired = await h.pair();
  assert.equal(paired.ok, true, JSON.stringify(paired.error));
  assert.equal(paired.status.paired, true);
  assert.equal(h.local[LOCAL].token, key);
  const revoked = await h.ui('revoke', { confirmed: true });
  assert.equal(revoked.ok, true, JSON.stringify(revoked.error));
  assert.equal(revoked.status.paired, false);
  assert.equal(revoked.status.revocationPending, false);
  assert.equal(h.local[LOCAL].token, null);
  assert.deepEqual(requests.map(request => request.url), ['http://127.0.0.1:43127/pair', 'http://127.0.0.1:43127/revoke']);
  for (const { options } of requests) {
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(requests).includes(RAW_CODE));
  assert.ok(!JSON.stringify(requests).includes(key));
});

test('native hello sends the grant only after the Host proves identity', async () => {
  const h = harness({ device: persisted() });
  const socket = await h.connected();
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(socket.url, 'ws://127.0.0.1:43127/extension');
  const [challenge, hello] = socket.sent;
  assert.deepEqual(Object.keys(challenge).sort(), ['nonce', 'protocol', 'type']);
  assert.equal(challenge.type, 'challenge');
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, PROTOCOL);
  assert.ok(!JSON.stringify(socket.sent).includes(TOKEN));
  assert.deepEqual(hello.permissions, { enabled: true, allowExistingTabs: false, allowedOrigins: [ORIGIN] });
  assert.equal(hello.instanceId, h.sessionData[SESSION].instanceId);
  assert.equal(socket.url.includes(TOKEN), false);
  socket.server({ type: 'ping' });
  assert.equal(socket.sent.at(-1).type, 'pong');
});

test('an unverified local listener cannot receive a saved grant or send a command', async () => {
  for (const response of [
    { type: 'welcome', protocol: PROTOCOL },
    { type: 'proof', protocol: PROTOCOL, nonce: newNonce(), proof: '0'.repeat(64) },
  ]) {
    const h = harness({ device: persisted() });
    await h.controller.ready;
    const socket = h.instances[0];
    socket.open();
    socket.server(response);
    socket.server({ type: 'command', id: 'spoof', method: 'open', params: { url: ORIGIN } });
    for (let retry = 0; h.controller.status().notice !== 'AUTH_REJECTED' && retry < 50; retry++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(h.controller.status().notice, 'AUTH_REJECTED');
    assert.deepEqual(socket.sent.map(frame => frame.type), ['challenge']);
    assert.equal(h.calls.create.length, 0);
  }
});

test('an unsigned pairing reply or revocation acknowledgement is rejected', async () => {
  const fake = async () => new Response(JSON.stringify({ ok: true, protocol: PROTOCOL, nonce: newNonce(), proof: '0'.repeat(64) }));
  const unpaired = harness({ device: null, fetchHook: fake });
  assert.equal((await unpaired.pair()).error.code, 'PAIRING_PROTOCOL');
  assert.equal(unpaired.instances.length, 0);
  const paired = harness({ device: persisted(), fetchHook: fake });
  await paired.connected();
  const revoked = await paired.ui('revoke', { confirmed: true });
  assert.equal(revoked.status.enabled, false);
  assert.equal(revoked.status.revocationPending, true);
  assert.ok(!JSON.stringify(paired.calls.fetch).includes(TOKEN));
});

test('default owns-only hides all user tabs; open is inactive and close never touches a user-created tab', async () => {
  const h = harness();
  const socket = await h.connected();
  assert.deepEqual((await h.command(socket, 'tabs')).result, []);
  const denied = h.command(socket, 'open', { url: 'https://forbidden.example/' });
  assert.equal(h.controller.status().siteRequest.origin, 'https://forbidden.example');
  assert.equal((await h.decideSite(false)).ok, true);
  assert.equal((await denied).error.code, 'SITE_APPROVAL_DENIED');
  assert.equal(h.calls.create.length, 0);
  const id = await h.own(socket);
  assert.equal(h.calls.create[0].active, false);
  assert.equal(h.tabs.get(1).active, true);
  assert.deepEqual((await h.command(socket, 'tabs')).result.map(tab => tab.id), [`ext:${id}`]);
  assert.equal((await h.command(socket, 'close', { tab_id: 'ext:1' })).error.code, 'TAB_NOT_OWNED');
  assert.equal(h.calls.remove.includes(1), false);
  assert.equal((await h.command(socket, 'close', { tab_id: `ext:${id}` })).ok, true);
  assert.equal(h.controller.status().ownedTabCount, 0);
});

test('upgrade keeps exact sites while removing pre-existing tabs and wildcard grants', async () => {
  const h = harness({ device: persisted({ existing: true }) });
  const socket = await h.connected();
  assert.deepEqual((await h.command(socket, 'tabs')).result, []);
  h.tabs.get(1).active = false;
  const list = await h.command(socket, 'tabs');
  assert.deepEqual(list.result, []);
  assert.equal((await h.cdp(socket, 1, 'Page.enable')).error.code, 'EXISTING_TAB_DENIED');
  assert.equal((await h.command(socket, 'close', { tab_id: 'ext:1' })).error.code, 'TAB_NOT_OWNED');
  assert.equal(h.calls.remove.length, 0);
  assert.deepEqual(h.local[LOCAL].grant, { enabled: true, allowExistingTabs: false, allowedOrigins: [ORIGIN] });
  const broad = harness({ device: persisted({ existing: true, origins: ['*'] }) });
  await broad.controller.ready;
  assert.deepEqual(broad.local[LOCAL].grant, { enabled: true, allowExistingTabs: false, allowedOrigins: [] });
});

test('focus emulation uses the same ownership/origin grant without activating any tab', async () => {
  const method = 'Emulation.setFocusEmulationEnabled';
  const h = harness();
  const socket = await h.connected();
  assert.equal((await h.cdp(socket, 1, method, { enabled: true })).error.code, 'EXISTING_TAB_DENIED');
  assert.equal(h.calls.attach.length, 0);
  const id = await h.own(socket);
  for (const enabled of [true, false]) assert.equal((await h.cdp(socket, id, method, { enabled })).ok, true);
  assert.deepEqual(h.calls.cdp.filter(call => call.method === method), [
    { target: { tabId: id }, method, params: { enabled: true } },
    { target: { tabId: id }, method, params: { enabled: false } },
  ]);
  assert.equal(h.tabs.get(1).active, true);
  assert.equal(h.tabs.get(id).active, false);
  const dispatched = h.calls.cdp.length;
  assert.equal((await h.cdp(socket, id, method, { enabled: true, activate: true })).error.code, 'INVALID_ARGUMENT');
  h.tabs.get(id).pendingUrl = 'https://forbidden.example/redirect';
  assert.equal((await h.cdp(socket, id, method, { enabled: true })).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal((await h.cdp(socket, id, method, { enabled: false })).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(h.calls.cdp.length, dispatched, 'no focus emulation can bypass current or pending origin authorization');
  for (const denied of ['Page.bringToFront', 'Target.activateTarget']) {
    assert.equal((await h.cdp(socket, id, denied, {})).error.code, 'CDP_METHOD_DENIED');
  }
});

test('cached native debugger attach and main-frame-only isolated evaluation', async () => {
  const h = harness();
  const socket = await h.connected();
  const id = await h.own(socket);
  assert.equal((await h.cdp(socket, id, 'Page.enable')).ok, true);
  assert.equal((await h.cdp(socket, id, 'Page.enable')).ok, true);
  assert.equal(h.calls.attach.length, 1);
  assert.equal((await h.cdp(socket, id, 'Runtime.evaluate', evaluation(9999))).error.code, 'ACCESS_DENIED');
  assert.equal((await h.cdp(socket, id, 'Page.createIsolatedWorld', { frameId: 'foreign-child', worldName: 'x', grantUniveralAccess: false })).error.code, 'FRAME_NOT_ALLOWED');
  const context = await h.world(socket, id);
  const createdWorld = h.calls.cdp.find(call => call.method === 'Page.createIsolatedWorld');
  assert.equal(createdWorld.params.worldName, `mbrowser:${h.sessionData[SESSION].instanceId}:${createHash('sha256').update('mbrowser').digest('hex')}`);
  assert.equal(createdWorld.params.grantUniveralAccess, false);
  assert.ok(h.sessionData[SESSION].issuedContexts[id].includes(context));
  assert.equal((await h.cdp(socket, id, 'Runtime.evaluate', evaluation(context))).result.result.value, 'safe result');
  assert.equal((await h.command(socket, 'detach', { tab_id: `ext:${id}` })).ok, true);
  assert.equal(h.controller.status().enabled, true, 'programmatic detach must not pause the extension');
  assert.equal((await h.cdp(socket, id, 'Runtime.evaluate', evaluation(context))).error.code, 'CDP_CONTEXT_GONE');
  assert.equal(h.calls.attach.length, 2);
});

test('native isolated-world namespace preserves distinct scope and navigation worlds', async () => {
  const h = harness();
  const socket = await h.connected();
  const id = await h.own(socket);
  await h.cdp(socket, id, 'Page.getFrameTree');
  const names = ['scope-one-nav-0', 'scope-two-nav-0', 'scope-one-nav-1', 'scope-one-nav-0'];
  for (const worldName of names) {
    assert.equal((await h.cdp(socket, id, 'Page.createIsolatedWorld', { frameId: `main-${id}`, worldName, grantUniveralAccess: false })).ok, true);
  }
  const nativeNames = h.calls.cdp.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params.worldName);
  assert.equal(new Set(nativeNames).size, 3);
  assert.equal(nativeNames[0], nativeNames[3]);
  assert.notEqual(nativeNames[0], nativeNames[1]);
  assert.notEqual(nativeNames[0], nativeNames[2]);
});

test('typed secrets and JavaScript exception details are never returned as diagnostics', async () => {
  const secret = 'TYPED_SECRET_NEVER_ECHO_THIS';
  const h = harness({ cdpHook(_target, method) {
    if (method === 'Input.insertText') throw new Error(`Could not insert ${secret}`);
    if (method === 'Runtime.evaluate') return { exceptionDetails: { text: secret, exception: { description: secret } } };
  } });
  const socket = await h.connected();
  const id = await h.own(socket);
  const context = await h.world(socket, id);
  const typed = await h.cdp(socket, id, 'Input.insertText', { text: secret });
  assert.equal(typed.error.code, 'CHROME_OPERATION_FAILED');
  assert.equal(JSON.stringify(typed).includes(secret), false);
  const evaluated = await h.cdp(socket, id, 'Runtime.evaluate', evaluation(context));
  assert.equal(evaluated.error.code, 'JS_EVALUATION_FAILED');
  assert.equal(JSON.stringify(evaluated).includes(secret), false);
});

test('navigation invalidates contexts; pending forbidden URL blocks input before dispatch', async () => {
  const h = harness();
  const socket = await h.connected();
  const id = await h.own(socket);
  const context = await h.world(socket, id);
  assert.equal((await h.cdp(socket, id, 'Page.navigate', { url: `${ORIGIN}/next` })).ok, true);
  assert.equal((await h.cdp(socket, id, 'Runtime.evaluate', evaluation(context))).error.code, 'CDP_CONTEXT_GONE');
  h.tabs.get(id).pendingUrl = 'https://forbidden.example/redirect';
  const before = h.calls.cdp.length;
  assert.equal((await h.cdp(socket, id, 'Input.insertText', { text: 'secret' })).error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(h.calls.cdp.length, before);
  await h.chrome.tabs.onUpdated.emit(id, { status: 'loading' }, clone(h.tabs.get(id)));
  assert.equal(h.attached.has(id), false);
  assert.deepEqual((await h.command(socket, 'tabs')).result, []);
  assert.equal((await h.command(socket, 'close', { tab_id: `ext:${id}` })).ok, true, 'closing exact owned tab is a lifecycle-only exception');
});

test('pause cancels pending work, releases debugger, persists and never reconnects itself', async () => {
  const pending = deferred();
  const h = harness({ cdpHook(_target, method) { if (method === 'Runtime.evaluate') return pending.promise; } });
  const socket = await h.connected();
  const id = await h.own(socket);
  const context = await h.world(socket, id);
  socket.server({ type: 'command', id: 'slow', method: 'send', params: { tab_id: `ext:${id}`, method: 'Runtime.evaluate', params: evaluation(context) } });
  await settle();
  const revision = h.controller.status().revision;
  assert.equal((await h.ui('pause')).ok, true);
  assert.equal(h.controller.status().enabled, false);
  assert.equal(h.local[LOCAL].grant.enabled, false);
  assert.equal(h.attached.size, 0);
  assert.equal(h.alarms.has('mbrowser.reconnect'), false);
  const permissionUpdate = socket.sent.find(frame => frame.type === 'permissions' && frame.permissions.enabled === false);
  assert.ok(permissionUpdate);
  const count = h.instances.length;
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  assert.equal(h.instances.length, count);
  assert.equal((await h.ui('resume', { revision, accepted: true })).error.code, 'STALE_SETTINGS');
  pending.resolve({ result: { value: 'late' } });
  await settle();
  assert.equal(socket.sent.some(frame => frame.id === 'slow' && frame.ok === true), false);
  assert.equal(h.calls.remove.length, 0, 'pause must not close even owned tabs');
});

test('cancel aborts a pending CDP operation and never replays input or late results', async () => {
  const pending = deferred();
  const h = harness({ cdpHook(_target, method) { if (method === 'Runtime.evaluate') return pending.promise; } });
  const socket = await h.connected();
  const id = await h.own(socket);
  const context = await h.world(socket, id);
  const result = h.command(socket, 'send', { tab_id: `ext:${id}`, method: 'Runtime.evaluate', params: evaluation(context) }, 'cancel-me');
  await settle();
  socket.server({ type: 'cancel', id: 'cancel-me' });
  assert.equal((await result).error.code, 'ABORTED');
  await settle();
  assert.equal(h.attached.size, 0);
  assert.ok(h.calls.cdp.every(call => !['Runtime.terminateExecution', 'Page.stopLoading'].includes(call.method)));
  pending.resolve({ result: { value: 'late secret' } });
  await settle();
  assert.equal(socket.sent.filter(frame => frame.type === 'result' && frame.id === 'cancel-me').length, 1);
  assert.equal(h.controller.status().enabled, true);
});

test('late native create after cancellation is recorded and cleaned without adopting any user tab', async () => {
  const creation = deferred();
  const h = harness({ createHook: () => creation.promise });
  const socket = await h.connected();
  const result = h.command(socket, 'open', { url: `${ORIGIN}/slow` }, 'opening');
  await settle();
  socket.server({ type: 'cancel', id: 'opening' });
  assert.equal((await result).error.code, 'ABORTED');
  creation.resolve({ id: 100, title: 'late', url: `${ORIGIN}/slow`, active: false, incognito: false });
  await settle();
  assert.equal(h.tabs.has(100), false);
  assert.equal(h.controller.status().ownedTabCount, 0);
  assert.deepEqual(h.calls.remove, [100]);
  assert.ok(h.tabs.has(1));
  assert.equal(h.sessionData[SESSION].ownedTabs.length, 0);
});

test('open waits on URL events, not fixed sleeps or page-load completion', async () => {
  const h = harness({ createHook: async () => ({ id: 100, title: '', url: 'about:blank', pendingUrl: `${ORIGIN}/loading`, active: false, incognito: false }) });
  const socket = await h.connected();
  let completed = false;
  const result = h.command(socket, 'open', { url: `${ORIGIN}/loading` }).then(value => { completed = true; return value; });
  await settle();
  assert.equal(completed, false);
  h.tabs.get(100).url = `${ORIGIN}/loading`;
  await h.chrome.tabs.onUpdated.emit(100, { url: `${ORIGIN}/loading`, status: 'loading' }, clone(h.tabs.get(100)));
  const reply = await result;
  assert.equal(reply.ok, true);
  assert.equal(reply.result.url, `${ORIGIN}/loading`);
});

test('unexpected user debugger detach pauses globally without a reattach loop', async () => {
  const h = harness();
  const socket = await h.connected();
  const id = await h.own(socket);
  await h.cdp(socket, id, 'Page.enable');
  h.attached.delete(id);
  await h.chrome.debugger.onDetach.emit({ tabId: id }, 'canceled_by_user');
  assert.equal(h.controller.status().notice, 'DETACHED_BY_USER');
  assert.equal(h.controller.status().enabled, false);
  assert.equal(h.local[LOCAL].grant.enabled, false);
  const count = h.instances.length;
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  assert.equal(h.instances.length, count);
  assert.equal(h.calls.attach.length, 1);
});

test('an exact site approval continues the original background open and does not release existing tabs', async () => {
  const h = harness();
  const socket = await h.connected();
  const id = await h.own(socket);
  await h.cdp(socket, id, 'Page.enable');
  const opening = h.command(socket, 'open', { url: 'https://second.example/path?private=123' });
  const pending = h.controller.status().siteRequest;
  assert.equal(pending.origin, 'https://second.example');
  assert.equal(JSON.stringify(pending).includes('private'), false);
  assert.equal(h.calls.create.length, 1);
  assert.equal((await h.ui('decideSite', { id: pending.id, allow: true })).error.code, 'UNTRUSTED_SENDER');
  assert.equal((await h.decideSite(true, 'stale')).error.code, 'STALE_SETTINGS');
  assert.equal((await h.command(socket, 'open', { url: 'https://third.example/' })).error.code, 'SITE_APPROVAL_PENDING');
  assert.equal((await h.decideSite(true)).ok, true);
  assert.equal((await opening).ok, true);
  assert.deepEqual(h.local[LOCAL].grant, { enabled: true, allowExistingTabs: false, allowedOrigins: [ORIGIN, pending.origin] });
  assert.ok(socket.sent.some(frame => frame.type === 'permissions' && frame.permissions.allowedOrigins.includes(pending.origin)));
  assert.equal(h.controller.status().siteRequest, null);
  assert.equal(h.attached.has(id), true);
  assert.equal(h.instances.length, 1);
});

test('pausing during an approval write clears the pending site and prevents a late grant or tab', async () => {
  const storage = deferred();
  const started = deferred();
  const h = harness({ storageHook(name, value) {
    if (name === 'local' && value[LOCAL]?.grant.allowedOrigins.includes('https://second.example')) {
      started.resolve();
      return storage.promise;
    }
  } });
  const socket = await h.connected();
  const opening = h.command(socket, 'open', { url: 'https://second.example/' });
  const approval = h.decideSite(true);
  await started.promise;
  const pausing = h.ui('pause');
  await settle();
  assert.equal(h.controller.status().siteRequest, null);
  storage.resolve();
  assert.equal((await approval).error.code, 'STALE_SETTINGS');
  await pausing;
  await assert.rejects(opening, /No result for open/);
  assert.deepEqual(h.local[LOCAL].grant, { enabled: false, allowExistingTabs: false, allowedOrigins: [ORIGIN] });
  assert.equal(h.calls.create.length, 0);
});

test('1008 authentication rejection and replaced sessions stop reconnecting', async () => {
  for (const [code, reason, notice, paired] of [
    [1008, 'do not reflect server text SECRET', 'AUTH_REJECTED', false],
    [1000, 'replaced', 'CONNECTION_REPLACED', true],
  ]) {
    const h = harness({ device: persisted() });
    const socket = await h.connected();
    socket.close(code, reason);
    await settle();
    assert.equal(h.controller.status().notice, notice);
    assert.equal(h.controller.status().paired, paired);
    assert.equal(h.controller.status().enabled, false);
    assert.equal(JSON.stringify(h.controller.status()).includes('SECRET'), false);
    const count = h.instances.length;
    await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
    assert.equal(h.instances.length, count);
  }
});

test('malformed/oversized commands pause and duplicate IDs do not replay side effects', async () => {
  const h = harness();
  const socket = await h.connected();
  assert.equal((await h.command(socket, 'open', { url: `${ORIGIN}/one` }, 'once')).ok, true);
  assert.equal((await h.command(socket, 'open', { url: `${ORIGIN}/one` }, 'once')).error.code, 'DUPLICATE_COMMAND');
  assert.equal(h.calls.create.length, 1);
  socket.text(' '.repeat(1024 * 1024 + 1));
  await settle();
  assert.equal(h.controller.status().notice, 'PROTOCOL_ERROR');
  assert.equal(h.controller.status().enabled, false);
});

test('screenshots stay in the local panel and selecting a tab yields control without interrupting Chrome', async () => {
  const h = harness();
  const socket = await h.connected();
  assert.equal((await h.command(socket, 'open', { url: ORIGIN, visible: true })).error.code, 'BACKGROUND_ONLY');
  const id = await h.own(socket);
  assert.equal((await h.cdp(socket, id, 'Page.enable')).ok, true);
  assert.equal((await h.cdp(socket, id, 'Page.captureScreenshot', {})).error.code, 'CDP_METHOD_DENIED');
  assert.equal((await h.ui('getPreview', { tabId: id })).error.code, 'UNTRUSTED_SENDER');
  const panel = { ...h.sender, url: `chrome-extension://${ID}/panel.html` };
  const panelRequest = (action, extras = {}) => h.controller.handleUi({ action, ...extras }, panel);
  const activity = await panelRequest('getActivity');
  assert.deepEqual(activity.tabs, [{ id, title: 'Automation page', origin: ORIGIN, state: 'attached', preview: true }]);
  assert.equal((await h.command(socket, 'cursor', { tab_id: `ext:${id}`, x: 0.4, y: 0.6 })).ok, true);
  assert.deepEqual((await panelRequest('getPreview', { tabId: id })).frame, {
    image: 'test-only-png-base64', cursor: { x: 0.4, y: 0.6 },
  });
  assert.equal((await panelRequest('getPreview', { tabId: 1 })).ok, false);
  h.tabs.get(id).active = true;
  await h.chrome.tabs.onActivated.emit({ tabId: id });
  assert.deepEqual(h.calls.detach.map(tab => tab.tabId), [id]);
  assert.equal((await panelRequest('getActivity')).tabs[0].state, 'manual');
  assert.equal((await panelRequest('getPreview', { tabId: id })).ok, false);
  assert.equal((await h.cdp(socket, id, 'Page.enable')).error.code, 'TAB_IN_USE');
  assert.equal((await h.command(socket, 'close', { tab_id: `ext:${id}` })).error.code, 'TAB_IN_USE');
  assert.equal(h.calls.remove.length, 0);
  assert.ok(h.calls.cdp.every(call => !['Runtime.terminateExecution', 'Page.stopLoading'].includes(call.method)));
});

test('offline revoke blocks locally, retains only a trusted retry tombstone, never starts a WebSocket', async () => {
  let online = false;
  const h = harness({ device: persisted(), fetchHook: async (_url, _options, reply) => {
    if (!online) throw new Error(`OFFLINE ${TOKEN}`);
    return reply();
  } });
  const socket = await h.connected();
  const id = await h.own(socket);
  await h.cdp(socket, id, 'Page.enable');
  const result = await h.ui('revoke', { confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.status.enabled, false);
  assert.equal(result.status.paired, false);
  assert.equal(result.status.revocationPending, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(h.local[LOCAL].token, null);
  assert.equal(h.local[LOCAL].pendingRevocation.token, TOKEN);
  assert.equal(h.alarms.has('mbrowser.revoke'), true);
  assert.equal(h.attached.size, 0);
  assert.equal(h.calls.remove.length, 0);
  const count = h.instances.length;
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  assert.equal(h.instances.length, count);
  online = true;
  await h.controller.handleAlarm({ name: 'mbrowser.revoke' });
  assert.equal(h.controller.status().revocationPending, false);
  assert.equal(h.local[LOCAL].pendingRevocation, null);
  assert.equal(h.alarms.has('mbrowser.revoke'), false);
  assert.equal(h.calls.fetch.every(call => call.url === 'http://127.0.0.1:43127/revoke' && call.options.method === 'POST'), true);
  assert.ok(!JSON.stringify(h.calls.fetch).includes(TOKEN));
  assert.equal(h.instances.length, count);
});

test('a user pause during pairing wins immediately, and any late returned credential is only revoked', async () => {
  const response = deferred();
  const pairRequest = deferred();
  const revokeRequest = deferred();
  const h = harness({ device: null, fetchHook: (url, _options, reply) => {
    if (!url.endsWith('/pair')) {
      revokeRequest.resolve();
      return reply();
    }
    pairRequest.resolve();
    return response.promise.then(reply);
  } });
  await h.controller.ready;
  const pairing = h.pair();
  await pairRequest.promise;
  assert.equal(h.controller.status().connection, 'pairing');
  const pause = await h.ui('pause');
  assert.equal(pause.status.enabled, false);
  response.resolve();
  assert.equal((await pairing).error.code, 'CONSENT_CHANGED');
  await revokeRequest.promise;
  assert.equal(h.instances.length, 0);
  assert.equal(h.controller.status().enabled, false);
  assert.equal(h.local[LOCAL].token, null);
  assert.equal(h.calls.fetch.some(call => call.url.endsWith('/revoke')), true);
});

test('session ownership survives worker restart but never browser restart, stale debugger state is released', async () => {
  const session = {
    schema: 1, instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ownedTabs: [1, 999], attachedTabs: [1], issuedContexts: { 1: [50] }, activeUntil: Date.now() + 120_000,
  };
  const h = harness({ device: persisted(), session });
  await h.controller.ready;
  assert.deepEqual(h.sessionData[SESSION].ownedTabs, [1]);
  assert.equal(h.sessionData[SESSION].instanceId, session.instanceId);
  assert.ok(h.calls.detach.some(target => target.tabId === 1));
  assert.deepEqual(h.sessionData[SESSION].attachedTabs, []);
  h.tabs.get(1).active = false;
  const resumed = await h.connected();
  assert.equal((await h.cdp(resumed, 1, 'Runtime.evaluate', evaluation(50))).error.code, 'CDP_CONTEXT_GONE');
  assert.equal((await h.cdp(resumed, 1, 'Runtime.evaluate', evaluation(999))).error.code, 'ACCESS_DENIED');
  const restarted = harness({ device: persisted(), session: null });
  await restarted.controller.ready;
  assert.equal(restarted.controller.status().paired, true);
  assert.equal(restarted.controller.status().enabled, false);
  assert.equal(restarted.instances.length, 0);
  const socket = await restarted.connected();
  assert.notEqual(socket.sent.find(message => message.type === 'hello').instanceId, session.instanceId);
  assert.equal(restarted.controller.status().ownedTabCount, 0);
  assert.equal((await restarted.command(socket, 'close', { tab_id: 'ext:1' })).error.code, 'TAB_NOT_OWNED');
});

test('queued alarm/startup cannot connect during a pending resume write, and a concurrent pause wins', async () => {
  const storage = deferred();
  const h = harness({ device: persisted({ enabled: false }), storageHook: (name, value) => {
    if (name === 'local' && value[LOCAL]?.grant.enabled) return storage.promise;
  } });
  await h.controller.ready;
  const resume = h.ui('resume', { revision: h.controller.status().revision, accepted: true });
  await settle();
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  await h.controller.handleStartup();
  assert.equal(h.instances.length, 0);
  const pause = h.ui('pause');
  await settle();
  assert.equal(h.controller.status().enabled, false, 'pause must disable before waiting for the blocked write');
  storage.resolve();
  await Promise.all([resume, pause]);
  assert.equal(h.instances.length, 0);
  assert.equal(h.local[LOCAL].grant.enabled, false);
});

test('pairing saves the credential but stays inactive until the user activates', async () => {
  const storage = deferred();
  const started = deferred();
  const h = harness({ device: null, storageHook: (name, value) => {
    if (name === 'local' && value[LOCAL]?.token) {
      started.resolve();
      return storage.promise;
    }
  } });
  await h.controller.ready;
  const pairing = h.pair();
  await started.promise;
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  await h.controller.handleStartup();
  assert.equal(h.instances.length, 0);
  storage.resolve();
  assert.equal((await pairing).ok, true);
  assert.equal(h.instances.length, 0);
  assert.equal(h.local[LOCAL].grant.enabled, false);
  assert.equal(h.controller.status().paired, true);
  assert.equal(h.alarms.has('mbrowser.idle'), false);
});

test('idle expiry closes the bridge, releases tabs and keeps only the saved site approval', async () => {
  let time = Date.now();
  const h = harness({ now: () => time });
  const socket = await h.connected();
  const first = h.alarms.get('mbrowser.idle').when;
  time += 15_000;
  await h.command(socket, 'tabs');
  await h.ui('getStatus');
  socket.server({ type: 'ping' });
  assert.equal(h.alarms.get('mbrowser.idle').when, first);
  const id = await h.own(socket);
  assert.equal((await h.cdp(socket, id, 'Page.enable')).ok, true);
  assert.equal(h.attached.size, 1);
  const renewed = h.alarms.get('mbrowser.idle').when;
  assert.ok(renewed > first);
  time = renewed + 1;
  await h.controller.handleAlarm({ name: 'mbrowser.idle' });
  assert.equal(h.controller.status().notice, 'IDLE');
  assert.equal(h.controller.status().enabled, false);
  assert.equal(socket.readyState, 3);
  assert.equal(h.attached.size, 0);
  assert.equal(h.alarms.has('mbrowser.idle'), false);
  assert.equal(h.sessionData[SESSION].activeUntil, 0);
  assert.deepEqual(h.local[LOCAL].grant, { enabled: false, allowExistingTabs: false, allowedOrigins: [ORIGIN] });
  await h.controller.handleStartup();
  assert.equal(h.instances.length, 1);
  assert.equal(h.tabs.has(id), true);
});

test('failed startup storage never enables later pairing or an alarm connection', async () => {
  const secret = 'RAW_STORAGE_ERROR_SECRET';
  const h = harness({ device: persisted(), storageHook(name) { if (name === 'local') throw new Error(secret); } });
  await h.controller.ready;
  assert.equal(h.controller.status().notice, 'STORAGE_UNAVAILABLE');
  assert.equal(h.controller.status().enabled, false);
  const response = await h.pair();
  assert.equal(response.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes(secret), false);
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  assert.equal(h.instances.length, 0);
  assert.equal(h.calls.fetch.length, 0);
});

test('failed approval storage closes the authorization gate and sanitizes the error', async () => {
  const h = harness({ device: persisted({ enabled: false }), storageHook(name, value) {
    if (name === 'local' && value[LOCAL]?.grant.enabled) throw new Error('RAW_STORAGE_SECRET');
  } });
  await h.controller.ready;
  const response = await h.ui('resume', { revision: h.controller.status().revision, accepted: true });
  assert.equal(response.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(response.status.enabled, false);
  assert.equal(response.status.notice, 'STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes('RAW_STORAGE_SECRET'), false);
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  await h.controller.handleStartup();
  assert.equal(h.instances.length, 0);
});

test('a pause storage failure still blocks runtime control and explicitly warns persistence was not saved', async () => {
  let broken = false;
  const h = harness({ device: persisted(), storageHook(name) { if (broken && name === 'local') throw new Error('RAW_STORAGE_SECRET'); } });
  const socket = await h.connected();
  const id = await h.own(socket);
  await h.cdp(socket, id, 'Page.enable');
  broken = true;
  const response = await h.ui('pause');
  await settle();
  assert.equal(response.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(response.status.enabled, false);
  assert.equal(response.status.notice, 'STORAGE_UNAVAILABLE');
  assert.match(response.error.message, /desactiva la extensión/);
  assert.equal(h.attached.size, 0);
  const count = h.instances.length;
  await h.controller.handleAlarm({ name: 'mbrowser.reconnect' });
  assert.equal(h.instances.length, count);
});

test('late native debugger attach after cancellation is detached without dispatching the command', async () => {
  const attaching = deferred();
  const h = harness({ attachHook: () => attaching.promise });
  const socket = await h.connected();
  const id = await h.own(socket);
  const result = h.command(socket, 'send', { tab_id: `ext:${id}`, method: 'Page.enable', params: {} }, 'late-attach');
  await settle();
  socket.server({ type: 'cancel', id: 'late-attach' });
  assert.equal((await result).error.code, 'ABORTED');
  attaching.resolve();
  await settle();
  assert.equal(h.attached.size, 0);
  assert.equal(h.calls.attach.length, 1);
  assert.equal(h.calls.cdp.some(call => call.method === 'Page.enable'), false);
});

test('invalid persisted approval fails closed; an intentional pause persists across restart', async () => {
  const invalid = persisted();
  invalid.consentVersion = 0;
  const h = harness({ device: invalid });
  await h.controller.ready;
  assert.equal(h.controller.status().notice, 'STORAGE_INVALID');
  assert.equal(h.instances.length, 0);
  const paused = harness({ device: persisted({ enabled: false }) });
  await paused.controller.ready;
  assert.equal(paused.controller.status().connection, 'paused');
  assert.equal(paused.instances.length, 0);
  await paused.controller.handleStartup();
  assert.equal(paused.instances.length, 0);
});
