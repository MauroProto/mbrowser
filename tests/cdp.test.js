import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CDPConnection, CDPTransport } from '../lib/cdp.js';
import { BrowserEngine } from '../lib/engine.js';
import { deferred } from './helpers/credentials.js';
import { startCDPServer, NO_REPLY } from './helpers/cdp-server.js';

async function peer(t, options) { const server = await startCDPServer(options); t.after(() => server.close()); return server; }
function connect(t, server, options = {}) { const connection = new CDPConnection(server.wsUrl, options); t.after(() => connection.dispose()); return connection; }
function transport(t, options) { const result = new CDPTransport(options); t.after(() => result.dispose()); return result; }

class ControlledWebSocket extends EventTarget {
  static sockets = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; ControlledWebSocket.sockets.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('CDP connection multiplexes native WebSocket commands and installs event handlers before replies', async (t) => {
  const server = await peer(t, { onCommand(command, { emit, socket }) {
    emit({ method: 'Page.frameNavigated', params: { frame: { id: 'local-frame' } }, sessionId: command.sessionId }, socket);
    return { echoed: command.params };
  } });
  const connection = connect(t, server);
  const events = [];
  const unsubscribe = connection.on('Page.frameNavigated', (params, sessionId) => events.push({ params, sessionId }));
  connection.on('Page.frameNavigated', () => { throw new Error('Consumer error must not break pending CDP'); });
  assert.deepEqual(await Promise.all([
    connection.send('Runtime.evaluate', { expression: '1+1' }, { sessionId: 'session-A' }),
    connection.send('Runtime.evaluate', { expression: '2+2' }, { sessionId: 'session-B' }),
  ]), [{ echoed: { expression: '1+1' } }, { echoed: { expression: '2+2' } }]);
  assert.equal(server.sockets.size, 1, 'Commands share one persistent native browser WebSocket');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((item) => item.sessionId).sort(), ['session-A', 'session-B']);
  unsubscribe();
  await connection.send('Runtime.evaluate', {});
  assert.equal(events.length, 2);
  assert.equal(connection.pendingCount, 0);
});

test('CDP per-command timeout/abort release pending entries and ignore late results', async (t) => {
  const commandReady = deferred();
  const server = await peer(t, { onCommand(command) { commandReady.resolve(command); return NO_REPLY; } });
  const connection = connect(t, server);
  await connection.connect();
  await assert.rejects(connection.send('Runtime.evaluate', {}, { timeoutMs: 20 }), { code: 'TIMEOUT' });
  const timedOut = await commandReady.promise;
  assert.equal(connection.pendingCount, 0);
  const controller = new AbortController();
  const cancelled = assert.rejects(connection.send('Runtime.evaluate', {}, { signal: controller.signal }), { code: 'ABORTED' });
  // Wait for deterministic protocol receipt, not a timing sleep.
  const nativeSocket = [...server.sockets][0];
  await new Promise((resolve) => nativeSocket.once('message', resolve));
  controller.abort();
  await cancelled;
  assert.equal(connection.pendingCount, 0);
  const next = connection.send('Runtime.evaluate', {});
  const raw = await new Promise((resolve) => nativeSocket.once('message', resolve));
  const current = JSON.parse(raw.toString());
  server.emit({ id: timedOut.id, result: { value: 'stale reply' } });
  server.emit({ id: current.id, result: { value: 'current reply' } });
  assert.deepEqual(await next, { value: 'current reply' });
  assert.equal(connection.pendingCount, 0);
});

test('CDP socket disconnect rejects every pending command and allows explicit subsequent reconnect', async (t) => {
  const received = deferred();
  let hold = true;
  let count = 0;
  const server = await peer(t, { onCommand() { if (!hold) return { recovered: true }; if (++count === 2) received.resolve(); return NO_REPLY; } });
  const connection = connect(t, server);
  const first = assert.rejects(connection.send('Page.enable'), { code: 'DISCONNECTED' });
  const second = assert.rejects(connection.send('Runtime.evaluate'), { code: 'DISCONNECTED' });
  await received.promise;
  for (const socket of server.sockets) socket.terminate();
  await Promise.all([first, second]);
  assert.equal(connection.pendingCount, 0);
  assert.equal(connection.connected, false);
  hold = false;
  assert.deepEqual(await connection.send('Page.enable'), { recovered: true });
});

test('invalid protocol JSON/array frames reject pending work with a safe stable error', async (t) => {
  for (const frame of ['not JSON', '[]', 'null']) {
    const received = deferred();
    const server = await peer(t, { onCommand() { received.resolve(); return NO_REPLY; } });
    const connection = connect(t, server);
    const pending = assert.rejects(connection.send('Runtime.evaluate'), { code: 'PROTOCOL_ERROR' });
    await received.promise;
    [...server.sockets][0].send(frame);
    await pending;
    assert.equal(connection.pendingCount, 0);
  }
});

test('CDP protocol errors are classified without returning raw code, data or secrets', async (t) => {
  const secret = 'fixture-sensitive-evaluated-value';
  const server = await peer(t, { onCommand(command) { throw new Error(`${command.params.failure}: ${secret}`); } });
  const connection = connect(t, server);
  for (const [failure, expected] of [
    ['Cannot find context with specified id', 'CDP_CONTEXT_GONE'],
    ['No session with given id', 'TAB_NOT_FOUND'],
    ['Arbitrary Chrome failure', 'CDP_ERROR'],
  ]) {
    const error = await connection.send('Runtime.evaluate', { failure }).then(() => assert.fail('Expected error'), (error) => error);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
  }
});

test('CDP cancellation before connect does not create a socket or write protocol data', async (t) => {
  ControlledWebSocket.sockets = [];
  const controller = new AbortController(); controller.abort();
  const connection = new CDPConnection('ws://127.0.0.1:1/devtools/browser/unused', { WebSocketImpl: ControlledWebSocket });
  t.after(() => connection.dispose());
  await assert.rejects(connection.send('Page.enable', {}, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(ControlledWebSocket.sockets.length, 0);
  assert.equal(connection.pendingCount, 0);
});

test('CDP shared connection lets one waiter abort without cancelling another', async (t) => {
  ControlledWebSocket.sockets = [];
  const connection = new CDPConnection('ws://127.0.0.1:1/devtools/browser/unused', { WebSocketImpl: ControlledWebSocket });
  t.after(() => connection.dispose());
  const controller = new AbortController();
  const cancelled = assert.rejects(connection.connect({ signal: controller.signal }), { code: 'ABORTED' });
  const other = connection.connect();
  assert.equal(ControlledWebSocket.sockets.length, 1);
  controller.abort(); await cancelled;
  ControlledWebSocket.sockets[0].open();
  await other;
  assert.equal(connection.connected, true);
});

test('CDP connect deadline closes a stuck socket; disposal blocks all future requests', async (t) => {
  ControlledWebSocket.sockets = [];
  const connection = new CDPConnection('ws://127.0.0.1:1/devtools/browser/unused', { WebSocketImpl: ControlledWebSocket, connectTimeoutMs: 20 });
  t.after(() => connection.dispose());
  await assert.rejects(connection.connect(), { code: 'TIMEOUT' });
  assert.equal(ControlledWebSocket.sockets[0].readyState, 3);
  assert.equal(connection.pendingCount, 0);
  connection.dispose(); connection.dispose();
  await assert.rejects(connection.connect(), { code: 'DISCONNECTED' });
  await assert.rejects(connection.send('Page.enable'), { code: 'DISCONNECTED' });
  assert.equal(ControlledWebSocket.sockets.length, 1);
});

test('detaching one flattened session rejects only that session pending work', async (t) => {
  const ready = deferred();
  let count = 0;
  const server = await peer(t, { onCommand() { if (++count === 2) ready.resolve(); return NO_REPLY; } });
  const connection = connect(t, server);
  const rejected = assert.rejects(connection.send('Runtime.evaluate', {}, { sessionId: 'session-A' }), { code: 'TAB_NOT_FOUND' });
  const surviving = connection.send('Runtime.evaluate', {}, { sessionId: 'session-B' });
  await ready.promise;
  connection.rejectSession('session-A');
  await rejected;
  const command = server.commands.find((command) => command.sessionId === 'session-B');
  server.emit({ id: command.id, result: { unaffected: true } });
  assert.deepEqual(await surviving, { unaffected: true });
  assert.equal(connection.pendingCount, 0);
});

test('legacy transport discovers only an explicit loopback endpoint and lists only page targets', async (t) => {
  const server = await peer(t);
  const cdp = transport(t, { port: server.port });
  const status = await cdp.status();
  assert.equal(status.connected, true);
  assert.equal(status.browser, 'Chrome/fixture');
  assert.match(cdp.browserId, /\/devtools\/browser\/fixture$/);
  assert.deepEqual(await cdp.listTabs(), [{ id: 'fixture-target', title: 'Local protocol fixture', url: 'http://127.0.0.1:9876/fixture' }]);
  assert.deepEqual(server.httpRequests.map(({ url }) => url), ['/json/version']);
  await cdp.dispose();
  assert.equal(server.commands.some(({ method }) => method === 'Target.closeTarget'), false, 'Transport disposal must not close existing browser tabs');
});

test('legacy transport reuses one flattened attachment for concurrent page commands', async (t) => {
  const server = await peer(t);
  const cdp = transport(t, { endpoint: server.wsUrl });
  await Promise.all([
    cdp.send('fixture-target', 'Runtime.evaluate', { expression: '1+1' }),
    cdp.send('fixture-target', 'Runtime.evaluate', { expression: '1+1' }),
  ]);
  assert.equal(server.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
  assert.equal(server.commands.filter(({ method }) => method === 'Target.getTargetInfo').length, 2, 'Each command rechecks current target security policy');
  const evaluations = server.commands.filter(({ method }) => method === 'Runtime.evaluate');
  assert.ok(evaluations.every(({ sessionId }) => sessionId === 'test-session-1'));
  await cdp.detach('fixture-target');
  assert.equal(server.commands.at(-1).method, 'Target.detachFromTarget');
});

test('legacy tab creation is background unless explicitly visible, and only regular HTTP(S) is accepted', async (t) => {
  const server = await peer(t);
  const cdp = transport(t, { endpoint: server.wsUrl });
  const tab = await cdp.createTab({ url: 'http://127.0.0.1:9876/fixture' });
  assert.deepEqual(server.commands.find(({ method }) => method === 'Target.createTarget').params, { url: tab.url, background: true });
  const visible = await cdp.createTab({ url: 'https://example.test/', visible: true });
  assert.deepEqual(server.commands.filter(({ method }) => method === 'Target.createTarget').at(-1).params, { url: visible.url, background: false });
  assert.equal(server.commands.at(-1).method, 'Target.activateTarget');
  for (const url of ['file:///C:/private', 'chrome://settings/', 'chrome-extension://fixture/', 'javascript:alert(1)', 'https://user:pass@example.test/']) {
    await assert.rejects(cdp.createTab({ url }), { code: 'ACCESS_DENIED' });
  }
  assert.deepEqual(await cdp.closeTab(tab.id), { closed: tab.id });
  await assert.rejects(cdp.closeTab(tab.id), { code: 'TAB_NOT_FOUND' });
});

test('legacy transport allowlists raw methods and rechecks scheme after a cached page navigates', async (t) => {
  const server = await peer(t);
  const cdp = transport(t, { endpoint: server.wsUrl });
  await cdp.send('fixture-target', 'Page.enable');
  const count = server.commands.length;
  for (const method of ['Browser.close', 'Target.createTarget', 'Target.closeTarget', 'Network.getAllCookies', 'Page.bringToFront']) {
    await assert.rejects(cdp.send('fixture-target', method, {}), { code: 'ACCESS_DENIED' });
  }
  assert.equal(server.commands.length, count);
  server.targets.get('fixture-target').url = 'chrome://settings/';
  await assert.rejects(cdp.send('fixture-target', 'Runtime.evaluate', {}), { code: 'ACCESS_DENIED' });
  assert.equal(server.commands.filter(({ method }) => method === 'Runtime.evaluate').length, 0);
  await assert.rejects(cdp.send('service-worker', 'Runtime.evaluate', {}), { code: 'TAB_NOT_FOUND' });
});

test('target detach event rejects pending page commands and allows a fresh session on next command', async (t) => {
  const ready = deferred();
  let hold = true;
  const server = await peer(t, { onCommand(command) { if (hold && command.method === 'Runtime.evaluate') { ready.resolve(command); return NO_REPLY; } } });
  const cdp = transport(t, { endpoint: server.wsUrl });
  const rejected = assert.rejects(cdp.send('fixture-target', 'Runtime.evaluate', {}), { code: 'TAB_NOT_FOUND' });
  const command = await ready.promise;
  server.emit({ method: 'Target.detachedFromTarget', params: { sessionId: command.sessionId } });
  await rejected;
  hold = false;
  await cdp.send('fixture-target', 'Runtime.evaluate', {});
  assert.equal(server.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 2);
});

test('legacy discovery rejects remote URLs, credentials, queries, invalid ports and non-browser websocket identities', async (t) => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://example.test/devtools/browser/untrusted' }) }; };
  for (const endpoint of ['ws://example.test/devtools/browser/unsafe', 'http://127.0.0.1:1234/?token=private', 'http://user:pass@127.0.0.1:1234/', 'file:///C:/private']) {
    await assert.rejects(transport(t, { endpoint, fetchImpl }).status(), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(fetches, 0);
  for (const port of [0, -1, 65536, 'abc']) await assert.rejects(transport(t, { port, fetchImpl }).status(), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(transport(t, { endpoint: 'http://127.0.0.1:1234/', fetchImpl }).status(), { code: 'INVALID_ARGUMENT' });
  assert.equal(fetches, 1, 'Unsafe discovered endpoint must be rejected before opening WebSocket');
  const pageEndpoint = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/fixture' }) });
  await assert.rejects(transport(t, { endpoint: 'http://127.0.0.1:1234/', fetchImpl: pageEndpoint }).status(), { code: 'PROTOCOL_ERROR' });
});

test('new target creation remains pending through initial blank metadata until an exact-session main-frame HTTP commit', { timeout: 3000 }, async (t) => {
  const treeReady = deferred(); const id = 'delayed-created-target'; const url = 'http://127.0.0.1:9876/committed';
  let sessionId; let settled = false;
  const server = await peer(t, { onCommand(command, { targets }) {
    if (command.method === 'Target.createTarget') {
      targets.set(id, { targetId: id, type: 'page', title: '', url: 'about:blank' }); return { targetId: id };
    }
    if (command.method === 'Page.getFrameTree') {
      sessionId = command.sessionId; treeReady.resolve();
      return { frameTree: { frame: { id: 'created-main', loaderId: 'initial-blank-loader', url: 'about:blank' } } };
    }
  } });
  const cdp = transport(t, { endpoint: server.wsUrl, timeoutMs: 1000 });
  const creation = cdp.createTab({ url }); creation.then(() => { settled = true; }, () => { settled = true; });
  await treeReady.promise; await cdp.status();
  assert.equal(settled, false, 'Target.createTarget acknowledgement is not a committed document');
  for (const event of [
    { sessionId: 'unrelated-session', frame: { id: 'created-main', loaderId: 'new-loader', url } },
    { sessionId, frame: { id: 'child', parentId: 'created-main', loaderId: 'new-loader', url } },
  ]) {
    server.emit({ method: 'Page.frameNavigated', sessionId: event.sessionId, params: { frame: event.frame } });
    await cdp.status(); assert.equal(settled, false);
  }
  assert.equal(server.commands.filter(({ method }) => method === 'Runtime.evaluate' || method.startsWith('Input.')).length, 0, 'Blank-page readiness permits metadata only, not observation/input');
  server.targets.get(id).url = url;
  server.emit({ method: 'Page.frameNavigated', sessionId, params: { frame: { id: 'created-main', loaderId: 'committed-loader', url } } });
  const created = await creation;
  assert.equal(created.id, id); assert.equal(created.url, url);
  assert.equal(server.commands.filter(({ method }) => method === 'Target.createTarget').length, 1);
});

test('aborting initial-document readiness closes only the exact newly-created target without accessing blank content', { timeout: 3000 }, async (t) => {
  const treeReady = deferred(); const id = 'aborted-created-target';
  const server = await peer(t, { onCommand(command, { targets }) {
    if (command.method === 'Target.createTarget') { targets.set(id, { targetId: id, type: 'page', title: '', url: '' }); return { targetId: id }; }
    if (command.method === 'Page.getFrameTree') { treeReady.resolve(); return { frameTree: { frame: { id: 'blank-main', url: '' } } }; }
  } });
  const cdp = transport(t, { endpoint: server.wsUrl, timeoutMs: 1000 }); const controller = new AbortController();
  const rejected = assert.rejects(cdp.createTab({ url: 'http://127.0.0.1:9876/fixture' }, { signal: controller.signal }), { code: 'ABORTED' });
  await treeReady.promise; controller.abort(); await rejected;
  assert.equal(server.targets.has(id), false);
  assert.equal(server.targets.has('fixture-target'), true);
  assert.deepEqual(server.commands.filter(({ method }) => method === 'Target.closeTarget').map(({ params }) => params.targetId), [id]);
  assert.equal(server.commands.filter(({ method }) => method === 'Runtime.evaluate' || method.startsWith('Input.')).length, 0);
});

test('navigation acknowledgement and old frame tree do not complete before the matching new main-frame loader', { timeout: 3000 }, async (t) => {
  const treeReady = deferred(); const url = 'http://127.0.0.1:9876/next'; let sessionId; let settled = false;
  const server = await peer(t, { onCommand(command) {
    if (command.method === 'Page.navigate') { sessionId = command.sessionId; return { frameId: 'navigation-main', loaderId: 'new-navigation-loader' }; }
    if (command.method === 'Page.getFrameTree') {
      treeReady.resolve(); return { frameTree: { frame: { id: 'navigation-main', loaderId: 'old-loader', url: 'http://127.0.0.1:9876/fixture' } } };
    }
  } });
  const cdp = transport(t, { endpoint: server.wsUrl, timeoutMs: 1000 });
  const navigation = cdp.send('fixture-target', 'Page.navigate', { url }); navigation.then(() => { settled = true; }, () => { settled = true; });
  await treeReady.promise; await cdp.status(); assert.equal(settled, false);
  for (const event of [
    { sessionId, frame: { id: 'navigation-main', loaderId: 'old-loader', url } },
    { sessionId: 'unrelated-session', frame: { id: 'navigation-main', loaderId: 'new-navigation-loader', url } },
    { sessionId, frame: { id: 'child', parentId: 'navigation-main', loaderId: 'new-navigation-loader', url } },
  ]) {
    server.emit({ method: 'Page.frameNavigated', sessionId: event.sessionId, params: { frame: event.frame } });
    await cdp.status(); assert.equal(settled, false);
  }
  server.targets.get('fixture-target').url = url;
  server.emit({ method: 'Page.frameNavigated', sessionId, params: { frame: { id: 'navigation-main', loaderId: 'new-navigation-loader', url } } });
  assert.equal((await navigation).loaderId, 'new-navigation-loader');
  assert.equal(server.commands.filter(({ method }) => method === 'Page.navigate').length, 1, 'Navigation must not be replayed while waiting for commit');
});

test('legacy lifecycle methods honor a pre-aborted signal before touching the browser', async (t) => {
  const server = await peer(t);
  const cdp = transport(t, { endpoint: server.wsUrl });
  const controller = new AbortController(); controller.abort();
  const options = { signal: controller.signal };
  for (const operation of [() => cdp.status(options), () => cdp.listTabs(options),
    () => cdp.createTab({ url: 'http://127.0.0.1:9876/fixture' }, options), () => cdp.closeTab('fixture-target', options),
    () => cdp.detach('fixture-target', options), () => cdp.send('fixture-target', 'Page.enable', {}, options)]) {
    await assert.rejects(operation(), { code: 'ABORTED' });
  }
  assert.equal(server.commands.length, 0, 'Cancelled lifecycle operations must not touch the browser');
});

test('one send uses an aggregate deadline through target validation and attachment, not a reset budget per stage', async (t) => {
  const server = await peer(t, { async onCommand({ method }) {
    if (method === 'Target.getTargetInfo' || method === 'Target.attachToTarget') await new Promise((resolve) => setTimeout(resolve, 70));
  } });
  const cdp = transport(t, { endpoint: server.wsUrl });
  await cdp.status();
  await assert.rejects(cdp.send('fixture-target', 'Runtime.evaluate', { expression: '2' }, { timeoutMs: 110 }), { code: 'TIMEOUT' });
  assert.equal(server.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
  assert.equal(server.commands.filter(({ method }) => method === 'Runtime.evaluate').length, 0, 'No page command after the caller deadline');
});

test('independent callers share setup attachment but cancellation of its first waiter does not abort the other action', { timeout: 3000 }, async (t) => {
  const attached = deferred(); const secondTargetInfo = deferred(); let infos = 0;
  const server = await peer(t, { onCommand(command, { socket }) {
    if (command.method === 'Target.getTargetInfo' && ++infos === 2) secondTargetInfo.resolve();
    if (command.method === 'Target.attachToTarget') { attached.resolve({ command, socket }); return NO_REPLY; }
    if (command.method === 'Runtime.evaluate') return { result: { type: 'string', value: command.params.expression } };
  } });
  const cdp = transport(t, { endpoint: server.wsUrl, timeoutMs: 1500 });
  const controller = new AbortController();
  const cancelled = assert.rejects(cdp.send('fixture-target', 'Runtime.evaluate', { expression: 'cancelled-A' }, { signal: controller.signal }), { code: 'ABORTED' });
  const { command, socket } = await attached.promise;
  const independent = cdp.send('fixture-target', 'Runtime.evaluate', { expression: 'independent-B' });
  await secondTargetInfo.promise; controller.abort(); await cancelled;
  server.sessions.set('shared-fixture-session', 'fixture-target');
  server.emit({ id: command.id, result: { sessionId: 'shared-fixture-session' } }, socket);
  assert.equal((await independent).result.value, 'independent-B');
  assert.equal(server.commands.filter(({ method }) => method === 'Target.attachToTarget').length, 1);
  assert.deepEqual(server.commands.filter(({ method }) => method === 'Runtime.evaluate').map(({ params }) => params.expression), ['independent-B']);
});

test('explicit root browser websocket works without HTTP discovery and rotates volatile identity on reconnect, invalidating old ownership', { timeout: 3000 }, async (t) => {
  const pending = deferred();
  const server = await peer(t, { browserPath: '/devtools/browser', onCommand(command) {
    if (command.method === 'Runtime.evaluate') { pending.resolve(); return NO_REPLY; }
  } });
  const cdp = transport(t, { endpoint: server.wsUrl });
  const browser = new BrowserEngine({ transport: cdp, overlay: false }); t.after(() => browser.dispose());
  const opened = await browser.execute('open', { url: 'http://127.0.0.1:9876/fixture' });
  const first = await cdp.status();
  assert.equal(first.identity_scope, 'connection'); assert.equal((await browser.execute('status')).our_tabs, 1);
  const disconnected = assert.rejects(cdp.send(opened.tab_id, 'Runtime.evaluate', {}), { code: 'DISCONNECTED' });
  await pending.promise;
  for (const socket of server.sockets) socket.terminate();
  await disconnected;
  const reconnected = await cdp.status();
  assert.equal(reconnected.identity_scope, 'connection'); assert.notEqual(first.browserId, reconnected.browserId);
  assert.equal((await browser.execute('status')).our_tabs, 0);
  await assert.rejects(browser.execute('close', { tab_id: opened.tab_id }), { code: 'NOT_OWNED' });
  assert.equal(server.targets.has(opened.tab_id), true, 'Reconnect must not close any tab from the old ownership lifetime');
  assert.equal(server.httpRequests.length, 0, 'An explicitly supplied root websocket needs no /json/version probe');
});

test('reconnection inside close/send cannot dispatch against a reused ID in a different root connection lifetime', { timeout: 3000 }, async (t) => {
  for (const action of ['close', 'send']) {
    const pending = deferred();
    const server = await peer(t, { browserPath: '/devtools/browser', onCommand(command) {
      if (command.method === 'Runtime.evaluate') { pending.resolve(); return NO_REPLY; }
    } });
    const cdp = transport(t, { endpoint: server.wsUrl });
    const created = await cdp.createTab({ url: 'http://127.0.0.1:9876/fixture' });
    const oldIdentity = cdp.browserId;
    const disconnected = assert.rejects(cdp.send(created.id, 'Runtime.evaluate', { expression: 'old-lifetime-observation' }), { code: 'DISCONNECTED' });
    await pending.promise;
    const count = server.commands.length;
    const ensure = cdp._ensureConnection.bind(cdp); let injectDisconnect = true;
    // Deterministic schedule: disconnect after the public operation starts but before its connection acquisition resolves.
    cdp._ensureConnection = async (options) => {
      if (injectDisconnect) {
        injectDisconnect = false;
        for (const socket of server.sockets) socket.terminate();
        await disconnected;
        server.targets.set(created.id, { targetId: created.id, type: 'page', title: 'Reused unrelated user tab', url: 'http://127.0.0.1:9876/unrelated' });
      }
      return ensure(options);
    };
    await assert.rejects(action === 'close' ? cdp.closeTab(created.id) : cdp.send(created.id, 'Runtime.evaluate', { expression: 'must-not-observe-reused-user-tab' }), { code: 'DISCONNECTED' });
    assert.notEqual(cdp.browserId, oldIdentity);
    assert.equal(server.targets.has(created.id), true, 'A reused tab ID must never be closed');
    const afterReconnect = server.commands.slice(count);
    assert.equal(afterReconnect.filter(({ method }) => ['Target.closeTarget', 'Target.getTargetInfo', 'Target.attachToTarget', 'Runtime.evaluate'].includes(method)).length, 0);
  }
});

test('404 on explicit local HTTP endpoint or port supports only the same-host root browser websocket', async (t) => {
  const server = await peer(t, { browserPath: '/devtools/browser', versionStatus: 404 });
  for (const options of [{ endpoint: server.origin }, { port: server.port }]) {
    const cdp = transport(t, options); const status = await cdp.status();
    assert.equal(status.connected, true); assert.equal(status.identity_scope, 'connection');
  }
  assert.equal(server.httpRequests.filter(({ url }) => url === '/json/version').length, 2);
  assert.equal(server.sockets.size, 2);
});

test('403 and invalid discovered debugger paths do not trigger the root-websocket compatibility path', async (t) => {
  const denied = await peer(t, { browserPath: '/devtools/browser', versionStatus: 403 });
  await assert.rejects(transport(t, { endpoint: denied.origin }).status(), { code: 'CDP_UNAVAILABLE' });
  assert.equal(denied.sockets.size, 0);
  const invalid = await peer(t, { browserPath: '/devtools/browser', versionResponse: { webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/page/private' } });
  await assert.rejects(transport(t, { endpoint: invalid.origin }).status(), { code: 'PROTOCOL_ERROR' });
  assert.equal(invalid.sockets.size, 0);
});
