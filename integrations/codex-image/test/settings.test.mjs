import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from '../src/settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
test('a fresh checkout starts with portable settings and no private config', async () => {
  const root = await mkdtemp(join(here, 'run-'));
  const settings = await loadSettings(join(root, 'missing.json'));
  assert.equal(settings.backend, 'codex');
  assert.equal(settings.accioBaseUrl, 'http://127.0.0.1:18437');
  assert.equal(settings.accioApiKeyFile.endsWith('api.key'), true);
  assert.equal(settings.codexBin, 'codex');
  assert.equal(settings.stateDir, join(root, 'state'));
  assert.equal(settings.outputDir, join(root, 'output'));
});
test('user paths resolve against their config, and malformed config stays visible', async () => {
  const root = await mkdtemp(join(here, 'run-')), configPath = join(root, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ backend: 'accio', accioApiKeyFile: './private/api.key', codexBin: process.execPath, stateDir: './jobs', outputDir: '../images' }));
  const settings = await loadSettings(configPath);
  assert.equal(settings.codexBin, process.execPath);
  assert.equal(settings.backend, 'accio');
  assert.equal(settings.accioApiKeyFile, join(root, 'private/api.key'));
  assert.equal(settings.stateDir, join(root, 'jobs'));
  assert.equal(settings.outputDir, join(root, '../images'));
  await writeFile(configPath, '{broken');
  await assert.rejects(loadSettings(configPath), SyntaxError);
});
