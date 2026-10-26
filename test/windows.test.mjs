import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainStore } from '../src/auth.mjs';
import { apiKey } from '../src/server.mjs';

test('Windows DPAPI stores only this bridge grant encrypted and rejects corruption', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accio-dpapi-test-'));
  const previous = process.env.ACCIO_API_STATE_DIR;
  process.env.ACCIO_API_STATE_DIR = directory;
  try {
    const store = new KeychainStore();
    assert.equal(await store.read(), null);
    const synthetic = { accessToken: 'synthetic-access-only', refreshToken: 'synthetic-refresh-only', expiresAt: 12345678 };
    await store.write(synthetic);
    assert.deepEqual(await store.read(), synthetic);
    assert.equal((await readFile(join(directory, 'oauth.dpapi'))).includes(Buffer.from(synthetic.accessToken)), false);
    await store.write({ ...synthetic, accessToken: 'synthetic-replacement' });
    assert.equal((await store.read()).accessToken, 'synthetic-replacement');
    await writeFile(join(directory, 'oauth.dpapi'), 'corrupt');
    await assert.rejects(store.read(), error => error.code === 'keychain_error');
  } finally {
    if (previous === undefined) delete process.env.ACCIO_API_STATE_DIR;
    else process.env.ACCIO_API_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows creates and reuses its own local API key', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accio-key-test-'));
  try {
    const key = await apiKey(directory);
    assert.match(key, /^accio-local-[a-f0-9]{64}$/);
    assert.equal(await apiKey(directory), key);
    await writeFile(join(directory, 'api.key'), 'invalid');
    await assert.rejects(apiKey(directory), /Invalid local API key/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
