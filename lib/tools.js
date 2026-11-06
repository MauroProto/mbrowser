const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) };
const tab = { type: 'string', description: 'Authorized tab ID. Omit for this session’s current mbrowser tab.' };
const target = { type: 'string', description: 'Exact ref from the latest snapshot, or a unique CSS selector.' };
const limit = { type: 'integer', description: 'Output character limit: 1000–100000; default 30000.' };

/** Pure definitions: importable for schema/first-turn prompt measurement without starting a bridge. */
export function createToolDefinitions(run) {
  function define(action, description, properties = {}, required = [], timeoutMs = 35_000) {
    return {
      name: `mbrowser_${action}`,
      description,
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      output,
      timeoutMs,
      // Observations can change snapshots/current-tab state; preserve model ordering.
      isConcurrencySafe: () => false,
      execute: (args, exec) => run(action, args ?? {}, exec),
    };
  }
  return [
    define('status', 'Check the Chrome extension connection and authorization. The user connects it with /mbrowser.'),
    define('tabs', 'List tabs authorized for this agent. Active tabs are reserved for the user.'),
    define('open', 'Open a background tab. For a new site, ask the user to watch the mbrowser panel in Chrome before calling this tool. It waits for their approval there.', {
      url: { type: 'string', description: 'Absolute HTTP(S) URL. Each new origin requires approval in Chrome.' },
    }, ['url'], 70_000),
    define('navigate', 'Navigate a tab to an approved site. Use mbrowser_open for a new site that needs approval.', {
      tab_id: tab,
      url: { type: 'string', description: 'Absolute HTTP(S) destination within the authorized sites.' },
    }, ['url']),
    define('read', 'Read page text, sanitized HTML or the title. Password fields are redacted.', {
      tab_id: tab,
      mode: { type: 'string', enum: ['text', 'html', 'title'], description: 'Default text.' },
      max_chars: limit,
    }),
    define('snapshot', 'Inspect visible page controls and receive stable element refs for interaction.', { tab_id: tab }),
    define('click', 'Click a visible, enabled, unobstructed page element without moving the OS pointer.', {
      tab_id: tab, selector: target,
    }, ['selector']),
    define('type', 'Replace an editable field’s contents using browser input. Typed text is not returned.', {
      tab_id: tab, selector: target,
      text: { type: 'string', description: 'Replacement text, including an empty string to clear the field.' },
    }, ['selector', 'text']),
    define('press', 'Send a key or keyboard chord to an authorized tab.', {
      tab_id: tab,
      key: { type: 'string', description: 'Key or chord, e.g. Enter, Escape, Tab, ArrowDown or Control+A.' },
      selector: { ...target, description: `${target.description} Omit to use the focused element.` },
    }, ['key']),
    define('scroll', 'Scroll top-frame content without activating the tab. Returns observed movement; no wheel events, iframe traversal or chaining past the nearest scroll container.', {
      tab_id: tab,
      selector: { ...target, description: `${target.description} The target must already be visible.` },
      x: { type: 'number', description: 'Viewport CSS x coordinate; requires y and no selector. Default viewport center.' },
      y: { type: 'number', description: 'Viewport CSS y coordinate; requires x and no selector.' },
      delta_x: { type: 'number', description: 'Horizontal CSS pixel delta; default 0.' },
      delta_y: { type: 'number', description: 'Vertical CSS pixel delta; positive scrolls down. Default 600.' },
    }),
    define('wait', 'Wait for a visible page element without repeatedly opening connections.', {
      tab_id: tab,
      selector: { type: 'string', description: 'CSS selector of the element to wait for.' },
      timeout_ms: { type: 'integer', description: 'Wait limit: 1–60000 ms; default 15000.' },
    }, ['selector'], 70_000),
    define('close', 'Close only a tab created by mbrowser in this session; never a user-created tab.', { tab_id: tab }),
  ];
}
