import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PROTOCOL, newNonce, proofMessage } from '../extension/auth.js';
import { once } from 'node:events';
import { test } from 'node:test';
import { BrowserBridge, CREDENTIAL_KEY, DEFAULT_PORT, EXTENSION_ID, validatePermissions } from '../lib/bridge.js';
import { deferred, MemoryCredentials } from './helpers/credentials.js';
import { requestHttp } from './helpers/http.js';
import { connectWebSocket } from './helpers/websocket.js';

const TEST_EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GRANT = { enabled: true, allowExistingTabs: false, allowedOrigins: ['http://127.0.0.1:9876'] };
const JSON_HEADERS = { 'content-type': 'application/json' };

async function setup(t, overrides = {}) {
  const credentials = overrides.credentials || new MemoryCredentials();
  let codes = 0;
  const bridge = new BrowserBridge({
    port: 0, extensionId: TEST_EXTENSION_ID, credentials,
    heartbeatMs: 10000, commandTimeoutMs: 2000, authTimeoutMs: 500,
    codeFactory: () => (++codes).toString(16).padStart(32, '0'),
    ...overrides,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  return { bridge, credentials };
}

function post(bridge, path, body, headers = {}) {
  return requestHttp(bridge.origin, {
    path, method: 'POST', body: JSON.stringify(body),
    headers: { ...JSON_HEADERS, origin: bridge.extensionOrigin, ...headers },
  });
}

function sign(bridge, key, purpose, ...fields) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(proofMessage(purpose, bridge.port, bridge.extensionId, ...fields)).digest('hex');
}

function pairingRequest(bridge, code) {
  const nonce = newNonce();
  return { nonce, proof: sign(bridge, code.replaceAll('-', ''), 'pair/request', nonce) };
}

async function pair(bridge) {
  const pairing = bridge.createPairingCode();
  const request = pairingRequest(bridge, pairing.code);
  const response = await post(bridge, '/pair', request);
  assert.equal(response.status, 200);
  assert.equal(response.json.protocol, PROTOCOL);
  assert.match(response.json.nonce, /^[a-f0-9]{64}$/);
  const code = pairing.code.replaceAll('-', '');
  assert.equal(response.json.proof, sign(bridge, code, 'pair/response', request.nonce, response.json.nonce));
  const token = sign(bridge, code, 'pair/device', request.nonce, response.json.nonce);
  assert.ok(!JSON.stringify(response.json).includes(token));
  return { token, pairing };
}

async function handshake(bridge, client, token, { instanceId = 'fixture-browser-A', permissions = GRANT } = {}) {
  const nonce = newNonce();
  client.sendJson({ type: 'challenge', protocol: PROTOCOL, nonce });
  const reply = await client.nextJson();
  assert.equal(reply.type, 'proof');
  assert.equal(reply.proof, sign(bridge, token, 'socket/host', nonce, reply.nonce));
  const proof = sign(bridge, token, 'socket/extension', nonce, reply.nonce, instanceId, permissions);
  return { type: 'hello', protocol: PROTOCOL, instanceId, permissions, proof };
}

async function authenticate(t, bridge, token, options) {
  const client = await connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin });
  t.after(() => client.destroy());
  client.sendJson(await handshake(bridge, client, token, options));
  assert.deepEqual(await client.nextJson(), { type: 'welcome', protocol: PROTOCOL });
  assert.equal(bridge.connected, true);
  return client;
}

async function nextCommand(client) {
  return client.nextJson({ predicate: (message) => message?.type === 'command' });
}

test('bridge validates configuration and exact permission origins', () => {
  const credentials = new MemoryCredentials();
  const defaults = new BrowserBridge({ credentials });
  assert.match(CREDENTIAL_KEY, /^mbrowser\/[a-z0-9-]+$/);
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.extensionId, EXTENSION_ID);
  assert.equal(defaults.heartbeatMs, 20000);
  assert.equal(defaults.maxPayload, 16 * 1024 * 1024);
  assert.equal(defaults.maxCommandBytes, 1024 * 1024);
  assert.equal(defaults.maxHttpBytes, 16 * 1024);
  assert.throws(() => new BrowserBridge({ credentials, port: -1 }), { code: 'INVALID_PORT' });
  assert.throws(() => new BrowserBridge({ credentials, port: 65536 }), { code: 'INVALID_PORT' });
  assert.throws(() => new BrowserBridge({ credentials, extensionId: 'not-an-extension-id' }), { code: 'INVALID_EXTENSION' });
  assert.throws(() => new BrowserBridge(), { code: 'CREDENTIAL_STORE' });
  for (const key of ['heartbeatMs', 'commandTimeoutMs', 'pairingTtlMs', 'authTimeoutMs', 'maxPayload', 'maxCommandBytes', 'maxHttpBytes']) {
    assert.throws(() => new BrowserBridge({ credentials, [key]: 0 }), { code: 'INVALID_LIMIT' });
  }
  for (const allowedOrigins of [[], ['file:///tmp'], ['https://example.test/'], ['https://example.test/path'], ['https://user:password@example.test'], ['null'], [123], Array(101).fill('*')]) {
    assert.throws(() => validatePermissions({ ...GRANT, allowedOrigins }), { code: 'INVALID_PERMISSIONS' });
  }
  assert.throws(() => validatePermissions({ ...GRANT, enabled: 'true' }), { code: 'INVALID_PERMISSIONS' });
  const grant = validatePermissions({ ...GRANT, allowedOrigins: ['https://example.test', 'https://example.test'] });
  assert.deepEqual(grant.allowedOrigins, ['https://example.test']);
  assert.ok(Object.isFrozen(grant) && Object.isFrozen(grant.allowedOrigins));
  assert.deepEqual(validatePermissions({ ...GRANT, allowedOrigins: ['https://example.test', '*'] }).allowedOrigins, ['*']);
});

test('bridge binds IPv4 loopback; health contains no browser or credential data', async (t) => {
  const { bridge, credentials } = await setup(t);
  const health = await requestHttp(bridge.origin, { path: '/health' });
  assert.deepEqual(health.json, { name: 'mbrowser', protocol: PROTOCOL });
  assert.equal(health.status, 200);
  assert.equal(health.headers['access-control-allow-origin'], undefined);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  const { token, pairing } = await pair(bridge);
  const record = credentials.records.get(CREDENTIAL_KEY);
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.deviceKey, token);
  assert.equal(record.payload.revoked, false);
  const safe = JSON.stringify({ status: await bridge.status(), health: (await requestHttp(bridge.origin, { path: '/health' })).json  });
  for (const secret of [token, pairing.code, pairing.code.replaceAll('-', '')]) assert.ok(!safe.includes(secret), 'A secret leaked to health or status');
  assert.deepEqual(credentials.keysRead.every((key) => key === CREDENTIAL_KEY), true);
  assert.equal((await bridge.status()).paired, true);
  assert.equal(bridge.origin, `http://127.0.0.1:${bridge.port}`);
});

test('HTTP rejects unrelated Host and Origin without wildcard CORS or command endpoint', async (t) => {
  const { bridge } = await setup(t);
  for (const host of [`localhost:${bridge.port}`, '127.0.0.1', `127.0.0.1:${bridge.port}.attacker.invalid`, `attacker.invalid:${bridge.port}`]) {
    const response = await requestHttp(bridge.origin, { path: '/health', headers: { host } });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const origin of ['null', bridge.origin, 'https://attacker.invalid', `chrome-extension://${'b'.repeat(32)}`, `${bridge.extensionOrigin}/`]) {
    const response = await post(bridge, '/pair', { code: 'not valid' }, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal((await requestHttp(bridge.origin, { path: '/health', headers: { origin } })).status, 403);
  }
  assert.equal((await requestHttp(bridge.origin, { path: '/pair', method: 'POST', headers: JSON_HEADERS, body: '{}' })).status, 403);
  for (const path of ['/command', '/send', '/tabs', '/extension', '/health?token=forbidden']) {
    const response = await post(bridge, path, {});
    assert.equal(response.status, 404, 'There must be no unauthenticated business-command HTTP endpoint');
  }
  assert.equal((await post(bridge, '/pair?code=forbidden', {})).status, 404);
});

test('CORS preflight admits only exact extension POST and known headers', async (t) => {
  const { bridge } = await setup(t);
  const options = (headers) => requestHttp(bridge.origin, { method: 'OPTIONS', path: '/pair', headers: { origin: bridge.extensionOrigin, ...headers } });
  const good = await options({ 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' });
  assert.equal(good.status, 204);
  assert.equal(good.headers['access-control-allow-origin'], bridge.extensionOrigin);
  assert.equal(good.headers['access-control-allow-methods'], 'POST');
  assert.notEqual(good.headers['access-control-allow-origin'], '*');
  assert.equal((await options({ 'access-control-request-method': 'GET' })).status, 403);
  assert.equal((await options({ 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-arbitrary' })).status, 403);
  assert.equal((await requestHttp(bridge.origin, { path: '/pair', headers: { origin: bridge.extensionOrigin } })).status, 405);
});

test('pairing codes are one-use under parallel replay and regenerating invalidates older codes', async (t) => {
  const { bridge } = await setup(t);
  const old = bridge.createPairingCode();
  const current = bridge.createPairingCode();
  assert.notEqual(current.code, old.code);
  assert.equal((await post(bridge, '/pair', pairingRequest(bridge, old.code))).status, 401);
  const request = pairingRequest(bridge, current.code);
  const replay = await Promise.all([post(bridge, '/pair', request), post(bridge, '/pair', request)]);
  assert.deepEqual(replay.map((response) => response.status).sort(), [200, 401]);
  assert.equal((await post(bridge, '/pair', request)).status, 401);
  assert.equal((await bridge.status()).pairing_available, false);
});

test('pairing expires deterministically and bad-code attempts are rate limited', async (t) => {
  const { bridge } = await setup(t, { pairingTtlMs: 20 });
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const code = bridge.createPairingCode();
  t.mock.timers.tick(21);
  assert.equal((await post(bridge, '/pair', pairingRequest(bridge, code.code))).status, 401);
  assert.equal((await bridge.status()).pairing_available, false);
  for (let index = 0; index < 7; index++) assert.equal((await post(bridge, '/pair', { code: 'wrong' })).status, 401);
  assert.equal((await post(bridge, '/pair', { code: 'wrong' })).status, 429);
  t.mock.timers.tick(60001);
  assert.equal((await post(bridge, '/pair', { code: 'wrong' })).status, 401);
});

test('JSON HTTP validation rejects malformed, scalar and declared oversized bodies without consuming pairing', async (t) => {
  const { bridge } = await setup(t, { maxHttpBytes: 192 });
  const code = bridge.createPairingCode();
  const request = (body, headers = JSON_HEADERS) => requestHttp(bridge.origin, { path: '/pair', method: 'POST', headers: { origin: bridge.extensionOrigin, ...headers }, body });
  assert.equal((await request('{}', { 'content-type': 'text/plain' })).status, 415);
  for (const body of ['{', 'null', '[]', '1', '"value"']) assert.equal((await request(body)).status, 400);
  const oversized = JSON.stringify({ code: 'x'.repeat(200) });
  const denied = await request(oversized, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(oversized) });
  assert.equal(denied.status, 413);
  assert.equal(denied.json.error.code, 'PAYLOAD_LIMIT');
  assert.equal((await post(bridge, '/pair', pairingRequest(bridge, code.code))).status, 200);
});

test('chunked oversized HTTP body returns explicit 413 rather than resetting the socket', async (t) => {
  const { bridge } = await setup(t, { maxHttpBytes: 192 });
  const response = await requestHttp(bridge.origin, {
    path: '/pair', method: 'POST', headers: { ...JSON_HEADERS, origin: bridge.extensionOrigin },
    body: JSON.stringify({ code: 'x'.repeat(256) }),
  });
  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, 'PAYLOAD_LIMIT');
});

test('WebSocket upgrade rejects wrong/missing Origin, Host, route and token query', async (t) => {
  const { bridge } = await setup(t);
  for (const origin of [undefined, 'null', bridge.origin, `chrome-extension://${'b'.repeat(32)}`, `${bridge.extensionOrigin}/`]) {
    await assert.rejects(connectWebSocket(bridge.origin, { origin }), { status: 403 });
  }
  await assert.rejects(connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin, host: `localhost:${bridge.port}` }), { status: 403 });
  for (const path of ['/wrong', '/extension?token=must-not-be-in-query']) {
    await assert.rejects(connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin, path }), { status: 403 });
  }
  assert.equal(bridge.connected, false);
});

test('WebSocket requires authenticated hello, matching protocol, valid grant and auth deadline', async (t) => {
  const { bridge } = await setup(t, { authTimeoutMs: 50 });
  const { token } = await pair(bridge);
  for (const message of [
    { type: 'tabs' }, { type: 'challenge', protocol: 1, nonce: newNonce() },
    { type: 'challenge', protocol: PROTOCOL, nonce: '' }, [],
  ]) {
    const client = await connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin });
    t.after(() => client.destroy());
    client.sendJson(message);
    assert.equal((await client.waitClosed()).code, 1008);
    assert.equal(bridge.connected, false);
  }
  let previousHello;
  for (const mutate of [
    hello => ({ ...hello, proof: 'a'.repeat(64) }),
    hello => ({ ...hello, permissions: { ...GRANT, allowedOrigins: ['*'] } }),
    () => previousHello,
  ]) {
    const client = await connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin });
    t.after(() => client.destroy());
    const hello = await handshake(bridge, client, token);
    client.sendJson(mutate(hello));
    previousHello = hello;
    assert.equal((await client.waitClosed()).code, 1008);
    assert.equal(bridge.connected, false);
  }
  const silent = await connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin });
  t.after(() => silent.destroy());
  assert.equal((await silent.waitClosed()).code, 1006);
  const client = await authenticate(t, bridge, token);
  client.sendJson({ type: 'ping' });
  assert.deepEqual(await client.nextJson(), { type: 'pong' });
});

test('authenticated command/result round trip and extension errors preserve stable codes', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  assert.equal(bridge.browserId, 'extension:fixture-browser-A');
  const resultPromise = bridge.request('tabs', {});
  const command = await nextCommand(client);
  assert.match(command.id, /^[a-f0-9]{32}$/);
  assert.equal(command.method, 'tabs');
  assert.deepEqual(command.params, {});
  assert.ok(!JSON.stringify(command).includes(token));
  const tabs = [{ id: 'ext:123', title: 'Local', url: 'http://127.0.0.1:9876/fixture', owned: true }];
  client.sendJson({ type: 'result', id: command.id, ok: true, result: tabs });
  assert.deepEqual(await resultPromise, tabs);
  const failed = assert.rejects(bridge.request('send', { tab_id: 'ext:123', method: 'Runtime.evaluate', params: {} }), { code: 'TAB_NOT_FOUND' });
  const next = await nextCommand(client);
  client.sendJson({ type: 'result', id: next.id, ok: false, error: { code: 'TAB_NOT_FOUND', message: 'The local tab was removed' } });
  await failed;
  assert.equal((await bridge.status()).pending, 0);
});

test('request timeout and abort send cancel; late results do not satisfy another request', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const timedOut = assert.rejects(bridge.request('tabs', {}, { timeoutMs: 30 }), { code: 'TIMEOUT' });
  const first = await nextCommand(client);
  const cancel = await client.nextJson({ predicate: (message) => message?.type === 'cancel' });
  assert.equal(cancel.id, first.id);
  await timedOut;
  const controller = new AbortController();
  const aborted = assert.rejects(bridge.request('tabs', {}, { signal: controller.signal }), { code: 'ABORTED' });
  const second = await nextCommand(client);
  assert.notEqual(first.id, second.id);
  client.sendJson({ type: 'result', id: first.id, ok: true, result: ['late'] });
  controller.abort();
  assert.equal((await client.nextJson({ predicate: (message) => message?.type === 'cancel' })).id, second.id);
  await aborted;
  const thirdPromise = bridge.request('tabs');
  const third = await nextCommand(client);
  client.sendJson({ type: 'result', id: second.id, ok: true, result: ['also late'] });
  client.sendJson({ type: 'result', id: third.id, ok: true, result: ['correct'] });
  assert.deepEqual(await thirdPromise, ['correct']);
  assert.equal((await bridge.status()).pending, 0);
});

test('request validation, command bytes and pending-work limit are enforced before send', async (t) => {
  const { bridge } = await setup(t, { maxCommandBytes: 256 });
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  await assert.rejects(bridge.request('arbitrary'), { code: 'UNSUPPORTED_COMMAND' });
  await assert.rejects(bridge.request('tabs', []), { code: 'INVALID_ARGUMENT' });
  for (const timeoutMs of [0, -1, 120001, Infinity]) await assert.rejects(bridge.request('tabs', {}, { timeoutMs }), { code: 'INVALID_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bridge.request('tabs', {}, { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(bridge.request('send', { text: 'x'.repeat(300) }), { code: 'PAYLOAD_LIMIT' });
  const circular = {}; circular.self = circular;
  await assert.rejects(bridge.request('send', circular), { code: 'INVALID_ARGUMENT' });
  assert.equal(client.messages.length, 0);
  const results = Array.from({ length: 32 }, () => bridge.request('tabs'));
  const commands = [];
  for (let index = 0; index < 32; index++) commands.push(await nextCommand(client));
  assert.equal((await bridge.status()).pending, 32);
  await assert.rejects(bridge.request('tabs'), { code: 'BUSY' });
  for (const command of commands) client.sendJson({ type: 'result', id: command.id, ok: true, result: [] });
  assert.deepEqual(await Promise.all(results), Array.from({ length: 32 }, () => []));
  assert.equal((await bridge.status()).pending, 0);
});

test('malformed, binary, unmasked and oversized WebSocket frames close safely', async (t) => {
  const { bridge } = await setup(t, { maxPayload: 512 });
  const { token } = await pair(bridge);
  for (const [payload, options, expected] of [
    ['{', {}, 1008], ['binary', { opcode: 2 }, 1008],
    ['{}', { masked: false }, 1002], [JSON.stringify({ padding: 'x'.repeat(1024) }), {}, 1009],
  ]) {
    const client = await authenticate(t, bridge, token);
    client.sendFrame(payload, options);
    assert.equal((await client.waitClosed()).code, expected);
  }
  assert.deepEqual((await requestHttp(bridge.origin, { path: '/health' })).json, { name: 'mbrowser', protocol: PROTOCOL });
});

test('disconnect rejects pending work; reconnect identity replaces previous connection', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const first = await authenticate(t, bridge, token);
  const disconnected = assert.rejects(bridge.request('tabs'), { code: 'DISCONNECTED' });
  await nextCommand(first);
  const dropped = once(bridge, 'disconnection');
  first.destroy();
  await dropped;
  await disconnected;
  await assert.rejects(bridge.request('tabs'), { code: 'EXTENSION_DISCONNECTED' });
  const second = await authenticate(t, bridge, token, { instanceId: 'fixture-browser-A' });
  const replaced = assert.rejects(bridge.request('tabs'), { code: 'CONNECTION_REPLACED' });
  await nextCommand(second);
  await authenticate(t, bridge, token, { instanceId: 'fixture-browser-B' });
  await replaced;
  assert.equal((await second.waitClosed()).code, 1000);
  assert.equal(bridge.browserId, 'extension:fixture-browser-B');
});

test('pause immediately cancels pending work and rejects new commands; resume updates grant', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const paused = assert.rejects(bridge.request('tabs'), { code: 'PAUSED' });
  const command = await nextCommand(client);
  const updated = once(bridge, 'permissions');
  client.sendJson({ type: 'permissions', permissions: { ...GRANT, enabled: false } });
  await updated;
  await paused;
  assert.equal((await client.nextJson({ predicate: (message) => message?.type === 'cancel' })).id, command.id);
  assert.equal((await bridge.status()).paused, true);
  await assert.rejects(bridge.request('tabs'), { code: 'PAUSED' });
  const resumed = once(bridge, 'permissions');
  client.sendJson({ type: 'permissions', permissions: { ...GRANT, allowExistingTabs: true, allowedOrigins: ['https://example.test'] } });
  await resumed;
  assert.deepEqual(bridge.permissions, { enabled: true, allowExistingTabs: true, allowedOrigins: ['https://example.test'] });
  const request = bridge.request('tabs');
  const next = await nextCommand(client);
  client.sendJson({ type: 'result', id: next.id, ok: true, result: [] });
  assert.deepEqual(await request, []);
});

test('pause during async credential validation prevents a command from being sent', async (t) => {
  const { bridge, credentials } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  credentials.beforeRead = async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; }
  };
  const pending = bridge.request('tabs');
  // Attach a handler now: this test intentionally causes rejection before awaiting it below.
  const observed = pending.then((value) => ({ value }), (error) => ({ error }));
  await entered.promise;
  const updated = once(bridge, 'permissions');
  client.sendJson({ type: 'permissions', permissions: { ...GRANT, enabled: false } });
  await updated;
  release.resolve();
  const result = await observed;
  assert.equal(result.error?.code, 'PAUSED', 'A command authorized before an await must recheck the live grant after that await');
  assert.ok(!client.messages.some((message) => message.type === 'command'), 'Paused command reached the extension');
});

test('revoke requires the paired key, drops work and signs confirmation for retries', async (t) => {
  const { bridge, credentials } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  assert.equal((await post(bridge, '/revoke', {})).status, 401);
  assert.equal((await post(bridge, '/revoke', {}, { authorization: `Bearer ${'Z'.repeat(43)}` })).status, 401);
  assert.equal((await post(bridge, '/revoke', {}, { authorization: `Bearer ${token}`, origin: 'https://attacker.invalid' })).status, 403);
  const revoked = assert.rejects(bridge.request('tabs'), { code: 'REVOKED' });
  await nextCommand(client);
  const key = sign(bridge, token, 'revoke/key');
  const nonce = newNonce();
  const request = { nonce, proof: sign(bridge, key, 'revoke/request', nonce) };
  const response = await post(bridge, '/revoke', request);
  assert.equal(response.status, 200);
  assert.equal(response.json.proof, sign(bridge, key, 'revoke/response', nonce));
  await revoked;
  assert.equal((await client.waitClosed()).code, 1008);
  const record = credentials.records.get(CREDENTIAL_KEY);
  assert.equal(record.payload.revoked, true);
  assert.equal(record.payload.deviceKey, undefined);
  assert.equal((await bridge.status()).revoked, true);
  const reconnect = await connectWebSocket(bridge.origin, { origin: bridge.extensionOrigin });
  t.after(() => reconnect.destroy());
  reconnect.sendJson({ type: 'challenge', protocol: PROTOCOL, nonce: newNonce() });
  assert.equal((await reconnect.waitClosed()).code, 1008);
  assert.equal((await post(bridge, '/revoke', request)).json.proof, response.json.proof);
});

test('authorization persists across bridge restart without recurring pairing', async (t) => {
  const credentials = new MemoryCredentials();
  const first = (await setup(t, { credentials })).bridge;
  const { token } = await pair(first);
  await authenticate(t, first, token);
  await first.dispose();
  const second = (await setup(t, { credentials })).bridge;
  assert.equal((await second.status()).paired, true);
  assert.equal((await second.status()).pairing_available, false);
  await authenticate(t, second, token, { instanceId: 'fixture-browser-after-restart' });
  assert.equal(second.browserId, 'extension:fixture-browser-after-restart');
  assert.equal(credentials.writes.length, 1, 'Reconnect should not rewrite credentials or require another code');
});

test('heartbeat disconnects an unresponsive extension and rejects pending commands', async (t) => {
  const { bridge } = await setup(t, { heartbeatMs: 20 });
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const rejected = assert.rejects(bridge.request('tabs'), { code: 'DISCONNECTED' });
  await nextCommand(client);
  assert.deepEqual(await client.nextJson({ predicate: (message) => message?.type === 'ping' }), { type: 'ping' });
  assert.equal((await client.waitClosed()).code, 1012);
  await rejected;
});

test('port conflict does not replace another server; disposal is idempotent and fails pending work', async (t) => {
  const { bridge } = await setup(t);
  const other = new BrowserBridge({ port: bridge.port, credentials: new MemoryCredentials() });
  t.after(() => other.dispose());
  await assert.rejects(other.start(), { code: 'PORT_IN_USE' });
  assert.equal((await requestHttp(bridge.origin, { path: '/health' })).status, 200);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const disposed = assert.rejects(bridge.request('tabs'), { code: 'DISPOSED' });
  await nextCommand(client);
  await bridge.dispose();
  await disposed;
  await bridge.dispose();
  await assert.rejects(bridge.start(), { code: 'DISPOSED' });
  await assert.rejects(bridge.request('tabs'), { code: 'DISPOSED' });
  assert.equal((await bridge.status()).pending, 0);
  const neverStarted = new BrowserBridge({ credentials: new MemoryCredentials() });
  await neverStarted.dispose();
  await neverStarted.dispose();
});

test('dispose racing initial start cannot leave a listening bridge behind', async (t) => {
  const bridge = new BrowserBridge({ port: 0, credentials: new MemoryCredentials() });
  // Emergency teardown of this test-owned server also handles the regression this test detects.
  t.after(async () => {
    await bridge.dispose();
    bridge._server?.closeAllConnections();
    if (bridge._server?.listening) await new Promise((resolve) => bridge._server.close(resolve));
  });
  const starting = bridge.start();
  await bridge.dispose();
  await starting.catch((error) => assert.equal(error.code, 'DISPOSED'));
  assert.equal(bridge.connected, false);
  assert.equal(bridge._server?.listening, false, 'A disposed bridge remained bound after its in-flight start completed');
});

test('extension error diagnostics redact pairing/token-shaped material and typed text, including code fields', async (t) => {
  const { bridge } = await setup(t);
  const { token, pairing } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const typedText = 'fixture short sensitive typed text';
  const observed = bridge.request('send', { tab_id: 'ext:123', method: 'Input.insertText', params: { text: typedText } })
    .then(() => assert.fail('Expected extension error'), (error) => error);
  const command = await nextCommand(client);
  client.sendJson({ type: 'result', id: command.id, ok: false, error: {
    code: token,
    message: `Failure ${typedText}; token ${token}; code ${pairing.code}`,
  } });
  const error = await observed;
  for (const secret of [typedText, token, pairing.code]) {
    assert.ok(!String(error.message).includes(secret), 'Extension error message leaked sensitive diagnostic material');
    assert.ok(!String(error.code).includes(secret), 'Extension error code leaked sensitive diagnostic material');
  }
  assert.equal((await bridge.status()).pending, 0);
});

test('credential read failure is fail-closed and does not expose backend errors', async (t) => {
  const { bridge, credentials } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const backendSecret = 'fixture-credential-database-private-detail';
  credentials.beforeRead = () => { throw new Error(backendSecret); };
  const safeStatus = await bridge.status();
  assert.equal(safeStatus.paired, false);
  assert.equal(safeStatus.connected, false);
  assert.equal(safeStatus.reason, 'CREDENTIAL_STORE');
  assert.equal(safeStatus.credential_error, true);
  assert.ok(!JSON.stringify(safeStatus).includes(backendSecret));
  const failure = await bridge.request('tabs').then(() => assert.fail('Expected fail-closed credential error'), (error) => error);
  assert.equal(failure.code, 'EXTENSION_DISCONNECTED');
  assert.ok(!failure.message.includes(backendSecret));
  assert.equal((await client.waitClosed()).code, 1012);
});

test('live grant narrowing cancels existing work; malformed updates drop the connection', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const changed = assert.rejects(bridge.request('tabs'), { code: 'PERMISSIONS_CHANGED' });
  await nextCommand(client);
  const update = once(bridge, 'permissions');
  client.sendJson({ type: 'permissions', permissions: { ...GRANT, allowedOrigins: ['https://example.test'] } });
  await update;
  await changed;
  const invalid = assert.rejects(bridge.request('tabs'), { code: 'DISCONNECTED' });
  await nextCommand(client);
  client.sendJson({ type: 'permissions', permissions: { ...GRANT, allowedOrigins: ['https://example.test/path'] } });
  assert.equal((await client.waitClosed()).code, 1008);
  await invalid;
});

test('multiple concurrent dispose calls drain the same listening server and pending work', async (t) => {
  const { bridge } = await setup(t);
  const { token } = await pair(bridge);
  const client = await authenticate(t, bridge, token);
  const disposed = assert.rejects(bridge.request('tabs'), { code: 'DISPOSED' });
  await nextCommand(client);
  await Promise.all([bridge.dispose(), bridge.dispose(), bridge.dispose()]);
  await disposed;
  assert.equal(bridge._server.listening, false);
  assert.equal((await bridge.status()).pending, 0);
});
