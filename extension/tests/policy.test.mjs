import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import {
  bridgeUrl, normalizePort, normalizeAllowedOrigins,
  normalizePairCode, normalizeWebUrl, isAllowedUrl, parseTabId, validToken,
  validateCdp, safeError,
} from '../policy.js';

const rejects = (fn, code) => assert.throws(fn, error => error.code === code);

test('manifest has the pinned ID and the minimal, isolated MV3 surface', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['debugger', 'tabs', 'storage', 'alarms', 'sidePanel']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['http://127.0.0.1/mbrowser/connect'], js: ['connect.js'], run_at: 'document_start', all_frames: false,
  }]);
  for (const key of ['externally_connectable', 'web_accessible_resources', 'optional_permissions']) {
    assert.equal(manifest[key], undefined);
  }
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...digest].map(n => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(n, 16))).join('');
  assert.equal(id, 'fjgcljkoolmpniiomfmdjkplelohggna');
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-eval|unsafe-inline|https:/);
  assert.equal(manifest.action.default_popup, undefined);
  const paths = [manifest.background.service_worker, manifest.options_ui.page, manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons)];
  await Promise.all(paths.map(path => access(new URL(`../${path}`, import.meta.url))));
});

test('bridge endpoint is constructed only from numeric safe ports and fixed paths', () => {
  assert.equal(normalizePort('43127'), 43127);
  assert.equal(bridgeUrl(43127, '/pair'), 'http://127.0.0.1:43127/pair');
  assert.equal(bridgeUrl(43127, '/extension', true), 'ws://127.0.0.1:43127/extension');
  for (const value of ['http://evil.test', '127.0.0.1:43127', '43127/a', ' 43127', '043127', 80, 0, 65536, 6000, 6667, NaN, {}, null]) {
    rejects(() => normalizePort(value), 'INVALID_PORT');
  }
  rejects(() => bridgeUrl(43127, '/health'), 'INVALID_ENDPOINT');
  rejects(() => bridgeUrl(43127, '/extension?token=secret', true), 'INVALID_ENDPOINT');
  rejects(() => bridgeUrl(43127, '/pair', true), 'INVALID_ENDPOINT');
});

test('origins are exact canonical http(s) origins, or a separately approved wildcard', () => {
  assert.deepEqual(normalizeAllowedOrigins(['https://EXAMPLE.com/', 'https://example.com:443', 'http://example.com:8080']), ['https://example.com', 'http://example.com:8080']);
  assert.deepEqual(normalizeAllowedOrigins(['*']), ['*']);
  rejects(() => normalizeAllowedOrigins(['*'], { allowWildcard: false }), 'INVALID_ORIGINS');
  assert.equal(isAllowedUrl('https://example.com/a?q=1#h', ['https://example.com']), true);
  assert.equal(isAllowedUrl('https://sub.example.com/a', ['https://example.com']), false);
  assert.equal(isAllowedUrl('http://example.com/', ['https://example.com']), false);
  assert.equal(isAllowedUrl('chrome://settings/', ['*']), false);
  assert.equal(isAllowedUrl('https://user:password@example.com/', ['*']), false);
  assert.deepEqual(normalizeAllowedOrigins([]), []);
  assert.equal(isAllowedUrl('https://example.com/', []), false);
  for (const value of [['*', 'https://example.com'], ['https://*.example.com'], ['https://example.com/path'], ['https://example.com/.'], ['https:example.com'], ['https://example.com?q=1'], ['https://example.com?'], ['https://example.com/#x'], ['https://example.com/#'], ['https://@example.com'], ['https://user:pass@example.com'], ['file:///tmp'], ['null'], [' https://example.com']]) {
    rejects(() => normalizeAllowedOrigins(value), 'INVALID_ORIGINS');
  }
});

test('pairing uses a bounded one-time code', () => {
  assert.equal(normalizePairCode('abcd-1234-abcd-5678-abcd-1234-abcd-5678'), 'ABCD1234ABCD5678ABCD1234ABCD5678');
  for (const code of ['', 'ABCD', 'ABCD1234ABCD5678?token=x', 'abcd 1234 abcd 5678']) rejects(() => normalizePairCode(code), 'INVALID_PAIR_CODE');
  assert.equal(validToken('a'.repeat(64)), true);
  for (const token of ['short', 'x\n'.repeat(32), 'secret?token=abc', 123]) assert.equal(validToken(token), false);
});

test('tab IDs and URLs do not accept alternate transports or privileged pages', () => {
  assert.equal(parseTabId('ext:123'), 123);
  for (const id of ['123', 'ext:0', 'ext:-1', 'ext:01', 'ext:9999999999', 'target-1', 1]) rejects(() => parseTabId(id), 'INVALID_TAB_ID');
  assert.equal(normalizeWebUrl('https://example.com'), 'https://example.com/');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///x', 'chrome://settings', 'https://a:b@example.com', 'https://example.com/\nsecret']) rejects(() => normalizeWebUrl(url), 'INVALID_URL');
});

test('CDP allowlist denies escape hatches, default contexts and unexpected params', () => {
  for (const method of ['Target.createTarget', 'Target.attachToTarget', 'Browser.close', 'Browser.setPermission', 'Network.getAllCookies', 'Network.enable', 'Fetch.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.callFunctionOn', 'Runtime.terminateExecution']) {
    rejects(() => validateCdp(method, {}), 'CDP_METHOD_DENIED');
  }
  validateCdp('Page.enable', {});
  validateCdp('Page.getFrameTree', {});
  validateCdp('Page.createIsolatedWorld', { frameId: 'main', worldName: 'mbrowser', grantUniveralAccess: false });
  rejects(() => validateCdp('Page.createIsolatedWorld', { frameId: 'main', worldName: 'mbrowser', grantUniveralAccess: true }), 'INVALID_ARGUMENT');
  const evaluation = { expression: 'document.title', contextId: 7, awaitPromise: true, returnByValue: true, userGesture: false, timeout: 1000 };
  validateCdp('Runtime.evaluate', evaluation);
  const { contextId, ...withoutContext } = evaluation;
  rejects(() => validateCdp('Runtime.evaluate', withoutContext), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Runtime.evaluate', { ...evaluation, includeCommandLineAPI: true }), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Runtime.evaluate', { ...evaluation, userGesture: true }), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }), 'CDP_METHOD_DENIED');
  rejects(() => validateCdp('Page.navigate', { url: 'https://example.com', frameId: 'subframe' }), 'INVALID_ARGUMENT');
});

test('background focus emulation permits only an exact boolean, never activation or broader emulation', () => {
  validateCdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  validateCdp('Emulation.setFocusEmulationEnabled', { enabled: false });
  for (const params of [{}, { enabled: 1 }, { enabled: 'true' }, { enabled: null }, { enabled: true, targetId: 'foreign' }, { enabled: false, activate: true }]) {
    rejects(() => validateCdp('Emulation.setFocusEmulationEnabled', params), 'INVALID_ARGUMENT');
  }
  for (const method of ['Page.bringToFront', 'Emulation.setDeviceMetricsOverride', 'Emulation.setScriptExecutionDisabled']) {
    rejects(() => validateCdp(method, {}), 'CDP_METHOD_DENIED');
  }
});

test('trusted input includes Enter/printable keyDown but cannot invoke arbitrary editor commands', () => {
  validateCdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 200, button: 'left', buttons: 1, clickCount: 1 });
  validateCdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -400 });
  validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a', unmodifiedText: 'a' });
  validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2, commands: ['selectAll'] });
  validateCdp('Input.insertText', { text: 'contraseña que nunca se registra' });
  rejects(() => validateCdp('Input.dispatchKeyEvent', { type: 'keyUp', text: 'a' }), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\0' }), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', text: 'secret-too-long' }), 'INVALID_ARGUMENT');
  rejects(() => validateCdp('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['openDocument'] }), 'INVALID_ARGUMENT');
});

test('Chrome diagnostics never echo passwords, script source or token-shaped strings', () => {
  const secret = 'MY_PASSWORD_SHOULD_NOT_APPEAR';
  assert.equal(safeError(new Error(`Input.insertText failed: ${secret}`)).code, 'CHROME_OPERATION_FAILED');
  assert.equal(safeError(new Error(`Cannot find context: ${secret}`)).code, 'CDP_CONTEXT_GONE');
  assert.equal(safeError(new Error(`Another debugger is already attached: ${secret}`)).code, 'DEBUGGER_BUSY');
  for (const input of [new Error(secret), new Error(`No tab ${secret}`), new Error(`execution context destroyed ${secret}`)]) {
    assert.equal(JSON.stringify(safeError(input)).includes(secret), false);
  }
});
