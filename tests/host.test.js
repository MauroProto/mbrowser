import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { Config, parseConfig, apply, createRunner, createToolDefinitions, inject, name } from '../host-v2.js';
import { createLinkCommand } from '../lib/link-chrome.js';
import manifest from '../package.json' with { type: 'json' };
import { MemoryCredentials, deferred } from './helpers/credentials.js';
import { requestHttp } from './helpers/http.js';

function runner(overrides = {}) {
  const calls = [];
  const bridge = { async status() { calls.push({ method: 'status' }); return { backend: 'extension', connected: false, paired: false }; }, createPairingCode() { calls.push({ method: 'pair' }); return { code: 'ABCD-EF12-3456-7890', expires_at: 'fixture' }; } };
  const engine = { async execute(action, args, options) { calls.push({ method: 'execute', action, args, options }); return { ok: true }; } };
  return { calls, bridge, engine, run: createRunner({ bridge, engine, ...overrides }) };
}

/** Inspected Service-shaped doubles; NOT an installed Cordis/runtime integration. */
function hostContext({ failRegistration = -1, failDomain = false } = {}) {
  const definitions = new Map(); const commands = new Map(); const events = []; const specs = []; const disposers = [];
  let value; let globalSchema; let closed = false; let registrationIndex = 0;
  const domain = {
    global: { get() { assert.equal(closed, false); return value; }, async set(next) {
      assert.equal(closed, false); assert.notEqual(next, null, 'storageDomain uses null as a sentinel, not a persisted top-level record');
      assert.equal(globalSchema.safeParse(next).success, true); value = structuredClone(next);
    } },
    async close() { closed = true; events.push('domain:close'); },
  };
  async function dispose() { while (disposers.length) await disposers.pop()(); }
  const ctx = {
    credentials: new MemoryCredentials(),
    storageDomain: { async open(spec) {
      events.push('domain:open'); specs.push(spec);
      // Actual dsh-storage constraints, not just a shape-compatible mock.
      assert.match(spec.name, /^[a-z][a-z0-9_]*$/);
      assert.notEqual(spec.global.initial, null);
      globalSchema = spec.global.schema;
      assert.equal(globalSchema.safeParse(spec.global.initial).success, true);
      assert.equal(globalSchema.safeParse(null).success, false, 'Top-level global null must be rejected by the record codec');
      value = structuredClone(spec.global.initial);
      if (failDomain) throw new Error('fixture open failure'); return domain;
    } },
    tools: { register(definition) {
      if (registrationIndex++ === failRegistration) throw new Error('fixture registration failure');
      assert.equal(definitions.has(definition.name), false); definitions.set(definition.name, definition); events.push(`register:${definition.name}`);
      return () => { assert.ok(definitions.delete(definition.name)); events.push(`unregister:${definition.name}`); };
    } },
    commands: { register(definition) {
      commands.set(definition.name, definition);
      return () => commands.delete(definition.name);
    } },
    get(service) { assert.equal(service, 'sandboxPolicy'); return undefined; },
    async effect(factory, label) {
      events.push(`effect:${label}`);
      try { for await (const cleanup of factory()) { assert.equal(typeof cleanup, 'function'); disposers.push(cleanup); } }
      catch (error) { await dispose(); throw error; }
    },
  };
  return { ctx, definitions, commands, events, specs, domain, dispose, get closed() { return closed; } };
}
async function listeningServer(t) {
  const server = http.createServer((_req, res) => res.end('fixture owner remains present'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())));
  return server;
}
async function unusedPort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise((resolvePromise) => server.close(resolvePromise)); return port;
}

test('Host exports the intended hard dependencies and bounded extension-only configuration', () => {
  assert.equal(name, 'mbrowser');
  assert.deepEqual(inject, ['tools', 'credentials', 'storageDomain', 'commands']);
  assert.equal(typeof Config, 'function', 'Cordis configuration must be a native callable Schemastery schema');
  assert.deepEqual(Config(), { port: 43127, overlay: true });
  assert.deepEqual(Config({}), { port: 43127, overlay: true });
  assert.deepEqual(Config({ port: 45001, overlay: false }), { port: 45001, overlay: false });
  assert.deepEqual(parseConfig(undefined), { port: 43127, overlay: true });
  assert.deepEqual(parseConfig({}), { port: 43127, overlay: true });
  assert.deepEqual(parseConfig({ port: 45001, overlay: false }), { port: 45001, overlay: false });
  assert.throws(() => parseConfig({ port: 6000 }), { code: 'INVALID_PORT' });
  for (const config of [{ port: 0 }, { port: 1023 }, { port: 65536 }, { port: 45001.5 }, { port: '43127' }, { overlay: 'yes' }]) {
    assert.throws(() => Config(config)); assert.throws(() => parseConfig(config));
  }
  assert.deepEqual(parseConfig({ backend: 'cdp', port: 45001, userDataDir: 'not-a-profile' }), { port: 45001, overlay: true }, 'Legacy settings cannot silently enable CDP fallback');
});

test('pure tool definitions have exact action/schema forwarding, bounded outputs and ordered execution', async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { ok: true }; };
  const definitions = createToolDefinitions(run);
  assert.deepEqual(definitions.map(({ name }) => name), ['mbrowser_status', 'mbrowser_tabs', 'mbrowser_open', 'mbrowser_navigate', 'mbrowser_read', 'mbrowser_snapshot', 'mbrowser_click', 'mbrowser_type', 'mbrowser_press', 'mbrowser_scroll', 'mbrowser_wait', 'mbrowser_close']);
  assert.equal(new Set(definitions.map(({ name }) => name)).size, definitions.length);
  const exec = { agent: { id: 'schema-test' } };
  for (const definition of definitions) {
    assert.ok(definition.description.length > 0);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    for (const key of definition.parameters.required || []) assert.ok(Object.hasOwn(definition.parameters.properties, key));
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.isConcurrencySafe({}), false);
    assert.equal(definition.timeoutMs, ['mbrowser_wait', 'mbrowser_open'].includes(definition.name) ? 70000 : 35000);
    assert.deepEqual(JSON.parse(definition.output.render({}, { ok: true })[0].text), { ok: true });
    await definition.execute(undefined, exec);
    assert.deepEqual(calls.at(-1), [definition.name.slice('mbrowser_'.length), {}, exec]);
  }
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  assert.deepEqual(byName.get('mbrowser_read').parameters.properties.mode.enum, ['text', 'html', 'title']);
  assert.match(byName.get('mbrowser_read').parameters.properties.max_chars.description, /1000.*100000/);
  assert.match(byName.get('mbrowser_press').parameters.properties.key.description, /Control\+A/);
  assert.deepEqual(byName.get('mbrowser_type').parameters.required, ['selector', 'text']);
});

test('runner status directs the user to the human command and never generates or returns a code', async () => {
  const { run, calls } = runner();
  const first = await run('status');
  assert.equal(first.backend, 'extension'); assert.equal(first.version, manifest.version); assert.equal(first.state_persisted, true);
  assert.equal(first.extension_directory, undefined);
  assert.ok(first.setup.some((line) => line.includes('/mbrowser')));
  assert.equal(first.pairing, undefined);
  assert.deepEqual(calls, [{ method: 'status' }]);
  await assert.rejects(run('status', { pair: true }), { code: 'HUMAN_ACTION_REQUIRED' });
  assert.deepEqual(calls, [{ method: 'status' }]);
  await run('status', { pair: 'true' });
  assert.equal(calls.at(-1).method, 'status');
});

test('the human command passes a one-use local link to Chrome and never logs its secret', async () => {
  const code = 'ABCD-1234-ABCD-5678-0123-4567-89AB-CDEF';
  let generated = 0;
  let launched;
  const bridge = { port: 43127, origin: 'http://127.0.0.1:43127', createPairingCode() { generated++; return { code }; } };
  const command = createLinkCommand(bridge, url => { launched = url; });
  assert.equal(command.recordInput, false);
  assert.equal((await command.handler({ rawInput: 'https://example.com/' })).kind, 'error');
  assert.equal((await command.handler({ rawInput: '', signal: AbortSignal.abort() })).kind, 'error');
  assert.equal(generated, 0);
  const result = await command.handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  assert.equal(launched, 'http://127.0.0.1:43127/mbrowser/connect#link=' + code.replaceAll('-', ''));
  assert.ok(!JSON.stringify(result).includes(code.replaceAll('-', '')));
  const failure = await createLinkCommand(bridge, url => { throw new Error(url); }).handler({ rawInput: '' });
  assert.equal(failure.kind, 'error');
  assert.ok(!JSON.stringify(failure).includes(code.replaceAll('-', '')));
});

test('runner uses the Agent ID rather than model arguments as the ownership scope', async () => {
  const { run, calls } = runner();
  const args = { url: 'http://127.0.0.1:9876/fixture', scope: 'not-authority' };
  await run('open', args, { agent: { id: 'real-agent-session', session: { id: 'session' } } });
  assert.equal(calls[0].options.scope, 'real-agent-session');
  assert.equal(calls[0].args, args);
  await run('tabs', {}, {});
  assert.equal(calls[1].options.scope, 'agentless');
});

test('runner propagates both caller and plugin-lifetime cancellation and checks it before touching services', async () => {
  for (const source of ['caller', 'lifetime']) {
    const caller = new AbortController(); const lifetime = new AbortController();
    const { run, calls } = runner({ signal: lifetime.signal });
    await run('read', {}, { agent: { id: 'A' }, signal: caller.signal });
    const forwarded = calls[0].options.signal;
    assert.equal(forwarded.aborted, false);
    (source === 'caller' ? caller : lifetime).abort();
    assert.equal(forwarded.aborted, true);
    await assert.rejects(run('status', { pair: true }, { signal: caller.signal }), { code: 'ABORTED' });
    assert.equal(calls.length, 1);
  }
});

test('status cancellation while awaiting credentials discards the late response', async () => {
  const started = deferred(); const release = deferred(); const controller = new AbortController();
  let generated = false;
  const bridge = { async status() { started.resolve(); await release.promise; return { connected: false }; }, createPairingCode() { generated = true; return { code: 'not-allowed-after-abort' }; } };
  const { run } = runner({ bridge });
  const pending = assert.rejects(run('status', {}, { signal: controller.signal }), { code: 'ABORTED' });
  await started.promise; controller.abort(); release.resolve();
  await pending; assert.equal(generated, false);
});

test('paired Host rejects arbitrary JavaScript and file capture before invoking the engine', async () => {
  const { run, calls } = runner();
  await assert.rejects(run('js', { code: 'document.cookie' }), { code: 'UNSUPPORTED_COMMAND' });
  await assert.rejects(run('shot', { path: 'screenshot.png' }), { code: 'UNSUPPORTED_COMMAND' });
  assert.deepEqual(calls, []);
});

test('runner preserves safe engine codes for message-only renderers and masks generic exceptions', async () => {
  const safe = Object.assign(new Error('The selected tab is unavailable.'), { code: 'TAB_NOT_FOUND' });
  const { run } = runner({ engine: { async execute() { throw safe; } } });
  const error = await run('read').then(() => assert.fail('Expected rejection'), (error) => error);
  assert.equal(error.code, 'TAB_NOT_FOUND'); assert.match(error.message, /^\[TAB_NOT_FOUND\] /);
  const privateError = 'fixture-private-unexpected-failure';
  const unexpected = runner({ engine: { async execute() { throw new Error(privateError); } } });
  const generic = await unexpected.run('read').then(() => assert.fail('Expected rejection'), (error) => error);
  assert.equal(generic.code, 'BROWSER_ERROR'); assert.ok(!generic.message.includes(privateError));
});

test('Host apply starts one real loopback bridge with Service doubles and tears down in reverse ownership order', async (t) => {
  const port = await unusedPort();
  const host = hostContext(); t.after(() => host.dispose());
  await apply(host.ctx, { port, overlay: false });
  assert.equal(host.specs.length, 1);
  assert.equal(host.specs[0].name, 'mbrowser_engine_v2'); assert.equal(host.specs[0].version, 1);
  assert.equal(host.specs[0].layout, 'single'); assert.deepEqual(host.specs[0].global.initial, { state: null });
  assert.equal(host.specs[0].global.schema.safeParse(null).success, false);
  assert.deepEqual(host.specs[0].tables, {});
  assert.equal(host.definitions.size, 12);
  assert.equal(host.commands.get('mbrowser').name, 'mbrowser');
  const health = await requestHttp(`http://127.0.0.1:${port}`, { path: '/health' });
  assert.equal(health.status, 200);
  const statusTool = host.definitions.get('mbrowser_status');
  const status = await statusTool.execute({}, { agent: { id: 'fixture-agent' } });
  assert.equal(status.connected, false); assert.equal(status.bridge_url, `http://127.0.0.1:${port}`);
  const error = await host.definitions.get('mbrowser_open').execute({ url: 'http://127.0.0.1:9876/fixture' }, { agent: { id: 'fixture-agent' } }).then(() => assert.fail('Extension must be paired'), (error) => error);
  assert.equal(error.code, 'DISCONNECTED', 'No extension connection must never fall back to direct CDP');
  await host.dispose();
  assert.equal(host.definitions.size, 0); assert.equal(host.closed, true);
  assert.equal(host.commands.size, 0);
  assert.equal(host.events.at(-1), 'domain:close');
  assert.equal(host.events.filter((event) => event.startsWith('unregister:')).length, 12);
  await assert.rejects(requestHttp(`http://127.0.0.1:${port}`, { path: '/health' }));
  await assert.rejects(statusTool.execute({ pair: true }, {}), { code: 'ABORTED' });
});

test('Host startup failure on occupied port disposes only its own objects and preserves the other listener', async (t) => {
  const blocker = await listeningServer(t); const { port } = blocker.address();
  const host = hostContext(); t.after(() => host.dispose());
  await assert.rejects(apply(host.ctx, { port }), { code: 'PORT_IN_USE' });
  assert.equal(host.closed, true); assert.equal(host.definitions.size, 0); assert.equal(blocker.listening, true);
  const reply = await requestHttp(`http://127.0.0.1:${port}`, { path: '/' });
  assert.equal(reply.text, 'fixture owner remains present');
});

test('tool registration failure cleans partial registration, bridge and profile-domain handles', async (t) => {
  const host = hostContext({ failRegistration: 2 }); t.after(() => host.dispose());
  const port = await unusedPort();
  await assert.rejects(apply(host.ctx, { port }), /fixture registration failure/);
  assert.equal(host.definitions.size, 0); assert.equal(host.closed, true);
  assert.equal(host.events.filter((event) => event.startsWith('register:')).length, 2);
  assert.equal(host.events.filter((event) => event.startsWith('unregister:')).length, 2);
  await assert.rejects(requestHttp(`http://127.0.0.1:${port}`, { path: '/health' }));
});
