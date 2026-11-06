import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryWorkspace } from '../helpers/temp-workspace.js';
import { test } from 'node:test';
import { PASSWORD_SENTINEL, startFixture } from '../fixtures/server.js';

const enabled = process.env.MBROWSER_LIVE === '1';

test('LIVE CDP: own local tabs only; trusted input, identity, redaction, scopes and background', {
  skip: enabled ? false : 'Not run: set MBROWSER_LIVE=1 and MBROWSER_TEST_CDP_PORT explicitly; requires authorized Chrome CDP.',
  timeout: 90000,
}, async (t) => {
  const portText = process.env.MBROWSER_TEST_CDP_PORT || '';
  assert.match(portText, /^\d{1,5}$/, 'MBROWSER_TEST_CDP_PORT must be explicitly provided; profile autodiscovery is forbidden here');
  const port = Number(portText);
  assert.ok(port > 0 && port <= 65535, 'Invalid explicit test CDP port');
  const [{ BrowserEngine }, { CDPTransport }] = await Promise.all([
    import('../../lib/engine.js'), import('../../lib/cdp.js'),
  ]);
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const directory = await temporaryWorkspace(t);
  const cdp = new CDPTransport({ port, env: {}, timeoutMs: 5000 });
  const acquired = new Set();
  const identities = new Map();
  const remaining = new Set();
  const sent = [];
  // Independent of engine authorization; stop on unknown IDs or a changed browser lifetime.
  const ownId = (id) => {
    assert.ok(acquired.has(id), 'SAFETY STOP: transport target was not created by this test');
    assert.equal(identities.get(id), cdp.browserId, 'SAFETY STOP: browser identity changed since test-created tab');
  };
  const localUrl = (url) => assert.equal(new URL(url).origin, fixture.origin, 'SAFETY STOP: non-fixture URL');
  const transport = {
    kind: 'cdp',
    get browserId() { return cdp.browserId; },
    status: (options) => cdp.status(options),
    listTabs: (options) => cdp.listTabs(options),
    async createTab(args, options) {
      localUrl(args.url);
      assert.notEqual(args.visible, true, 'SAFETY STOP: test must never select a tab');
      const tab = await cdp.createTab(args, options); acquired.add(tab.id); identities.set(tab.id, cdp.browserId); remaining.add(tab.id); return tab;
    },
    async closeTab(id, options) { ownId(id); const value = await cdp.closeTab(id, options); remaining.delete(id); return value; },
    async send(id, method, params, options) {
      ownId(id);
      if (method === 'Page.navigate') localUrl(params.url);
      assert.notEqual(method, 'Page.bringToFront', 'SAFETY STOP: foreground activation forbidden');
      sent.push({ id, method });
      return cdp.send(id, method, params, options);
    },
    async detach(id, options) { ownId(id); return cdp.detach?.(id, options); },
    dispose: () => cdp.dispose(),
  };
  const engine = new BrowserEngine({ transport, statePath: join(directory, 'state.json') });
  t.after(async () => {
    try {
      const failures = [];
      for (const id of [...remaining]) {
        try { await transport.closeTab(id, { timeoutMs: 5000 }); }
        catch (error) { failures.push({ id, code: error?.code || 'CLEANUP_FAILED' }); }
      }
      if (failures.length) t.diagnostic(`Exact-ID cleanup could not confirm closure: ${JSON.stringify(failures)}`);
      assert.equal(remaining.size, 0, 'After cleanup, some exact test-created tabs could not safely be closed');
      t.diagnostic(`Cleanup verified: ${acquired.size} exact test-created tabs closed; no pre-existing targets touched.`);
    } finally { await engine.dispose(); }
  });
  const scope = 'local-live-a';
  const run = (action, args = {}) => engine.execute(action, args, { scope });
  await cdp.status();
  const opened = await run('open', { url: fixture.url });
  const tabId = opened.tab_id || opened.targetId;
  assert.ok(acquired.has(tabId));
  // Markup alone may be visible before the bottom-of-document script installs listeners.
  await run('wait', { selector: '#fixture-ready', timeout_ms: 5000 });
  await run('wait', { selector: '#click-target', timeout_ms: 5000 });

  await t.test('created tab remains background; no bring-to-front command', async () => {
    const result = await run('js', { code: 'document.visibilityState' });
    assert.equal(result.value, 'hidden', 'The test-created tab unexpectedly became foreground');
    assert.ok(!sent.some(({ method }) => method === 'Page.bringToFront'));
  });

  await t.test('background DOM scroll observes immediate root/nested offsets without wheel or boundary chaining', async () => {
    const start = sent.length;
    await run('js', { code: `(() => {
      document.documentElement.style.scrollBehavior = 'smooth';
      document.scrollingElement.scrollTo({left:0,top:0,behavior:'instant'});
      globalThis.__mbrowserLiveWheels = 0;
      globalThis.__mbrowserLiveWheelHandler = () => globalThis.__mbrowserLiveWheels++;
      document.addEventListener('wheel', globalThis.__mbrowserLiveWheelHandler, {passive:true});
      return true;
    })()` });
    try {
      const moved = await run('scroll', { selector: 'html', delta_y: 123 });
      assert.equal(moved.method, 'dom'); assert.equal(moved.moved_y, 123);
      await run('js', { code: `(() => {
        const box = document.createElement('div'); box.id = 'mbrowser-live-scroll';
        box.style.cssText = 'position:fixed;top:10px;left:10px;width:180px;height:80px;overflow:auto;scroll-behavior:smooth;z-index:2147483646;background:white';
        const contents = document.createElement('div'); contents.style.cssText='height:400px;width:400px'; contents.textContent='Own scroll fixture';
        box.append(contents); document.body.append(box); return true;
      })()` });
      const nested = await run('scroll', { selector: '#mbrowser-live-scroll', delta_x: 17, delta_y: 75 });
      assert.equal(nested.moved_x, 17); assert.equal(nested.moved_y, 75); assert.equal(nested.scrollers.length, 1);
      await run('scroll', { selector: '#mbrowser-live-scroll', delta_y: 100000 });
      const boundary = await run('scroll', { selector: '#mbrowser-live-scroll', delta_y: 10 });
      assert.equal(boundary.changed, false); assert.equal(boundary.moved_y, 0);
      const observed = await run('js', { code: '({root:document.scrollingElement.scrollTop,hidden:document.visibilityState,wheels:globalThis.__mbrowserLiveWheels})' });
      assert.equal(observed.value.root, 123); assert.equal(observed.value.hidden, 'hidden'); assert.equal(observed.value.wheels, 0);
      assert.ok(!sent.slice(start).some(({ method }) => /^(Input\.|Emulation\.)/.test(method) || method === 'Page.bringToFront'));
    } finally {
      await run('js', { code: `(() => {
        document.getElementById('mbrowser-live-scroll')?.remove();
        document.documentElement.style.removeProperty('scroll-behavior');
        document.scrollingElement.scrollTo({left:0,top:0,behavior:'instant'});
        document.removeEventListener('wheel',globalThis.__mbrowserLiveWheelHandler);
        delete globalThis.__mbrowserLiveWheelHandler; delete globalThis.__mbrowserLiveWheels; return true;
      })()` });
    }
  });

  await t.test('click dispatches trusted browser mouse events', async () => {
    await run('js', { code: 'document.getElementById("fixture-reset-events").click()' });
    await run('click', { selector: '#click-target' });
    await run('wait', { selector: '#click-target[data-clicks="1"]', timeout_ms: 5000 });
    const result = await run('js', { code: '({clicks: JSON.parse(document.getElementById("fixture-state").textContent).clicks, events: JSON.parse(document.getElementById("fixture-state").textContent).events})' });
    assert.equal(result.value.clicks, 1);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      assert.ok(result.value.events.some((event) => event.type === type && event.id === 'click-target' && event.trusted === true), `Missing trusted ${type}`);
    }
  });

  await t.test('native replacement updates React-style tracked and multiline inputs', async () => {
    await run('type', { selector: '#controlled', text: 'replacement React value' });
    const controlled = await run('js', { code: '({value: JSON.parse(document.getElementById("fixture-state").textContent).controlled, changes: JSON.parse(document.getElementById("fixture-state").textContent).changes, events: JSON.parse(document.getElementById("fixture-state").textContent).events.filter(e => e.id === "controlled")})' });
    assert.equal(controlled.value.value, 'replacement React value');
    assert.ok(controlled.value.changes >= 1);
    assert.ok(controlled.value.events.some((event) => event.type === 'input' && event.trusted === true));
    const text = 'first line\nsecond line 👋';
    await run('type', { selector: '#textarea', text });
    assert.equal((await run('js', { code: 'document.querySelector("#textarea").value' })).value, text);
    await run('type', { selector: '#editable', text: 'replacement editable' });
    assert.equal((await run('js', { code: 'document.querySelector("#editable").textContent' })).value, 'replacement editable');
  });

  await t.test('password contents never appear in snapshot, HTML, or type result', async () => {
    const initial = JSON.stringify(await run('snapshot'));
    assert.ok(!initial.includes(PASSWORD_SENTINEL), 'Snapshot exposed initial password');
    const typedSecret = 'fixture-new-password-private-827b';
    const typed = await run('type', { selector: '#password', text: typedSecret });
    const html = await run('read', { mode: 'html' });
    const after = await run('snapshot');
    const observations = JSON.stringify({ typed, html, after });
    assert.ok(!observations.includes(PASSWORD_SENTINEL), 'HTML retained password value attribute');
    assert.ok(!observations.includes(typedSecret), 'Observation or type result exposed typed password');
  });

  await t.test('ambiguous, disabled, readonly, hidden, covered and invalid targets fail safely', async () => {
    for (const [action, args, code] of [
      ['click', { selector: '.ambiguous' }, 'AMBIGUOUS_SELECTOR'],
      ['click', { selector: '#disabled' }, 'ELEMENT_DISABLED'],
      ['type', { selector: '#readonly', text: 'not written' }, 'ELEMENT_NOT_EDITABLE'],
      ['click', { selector: '#covered-target' }, 'ELEMENT_OBSCURED'],
      ['click', { selector: '[' }, 'INVALID_SELECTOR'],
    ]) await assert.rejects(run(action, args), { code });
    await assert.rejects(run('click', { selector: '#hidden' }), (error) => ['ELEMENT_NOT_FOUND', 'ELEMENT_OBSCURED', 'ELEMENT_NOT_VISIBLE'].includes(error.code));
    assert.equal((await run('js', { code: 'document.querySelector("#readonly").value' })).value, 'unchanged');
  });

  await t.test('snapshot references detect replacement rather than clicking a new node', async () => {
    const snapshot = await run('snapshot');
    const reference = snapshot.elements.find((item) => item.text === 'Original identity')?.ref;
    assert.ok(reference, 'Snapshot must expose opaque identity reference');
    await run('js', { code: 'document.getElementById("fixture-replace").click()' });
    await assert.rejects(run('click', { selector: reference }), { code: 'STALE_REFERENCE' });
    assert.equal((await run('js', { code: 'JSON.parse(document.getElementById("fixture-state").textContent).replacementClicks' })).value, 0);
    await run('click', { selector: '#replaceable' });
    await run('wait', { selector: '#replaceable[data-clicks="1"]', timeout_ms: 5000 });
    assert.equal((await run('js', { code: 'JSON.parse(document.getElementById("fixture-state").textContent).replacementClicks' })).value, 1);
  });

  await t.test('open shadow DOM targets retain identity and accept trusted input', async () => {
    const snapshot = await run('snapshot');
    const reference = snapshot.elements.find((item) => item.text === 'Shadow action')?.ref;
    assert.ok(reference, 'Open shadow-root target missing from snapshot');
    await run('click', { selector: reference });
    await run('wait', { selector: '#shadow-host[data-clicks="1"]', timeout_ms: 5000 });
    assert.equal((await run('js', { code: 'JSON.parse(document.getElementById("fixture-state").textContent).shadowClicks' })).value, 1);
  });

  await t.test('wait timeout and explicit insertion use local state only', async () => {
    await assert.rejects(run('wait', { selector: '#will-not-exist', timeout_ms: 60 }), { code: 'TIMEOUT' });
    await run('js', { code: 'document.getElementById("fixture-insert").click()' });
    const found = await run('wait', { selector: '#delayed-target', timeout_ms: 1000 });
    assert.notEqual(found.ok, false);
  });

  await t.test('current tabs and close authority are scope-isolated', async () => {
    const otherScope = 'local-live-b';
    await assert.rejects(engine.execute('read', {}, { scope: otherScope }), { code: 'NO_CURRENT_TAB' });
    const other = await engine.execute('open', { url: `${fixture.origin}/next` }, { scope: otherScope });
    const otherId = other.tab_id || other.targetId;
    // Negative close targets another test-created local tab, never an existing user tab.
    await assert.rejects(run('close', { tab_id: otherId }), { code: 'NOT_OWNED' });
    const before = await run('snapshot');
    const reference = before.elements.find((item) => item.ref)?.ref;
    assert.ok(reference);
    await run('navigate', { url: `${fixture.origin}/next` });
    await run('wait', { selector: '#next', timeout_ms: 5000 });
    await assert.rejects(run('click', { selector: reference }), { code: 'STALE_REFERENCE' });
    await engine.execute('close', { tab_id: otherId }, { scope: otherScope });
    await run('close', { tab_id: tabId });
    assert.equal(remaining.size, 0);
  });

  assert.ok(acquired.size >= 2, 'Integration must actually create and exercise its own local tabs');
  // Actual leak verification runs AFTER guarded t.after cleanup, including when a subtest failed.
  t.diagnostic('Exercised explicit CDP endpoint only. Extension installation/grant/restart remain separate manual checks. No screenshots taken.');
});
