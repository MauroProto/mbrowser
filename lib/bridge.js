import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { PROTOCOL as PROTOCOL_VERSION, PAIR_CODE_PATTERN, PROOF_PATTERN, proofMessage } from '../extension/auth.js';

export { PROTOCOL_VERSION };
export const EXTENSION_ID = 'fjgcljkoolmpniiomfmdjkplelohggna';
export const DEFAULT_PORT = 43127;
export const CREDENTIAL_KEY = 'mbrowser/extension-device-v2';
const COMMANDS = new Set(['tabs', 'open', 'close', 'send', 'detach', 'cursor']);
// Diagnostic codes are protocol vocabulary, not an arbitrary channel for page/credential text.
const BROWSER_ERROR_CODES = new Set([
  'ABORTED', 'ACCESS_DENIED', 'BUSY', 'CDP_CONTEXT_GONE', 'CDP_ERROR', 'CDP_METHOD_DENIED', 'CHROME_OPERATION_FAILED',
  'EXISTING_TAB_DENIED', 'JS_EVALUATION_FAILED', 'TAB_NOT_OWNED',
  'CONSENT_CHANGED', 'CONSENT_REQUIRED', 'CONTEXT_LOST', 'CONTEXT_NOT_ALLOWED',
  'DEBUGGER_BUSY', 'DEBUGGER_DETACHED', 'DISCONNECTED', 'DUPLICATE_COMMAND',
  'FORBIDDEN', 'FRAME_NOT_ALLOWED', 'INVALID_ARGUMENT', 'INVALID_TAB', 'INVALID_TAB_ID',
  'INVALID_URL', 'METHOD_NOT_ALLOWED', 'NOT_ALLOWED', 'NOT_OWNED', 'NOT_PAIRED',
  'ORIGIN_NOT_ALLOWED', 'PAUSED', 'PERMISSIONS_CHANGED', 'RESULT_TOO_LARGE',
  'REVOKED', 'SITE_APPROVAL_DENIED', 'SITE_APPROVAL_PENDING', 'SITE_APPROVAL_TIMEOUT', 'SITE_LIMIT',
  'STORAGE_UNAVAILABLE', 'TAB_BUSY', 'TAB_IN_USE', 'TAB_NOT_FOUND', 'BACKGROUND_ONLY', 'TIMEOUT',
]);

export function bridgeError(code, message) {
  const error = new Error(message);
  error.name = 'MbrowserError';
  error.code = code;
  return error;
}

const nonce = () => randomBytes(32).toString('hex');
const validProof = (value) => typeof value === 'string' && PROOF_PATTERN.test(value);
function sameProof(a, b) {
  return validProof(a) && validProof(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function devicePayload(record) {
  return record?.kind === 'grant' && record.payload?.version === PROTOCOL_VERSION ? record.payload : null;
}
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validatePermissions(value) {
  if (!plainObject(value) || typeof value.enabled !== 'boolean' || value.allowExistingTabs !== false
      || !Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 100) {
    throw bridgeError('INVALID_PERMISSIONS', 'Permisos de la extensión no válidos.');
  }
  const origins = value.allowedOrigins.map((origin) => {
    if (typeof origin !== 'string' || origin.length > 2048) throw bridgeError('INVALID_PERMISSIONS', 'Origen no válido.');
    let url;
    try { url = new URL(origin); } catch { throw bridgeError('INVALID_PERMISSIONS', 'Origen no válido.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw bridgeError('INVALID_PERMISSIONS', 'Usá orígenes HTTP(S) exactos, sin rutas ni credenciales.');
    }
    return origin;
  });
  return Object.freeze({
    enabled: value.enabled,
    allowExistingTabs: value.allowExistingTabs,
    allowedOrigins: Object.freeze([...new Set(origins)]),
  });
}

/** A profile-owned, authenticated loopback connection. Never accepts page-origin commands. */
export class BrowserBridge extends EventEmitter {
  constructor({
    port = DEFAULT_PORT,
    extensionId = EXTENSION_ID,
    credentials,
    credentialKey = CREDENTIAL_KEY,
    heartbeatMs = 20_000,
    commandTimeoutMs = 20_000,
    pairingTtlMs = 600_000,
    authTimeoutMs = 5_000,
    maxPayload = 16 * 1024 * 1024,
    maxCommandBytes = 1024 * 1024,
    maxHttpBytes = 16 * 1024,
    codeFactory = () => randomBytes(16).toString('hex').toUpperCase(),
  } = {}) {
    super();
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw bridgeError('INVALID_PORT', 'Puerto local no válido.');
    if (!/^[a-p]{32}$/.test(extensionId)) throw bridgeError('INVALID_EXTENSION', 'Identidad de extensión no válida.');
    if (!credentials?.readRecord || !credentials?.modifyRecord) throw bridgeError('CREDENTIAL_STORE', 'Falta el almacén de credenciales de Harness.');
    for (const n of [heartbeatMs, commandTimeoutMs, pairingTtlMs, authTimeoutMs, maxPayload, maxCommandBytes, maxHttpBytes]) {
      if (!Number.isFinite(n) || n < 1) throw bridgeError('INVALID_LIMIT', 'Límite local no válido.');
    }
    this.port = port;
    this.extensionId = extensionId;
    this.credentials = credentials;
    this.credentialKey = credentialKey;
    Object.assign(this, { heartbeatMs, commandTimeoutMs, pairingTtlMs, authTimeoutMs, maxPayload, maxCommandBytes, maxHttpBytes, codeFactory });
    this._pending = new Map();
    this._sockets = new Set();
    this._authSockets = new Set();
    this._connection = null;
    this._permissions = null;
    this._browserId = null;
    this._pairing = null;
    this._pairAttempts = [];
    this._pairInProgress = false;
    this._disposed = false;
    this._started = false;
    this._lastReason = 'NOT_CONNECTED';
  }

  get origin() { return `http://127.0.0.1:${this.port}`; }
  get extensionOrigin() { return `chrome-extension://${this.extensionId}`; }
  get connected() { return this._connection?.socket.readyState === WebSocket.OPEN; }
  get permissions() { return this._permissions; }
  get browserId() { return this._browserId; }

  async start() {
    if (this._disposed) throw bridgeError('DISPOSED', 'mbrowser fue descargado.');
    if (this._started) return this;
    if (this._starting) return this._starting;
    this._starting = this._start();
    try { return await this._starting; } finally { this._starting = null; }
  }

  async _start() {
    this._server = http.createServer((req, res) => {
      this._http(req, res).catch((error) => {
        if (!res.headersSent) this._json(res, error.httpStatus || 500, {
          ok: false, error: { code: error.httpStatus ? error.code : 'BRIDGE_ERROR', message: error.httpStatus ? error.message : 'No se pudo completar la conexión local.' },
        });
        else res.end();
      });
    });
    this._server.requestTimeout = 15_000;
    this._server.headersTimeout = 5_000;
    this._server.keepAliveTimeout = 5_000;
    this._server.maxHeadersCount = 50;
    this._server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
      if (this._sockets.size > 64) socket.destroy();
    });
    this._server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    this._wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload, perMessageDeflate: false });
    this._wss.on('connection', (socket) => this._accept(socket));
    this._wss.on('error', () => { this._lastReason = 'SOCKET_ERROR'; });
    this._server.on('upgrade', (req, socket, head) => {
      if (!this._allowedHost(req) || req.headers.origin !== this.extensionOrigin || req.url !== '/extension' || this._disposed || this._authSockets.size >= 8) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this._wss.handleUpgrade(req, socket, head, (ws) => this._wss.emit('connection', ws, req));
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { this._server.off('listening', onListen); reject(error); };
        const onListen = () => { this._server.off('error', onError); resolve(); };
        this._server.once('error', onError);
        this._server.once('listening', onListen);
        this._server.listen(this.port, '127.0.0.1');
      });
    } catch (error) {
      this._wss.close();
      throw bridgeError(error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'BRIDGE_START',
        error.code === 'EADDRINUSE' ? `El puerto local ${this.port} está ocupado. No se reemplazó otro servidor; configurá otro puerto para este perfil.` : 'No se pudo iniciar el puente local de mbrowser.');
    }
    this.port = this._server.address().port;
    // dispose() may have raced the asynchronous listen event. Its drain closes this server.
    if (this._disposed) return this;
    this._started = true;
    this._server.on('error', () => { this._lastReason = 'SERVER_ERROR'; });
    this._heartbeat = setInterval(() => {
      const c = this._connection;
      if (!c) return;
      if (Date.now() - c.lastPong > this.heartbeatMs * 2.75) {
        this._drop(c, bridgeError('DISCONNECTED', 'La extensión dejó de responder.'), 1012, 'heartbeat timeout');
      } else this._send(c.socket, { type: 'ping' });
    }, this.heartbeatMs);
    this._heartbeat.unref?.();
    return this;
  }

  _allowedHost(req) {
    return req.headers.host === `127.0.0.1:${this.port}`
      && ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  }

  _json(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  }

  _httpError(status, code, message) {
    const error = bridgeError(code, message);
    error.httpStatus = status;
    return error;
  }

  async _readJson(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      throw this._httpError(415, 'CONTENT_TYPE', 'Se requiere JSON.');
    }
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > this.maxHttpBytes) throw this._httpError(413, 'PAYLOAD_LIMIT', 'Solicitud demasiado grande.');
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > this.maxHttpBytes) throw this._httpError(413, 'PAYLOAD_LIMIT', 'Solicitud demasiado grande.');
        chunks.push(chunk);
      }
    } catch (error) {
      if (error.httpStatus) throw error;
      throw this._httpError(400, 'INVALID_JSON', 'Solicitud interrumpida.');
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw this._httpError(400, 'INVALID_JSON', 'JSON no válido.'); }
    if (!plainObject(result)) throw this._httpError(400, 'INVALID_JSON', 'Se requiere un objeto JSON.');
    return result;
  }

  _sign(key, purpose, ...fields) {
    return createHmac('sha256', Buffer.from(key, 'hex'))
      .update(proofMessage(purpose, this.port, this.extensionId, ...fields)).digest('hex');
  }

  async _http(req, res) {
    if (!this._allowedHost(req) || (req.headers.origin && req.headers.origin !== this.extensionOrigin)) {
      this._json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Origen local no autorizado.' } });
      return;
    }
    const origin = req.headers.origin;
    if (origin === this.extensionOrigin) {
      res.setHeader('Access-Control-Allow-Origin', this.extensionOrigin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'GET' && req.url === '/health') {
      this._json(res, 200, { name: 'mbrowser', protocol: PROTOCOL_VERSION });
      return;
    }
    if (req.method === 'GET' && req.url === '/mbrowser/connect') {
      const navigation = !origin && req.headers['sec-fetch-site'] === 'none' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (!navigation) {
        this._json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Iniciá la conexión desde Harness.' } });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="mbrowser-connect" content="1"><title>mbrowser</title><h1>Abriendo mbrowser</h1><p>Si esta página sigue abierta, instalá la extensión en este perfil de Chrome y elegí /mbrowser de nuevo en Harness.</p></html>');
      return;
    }
    if (!['/pair', '/revoke'].includes(req.url)) {
      this._json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Ruta no disponible.' } });
      return;
    }
    if (origin !== this.extensionOrigin) {
      this._json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Esta acción pertenece a la extensión autorizada.' } });
      return;
    }
    if (req.method === 'OPTIONS') {
      const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== 'POST' || headers.some((x) => x !== 'content-type')) {
        this._json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Solicitud no autorizada.' } });
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.writeHead(204); res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      this._json(res, 405, { ok: false, error: { code: 'METHOD', message: 'Método no disponible.' } });
      return;
    }
    const body = await this._readJson(req);
    if (req.url === '/pair') {
      const now = Date.now();
      this._pairAttempts = this._pairAttempts.filter((t) => now - t < 60_000);
      if (this._pairAttempts.length >= 8) throw this._httpError(429, 'RATE_LIMIT', 'Demasiados intentos. Esperá un minuto.');
      this._pairAttempts.push(now);
      const current = this._pairing;
      if (!current || now >= current.expiresAt || !validProof(body.nonce) ||
          !sameProof(body.proof, this._sign(current.code, 'pair/request', body.nonce))) {
        throw this._httpError(401, 'PAIRING_CODE', 'Código inválido, usado o vencido. Generá otro en mbrowser_status.');
      }
      // Claim the one-use code before writing credentials. Do not let a second pairing overtake this write.
      this._pairing = null;
      this._pairInProgress = true;
      try {
        const hostNonce = nonce();
        const deviceKey = this._sign(current.code, 'pair/device', body.nonce, hostNonce);
        const proof = this._sign(current.code, 'pair/response', body.nonce, hostNonce);
        const payload = { version: PROTOCOL_VERSION, deviceKey, pairedAt: new Date().toISOString(), revoked: false };
        await this.credentials.modifyRecord(this.credentialKey, async () => ({ kind: 'grant', payload }));
        if (this._connection) this._drop(this._connection, bridgeError('PAIRING_CHANGED', 'Se autorizó una conexión nueva.'), 1008, 'pairing changed');
        this._lastReason = 'PAIRED';
        this._json(res, 200, { nonce: hostNonce, proof, protocol: PROTOCOL_VERSION });
      } finally {
        this._pairInProgress = false;
      }
      return;
    }
    if (!validProof(body.nonce) || !validProof(body.proof)) throw this._httpError(401, 'UNAUTHORIZED', 'Prueba de revocación no válida.');
    let revokeKey;
    let revokedDeviceKey;
    await this.credentials.modifyRecord(this.credentialKey, async (record) => {
      const current = devicePayload(record);
      const key = current?.revoked ? current.revokeKey : validProof(current?.deviceKey) ? this._sign(current.deviceKey, 'revoke/key') : null;
      if (!validProof(key) || !sameProof(body.proof, this._sign(key, 'revoke/request', body.nonce))) return undefined;
      revokeKey = key;
      if (current.revoked) return undefined;
      revokedDeviceKey = current.deviceKey;
      return { kind: 'grant', payload: { version: PROTOCOL_VERSION, revoked: true, revokeKey, revokedAt: new Date().toISOString() } };
    });
    if (!revokeKey) throw this._httpError(401, 'UNAUTHORIZED', 'La autorización ya cambió.');
    if (revokedDeviceKey) {
      if (this._connection && sameProof(this._connection.deviceKey, revokedDeviceKey)) {
        this._drop(this._connection, bridgeError('REVOKED', 'La autorización de mbrowser fue revocada.'), 1008, 'revoked');
      }
      this._lastReason = 'REVOKED';
    }
    this._json(res, 200, { ok: true, proof: this._sign(revokeKey, 'revoke/response', body.nonce) });
  }

  createPairingCode() {
    if (!this._started || this._disposed) throw bridgeError('NOT_STARTED', 'El puente de mbrowser no está activo.');
    if (this._pairInProgress) throw bridgeError('BUSY', 'Esperá a que termine la vinculación en curso.');
    const raw = String(this.codeFactory()).replaceAll('-', '').toUpperCase();
    if (!PAIR_CODE_PATTERN.test(raw)) throw bridgeError('CODE_GENERATOR', 'No se pudo crear un código seguro.');
    this._pairing = { code: raw, expiresAt: Date.now() + this.pairingTtlMs };
    return {
      code: raw.match(/.{1,4}/g).join('-'),
      expires_at: new Date(this._pairing.expiresAt).toISOString(),
      extension_id: this.extensionId,
      bridge_url: this.origin,
    };
  }

  async status() {
    let device = null;
    let credentialError = false;
    try { device = await this._readDevice(); }
    catch { credentialError = true; }
    return {
      backend: 'extension', protocol: PROTOCOL_VERSION, connected: this.connected,
      paired: !!device && !device.revoked && validProof(device.deviceKey),
      revoked: !!device?.revoked,
      paused: this._permissions?.enabled === false,
      permissions: this._permissions,
      browser_id: this._browserId,
      extension_id: this.extensionId,
      bridge_url: this.origin,
      reason: credentialError ? 'CREDENTIAL_STORE' : this.connected ? (this._permissions?.enabled ? 'CONNECTED' : 'PAUSED') : this._lastReason,
      credential_error: credentialError,
      pairing_available: !!this._pairing && Date.now() < this._pairing.expiresAt,
      pending: this._pending.size,
    };
  }

  async _readDevice() {
    try { return devicePayload(await this.credentials.readRecord(this.credentialKey)); }
    catch {
      const error = bridgeError('CREDENTIAL_STORE', 'No se pudo leer la autorización guardada. mbrowser no ejecutó una acción nueva.');
      if (this._connection) this._drop(this._connection, error, 1012, 'credential store unavailable');
      throw error;
    }
  }

  async _validDeviceKey(deviceKey) {
    const device = await this._readDevice();
    return !!device && !device.revoked && sameProof(device.deviceKey, deviceKey);
  }

  _accept(socket) {
    this._authSockets.add(socket);
    const authTimer = setTimeout(() => socket.terminate(), this.authTimeoutMs);
    authTimer.unref?.();
    const state = {
      phase: 'challenge',
      connection: null,
      authenticated: () => { clearTimeout(authTimer); this._authSockets.delete(socket); },
    };
    socket.on('error', () => { /* WebSocket owns transport errors; close rejects pending commands. */ });
    socket.on('close', () => {
      clearTimeout(authTimer);
      this._authSockets.delete(socket);
      if (state.connection) this._drop(state.connection, bridgeError('DISCONNECTED', 'Se desconectó la extensión de Chrome.'), null);
    });
    socket.on('message', (data, isBinary) => {
      this._message(socket, data, isBinary, state).catch(() => socket.close(1008, 'invalid message'));
    });
  }

  async _message(socket, data, isBinary, state) {
    if (this._disposed || isBinary) { socket.close(1008, 'invalid message'); return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); }
    catch { socket.close(1008, 'invalid JSON'); return; }
    if (!plainObject(msg)) { socket.close(1008, 'invalid message'); return; }
    if (state.phase === 'challenge') {
      state.phase = 'authenticating';
      if (msg.type !== 'challenge' || msg.protocol !== PROTOCOL_VERSION || !validProof(msg.nonce)) {
        socket.close(1008, 'authentication required'); return;
      }
      const device = await this._readDevice();
      if (!device || device.revoked || !validProof(device.deviceKey) || socket.readyState !== WebSocket.OPEN || this._disposed) {
        socket.close(1008, 'unauthorized'); return;
      }
      state.deviceKey = device.deviceKey;
      state.clientNonce = msg.nonce;
      state.hostNonce = nonce();
      state.phase = 'hello';
      this._send(socket, {
        type: 'proof', protocol: PROTOCOL_VERSION, nonce: state.hostNonce,
        proof: this._sign(state.deviceKey, 'socket/host', state.clientNonce, state.hostNonce),
      });
      return;
    }
    if (state.phase === 'hello') {
      state.phase = 'authenticating';
      if (msg.type !== 'hello' || msg.protocol !== PROTOCOL_VERSION || !/^[A-Za-z0-9_-]{8,128}$/.test(msg.instanceId || '')) {
        socket.close(1008, 'authentication required'); return;
      }
      const permissions = validatePermissions(msg.permissions);
      const deviceKey = state.deviceKey;
      const expected = this._sign(deviceKey, 'socket/extension', state.clientNonce, state.hostNonce, msg.instanceId, msg.permissions);
      if (!sameProof(expected, msg.proof) || !await this._validDeviceKey(deviceKey) ||
          socket.readyState !== WebSocket.OPEN || this._disposed) {
        socket.close(1008, 'unauthorized'); return;
      }
      if (this._connection) this._drop(this._connection, bridgeError('CONNECTION_REPLACED', 'La extensión se reconectó.'), 1000, 'replaced');
      const c = { socket, instanceId: msg.instanceId, permissions, deviceKey, lastPong: Date.now() };
      state.connection = c;
      state.phase = 'ready';
      state.authenticated();
      this._connection = c;
      this._permissions = permissions;
      this._browserId = `extension:${msg.instanceId}`;
      this._lastReason = permissions.enabled ? 'CONNECTED' : 'PAUSED';
      this._send(socket, { type: 'welcome', protocol: PROTOCOL_VERSION });
      this.emit('connection', { browserId: this.browserId, permissions });
      return;
    }
    if (state.phase !== 'ready' || this._connection !== state.connection) { socket.close(1008, 'authentication required'); return; }
    const c = state.connection;
    if (msg.type === 'pong') { c.lastPong = Date.now(); return; }
    if (msg.type === 'ping') { this._send(socket, { type: 'pong' }); return; }
    const previousUpdate = c.permissionUpdate;
    if (msg.type === 'permissions') {
      c.permissionUpdate = this._updatePermissions(c, msg.permissions, previousUpdate);
      await c.permissionUpdate;
      return;
    }
    // An approved open can finish before the credential lookup for its grant update.
    await previousUpdate;
    if (!await this._isCurrentDevice(c)) return;
    if (msg.type !== 'result' || typeof msg.id !== 'string' || typeof msg.ok !== 'boolean') { socket.close(1008, 'invalid result'); return; }
    if (!this._pending.has(msg.id)) return; // A late response to a timed-out/cancelled command is never replayed.
    if (msg.ok) this._settle(msg.id, null, msg.result);
    else {
      const code = BROWSER_ERROR_CODES.has(msg.error?.code) ? msg.error.code : 'BROWSER_ERROR';
      let message = typeof msg.error?.message === 'string' ? msg.error.message.slice(0, 2000) : 'Chrome no pudo completar la acción.';
      for (const value of this._pending.get(msg.id)?.redact || []) message = message.split(value).join('[redactado]');
      message = message.replace(/[A-Za-z0-9_-]{43,}/g, '[credencial redactada]')
        .replace(/\b[A-Fa-f0-9]{4}(?:-[A-Fa-f0-9]{4}){3,7}\b/g, '[código redactado]');
      this._settle(msg.id, bridgeError(code, message));
    }
  }

  async _isCurrentDevice(connection) {
    if (this._connection !== connection) return false;
    if (!await this._validDeviceKey(connection.deviceKey)) {
      this._drop(connection, bridgeError('REVOKED', 'La autorización de mbrowser cambió.'), 1008, 'revoked');
      return false;
    }
    return this._connection === connection;
  }

  async _updatePermissions(connection, supplied, previousUpdate) {
    await previousUpdate;
    if (!await this._isCurrentDevice(connection)) return;
    const permissions = validatePermissions(supplied);
    const previous = connection.permissions;
    const addedSitesOnly = previous.enabled && permissions.enabled &&
      permissions.allowedOrigins.length > previous.allowedOrigins.length &&
      previous.allowedOrigins.every(origin => permissions.allowedOrigins.includes(origin));
    this._permissions = connection.permissions = permissions;
    this._lastReason = permissions.enabled ? 'CONNECTED' : 'PAUSED';
    if (!addedSitesOnly) {
      this._failPending(bridgeError(permissions.enabled ? 'PERMISSIONS_CHANGED' : 'PAUSED',
        permissions.enabled ? 'Los permisos cambiaron. Verificá el estado antes de continuar.' : 'mbrowser está pausado en la extensión.'), true);
    }
    this.emit('permissions', permissions);
  }

  _send(socket, value, onError) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(value), (error) => { if (error) onError?.(error); }); return true; }
    catch (error) { onError?.(error); return false; }
  }

  async request(method, params = {}, { signal, timeoutMs = this.commandTimeoutMs } = {}) {
    if (!COMMANDS.has(method)) throw bridgeError('UNSUPPORTED_COMMAND', 'Acción de extensión no admitida.');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw bridgeError('INVALID_TIMEOUT', 'Tiempo de espera no válido (1–120000 ms).');
    if (!plainObject(params)) throw bridgeError('INVALID_ARGUMENT', 'Parámetros de extensión no válidos.');
    if (this._disposed) throw bridgeError('DISPOSED', 'mbrowser fue descargado.');
    if (signal?.aborted) throw bridgeError('ABORTED', 'Acción de mbrowser cancelada.');
    const c = this._connection;
    if (!c || !this.connected) throw bridgeError('EXTENSION_DISCONNECTED', 'La extensión mbrowser no está conectada. Revisá mbrowser_status o abrí las opciones de la extensión.');
    if (!c.permissions.enabled) throw bridgeError('PAUSED', 'mbrowser está pausado en la extensión.');
    if (!await this._validDeviceKey(c.deviceKey)) {
      this._drop(c, bridgeError('REVOKED', 'La autorización de mbrowser cambió.'), 1008, 'revoked');
      throw bridgeError('REVOKED', 'La autorización de mbrowser fue revocada.');
    }
    if (this._connection !== c || !this.connected) throw bridgeError('DISCONNECTED', 'La conexión de la extensión cambió.');
    if (!c.permissions.enabled) throw bridgeError('PAUSED', 'mbrowser está pausado en la extensión.');
    if (signal?.aborted) throw bridgeError('ABORTED', 'Acción de mbrowser cancelada.');
    if (this._pending.size >= 32) throw bridgeError('BUSY', 'Hay demasiadas acciones pendientes.');
    const id = randomBytes(16).toString('hex');
    let encoded;
    try { encoded = JSON.stringify({ type: 'command', id, method, params }); }
    catch { throw bridgeError('INVALID_ARGUMENT', 'Los parámetros no son JSON válido.'); }
    if (Buffer.byteLength(encoded) > this.maxCommandBytes) throw bridgeError('PAYLOAD_LIMIT', 'La acción supera el límite de tamaño.');
    return new Promise((resolve, reject) => {
      const cancel = (code, message) => {
        if (!this._pending.has(id)) return;
        this._send(c.socket, { type: 'cancel', id });
        this._settle(id, bridgeError(code, message));
      };
      const timer = setTimeout(() => cancel('TIMEOUT', 'Chrome no respondió a tiempo. La acción puede haberse ejecutado: verificá el estado antes de repetirla.'), timeoutMs);
      timer.unref?.();
      const onAbort = () => cancel('ABORTED', 'Acción cancelada. Puede haberse iniciado: verificá el estado antes de repetirla.');
      const redact = method === 'send' && params.method === 'Input.insertText' && typeof params.params?.text === 'string' && params.params.text
        ? [params.params.text] : [];
      this._pending.set(id, { resolve, reject, timer, signal, onAbort, redact });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        c.socket.send(encoded, (error) => { if (error) this._settle(id, bridgeError('DISCONNECTED', 'Se interrumpió la conexión con Chrome.')); });
      } catch { this._settle(id, bridgeError('DISCONNECTED', 'Se interrumpió la conexión con Chrome.')); }
    });
  }

  _settle(id, error, result) {
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (error) pending.reject(error); else pending.resolve(result);
  }

  _failPending(error, cancel = false) {
    for (const id of this._pending.keys()) {
      if (cancel && this._connection) this._send(this._connection.socket, { type: 'cancel', id });
      this._settle(id, error);
    }
  }

  _drop(connection, error, closeCode = 1012, reason = 'disconnected') {
    if (this._connection === connection) {
      this._connection = null;
      this._lastReason = error.code || 'DISCONNECTED';
      this._failPending(error);
      this.emit('disconnection', { code: this._lastReason });
    }
    if (closeCode && connection.socket.readyState === WebSocket.OPEN) connection.socket.close(closeCode, reason);
  }

  async dispose() {
    if (this._disposePromise) return this._disposePromise;
    this._disposed = true;
    this._disposePromise = this._dispose();
    return this._disposePromise;
  }

  async _dispose() {
    // Drain an in-progress start before closing handles: listen can settle after unload.
    await this._starting?.catch(() => {});
    this._pairing = null;
    clearInterval(this._heartbeat);
    this._failPending(bridgeError('DISPOSED', 'mbrowser fue descargado.'));
    this._connection = null;
    for (const ws of this._wss?.clients || []) ws.terminate();
    for (const socket of this._sockets) socket.destroy();
    await Promise.all([
      this._wss ? new Promise((resolve) => this._wss.close(() => resolve())) : undefined,
      this._server?.listening ? new Promise((resolve) => this._server.close(() => resolve())) : undefined,
    ]);
    this._started = false;
    this.removeAllListeners();
  }
}
