import vm from 'node:vm';
import { pageExpression } from '../../lib/page-functions.js';

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Small explicit DOM model for page-helper logic, NOT a rendering engine or trusted-input test.
 * Real layout, React event semantics, focus, and Chrome behavior belong to the gated live suite.
 */
export class TestElement {
  constructor(document, tagName, { id, text = '', value, type, attrs = {}, rect, style = {}, disabled = false, readOnly = false, editable = false } = {}) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attrs).map(([key, val]) => [key, String(val)]));
    if (id) this.attributes.set('id', id);
    if (type) this.attributes.set('type', type);
    if (value !== undefined) this.attributes.set('value', value);
    this._value = value ?? '';
    this._text = text;
    this.children = [];
    this.parentNode = null;
    this.style = { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible', ...style };
    this.rect = rect || { x: 20, y: 20, left: 20, top: 20, width: 160, height: 30, right: 180, bottom: 50 };
    this.disabled = disabled;
    this.readOnly = readOnly;
    this.isContentEditable = editable;
    this.inert = false;
    this.shadowRoot = null;
    this.scrollCount = 0;
    this.scrollWrites = [];
    this.scrollLeft = 0; this.scrollTop = 0;
    this.clientWidth = this.rect.width; this.clientHeight = this.rect.height;
    this.scrollWidth = this.clientWidth; this.scrollHeight = this.clientHeight;
    this.focusCount = 0;
  }
  get id() { return this.getAttribute('id') || ''; }
  get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get defaultValue() { return this.getAttribute('value') || ''; }
  get href() { const href = this.getAttribute('href'); return href ? new URL(href, this.ownerDocument.location.href).href : ''; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; this.ownerDocument.notify(); }
  get innerText() {
    if (this.style.display === 'none' || this.getAttribute('hidden') !== null) return '';
    return this._text + this.children.map((child) => child.innerText).join(' ');
  }
  set innerText(value) { this.textContent = value; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    const root = this.getRootNode();
    return root === this.ownerDocument || Boolean(root?.host?.isConnected);
  }
  getRootNode() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); this.ownerDocument.notify(); }
  removeAttribute(name) { this.attributes.delete(name); this.ownerDocument.notify(); }
  appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; this.ownerDocument.notify(); return child; }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentNode = null;
    this.ownerDocument.notify();
  }
  replaceWith(replacement) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    replacement.remove();
    parent.children[index] = replacement; replacement.parentNode = parent; this.parentNode = null;
    this.ownerDocument.notify();
  }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) { return query(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() { this.scrollCount++; }
  scrollBy(options) {
    this.scrollWrites.push({ ...options });
    this.scrollLeft = Math.min(Math.max(0, this.scrollWidth - this.clientWidth), Math.max(0, this.scrollLeft + (options.left || 0)));
    this.scrollTop = Math.min(Math.max(0, this.scrollHeight - this.clientHeight), Math.max(0, this.scrollTop + (options.top || 0)));
  }
  focus() {
    this.focusCount++;
    const root = this.getRootNode();
    if (root?.host) { root.activeElement = this; this.ownerDocument.activeElement = root.host; }
    else this.ownerDocument.activeElement = this;
  }
  cloneNode(deep) {
    const clone = new TestElement(this.ownerDocument, this.tagName, {
      attrs: Object.fromEntries(this.attributes), text: this._text, rect: { ...this.rect },
      style: { ...this.style }, disabled: this.disabled, readOnly: this.readOnly, editable: this.isContentEditable,
    });
    clone._value = this._value;
    if (deep) for (const child of this.children) clone.appendChild(child.cloneNode(true));
    return clone;
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('');
    const tag = this.tagName.toLowerCase();
    const contents = escapeHtml(this._text) + this.children.map((child) => child.outerHTML).join('');
    return `<${tag}${attrs}>${contents}</${tag}>`;
  }
  attachShadow() { this.shadowRoot = new TestShadowRoot(this.ownerDocument, this); return this.shadowRoot; }
}

class TestShadowRoot {
  constructor(document, host) { this.ownerDocument = document; this.host = host; this.nodeType = 11; this.children = []; this.activeElement = null; }
  appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); this.ownerDocument.notify(); return child; }
  querySelectorAll(selector) { return query(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  elementFromPoint(x, y) { return this.ownerDocument.hitOverride ?? hit(this, x, y); }
}

function descendants(root) {
  const result = [];
  const visit = (node) => { for (const child of node.children || []) { result.push(child); visit(child); } };
  visit(root);
  return result;
}
function matches(element, selector) {
  const value = selector.trim();
  if (value === '*') return true;
  if (value === ':disabled') return element.disabled;
  if (value.startsWith('#')) return element.id === value.slice(1);
  if (value.startsWith('.')) return (element.getAttribute('class') || '').split(/\s+/).includes(value.slice(1));
  const attribute = /^(?:([a-z]+))?\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(value);
  if (attribute) return (!attribute[1] || element.tagName.toLowerCase() === attribute[1])
    && element.getAttribute(attribute[2]) !== null && (attribute[3] === undefined || element.getAttribute(attribute[2]) === attribute[3]);
  if (/^[a-z]+$/i.test(value)) return element.tagName.toLowerCase() === value.toLowerCase();
  throw new Error('Unsupported or invalid test selector');
}
function query(root, selector) {
  if (typeof selector !== 'string' || !selector || selector === '[' || selector.includes('???')) throw new Error('Invalid selector');
  const selectors = selector.split(',');
  // Validate even when there are no elements, as querySelectorAll does.
  for (const item of selectors) matches({ id: '', tagName: '', disabled: false, getAttribute: () => null }, item);
  return descendants(root).filter((element) => selectors.some((item) => matches(element, item)));
}
function hit(root, x, y) {
  const elements = descendants(root).filter((element) => {
    const rect = element.rect;
    return element.isConnected && element.style.display !== 'none' && element.style.visibility !== 'hidden'
      && element.style.pointerEvents !== 'none' && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
  return elements.at(-1) || null;
}

export function createPageVm({ url = 'http://127.0.0.1:9876/fixture', title = 'VM fixture' } = {}) {
  const observers = new Set();
  const timers = new Set();
  const location = { href: url };
  const document = {
    nodeType: 9, children: [], location, title, activeElement: null, hitOverride: null,
    notify() {
      for (const observer of observers) if (observer.observed && !observer.queued) {
        observer.queued = true;
        queueMicrotask(() => { observer.queued = false; if (observer.observed) observer.callback([], observer); });
      }
    },
    querySelectorAll(selector) { return query(this, selector); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    createElement(tag) { return new TestElement(this, tag); },
    elementFromPoint(x, y) { return this.hitOverride ?? hit(this, x, y); },
  };
  const html = new TestElement(document, 'html');
  html.clientWidth = 1024; html.clientHeight = 768;
  html.scrollWidth = 1024; html.scrollHeight = 768;
  html.parentNode = document; document.children.push(html); document.documentElement = html; document.scrollingElement = html;
  const body = new TestElement(document, 'body');
  html.appendChild(body); document.body = body; document.activeElement = body;
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.observed = false; this.queued = false; observers.add(this); }
    observe() { this.observed = true; }
    disconnect() { this.observed = false; observers.delete(this); }
  }
  const trackedSetTimeout = (callback, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return timer;
  };
  const trackedClearTimeout = (timer) => { timers.delete(timer); clearTimeout(timer); };
  const globals = {
    document, location, navigator: { platform: 'Win32' }, innerWidth: 1024, innerHeight: 768,
    getComputedStyle: (element) => element.style,
    MutationObserver, setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout, queueMicrotask,
  };
  const context = vm.createContext(globals);
  context.window = context;
  const evaluate = async (expression) => vm.runInContext(expression, context, { timeout: 2000 });
  const run = async (operation, args = {}) => JSON.parse(JSON.stringify(await evaluate(pageExpression(operation, args))));
  return {
    document, context, location, observers, timers, run, evaluate,
    add(tag, options = {}, parent = body) { return parent.appendChild(new TestElement(document, tag, options)); },
    dispose() { for (const timer of timers) clearTimeout(timer); timers.clear(); for (const observer of observers) observer.disconnect(); },
  };
}
