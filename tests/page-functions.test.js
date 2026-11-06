import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSWORD_SENTINEL } from './fixtures/server.js';
import { createPageVm } from './helpers/page-vm.js';

function page(t) { const fixture = createPageVm(); t.after(() => fixture.dispose()); return fixture; }
function errorCode(result, code) { assert.equal(result.ok, false); assert.equal(result.error?.code, code); }

function targetPage(t) {
  const fixture = page(t);
  const button = fixture.add('button', { id: 'button', text: 'Original target' });
  fixture.document.hitOverride = button;
  return { fixture, button };
}

test('pageExpression runs self-contained; snapshots have opaque refs without mutating page attributes', async (t) => {
  const { fixture, button } = targetPage(t);
  const attributes = [...button.attributes];
  const result = await fixture.run('snapshot', { snapshotId: 'generation-A', stateKey: '_scope_A' });
  assert.equal(result.ok, true);
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].text, 'Original target');
  assert.equal(result.elements[0].ref, '@generation-A:0');
  assert.deepEqual([...button.attributes], attributes, 'Snapshot must retain Node identity without injecting numeric attributes');
  assert.equal((await fixture.run('resolve', { selector: result.elements[0].ref, stateKey: '_scope_A', actionId: 'click-A' })).ok, true);
  errorCode(await fixture.run('resolve', { selector: '@0', stateKey: '_scope_A' }), 'STALE_REFERENCE');
  errorCode(await fixture.run('snapshot', {}), 'INVALID_ARGUMENT');
});

test('snapshot references reject reused selector, disconnected Node, changed fingerprint and navigation', async (t) => {
  const { fixture, button } = targetPage(t);
  const first = await fixture.run('snapshot', { snapshotId: 'first' });
  const reference = first.elements[0].ref;
  const replacement = fixture.add('button', { id: 'replacement', text: 'Original target' });
  replacement.remove();
  button.replaceWith(replacement);
  replacement.setAttribute('id', 'button');
  fixture.document.hitOverride = replacement;
  errorCode(await fixture.run('resolve', { selector: reference }), 'STALE_REFERENCE');
  assert.equal((await fixture.run('resolve', { selector: '#button' })).ok, true);
  const second = await fixture.run('snapshot', { snapshotId: 'second' });
  replacement.textContent = 'Changed operation';
  errorCode(await fixture.run('resolve', { selector: second.elements[0].ref }), 'STALE_REFERENCE');
  const third = await fixture.run('snapshot', { snapshotId: 'third' });
  fixture.location.href = 'http://127.0.0.1:9876/next';
  errorCode(await fixture.run('resolve', { selector: third.elements[0].ref }), 'STALE_REFERENCE');
  errorCode(await fixture.run('resolve', { selector: reference }), 'STALE_REFERENCE');
});

test('snapshot generations and per-scope state reject old and foreign references', async (t) => {
  const { fixture } = targetPage(t);
  const first = await fixture.run('snapshot', { snapshotId: 'first', stateKey: '_scope_A' });
  const second = await fixture.run('snapshot', { snapshotId: 'second', stateKey: '_scope_A' });
  await fixture.run('snapshot', { snapshotId: 'other', stateKey: '_scope_B' });
  errorCode(await fixture.run('resolve', { selector: first.elements[0].ref, stateKey: '_scope_A' }), 'STALE_REFERENCE');
  errorCode(await fixture.run('resolve', { selector: second.elements[0].ref, stateKey: '_scope_B' }), 'STALE_REFERENCE');
  assert.equal((await fixture.run('resolve', { selector: second.elements[0].ref, stateKey: '_scope_A' })).ok, true);
});

test('CSS targets must be unique and syntactically valid; no first-match fallback', async (t) => {
  const { fixture, button } = targetPage(t);
  button.setAttribute('class', 'duplicate');
  fixture.add('button', { id: 'duplicate', text: 'Different action', attrs: { class: 'duplicate' } });
  errorCode(await fixture.run('resolve', { selector: '.duplicate' }), 'AMBIGUOUS_SELECTOR');
  errorCode(await fixture.run('resolve', { selector: '#missing' }), 'ELEMENT_NOT_FOUND');
  errorCode(await fixture.run('resolve', { selector: '[' }), 'INVALID_SELECTOR');
  errorCode(await fixture.run('resolve', { selector: '' }), 'INVALID_ARGUMENT');
  errorCode(await fixture.run('resolve', { selector: 'x'.repeat(10001) }), 'INVALID_ARGUMENT');
});

test('resolve rejects disabled, inherited inert, invisible and obscured targets', async (t) => {
  const { fixture, button } = targetPage(t);
  button.disabled = true;
  errorCode(await fixture.run('resolve', { selector: '#button' }), 'ELEMENT_DISABLED');
  button.disabled = false;
  fixture.document.body.inert = true;
  errorCode(await fixture.run('resolve', { selector: '#button' }), 'ELEMENT_DISABLED');
  fixture.document.body.inert = false;
  fixture.document.body.setAttribute('aria-disabled', 'true');
  errorCode(await fixture.run('resolve', { selector: '#button' }), 'ELEMENT_DISABLED');
  fixture.document.body.removeAttribute('aria-disabled');
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }, { contentVisibility: 'hidden' }]) {
    const original = { ...button.style };
    Object.assign(button.style, style);
    errorCode(await fixture.run('resolve', { selector: '#button' }), 'ELEMENT_NOT_VISIBLE');
    button.style = original;
  }
  const cover = fixture.add('div', { id: 'cover', text: 'Blocking layer' });
  fixture.document.hitOverride = cover;
  errorCode(await fixture.run('resolve', { selector: '#button' }), 'ELEMENT_OBSCURED');
  const child = fixture.add('span', { text: 'Inside target' }, button);
  fixture.document.hitOverride = child;
  assert.equal((await fixture.run('resolve', { selector: '#button' })).ok, true, 'A descendant hit is still the intended target');
});

test('verify retains action Node identity and original hit point through dispatch', async (t) => {
  const { fixture, button } = targetPage(t);
  const resolved = await fixture.run('resolve', { selector: '#button', actionId: 'action-A' });
  assert.equal(resolved.ok, true);
  assert.equal(button.scrollCount, 1);
  assert.equal((await fixture.run('verify', { actionId: 'action-A', ...resolved.at })).ok, true);
  button.setAttribute('aria-label', 'Different semantics');
  errorCode(await fixture.run('verify', { actionId: 'action-A' }), 'STALE_REFERENCE');
  button.removeAttribute('aria-label');
  await fixture.run('resolve', { selector: '#button', actionId: 'move-A' });
  fixture.document.hitOverride = null;
  button.rect = { x: 400, y: 400, left: 400, top: 400, width: 100, height: 30, right: 500, bottom: 430 };
  errorCode(await fixture.run('verify', { actionId: 'move-A', x: resolved.at.x, y: resolved.at.y }), 'STALE_REFERENCE');
});

test('editable and focus guards reject readonly/non-text fields and check deep active element', async (t) => {
  const fixture = page(t);
  for (const [id, options, code] of [
    ['readonly', { readOnly: true }, 'ELEMENT_NOT_EDITABLE'],
    ['checkbox', { type: 'checkbox' }, 'ELEMENT_NOT_EDITABLE'],
    ['disabled', { disabled: true }, 'ELEMENT_DISABLED'],
  ]) {
    const input = fixture.add('input', { id, value: 'untouched', ...options });
    fixture.document.hitOverride = input;
    errorCode(await fixture.run('resolve', { selector: `#${id}`, editable: true }), code);
    assert.equal(input.value, 'untouched');
  }
  const field = fixture.add('input', { id: 'editable', value: 'initial' });
  fixture.document.hitOverride = field;
  assert.equal((await fixture.run('resolve', { selector: '#editable', editable: true, actionId: 'type-A' })).ok, true);
  errorCode(await fixture.run('focus', { actionId: 'type-A' }), 'FOCUS_CHANGED');
  const focused = await fixture.run('focus', { actionId: 'type-A', focus: true });
  assert.equal(focused.ok, true);
  assert.equal(focused.select_modifier, 2);
  assert.equal(field.focusCount, 1);
  fixture.context.navigator.platform = 'MacIntel';
  assert.equal((await fixture.run('focus', { actionId: 'type-A' })).select_modifier, 4);
  field.readOnly = true;
  errorCode(await fixture.run('verify', { actionId: 'type-A' }), 'ELEMENT_NOT_EDITABLE');
});

test('open shadow-root nodes appear in snapshots and retain focus/hit-test identity', async (t) => {
  const fixture = page(t);
  const host = fixture.add('div', { id: 'host' });
  const root = host.attachShadow();
  const shadow = fixture.add('input', { id: 'shadow-input', value: 'shadow text' }, root);
  const snapshot = await fixture.run('snapshot', { snapshotId: 'shadow' });
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0].text, 'shadow text');
  assert.equal((await fixture.run('resolve', { selector: snapshot.elements[0].ref, editable: true, actionId: 'shadow-type' })).ok, true);
  assert.equal((await fixture.run('focus', { actionId: 'shadow-type', focus: true })).ok, true);
  assert.equal(root.activeElement, shadow);
  assert.equal(fixture.document.activeElement, host);
});

test('password redaction covers live/default attributes, autocomplete fields, HTML and snapshots without changing DOM', async (t) => {
  const fixture = page(t);
  const password = fixture.add('input', { id: 'password', type: 'password', value: PASSWORD_SENTINEL });
  const liveSecret = 'fixture-live-password-28ab';
  password.value = liveSecret;
  const autofill = fixture.add('input', { id: 'new-password', value: 'fixture-autocomplete-secret', attrs: { autocomplete: 'new-password' } });
  const visible = fixture.add('p', { text: `An echo of ${liveSecret}` });
  assert.ok(visible.isConnected);
  const snapshot = await fixture.run('snapshot', { snapshotId: 'redaction' });
  assert.equal(snapshot.elements[0].value, '[REDACTED]');
  assert.equal(snapshot.elements[1].value, '[REDACTED]');
  for (const result of [snapshot, await fixture.run('read', { mode: 'html' }), await fixture.run('read', { mode: 'text' })]) {
    const output = JSON.stringify(result);
    for (const secret of [PASSWORD_SENTINEL, liveSecret, autofill.value]) assert.ok(!output.includes(secret), 'Sensitive field value leaked');
  }
  assert.equal(password.value, liveSecret);
  assert.equal(password.getAttribute('value'), PASSWORD_SENTINEL);
  assert.equal(autofill.value, 'fixture-autocomplete-secret');
});

test('structured reads and snapshots redact custom password editors and omit hidden HTML secrets', async (t) => {
  const p = page(t);
  const secret = 'private-editor-value';
  p.add('div', { id: 'editor', editable: true, attrs: { contenteditable: 'true', autocomplete: 'current-password' }, text: secret });
  p.add('input', { type: 'hidden', value: 'private-hidden-form-value' });
  p.add('script', { text: 'const token = "private-embedded-script-value"' });
  for (const [action, args] of [['snapshot', { snapshotId: 'snapshot-a' }], ['read', { mode: 'html' }]]) {
    const result = await p.run(action, args);
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /private-(?:editor|hidden|embedded)/);
  }
});

test('JavaScript returns object envelopes, safely serializes values, and redacts nested password material', async (t) => {
  const fixture = page(t);
  fixture.add('input', { id: 'password', type: 'password', value: PASSWORD_SENTINEL });
  assert.deepEqual(await fixture.run('js', { code: '1+1' }), { ok: true, value: 2 });
  assert.deepEqual(await fixture.run('js', { code: 'undefined' }), { ok: true, value: null });
  assert.deepEqual(await fixture.run('js', { code: '[false, null, 12n]' }), { ok: true, value: [false, null, '12'] });
  for (const code of [
    'document.querySelector("#password").value',
    '({nested: [document.querySelector("#password").value], password: "not-even-in-DOM"})',
    '({[document.querySelector("#password").value]: "value"})',
    'document.querySelector("#password")',
  ]) assert.ok(!JSON.stringify(await fixture.run('js', { code })).includes(PASSWORD_SENTINEL));
  const accessor = await fixture.run('js', { code: 'globalThis.getterCalls = 0; ({ get secret() { globalThis.getterCalls++; return "unsafe"; } })' });
  assert.equal(accessor.value.secret, '[Accessor]');
  assert.equal((await fixture.run('js', { code: 'globalThis.getterCalls' })).value, 0);
  const cycle = await fixture.run('js', { code: 'const cycle = {}; cycle.self = cycle; cycle' });
  assert.equal(cycle.value.self, '[Circular]');
  const exception = await fixture.run('js', { code: 'throw new Error(document.querySelector("#password").value)' });
  errorCode(exception, 'JS_ERROR');
  assert.ok(!JSON.stringify(exception).includes(PASSWORD_SENTINEL));
  errorCode(await fixture.run('js', { code: ' ' }), 'INVALID_ARGUMENT');
});

test('observation limits bound text and numeric collections, not just string leaves', async (t) => {
  const fixture = page(t);
  fixture.document.body.textContent = 'x'.repeat(5000);
  const read = await fixture.run('read', { maxChars: 1000 });
  assert.ok(read.body.length <= 1000);
  assert.equal(read.truncated, true);
  const numbers = await fixture.run('js', { code: 'Array.from({length: 1000}, (_, index) => index)', maxChars: 1000 });
  assert.ok(JSON.stringify(numbers).length <= 1300, 'Numeric/structural output bypassed the observation character budget');
  assert.equal(numbers.truncated, true);
});

test('snapshot bounds element count and excludes hidden/disconnected nodes', async (t) => {
  const fixture = page(t);
  for (let index = 0; index < 205; index++) fixture.add('button', { id: `button-${index}`, text: `Button ${index}` });
  const hidden = fixture.add('button', { id: 'hidden', text: 'Hidden', style: { display: 'none' } });
  hidden.remove();
  const result = await fixture.run('snapshot', { snapshotId: 'many' });
  assert.equal(result.elements.length, 200);
  assert.equal(result.elements[199].ref, '@many:199');
});

test('MutationObserver wait resolves explicit mutations and disconnects observer/timer on success', async (t) => {
  const fixture = page(t);
  const waiting = fixture.run('wait', { selector: '#inserted', timeoutMs: 500 });
  await Promise.resolve();
  assert.equal(fixture.observers.size, 1);
  fixture.add('button', { id: 'inserted', text: 'Inserted target' });
  const result = await waiting;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Inserted target');
  assert.equal(fixture.observers.size, 0);
  assert.equal(fixture.timers.size, 0);
});

test('wait requires visibility rather than merely finding a hidden DOM node', async (t) => {
  const fixture = page(t);
  fixture.add('button', { id: 'hidden-wait', text: 'Not yet visible', style: { display: 'none' } });
  errorCode(await fixture.run('wait', { selector: '#hidden-wait', timeoutMs: 15 }), 'TIMEOUT');
  assert.equal(fixture.observers.size, 0);
  assert.equal(fixture.timers.size, 0);
});

test('wait timeout, invalid CSS and ambiguity produce stable errors and release observers', async (t) => {
  const fixture = page(t);
  errorCode(await fixture.run('wait', { selector: '#never', timeoutMs: 15 }), 'TIMEOUT');
  assert.equal(fixture.observers.size, 0);
  assert.equal(fixture.timers.size, 0);
  errorCode(await fixture.run('wait', { selector: '[' }), 'INVALID_SELECTOR');
  fixture.add('button', { attrs: { class: 'duplicate' } });
  fixture.add('button', { attrs: { class: 'duplicate' } });
  errorCode(await fixture.run('wait', { selector: '.duplicate' }), 'AMBIGUOUS_SELECTOR');
});

test('overlay cleanup removes illustration and timers without leaking action state', async (t) => {
  const { fixture } = targetPage(t);
  await fixture.run('resolve', { selector: '#button', actionId: 'overlay-action' });
  const count = fixture.document.documentElement.children.length;
  assert.equal((await fixture.run('overlay', { x: 40, y: 40 })).ok, true);
  assert.equal(fixture.document.documentElement.children.length, count + 1);
  assert.equal(fixture.timers.size, 1);
  assert.equal((await fixture.run('cleanup')).ok, true);
  assert.equal(fixture.document.documentElement.children.length, count);
  assert.equal(fixture.timers.size, 0);
  errorCode(await fixture.run('verify', { actionId: 'overlay-action' }), 'STALE_REFERENCE');
});

test('password capture fails closed rather than leaking untracked oversized or overflow values', async (t) => {
  const oversized = page(t);
  const secret = 'fixture-oversized-password-'.repeat(5000);
  oversized.add('input', { id: 'password', type: 'password', value: secret });
  for (const [operation, args] of [['snapshot', {}], ['read', { mode: 'html' }], ['js', { code: 'document.querySelector("#password").value' }]]) {
    const result = await oversized.run(operation, args);
    errorCode(result, 'PAGE_ERROR'); assert.ok(!JSON.stringify(result).includes('fixture-oversized-password-'));
  }
  const overflow = page(t);
  for (let index = 0; index < 257; index++) overflow.add('input', { type: 'password', value: `fixture-overflow-password-${index}` });
  const result = await overflow.run('read', { mode: 'html' });
  errorCode(result, 'PAGE_ERROR'); assert.ok(!JSON.stringify(result).includes('fixture-overflow-password-'));
});

test('JavaScript array accessors are described, not invoked during safe serialization', async (t) => {
  const fixture = page(t);
  const result = await fixture.run('js', { code: '(() => { globalThis.arrayGetterCalls = 0; const value = []; Object.defineProperty(value, "0", { enumerable: true, get() { globalThis.arrayGetterCalls++; throw new Error("fixture-private-array-getter"); } }); return value; })()' });
  assert.equal(result.ok, true); assert.deepEqual(result.value, ['[Accessor]']);
  assert.equal(await fixture.evaluate('globalThis.arrayGetterCalls'), 0);
  assert.ok(!JSON.stringify(result).includes('fixture-private-array-getter'));
});

test('scroll groups axes and observes instant clamping without chaining from a boundary or zero-range container', async (t) => {
  const fixture = page(t);
  const root = fixture.document.scrollingElement; root.scrollHeight = 3000;
  const box = fixture.add('div', { id: 'scroll-box', style: { overflow: 'auto' } });
  box.scrollWidth = box.clientWidth + 50; box.scrollHeight = box.clientHeight + 100;
  const leaf = fixture.add('span', { id: 'leaf' }, box); fixture.document.hitOverride = leaf;
  const result = await fixture.run('scroll', { selector: '#scroll-box', deltaX: 12.5, deltaY: 200 });
  assert.equal(result.ok, true); assert.equal(result.moved_x, 12.5); assert.equal(result.moved_y, 100);
  assert.deepEqual(box.scrollWrites, [{ left: 12.5, top: 200, behavior: 'instant' }]);
  assert.equal(root.scrollWrites.length, 0); assert.equal(box.scrollCount, 0);
  const boundary = await fixture.run('scroll', { selector: '#leaf', deltaY: 10 });
  assert.equal(boundary.changed, false); assert.equal(boundary.moved_y, 0);
  box.scrollTop = 0; box.scrollHeight = box.clientHeight;
  assert.equal((await fixture.run('scroll', { deltaY: 10 })).changed, false);
  assert.equal(root.scrollWrites.length, 0, 'A zero-range nearest container does not fall through to its parent');
  assert.equal(fixture.timers.size, 0); assert.equal(fixture.observers.size, 0);
});

test('scroll ignores display:contents wrappers instead of treating them as zero-range scroll boxes', async (t) => {
  const fixture = page(t);
  const outer = fixture.add('div', { id: 'outer', style: { overflow: 'auto' } }); outer.scrollHeight += 200;
  const wrapper = fixture.add('div', { style: { display: 'contents', overflow: 'auto' } }, outer);
  const leaf = fixture.add('span', { id: 'leaf' }, wrapper); fixture.document.hitOverride = leaf;
  for (const display of ['contents', 'inline']) {
    outer.scrollTop = 0; wrapper.style.display = display; wrapper.clientWidth = 0; wrapper.clientHeight = 0;
    const result = await fixture.run('scroll', { selector: '#leaf', deltaY: 25 });
    assert.equal(result.moved_y, 25); assert.equal(outer.scrollTop, 25); assert.equal(wrapper.scrollWrites.length, 0);
  }
});

test('scroll chooses containers per axis and preserves signed native offsets', async (t) => {
  const fixture = page(t);
  const horizontal = fixture.add('div', { id: 'horizontal', style: { overflowX: 'auto' } });
  horizontal.scrollWidth += 100;
  const vertical = fixture.add('div', { id: 'vertical', style: { overflowX: 'hidden', overflowY: 'scroll' } }, horizontal);
  vertical.scrollHeight += 100;
  const leaf = fixture.add('span', { id: 'leaf' }, vertical); fixture.document.hitOverride = leaf;
  const result = await fixture.run('scroll', { selector: '#leaf', deltaX: 25, deltaY: 40 });
  assert.equal(result.scrollers.length, 2); assert.equal(horizontal.scrollLeft, 25); assert.equal(vertical.scrollTop, 40);
  horizontal.scrollLeft = -7;
  horizontal.scrollBy = function (options) { this.scrollWrites.push({ ...options }); this.scrollLeft += options.left; };
  const rtl = await fixture.run('scroll', { selector: '#leaf', deltaX: -12.5, deltaY: 0 });
  assert.equal(rtl.moved_x, -12.5); assert.equal(rtl.scrollers[0].after.x, -19.5);
  const zero = await fixture.run('scroll', { selector: '#leaf', deltaX: 0, deltaY: 0 });
  assert.equal(zero.changed, false); assert.deepEqual(zero.scrollers, []);
  // Chrome computes a visible axis to auto when its paired axis is scroll/auto.
  vertical.style.overflowX = 'auto'; horizontal.scrollLeft = 0;
  const outerWrites = horizontal.scrollWrites.length;
  const stoppedX = await fixture.run('scroll', { selector: '#leaf', deltaX: 25, deltaY: 0 });
  assert.equal(stoppedX.moved_x, 0); assert.equal(horizontal.scrollLeft, 0);
  assert.equal(horizontal.scrollWrites.length, outerWrites, 'A computed auto axis with zero range stops chaining');
});

test('scroll respects viewport overflow propagation, CSS locks and quirks scrollingElement', async (t) => {
  for (const [kind, expected] of [['standards', 20], ['body-hidden', 0], ['root-clip', 0], ['quirks', 20]]) {
    const { fixture } = targetPage(t);
    if (kind === 'quirks') fixture.document.scrollingElement = fixture.document.body;
    const root = fixture.document.scrollingElement; root.scrollHeight = root.clientHeight + 100;
    if (kind === 'body-hidden') fixture.document.body.style.overflowY = 'hidden';
    if (kind === 'root-clip') root.style.overflowY = 'clip';
    const result = await fixture.run('scroll', { deltaY: 20 });
    assert.equal(result.ok, true, kind); assert.equal(result.moved_y, expected, kind); assert.equal(root.scrollTop, expected, kind);
    assert.equal(fixture.document.body.scrollWrites.length, kind === 'quirks' ? 1 : 0);
  }
  const { fixture } = targetPage(t); fixture.document.scrollingElement = null;
  errorCode(await fixture.run('scroll', {}), 'PAGE_ERROR');
});

test('scroll follows open-shadow and assigned-slot ancestry but never accesses embedded documents', async (t) => {
  const fixture = page(t);
  const host = fixture.add('div', { id: 'host' }); const shadow = host.attachShadow();
  const box = fixture.add('div', { id: 'shadow-box', style: { overflowY: 'auto' } }, shadow); box.scrollHeight += 200;
  const slot = fixture.add('slot', {}, box);
  const leaf = fixture.add('span', { id: 'slotted' }, host); leaf.assignedSlot = slot;
  fixture.document.hitOverride = host; shadow.elementFromPoint = () => leaf;
  const result = await fixture.run('scroll', { x: 40, y: 30, deltaY: 55 });
  assert.equal(result.moved_y, 55); assert.equal(box.scrollTop, 55);
  const selected = await fixture.run('scroll', { selector: '#shadow-box', deltaY: 10 });
  assert.equal(selected.ok, true); assert.equal(box.scrollTop, 65); assert.equal(box.scrollCount, 0);
  for (const tag of ['iframe', 'frame', 'object', 'embed']) {
    const frame = fixture.add(tag, { id: `embedded-${tag}` });
    let reads = 0; Object.defineProperty(frame, 'contentDocument', { get() { reads++; throw new Error('must not read a child document'); } });
    fixture.document.hitOverride = frame;
    errorCode(await fixture.run('scroll', { x: 40, y: 30 }), 'UNSUPPORTED_TARGET'); assert.equal(reads, 0);
  }
});

test('scroll rejects bad targeting and stale or unsafe selectors before any scrolling', async (t) => {
  const { fixture, button } = targetPage(t);
  const root = fixture.document.scrollingElement; root.scrollHeight += 500;
  for (const args of [{ x: 1 }, { y: 1 }, { selector: '#button', x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1024, y: 1 }, { deltaY: Infinity }, { deltaX: 100001 }]) {
    errorCode(await fixture.run('scroll', args), 'INVALID_ARGUMENT');
  }
  const ref = (await fixture.run('snapshot', { snapshotId: 'scroll-ref' })).elements[0].ref;
  button.textContent = 'changed'; errorCode(await fixture.run('scroll', { selector: ref }), 'STALE_REFERENCE');
  button.disabled = true; errorCode(await fixture.run('scroll', { selector: '#button' }), 'ELEMENT_DISABLED'); button.disabled = false;
  button.style.display = 'none'; errorCode(await fixture.run('scroll', { selector: '#button' }), 'ELEMENT_NOT_VISIBLE'); button.style.display = 'block';
  button.rect = { x: 0, y: 900, left: 0, top: 900, right: 100, bottom: 950, width: 100, height: 50 };
  errorCode(await fixture.run('scroll', { selector: '#button' }), 'ELEMENT_NOT_VISIBLE');
  assert.equal(root.scrollWrites.length, 0); assert.equal(button.scrollCount, 0, 'No preparatory scrollIntoView, even for offscreen selectors');
});

test('wait reacts to a style mutation making an existing node visible and releases observer state', async (t) => {
  const fixture = page(t);
  const element = fixture.add('button', { id: 'becomes-visible', text: 'Now visible', style: { display: 'none' } });
  const waiting = fixture.run('wait', { selector: '#becomes-visible', timeoutMs: 1000 });
  element.style.display = 'block'; element.setAttribute('style', 'display:block');
  const result = await waiting;
  assert.equal(result.ok, true); assert.equal(fixture.observers.size, 0); assert.equal(fixture.timers.size, 0);
});
