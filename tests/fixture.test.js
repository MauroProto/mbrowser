import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSWORD_SENTINEL, startFixture, TITLE } from './fixtures/server.js';
import { requestHttp } from './helpers/http.js';

test('local fixture binds only ephemeral IPv4 loopback and serves deterministic pages', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const address = fixture.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  assert.ok(address.port > 0);
  const first = await requestHttp(fixture.origin, { path: '/fixture' });
  const again = await requestHttp(fixture.origin, { path: '/fixture' });
  assert.equal(first.status, 200);
  assert.equal(first.text, again.text, 'fixture must not embed random identifiers or timestamps');
  assert.ok(first.text.includes(`<title>${TITLE}</title>`));
  assert.ok(first.text.includes(PASSWORD_SENTINEL));
  for (const id of ['fixture-ready', 'click-target', 'replaceable', 'controlled', 'password', 'covered-target', 'disabled', 'readonly', 'editable', 'shadow-host']) {
    assert.ok(first.text.includes(`id="${id}"`), `missing scenario ${id}`);
  }
  assert.equal((first.text.match(/class="ambiguous"/g) || []).length, 2);
  assert.ok(first.text.includes('event.isTrusted'));
  assert.ok(first.text.includes('valueDescriptor.set.call'));
  assert.ok(first.text.includes('old.replaceWith(replacement)'));
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.ok(first.headers['content-security-policy'].includes("default-src 'self'"));
  assert.doesNotMatch(first.text, /(?:src|href)="(?:https?:)?\/\//i, 'fixture must never load external resources');
  const health = await requestHttp(fixture.origin, { path: '/health' });
  assert.deepEqual(health.json, { name: 'mbrowser-test-fixture', version: 1 });
  for (const path of ['/next', '/frame']) {
    assert.equal((await requestHttp(fixture.origin, { path })).status, 200);
  }
  assert.deepEqual(fixture.requests.map(({ pathname }) => pathname), ['/fixture', '/fixture', '/health', '/next', '/frame']);
});

test('local fixture rejects unrelated hosts, unsupported methods, and unknown paths', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  assert.equal((await requestHttp(fixture.origin, { headers: { host: 'attacker.invalid' } })).status, 403);
  const method = await requestHttp(fixture.origin, { method: 'POST', body: 'not persisted' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'GET, HEAD');
  assert.equal((await requestHttp(fixture.origin, { path: '/not-a-route' })).status, 404);
  const head = await requestHttp(fixture.origin, { method: 'HEAD', path: '/fixture' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.ok(Number(head.headers['content-length']) > 0);
  await fixture.close();
  await fixture.close();
  assert.equal(fixture.address(), null);
});
