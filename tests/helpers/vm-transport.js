import { FakeTransport } from './fake-transport.js';
import { createPageVm } from './page-vm.js';

/** Contract fake executing the real page expression against a deliberately small DOM model. */
export class VMTransport extends FakeTransport {
  constructor({ beforeSend, ...options } = {}) {
    super(options);
    this.pages = new Map();
    this.loaders = new Map();
    this.worldIds = new Map();
    this.nextWorldId = 1;
    this.beforeSend = beforeSend;
    this.sendHandler = async (request) => {
      const override = await this.beforeSend?.(request);
      if (override !== undefined) return override;
      const { id, method, params } = request;
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${id}`, loaderId: `loader-${this.loaders.get(id) || 0}`, url: this.tabMap.get(id).url } } };
      if (method === 'Page.createIsolatedWorld') {
        const key = `${id}:${params.worldName}`;
        if (!this.worldIds.has(key)) this.worldIds.set(key, this.nextWorldId++);
        return { executionContextId: this.worldIds.get(key) };
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: await this.pageFor(id).evaluate(params.expression) } };
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        this.pageFor(id).document.elementFromPoint(params.x, params.y)?.focus();
        return {};
      }
      if (method === 'Page.navigate') {
        this.tabMap.get(id).url = params.url;
        this.pageFor(id).location.href = params.url;
        this.loaders.set(id, (this.loaders.get(id) || 0) + 1);
        return { frameId: `frame-${id}` };
      }
    };
  }
  pageFor(id) {
    if (!this.pages.has(id)) this.pages.set(id, createPageVm({ url: this.tabMap.get(id)?.url }));
    return this.pages.get(id);
  }
  async dispose() { for (const page of this.pages.values()) page.dispose(); await super.dispose(); }
}
