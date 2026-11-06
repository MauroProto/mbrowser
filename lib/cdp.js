/** Explicit legacy-CDP transport. Uses the Node 24 native WebSocket, never a child process. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT = 15000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const PAGE_METHODS = new Set([
  'Page.enable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.navigate', 'Page.captureScreenshot',
  'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Emulation.setFocusEmulationEnabled',
]);
export const CDP_PAGE_METHODS = Object.freeze([...PAGE_METHODS]);

export class CDPError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CDPError';
    this.code = code;
  }
}

const aborted = () => new CDPError('ABORTED', 'The browser request was cancelled. It may already have executed; inspect before retrying.');
const timeout = () => new CDPError('TIMEOUT', 'The browser request timed out. It may already have executed; inspect before retrying.');
const boundedTimeout = (value, fallback = DEFAULT_TIMEOUT) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.min(180000, Math.max(1, Number(value))) : fallback;

function raceDeadline(promise, { signal, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let settled = false;
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => end(reject, aborted());
    const timer = setTimeout(() => end(reject, timeout()), boundedTimeout(timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => end(resolve, value), (error) => end(reject, error));
  });
}

function protocolError(method, error) {
  // Classify, but never forward Chrome's raw error text/data: those can echo evaluated code or secrets.
  const message = typeof error?.message === 'string' ? error.message : '';
  let code = 'CDP_ERROR';
  let safeMessage = 'Chrome rejected the debugger request.';
  if (/cannot find context|execution context.*(?:destroy|not found)|context.*(?:not found|does not exist)|uniqueContextId/i.test(message)) {
    code = 'CDP_CONTEXT_GONE';
    safeMessage = 'The page execution context changed.';
  } else if (/no (?:target|session)|target (?:closed|not found)|session (?:closed|not found)|not attached/i.test(message)) {
    code = 'TAB_NOT_FOUND';
    safeMessage = 'The tab or debugger session no longer exists.';
  }
  const result = new CDPError(code, safeMessage);
  if (typeof error?.code === 'number') result.protocolCode = error.code;
  return result;
}

/** Persistent, multiplexed, flattened-CDP connection with independent request deadlines. */
export class CDPConnection {
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = DEFAULT_TIMEOUT, connectTimeoutMs = 10000, autoReconnect = true } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new CDPError('UNSUPPORTED_RUNTIME', 'Node 24 or newer with native WebSocket is required.');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = boundedTimeout(timeoutMs);
    this.connectTimeoutMs = boundedTimeout(connectTimeoutMs, 10000);
    this.autoReconnect = autoReconnect !== false;
    this._opened = false;
    this.ws = null;
    this._nextId = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._connecting = null;
    this._rejectConnect = null;
    this._connectTimer = null;
    this._disposed = false;
  }

  get connected() { return !this._disposed && this.ws?.readyState === 1; }
  get pendingCount() { return this._pending.size; }

  on(method, listener) {
    if (typeof listener !== 'function') throw new TypeError('An event listener is required.');
    let listeners = this._listeners.get(method);
    if (!listeners) this._listeners.set(method, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this._listeners.delete(method);
    };
  }

  _emit(method, params, sessionId) {
    for (const listener of this._listeners.get(method) || []) {
      try { listener(params, sessionId); } catch { /* a consumer must not break protocol handling */ }
    }
  }

  _disconnect(error, socket = this.ws) {
    if (socket !== this.ws) return;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    const rejectConnect = this._rejectConnect;
    this._rejectConnect = null;
    this._connecting = null;
    rejectConnect?.(error);
    for (const record of [...this._pending.values()]) record.finish(false, error);
    this._emit('disconnect', { code: error.code || 'DISCONNECTED' });
  }

  async _message(data, socket) {
    if (socket !== this.ws || this._disposed) return;
    try {
      let text;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength).toString('utf8');
      else if (typeof data?.text === 'function') text = await data.text();
      else throw new Error('Invalid frame');
      if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) throw new Error('Oversized frame');
      const message = JSON.parse(text);
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
      if (Number.isSafeInteger(message.id)) {
        const record = this._pending.get(message.id);
        if (!record) return;
        record.finish(!message.error, message.error ? protocolError(record.method, message.error) : (message.result || {}));
      } else if (typeof message.method === 'string') {
        this._emit(message.method, message.params || {}, message.sessionId);
      }
    } catch {
      this._disconnect(new CDPError('PROTOCOL_ERROR', 'Chrome sent an invalid or oversized protocol message.'), socket);
      try { socket.close(1002, 'Protocol error'); } catch { /* already closed */ }
    }
  }

  async connect(options = {}) {
    if (this._disposed) throw new CDPError('DISCONNECTED', 'The CDP connection is disposed.');
    if (options.signal?.aborted) throw aborted();
    if (this.connected) return;
    if (this._opened && !this.autoReconnect) throw new CDPError('DISCONNECTED', 'The pinned debugger connection is no longer open.');
    if (!this._connecting) {
      let socket;
      try { socket = new this.WebSocketImpl(this.url); }
      catch { throw new CDPError('DISCONNECTED', 'Could not open the local Chrome debugger connection.'); }
      this.ws = socket;
      try { socket.binaryType = 'arraybuffer'; } catch { /* optional in test transports */ }
      let resolveConnect;
      const connecting = new Promise((resolve, reject) => { resolveConnect = resolve; this._rejectConnect = reject; });
      this._connecting = connecting;
      // Install message/disconnect handlers before the connection becomes ready.
      socket.addEventListener('message', (event) => { void this._message(event.data, socket); });
      socket.addEventListener('close', () => this._disconnect(new CDPError('DISCONNECTED', 'Chrome disconnected from the browser engine.'), socket));
      socket.addEventListener('error', () => {
        this._disconnect(new CDPError('DISCONNECTED', 'The local Chrome debugger connection failed.'), socket);
        try { socket.close(); } catch { /* already closed */ }
      });
      socket.addEventListener('open', () => {
        if (socket !== this.ws || this._disposed) return;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
        this._connecting = null;
        this._rejectConnect = null;
        this._opened = true;
        resolveConnect();
      }, { once: true });
      this._connectTimer = setTimeout(() => {
        this._disconnect(timeout(), socket);
        try { socket.close(); } catch { /* still connecting */ }
      }, this.connectTimeoutMs);
      // Keep a rejection handler even if every caller is independently cancelled.
      connecting.catch(() => {});
      return raceDeadline(connecting, { signal: options.signal, timeoutMs: options.timeoutMs || this.connectTimeoutMs });
    }
    return raceDeadline(this._connecting, { signal: options.signal, timeoutMs: options.timeoutMs || this.connectTimeoutMs });
  }

  async send(method, params = {}, { sessionId, signal, timeoutMs = this.timeoutMs } = {}) {
    if (typeof method !== 'string' || !method) throw new CDPError('INVALID_ARGUMENT', 'A CDP method is required.');
    const budget = boundedTimeout(timeoutMs, this.timeoutMs);
    const started = Date.now();
    await this.connect({ signal, timeoutMs: budget });
    if (signal?.aborted) throw aborted();
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) throw timeout();
    const socket = this.ws;
    if (!this.connected) throw new CDPError('DISCONNECTED', 'Chrome is not connected.');
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const onAbort = () => finish(false, aborted());
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this._pending.delete(id);
        (ok ? resolve : reject)(value);
      };
      this._pending.set(id, { method, sessionId, finish });
      timer = setTimeout(() => finish(false, timeout()), remaining);
      signal?.addEventListener('abort', onAbort, { once: true });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try { socket.send(JSON.stringify(message)); }
      catch { finish(false, new CDPError('DISCONNECTED', 'Could not send the browser request.')); }
    });
  }

  rejectSession(sessionId) {
    for (const record of [...this._pending.values()]) {
      if (record.sessionId === sessionId) record.finish(false, new CDPError('TAB_NOT_FOUND', 'The tab debugger session was detached.'));
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._disconnect(new CDPError('DISCONNECTED', 'The browser connection was disposed.'));
    try { this.ws?.close(1000, 'Disposed'); } catch { /* already closed */ }
    this._listeners.clear();
  }

  close() { this.dispose(); }
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CDPError('INVALID_ARGUMENT', 'The local Chrome debugger port is invalid.');
  return port;
}
function localUrl(value, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new CDPError('INVALID_ARGUMENT', 'The local Chrome debugger endpoint is invalid.'); }
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new CDPError('INVALID_ARGUMENT', 'Legacy CDP endpoints must be loopback URLs without credentials or query strings.');
  }
  return url;
}
function siteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CDPError('INVALID_ARGUMENT', 'An absolute http(s) URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new CDPError('ACCESS_DENIED', 'Only regular http(s) pages without URL credentials are allowed.');
  return url.href;
}

/**
 * Transport contract implementation for explicitly requested legacy CDP use.
 * Tab/scope ownership is enforced by BrowserEngine; no raw method is exposed as a tool.
 */
export class CDPTransport {
  constructor({ endpoint, port, userDataDir, timeoutMs = DEFAULT_TIMEOUT, connectTimeoutMs = 10000,
    WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch } = {}) {
    this.kind = 'cdp';
    this._browserId = null;
    this._identityScope = null;
    this.endpoint = endpoint || process.env.MBROWSER_ENDPOINT;
    this.port = port ?? process.env.MBROWSER_PORT;
    this.userDataDir = userDataDir || process.env.MBROWSER_CHROME_UD
      || join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
    this.timeoutMs = boundedTimeout(timeoutMs);
    this.connectTimeoutMs = boundedTimeout(connectTimeoutMs, 10000);
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this._connection = null;
    this._connecting = null;
    this._sessions = new Map();
    this._sessionPromises = new Map();
    this._disposed = false;
    this._port = null;
  }

  get browserId() { return this._browserId; }
  get identityScope() { return this._identityScope; }

  async _endpoint() {
    let base;
    if (this.endpoint) {
      const parsed = localUrl(this.endpoint, ['ws:', 'wss:', 'http:', 'https:']);
      if (['ws:', 'wss:'].includes(parsed.protocol)) {
        if (!/^\/devtools\/browser(?:\/[^/]+)?$/.test(parsed.pathname)) throw new CDPError('INVALID_ARGUMENT', 'A browser-session WebSocket endpoint is required.');
        return parsed.href;
      }
      base = `${parsed.origin}/json/version`;
    } else if (this.port !== undefined && this.port !== '') {
      base = `http://127.0.0.1:${validatePort(this.port)}/json/version`;
    } else {
      let contents;
      try { contents = await readFile(join(this.userDataDir, 'DevToolsActivePort'), 'utf8'); }
      catch { throw new CDPError('CDP_UNAVAILABLE', 'Legacy remote debugging is unavailable. Use the paired extension, or explicitly enable Chrome remote debugging before using this CLI.'); }
      const [portLine, path] = contents.trim().split(/\r?\n/);
      const port = validatePort(portLine);
      if (path && /^\/devtools\/browser(?:\/[^/?#\s]+)?$/.test(path)) return `ws://127.0.0.1:${port}${path}`;
      base = `http://127.0.0.1:${port}/json/version`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    try {
      const response = await this.fetchImpl(base, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok) {
        // Some explicitly opted-in Chrome remote-debugging builds expose only this root WebSocket.
        // Restrict compatibility discovery to an exact 404 and the same loopback origin; never retry actions.
        if (response.status === 404 && (this.endpoint || (this.port !== undefined && this.port !== ''))) {
          const root = localUrl(base, ['http:', 'https:']);
          root.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
          root.pathname = '/devtools/browser';
          return root.href;
        }
        throw new CDPError('CDP_UNAVAILABLE', 'The local Chrome debugger endpoint is unavailable.');
      }
      const value = await response.json();
      const ws = localUrl(value.webSocketDebuggerUrl, ['ws:', 'wss:']);
      if (!/^\/devtools\/browser(?:\/[^/]+)?$/.test(ws.pathname)) throw new CDPError('PROTOCOL_ERROR', 'Chrome did not provide a browser-session debugger endpoint.');
      return ws.href;
    } catch (error) {
      if (error instanceof CDPError) throw error;
      if (controller.signal.aborted) throw timeout();
      throw new CDPError('CDP_UNAVAILABLE', 'Could not discover the local Chrome debugger connection.');
    } finally { clearTimeout(timer); }
  }

  async _ensureConnection(options = {}) {
    if (this._disposed) throw new CDPError('DISCONNECTED', 'The legacy CDP transport is disposed.');
    if (options.signal?.aborted) throw aborted();
    if (this._connection?.connected) return this._connection;
    if (!this._connecting) {
      const connecting = (async () => {
        const endpoint = await this._endpoint();
        if (this._disposed) throw new CDPError('DISCONNECTED', 'The legacy CDP transport is disposed.');
        const connection = new CDPConnection(endpoint, {
          WebSocketImpl: this.WebSocketImpl, timeoutMs: this.timeoutMs, connectTimeoutMs: this.connectTimeoutMs, autoReconnect: false,
        });
        this._connection = connection;
        this._sessions.clear();
        this._sessionPromises.clear();
        connection.on('disconnect', () => {
          if (this._connection !== connection) return;
          this._connection = null;
          this._sessions.clear();
          this._sessionPromises.clear();
          // A transport operation must not reconnect inside an already-pinned connection.send().
          // A later explicit operation may establish a new connection and rotate its identity first.
          connection.dispose();
        });
        connection.on('Target.detachedFromTarget', ({ sessionId }) => {
          for (const [id, session] of this._sessions) if (session === sessionId) this._sessions.delete(id);
          connection.rejectSession(sessionId);
        });
        connection.on('Target.targetDestroyed', ({ targetId }) => {
          const session = this._sessions.get(targetId);
          if (session) connection.rejectSession(session);
          this._sessions.delete(targetId);
        });
        try { await connection.connect(); }
        catch (error) { connection.dispose(); throw error; }
        const url = new URL(endpoint);
        this._identityScope = url.pathname === '/devtools/browser' ? 'connection' : 'browser';
        // Root endpoints expose no lifetime identity. Never carry ownership over reconnects/processes.
        this._browserId = this._identityScope === 'connection'
          ? `cdp:connection:${url.host}:${randomUUID()}` : `cdp:${url.host}${url.pathname}`;
        this._port = Number(url.port) || (url.protocol === 'wss:' ? 443 : 80);
        return connection;
      })();
      this._connecting = connecting;
      connecting.then(() => { if (this._connecting === connecting) this._connecting = null; }, () => { if (this._connecting === connecting) this._connecting = null; });
    }
    return raceDeadline(this._connecting, { signal: options.signal, timeoutMs: options.timeoutMs || this.connectTimeoutMs + 1000 });
  }

  _budget(options = {}) {
    const deadline = Date.now() + boundedTimeout(options.timeoutMs, this.timeoutMs);
    return () => {
      if (options.signal?.aborted) throw aborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeout();
      return { signal: options.signal, timeoutMs: remaining };
    };
  }

  async status(options = {}) {
    const budget = this._budget(options);
    const connection = await this._ensureConnection(budget());
    const version = await connection.send('Browser.getVersion', {}, budget());
    return { connected: true, kind: this.kind, browserId: this.browserId, identity_scope: this._identityScope, browser: version.product || 'Chrome', protocolVersion: version.protocolVersion, port: this._port };
  }

  async listTabs(options = {}) {
    const budget = this._budget(options);
    const connection = await this._ensureConnection(budget());
    const { targetInfos = [] } = await connection.send('Target.getTargets', {}, budget());
    return targetInfos.filter((tab) => tab.type === 'page').map((tab) => ({ id: tab.targetId, title: tab.title || '', url: tab.url || '' }));
  }

  async _committedPage(connection, sessionId, options, dispatch, requestedUrl) {
    const budget = this._budget(options);
    let started = !dispatch;
    let dispatched = !dispatch;
    let result = {};
    let latest;
    let resolveFrame;
    let rejectFrame;
    const frameReady = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    frameReady.catch(() => {});
    const consider = (frame) => {
      if (!frame || frame.parentId || typeof frame.id !== 'string') return;
      latest = frame;
      if (!started || !dispatched || !frame.url || frame.url === 'about:blank') return;
      try {
        const url = siteUrl(frame.url);
        if (dispatch && (result.loaderId ? frame.loaderId !== result.loaderId : url !== requestedUrl)) return;
        resolveFrame({ ...frame, url });
      } catch (failure) { rejectFrame(failure); }
    };
    const offFrame = connection.on('Page.frameNavigated', (params, source) => {
      if (source === sessionId) consider(params.frame);
    });
    const offWithin = connection.on('Page.navigatedWithinDocument', (params, source) => {
      if (source === sessionId && params.frameId && (params.frameId === latest?.id || params.frameId === result.frameId)) {
        consider({ ...latest, id: params.frameId, url: params.url });
      }
    });
    const offDisconnect = connection.on('disconnect', () => rejectFrame(new CDPError('DISCONNECTED', 'The browser disconnected before the page committed.')));
    const offDetach = connection.on('Target.detachedFromTarget', (params) => {
      if (params.sessionId === sessionId) rejectFrame(new CDPError('TAB_NOT_FOUND', 'The tab closed before the page committed.'));
    });
    try {
      await connection.send('Page.enable', {}, { sessionId, ...budget() });
      if (dispatch) {
        started = true;
        result = await dispatch(budget());
        dispatched = true;
        if (result.errorText) return { result, frame: null };
        consider(latest);
      }
      const { frameTree } = await connection.send('Page.getFrameTree', {}, { sessionId, ...budget() });
      consider(frameTree?.frame);
      const frame = await raceDeadline(frameReady, budget());
      if (this._connection !== connection || !connection.connected) throw new CDPError('DISCONNECTED', 'The browser changed before the page committed.');
      return { result, frame };
    } finally {
      offFrame(); offWithin(); offDisconnect(); offDetach();
    }
  }

  async createTab({ url, visible = false }, options = {}) {
    const href = siteUrl(url);
    const budget = this._budget(options);
    const connection = await this._ensureConnection(budget());
    const { targetId } = await connection.send('Target.createTarget', { url: href, background: visible !== true }, budget());
    if (typeof targetId !== 'string' || !targetId) throw new CDPError('PROTOCOL_ERROR', 'Chrome did not return a tab ID.');
    try {
      // Only the exact newly-created tab may be inspected while its initial URL is blank.
      // No evaluation or input occurs until a regular top-level page actually commits.
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true }, budget());
      if (!sessionId) throw new CDPError('PROTOCOL_ERROR', 'Chrome did not return a debugger session.');
      if (this._connection !== connection || !connection.connected) throw new CDPError('DISCONNECTED', 'The browser changed while opening the tab.');
      this._sessions.set(targetId, sessionId);
      const { frame } = await this._committedPage(connection, sessionId, budget());
      if (visible === true) {
        // Creation already requests foreground; activation is a best-effort compatibility step.
        try { await connection.send('Target.activateTarget', { targetId }, budget()); } catch { /* retain the created tab/ownership */ }
      }
      return { id: targetId, title: '', url: frame.url };
    } catch (failure) {
      // Exact successful creation is known here. Never reconnect or infer/adopt a target for cleanup.
      if (this._connection === connection) {
        this._sessions.delete(targetId);
        if (connection.connected) {
          try { await connection.send('Target.closeTarget', { targetId }, { timeoutMs: 1000 }); } catch { /* outcome may be unknown after disconnect */ }
        }
      }
      throw failure;
    }
  }

  async closeTab(id, options = {}) {
    const expectedBrowserId = this.browserId;
    const budget = this._budget(options);
    const connection = await this._ensureConnection(budget());
    if (expectedBrowserId && this.browserId !== expectedBrowserId) throw new CDPError('DISCONNECTED', 'The browser identity changed before closing. Inspect the browser before retrying.');
    const result = await connection.send('Target.closeTarget', { targetId: id }, budget());
    if (result.success === false) throw new CDPError('TAB_NOT_FOUND', 'Chrome could not close that tab.');
    const session = this._sessions.get(id);
    if (session) connection.rejectSession(session);
    this._sessions.delete(id);
    return { closed: id };
  }

  async _session(id, connection, options) {
    const budget = this._budget(options);
    // Recheck the actual target URL for every raw command, including cached sessions.
    const { targetInfo } = await connection.send('Target.getTargetInfo', { targetId: id }, budget());
    if (!targetInfo || targetInfo.type !== 'page') throw new CDPError('TAB_NOT_FOUND', 'The target is not an open page tab.');
    siteUrl(targetInfo.url);
    if (this._sessions.has(id)) return this._sessions.get(id);
    if (!this._sessionPromises.has(id)) {
      budget();
      const promise = (async () => {
        // Session setup is shared, not an action. Each consumer waits with its own signal/deadline.
        const { sessionId } = await connection.send('Target.attachToTarget', { targetId: id, flatten: true }, { timeoutMs: this.timeoutMs });
        if (!sessionId) throw new CDPError('PROTOCOL_ERROR', 'Chrome did not return a debugger session.');
        if (this._disposed || this._connection !== connection || !connection.connected) throw new CDPError('DISCONNECTED', 'The debugger connection changed during session setup.');
        this._sessions.set(id, sessionId);
        return sessionId;
      })();
      this._sessionPromises.set(id, promise);
      const forget = () => { if (this._sessionPromises.get(id) === promise) this._sessionPromises.delete(id); };
      promise.then(forget, forget);
    }
    return raceDeadline(this._sessionPromises.get(id), budget());
  }

  async send(id, method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (!PAGE_METHODS.has(method)) throw new CDPError('ACCESS_DENIED', 'This CDP method is not available through the browser engine.');
    const expectedBrowserId = this.browserId;
    const budget = boundedTimeout(timeoutMs, this.timeoutMs);
    const started = Date.now();
    const remaining = () => {
      const value = budget - (Date.now() - started);
      if (value <= 0) throw timeout();
      return value;
    };
    const connection = await this._ensureConnection({ signal, timeoutMs: remaining() });
    if (expectedBrowserId && this.browserId !== expectedBrowserId) throw new CDPError('DISCONNECTED', 'The browser identity changed before page access. Inspect the browser before retrying.');
    const sessionId = await this._session(id, connection, { signal, timeoutMs: remaining() });
    if (method === 'Page.navigate') {
      const url = siteUrl(params.url);
      const { result } = await this._committedPage(connection, sessionId, { signal, timeoutMs: remaining() },
        (options) => connection.send(method, { ...params, url }, { sessionId, ...options }), url);
      return result;
    }
    return connection.send(method, params, { sessionId, signal, timeoutMs: remaining() });
  }

  async detach(id, options = {}) {
    const budget = this._budget(options);
    budget();
    const sessionId = this._sessions.get(id);
    this._sessions.delete(id);
    if (sessionId && this._connection?.connected) {
      this._connection.rejectSession(sessionId);
      await this._connection.send('Target.detachFromTarget', { sessionId }, budget());
    }
    return { detached: true };
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._connection?.dispose();
    this._sessions.clear();
    this._sessionPromises.clear();
  }
}
