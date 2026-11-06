import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const file = path => new URL(`../${path}`, import.meta.url);

test('original icons are real PNGs in every declared Chrome size', async () => {
  const manifest = JSON.parse(await readFile(file('manifest.json'), 'utf8'));
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = await readFile(file(path));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), Number(size));
    assert.equal(png.readUInt32BE(20), Number(size));
    assert.ok(png.length > 100);
  }
});

test('Spanish pages resolve all local assets, have unique IDs and no inline or remote active content', async () => {
  const common = await readFile(file('ui.js'), 'utf8');
  for (const name of ['popup', 'options', 'panel']) {
    const html = await readFile(file(`${name}.html`), 'utf8');
    const js = await readFile(file(`${name}.js`), 'utf8');
    assert.match(html, /<html lang="es">/);
    assert.doesNotMatch(html, /\s(?:style|on[a-z]+)\s*=/i);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(match[1], /^(?:https?:|\/|\.\.)/);
      await access(file(match[1]));
    }
    for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(match[1], /type="module"/);
      assert.match(match[1], /src="[^"]+"/);
      assert.equal(match[2].trim(), '');
    }
    for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `${name} is missing #${match[1]}`);
    assert.doesNotMatch(js + common, /\b(?:innerHTML|outerHTML|document\.write|eval|Function|localStorage|sessionStorage)\b/);
    assert.doesNotMatch(js + common, /\b(?:fetch|WebSocket)\s*\(/);
    assert.doesNotMatch(js + common, /chrome\.storage/);
    for (const required of ['status-title', 'status-detail', 'status-dot', 'pause', 'resume', 'revoke', 'revoke-dialog', 'feedback', 'notice']) {
      assert.ok(ids.includes(required), `${name} is missing #${required}`);
    }
  }
  const css = await readFile(file('styles.css'), 'utf8');
  assert.doesNotMatch(css, /@import|https?:|data:/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});

test('initial form does not preapprove existing tabs, wildcard origins or consent', async () => {
  const html = await readFile(file('options.html'), 'utf8');
  assert.match(html, /name="scope" value="exact" checked/);
  for (const id of ['allow-existing', 'consent']) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag);
    assert.doesNotMatch(tag, /\bchecked\b/);
  }
  assert.match(html, /name="scope" value="all"/);
  assert.match(html, /id="all-origins-warning"[^>]*hidden/);
  assert.match(html, /no se puede ni se debe ocultar/);
});
