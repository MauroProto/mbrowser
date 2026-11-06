import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

export async function temporaryWorkspace(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'mbrowser-test-'));
  const verified = resolve(directory);
  assert.equal(dirname(verified), parent);
  assert.ok(basename(verified).startsWith('mbrowser-test-'));
  t.after(async () => {
    // Delete only the captured, verified absolute directory created by this exact test.
    assert.equal(resolve(directory), verified);
    assert.equal(dirname(verified), parent);
    assert.ok(basename(verified).startsWith('mbrowser-test-'));
    await rm(verified, { recursive: true, force: true });
  });
  return verified;
}
