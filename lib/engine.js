/** Scoped, in-process browser engine. No browser spawning, OS input, or implicit CDP fallback. */
import { readFile, writeFile, mkdir, rename, unlink, realpath, open, link } from 'node:fs/promises';
import { dirname, basename, resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRedactor, pageExpression } from './page-functions.js';

const ACTIONS = new Set(['status', 'tabs', 'open', 'read', 'snapshot', 'js', 'click', 'type', 'wait', 'shot', 'close', 'navigate', 'press', 'scroll']);
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_SHOT_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ERROR_MESSAGES = {
  INVALID_ARGUMENT: 'The browser arguments are invalid.',
  ACCESS_DENIED: 'The current browser grant does not allow this operation.',
  ORIGIN_DENIED: 'This site is outside the current browser grant.',
  PAUSED: 'Browser control is paused. Resume it in the mbrowser extension.',
  REVOKED: 'Browser authorization was revoked. Pair the extension again before continuing.',
  NOT_PAIRED: 'Pair the mbrowser extension before controlling browser tabs.',
  DISCONNECTED: 'The browser connection is unavailable. Reconnect, inspect the current state, and try again.',
  TIMEOUT: 'The browser operation timed out. It may already have executed; inspect before retrying.',
  ABORTED: 'The browser operation was cancelled. It may already have executed; inspect before retrying.',
  BROWSER_CHANGED: 'The browser session changed. Previous tab ownership and references have been invalidated.',
  TAB_NOT_FOUND: 'The tab is closed, unavailable, or outside the current browser grant.',
  TAB_IN_USE: 'This tab is selected in Chrome. Switch to another tab before using mbrowser on it.',
  BACKGROUND_ONLY: 'This action could open another window or a browser dialog. For a link, open the destination in a new mbrowser background tab.',
  NOT_OWNED: 'Only tabs created by mbrowser in this same scope and browser session can be closed.',
  NO_CURRENT_TAB: 'This scope has no current tab. Open a tab or provide an authorized tab_id.',
  STALE_REFERENCE: 'The snapshot reference or target is stale. Take a new snapshot and use its exact ref.',
  AMBIGUOUS_SELECTOR: 'The selector matches more than one element. Use an exact snapshot ref or a unique selector.',
  INVALID_SELECTOR: 'The CSS selector is invalid.',
  ELEMENT_NOT_FOUND: 'No element matches the selector.',
  ELEMENT_DISABLED: 'The element is disabled or inert.',
  ELEMENT_NOT_VISIBLE: 'The element is not visible in the viewport.',
  ELEMENT_OBSCURED: 'Another element obscures the target.',
  ELEMENT_NOT_EDITABLE: 'The element is not an editable text field.',
  ELEMENT_NOT_FOCUSABLE: 'The element cannot receive keyboard input.',
  UNSUPPORTED_TARGET: 'Select a control in the main document, outside embedded frames.',
  FOCUS_CHANGED: 'Keyboard focus changed away from the intended element.',
  JS_ERROR: 'JavaScript evaluation failed. Exception text is omitted to protect sensitive page data.',
  JS_EVALUATION_FAILED: 'JavaScript evaluation failed. Exception text is omitted to protect sensitive page data.',
  PAGE_ERROR: 'The page document changed or its operation failed. Take a new observation before acting.',
  CDP_CONTEXT_GONE: 'The page execution context changed. Take a new observation before acting.',
  CONTEXT_LOST: 'The page execution context changed. Take a new observation before acting.',
  CDP_ERROR: 'Chrome rejected the browser operation. No raw page or protocol error was returned.',
  CDP_UNAVAILABLE: 'Legacy CDP is unavailable. Connect the extension, or explicitly configure legacy remote debugging.',
  DEBUGGER_BUSY: 'Another debugger is attached to this tab. Release it before trying again.',
  DEBUGGER_DETACHED: 'The tab debugger was detached. Reconnect before continuing.',
  CHROME_OPERATION_FAILED: 'Chrome could not complete the operation. Inspect before retrying.',
  PROTOCOL_ERROR: 'The browser transport returned an invalid protocol response.',
  STATE_UNAVAILABLE: 'Browser scope state could not be read or saved safely.',
  INVALID_PATH: 'Screenshot output must be a new .png file inside the trusted workspace root.',
  FILE_EXISTS: 'The screenshot destination already exists. Choose a new .png path.',
  SCREENSHOT_TOO_LARGE: 'The screenshot exceeds the 32 MiB decoded size limit.',
  INVALID_SCREENSHOT: 'Chrome did not return a valid bounded PNG screenshot.',
  BROWSER_ERROR: 'The browser operation failed. No sensitive diagnostic data was returned.',
};

export class BrowserError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] || ERROR_MESSAGES.BROWSER_ERROR) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}
const error = (code, message) => new BrowserError(code, message);
const safeError = (value) => {
  if (value instanceof BrowserError) return value;
  const aliases = { TAB_NOT_OWNED: 'NOT_OWNED', ORIGIN_NOT_ALLOWED: 'ORIGIN_DENIED', PERMISSION_DENIED: 'ACCESS_DENIED', EXTENSION_DISCONNECTED: 'DISCONNECTED', EXTENSION_PAUSED: 'PAUSED', PAIR_REQUIRED: 'NOT_PAIRED' };
  const candidate = typeof value?.code === 'string' ? value.code : '';
  const code = Object.hasOwn(ERROR_MESSAGES, candidate) ? candidate : (Object.hasOwn(aliases, candidate) ? aliases[candidate] : 'BROWSER_ERROR');
  return error(code);
};
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u0020\u007f]/.test(id);
const maxChars = (args) => {
  if (args.max_chars === undefined) return 30000;
  if (!Number.isInteger(args.max_chars) || args.max_chars < 1000 || args.max_chars > 100000) throw error('INVALID_ARGUMENT', 'max_chars must be an integer between 1000 and 100000.');
  return args.max_chars;
};
const timeoutMs = (value, fallback = 15000, max = 120000) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw error('INVALID_ARGUMENT', `timeout_ms must be an integer between 1 and ${max}.`);
  return value;
};
const webUrl = (value) => {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) throw error('INVALID_ARGUMENT', 'An absolute http(s) URL without credentials is required.');
  let url;
  try { url = new URL(value); } catch { throw error('INVALID_ARGUMENT', 'An absolute http(s) URL without credentials is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw error('ACCESS_DENIED', 'Only regular http(s) pages without URL credentials are allowed.');
  return url;
};
const selectorArg = (args) => {
  if (typeof args.selector !== 'string' || !args.selector || args.selector.length > 10000) throw error('INVALID_ARGUMENT', 'A CSS selector or exact snapshot reference is required.');
  return args.selector;
};
const within = (root, target) => {
  const path = relative(root, target);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/**
 * Transport shape is documented in ARCHITECTURE.md. workspaceRoot is trusted host
 * configuration, never a model-controlled action argument. State persistence is opt-in.
 */
export class BrowserEngine {
  static get revision() { return '2.0.0-background-scroll-1'; }

  constructor({ transport, statePath, stateStore, allowExistingTabs = false, overlay = true, workspaceRoot } = {}) {
    if (!transport || !['status', 'listTabs', 'createTab', 'closeTab', 'send', 'dispose'].every((method) => typeof transport[method] === 'function')) {
      throw error('INVALID_ARGUMENT', 'A browser transport implementing the engine contract is required.');
    }
    if (statePath && stateStore) throw error('INVALID_ARGUMENT', 'statePath and stateStore are mutually exclusive.');
    if (stateStore && (typeof stateStore.load !== 'function' || typeof stateStore.save !== 'function')) throw error('INVALID_ARGUMENT', 'stateStore must implement load() and save(value).');
    this.transport = transport;
    this.statePath = statePath ? resolve(statePath) : null;
    this.stateStore = stateStore || null;
    this.allowExistingTabs = allowExistingTabs === true;
    this.overlay = overlay !== false;
    this.workspaceRoot = workspaceRoot;
    this._browserId = null;
    this._namespace = randomBytes(16).toString('hex');
    this._scopes = new Map();
    this._epochs = new Map();
    this._worlds = new Map();
    this._scopeQueues = new Map();
    this._tabQueues = new Map();
    this._touchedTabs = new Set();
    this._secrets = new Map();
    this._loadPromise = null;
    this._savePromise = Promise.resolve();
    this._disposed = false;
    this._disposeController = new AbortController();
  }

  _scope(scope) {
    let state = this._scopes.get(scope);
    if (!state) {
      state = { current: null, tabs: new Map() };
      this._scopes.set(scope, state);
    }
    return state;
  }

  async _loadState() {
    if (!this._loadPromise) this._loadPromise = (async () => {
      if (!this.statePath && !this.stateStore) return;
      let text;
      try {
        text = this.stateStore ? JSON.stringify(await this.stateStore.load()) : await readFile(this.statePath, 'utf8');
      } catch (cause) { if (!this.stateStore && cause.code === 'ENOENT') return; throw error('STATE_UNAVAILABLE'); }
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return; // never adopt oversized/legacy/unrecognizable state
      let data;
      try { data = JSON.parse(text); } catch { return; }
      if (data?.version !== 2 || typeof data.browserId !== 'string' || !data.browserId || data.browserId.length > 2048
        || !/^[a-f0-9]{32}$/.test(data.namespace) || !Array.isArray(data.scopes) || data.scopes.length > 1000) return;
      const scopes = new Map();
      for (const record of data.scopes) {
        if (typeof record?.scope !== 'string' || !record.scope || record.scope.length > 1024 || !Array.isArray(record.tabs) || record.tabs.length > 1000) continue;
        const tabs = new Map();
        for (const tab of record.tabs) {
          if (!validId(tab?.id) || typeof tab.url !== 'string' || tab.url.length > 16384 || typeof tab.createdAt !== 'string') continue;
          let origin;
          try { origin = webUrl(tab.url).origin; } catch { continue; }
          tabs.set(tab.id, { url: origin, createdAt: tab.createdAt });
        }
        scopes.set(record.scope, { current: validId(record.current) && tabs.has(record.current) ? record.current : null, tabs });
      }
      this._browserId = data.browserId;
      this._namespace = data.namespace;
      this._scopes = scopes;
      if (Array.isArray(data.epochs)) for (const record of data.epochs.slice(0, 1000)) {
        if (!Array.isArray(record) || record.length !== 2) continue;
        const [id, epoch] = record;
        if (validId(id) && Number.isSafeInteger(epoch) && epoch >= 0) this._epochs.set(id, epoch);
      }
    })();
    return this._loadPromise;
  }

  _saveState() {
    if (!this.statePath && !this.stateStore) return Promise.resolve();
    const save = async () => {
      const scopes = [...this._scopes].map(([scope, state]) => ({
        scope, current: state.current, tabs: [...state.tabs].map(([id, value]) => ({ id, ...value })),
      }));
      const text = JSON.stringify({ version: 2, browserId: this._browserId, namespace: this._namespace, scopes, epochs: [...this._epochs] });
      if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) throw error('STATE_UNAVAILABLE');
      if (this.stateStore) {
        try { await this.stateStore.save(JSON.parse(text)); } catch { throw error('STATE_UNAVAILABLE'); }
        return;
      }
      const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await mkdir(dirname(this.statePath), { recursive: true });
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.statePath);
      } catch { throw error('STATE_UNAVAILABLE'); }
      finally { try { await unlink(temporary); } catch { /* renamed or never created */ } }
    };
    this._savePromise = this._savePromise.catch(() => {}).then(save);
    return this._savePromise;
  }

  _syncIdentity(id) {
    if (typeof id !== 'string' || !id) return false;
    if (this._browserId === id) return false;
    this._browserId = id;
    this._namespace = randomBytes(16).toString('hex');
    this._scopes.clear();
    this._epochs.clear();
    this._worlds.clear();
    this._touchedTabs.clear();
    this._secrets.clear();
    return true;
  }

  _check(request) {
    if (request.signal.aborted) throw error(request.timedOut ? 'TIMEOUT' : 'ABORTED');
    if (this._disposed) throw error('DISCONNECTED');
    if (request.browserId && this.transport.browserId && request.browserId !== this.transport.browserId) {
      this._syncIdentity(this.transport.browserId);
      void this._saveState().catch(() => {});
      throw error('BROWSER_CHANGED');
    }
    if (Date.now() >= request.deadline) throw error('TIMEOUT');
  }

  _await(promise, request) {
    try { this._check(request); } catch (cause) { Promise.resolve(promise).catch(() => {}); return Promise.reject(cause); }
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const end = (ok, value) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        (ok ? resolvePromise : reject)(value);
      };
      const onAbort = () => end(false, error(request.timedOut ? 'TIMEOUT' : 'ABORTED'));
      request.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then((value) => {
        try { this._check(request); end(true, value); } catch (cause) { end(false, cause); }
      }, (cause) => end(false, safeError(cause)));
    });
  }

  _queue(map, key, run, request) {
    const previous = map.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => { this._check(request); return run(); });
    map.set(key, task);
    const clear = () => { if (map.get(key) === task) map.delete(key); };
    task.then(clear, clear);
    return this._await(task, request);
  }

  _options(request) {
    this._check(request);
    return { signal: request.signal, timeoutMs: Math.max(1, request.deadline - Date.now()) };
  }

  async _transport(method, args, request) {
    this._check(request);
    try { return await this._await(this.transport[method](...args, this._options(request)), request); }
    catch (cause) { throw safeError(cause); }
  }

  _permissions() {
    let permissions;
    try { permissions = this.transport.permissions; } catch { throw error('ACCESS_DENIED'); }
    if (permissions == null) return null;
    if (permissions.enabled !== true) throw error('PAUSED');
    if (!Array.isArray(permissions.allowedOrigins)) throw error('ACCESS_DENIED');
    return permissions;
  }

  _allowExisting() {
    const permissions = this._permissions();
    return permissions ? permissions.allowExistingTabs === true : this.allowExistingTabs;
  }

  _authorizeUrl(value) {
    const url = webUrl(value);
    const permissions = this._permissions();
    if (permissions && !permissions.allowedOrigins.includes('*') && !permissions.allowedOrigins.includes(url.origin)) throw error('ORIGIN_DENIED');
    return url.href;
  }

  _owned(scope, id, tab) {
    return this._scope(scope).tabs.has(id) && tab?.owned !== false;
  }

  _mayAccess(scope, tab) {
    return this._owned(scope, tab.id, tab) ||
      (this._allowExisting() && !(this.transport.kind === 'extension' && tab.owned === true));
  }

  _forget(id) {
    let changed = false;
    for (const state of this._scopes.values()) {
      if (state.tabs.delete(id)) changed = true;
      if (state.current === id) { state.current = null; changed = true; }
    }
    for (const [key, world] of this._worlds) if (world.tabId === id) this._worlds.delete(key);
    this._epochs.delete(id);
    this._touchedTabs.delete(id);
    return changed;
  }

  _prune(tabs) {
    let changed = false;
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    for (const state of this._scopes.values()) for (const id of [...state.tabs.keys()]) {
      // Extension listings deliberately omit tabs outside the grant. Absence is not proof of closure.
      if (byId.get(id)?.owned === false || (this.transport.kind === 'cdp' && !byId.has(id))) changed = this._forget(id) || changed;
    }
    return changed;
  }

  _tab(args, scope, tabs, { closing = false } = {}) {
    const id = args.tab_id ?? this._scope(scope).current;
    if (!id) throw error('NO_CURRENT_TAB');
    if (!validId(id)) throw error('INVALID_ARGUMENT', 'tab_id must be a valid browser tab identifier.');
    const tab = tabs.find((item) => item.id === id);
    const owned = this._owned(scope, id, tab);
    if (closing) {
      if (!owned) throw error('NOT_OWNED');
      // Closing an exact owned record is safe even if a later forbidden navigation hides it from listTabs.
      return tab || { id, url: this._scope(scope).tabs.get(id).url, owned: true };
    }
    if (!tab) throw error('TAB_NOT_FOUND');
    if (!this._mayAccess(scope, tab)) throw error('ACCESS_DENIED');
    this._authorizeUrl(tab.url);
    return tab;
  }

  async _send(tab, method, params, request) {
    this._check(request);
    this._permissions(); // live grant: pause/revoke between two commands must stop the next command
    if (!this._mayAccess(request.scope, tab)) throw error('ACCESS_DENIED');
    this._authorizeUrl(tab.url);
    const result = await this._transport('send', [tab.id, method, params], request);
    this._touchedTabs.add(tab.id);
    return result;
  }

  _worldKey(tabId, scope) { return `${tabId}\u0000${scope}`; }

  async _world(tab, request, force = false) {
    const key = this._worldKey(tab.id, request.scope);
    const { frameTree } = await this._send(tab, 'Page.getFrameTree', {}, request);
    const frame = frameTree?.frame;
    if (!frame || typeof frame.id !== 'string') throw error('PAGE_ERROR');
    this._authorizeUrl(frame.url);
    tab.url = frame.url;
    const epoch = this._epochs.get(tab.id) || 0;
    let world = this._worlds.get(key);
    if (!force && world && world.frameId === frame.id && world.loaderId === frame.loaderId && world.epoch === epoch) return world;
    await this._send(tab, 'Page.enable', {}, request);
    const scopeHash = createHash('sha256').update(request.scope).digest('hex').slice(0, 24);
    const suffix = `${this._namespace}_${scopeHash}_${epoch}`;
    const { executionContextId } = await this._send(tab, 'Page.createIsolatedWorld', {
      frameId: frame.id, worldName: `mbrowser_${suffix}`, grantUniveralAccess: false,
    }, request);
    if (!Number.isSafeInteger(executionContextId) || executionContextId <= 0) throw error('PAGE_ERROR');
    world = { tabId: tab.id, frameId: frame.id, loaderId: frame.loaderId, epoch, contextId: executionContextId, stateKey: `__mbrowser_${suffix}` };
    this._worlds.set(key, world);
    return world;
  }

  async _page(tab, operation, args, request) {
    const isReference = typeof args.selector === 'string' && args.selector.startsWith('@');
    const safeToRetry = ['read', 'snapshot', 'wait', 'viewport', 'overlay', 'resolve'].includes(operation) && !isReference;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const world = await this._world(tab, request, attempt > 0);
        const remaining = Math.min(120000, Math.max(1, request.deadline - Date.now() - 10));
        const response = await this._send(tab, 'Runtime.evaluate', {
          expression: pageExpression(operation, {
            ...args, stateKey: world.stateKey, maxChars: request.maxChars,
            inputOrigins: this.transport.kind === 'extension' ? this._permissions()?.allowedOrigins : undefined,
          }),
          contextId: world.contextId, awaitPromise: true, returnByValue: true, userGesture: false, timeout: remaining,
        }, request);
        if (response.exceptionDetails) throw error('JS_ERROR');
        const value = response.result?.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('PAGE_ERROR');
        if (value.ok === false || value.error) {
          const code = value.error?.code;
          throw error(typeof code === 'string' && ERROR_MESSAGES[code] ? code : 'PAGE_ERROR');
        }
        return value;
      } catch (cause) {
        const failure = safeError(cause);
        const contextLost = ['CDP_CONTEXT_GONE', 'CONTEXT_LOST'].includes(failure.code);
        if (contextLost) this._worlds.delete(this._worldKey(tab.id, request.scope));
        if (contextLost && isReference) throw error('STALE_REFERENCE');
        if (!contextLost || !safeToRetry || attempt > 0) throw failure;
      }
    }
    throw error('PAGE_ERROR');
  }

  async _overlay(tab, at, request) {
    if (!this.overlay) return;
    try {
      if (typeof this.transport.markCursor === 'function') {
        const viewport = await this._page(tab, 'viewport', {}, request);
        if (viewport.width > 0 && viewport.height > 0) {
          const position = { x: at.x / viewport.width, y: at.y / viewport.height };
          await this._transport('markCursor', [tab.id, position], request);
        }
      } else {
        await this._page(tab, 'overlay', { x: at.x, y: at.y }, request);
      }
    }
    catch { /* optional illustration never makes the action fail */ }
  }

  async _resolveAction(tab, args, request, editable = false) {
    const actionId = randomBytes(16).toString('hex');
    const result = await this._page(tab, 'resolve', { selector: selectorArg(args), actionId, editable }, request);
    return { actionId, ...result };
  }

  async _verify(tab, target, request, focus = false) {
    return this._page(tab, focus ? 'focus' : 'verify', { actionId: target.actionId, x: target.at.x, y: target.at.y }, request);
  }

  async _mouseClick(tab, target, request) {
    await this._overlay(tab, target.at, request);
    await this._verify(tab, target, request);
    const at = { x: target.at.x, y: target.at.y };
    await this._send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 }, request);
    // Recheck after hover: hover handlers may replace/move/disable the element.
    await this._verify(tab, target, request);
    let pressed = false;
    try {
      // Once a dispatch is attempted, a lost/aborted acknowledgement cannot prove it did not execute.
      pressed = true;
      await this._send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }, request);
    } finally {
      if (pressed) {
        // A cancellation after mousedown must not leave a held button. No click replay is attempted.
        if (!request.signal.aborted) await this._send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, request);
        else if (!this.transport.browserId || this.transport.browserId === request.browserId) {
          try { await this.transport.send(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, { timeoutMs: 1000 }); } catch { /* transport may already be paused/disconnected */ }
        }
      }
    }
  }

  async _key(tab, spec, request) {
    let down = false;
    try {
      down = true;
      await this._send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, request);
    } finally {
      if (down) {
        const { commands, text, unmodifiedText, ...up } = spec;
        if (!request.signal.aborted) await this._send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up }, request);
        else if (!this.transport.browserId || this.transport.browserId === request.browserId) {
          try { await this.transport.send(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up }, { timeoutMs: 1000 }); } catch { /* release only, never replay */ }
        }
      }
    }
  }

  _scrub(value, limit, scope) {
    const redact = createRedactor(this._secrets.get(scope) || []);
    let budget = limit - 64;
    let truncated = false;
    const OMIT = Symbol('omit');
    const seen = new WeakSet();
    const spend = (count) => {
      if (count > budget) { truncated = true; return false; }
      budget -= count;
      return true;
    };
    const text = (value) => {
      const full = redact(value, limit + 1);
      if (spend(JSON.stringify(full).length)) return full;
      if (budget < 2) return OMIT;
      let low = 0;
      let high = Math.min(full.length, budget - 2);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify(full.slice(0, middle)).length <= budget) low = middle;
        else high = middle - 1;
      }
      const result = full.slice(0, low);
      spend(JSON.stringify(result).length);
      return result;
    };
    const walk = (item, depth = 0) => {
      if (item == null) return spend(4) ? null : OMIT;
      if (typeof item === 'boolean') return spend(item ? 4 : 5) ? item : OMIT;
      if (typeof item === 'number') return spend(Number.isFinite(item) ? String(item).length : 4) ? (Number.isFinite(item) ? item : null) : OMIT;
      if (typeof item === 'string') return text(item);
      if (depth > 15 || budget < 2) { truncated = true; return OMIT; }
      if (typeof item !== 'object') return spend(4) ? null : OMIT;
      if (seen.has(item)) return text('[Circular]');
      seen.add(item);
      if (!spend(2)) return OMIT;
      if (Array.isArray(item)) {
        const out = [];
        for (const entry of item.slice(0, 1000)) {
          if (out.length && !spend(1)) break;
          const clean = walk(entry, depth + 1);
          if (clean === OMIT) break;
          out.push(clean);
        }
        if (item.length > out.length) truncated = true;
        return out;
      }
      const out = {};
      let count = 0;
      for (const [key, entry] of Object.entries(item)) {
        if (++count > 1000 || budget < 8) { truncated = true; break; }
        if (count > 1 && !spend(1)) break;
        const safeKey = text(key.slice(0, 200));
        if (safeKey === OMIT || !spend(1)) break;
        const clean = walk(/^(?:password|passwd|pairingCode|pairingToken|authorization|credentials)$/i.test(key) ? '[REDACTED]' : entry, depth + 1);
        if (clean === OMIT) break;
        Object.defineProperty(out, safeKey, { value: clean, enumerable: true, configurable: true });
      }
      return out;
    };
    const result = walk(value);
    if (truncated && result && result !== OMIT && typeof result === 'object' && !Array.isArray(result)) {
      // Copied fields are non-writable; safely replace a marker supplied by the page.
      Object.defineProperty(result, 'truncated', { value: true, enumerable: true, configurable: true });
    }
    return result === OMIT ? { ok: true, truncated: true } : result;
  }

  async _screenshot(tab, args, request) {
    const rootOption = request.workspaceRoot || this.workspaceRoot;
    if (typeof rootOption !== 'string' || !rootOption) throw error('INVALID_PATH', 'Screenshot capture requires a trusted workspaceRoot from the host.');
    if (typeof args.path !== 'string' || !isAbsolute(args.path) || extname(args.path).toLowerCase() !== '.png') throw error('INVALID_PATH');
    let root;
    let parent;
    try { root = await realpath(resolve(rootOption)); parent = await realpath(dirname(resolve(args.path))); }
    catch { throw error('INVALID_PATH'); }
    const destination = resolve(parent, basename(args.path));
    if (!within(root, destination)) throw error('INVALID_PATH');
    this._check(request);
    const { data } = await this._send(tab, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, request);
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_SHOT_BYTES / 3) * 4 + 4) throw error('SCREENSHOT_TOO_LARGE');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw error('INVALID_SCREENSHOT');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_SHOT_BYTES) throw error('SCREENSHOT_TOO_LARGE');
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw error('INVALID_SCREENSHOT');
    const temporary = resolve(parent, `.mbrowser-shot-${randomUUID()}.tmp`);
    let handle;
    try {
      this._check(request);
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      this._check(request);
      // link is an exclusive atomic publication: unlike rename it cannot overwrite an existing path.
      await link(temporary, destination);
    } catch (cause) {
      if (cause instanceof BrowserError) throw cause;
      if (cause.code === 'EEXIST') throw error('FILE_EXISTS');
      throw error('INVALID_PATH');
    } finally {
      try { await handle?.close(); } catch { /* already closed */ }
      try { await unlink(temporary); } catch { /* never created/already removed */ }
    }
    return { ok: true, tab_id: tab.id, path: destination, bytes: bytes.length };
  }

  async _run(action, args, request) {
    await this._await(this._loadState(), request);
    // Probe identity before reading persisted ownership. Extension status is local/safe, not a browser command.
    const status = await this._transport('status', [], request);
    const id = this.transport.browserId || status?.browserId || status?.browser_id;
    const changed = this._syncIdentity(id);
    if (changed) await this._await(this._saveState(), request);
    request.browserId = id || null;
    if (action === 'status') {
      const permissions = this.transport.permissions;
      return { ok: true, transport: this.transport.kind, connected: status?.connected !== false && !!id,
        ...(typeof status?.paired === 'boolean' ? { paired: status.paired } : {}),
        ...(typeof status?.browser === 'string' ? { browser: status.browser } : {}),
        ...(Number.isInteger(status?.port) ? { port: status.port } : {}),
        browser_id: id || null, enabled: permissions ? permissions.enabled === true : status?.connected !== false,
        allow_existing_tabs: permissions ? permissions.allowExistingTabs === true : this.allowExistingTabs,
        our_tabs: this._scope(request.scope).tabs.size, current: this._scope(request.scope).current, state_persisted: !!(this.statePath || this.stateStore) };
    }
    if (status?.connected === false || !id) throw error('DISCONNECTED');
    this._permissions();
    const rawTabs = await this._transport('listTabs', [], request);
    if (!Array.isArray(rawTabs)) throw error('PROTOCOL_ERROR');
    const tabs = rawTabs.filter((tab) => validId(tab?.id) && typeof tab.url === 'string').map((tab) => ({ ...tab }));
    if (this._prune(tabs)) await this._await(this._saveState(), request);

    if (action === 'tabs') return { ok: true, tabs: tabs.filter((tab) => {
      if (!this._mayAccess(request.scope, tab)) return false;
      try { this._authorizeUrl(tab.url); return true; } catch { return false; }
    }).map((tab) => ({
      id: tab.id, title: String(tab.title || '').slice(0, 1000), url: tab.url.slice(0, 16384),
      ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
      owned: this._owned(request.scope, tab.id, tab), ours: this._owned(request.scope, tab.id, tab),
    })) };

    if (action === 'open') {
      const url = this._authorizeUrl(args.url);
      if (args.visible !== undefined && typeof args.visible !== 'boolean') throw error('INVALID_ARGUMENT', 'visible must be a boolean.');
      // Observe an exact successful result even if a transport ignores cancellation, without replay/adoption.
      // The extension normally cancels and cleans up its exact newly-created tab itself.
      const creation = Promise.resolve().then(() => {
        this._check(request);
        return this.transport.createTab({ url, visible: args.visible === true }, this._options(request));
      }).then(async (tab) => {
        if (!validId(tab?.id)) throw error('PROTOCOL_ERROR');
        if (!this._disposed && this._browserId === request.browserId && (!this.transport.browserId || this.transport.browserId === request.browserId)) {
          const state = this._scope(request.scope);
          state.tabs.set(tab.id, { url: new URL(url).origin, createdAt: new Date().toISOString() });
          if (!request.signal.aborted) state.current = tab.id;
          await this._saveState();
        }
        return tab;
      });
      const tab = await this._await(creation, request);
      return { ok: true, tab_id: tab.id, targetId: tab.id, url: typeof tab.url === 'string' ? tab.url : url,
        title: typeof tab.title === 'string' ? tab.title : '', visible: args.visible === true, background: args.visible !== true };
    }

    const tab = this._tab(args, request.scope, tabs, { closing: action === 'close' });
    return this._queue(this._tabQueues, `${id}\u0000${tab.id}`, async () => {
      this._check(request);
      this._permissions();
      let emulatedFocus = false;
      try {
        if (action === 'close') {
          if (!this._owned(request.scope, tab.id, tab)) throw error('NOT_OWNED');
          await this._transport('closeTab', [tab.id], request);
          this._forget(tab.id);
          await this._await(this._saveState(), request);
          return { ok: true, closed: tab.id, tab_id: tab.id };
        }
        if (!this._mayAccess(request.scope, tab)) throw error('ACCESS_DENIED');
        this._authorizeUrl(tab.url);
        if (action === 'type' && (typeof args.text !== 'string' || args.text.length > 100000)) {
          throw error('INVALID_ARGUMENT', 'text must be a string of at most 100000 characters.');
        }
        if (['click', 'type', 'press'].includes(action)) {
          // Renderer focus emulation is not tab/window activation and never moves the OS pointer.
          // Background pages otherwise defer compositor input ACKs and may not focus native editors.
          emulatedFocus = true;
          await this._send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true }, request);
        }
        if (action === 'read') return { ...(await this._page(tab, 'read', { mode: args.mode || 'text' }, request)), tab_id: tab.id };
        if (action === 'snapshot') return { ...(await this._page(tab, 'snapshot', { snapshotId: randomBytes(16).toString('hex') }, request)), tab_id: tab.id };
        if (action === 'js') {
          if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > 262144) throw error('INVALID_ARGUMENT', 'JavaScript code must be a nonempty string of at most 262144 characters.');
          return { ...(await this._page(tab, 'js', { code: args.code }, request)), tab_id: tab.id };
        }
        if (action === 'wait') return { ...(await this._page(tab, 'wait', { selector: selectorArg(args), timeoutMs: timeoutMs(args.timeout_ms) }, request)), tab_id: tab.id };
        if (action === 'shot') return this._screenshot(tab, args, request);
        if (action === 'navigate') {
          const url = this._authorizeUrl(args.url);
          this._epochs.set(tab.id, (this._epochs.get(tab.id) || 0) + 1);
          for (const [key, world] of this._worlds) if (world.tabId === tab.id) this._worlds.delete(key);
          await this._await(this._saveState(), request);
          const navigation = await this._send(tab, 'Page.navigate', { url }, request);
          if (navigation.errorText) throw error('PAGE_ERROR');
          return { ok: true, tab_id: tab.id, url, loading: true };
        }
        if (action === 'click') {
          const target = await this._resolveAction(tab, args, request);
          await this._mouseClick(tab, target, request);
          return { ok: true, tab_id: tab.id, tag: target.tag, text: target.text, at: target.at };
        }
        if (action === 'type') {
          const target = await this._resolveAction(tab, args, request, true);
          if (target.sensitive && args.text) {
            const secrets = this._secrets.get(request.scope) || new Set();
            if (!secrets.has(args.text)) {
              const count = [...this._secrets.values()].reduce((total, values) => total + values.size, 0);
              if (count >= 256) throw error('PAGE_ERROR');
              secrets.add(args.text);
              this._secrets.set(request.scope, secrets);
            }
          }
          await this._mouseClick(tab, target, request);
          const focus = await this._verify(tab, target, request, true);
          await this._key(tab, { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: focus.select_modifier || 2, commands: ['selectAll'] }, request);
          await this._verify(tab, target, request, true);
          await this._key(tab, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, modifiers: 0, commands: ['deleteBackward'] }, request);
          if (args.text) {
            await this._verify(tab, target, request, true);
            await this._send(tab, 'Input.insertText', { text: args.text }, request);
          }
          return { ok: true, tab_id: tab.id, tag: target.tag, characters: args.text.length, sensitive: target.sensitive === true, at: target.at };
        }
        if (action === 'press') {
          const spec = parseKey(args.key);
          if (args.selector !== undefined) {
            const target = await this._resolveAction(tab, args, request);
            await this._overlay(tab, target.at, request);
            await this._page(tab, 'focus', { actionId: target.actionId, focus: true }, request);
          }
          await this._page(tab, 'keyboardTarget', { key: spec.key, modifiers: spec.modifiers }, request);
          await this._key(tab, spec, request);
          return { ok: true, tab_id: tab.id, key: spec.key, modifiers: spec.modifiers };
        }
        if (action === 'scroll') {
          const dx = args.delta_x === undefined ? 0 : args.delta_x, dy = args.delta_y === undefined ? 600 : args.delta_y;
          const hasX = args.x !== undefined, hasY = args.y !== undefined;
          if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 100000 || Math.abs(dy) > 100000
            || hasX !== hasY || (hasX && (!Number.isFinite(args.x) || !Number.isFinite(args.y)))
            || (args.selector !== undefined && (hasX || hasY))) throw error('INVALID_ARGUMENT');
          // One primary, non-retryable CSSOM operation; no queued wheel, focus emulation, or scrollIntoView.
          const result = await this._page(tab, 'scroll', {
            ...(args.selector !== undefined ? { selector: selectorArg(args) } : { x: args.x, y: args.y }),
            deltaX: dx, deltaY: dy,
          }, request);
          if (result.at) await this._overlay(tab, result.at, request);
          return { ...result, tab_id: tab.id };
        }
        throw error('INVALID_ARGUMENT');
      } catch (cause) {
        if (cause?.code === 'TAB_NOT_FOUND') {
          this._forget(tab.id);
          await this._saveState();
        }
        throw cause;
      } finally {
        // Restore real renderer focus even after cancellation/lost ACK; never cross browser lifetimes.
        if (emulatedFocus && this._browserId === request.browserId && this.transport.browserId === request.browserId) {
          try { await this.transport.send(tab.id, 'Emulation.setFocusEmulationEnabled', { enabled: false }, { timeoutMs: 1000 }); }
          catch { /* best-effort release only; no activation, browser reconnect adoption, or input replay */ }
        }
      }
    }, request);
  }

  async execute(action, args = {}, { scope = 'default', signal, workspaceRoot } = {}) {
    if (this._disposed) throw error('DISCONNECTED');
    if (!ACTIONS.has(action) || !args || typeof args !== 'object' || Array.isArray(args)) throw error('INVALID_ARGUMENT');
    if (typeof scope !== 'string' || !scope || scope.length > 1024) throw error('INVALID_ARGUMENT', 'A nonempty scope string of at most 1024 characters is required.');
    if (signal && typeof signal.addEventListener !== 'function') throw error('INVALID_ARGUMENT');
    const timeout = action === 'wait' ? timeoutMs(args.timeout_ms) + 10000 : 30000;
    const deadlineController = new AbortController();
    const request = { scope, deadline: Date.now() + timeout, maxChars: maxChars(args), workspaceRoot, timedOut: false, browserId: null };
    request.signal = AbortSignal.any([this._disposeController.signal, deadlineController.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => { request.timedOut = true; deadlineController.abort(); }, timeout);
    try {
      const result = await this._queue(this._scopeQueues, scope, () => this._run(action, args, request), request);
      return this._scrub(result, request.maxChars, request.scope);
    } catch (cause) { throw safeError(cause); }
    finally { clearTimeout(timer); }
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disposeController.abort();
    // No page creation or closing on cleanup, and no new world/attachment just to remove an illustration.
    const detached = [...this._touchedTabs].map(async (id) => {
      try { await this.transport.detach?.(id, { timeoutMs: 1000 }); } catch { /* paused/disconnected */ }
    });
    let timer;
    try { await Promise.race([Promise.allSettled(detached), new Promise((resolvePromise) => { timer = setTimeout(resolvePromise, 1200); })]); }
    finally { clearTimeout(timer); }
    try { await this._savePromise; } catch { /* previous operation already reported persistence failure */ }
    await this.transport.dispose();
    this._worlds.clear();
    this._touchedTabs.clear();
    this._secrets.clear();
  }
}

function parseKey(input) {
  if (typeof input !== 'string' || !input || input.length > 100) throw error('INVALID_ARGUMENT', 'key must name one key, optionally prefixed with Control+, Meta+, Alt+, or Shift+.');
  const pieces = input.split('+');
  let key = pieces.pop();
  let modifiers = 0;
  for (const modifier of pieces) {
    const bit = { control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, alt: 1, shift: 8 }[modifier.toLowerCase()];
    if (!bit || (modifiers & bit)) throw error('INVALID_ARGUMENT', 'The key combination is invalid.');
    modifiers |= bit;
  }
  const aliases = { Return: 'Enter', Esc: 'Escape', Space: ' ', Spacebar: ' ', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
  key = aliases[key] || key;
  const known = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32],
  };
  let code;
  let virtualKey;
  if (known[key]) [code, virtualKey] = known[key];
  else if (/^[a-zA-Z]$/.test(key)) { code = `Key${key.toUpperCase()}`; virtualKey = key.toUpperCase().charCodeAt(0); }
  else if (/^[0-9]$/.test(key)) { code = `Digit${key}`; virtualKey = key.charCodeAt(0); }
  else if (/^F(?:[1-9]|1[0-2])$/.test(key)) { code = key; virtualKey = 111 + Number(key.slice(1)); }
  else if ([...key].length === 1 && !/[\u0000-\u001f\u007f]/.test(key)) { code = ''; virtualKey = 0; }
  else throw error('INVALID_ARGUMENT', 'The key name is unsupported.');
  const result = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers };
  if (!(modifiers & (1 | 2 | 4))) {
    if (key === 'Enter') { result.text = '\r'; result.unmodifiedText = '\r'; }
    else if ([...key].length === 1) { result.text = modifiers & 8 ? key.toUpperCase() : key; result.unmodifiedText = key; }
  }
  return result;
}
