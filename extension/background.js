import {
  PROTOCOL, DEFAULT_PORT, CONSENT_VERSION, MAX_REQUEST_BYTES, MAX_RESULT_BYTES,
  MAX_HTTP_BYTES, MAX_COMMAND_MS, MAX_IN_FLIGHT, ExtensionError, fail, isRecord,
  normalizePort, bridgeUrl, normalizePairCode, validToken, normalizeAllowedOrigins,
  normalizeWebUrl, isAllowedUrl, parseTabId, validChromeTabId,
  validRequestId, validateCdp, safeError,
} from './policy.js';

import { newNonce, PAIR_CODE_PATTERN, PROOF_PATTERN, signProof, verifyProof } from './auth.js';

const LOCAL_KEY = 'mbrowser.device.v2';
const SESSION_KEY = 'mbrowser.session.v2';
const RECONNECT_ALARM = 'mbrowser.reconnect';
const REVOKE_ALARM = 'mbrowser.revoke';
const IDLE_ALARM = 'mbrowser.idle';
const HEARTBEAT_MS = 20_000;
const AUTH_TIMEOUT_MS = 10_000;
const SITE_APPROVAL_MS = 45_000;
const IDLE_MS = 120_000;
const ACTIVITY_SAVE_INTERVAL_MS = 5_000;
const encoder = new TextEncoder();

function defaultDevice() {
  return {
    schema: 1,
    port: DEFAULT_PORT,
    token: null,
    consentVersion: 0,
    approvedAt: null,
    grant: { enabled: false, allowExistingTabs: false, allowedOrigins: [] },
    pendingRevocation: null,
  };
}

function timer(callback, delay) {
  const handle = setTimeout(callback, delay);
  handle?.unref?.();
  return handle;
}

async function bounded(promise, delay) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { handle = timer(() => reject(new ExtensionError('TIMEOUT', 'Chrome tardó demasiado en responder.')), delay); }),
    ]);
  } finally { clearTimeout(handle); }
}

function closeSocket(socket, code = 1000, reason = 'stopped') {
  try { socket?.close(code, reason); } catch { /* No secrets or untrusted server diagnostics. */ }
}

function loadDevice(value) {
  if (value === undefined) return defaultDevice();
  if (!isRecord(value) || value.schema !== 1) throw new Error('Invalid stored device');
  const result = defaultDevice();
  result.port = normalizePort(value.port);
  if (value.pendingRevocation !== null && value.pendingRevocation !== undefined) {
    if (!isRecord(value.pendingRevocation) || !validToken(value.pendingRevocation.token)) throw new Error('Invalid revocation');
    result.pendingRevocation = {
      token: value.pendingRevocation.token,
      port: normalizePort(value.pendingRevocation.port),
    };
  }
  if (value.token !== null && value.token !== undefined) {
    if (!validToken(value.token) || value.consentVersion !== CONSENT_VERSION ||
        typeof value.approvedAt !== 'string' || !Number.isFinite(Date.parse(value.approvedAt)) ||
        !isRecord(value.grant) || typeof value.grant.enabled !== 'boolean' ||
        typeof value.grant.allowExistingTabs !== 'boolean') throw new Error('Invalid authorization');
    result.token = value.token;
    result.consentVersion = CONSENT_VERSION;
    result.approvedAt = value.approvedAt;
    const origins = normalizeAllowedOrigins(value.grant.allowedOrigins);
    result.grant = {
      enabled: value.grant.enabled,
      allowExistingTabs: false,
      allowedOrigins: origins.includes('*') ? [] : origins,
    };
  }
  return result;
}

/** Native MV3 controller. Pairing codes and device keys are never sent over the wire. */
export class BackgroundController {
  #chrome;
  #fetch;
  #WebSocket;
  #now;
  #device = defaultDevice();
  #instanceId = null;
  #owned = new Set();
  #attached = new Set();
  #attaching = new Map();
  #releasing = new Map();
  #expectedDetach = new Set();
  #mainFrames = new Map();
  #contexts = new Map();
  #expiredContexts = new Map();
  #tabRevision = new Map();
  #tabBusy = new Map();
  #cursor = new Map();
  #previewPending = false;
  #lastPreview = 0;
  #socket = null;
  #socketSerial = 0;
  #welcomed = false;
  #connection = 'unpaired';
  #notice = null;
  #siteRequest = null;
  #pendingLink = null;
  #epoch = 0;
  #revision = 0;
  #inFlight = new Map();
  #recentIds = new Set();
  #authTimer;
  #heartbeatTimer;
  #reconnectTimer;
  #idleTimer;
  #activeUntil = 0;
  #backoff = 0;
  #lastReceived = 0;
  #mutation = Promise.resolve();
  #deviceWrites = Promise.resolve();
  #sessionWrites = Promise.resolve();
  #revoking = null;
  #storageReady = false;
  #authorizationReady = false;
  ready;

  constructor({ chrome = globalThis.chrome, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket, now = Date.now } = {}) {
    this.#chrome = chrome;
    this.#fetch = fetch;
    this.#WebSocket = WebSocket;
    this.#now = now;
    this.ready = this.#initialize().catch(() => {
      this.#storageReady = false;
      this.#authorizationReady = false;
      this.#device = defaultDevice();
      this.#notice = 'STORAGE_UNAVAILABLE';
      this.#connection = 'unpaired';
      this.#notify();
    });
  }

  async #initialize() {
    // Includes extension pages, but never content scripts or other untrusted contexts.
    await Promise.all([
      this.#chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      this.#chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    ]);
    const [local, session] = await Promise.all([
      this.#chrome.storage.local.get(LOCAL_KEY),
      this.#chrome.storage.session.get(SESSION_KEY),
    ]);
    try { this.#device = loadDevice(local[LOCAL_KEY]); } catch {
      this.#device = defaultDevice();
      this.#notice = 'STORAGE_INVALID';
    }
    const saved = session[SESSION_KEY];
    const validSession = isRecord(saved) && saved.schema === 1 &&
      typeof saved.instanceId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved.instanceId);
    this.#instanceId = validSession ? saved.instanceId : crypto.randomUUID();
    if (validSession) {
      this.#owned = new Set((Array.isArray(saved.ownedTabs) ? saved.ownedTabs : []).filter(validChromeTabId));
      this.#attached = new Set((Array.isArray(saved.attachedTabs) ? saved.attachedTabs : []).filter(validChromeTabId));
    }
    const now = this.#now();
    if (validSession && this.#device.grant.enabled && Number.isSafeInteger(saved.activeUntil) &&
        saved.activeUntil > now && saved.activeUntil <= now + IDLE_MS) {
      this.#activeUntil = saved.activeUntil;
    }
    this.#device.grant.enabled = this.#activeUntil > 0;
    const tabs = await this.#chrome.tabs.query({});
    const liveIds = new Set(tabs.filter(tab => !tab.incognito).map(tab => tab.id));
    this.#owned = new Set([...this.#owned].filter(id => liveIds.has(id)));
    // These IDs are only a stale-context diagnostic cache, NEVER authority to evaluate after restart.
    if (validSession && isRecord(saved.issuedContexts)) {
      for (const [tabId, contextIds] of Object.entries(saved.issuedContexts).slice(-128)) {
        const id = Number(tabId);
        if (!validChromeTabId(id) || !liveIds.has(id) || !Array.isArray(contextIds)) continue;
        this.#expiredContexts.set(id, new Set(contextIds.filter(value => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647).slice(-256)));
      }
    }
    this.#storageReady = true;
    // A worker restart preserves ownership but never assumes that old debugger contexts are valid.
    await this.#releaseAll();
    await Promise.all([this.#saveDevice(), this.#saveSession()]);
    this.#authorizationReady = Boolean(this.#device.token && this.#device.grant.enabled);
    this.#connection = this.#device.token ? (this.#device.grant.enabled ? 'waiting' : 'paused') : 'unpaired';
    if (this.#device.pendingRevocation) {
      this.#notice = 'REVOCATION_PENDING';
      void this.#flushRevocation().catch(() => {});
    }
    this.#notify();
    if (this.#canConnect()) {
      this.#scheduleIdle();
      this.#connect();
    }
  }

  isUiSender(sender) {
    const base = `chrome-extension://${this.#chrome.runtime.id}`;
    return sender?.id === this.#chrome.runtime.id &&
      ['options.html', 'panel.html'].some(page => sender.url === `${base}/${page}`) &&
      (!sender.origin || sender.origin === base);
  }

  async handleHandoff(message, sender) {
    if (sender?.id !== this.#chrome.runtime.id || sender.frameId !== 0 ||
        !validChromeTabId(sender.tab?.id) || sender.tab.incognito) {
      fail('UNTRUSTED_SENDER', 'La conexión se inicia desde Harness.');
    }
    if (typeof message.code !== 'string' || !PAIR_CODE_PATTERN.test(message.code)) {
      fail('INVALID_PAIR_CODE', 'Elegí /mbrowser de nuevo en Harness.');
    }
    const url = new URL(sender.url);
    const port = normalizePort(url.port);
    if (url.origin !== 'http://127.0.0.1:' + port || url.pathname !== '/mbrowser/connect' ||
        url.search || sender.origin !== url.origin) fail('UNTRUSTED_SENDER', 'La conexión se inicia desde Harness.');
    const current = await this.#chrome.tabs.get(sender.tab.id);
    const here = new URL(current.pendingUrl || current.url);
    if (current.id !== sender.tab.id || here.origin !== url.origin || here.pathname !== url.pathname || here.search) return;
    const ticket = { tabId: current.id, port, code: message.code, expiresAt: this.#now() + 120_000 };
    this.#pendingLink = ticket;
    timer(() => { if (this.#pendingLink === ticket) this.#pendingLink = null; }, 120_000);
    try {
      await this.#chrome.tabs.update(current.id, { url: this.#chrome.runtime.getURL('options.html') });
    } catch (error) {
      if (this.#pendingLink === ticket) this.#pendingLink = null;
      throw error;
    }
  }

  status() {
    const grant = this.#device.grant;
    return {
      protocol: PROTOCOL,
      extensionId: this.#chrome.runtime.id,
      revision: this.#revision,
      paired: Boolean(this.#device.token),
      consentGranted: this.#device.consentVersion === CONSENT_VERSION,
      enabled: Boolean(this.#device.token && grant.enabled && this.#activeUntil > this.#now()),
      connection: this.#connection,
      bridgePort: this.#device.port,
      permissions: {
        enabled: Boolean(this.#device.token && grant.enabled && this.#activeUntil > this.#now()),
        allowExistingTabs: grant.allowExistingTabs,
        allowedOrigins: [...grant.allowedOrigins],
      },
      ownedTabCount: this.#owned.size,
      attachedTabCount: this.#attached.size,
      revocationPending: Boolean(this.#device.pendingRevocation),
      siteRequest: this.#siteRequest && { id: this.#siteRequest.id, origin: this.#siteRequest.origin },
      notice: this.#notice,
    };
  }

  async handleUi(message, sender) {
    if (!this.isUiSender(sender)) return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'Esta página no puede controlar la extensión.' } };
    await this.ready;
    try {
      if (!isRecord(message)) fail('INVALID_ARGUMENT', 'La solicitud no es válida.');
      const allowed = {
        getStatus: ['action'],
        getActivity: ['action'],
        getPreview: ['action', 'tabId'],
        consumeLink: ['action'],
        decideSite: ['action', 'id', 'allow'],
        pause: ['action'],
        resume: ['action', 'revision', 'accepted'],
        revoke: ['action', 'confirmed'],
      };
      if (!Object.hasOwn(allowed, message.action) || Object.keys(message).some(key => !allowed[message.action].includes(key))) {
        fail('INVALID_ARGUMENT', 'Esa acción no está disponible en la extensión.');
      }
      if (message.action === 'getActivity' || message.action === 'getPreview') {
        if (sender.url !== `chrome-extension://${this.#chrome.runtime.id}/panel.html`) {
          fail('UNTRUSTED_SENDER', 'La vista previa pertenece al panel de actividad.');
        }
        if (message.action === 'getActivity') return { ok: true, tabs: await this.#activity() };
        return { ok: true, frame: await this.#preview(message.tabId) };
      }
      if (message.action !== 'getStatus') {
        if (!this.#storageReady) fail('STORAGE_UNAVAILABLE', 'Chrome no pudo guardar la autorización de forma segura.');
        // Safety-reducing actions are never queued behind pairing, storage, or slow Chrome work.
        if (message.action === 'pause') {
          await this.#pause('PAUSED_BY_USER');
          return { ok: true, status: this.status() };
        }
        if (message.action === 'revoke') {
          if (message.confirmed !== true) fail('CONSENT_REQUIRED', 'Confirma la revocación antes de continuar.');
          await this.#pause('REVOKED');
          await this.#mutate(() => this.#revoke());
          return { ok: true, status: this.status() };
        }
        await this.#mutate(async () => {
          switch (message.action) {
            case 'consumeLink': {
              if (sender.url !== this.#chrome.runtime.getURL('options.html')) fail('UNTRUSTED_SENDER', 'La conexión se inicia desde Harness.');
              const link = this.#pendingLink;
              if (!link || sender.tab?.id !== link.tabId) break;
              this.#pendingLink = null;
              if (this.#now() >= link.expiresAt) fail('PAIRING_REJECTED', 'La conexión caducó. Elegí /mbrowser de nuevo en Harness.');
              if (this.#device.token && this.#device.port !== link.port) {
                fail('ALREADY_PAIRED', 'Desconectá el otro Harness en el panel y volvé a elegir /mbrowser.');
              }
              if (!this.#device.token || this.#notice === 'AUTH_REJECTED') await this.#pair(link);
              break;
            }
            case 'decideSite':
              if (sender.url !== this.#chrome.runtime.getURL('panel.html')) fail('UNTRUSTED_SENDER', 'El permiso se confirma desde el panel.');
              await this.#decideSite(message);
              break;
            case 'resume':
              this.#checkRevision(message.revision);
              if (message.accepted !== true || !this.#device.token || this.#device.consentVersion !== CONSENT_VERSION) {
                fail('CONSENT_REQUIRED', 'Vincula la extensión y confirma el alcance antes de reanudar.');
              }
              await this.#activate();
              break;
          }
        });
      }
      return { ok: true, status: this.status() };
    } catch (error) {
      this.#notify();
      return { ok: false, error: safeError(error), status: this.status() };
    }
  }

  async #activity() {
    if (!this.#canConnect() || !this.#welcomed) return [];
    const epoch = this.#epoch;
    const tabs = await this.#chrome.tabs.query({});
    if (epoch !== this.#epoch || !this.#welcomed) return [];
    return tabs.filter(tab => {
      const id = tab.id;
      if (!this.#owned.has(id) && !this.#attached.has(id) && !this.#tabBusy.has(id)) return false;
      try { this.#checkTabGrant(tab, id); return true; } catch { return false; }
    }).map(tab => {
      const id = tab.id;
      const attached = this.#attached.has(id) && !this.#releasing.has(id);
      const state = tab.active !== false ? 'manual' : this.#tabBusy.has(id) ? 'working' : attached ? 'attached' : 'idle';
      return {
        id, state, title: String(tab.title || '').slice(0, 200), origin: new URL(tab.url).origin,
        preview: this.#owned.has(id) && attached && tab.active === false,
      };
    }).slice(0, 50);
  }

  async #preview(id) {
    if (!validChromeTabId(id)) fail('INVALID_TAB', 'Elige una pestaña de mbrowser.');
    const epoch = this.#epoch;
    const revision = this.#tabRevision.get(id);
    const check = async () => {
      const tab = await this.#chrome.tabs.get(id);
      if (epoch !== this.#epoch || revision !== this.#tabRevision.get(id) || !this.#canConnect() ||
          !this.#welcomed || !this.#attached.has(id) || this.#releasing.has(id)) {
        fail('PREVIEW_UNAVAILABLE', 'La pestaña ya no está disponible para la vista previa.');
      }
      this.#checkTabGrant(tab, id, { ownOnly: true });
      this.#checkBackground(tab);
      if (tab.pendingUrl) fail('PREVIEW_UNAVAILABLE', 'Espera a que termine la navegación.');
      return tab;
    };
    const tab = await check();
    if (this.#previewPending || Date.now() - this.#lastPreview < 500) return null;
    this.#lastPreview = Date.now();
    this.#previewPending = true;
    let capture;
    try {
      capture = this.#chrome.debugger.sendCommand({ tabId: id }, 'Page.captureScreenshot', {
        format: 'jpeg', quality: 40, fromSurface: true, captureBeyondViewport: false,
      });
      const result = await bounded(capture, 2000);
      const after = await check();
      if (after.url !== tab.url || after.pendingUrl || typeof result?.data !== 'string' || result.data.length > 2_000_000) return null;
      const mark = this.#cursor.get(id);
      return { image: result.data, cursor: mark?.until > Date.now() ? { x: mark.x, y: mark.y } : null };
    } finally {
      // A timeout must not permit a second capture while Chrome still handles the first one.
      void Promise.resolve(capture).then(() => { this.#previewPending = false; }, () => { this.#previewPending = false; });
    }
  }

  #checkRevision(revision) {
    if (revision !== this.#revision) fail('STALE_SETTINGS', 'El estado cambió. Revisa los permisos actuales y vuelve a confirmar.');
  }

  #mutate(operation) {
    const result = this.#mutation.catch(() => {}).then(operation);
    this.#mutation = result.catch(() => {});
    return result;
  }

  #saveDevice(device = this.#device) {
    if (!this.#storageReady) return Promise.resolve();
    const snapshot = structuredClone(device);
    const result = this.#deviceWrites.catch(() => {}).then(() => this.#chrome.storage.local.set({ [LOCAL_KEY]: snapshot })).catch(() => {
      this.#storageFailure();
      fail('STORAGE_UNAVAILABLE', 'Chrome no pudo guardar la autorización. El control se detuvo; desactiva la extensión en Chrome si no puedes guardar una pausa.');
    });
    this.#deviceWrites = result.catch(() => {});
    return result;
  }

  #saveSession() {
    if (!this.#storageReady) return Promise.resolve();
    const issuedContexts = {};
    const ids = [...new Set([...this.#expiredContexts.keys(), ...this.#contexts.keys()])].slice(-128);
    for (const id of ids) {
      issuedContexts[id] = [...new Set([...(this.#expiredContexts.get(id) || []), ...(this.#contexts.get(id) || [])])].slice(-256);
    }
    const snapshot = {
      schema: 1, instanceId: this.#instanceId,
      ownedTabs: [...this.#owned], attachedTabs: [...this.#attached], issuedContexts, activeUntil: this.#activeUntil,
    };
    const result = this.#sessionWrites.catch(() => {}).then(() => this.#chrome.storage.session.set({ [SESSION_KEY]: snapshot })).catch(() => {
      if (this.#device.grant.enabled || this.#authorizationReady) this.#storageFailure();
      fail('STORAGE_UNAVAILABLE', 'Chrome no pudo guardar el estado seguro de las pestañas. El control se detuvo.');
    });
    this.#sessionWrites = result.catch(() => {});
    return result;
  }

  #storageFailure() {
    this.#authorizationReady = false;
    this.#endActivity();
    this.#device.grant.enabled = false;
    this.#revision++;
    this.#notice = 'STORAGE_UNAVAILABLE';
    this.#sendPermissions();
    this.#invalidate(new ExtensionError('STORAGE_UNAVAILABLE', 'El almacenamiento seguro dejó de estar disponible.'));
    this.#disconnect();
    this.#connection = this.#device.token ? 'paused' : 'unpaired';
    this.#notify();
    void this.#releaseAll().catch(() => {});
  }

  #notify() {
    const status = this.status();
    this.#chrome.runtime.sendMessage({ type: 'mbrowser.status', status }).catch(() => {});
    const text = status.siteRequest ? '!' : status.enabled ? (status.connection === 'connected' ? 'ON' : '…') : (status.paired ? 'Ⅱ' : '');
    this.#chrome.action?.setBadgeText({ text }).catch(() => {});
    this.#chrome.action?.setBadgeBackgroundColor({ color: status.enabled && !status.siteRequest ? '#1b7563' : '#8a5b1b' }).catch(() => {});
  }

  async #pair(message) {
    const port = normalizePort(message.port);
    const code = normalizePairCode(message.code);
    const grant = { enabled: false, allowExistingTabs: false, allowedOrigins: [] };
    if (this.#device.pendingRevocation && this.#device.pendingRevocation.port !== port) {
      fail('REVOCATION_PENDING', 'Inicia el Harness anterior para confirmar la revocación antes de cambiar de puerto.');
    }
    const pausing = this.#pause('PAIRING');
    const epoch = this.#epoch;
    await pausing;
    if (epoch !== this.#epoch) fail('CONSENT_CHANGED', 'La vinculación se canceló porque cambió tu autorización.');
    this.#connection = 'pairing';
    this.#notify();
    try {
      const clientNonce = newNonce();
      const binding = [port, this.#chrome.runtime.id];
      const proof = await signProof(code, 'pair/request', ...binding, clientNonce);
      if (epoch !== this.#epoch) fail('CONSENT_CHANGED', 'La vinculación se canceló.');
      const response = await this.#localFetch(port, '/pair', {
        method: 'POST', body: JSON.stringify({ nonce: clientNonce, proof }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        if ([400, 401, 403, 409, 410, 429].includes(response.status)) {
          fail('PAIRING_REJECTED', 'La conexión caducó. Elegí /mbrowser de nuevo en Harness.');
        }
        fail('BRIDGE_UNAVAILABLE', 'Harness no pudo completar la vinculación. Comprueba la conexión local.');
      }
      const data = await this.#readSmallJson(response);
      if (!isRecord(data) || data.protocol !== PROTOCOL || typeof data.nonce !== 'string' || !PROOF_PATTERN.test(data.nonce) ||
          !await verifyProof(code, data.proof, 'pair/response', ...binding, clientNonce, data.nonce)) {
        fail('PAIRING_PROTOCOL', 'No se pudo verificar Harness. Elegí /mbrowser de nuevo en Harness.');
      }
      const token = await signProof(code, 'pair/device', ...binding, clientNonce, data.nonce);
      if (epoch !== this.#epoch) {
        this.#device.pendingRevocation = { port, token };
        await this.#saveDevice();
        void this.#flushRevocation().catch(() => {});
        fail('CONSENT_CHANGED', 'La autorización cambió durante la vinculación. No se inició ninguna conexión.');
      }
      this.#device = {
        schema: 1, port, token,
        consentVersion: CONSENT_VERSION, approvedAt: new Date().toISOString(),
        grant, pendingRevocation: null,
      };
      this.#revision++;
      this.#notice = null;
      await this.#saveDevice();
      if (epoch !== this.#epoch) fail('CONSENT_CHANGED', 'La extensión quedó en pausa porque cambió tu autorización.');
      await this.#chrome.alarms.clear(REVOKE_ALARM);
      if (epoch !== this.#epoch) fail('CONSENT_CHANGED', 'La autorización cambió antes de conectar. Revisa el estado actual.');
      this.#connection = 'paused';
      this.#notify();
    } catch (error) {
      this.#connection = this.#device.token ? 'paused' : 'unpaired';
      this.#notice = error instanceof ExtensionError ? error.code : 'BRIDGE_UNAVAILABLE';
      this.#notify();
      if (!(error instanceof ExtensionError)) fail('BRIDGE_UNAVAILABLE', 'No se pudo contactar con Harness en 127.0.0.1. Comprueba el puerto y que esté abierto.');
      throw error;
    }
  }

  async #localFetch(port, path, init) {
    const controller = new AbortController();
    const timeout = timer(() => controller.abort(), 8_000);
    try {
      // Native WebIDL fetch rejects an unrelated receiver; invoke the callback standalone.
      const fetch = this.#fetch;
      return await fetch(bridgeUrl(port, path), {
        ...init,
        signal: controller.signal,
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      });
    } finally { clearTimeout(timeout); }
  }

  async #readSmallJson(response) {
    const length = response.headers.get('content-length');
    if (length && Number(length) > MAX_HTTP_BYTES) fail('PAIRING_PROTOCOL', 'La respuesta local supera el tamaño permitido.');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (encoder.encode(text).length > MAX_HTTP_BYTES) fail('PAIRING_PROTOCOL', 'La respuesta local supera el tamaño permitido.');
      try { return JSON.parse(text); } catch { fail('PAIRING_PROTOCOL', 'La respuesta local no es válida.'); }
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    const deadline = Date.now() + 8_000;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail('PAIRING_PROTOCOL', 'La respuesta local tardó demasiado en completarse.');
        const item = await bounded(reader.read(), remaining);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_HTTP_BYTES) fail('PAIRING_PROTOCOL', 'La respuesta local supera el tamaño permitido.');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)); } catch {
      fail('PAIRING_PROTOCOL', 'La respuesta local no es válida.');
    }
  }

  #scheduleIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = timer(() => { void this.#expireIdle().catch(() => {}); }, Math.max(0, this.#activeUntil - this.#now()));
    void this.#chrome.alarms.create(IDLE_ALARM, { when: this.#activeUntil }).catch(() => {});
  }

  #endActivity() {
    this.#activeUntil = 0;
    clearTimeout(this.#idleTimer);
    void this.#chrome.alarms.clear(IDLE_ALARM).catch(() => {});
  }

  #markActivity() {
    const next = this.#now() + IDLE_MS;
    if (next - this.#activeUntil < ACTIVITY_SAVE_INTERVAL_MS) return;
    this.#activeUntil = next;
    this.#scheduleIdle();
    void this.#saveSession().catch(() => {});
  }

  async #expireIdle() {
    if (this.#activeUntil && this.#now() >= this.#activeUntil) await this.#pause('IDLE');
  }

  async #activate() {
    this.#authorizationReady = false;
    this.#device.grant.enabled = true;
    this.#activeUntil = this.#now() + IDLE_MS;
    this.#scheduleIdle();
    this.#revision++;
    this.#notice = null;
    this.#sendPermissions();
    this.#invalidate(new ExtensionError('PERMISSIONS_CHANGED', 'El usuario cambió los permisos. La operación se canceló.'));
    const epoch = this.#epoch;
    this.#disconnect();
    this.#connection = 'waiting';
    this.#notify();
    await Promise.all([this.#saveDevice(), this.#saveSession(), this.#releaseAll()]);
    if (epoch !== this.#epoch) return;
    this.#authorizationReady = Boolean(this.#device.token && this.#device.grant.enabled);
    if (this.#canConnect()) this.#connect();
  }

  async #pause(notice) {
    this.#authorizationReady = false;
    this.#pendingLink = null;
    this.#endActivity();
    this.#device.grant.enabled = false;
    this.#revision++;
    this.#notice = notice;
    this.#sendPermissions();
    this.#invalidate(new ExtensionError('PAUSED', 'mbrowser está en pausa. Reanúdalo desde la extensión.'));
    this.#disconnect();
    this.#connection = this.#device.token ? 'paused' : 'unpaired';
    this.#notify();
    await Promise.all([this.#saveDevice(), this.#saveSession(), this.#releaseAll()]);
    this.#notify();
  }

  async #revoke() {
    const credential = this.#device.pendingRevocation || (this.#device.token ? { token: this.#device.token, port: this.#device.port } : null);
    await this.#pause('REVOKED');
    this.#device.token = null;
    this.#device.consentVersion = 0;
    this.#device.approvedAt = null;
    this.#device.grant = { enabled: false, allowExistingTabs: false, allowedOrigins: [] };
    this.#device.pendingRevocation = credential || null;
    this.#revision++;
    this.#connection = 'unpaired';
    this.#notice = credential ? 'REVOCATION_PENDING' : 'REVOKED';
    await this.#saveDevice();
    this.#notify();
    await this.#flushRevocation();
  }

  #flushRevocation() {
    if (this.#revoking) return this.#revoking;
    const pending = this.#device.pendingRevocation;
    if (!pending) return Promise.resolve();
    this.#revoking = (async () => {
      try {
        const binding = [pending.port, this.#chrome.runtime.id];
        const key = await signProof(pending.token, 'revoke/key', ...binding);
        const nonce = newNonce();
        const proof = await signProof(key, 'revoke/request', ...binding, nonce);
        const response = await this.#localFetch(pending.port, '/revoke', {
          method: 'POST', body: JSON.stringify({ nonce, proof }), headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) throw new Error('Revocation not confirmed');
        const data = await this.#readSmallJson(response);
        if (data?.ok !== true || !await verifyProof(key, data.proof, 'revoke/response', ...binding, nonce)) {
          throw new Error('Revocation not authenticated');
        }
        if (this.#device.pendingRevocation?.token === pending.token) {
          this.#device.pendingRevocation = null;
          if (this.#notice === 'REVOCATION_PENDING') this.#notice = 'REVOKED';
          await this.#saveDevice();
          await this.#chrome.alarms.clear(REVOKE_ALARM);
        }
      } catch {
        if (this.#device.pendingRevocation?.token === pending.token) {
          this.#notice = 'REVOCATION_PENDING';
          await this.#chrome.alarms.create(REVOKE_ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
        }
      } finally {
        this.#revoking = null;
        this.#notify();
      }
    })();
    return this.#revoking;
  }

  #canConnect() {
    return this.#storageReady && this.#authorizationReady && Boolean(this.#device.token) && this.#device.grant.enabled &&
      this.#activeUntil > this.#now() &&
      this.#device.consentVersion === CONSENT_VERSION && !this.#device.pendingRevocation;
  }

  #permissions() {
    return {
      enabled: Boolean(this.#device.token && this.#device.grant.enabled),
      allowExistingTabs: this.#device.grant.allowExistingTabs,
      allowedOrigins: [...this.#device.grant.allowedOrigins],
    };
  }

  #sendPermissions() {
    if (this.#welcomed) this.#sendFrame({ type: 'permissions', permissions: this.#permissions() });
  }

  #connect() {
    if (!this.#canConnect() || this.#socket) return;
    clearTimeout(this.#reconnectTimer);
    void this.#chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
    const serial = ++this.#socketSerial;
    let socket;
    try { socket = new this.#WebSocket(bridgeUrl(this.#device.port, '/extension', true)); } catch {
      this.#connection = 'waiting';
      this.#notice = 'BRIDGE_UNAVAILABLE';
      this.#scheduleReconnect();
      this.#notify();
      return;
    }
    this.#socket = socket;
    this.#welcomed = false;
    this.#recentIds.clear();
    this.#connection = 'connecting';
    this.#notify();
    socket.binaryType = 'arraybuffer';
    this.#authTimer = timer(() => {
      if (this.#socket === socket && !this.#welcomed) closeSocket(socket, 4000, 'authentication timeout');
    }, AUTH_TIMEOUT_MS);
    const handshake = { phase: 'proof', clientNonce: newNonce() };
    socket.onopen = () => {
      if (this.#socket !== socket || serial !== this.#socketSerial || !this.#canConnect()) return closeSocket(socket);
      this.#sendFrame({ type: 'challenge', protocol: PROTOCOL, nonce: handshake.clientNonce }, socket);
    };
    socket.onmessage = event => {
      void this.#receive(event.data, socket, serial, handshake).catch(() => {
        if (this.#socket === socket && this.#socketSerial === serial) void this.#pause('AUTH_REJECTED').catch(() => {});
      });
    };
    socket.onerror = () => {
      if (this.#socket === socket) {
        this.#notice = 'BRIDGE_UNAVAILABLE';
        this.#notify();
      }
    };
    socket.onclose = event => { void this.#closed(event, socket, serial).catch(() => {}); };
  }

  #sendFrame(frame, socket = this.#socket) {
    if (!socket || socket.readyState !== 1) return false;
    let text;
    try { text = JSON.stringify(frame); } catch { return false; }
    if (encoder.encode(text).length > MAX_RESULT_BYTES) return false;
    if (socket.bufferedAmount > 2 * MAX_RESULT_BYTES) {
      closeSocket(socket, 4013, 'backpressure');
      return false;
    }
    try { socket.send(text); return true; } catch { return false; }
  }

  async #receive(data, socket, serial, handshake) {
    if (this.#socket !== socket || this.#socketSerial !== serial) return;
    if (typeof data !== 'string' || data.length > MAX_REQUEST_BYTES || encoder.encode(data).length > MAX_REQUEST_BYTES) {
      void this.#pause('PROTOCOL_ERROR').catch(() => {});
      return;
    }
    let message;
    try { message = JSON.parse(data); } catch { void this.#pause('PROTOCOL_ERROR').catch(() => {}); return; }
    if (!isRecord(message) || typeof message.type !== 'string') { void this.#pause('PROTOCOL_ERROR').catch(() => {}); return; }
    this.#lastReceived = Date.now();
    if (!this.#welcomed) {
      if (handshake.phase === 'proof' && message.type === 'proof' && message.protocol === PROTOCOL &&
          typeof message.nonce === 'string' && PROOF_PATTERN.test(message.nonce)) {
        handshake.phase = 'verifying';
        const key = this.#device.token;
        const binding = [this.#device.port, this.#chrome.runtime.id, handshake.clientNonce, message.nonce];
        if (!key || !await verifyProof(key, message.proof, 'socket/host', ...binding)) {
          fail('AUTH_REJECTED', 'El servidor local no pudo demostrar su identidad.');
        }
        const instanceId = this.#instanceId;
        const permissions = this.#permissions();
        const proof = await signProof(key, 'socket/extension', ...binding, instanceId, permissions);
        if (this.#socket !== socket || this.#socketSerial !== serial || !this.#canConnect()) return;
        handshake.phase = 'welcome';
        this.#sendFrame({ type: 'hello', protocol: PROTOCOL, instanceId, permissions, proof }, socket);
        return;
      }
      if (handshake.phase !== 'welcome' || message.type !== 'welcome' || message.protocol !== PROTOCOL) {
        fail('AUTH_REJECTED', 'El servidor local no pudo demostrar su identidad.');
      }
      clearTimeout(this.#authTimer);
      this.#welcomed = true;
      this.#connection = 'connected';
      this.#notice = null;
      this.#backoff = 0;
      void this.#chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
      this.#heartbeatTimer = setInterval(() => {
        if (this.#socket !== socket || !this.#canConnect()) return;
        if (Date.now() - this.#lastReceived > 65_000) closeSocket(socket, 4000, 'heartbeat timeout');
        else this.#sendFrame({ type: 'ping' });
      }, HEARTBEAT_MS);
      this.#heartbeatTimer?.unref?.();
      this.#notify();
      return;
    }
    switch (message.type) {
      case 'ping': this.#sendFrame({ type: 'pong' }); break;
      case 'pong': break;
      case 'command': void this.#runCommand(message, socket, serial); break;
      case 'cancel':
        if (!validRequestId(message.id)) { void this.#pause('PROTOCOL_ERROR').catch(() => {}); break; }
        this.#cancelCommand(message.id);
        break;
      default: void this.#pause('PROTOCOL_ERROR').catch(() => {});
    }
  }

  async #closed(event, socket, serial) {
    if (this.#socket !== socket || this.#socketSerial !== serial) return;
    this.#socket = null;
    this.#socketSerial++;
    this.#clearConnectionTimers();
    const authenticated = this.#welcomed;
    this.#welcomed = false;
    this.#invalidate(new ExtensionError('DISCONNECTED', 'Se perdió la conexión con Harness. La operación no se reintentó.'));
    if (event.code === 1008) {
      this.#authorizationReady = false;
      this.#endActivity();
      if (authenticated) {
        this.#device.token = null;
        this.#device.consentVersion = 0;
      }
      this.#device.grant.enabled = false;
      this.#revision++;
      this.#notice = 'AUTH_REJECTED';
      this.#connection = this.#device.token ? 'paused' : 'unpaired';
      await this.#saveDevice().catch(() => {});
    } else if (authenticated && event.code === 1000 && event.reason === 'replaced') {
      this.#authorizationReady = false;
      this.#endActivity();
      this.#device.grant.enabled = false;
      this.#revision++;
      this.#notice = 'CONNECTION_REPLACED';
      this.#connection = 'paused';
      await this.#saveDevice().catch(() => {});
    } else {
      this.#notice = this.#device.grant.enabled ? 'BRIDGE_UNAVAILABLE' : this.#notice;
      this.#connection = this.#device.token ? (this.#device.grant.enabled ? 'waiting' : 'paused') : 'unpaired';
    }
    const closedSerial = this.#socketSerial;
    await this.#releaseAll();
    this.#notify();
    if (closedSerial === this.#socketSerial && this.#canConnect()) this.#scheduleReconnect();
  }

  #clearConnectionTimers() {
    clearTimeout(this.#authTimer);
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#reconnectTimer);
  }

  #disconnect() {
    const socket = this.#socket;
    this.#socket = null;
    this.#socketSerial++;
    this.#welcomed = false;
    this.#clearConnectionTimers();
    void this.#chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
    closeSocket(socket);
  }

  #scheduleReconnect() {
    if (!this.#canConnect()) return;
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.#backoff++, 5)));
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = timer(() => this.#connect(), delay);
    // A single alarm wakes a suspended worker; no periodic polling while connected or deliberately paused.
    void this.#chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + Math.max(30_000, delay) }).catch(() => {});
  }

  async handleAlarm(alarm) {
    await this.ready;
    if (alarm.name === RECONNECT_ALARM && this.#canConnect()) this.#connect();
    if (alarm.name === REVOKE_ALARM) await this.#flushRevocation();
    if (alarm.name === IDLE_ALARM) await this.#expireIdle();
  }

  async handleStartup() {
    await this.ready;
    if (this.#device.pendingRevocation) await this.#flushRevocation();
    if (this.#canConnect()) this.#connect();
  }

  #invalidate(reason) {
    this.#epoch++;
    this.#siteRequest = null;
    for (const context of this.#inFlight.values()) context.controller.abort(reason);
    for (const id of this.#contexts.keys()) this.#clearDocument(id);
    this.#mainFrames.clear();
  }

  #assertContext(context) {
    if (context.controller.signal.aborted) throw context.controller.signal.reason;
    if (context.epoch !== this.#epoch) fail('PERMISSIONS_CHANGED', 'Los permisos cambiaron durante la operación.');
    if (!this.#canConnect() || !this.#welcomed) fail('PAUSED', 'La extensión no está conectada y autorizada.');
    if (context.socket !== this.#socket || context.serial !== this.#socketSerial) fail('DISCONNECTED', 'La conexión cambió. No se reintentó la operación.');
    if (context.tabId && !context.navigation && !context.closing && context.tabRevision !== (this.#tabRevision.get(context.tabId) || 0)) {
      fail('CDP_CONTEXT_GONE', 'El documento cambió durante la operación. Obtén una nueva observación.');
    }
  }

  #awaitContext(context, operation) {
    this.#assertContext(context);
    return new Promise((resolve, reject) => {
      const signal = context.controller.signal;
      const aborted = () => reject(signal.reason || new ExtensionError('ABORTED', 'La operación se canceló.'));
      signal.addEventListener('abort', aborted, { once: true });
      let promise;
      try { promise = operation(); } catch (error) { signal.removeEventListener('abort', aborted); reject(error); return; }
      Promise.resolve(promise).then(value => {
        signal.removeEventListener('abort', aborted);
        try { this.#assertContext(context); resolve(value); } catch (error) { reject(error); }
      }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    });
  }

  #cancelCommand(id) {
    const context = this.#inFlight.get(id);
    if (!context) return;
    context.controller.abort(new ExtensionError('ABORTED', 'Harness canceló la operación. No se reintentará.'));
    if (context.tabId) {
      this.#clearDocument(context.tabId);
      void this.#releaseTab(context.tabId).catch(() => {});
    }
  }

  async #runCommand(message, socket, serial) {
    const id = message.id;
    if (!validRequestId(id)) { void this.#pause('PROTOCOL_ERROR').catch(() => {}); return; }
    const replyError = error => {
      if (this.#socket === socket && this.#socketSerial === serial) {
        this.#sendFrame({ type: 'result', id, ok: false, error: safeError(error) }, socket);
      }
    };
    if (this.#inFlight.has(id) || this.#recentIds.has(id)) {
      replyError(new ExtensionError('DUPLICATE_COMMAND', 'La orden ya fue recibida. No se ejecutó de nuevo.'));
      return;
    }
    if (this.#inFlight.size >= MAX_IN_FLIGHT) {
      replyError(new ExtensionError('BUSY', 'Hay demasiadas operaciones pendientes.'));
      return;
    }
    const context = {
      id, socket, serial, epoch: this.#epoch, controller: new AbortController(),
      tabId: null, tabRevision: 0, navigation: false,
    };
    this.#inFlight.set(id, context);
    const timeout = timer(() => {
      context.controller.abort(new ExtensionError('TIMEOUT', 'La operación superó su tiempo máximo de espera.'));
      if (context.tabId) void this.#releaseTab(context.tabId).catch(() => {});
    }, MAX_COMMAND_MS);
    try {
      this.#assertContext(context);
      const result = await this.#execute(message.method, message.params, context);
      this.#assertContext(context);
      if (message.method === 'open' || message.method === 'send') this.#markActivity();
      const sent = this.#sendFrame({ type: 'result', id, ok: true, result }, socket);
      if (!sent && this.#socket === socket && socket.readyState === 1) {
        replyError(new ExtensionError('RESULT_TOO_LARGE', 'El resultado supera el tamaño permitido. Reduce la observación.'));
      }
    } catch (error) { replyError(error); } finally {
      clearTimeout(timeout);
      if (this.#inFlight.get(id) === context) this.#inFlight.delete(id);
      if (this.#tabBusy.get(context.tabId) === context) this.#tabBusy.delete(context.tabId);
      if (this.#socket === socket && this.#socketSerial === serial) {
        this.#recentIds.add(id);
        if (this.#recentIds.size > 512) this.#recentIds.delete(this.#recentIds.values().next().value);
      }
    }
  }

  #lockTab(context, id) {
    if (this.#tabBusy.has(id) && this.#tabBusy.get(id) !== context) fail('TAB_BUSY', 'Otra operación está usando esta pestaña.');
    context.tabId = id;
    context.tabRevision = this.#tabRevision.get(id) || 0;
    this.#tabBusy.set(id, context);
  }

  #checkTabGrant(tab, id, { ownOnly = false } = {}) {
    if (!tab || tab.id !== id || tab.incognito) fail('TAB_NOT_FOUND', 'La pestaña no está disponible.');
    if (!this.#owned.has(id) && (ownOnly || !this.#device.grant.allowExistingTabs)) {
      fail(ownOnly ? 'TAB_NOT_OWNED' : 'EXISTING_TAB_DENIED', ownOnly ? 'Solo se pueden cerrar pestañas creadas por mbrowser en esta sesión.' : 'El acceso a pestañas que ya existían no está autorizado.');
    }
    if (!isAllowedUrl(tab.url, this.#device.grant.allowedOrigins) ||
        (tab.pendingUrl && !isAllowedUrl(tab.pendingUrl, this.#device.grant.allowedOrigins))) {
      fail('ORIGIN_NOT_ALLOWED', 'La pestaña o su navegación pendiente no pertenece a los sitios autorizados.');
    }
    return tab;
  }

  #checkBackground(tab) {
    if (tab.active !== false) fail('TAB_IN_USE', 'Esta pestaña está seleccionada en Chrome. Cámbiate a otra para que mbrowser pueda usarla.');
  }

  #commandParams(params, names) {
    if (!isRecord(params) || Object.keys(params).some(key => !names.includes(key))) fail('INVALID_ARGUMENT', 'Los parámetros de la orden no son válidos.');
  }

  async #awaitSiteApproval(url, context) {
    if (isAllowedUrl(url, this.#device.grant.allowedOrigins)) return;
    if (this.#siteRequest) fail('SITE_APPROVAL_PENDING', 'Ya hay un sitio esperando tu decisión en el panel de mbrowser.');
    if (this.#device.grant.allowedOrigins.length >= 100) fail('SITE_LIMIT', 'Se alcanzó el límite de sitios para esta conexión.');
    const [origin] = normalizeAllowedOrigins([new URL(url).origin], { allowWildcard: false });
    let decide;
    const answer = new Promise(resolve => { decide = resolve; });
    const pending = { id: crypto.randomUUID(), origin, decide };
    this.#siteRequest = pending;
    this.#notify();
    const deadline = timer(() => decide(null), SITE_APPROVAL_MS);
    try {
      const allowed = await this.#awaitContext(context, () => answer);
      if (allowed === null) fail('SITE_APPROVAL_TIMEOUT', 'Abrí el panel de mbrowser y volvé a pedir la página para autorizarla.');
      if (!allowed) fail('SITE_APPROVAL_DENIED', 'El usuario rechazó el acceso a este sitio.');
    } finally {
      clearTimeout(deadline);
      if (this.#siteRequest === pending) {
        this.#siteRequest = null;
        this.#notify();
      }
    }
  }

  async #decideSite({ id, allow }) {
    const pending = this.#siteRequest;
    if (!pending || id !== pending.id || typeof allow !== 'boolean' || !this.#welcomed) {
      fail('STALE_SETTINGS', 'Esta solicitud ya no está activa.');
    }
    if (allow) {
      const epoch = this.#epoch;
      const grant = { ...this.#device.grant, allowedOrigins: [...this.#device.grant.allowedOrigins, pending.origin] };
      const device = { ...this.#device, grant };
      await this.#saveDevice(device);
      if (epoch !== this.#epoch || this.#siteRequest !== pending) {
        await this.#saveDevice();
        fail('STALE_SETTINGS', 'Esta solicitud ya no está activa.');
      }
      this.#device = device;
      this.#revision++;
      this.#sendPermissions();
    }
    pending.decide(allow);
  }

  async #execute(method, params, context) {
    switch (method) {
      case 'tabs': {
        this.#commandParams(params, []);
        const tabs = await this.#awaitContext(context, () => this.#chrome.tabs.query({}));
        return tabs.filter(tab => {
          if (!validChromeTabId(tab.id) || (!this.#owned.has(tab.id) && tab.active !== false)) return false;
          try { this.#checkTabGrant(tab, tab.id); return true; } catch { return false; }
        }).map(tab => ({
          id: `ext:${tab.id}`, title: tab.title || '', url: tab.url,
          active: Boolean(tab.active), owned: this.#owned.has(tab.id),
        }));
      }
      case 'open': return this.#open(params, context);
      case 'close': {
        this.#commandParams(params, ['tab_id']);
        const id = parseTabId(params.tab_id);
        this.#lockTab(context, id);
        if (!this.#owned.has(id)) fail('TAB_NOT_OWNED', 'Solo se pueden cerrar pestañas creadas por mbrowser en esta sesión.');
        const tab = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
        if (tab.id !== id || tab.incognito) fail('TAB_NOT_FOUND', 'La pestaña ya no está disponible.');
        this.#checkBackground(tab);
        // Lifecycle-only exception: closing our exact tab never reads a now-unapproved document.
        await this.#awaitContext(context, () => this.#releaseTab(id));
        const after = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
        this.#checkBackground(after);
        context.closing = true;
        await this.#awaitContext(context, () => this.#chrome.tabs.remove(id));
        this.#owned.delete(id);
        await this.#saveSession();
        this.#notify();
        return { closed: true };
      }
      case 'detach': {
        this.#commandParams(params, ['tab_id']);
        const id = parseTabId(params.tab_id);
        this.#lockTab(context, id);
        // Releasing our own attachment is safe even after a user navigation left the grant.
        await this.#awaitContext(context, () => this.#releaseTab(id));
        return { detached: true };
      }
      case 'cursor': {
        this.#commandParams(params, ['tab_id', 'x', 'y']);
        const id = parseTabId(params.tab_id);
        this.#lockTab(context, id);
        if (![params.x, params.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
          fail('INVALID_ARGUMENT', 'La posición del cursor está fuera de la pestaña.');
        }
        const tab = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
        this.#checkTabGrant(tab, id);
        this.#checkBackground(tab);
        if (this.#owned.has(id)) this.#cursor.set(id, { x: params.x, y: params.y, until: Date.now() + 3500 });
        return {};
      }
      case 'send': return this.#sendCdp(params, context);
      default: fail('METHOD_NOT_ALLOWED', 'La extensión no admite esa operación.');
    }
  }

  async #open(params, context) {
    this.#commandParams(params, ['url', 'visible']);
    if (params.visible !== undefined && typeof params.visible !== 'boolean') fail('INVALID_ARGUMENT', 'La visibilidad debe ser un valor booleano.');
    if (params.visible === true) fail('BACKGROUND_ONLY', 'mbrowser abre pestañas en segundo plano. Usa el panel de actividad para verlas.');
    const url = normalizeWebUrl(params.url);
    await this.#awaitSiteApproval(url, context);
    this.#assertContext(context);
    if (!isAllowedUrl(url, this.#device.grant.allowedOrigins)) fail('ORIGIN_NOT_ALLOWED', 'Ese sitio no está autorizado.');
    context.navigation = true;
    let createdId = null;
    const creation = this.#chrome.tabs.create({ url, active: false }).then(async tab => {
      if (!validChromeTabId(tab?.id)) fail('TAB_NOT_FOUND', 'Chrome no devolvió una pestaña válida.');
      createdId = tab.id;
      this.#owned.add(tab.id);
      this.#lockTab(context, tab.id);
      try {
        await this.#saveSession();
        this.#assertContext(context);
      } catch (error) {
        await this.#discardNewTab(tab.id);
        throw error;
      }
      return tab;
    });
    try {
      const tab = await this.#awaitContext(context, () => creation);
      const ready = await this.#waitForInitialUrl(tab.id, context);
      this.#checkTabGrant(ready, tab.id, { ownOnly: true });
      this.#checkBackground(ready);
      this.#notify();
      return { id: `ext:${tab.id}`, title: ready.title || '', url: ready.pendingUrl || ready.url || url };
    } catch (error) {
      if (createdId !== null) await this.#discardNewTab(createdId);
      throw error;
    }
  }

  async #discardNewTab(id) {
    if (!this.#owned.has(id)) return;
    try {
      const tab = await this.#chrome.tabs.get(id);
      if (tab.id === id && !tab.incognito && tab.active === false && this.#owned.has(id)) await this.#chrome.tabs.remove(id);
    } catch { /* May already be closed. */ }
    this.#owned.delete(id);
    this.#tabBusy.delete(id);
    this.#clearDocument(id);
    await this.#saveSession();
    this.#notify();
  }

  #waitForInitialUrl(id, context) {
    return this.#awaitContext(context, () => new Promise((resolve, reject) => {
      let deadline;
      let done = false;
      const signal = context.controller.signal;
      const cleanup = () => {
        clearTimeout(deadline);
        signal.removeEventListener('abort', aborted);
        this.#chrome.tabs.onUpdated.removeListener(updated);
        this.#chrome.tabs.onRemoved.removeListener(removed);
      };
      const finish = (error, tab) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error); else resolve(tab);
      };
      const check = tab => {
        if (tab.pendingUrl && !isAllowedUrl(tab.pendingUrl, this.#device.grant.allowedOrigins)) {
          finish(new ExtensionError('ORIGIN_NOT_ALLOWED', 'La navegación salió del alcance autorizado.'));
        } else if (tab.url && /^https?:\/\//i.test(tab.url)) {
          try { this.#checkTabGrant(tab, id, { ownOnly: true }); finish(null, tab); } catch (error) { finish(error); }
        } else if (tab.url && tab.url !== 'about:blank') {
          finish(new ExtensionError('ORIGIN_NOT_ALLOWED', 'Chrome abrió una página que no se puede automatizar.'));
        }
      };
      const updated = (tabId, _change, tab) => { if (tabId === id) check(tab); };
      const removed = tabId => { if (tabId === id) finish(new ExtensionError('TAB_NOT_FOUND', 'La pestaña se cerró antes de estar lista.')); };
      const aborted = () => finish(signal.reason || new ExtensionError('ABORTED', 'La apertura se canceló.'));
      this.#chrome.tabs.onUpdated.addListener(updated);
      this.#chrome.tabs.onRemoved.addListener(removed);
      signal.addEventListener('abort', aborted, { once: true });
      deadline = timer(() => finish(new ExtensionError('TIMEOUT', 'La pestaña no inició una navegación web a tiempo.')), 10_000);
      this.#chrome.tabs.get(id).then(check, () => finish(new ExtensionError('TAB_NOT_FOUND', 'La pestaña ya no existe.')));
    }));
  }

  async #sendCdp(params, context) {
    this.#commandParams(params, ['tab_id', 'method', 'params']);
    const id = parseTabId(params.tab_id);
    validateCdp(params.method, params.params);
    this.#lockTab(context, id);
    if (params.method === 'Page.navigate') {
      if (!isAllowedUrl(params.params.url, this.#device.grant.allowedOrigins)) fail('ORIGIN_NOT_ALLOWED', 'El destino no está autorizado.');
      context.navigation = true;
      this.#clearDocument(id);
    }
    const tab = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
    this.#checkTabGrant(tab, id);
    this.#checkBackground(tab);
    await this.#ensureAttached(id, context);
    if (params.method === 'Page.createIsolatedWorld' && this.#mainFrames.get(id) !== params.params.frameId) {
      fail('FRAME_NOT_ALLOWED', 'Solo se permite el documento principal de esta pestaña.');
    }
    if (params.method === 'Runtime.evaluate' && !this.#contexts.get(id)?.has(params.params.contextId)) {
      if (this.#expiredContexts.get(id)?.has(params.params.contextId)) {
        fail('CDP_CONTEXT_GONE', 'El contexto aislado cambió. Obtén una nueva observación.');
      }
      fail('ACCESS_DENIED', 'El contexto solicitado no fue creado por mbrowser para este documento.');
    }
    // Prefix a random browser-lifetime namespace without collapsing the peer's distinct scope/navigation worlds.
    let nativeParams = params.params;
    if (params.method === 'Page.createIsolatedWorld') {
      const hash = await this.#awaitContext(context, () => crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.params.worldName)));
      const suffix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      nativeParams = { ...params.params, worldName: `mbrowser:${this.#instanceId}:${suffix}` };
    }
    // Check again after the asynchronous attach and any preparation, immediately before dispatch.
    const target = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
    this.#checkTabGrant(target, id);
    this.#checkBackground(target);
    let result;
    try {
      result = await this.#awaitContext(context, () => this.#chrome.debugger.sendCommand({ tabId: id }, params.method, nativeParams));
    } catch (error) {
      const safe = safeError(error);
      if (safe.code === 'CDP_CONTEXT_GONE') this.#clearDocument(id);
      throw error;
    }
    if (params.method === 'Runtime.evaluate' && result?.exceptionDetails) {
      fail('JS_EVALUATION_FAILED', 'El código no pudo ejecutarse en el documento. Los detalles se omiten para proteger datos sensibles.');
    }
    const after = await this.#awaitContext(context, () => this.#chrome.tabs.get(id));
    this.#checkTabGrant(after, id);
    this.#checkBackground(after);
    if (params.method === 'Page.getFrameTree' && typeof result?.frameTree?.frame?.id === 'string') {
      this.#mainFrames.set(id, result.frameTree.frame.id);
    }
    if (params.method === 'Page.createIsolatedWorld' && Number.isSafeInteger(result?.executionContextId)) {
      if (!this.#contexts.has(id)) this.#contexts.set(id, new Set());
      this.#contexts.get(id).add(result.executionContextId);
      await this.#saveSession();
    }
    return result || {};
  }

  async #ensureAttached(id, context) {
    const releasing = this.#releasing.get(id);
    if (releasing) await this.#awaitContext(context, () => releasing);
    if (this.#attached.has(id)) { this.#expectedDetach.delete(id); return; }
    let attaching = this.#attaching.get(id);
    if (!attaching) {
      this.#expectedDetach.delete(id);
      attaching = this.#chrome.debugger.attach({ tabId: id }, '1.3').then(async () => {
        this.#attached.add(id);
        await this.#saveSession();
        this.#notify();
      });
      this.#attaching.set(id, attaching);
      const cleanup = () => { if (this.#attaching.get(id) === attaching) this.#attaching.delete(id); };
      attaching.then(cleanup, cleanup);
      attaching.then(() => {
        try { this.#assertContext(context); } catch { void this.#releaseTab(id).catch(() => {}); }
      }, () => {});
    }
    try { await this.#awaitContext(context, () => attaching); } catch (error) {
      if (safeError(error).code === 'DEBUGGER_BUSY') void this.#pause('DEBUGGER_BUSY').catch(() => {});
      throw error;
    }
  }

  #clearDocument(id) {
    this.#cursor.delete(id);
    const issued = this.#contexts.get(id);
    if (issued?.size) {
      if (!this.#expiredContexts.has(id)) this.#expiredContexts.set(id, new Set());
      const expired = this.#expiredContexts.get(id);
      for (const contextId of issued) expired.add(contextId);
      while (expired.size > 256) expired.delete(expired.values().next().value);
      while (this.#expiredContexts.size > 128) this.#expiredContexts.delete(this.#expiredContexts.keys().next().value);
    }
    this.#mainFrames.delete(id);
    this.#contexts.delete(id);
  }

  #releaseTab(id) {
    if (this.#releasing.has(id)) return this.#releasing.get(id);
    const releasing = (async () => {
      const attaching = this.#attaching.get(id);
      if (attaching) await bounded(attaching, 2500).catch(() => {});
      if (!this.#attached.has(id)) { this.#clearDocument(id); return; }
      this.#expectedDetach.add(id);
      try {
        const detach = this.#chrome.debugger.detach({ tabId: id });
        detach.then(() => {
          this.#attached.delete(id);
          this.#clearDocument(id);
          void this.#saveSession().catch(() => {});
          this.#notify();
        }, () => {});
        await bounded(detach, 2500);
        this.#attached.delete(id);
      } catch (error) {
        this.#expectedDetach.delete(id);
        const code = safeError(error).code;
        if (code === 'DEBUGGER_DETACHED' || code === 'TAB_NOT_FOUND') this.#attached.delete(id);
        else this.#notice = 'DETACH_INCOMPLETE';
      }
      this.#clearDocument(id);
      await this.#saveSession().catch(() => {});
      this.#notify();
    })();
    this.#releasing.set(id, releasing);
    const cleanup = () => { if (this.#releasing.get(id) === releasing) this.#releasing.delete(id); };
    releasing.then(cleanup, cleanup);
    return releasing;
  }

  async #releaseAll() {
    await Promise.allSettled([...new Set([...this.#attached, ...this.#attaching.keys()])].map(id => this.#releaseTab(id)));
  }

  async handleDebuggerDetach(source, reason) {
    await this.ready;
    const id = source?.tabId;
    if (!validChromeTabId(id)) return;
    const expected = this.#expectedDetach.delete(id);
    this.#attached.delete(id);
    this.#clearDocument(id);
    if (!expected) {
      for (const context of this.#inFlight.values()) {
        if (context.tabId === id) context.controller.abort(new ExtensionError('DEBUGGER_DETACHED', 'Chrome desconectó la depuración de la pestaña.'));
      }
    }
    // Flip the grant synchronously before any storage await; never reattach after a user cancellation.
    const pause = !expected && reason !== 'target_closed' ? this.#pause('DETACHED_BY_USER') : Promise.resolve();
    await Promise.all([this.#saveSession().catch(() => {}), pause]);
    this.#notify();
  }

  async handleTabActivated(id) {
    await this.ready;
    const context = this.#tabBusy.get(id);
    if (!context && !this.#attached.has(id) && !this.#attaching.has(id)) return;
    context?.controller.abort(new ExtensionError('TAB_IN_USE', 'Seleccionaste esta pestaña. mbrowser cedió el control.'));
    this.#tabRevision.set(id, (this.#tabRevision.get(id) || 0) + 1);
    this.#clearDocument(id);
    await this.#releaseTab(id);
  }

  async handleTabUpdated(id, change, tab) {
    await this.ready;
    if (!this.#owned.has(id) && !this.#attached.has(id) && !this.#tabBusy.has(id)) return;
    if (change.url !== undefined || change.status === 'loading') {
      this.#tabRevision.set(id, (this.#tabRevision.get(id) || 0) + 1);
      this.#clearDocument(id);
      for (const context of this.#inFlight.values()) {
        if (context.tabId === id && !context.navigation) context.controller.abort(new ExtensionError('CDP_CONTEXT_GONE', 'La pestaña navegó a otro documento. Obtén una nueva observación.'));
      }
    }
    const permitted = isAllowedUrl(tab.url, this.#device.grant.allowedOrigins) &&
      (!tab.pendingUrl || isAllowedUrl(tab.pendingUrl, this.#device.grant.allowedOrigins));
    if (!permitted && this.#attached.has(id)) {
      for (const context of this.#inFlight.values()) {
        if (context.tabId === id) context.controller.abort(new ExtensionError('ORIGIN_NOT_ALLOWED', 'La navegación salió del alcance autorizado.'));
      }
      await this.#releaseTab(id);
    }
  }

  async handleTabRemoved(id) {
    await this.ready;
    this.#owned.delete(id);
    this.#attached.delete(id);
    this.#expectedDetach.delete(id);
    this.#clearDocument(id);
    this.#expiredContexts.delete(id);
    this.#tabRevision.delete(id);
    for (const context of this.#inFlight.values()) {
      if (context.tabId === id && !context.closing) context.controller.abort(new ExtensionError('TAB_NOT_FOUND', 'La pestaña se cerró.'));
    }
    await this.#saveSession().catch(() => {});
    this.#notify();
  }

  async handleTabReplaced(_addedId, removedId) {
    // Prerender/replacement IDs are not adopted. A reused Chrome integer never establishes ownership.
    await this.handleTabRemoved(removedId);
  }
}
