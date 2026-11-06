import { bridgeError } from './bridge.js';

const TAB_ID = /^ext:[1-9][0-9]*$/;
const METHODS = new Set([
  'Page.enable', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Page.navigate',
  'Runtime.evaluate',
  'Emulation.setFocusEmulationEnabled',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
]);

function validTab(id) {
  if (typeof id !== 'string' || !TAB_ID.test(id)) throw bridgeError('INVALID_TAB', 'Usá un tab_id ext:… de mbrowser_open o mbrowser_tabs.');
  return id;
}
function tabInfo(tab) {
  if (!tab || typeof tab !== 'object') throw bridgeError('INVALID_RESPONSE', 'Chrome devolvió una pestaña no válida.');
  return {
    id: validTab(tab.id),
    title: typeof tab.title === 'string' ? tab.title.slice(0, 1000) : '',
    url: typeof tab.url === 'string' ? tab.url.slice(0, 8192) : '',
    active: tab.active === true,
    owned: tab.owned === true,
  };
}

/** Maps the engine contract to the authenticated extension; never falls back to CDP. */
export class ExtensionTransport {
  constructor({ bridge } = {}) {
    if (!bridge?.request) throw bridgeError('INVALID_BRIDGE', 'Falta el puente de la extensión.');
    this.bridge = bridge;
    this.kind = 'extension';
    this.approvesSitesOnOpen = true;
    this.disposed = false;
  }
  get browserId() { return this.bridge.browserId; }
  get permissions() { return this.bridge.permissions; }
  async status() { return this.bridge.status(); }
  _assertActive() { if (this.disposed) throw bridgeError('DISPOSED', 'El transporte de mbrowser fue descargado.'); }
  async listTabs(options) {
    this._assertActive();
    const tabs = await this.bridge.request('tabs', {}, options);
    if (!Array.isArray(tabs) || tabs.length > 10_000) throw bridgeError('INVALID_RESPONSE', 'Chrome devolvió una lista de pestañas no válida.');
    return tabs.map(tabInfo);
  }
  async createTab({ url, visible = false }, options) {
    this._assertActive();
    return tabInfo(await this.bridge.request('open', { url, visible: visible === true }, options));
  }
  async closeTab(id, options) {
    this._assertActive();
    return this.bridge.request('close', { tab_id: validTab(id) }, options);
  }
  async send(id, method, params = {}, options) {
    this._assertActive();
    if (!METHODS.has(method)) throw bridgeError('UNSUPPORTED_CDP', 'Método de navegador no admitido por mbrowser.');
    return this.bridge.request('send', { tab_id: validTab(id), method, params }, options);
  }
  async markCursor(id, position, options) {
    return this.bridge.request('cursor', { tab_id: validTab(id), ...position }, options);
  }

  async detach(id, options) {
    this._assertActive();
    return this.bridge.request('detach', { tab_id: validTab(id) }, options);
  }
  async dispose() { this.disposed = true; }
}
