import http from 'node:http';

/** A public, deliberately fake credential. Never put real credentials in this fixture. */
export const PASSWORD_SENTINEL = 'fixture-password-DO-NOT-RETURN-7c41';
export const TITLE = 'mbrowser deterministic local fixture';

const FIXTURE_SCRIPT = String.raw`
(() => {
  'use strict';
  const events = [];
  const state = { clicks: 0, replacementClicks: 0, controlled: 'initial', changes: 0, events };
  const publish = () => {
    document.querySelector('#fixture-state').textContent = JSON.stringify(state);
    document.querySelector('#click-target').dataset.clicks = String(state.clicks);
    document.querySelector('#replaceable')?.setAttribute('data-clicks', String(state.replacementClicks));
    document.querySelector('#shadow-host').dataset.clicks = String(state.shadowClicks || 0);
  };
  const record = (event) => {
    const target = event.composedPath()[0];
    events.push({ type: event.type, id: target.id || '', trusted: event.isTrusted,
      inputType: event.inputType || null, key: event.key || null });
    publish();
  };
  for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click', 'beforeinput', 'input', 'change', 'keydown', 'keyup']) {
    document.addEventListener(name, record, true);
  }
  document.querySelector('#click-target').addEventListener('click', () => { state.clicks++; publish(); });
  const controlled = document.querySelector('#controlled');
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let trackedValue = valueDescriptor.get.call(controlled);
  // React-style value tracking: JS el.value= updates the tracker too; native input must bypass it.
  Object.defineProperty(controlled, 'value', {
    configurable: true,
    get() { return valueDescriptor.get.call(this); },
    set(value) { trackedValue = String(value); valueDescriptor.set.call(this, value); },
  });
  controlled.addEventListener('input', () => {
    const value = valueDescriptor.get.call(controlled);
    if (value !== trackedValue) { state.controlled = value; state.changes++; trackedValue = value; }
    document.querySelector('#controlled-output').textContent = state.controlled;
    publish();
  });
  document.querySelector('#form').addEventListener('submit', (event) => {
    event.preventDefault(); state.submitted = true; publish();
  });
  const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="shadow-button">Shadow action</button><input id="shadow-input" aria-label="Shadow input">';
  shadow.querySelector('button').addEventListener('click', () => { state.shadowClicks = (state.shadowClicks || 0) + 1; publish(); });
  window.fixture = {
    state,
    resetEvents() { events.length = 0; publish(); },
    replace() {
      const old = document.querySelector('#replaceable');
      const replacement = old.cloneNode(true);
      replacement.textContent = 'Replacement identity';
      replacement.addEventListener('click', () => { state.replacementClicks++; publish(); });
      old.replaceWith(replacement);
    },
    remove() { document.querySelector('#replaceable')?.remove(); },
    insert(id = 'delayed-target') {
      const item = document.createElement('button'); item.id = id;
      item.textContent = 'Inserted deterministically'; document.querySelector('#dynamic').append(item);
    },
    cover() { document.querySelector('#cover').hidden = false; },
    uncover() { document.querySelector('#cover').hidden = true; },
  };
  for (const [id, operation] of [['fixture-reset-events', 'resetEvents'], ['fixture-replace', 'replace'], ['fixture-insert', 'insert']]) {
    document.getElementById(id).addEventListener('click', () => window.fixture[operation]());
  }
  publish();
  // The target markup precedes this script. Expose readiness only after all event listeners exist.
  document.querySelector('#fixture-ready').hidden = false;
})();
`;

function fixturePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>
body { font: 16px/1.5 sans-serif; margin: 24px; }
button,input,textarea,[contenteditable] { padding: 8px; margin: 4px; }
section { margin: 12px 0; } #covered-box { position: relative; width: 300px; height: 60px; }
#cover { position: absolute; inset: 0; background: #aaa; z-index: 3; }
#cover[hidden] { display: none; } #below-fold { margin-top: 1600px; }
</style></head><body>
<h1>Only a local test page</h1><p id="public-text">Deterministic public observation text.</p>
<p id="fixture-ready" hidden>Fixture event handlers ready</p>
<section><button id="click-target">Trusted click target</button>
<button id="replaceable">Original identity</button>
<button class="ambiguous">Ambiguous one</button><button class="ambiguous">Ambiguous two</button>
<button id="disabled" disabled>Disabled target</button>
<button id="hidden" hidden>Hidden target</button></section>
<div id="covered-box"><button id="covered-target">Covered target</button><div id="cover">Blocking layer</div></div>
<form id="form"><label for="controlled">Controlled text</label>
<input id="controlled" value="initial" autocomplete="off"><output id="controlled-output">initial</output>
<label for="plain">Plain text</label><input id="plain" value="old text" autocomplete="off">
<label for="password">Password</label><input id="password" type="password" value="${PASSWORD_SENTINEL}" autocomplete="off">
<input id="readonly" value="unchanged" readonly><input id="disabled-input" value="unchanged" disabled>
<textarea id="textarea">initial multiline</textarea>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable text">old editable text</div>
<button id="submit" type="submit">Submit locally</button></form>
<div id="shadow-host"></div><div id="dynamic"></div>
<output id="fixture-state" hidden></output>
<button id="fixture-reset-events" hidden>Reset fixture events</button>
<button id="fixture-replace" hidden>Replace fixture node</button>
<button id="fixture-insert" hidden>Insert fixture node</button>
<a id="navigate" href="/next">Navigate locally</a>
<iframe id="local-frame" title="Local child frame" src="/frame"></iframe>
<button id="below-fold">Below fold target</button>
<script>${FIXTURE_SCRIPT}</script></body></html>`;
}

const SIMPLE_PAGES = {
  '/next': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local next page</title></head><body><h1 id="next">Navigation completed locally</h1><button id="replaceable">New document identity</button></body></html>',
  '/frame': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local frame</title></head><body><button id="frame-button">Frame action</button></body></html>',
};

/**
 * Start an ephemeral, IPv4-loopback-only server. No browser/profile access, external requests,
 * dependencies, wall-clock fixture behavior, or files are needed. close() is idempotent.
 */
export async function startFixture() {
  const requests = [];
  let origin;
  let closing;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 2000 }, (request, response) => {
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Unexpected Host');
      return;
    }
    const url = new URL(request.url, origin);
    requests.push({ method: request.method, pathname: url.pathname });
    const common = {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...common, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
      request.resume();
      return;
    }
    let body;
    let status = 200;
    let contentType = 'text/html; charset=utf-8';
    if (url.pathname === '/' || url.pathname === '/fixture') body = fixturePage();
    else if (url.pathname === '/health') {
      body = JSON.stringify({ name: 'mbrowser-test-fixture', version: 1 });
      contentType = 'application/json; charset=utf-8';
    } else if (Object.hasOwn(SIMPLE_PAGES, url.pathname)) body = SIMPLE_PAGES[url.pathname];
    else { status = 404; contentType = 'text/plain; charset=utf-8'; body = 'Not found'; }
    response.writeHead(status, { ...common, 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: `${origin}/fixture`,
    requests,
    address: () => server.address(),
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
