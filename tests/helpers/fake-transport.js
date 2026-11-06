/** A contract-level fake, not a browser. Tests must not claim DOM behavior from this helper. */
export class FakeTransport {
  constructor({ kind = 'cdp', browserId = 'browser-A', permissions, tabs = [], send } = {}) {
    this.kind = kind;
    this.browserId = browserId;
    this.permissions = permissions;
    this.tabMap = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
    this.calls = [];
    this.nextId = 100;
    this.disposed = false;
    this.sendHandler = send;
  }

  async status() {
    this.calls.push({ method: 'status' });
    return { kind: this.kind, connected: !this.disposed, browserId: this.browserId };
  }

  async listTabs() {
    this.calls.push({ method: 'listTabs' });
    return [...this.tabMap.values()].map((tab) => ({ ...tab }));
  }

  async createTab({ url, visible }) {
    this.calls.push({ method: 'createTab', url, visible });
    const id = this.kind === 'extension' ? `ext:${this.nextId++}` : `target-${this.nextId++}`;
    const tab = { id, url, title: 'Test tab', active: visible === true, owned: true };
    this.tabMap.set(id, tab);
    return { ...tab };
  }

  async closeTab(id) {
    this.calls.push({ method: 'closeTab', id });
    if (!this.tabMap.delete(id)) throw Object.assign(new Error('Missing fake tab'), { code: 'TAB_NOT_FOUND' });
    return { closed: id };
  }

  async send(id, method, params = {}, options = {}) {
    this.calls.push({ method: 'send', id, cdpMethod: method, params, options });
    if (!this.tabMap.has(id)) throw Object.assign(new Error('Missing fake tab'), { code: 'TAB_NOT_FOUND' });
    if (this.sendHandler) {
      const value = await this.sendHandler({ id, method, params, options, transport: this });
      if (value !== undefined) return value;
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: `frame-${id}`, url: this.tabMap.get(id).url } } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') return { result: { type: 'undefined' } };
    if (method === 'Page.navigate') {
      this.tabMap.get(id).url = params.url;
      return { frameId: `frame-${id}` };
    }
    return {};
  }

  async detach(id) { this.calls.push({ method: 'detach', id }); return { detached: true }; }
  async dispose() { this.calls.push({ method: 'dispose' }); this.disposed = true; }
}
