import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, readdir, mkdir, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserEngine } from '../lib/engine.js';
import { FakeTransport } from './helpers/fake-transport.js';
import { VMTransport } from './helpers/vm-transport.js';
import { deferred } from './helpers/credentials.js';
import { temporaryWorkspace } from './helpers/temp-workspace.js';

const ORIGIN = 'http://127.0.0.1:9876';
const URL = `${ORIGIN}/fixture`;
const GRANT = { enabled: true, allowExistingTabs: false, allowedOrigins: [ORIGIN] };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=';
const operationIs = (expression, operation) => expression.includes(`})("${operation}",`);
const sends = (transport, method) => transport.calls.filter((call) => call.method === 'send' && (!method || call.cdpMethod === method));

function engine(t, transport = new FakeTransport(), options = {}) {
  const result = new BrowserEngine({ transport, overlay: false, ...options });
  t.after(() => result.dispose());
  return { engine: result, transport };
}
async function target(t, options = {}) {
  const transport = new VMTransport(options.transportOptions);
  const result = engine(t, transport, options.engineOptions);
  const opened = await result.engine.execute('open', { url: URL }, { scope: options.scope || 'default' });
  const page = transport.pageFor(opened.tab_id);
  const button = page.add('button', { id: 'button', text: 'Click target' });
  page.document.hitOverride = button;
  return { ...result, page, button, id: opened.tab_id };
}

test('exact owned targets may be closed during initial blank metadata without granting page access or foreign close authority', async (t) => {
  const { engine: browser, transport } = engine(t);
  const opened = await browser.execute('open', { url: URL }, { scope: 'A' });
  transport.tabMap.get(opened.tab_id).url = 'about:blank';
  transport.tabMap.set('unrelated-user-tab', { id: 'unrelated-user-tab', title: 'User page', url: 'about:blank', owned: false });
  await assert.rejects(browser.execute('read', { tab_id: opened.tab_id }, { scope: 'A' }), { code: 'ACCESS_DENIED' });
  await assert.rejects(browser.execute('close', { tab_id: opened.tab_id }, { scope: 'B' }), { code: 'NOT_OWNED' });
  await assert.rejects(browser.execute('close', { tab_id: 'unrelated-user-tab' }, { scope: 'A' }), { code: 'NOT_OWNED' });
  assert.equal((await browser.execute('close', { tab_id: opened.tab_id }, { scope: 'A' })).closed, opened.tab_id);
  assert.equal(transport.tabMap.has('unrelated-user-tab'), true);
  assert.equal(sends(transport).length, 0, 'Closing an owned initial target must not evaluate or input into blank content');
});

test('engine validates transport, action, scope and argument boundaries', async (t) => {
  assert.throws(() => new BrowserEngine(), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ transport: {} }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ transport: new FakeTransport(), statePath: 'x', stateStore: {} }), { code: 'INVALID_ARGUMENT' });
  const { engine: browser } = engine(t);
  for (const [action, args, options] of [['unknown', {}], ['open', null], ['open', []], ['status', {}, { scope: '' }], ['status', {}, { scope: 's'.repeat(1025) }], ['read', { max_chars: 999 }], ['read', { max_chars: 100001 }], ['read', { max_chars: 1000.5 }]]) {
    await assert.rejects(browser.execute(action, args, options), { code: 'INVALID_ARGUMENT' });
  }
});

test('background open and independent scoped current-tab/close ownership are enforced', async (t) => {
  const { engine: browser, transport } = engine(t);
  const a = await browser.execute('open', { url: URL }, { scope: 'A' });
  const b = await browser.execute('open', { url: URL, visible: true }, { scope: 'B' });
  assert.equal(a.visible, false); assert.equal(a.background, true);
  assert.equal(b.visible, true); assert.equal(b.background, false);
  assert.deepEqual(transport.calls.filter(({ method }) => method === 'createTab').map(({ visible }) => visible), [false, true]);
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).current, a.tab_id);
  assert.equal((await browser.execute('status', {}, { scope: 'B' })).current, b.tab_id);
  await assert.rejects(browser.execute('close', { tab_id: a.tab_id }, { scope: 'B' }), { code: 'NOT_OWNED' });
  assert.equal(transport.calls.filter(({ method }) => method === 'closeTab').length, 0);
  assert.deepEqual((await browser.execute('tabs', {}, { scope: 'B' })).tabs.map(({ id }) => id), [b.tab_id]);
  assert.equal((await browser.execute('close', {}, { scope: 'A' })).closed, a.tab_id);
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).current, null);
  assert.equal((await browser.execute('status', {}, { scope: 'B' })).current, b.tab_id);
  await assert.rejects(browser.execute('close', {}, { scope: 'A' }), { code: 'NO_CURRENT_TAB' });
});

test('existing-tab access is opt-in and never grants permission to close user-created tabs', async (t) => {
  const transport = new VMTransport({ tabs: [{ id: 'foreign', url: URL, title: 'Fixture user tab' }] });
  transport.pageFor('foreign').add('p', { text: 'Existing fixture text' });
  const { engine: browser } = engine(t, transport);
  await assert.rejects(browser.execute('read', { tab_id: 'foreign' }), { code: 'ACCESS_DENIED' });
  assert.equal(sends(transport).length, 0);
  browser.allowExistingTabs = true;
  assert.equal((await browser.execute('read', { tab_id: 'foreign' })).body, 'Existing fixture text');
  await assert.rejects(browser.execute('close', { tab_id: 'foreign' }), { code: 'NOT_OWNED' });
  assert.equal(transport.calls.filter(({ method }) => method === 'closeTab').length, 0);
});

test('extension live grant overrides host preferences, origin checks and pause are fail-closed', async (t) => {
  const transport = new VMTransport({ kind: 'extension', permissions: { ...GRANT }, tabs: [{ id: 'ext:9', url: URL, owned: false }] });
  const { engine: browser } = engine(t, transport, { allowExistingTabs: true });
  await assert.rejects(browser.execute('read', { tab_id: 'ext:9' }), { code: 'ACCESS_DENIED' });
  transport.permissions = { ...GRANT, allowExistingTabs: true };
  assert.equal((await browser.execute('read', { tab_id: 'ext:9' })).ok, true);
  await assert.rejects(browser.execute('close', { tab_id: 'ext:9' }), { code: 'NOT_OWNED' });
  await assert.rejects(browser.execute('open', { url: 'https://example.test/' }), { code: 'ORIGIN_DENIED' });
  for (const url of ['file:///C:/private', 'chrome://settings/', 'javascript:alert(1)', 'https://user:pass@example.test/']) {
    await assert.rejects(browser.execute('open', { url }), { code: 'ACCESS_DENIED' });
  }
  assert.equal(transport.calls.filter(({ method }) => method === 'createTab').length, 0);
  transport.permissions = { ...GRANT, enabled: false };
  assert.equal((await browser.execute('status')).enabled, false);
  await assert.rejects(browser.execute('open', { url: URL }), { code: 'PAUSED' });
  await assert.rejects(browser.execute('tabs'), { code: 'PAUSED' });
});

test('browser-session identity change cannot adopt reused IDs or another scope current-tab state', async (t) => {
  const { engine: browser, transport } = engine(t);
  const old = await browser.execute('open', { url: URL }, { scope: 'A' });
  transport.browserId = 'browser-B';
  const status = await browser.execute('status', {}, { scope: 'A' });
  assert.equal(status.current, null); assert.equal(status.our_tabs, 0);
  await assert.rejects(browser.execute('close', { tab_id: old.tab_id }, { scope: 'A' }), { code: 'NOT_OWNED' });
  await assert.rejects(browser.execute('read', { tab_id: old.tab_id }, { scope: 'A' }), { code: 'ACCESS_DENIED' });
  assert.equal(transport.calls.some(({ method }) => method === 'closeTab'), false);
});

test('closed CDP tabs and explicitly disowned extension tabs clear ownership', async (t) => {
  const { engine: browser, transport } = engine(t);
  const opened = await browser.execute('open', { url: URL });
  transport.tabMap.delete(opened.tab_id);
  assert.deepEqual((await browser.execute('tabs')).tabs, []);
  assert.equal((await browser.execute('status')).current, null);
  await assert.rejects(browser.execute('close', { tab_id: opened.tab_id }), { code: 'NOT_OWNED' });
  const extension = new FakeTransport({ kind: 'extension', permissions: { ...GRANT } });
  const { engine: other } = engine(t, extension);
  const own = await other.execute('open', { url: URL });
  extension.tabMap.get(own.tab_id).owned = false;
  await other.execute('tabs');
  await assert.rejects(other.execute('close', { tab_id: own.tab_id }), { code: 'NOT_OWNED' });
});

test('a grant-filtered missing extension listing does not forfeit exact close-only ownership', async (t) => {
  const transport = new FakeTransport({ kind: 'extension', permissions: { ...GRANT } });
  const { engine: browser } = engine(t, transport);
  const own = await browser.execute('open', { url: URL });
  transport.listTabs = async () => [];
  await assert.rejects(browser.execute('read', { tab_id: own.tab_id }), { code: 'TAB_NOT_FOUND' });
  assert.equal((await browser.execute('close', { tab_id: own.tab_id })).closed, own.tab_id);
});

test('disconnected status never triggers page creation or implicit fallback', async (t) => {
  const transport = new FakeTransport(); transport.browserId = null;
  const { engine: browser } = engine(t, transport);
  assert.equal((await browser.execute('status')).connected, false);
  await assert.rejects(browser.execute('open', { url: URL }), { code: 'DISCONNECTED' });
  assert.deepEqual(transport.calls.map(({ method }) => method), ['status', 'status']);
});

test('state persists exact scoped ownership atomically, without full URLs, typed text or DOM data', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const path = join(workspace, 'state.json');
  const first = engine(t, new FakeTransport(), { statePath: path });
  const created = await first.engine.execute('open', { url: `${URL}?private-query=DO-NOT-PERSIST` }, { scope: 'A' });
  const text = await readFile(path, 'utf8');
  const state = JSON.parse(text);
  assert.equal(state.version, 2);
  assert.equal(state.scopes[0].tabs[0].id, created.tab_id);
  assert.equal(state.scopes[0].tabs[0].url, ORIGIN);
  assert.ok(!text.includes('DO-NOT-PERSIST'));
  assert.deepEqual((await readdir(workspace)).sort(), ['state.json']);
  await first.engine.dispose();
  const secondTransport = new FakeTransport({ tabs: [...first.transport.tabMap.values()] });
  const second = engine(t, secondTransport, { statePath: path });
  await assert.rejects(second.engine.execute('close', { tab_id: created.tab_id }, { scope: 'B' }), { code: 'NOT_OWNED' });
  assert.equal((await second.engine.execute('status', {}, { scope: 'A' })).current, created.tab_id);
  assert.equal((await second.engine.execute('close', {}, { scope: 'A' })).closed, created.tab_id);
});

test('malformed/legacy/oversized state and wrong browser identity never authorize an existing tab', async (t) => {
  const workspace = await temporaryWorkspace(t);
  for (const [index, contents] of ['{broken', JSON.stringify({ currentTab: 'foreign', tabs: ['foreign'] }), 'x'.repeat(1024 * 1024 + 1), JSON.stringify({ version: 2, browserId: 'browser-B', namespace: 'a'.repeat(32), scopes: [{ scope: 'default', current: 'foreign', tabs: [{ id: 'foreign', url: URL, createdAt: new Date().toISOString() }] }] })].entries()) {
    const path = join(workspace, `state-${index}.json`);
    await writeFile(path, contents);
    const transport = new FakeTransport({ tabs: [{ id: 'foreign', url: URL }] });
    const { engine: browser } = engine(t, transport, { statePath: path });
    await assert.rejects(browser.execute('close', { tab_id: 'foreign' }), { code: 'NOT_OWNED' });
    assert.equal(transport.calls.some(({ method }) => method === 'closeTab'), false);
  }
});

test('stateStore adapter round-trips only metadata and sanitizes backend load/save failures', async (t) => {
  let saved = null;
  const store = { async load() { return saved; }, async save(value) { saved = structuredClone(value); } };
  const first = engine(t, new FakeTransport(), { stateStore: store });
  const opened = await first.engine.execute('open', { url: URL }, { scope: 'domain-scope' });
  assert.equal(saved.scopes[0].tabs[0].id, opened.tab_id);
  const second = engine(t, new FakeTransport({ tabs: [...first.transport.tabMap.values()] }), { stateStore: store });
  assert.equal((await second.engine.execute('status', {}, { scope: 'domain-scope' })).current, opened.tab_id);
  const privateError = 'fixture-private-domain-store-data';
  for (const failure of ['load', 'save']) {
    const broken = { async load() { return null; }, async save() {}, [failure]: async () => { throw new Error(privateError); } };
    const { engine: browser, transport } = engine(t, new FakeTransport(), { stateStore: broken });
    const error = await browser.execute('open', { url: URL }).then(() => assert.fail('Expected store failure'), (error) => error);
    assert.equal(error.code, 'STATE_UNAVAILABLE');
    assert.ok(!error.message.includes(privateError));
    assert.equal(transport.calls.some(({ method }) => method === 'createTab'), false);
  }
});

test('per-scope queues preserve open order while unrelated scopes can make progress', async (t) => {
  const transport = new FakeTransport();
  const original = transport.createTab.bind(transport);
  const started = deferred(); const release = deferred();
  let held = false;
  transport.createTab = async (...args) => { if (!held) { held = true; started.resolve(); await release.promise; } return original(...args); };
  const { engine: browser } = engine(t, transport);
  const first = browser.execute('open', { url: `${URL}?first` }, { scope: 'A' });
  await started.promise;
  const queued = browser.execute('open', { url: `${URL}?second` }, { scope: 'A' });
  const independent = await browser.execute('open', { url: `${URL}?other` }, { scope: 'B' });
  assert.ok(independent.tab_id);
  assert.equal(transport.calls.filter(({ method }) => method === 'createTab').length, 1);
  release.resolve();
  const [a, b] = await Promise.all([first, queued]);
  assert.notEqual(a.tab_id, b.tab_id);
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).current, b.tab_id);
  assert.equal((await browser.execute('status', {}, { scope: 'B' })).current, independent.tab_id);
});

test('scope world names and snapshot refs cannot be reused across agent scopes even with existing-tab grants', async (t) => {
  const { engine: browser, transport, id } = await target(t, { engineOptions: { allowExistingTabs: true }, scope: 'A' });
  const a = await browser.execute('snapshot', { tab_id: id }, { scope: 'A' });
  const b = await browser.execute('snapshot', { tab_id: id }, { scope: 'B' });
  assert.notEqual(a.elements[0].ref, b.elements[0].ref);
  await assert.rejects(browser.execute('click', { tab_id: id, selector: a.elements[0].ref }, { scope: 'B' }), { code: 'STALE_REFERENCE' });
  assert.equal(sends(transport, 'Input.dispatchMouseEvent').length, 0);
  const worlds = sends(transport, 'Page.createIsolatedWorld').map(({ params }) => params.worldName);
  assert.equal(new Set(worlds).size, 2);
});

test('navigation invalidates prior references instead of reindexing a new document', async (t) => {
  const { engine: browser, transport, id } = await target(t);
  const snapshot = await browser.execute('snapshot');
  await browser.execute('navigate', { url: `${ORIGIN}/next` });
  await assert.rejects(browser.execute('click', { selector: snapshot.elements[0].ref }), { code: 'STALE_REFERENCE' });
  assert.equal(sends(transport, 'Input.dispatchMouseEvent').length, 0);
  assert.equal(transport.tabMap.get(id).url, `${ORIGIN}/next`);
});

test('click dispatches CDP pointer events in order and overlay errors are non-fatal', async (t) => {
  const { engine: browser, transport } = await target(t, {
    engineOptions: { overlay: true },
    transportOptions: { beforeSend({ method, params }) { if (method === 'Runtime.evaluate' && operationIs(params.expression, 'overlay')) return { result: { value: { ok: false, error: { code: 'PAGE_ERROR', message: 'Illustration is unavailable' } } } }; } },
  });
  assert.equal((await browser.execute('click', { selector: '#button' })).ok, true);
  assert.deepEqual(sends(transport, 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(sends(transport, 'Runtime.evaluate').every(({ params }) => params.userGesture === false));
});

test('native focus emulation brackets input and releases its override after target errors or caller cancellation without activation', { timeout: 3000 }, async (t) => {
  const { engine: browser, transport } = await target(t);
  await browser.execute('click', { selector: '#button' });
  let calls = sends(transport);
  const focus = () => sends(transport, 'Emulation.setFocusEmulationEnabled');
  assert.deepEqual(focus().map(({ params }) => params.enabled), [true, false]);
  assert.ok(calls.indexOf(focus()[0]) < calls.findIndex(({ cdpMethod }) => cdpMethod.startsWith('Input.')));
  assert.ok(calls.indexOf(focus()[1]) > calls.findLastIndex(({ cdpMethod }) => cdpMethod.startsWith('Input.')));
  await assert.rejects(browser.execute('click', { selector: '#missing' }), { code: 'ELEMENT_NOT_FOUND' });
  assert.deepEqual(focus().map(({ params }) => params.enabled), [true, false, true, false]);
  const controller = new AbortController(); const restored = deferred();
  transport.beforeSend = ({ method, params }) => {
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === false) restored.resolve();
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      controller.abort(); throw Object.assign(new Error('fixture interrupted input'), { code: 'ABORTED' });
    }
  };
  await assert.rejects(browser.execute('click', { selector: '#button' }, { signal: controller.signal }), { code: 'ABORTED' });
  await restored.promise; // Caller cancellation returns promptly; observe finally cleanup by receipt, not a sleep.
  assert.deepEqual(focus().map(({ params }) => params.enabled), [true, false, true, false, true, false]);
  assert.equal(focus().at(-1).options.signal, undefined, 'Best-effort focus release must not inherit an already-aborted caller signal');
  assert.equal(focus().at(-1).options.timeoutMs, 1000);
  calls = sends(transport);
  assert.equal(calls.some(({ cdpMethod }) => ['Page.bringToFront', 'Target.activateTarget'].includes(cdpMethod)), false);
});

test('authorized existing-tab input restores focus without adopting, activating or acquiring close authority', async (t) => {
  const id = 'existing-user-tab';
  const transport = new VMTransport({ tabs: [{ id, title: 'User fixture', url: URL, active: false, owned: false }] });
  const { engine: browser } = engine(t, transport, { allowExistingTabs: true });
  const page = transport.pageFor(id); const button = page.add('button', { id: 'button', text: 'Existing local fixture' });
  page.document.hitOverride = button;
  await browser.execute('click', { tab_id: id, selector: '#button' }, { scope: 'B' });
  assert.deepEqual(sends(transport, 'Emulation.setFocusEmulationEnabled').map(({ params }) => params.enabled), [true, false]);
  const status = await browser.execute('status', {}, { scope: 'B' });
  assert.equal(status.our_tabs, 0); assert.equal(status.current, null);
  await assert.rejects(browser.execute('close', { tab_id: id }, { scope: 'B' }), { code: 'NOT_OWNED' });
  assert.equal(transport.calls.some(({ method }) => ['createTab', 'closeTab'].includes(method)), false);
  assert.equal(sends(transport).some(({ cdpMethod }) => ['Page.bringToFront', 'Target.activateTarget'].includes(cdpMethod)), false);
});

test('hover-triggered Node replacement prevents subsequent mouse press; no unsafe selector replay', async (t) => {
  const { engine: browser, transport, page, button } = await target(t);
  transport.beforeSend = ({ method, params }) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
      const replacement = page.add('button', { id: 'new-node', text: 'Click target' });
      replacement.remove(); button.replaceWith(replacement); replacement.setAttribute('id', 'button'); page.document.hitOverride = replacement;
    }
  };
  await assert.rejects(browser.execute('click', { selector: '#button' }), { code: 'STALE_REFERENCE' });
  assert.deepEqual(sends(transport, 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved']);
});

test('type uses CDP selection/deletion/insertion, never embeds or returns typed text', async (t) => {
  const { engine: browser, transport, page } = await target(t);
  const field = page.add('input', { id: 'field', value: 'Initial' }); page.document.hitOverride = field;
  const text = 'fixture multiline\nreplacement';
  const result = await browser.execute('type', { selector: '#field', text });
  assert.equal(result.characters, text.length);
  assert.ok(!JSON.stringify(result).includes(text));
  assert.deepEqual(sends(transport).filter(({ cdpMethod }) => cdpMethod.startsWith('Input.')).map(({ cdpMethod, params }) => `${cdpMethod}:${params.type || ''}`), [
    'Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased',
    'Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp', 'Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp', 'Input.insertText:',
  ]);
  const keys = sends(transport, 'Input.dispatchKeyEvent');
  assert.equal(keys[0].params.modifiers, 2); assert.deepEqual(keys[0].params.commands, ['selectAll']);
  assert.equal(keys[2].params.key, 'Backspace');
  assert.deepEqual(sends(transport, 'Input.insertText')[0].params, { text });
  assert.ok(sends(transport, 'Runtime.evaluate').every(({ params }) => !params.expression.includes(text)), 'Typed text must be protocol data, not an evaluated source string');
});

test('empty replacement still selects/deletes; invalid or oversized text never dispatches input', async (t) => {
  const { engine: browser, transport, page } = await target(t);
  const field = page.add('input', { id: 'field', value: 'Initial' }); page.document.hitOverride = field;
  assert.equal((await browser.execute('type', { selector: '#field', text: '' })).characters, 0);
  assert.equal(sends(transport, 'Input.insertText').length, 0);
  assert.ok(sends(transport, 'Input.dispatchKeyEvent').some(({ params }) => params.key === 'Backspace'));
  const count = sends(transport).length;
  for (const text of [null, 123, 'x'.repeat(100001)]) await assert.rejects(browser.execute('type', { selector: '#field', text }), { code: 'INVALID_ARGUMENT' });
  assert.equal(sends(transport).length, count);
});

test('engine secondary redaction protects typed passwords echoed outside the original field', async (t) => {
  const { engine: browser, page } = await target(t);
  const field = page.add('input', { id: 'password', type: 'password', value: 'initial-fixture-secret' }); page.document.hitOverride = field;
  const secret = 'fixture-replacement-not-seen-by-page-model';
  assert.equal((await browser.execute('type', { selector: '#password', text: secret })).sensitive, true);
  field.remove();
  page.add('p', { text: `Unrelated page echo ${secret}` });
  const result = await browser.execute('read');
  assert.ok(!result.body.includes(secret));
  assert.ok(result.body.includes('[REDACTED]'));
});

test('disabled/covered/ambiguous/readonly targets fail without dispatching any CDP input', async (t) => {
  const { engine: browser, transport, page, button } = await target(t);
  button.disabled = true;
  await assert.rejects(browser.execute('click', { selector: '#button' }), { code: 'ELEMENT_DISABLED' });
  button.disabled = false;
  const other = page.add('button', { attrs: { class: 'duplicate' } }); button.setAttribute('class', 'duplicate');
  await assert.rejects(browser.execute('click', { selector: '.duplicate' }), { code: 'AMBIGUOUS_SELECTOR' });
  page.document.hitOverride = other;
  await assert.rejects(browser.execute('click', { selector: '#button' }), { code: 'ELEMENT_OBSCURED' });
  const readonly = page.add('input', { id: 'readonly', readOnly: true }); page.document.hitOverride = readonly;
  await assert.rejects(browser.execute('type', { selector: '#readonly', text: 'never-insert' }), { code: 'ELEMENT_NOT_EDITABLE' });
  assert.equal(sends(transport).filter(({ cdpMethod }) => cdpMethod.startsWith('Input.')).length, 0);
});

test('lost execution context retries observations once, but never replays JavaScript or a stale reference', async (t) => {
  const { engine: browser, transport } = await target(t);
  let lost = false;
  transport.beforeSend = ({ method, params }) => { if (method === 'Runtime.evaluate' && !lost) { lost = true; throw Object.assign(new Error('raw secret must not escape'), { code: 'CDP_CONTEXT_GONE' }); } };
  assert.equal((await browser.execute('read')).ok, true);
  assert.equal(sends(transport, 'Page.createIsolatedWorld').length, 2);
  const snapshot = await browser.execute('snapshot');
  lost = false;
  await assert.rejects(browser.execute('click', { selector: snapshot.elements[0].ref }), { code: 'STALE_REFERENCE' });
  assert.equal(sends(transport, 'Input.dispatchMouseEvent').length, 0);
  lost = false;
  const prior = sends(transport, 'Runtime.evaluate').length;
  await assert.rejects(browser.execute('js', { code: 'globalThis.sideEffect = true' }), { code: 'CDP_CONTEXT_GONE' });
  assert.equal(sends(transport, 'Runtime.evaluate').length, prior + 1);
});

test('unknown transport diagnostics, including error codes, cannot echo typed or credential-like secrets', async (t) => {
  const { engine: browser, transport } = await target(t);
  const secret = 'FIXTURE_SECRET_IN_UNTRUSTED_CODE';
  transport.beforeSend = () => { throw Object.assign(new Error(`private protocol failure ${secret}`), { code: secret, data: { private: secret } }); };
  const error = await browser.execute('read').then(() => assert.fail('Expected transport error'), (error) => error);
  assert.equal(error.code, 'BROWSER_ERROR');
  assert.ok(!JSON.stringify({ code: error.code, message: error.message }).includes(secret));
});

test('pre-aborted actions do not invoke transport or create any tab', async (t) => {
  const { engine: browser, transport } = engine(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(browser.execute('open', { url: URL }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(transport.calls, []);
});

test('abort during pending observation returns promptly, cancels queued work, and never replays input', async (t) => {
  const { engine: browser, transport } = await target(t);
  const started = deferred(); const release = deferred();
  transport.beforeSend = async ({ method, params }) => { if (method === 'Runtime.evaluate' && operationIs(params.expression, 'read')) { started.resolve(); await release.promise; } };
  const firstController = new AbortController();
  const first = assert.rejects(browser.execute('read', {}, { signal: firstController.signal }), { code: 'ABORTED' });
  await started.promise;
  const secondController = new AbortController();
  const second = assert.rejects(browser.execute('click', { selector: '#button' }, { signal: secondController.signal }), { code: 'ABORTED' });
  secondController.abort(); firstController.abort();
  await Promise.all([first, second]);
  release.resolve();
  // A new status queues behind the drained old scope work and proves no delayed click occurs.
  await browser.execute('status');
  assert.equal(sends(transport, 'Input.dispatchMouseEvent').length, 0);
});

test('cancellation after attempted mouse press releases the button without replaying a click', async (t) => {
  const { engine: browser, transport } = await target(t);
  const controller = new AbortController();
  transport.beforeSend = ({ method, params }) => { if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') controller.abort(); };
  await assert.rejects(browser.execute('click', { selector: '#button' }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(sends(transport, 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('cancellation after attempted keydown releases it and does not leave modifiers held', async (t) => {
  const { engine: browser, transport } = await target(t);
  const controller = new AbortController();
  transport.beforeSend = ({ method, params }) => { if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') controller.abort(); };
  await assert.rejects(browser.execute('press', { key: 'Control+A' }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(sends(transport, 'Input.dispatchKeyEvent').map(({ params }) => params.type), ['keyDown', 'keyUp']);
});

test('grant pause or browser identity switch between pointer commands prevents the next dispatch', async (t) => {
  for (const change of ['pause', 'identity']) {
    const { engine: browser, transport } = await target(t, { transportOptions: { kind: 'extension', permissions: { ...GRANT } } });
    transport.beforeSend = ({ method, params }) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        if (change === 'pause') transport.permissions = { ...GRANT, enabled: false };
        else transport.browserId = 'browser-new';
      }
    };
    await assert.rejects(browser.execute('click', { selector: '#button' }), { code: change === 'pause' ? 'PAUSED' : 'BROWSER_CHANGED' });
    assert.deepEqual(sends(transport, 'Input.dispatchMouseEvent').map(({ params }) => params.type), ['mouseMoved']);
  }
});

test('keyboard chords use explicit bounded browser protocol events', async (t) => {
  const { engine: browser, transport } = await target(t);
  const key = await browser.execute('press', { key: 'Control+A' });
  assert.equal(key.modifiers, 2); assert.equal(key.key, 'A');
  const keys = sends(transport, 'Input.dispatchKeyEvent');
  assert.equal(keys[0].params.key, 'A'); assert.equal(keys[0].params.code, 'KeyA');
  assert.equal(keys[0].params.modifiers, 2); assert.equal(keys[1].params.type, 'keyUp');
  for (const key of ['', 'NotAKey', 'Control+Control+A', 'Unknown+A']) await assert.rejects(browser.execute('press', { key }), { code: 'INVALID_ARGUMENT' });
});

test('scroll observes immediate offsets in one non-replayed DOM operation without wheel, focus or activation', async (t) => {
  const { engine: browser, transport, page } = await target(t);
  const root = page.document.scrollingElement;
  root.scrollHeight = root.clientHeight + 1000;
  const start = transport.calls.length;
  const scroll = await browser.execute('scroll', { delta_y: 321 });
  assert.deepEqual(scroll.at, { x: 512, y: 384 });
  assert.equal(scroll.method, 'dom'); assert.equal(scroll.moved_y, 321); assert.equal(root.scrollTop, 321);
  assert.equal(scroll.scrollers.length, 1); assert.equal(scroll.changed, true);
  const calls = transport.calls.slice(start).filter(({ method }) => method === 'send');
  assert.equal(calls.filter(({ cdpMethod, params }) => cdpMethod === 'Runtime.evaluate' && operationIs(params.expression, 'scroll')).length, 1);
  assert.ok(!calls.some(({ cdpMethod }) => /^(Input\.|Emulation\.)/.test(cdpMethod) || cdpMethod === 'Page.bringToFront'));
  for (const args of [{ x: -1, y: 10 }, { x: 1024, y: 10 }, { x: 5 }, { y: 5 }, { selector: '#button', x: 1, y: 1 }, { delta_y: Infinity }, { delta_x: 100001 }]) {
    await assert.rejects(browser.execute('scroll', args), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(root.scrollWrites.length, 1, 'Invalid requests never scroll or prepare via scrollIntoView');
  await browser.execute('scroll', { delta_y: 100000 });
  const boundary = await browser.execute('scroll', { delta_y: 1 });
  assert.equal(boundary.changed, false); assert.equal(boundary.moved_y, 0);
});

test('scroll never replays after context loss or a lost response', async (t) => {
  for (const code of ['CDP_CONTEXT_GONE', 'TIMEOUT']) {
    const { engine: browser, transport, page } = await target(t);
    const root = page.document.scrollingElement; root.scrollHeight += 1000;
    let attempts = 0;
    transport.beforeSend = async ({ method, params }) => {
      if (method === 'Runtime.evaluate' && operationIs(params.expression, 'scroll')) {
        attempts++; await page.evaluate(params.expression); // It took effect, but its reply was lost.
        throw Object.assign(new Error('fixture lost scroll response'), { code });
      }
    };
    await assert.rejects(browser.execute('scroll', { delta_y: 100 }), { code });
    assert.equal(attempts, 1); assert.equal(root.scrollTop, 100); assert.equal(root.scrollWrites.length, 1);
    assert.equal(sends(transport, 'Input.dispatchMouseEvent').length, 0);
    assert.equal(sends(transport, 'Emulation.setFocusEmulationEnabled').length, 0);
  }
});

test('screenshot writes only a new PNG in the trusted workspace and never overwrites existing files', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const { engine: browser, transport } = await target(t, { engineOptions: { workspaceRoot: workspace } });
  transport.beforeSend = ({ method }) => method === 'Page.captureScreenshot' ? { data: PNG } : undefined;
  const path = join(workspace, 'capture.png');
  const result = await browser.execute('shot', { path });
  assert.equal(result.path, await realpath(path));
  assert.deepEqual(await readFile(path), Buffer.from(PNG, 'base64'));
  await assert.rejects(browser.execute('shot', { path }), { code: 'FILE_EXISTS' });
  assert.deepEqual(await readFile(path), Buffer.from(PNG, 'base64'));
  assert.deepEqual(await readdir(workspace), ['capture.png']);
});

test('screenshot rejects missing trust, path escape and symlink escape before capture', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const outside = await temporaryWorkspace(t);
  const { engine: browser, transport } = await target(t, { engineOptions: { workspaceRoot: workspace } });
  for (const path of [join(outside, 'outside.png'), join(workspace, 'not-png.txt'), 'relative.png', join(workspace, 'missing', 'capture.png')]) {
    await assert.rejects(browser.execute('shot', { path }), { code: 'INVALID_PATH' });
  }
  await mkdir(join(outside, 'target'));
  await symlink(join(outside, 'target'), join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(browser.execute('shot', { path: join(workspace, 'escape', 'capture.png') }), { code: 'INVALID_PATH' });
  browser.workspaceRoot = undefined;
  await assert.rejects(browser.execute('shot', { path: join(workspace, 'capture.png') }), { code: 'INVALID_PATH' });
  assert.equal(sends(transport, 'Page.captureScreenshot').length, 0);
});

test('screenshot rejects invalid base64, non-PNG bytes and oversized encoded output without publishing files', async (t) => {
  const workspace = await temporaryWorkspace(t);
  const { engine: browser, transport } = await target(t, { engineOptions: { workspaceRoot: workspace } });
  for (const data of ['', 'not base64!?', Buffer.from('not PNG').toString('base64')]) {
    transport.beforeSend = ({ method }) => method === 'Page.captureScreenshot' ? { data } : undefined;
    await assert.rejects(browser.execute('shot', { path: join(workspace, 'capture.png') }), { code: 'INVALID_SCREENSHOT' });
  }
  transport.beforeSend = ({ method }) => method === 'Page.captureScreenshot' ? { data: 'A'.repeat(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 8) } : undefined;
  await assert.rejects(browser.execute('shot', { path: join(workspace, 'capture.png') }), { code: 'SCREENSHOT_TOO_LARGE' });
  assert.deepEqual(await readdir(workspace), []);
});

test('engine observations enforce serialized max_chars for numeric output too', async (t) => {
  const { engine: browser } = await target(t);
  const result = await browser.execute('js', { code: 'Array.from({length:1000},(_,i)=>i)', max_chars: 1000 });
  assert.ok(JSON.stringify(result).length <= 1100);
  assert.equal(result.truncated, true);
});

test('engine safely budgets observations which already contain a truncation marker', async (t) => {
  const { engine: browser, transport } = await target(t);
  for (const marker of [true, false]) {
    transport.beforeSend = ({ method, params }) => {
      if (method === 'Runtime.evaluate' && operationIs(params.expression, 'read')) {
        // Native protocol serialization can place an existing marker before a long field.
        return { result: { value: { ok: true, truncated: marker, body: 'x'.repeat(5000) } } };
      }
    };
    const result = await browser.execute('read', { mode: 'html', max_chars: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.ok(result.body.length > 0 && result.body.length < 5000);
    assert.ok(JSON.stringify(result).length <= 1000);
  }
});

test('engine disposal aborts outstanding work, detaches only touched tabs, and never creates or closes tabs', async (t) => {
  const { engine: browser, transport } = await target(t);
  await browser.execute('read');
  const started = deferred(); const release = deferred();
  transport.beforeSend = async ({ method, params }) => { if (method === 'Runtime.evaluate' && operationIs(params.expression, 'js')) { started.resolve(); await release.promise; } };
  const pending = assert.rejects(browser.execute('js', { code: '1+1' }), { code: 'ABORTED' });
  await started.promise;
  const callCount = transport.calls.length;
  await browser.dispose(); await pending;
  release.resolve();
  assert.deepEqual(transport.calls.slice(callCount).map(({ method }) => method), ['detach', 'dispose']);
  await assert.rejects(browser.execute('status'), { code: 'DISCONNECTED' });
  await browser.dispose();
});

test('contenteditable replacement survives native clear/insert mutations without replacing the target Node', async (t) => {
  const { engine: browser, transport, page } = await target(t);
  const field = page.add('div', { id: 'editable', text: 'initial text', editable: true, attrs: { contenteditable: 'true' } });
  page.document.hitOverride = field;
  transport.beforeSend = ({ method, params }) => {
    // Model only the native mutation between protocol commands; this is NOT a trusted-event browser test.
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Backspace') field.textContent = '';
    if (method === 'Input.insertText') field.textContent = params.text;
  };
  const reference = (await browser.execute('snapshot')).elements.find((entry) => entry.text === 'initial text')?.ref;
  assert.ok(reference);
  await browser.execute('type', { selector: reference, text: 'replacement editable' });
  assert.equal(field.textContent, 'replacement editable');
  assert.equal(sends(transport, 'Input.insertText').length, 1);
  await browser.execute('click', { selector: reference });
});

test('an exact late open result is retained only by its original scope and never replaces newer current-tab state', { timeout: 2000 }, async (t) => {
  const transport = new FakeTransport(); const create = transport.createTab.bind(transport);
  const started = deferred(); const release = deferred(); const recorded = deferred();
  let lateId; let saved = null;
  transport.createTab = async (args, options) => {
    if (!args.url.endsWith('?late')) return create(args, options);
    started.resolve(); await release.promise;
    const tab = await create(args, options); lateId = tab.id; return tab;
  };
  const { engine: browser } = engine(t, transport, { stateStore: {
    load: async () => null,
    save: async (state) => { saved = structuredClone(state); if (lateId && JSON.stringify(state).includes(`\"${lateId}\"`)) recorded.resolve(); },
  } });
  const controller = new AbortController();
  const pending = assert.rejects(browser.execute('open', { url: `${URL}?late` }, { scope: 'A', signal: controller.signal }), { code: 'ABORTED' });
  await started.promise; controller.abort(); await pending;
  const newer = await browser.execute('open', { url: `${URL}?newer` }, { scope: 'A' });
  const unrelated = await browser.execute('open', { url: URL }, { scope: 'B' });
  release.resolve(); await recorded.promise;
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).current, newer.tab_id);
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).our_tabs, 2);
  assert.equal((await browser.execute('status', {}, { scope: 'B' })).current, unrelated.tab_id);
  await assert.rejects(browser.execute('close', { tab_id: lateId }, { scope: 'B' }), { code: 'NOT_OWNED' });
  assert.ok(JSON.stringify(saved).includes(lateId));
  assert.equal((await browser.execute('close', { tab_id: lateId }, { scope: 'A' })).closed, lateId);
  assert.equal(transport.calls.filter(({ method }) => method === 'createTab').length, 3, 'Never replay an aborted open');
});

test('a late successful creation from an old browser identity cannot be adopted by the new browser', { timeout: 2000 }, async (t) => {
  const transport = new FakeTransport(); const create = transport.createTab.bind(transport);
  const started = deferred(); const release = deferred(); const returned = deferred();
  transport.createTab = async (args, options) => { started.resolve(); await release.promise; const tab = await create(args, options); returned.resolve(tab); return tab; };
  const { engine: browser } = engine(t, transport);
  const controller = new AbortController();
  const pending = assert.rejects(browser.execute('open', { url: URL }, { scope: 'A', signal: controller.signal }), { code: 'ABORTED' });
  await started.promise; controller.abort(); await pending;
  transport.browserId = 'fixture-new-browser';
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).our_tabs, 0);
  release.resolve(); const late = await returned.promise;
  assert.equal((await browser.execute('status', {}, { scope: 'A' })).our_tabs, 0);
  await assert.rejects(browser.execute('close', { tab_id: late.id }, { scope: 'A' }), { code: 'NOT_OWNED' });
  assert.equal(transport.calls.filter(({ method }) => method === 'closeTab').length, 0);
});

test('observations in one scope do not reveal password guesses remembered by another', async (t) => {
  const { engine: browser } = engine(t);
  const secret = 'fixture-other-agent-password';
  browser._secrets.set('A', new Set([secret]));
  const payload = { body: secret };
  assert.equal(browser._scrub(payload, 1000, 'A').body, '[REDACTED]');
  assert.equal(browser._scrub(payload, 1000, 'B').body, secret);
});

test('engine sensitive-value cache capacity fails closed before typing an otherwise untracked new password', async (t) => {
  const { engine: browser, transport, page } = await target(t);
  const field = page.add('input', { id: 'capacity-password', type: 'password', value: 'fixture-old-password' });
  page.document.hitOverride = field;
  // Boundary fixture: equivalent to passwords remembered across 256 earlier, now-closed documents.
  browser._secrets.set('default', new Set(Array.from({ length: 256 }, (_, index) => `fixture-prior-password-${index}`)));
  await assert.rejects(browser.execute('type', { selector: '#capacity-password', text: 'fixture-new-untracked-password' }), { code: 'PAGE_ERROR' });
  assert.equal(sends(transport, 'Input.insertText').length, 0, 'Never type a password whose fallback redaction cannot be retained');
});

test('input abort cleanup never dispatches to a reused ID in a different browser session', async (t) => {
  for (const kind of ['mouse', 'keyboard']) {
    const { engine: browser, transport } = await target(t);
    const controller = new AbortController();
    transport.beforeSend = ({ method, params }) => {
      if ((kind === 'mouse' && method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')
        || (kind === 'keyboard' && method === 'Input.dispatchKeyEvent' && params.type === 'keyDown')) {
        transport.browserId = 'different-browser-reusing-tab-id'; controller.abort();
      }
    };
    await assert.rejects(browser.execute(kind === 'mouse' ? 'click' : 'press', kind === 'mouse' ? { selector: '#button' } : { key: 'Control+A' }, { signal: controller.signal }), { code: 'ABORTED' });
    const events = sends(transport, kind === 'mouse' ? 'Input.dispatchMouseEvent' : 'Input.dispatchKeyEvent');
    assert.equal(events.filter(({ params }) => params.type === (kind === 'mouse' ? 'mouseReleased' : 'keyUp')).length, 0,
      'Release cleanup must not inject input into a different browser/possibly user-created tab');
    assert.equal(sends(transport, 'Emulation.setFocusEmulationEnabled').filter(({ params }) => params.enabled === false).length, 0,
      'Focus cleanup must not mutate a reused target in a different browser lifetime');
  }
});
