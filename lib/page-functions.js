/**
 * Self-contained functions evaluated in a per-scope, top-frame isolated world.
 * Never put element identifiers in page attributes: references hold the actual Node.
 * This module deliberately has no dependencies so it can also be exercised in a VM.
 */
export function createRedactor(secrets) {
  const literals = [...secrets].sort((a, b) => b.length - a.length)
    .map(secret => secret.replace(/[.*+?^$\u007b\u007d()|[\]\\]/g, '\\$&'));
  const pattern = literals.length ? new RegExp(literals.join('|'), 'g') : null;
  return (value, limit) => {
    const source = String(value);
    if (!pattern) return source.slice(0, limit);
    let result = '';
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      result += source.slice(cursor, Math.min(match.index, cursor + limit - result.length));
      if (result.length >= limit) return result;
      result += '[REDACTED]';
      if (result.length >= limit) return result.slice(0, limit);
      cursor = match.index + match[0].length;
    }
    return result + source.slice(cursor, cursor + limit - result.length);
  };
}

export async function pageOperation(operation, args = {}, redactorFactory = createRedactor) {
  const REDACTED = '[REDACTED]';
  const maxChars = Math.max(1000, Math.min(100000, Number(args.maxChars) || 30000));
  const stateKey = typeof args.stateKey === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,160}$/.test(args.stateKey)
    ? args.stateKey : '__mbrowser_page_state';
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  let state;

  try {
    const existing = Object.getOwnPropertyDescriptor(globalThis, stateKey)?.value;
    if (existing && existing.document === document && existing.actions instanceof Map) {
      state = existing;
    } else {
      state = { document, snapshot: null, actions: new Map(), secrets: new Set(), overlay: null, overlayTimer: null };
      Object.defineProperty(globalThis, stateKey, { value: state, configurable: true });
    }

    const roots = () => {
      const found = [document];
      for (let i = 0; i < found.length; i++) {
        for (const element of found[i].querySelectorAll('*')) {
          if (element.shadowRoot && !found.includes(element.shadowRoot)) found.push(element.shadowRoot);
        }
      }
      return found;
    };
    const query = (selector) => {
      const found = new Set();
      for (const root of roots()) for (const element of root.querySelectorAll(selector)) found.add(element);
      return [...found];
    };
    const isSensitive = (element) => {
      const type = String(element.type || element.getAttribute?.('type') || '').toLowerCase();
      const autocomplete = String(element.getAttribute?.('autocomplete') || '').toLowerCase();
      return type === 'password' || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/.test(autocomplete);
    };
    const remember = (value) => {
      if (typeof value !== 'string' || !value || state.secrets.has(value)) return;
      // Fail closed instead of silently returning an untracked oversized/overflow password.
      if (value.length > 100000 || state.secrets.size >= 256) throw new Error('Sensitive value capacity exceeded');
      state.secrets.add(value);
    };
    const fieldSelector = 'input, textarea, [contenteditable]';
    const captureSecrets = () => {
      for (const element of query(fieldSelector)) {
        if (!isSensitive(element)) continue;
        remember(element.value);
        remember(element.defaultValue);
        remember(element.getAttribute('value'));
        if (element.tagName?.toLowerCase() === 'textarea' || element.isContentEditable) {
          remember(element.textContent);
          remember(element.innerText);
        }
      }
    };
    captureSecrets();
    const finish = (value) => {
      captureSecrets();
      const redactString = redactorFactory(state.secrets);
      // Charge JSON structure and primitives as well as text. Reserve room for the truncation flag.
      let budget = maxChars - 64;
      let truncated = false;
      const OMIT = Symbol('omit');
      const seen = new WeakSet();
      const spend = (count) => {
        if (count > budget) { truncated = true; return false; }
        budget -= count;
        return true;
      };
      const text = (value) => {
        const full = redactString(value, maxChars + 1);
        const cost = JSON.stringify(full).length;
        if (spend(cost)) return full;
        if (budget < 2) return OMIT;
        // Escapes count too (including control characters and surrogate pairs).
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
      const clean = (item, depth = 0) => {
        if (item == null) return spend(4) ? null : OMIT;
        if (typeof item === 'string') return text(item);
        if (typeof item === 'boolean') return spend(item ? 4 : 5) ? item : OMIT;
        if (typeof item === 'number') return Number.isFinite(item) ? (spend(String(item).length) ? item : OMIT) : text(String(item));
        if (typeof item === 'bigint') return text(String(item));
        if (typeof item !== 'object') return text(`[${typeof item}]`);
        if (depth > 12 || budget <= 0) { truncated = true; return OMIT; }
        if (seen.has(item)) return text('[Circular]');
        seen.add(item);
        const nodeDescriptor = Object.getOwnPropertyDescriptor(item, 'nodeType');
        const isNode = typeof Node === 'function' ? item instanceof Node : nodeDescriptor && 'value' in nodeDescriptor && typeof nodeDescriptor.value === 'number';
        if (isNode) {
          return clean({ node: String(item.nodeName || 'Node').toLowerCase(), text: isSensitive(item) ? REDACTED : (item.innerText || item.textContent || '') }, depth + 1);
        }
        if (!spend(2)) return OMIT;
        if (Array.isArray(item)) {
          const out = [];
          const count = Math.min(item.length, 1000);
          for (let i = 0; i < count; i++) {
            if (out.length && !spend(1)) break;
            const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
            const entry = clean(descriptor && !('value' in descriptor) ? '[Accessor]' : descriptor?.value, depth + 1);
            if (entry === OMIT) break;
            out.push(entry);
          }
          if (out.length < item.length) truncated = true;
          return out;
        }
        const out = Object.create(null);
        let count = 0;
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor?.enumerable) continue;
          if (++count > 1000 || budget < 8) { truncated = true; break; }
          if (count > 1 && !spend(1)) break;
          const safeKey = text(key.slice(0, 200));
          if (safeKey === OMIT || !spend(1)) break;
          const entry = clean(/^(?:password|passwd|passwords)$/i.test(key)
            ? REDACTED : ('value' in descriptor ? descriptor.value : '[Accessor]'), depth + 1);
          if (entry === OMIT) break;
          Object.defineProperty(out, safeKey, { value: entry, enumerable: true, configurable: true });
        }
        return out;
      };
      const result = clean(value);
      if (truncated && result && result !== OMIT && !Array.isArray(result) && typeof result === 'object') result.truncated = true;
      return result === OMIT ? { ok: true, truncated: true } : result;
    };
    const parent = (node) => node?.assignedSlot || node?.parentElement || node?.getRootNode?.()?.host || null;
    const contains = (outer, inner) => {
      for (let node = inner; node; node = parent(node)) if (node === outer) return true;
      return false;
    };
    const disabled = (element) => {
      if (element.disabled === true) return true;
      try { if (element.matches(':disabled')) return true; } catch { /* unsupported pseudo-class */ }
      for (let node = element; node; node = parent(node)) {
        if (node.inert || node.getAttribute?.('aria-disabled') === 'true') return true;
      }
      return false;
    };
    const visible = (element) => {
      if (!element.isConnected || element.ownerDocument !== document) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      for (let node = element; node; node = parent(node)) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const fingerprint = (element) => JSON.stringify([
      element.tagName, element.getAttribute('type'), element.getAttribute('role'), element.getAttribute('id'),
      element.getAttribute('href'), element.getAttribute('name'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('autocomplete'), element.getAttribute('formaction'), element.getAttribute('contenteditable'),
      element.getAttribute('title'), (/^(?:input|textarea)$/i.test(element.tagName) || element.isContentEditable) ? '' : String(element.innerText || element.textContent || '').trim().slice(0, 500),
    ]);
    const description = (element, includeValue = false) => {
      const sensitive = isSensitive(element);
      const tag = String(element.tagName || '').toLowerCase();
      const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || '';
      const rawText = sensitive ? label : element.innerText || (typeof element.value === 'string' ? element.value : '') || label;
      const result = {
        tag,
        text: String(rawText).trim().replace(/\s+/g, ' ').slice(0, 200),
      };
      if (element.type) result.type = String(element.type);
      const role = element.getAttribute('role');
      if (role) result.role = role;
      if (element.href) result.href = String(element.href);
      const placeholder = element.getAttribute('placeholder');
      if (placeholder) result.placeholder = placeholder;
      if (includeValue && typeof element.value === 'string' && (sensitive || element.value)) {
        result.value = sensitive ? REDACTED : element.value.slice(0, 300);
      }
      if (sensitive) result.sensitive = true;
      if (disabled(element)) result.disabled = true;
      if (element.readOnly === true) result.readonly = true;
      if (typeof element.checked === 'boolean') result.checked = element.checked;
      return result;
    };
    const resolve = (selector) => {
      if (typeof selector !== 'string' || !selector || selector.length > 10000) return fail('INVALID_ARGUMENT', 'A selector or exact snapshot reference is required.');
      if (selector.startsWith('@')) {
        const match = /^@([A-Za-z0-9_-]{1,128}):(\d{1,8})$/.exec(selector);
        const snapshot = state.snapshot;
        if (!match || !snapshot || match[1] !== snapshot.id || snapshot.document !== document || snapshot.url !== location.href) {
          return fail('STALE_REFERENCE', 'Snapshot reference is stale. Take a new snapshot and use its exact ref.');
        }
        const entry = snapshot.elements[Number(match[2])];
        if (!entry || !entry.element.isConnected || entry.element.ownerDocument !== document || entry.fingerprint !== fingerprint(entry.element)) {
          return fail('STALE_REFERENCE', 'The referenced element was removed or changed. Take a new snapshot.');
        }
        return { element: entry.element };
      }
      let matches;
      try { matches = query(selector); } catch { return fail('INVALID_SELECTOR', 'The CSS selector is invalid.'); }
      if (matches.length === 0) return fail('ELEMENT_NOT_FOUND', 'No element matches the selector.');
      if (matches.length !== 1) return fail('AMBIGUOUS_SELECTOR', 'The selector matches more than one element. Use an exact snapshot ref or a unique selector.');
      return { element: matches[0] };
    };
    const editable = (element) => {
      const tag = String(element.tagName || '').toLowerCase();
      if (element.readOnly || element.getAttribute('aria-readonly') === 'true') return false;
      if (element.isContentEditable) return true;
      if (tag === 'textarea') return true;
      return tag === 'input' && /^(?:text|search|url|tel|email|password|number)$/.test(String(element.type || 'text').toLowerCase());
    };
    const hitAt = (x, y) => {
      let hit = document.elementFromPoint(x, y);
      const visited = new Set();
      while (hit?.shadowRoot && !visited.has(hit)) {
        visited.add(hit);
        const inside = hit.shadowRoot.elementFromPoint?.(x, y);
        if (!inside || inside === hit) break;
        hit = inside;
      }
      return hit;
    };
    const embedded = element => /^(?:iframe|frame|object|embed|fencedframe|portal)$/i.test(element?.tagName || '');
    const embeddedTarget = () => fail('UNSUPPORTED_TARGET', 'Select a control in the main document, outside embedded frames.');
    const inputSafety = (element, key, modifiers = 0) => {
      const origins = args.inputOrigins;
      if (!origins) return null;
      const foreground = () => fail('BACKGROUND_ONLY', 'This control may open another window or a browser dialog.');
      const checkNavigation = (target, destination) => {
        const name = (target ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').trim().toLowerCase();
        if (name && !['_self', '_parent', '_top'].includes(name)) return foreground();
        let url;
        try { url = new URL(destination || location.href, document.baseURI || location.href); }
        catch { return foreground(); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return foreground();
        if (!origins.includes('*') && !origins.includes(url.origin)) {
          return fail('ORIGIN_DENIED', 'The destination of this control is outside the site grant.');
        }
        return null;
      };
      for (let node = element; node; node = parent(node)) {
        if (node.type === 'file' || node.control?.type === 'file') return foreground();
        if (/^(?:A|AREA)$/.test(node.tagName) && node.hasAttribute('href') && (!key || key === 'Enter')) {
          if (node.hasAttribute('download') || modifiers) return foreground();
          return checkNavigation(node.getAttribute('target'), node.getAttribute('href'));
        }
        const submit = ['submit', 'image'].includes(node.type) && (!key || key === 'Enter' || key === ' ');
        if (node.form && (submit || key === 'Enter')) {
          return checkNavigation(node.getAttribute('formtarget') ?? node.form.getAttribute('target'),
            node.getAttribute('formaction') ?? node.form.getAttribute('action'));
        }
      }
      return null;
    };
    const pointFor = (element, scroll = false) => {
      if (embedded(element)) return embeddedTarget();
      if (scroll) {
        try { element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); } catch { /* geometry checks remain mandatory */ }
      }
      if (!visible(element)) return fail('ELEMENT_NOT_VISIBLE', 'The element is not visible.');
      if (disabled(element)) return fail('ELEMENT_DISABLED', 'The element is disabled or inert.');
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth);
      const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight);
      const left = Math.max(0, rect.left ?? rect.x);
      const right = Math.min(width, (rect.right ?? (rect.x + rect.width)));
      const top = Math.max(0, rect.top ?? rect.y);
      const bottom = Math.min(height, (rect.bottom ?? (rect.y + rect.height)));
      if (right <= left || bottom <= top) return fail('ELEMENT_NOT_VISIBLE', 'The element is outside the viewport.');
      const insetX = Math.min(3, (right - left) / 4);
      const insetY = Math.min(3, (bottom - top) / 4);
      const candidates = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + insetX, top + insetY], [right - insetX, top + insetY],
        [left + insetX, bottom - insetY], [right - insetX, bottom - insetY],
      ];
      for (const [x, y] of candidates) {
        const hit = hitAt(x, y);
        if (!embedded(hit) && contains(element, hit)) return { x, y };
      }
      return fail('ELEMENT_OBSCURED', 'Another element obscures the target.');
    };
    const getAction = () => {
      const action = state.actions.get(args.actionId);
      if (!action || action.document !== document || action.url !== location.href || !action.element.isConnected
        || action.element.ownerDocument !== document || action.fingerprint !== fingerprint(action.element)) {
        return fail('STALE_REFERENCE', 'The action target changed or navigation occurred. Resolve the element again.');
      }
      return action;
    };
    const activeElement = () => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      return active;
    };

    if (operation === 'keyboardTarget') {
      const active = activeElement();
      return embedded(active) ? embeddedTarget() : inputSafety(active, args.key, args.modifiers) || { ok: true };
    }

    if (operation === 'scroll') {
      const dx = args.deltaX === undefined ? 0 : args.deltaX, dy = args.deltaY === undefined ? 600 : args.deltaY;
      const hasSelector = args.selector !== undefined;
      const hasX = args.x !== undefined, hasY = args.y !== undefined;
      if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 100000 || Math.abs(dy) > 100000
        || hasX !== hasY || (hasX && (!Number.isFinite(args.x) || !Number.isFinite(args.y)))
        || (hasSelector && (hasX || hasY))) {
        return fail('INVALID_ARGUMENT', 'Use a selector or paired coordinates, and finite bounded deltas.');
      }
      const width = window.innerWidth || document.documentElement?.clientWidth;
      const height = window.innerHeight || document.documentElement?.clientHeight;
      let element, at;
      if (hasSelector) {
        const resolved = resolve(args.selector);
        if (resolved.ok === false) return resolved;
        element = resolved.element;
        at = pointFor(element, false); // Never scrollIntoView before validating or scrolling.
        if (at.ok === false) return at;
      } else {
        at = { x: args.x ?? width / 2, y: args.y ?? height / 2 };
        if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || at.x < 0 || at.y < 0 || at.x >= width || at.y >= height) {
          return fail('INVALID_ARGUMENT', 'Scroll coordinates must be inside the top-frame viewport.');
        }
        element = hitAt(at.x, at.y);
        if (!element) return fail('ELEMENT_NOT_FOUND', 'No top-frame element was hit.');
      }
      if (embedded(element)) {
        return fail('UNSUPPORTED_TARGET', 'Select a top-frame scroll container instead of an embedded document.');
      }
      const root = document.scrollingElement;
      if (!root || root.ownerDocument !== document) return fail('PAGE_ERROR', 'The document has no available viewport scroll container.');
      const overflow = (style, axis) => style[axis === 'x' ? 'overflowX' : 'overflowY'] || style.overflow || 'visible';
      const rootStyle = getComputedStyle(root);
      const bodyStyle = document.body && getComputedStyle(document.body);
      // In standards HTML, visible root overflow propagates the rendered body's overflow to the viewport.
      // Do not scroll that body as a second container. In quirks mode scrollingElement may itself be body.
      const propagatedBody = root === document.documentElement && root.tagName === 'HTML'
        && overflow(rootStyle, 'x') === 'visible' && overflow(rootStyle, 'y') === 'visible'
        && bodyStyle && bodyStyle.display !== 'none' ? document.body : null;
      const viewportStyle = propagatedBody ? bodyStyle : rootStyle;
      const nearest = (axis, delta) => {
        if (!delta) return null;
        const visited = new Set();
        for (let node = element; node && node.ownerDocument === document && !visited.has(node); node = parent(node)) {
          visited.add(node);
          if (node === propagatedBody) continue;
          const style = node === root ? viewportStyle : getComputedStyle(node);
          // Boxless wrappers are not zero-range scroll containers. Inline non-replaced boxes have no client area.
          if (node !== root && (style.display === 'contents'
            || (style.display === 'inline' && node.clientWidth === 0 && node.clientHeight === 0))) continue;
          const value = overflow(style, axis);
          const eligible = node === root ? value !== 'hidden' && value !== 'clip' : /^(auto|scroll|overlay)$/.test(value);
          if (eligible && typeof node.scrollBy === 'function') return node;
        }
        return null;
      };
      // Plan once, per axis. A boundary/zero-range container does NOT fall through to its parent.
      const plan = new Map();
      for (const [axis, delta] of [['x', dx], ['y', dy]]) {
        const container = nearest(axis, delta);
        if (!container) continue;
        if (!plan.has(container)) plan.set(container, { left: 0, top: 0 });
        plan.get(container)[axis === 'x' ? 'left' : 'top'] = delta;
      }
      const scrollers = [];
      let movedX = 0, movedY = 0;
      for (const [container, delta] of plan) {
        const before = { x: container.scrollLeft, y: container.scrollTop };
        // Primary CSSOM operation, never a replay/fallback after native wheel ACK. Native clamping/RTL apply.
        container.scrollBy({ ...delta, behavior: 'instant' });
        const after = { x: container.scrollLeft, y: container.scrollTop };
        const applied = { x: after.x - before.x, y: after.y - before.y };
        movedX += applied.x; movedY += applied.y;
        scrollers.push({ target: container === root ? 'page' : 'element', before, after, applied });
      }
      return finish({ ok: true, method: 'dom', at, delta_x: dx, delta_y: dy,
        moved_x: movedX, moved_y: movedY, changed: movedX !== 0 || movedY !== 0, scrollers });
    }

    if (operation === 'snapshot') {
      const id = args.snapshotId;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return fail('INVALID_ARGUMENT', 'A snapshot generation is required.');
      const elements = [];
      const entries = [];
      const selector = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],[contenteditable=""],summary,label';
      for (const element of query(selector)) {
        if (element.type === 'hidden' || !visible(element)) continue;
        const i = entries.length;
        entries.push({ element, fingerprint: fingerprint(element) });
        elements.push({ i, ref: `@${id}:${i}`, ...description(element, true) });
        if (entries.length >= 200) break;
      }
      state.snapshot = { id, document, url: location.href, elements: entries };
      state.actions.clear();
      return finish({ ok: true, title: document.title, url: location.href, snapshot_id: id, elements });
    }

    if (operation === 'read') {
      const mode = args.mode || 'text';
      if (!['text', 'html', 'title'].includes(mode)) return fail('INVALID_ARGUMENT', 'Read mode must be text, html, or title.');
      let body = null;
      if (mode === 'text') body = document.body?.innerText || '';
      if (mode === 'html' && document.documentElement) {
        const clone = document.documentElement.cloneNode(true);
        const sourceFields = [...document.documentElement.querySelectorAll(fieldSelector)];
        const clonedFields = [...clone.querySelectorAll(fieldSelector)];
        for (let i = 0; i < sourceFields.length; i++) {
          if (!isSensitive(sourceFields[i]) || !clonedFields[i]) continue;
          clonedFields[i].setAttribute('value', REDACTED);
          if (String(clonedFields[i].tagName).toLowerCase() === 'textarea' || sourceFields[i].isContentEditable) {
            clonedFields[i].textContent = REDACTED;
          }
        }
        for (const node of clone.querySelectorAll('script, style, template, meta, input[type="hidden"]')) node.remove();
        body = clone.outerHTML;
      }
      return finish({ ok: true, title: document.title, url: location.href, body });
    }

    if (operation === 'js') {
      if (typeof args.code !== 'string' || !args.code.trim()) return fail('INVALID_ARGUMENT', 'JavaScript code is required.');
      try {
        const value = await (0, eval)(args.code);
        return finish({ ok: true, value: value === undefined ? null : value });
      } catch {
        captureSecrets();
        return fail('JS_ERROR', 'JavaScript evaluation failed. Exception text is omitted to protect sensitive page data.');
      }
    }

    if (operation === 'resolve') {
      const resolved = resolve(args.selector);
      if (resolved.error) return resolved;
      const element = resolved.element;
      if (args.editable && !editable(element)) {
        if (disabled(element)) return fail('ELEMENT_DISABLED', 'The element is disabled or inert.');
        return fail('ELEMENT_NOT_EDITABLE', 'The element is not an editable text field.');
      }
      const point = pointFor(element, args.scroll !== false);
      if (point.error) return point;
      const unsafe = inputSafety(hitAt(point.x, point.y));
      if (unsafe) return unsafe;
      if (state.actions.size >= 16) state.actions.delete(state.actions.keys().next().value);
      state.actions.set(args.actionId || 'action', {
        element, document, url: location.href, fingerprint: fingerprint(element), x: point.x, y: point.y, editable: !!args.editable,
      });
      return finish({ ok: true, ...description(element), at: point, editable: editable(element) });
    }

    if (operation === 'verify' || operation === 'focus') {
      const action = getAction();
      if (action.error) return action;
      if (disabled(action.element)) return fail('ELEMENT_DISABLED', 'The element is disabled or inert.');
      if (action.editable && !editable(action.element)) return fail('ELEMENT_NOT_EDITABLE', 'The element is no longer editable.');
      if (operation === 'focus') {
        if (args.focus === true) {
          try { action.element.focus({ preventScroll: true }); } catch { return fail('ELEMENT_NOT_FOCUSABLE', 'The element cannot receive keyboard input.'); }
        }
        const active = activeElement();
        if (active !== action.element && !(action.element.isContentEditable && contains(action.element, active))) {
          return fail('FOCUS_CHANGED', 'Keyboard focus is not on the intended element.');
        }
        const platform = String(navigator.userAgentData?.platform || navigator.platform || '');
        return finish({ ok: true, sensitive: isSensitive(action.element), select_modifier: /mac|iphone|ipad/i.test(platform) ? 4 : 2 });
      }
      const point = pointFor(action.element, false);
      if (point.error) return point;
      if (args.x !== undefined && (Math.abs(Number(args.x) - point.x) > 1 || Math.abs(Number(args.y) - point.y) > 1)) {
        // A different still-visible point is fine only when the original point still hits this exact Node.
        const hit = hitAt(Number(args.x), Number(args.y));
        if (embedded(hit) || !contains(action.element, hit)) return fail('STALE_REFERENCE', 'The target moved before input could be dispatched.');
      }
      const unsafe = inputSafety(hitAt(args.x ?? point.x, args.y ?? point.y));
      if (unsafe) return unsafe;
      return finish({ ok: true, at: point, ...description(action.element) });
    }

    if (operation === 'wait') {
      const timeout = Math.max(1, Math.min(120000, Number(args.timeoutMs) || 15000));
      const started = Date.now();
      const check = () => {
        const found = resolve(args.selector);
        if (!found.error && !visible(found.element)) return fail('ELEMENT_NOT_FOUND', 'The matching element is not visible yet.');
        return found;
      };
      const initial = check();
      if (!initial.error) return finish({ ok: true, elapsed_ms: 0, ...description(initial.element) });
      if (initial.error.code !== 'ELEMENT_NOT_FOUND') return initial;
      return await new Promise((resolvePromise) => {
        let done = false;
        let observer;
        let timer;
        const observed = new Set();
        const end = (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          observer?.disconnect();
          resolvePromise(result);
        };
        const observeRoots = () => {
          for (const root of roots()) {
            if (observed.has(root)) continue;
            observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
            observed.add(root);
          }
        };
        observer = new MutationObserver(() => {
          const found = check();
          if (!found.error) return end(finish({ ok: true, elapsed_ms: Date.now() - started, ...description(found.element) }));
          if (found.error.code !== 'ELEMENT_NOT_FOUND') return end(found);
          observeRoots();
        });
        observeRoots();
        timer = setTimeout(() => end(fail('TIMEOUT', 'Timed out waiting for a unique visible matching element.')), timeout);
        // Cover a mutation between the first query and installing the observer.
        const found = check();
        if (!found.error) end(finish({ ok: true, elapsed_ms: Date.now() - started, ...description(found.element) }));
        else if (found.error.code !== 'ELEMENT_NOT_FOUND') end(found);
      });
    }

    if (operation === 'viewport') {
      return finish({ ok: true, width: window.innerWidth || document.documentElement.clientWidth, height: window.innerHeight || document.documentElement.clientHeight });
    }

    if (operation === 'overlay') {
      // Best effort only: callers must ignore failure and must not wait for an animation.
      if (state.overlayTimer) clearTimeout(state.overlayTimer);
      state.overlay?.remove();
      const element = document.createElement('div');
      element.setAttribute('aria-hidden', 'true');
      element.style.cssText = `position:fixed;left:${Number(args.x) || 0}px;top:${Number(args.y) || 0}px;width:22px;height:22px;z-index:2147483647;pointer-events:none!important;contain:strict;border-radius:50%;border:3px solid white;box-shadow:0 0 0 2px #1f6feb,0 2px 8px #0006;background:#1f6febdd;transform:translate(-45%,-45%);`;
      const arrow = document.createElement('div');
      arrow.style.cssText = 'position:absolute;left:5px;top:4px;width:12px;height:14px;background:#fff;clip-path:polygon(0 0, 0 87%, 31% 65%, 52% 100%, 71% 88%, 52% 58%, 100% 58%);';
      element.appendChild(arrow);
      document.documentElement.appendChild(element);
      state.overlay = element;
      try { element.animate?.([{ opacity: 0.25, scale: '0.7' }, { opacity: 1, scale: '1' }], { duration: 180 }); } catch { /* illustration only */ }
      state.overlayTimer = setTimeout(() => { element.remove(); if (state.overlay === element) state.overlay = null; }, 1500);
      return { ok: true };
    }

    if (operation === 'cleanup') {
      if (state.overlayTimer) clearTimeout(state.overlayTimer);
      state.overlay?.remove();
      state.overlay = null;
      state.actions.clear();
      return { ok: true };
    }

    return fail('INVALID_ARGUMENT', 'Unknown page operation.');
  } catch {
    // Never serialize page exception messages: they may contain passwords or evaluated code.
    return fail('PAGE_ERROR', 'The page operation failed or its document changed. Retry with a new snapshot.');
  }
}

/** Safely embed only data and this self-contained function in Runtime.evaluate. */
export function pageExpression(operation, args = {}) {
  return `(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)},(${createRedactor.toString()}))`;
}
