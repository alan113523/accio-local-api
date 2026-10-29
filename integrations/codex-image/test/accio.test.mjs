import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAccio, accioEndpoint } from '../src/accio.mjs';
import { ImageJobs } from '../src/jobs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const key = 'accio-local-' + 'a'.repeat(64);
async function fixture() {
  const root = await mkdtemp(join(here, 'run-')), keyFile = join(root, 'api.key');
  await writeFile(keyFile, key);
  return { root, settings: { backend: 'accio', accioApiKeyFile: keyFile, stateDir: join(root, 'state'), outputDir: root } };
}

test('Accio-only backend produces a real file without a Codex executable', async () => {
  const { root, settings } = await fixture(); let calls = 0;
  const result = await generateAccio({ finalPrompt: 'a boat', outDir: root, backendSettings: { ...settings, codexBin: '/not-installed' } }, async (url, options) => {
    calls++; assert.equal(url.href, 'http://127.0.0.1:18437/v1/images/generations');
    assert.equal(options.headers['x-api-key'], key); assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'gpt-image-2');
    return Response.json({ data: [{ b64_json: png }], accio: { actual_model: 'synthetic-image-model' } });
  });
  assert.equal(calls, 1); assert.deepEqual(result.images[0].dimensions, { width: 2, height: 1 });
  assert.equal(result.images[0].backend, 'accio'); assert.deepEqual(await readFile(result.images[0].path), Buffer.from(png, 'base64'));
});

test('Accio edit passes actual pixels using the local edits endpoint', async () => {
  const { root, settings } = await fixture(), reference = join(root, 'reference.png'); await writeFile(reference, Buffer.from(png, 'base64'));
  await generateAccio({ finalPrompt: 'edit it', referenceImages: [reference], outDir: root, backendSettings: settings }, async (url, options) => {
    assert.equal(url.pathname, '/v1/images/edits');
    assert.deepEqual(JSON.parse(options.body).reference_images, [{ mime_type: 'image/png', data: png }]);
    return Response.json({ data: [{ b64_json: png }] });
  });
});

test('private local API keys cannot be sent to a remote or credential-bearing base URL', async () => {
  for (const base of ['https://example.invalid', 'http://example.invalid', 'http://user:password@127.0.0.1:18437', 'http://127.0.0.1:18437/other']) {
    assert.throws(() => accioEndpoint(base, false), /local http/);
    await assert.rejects(generateAccio({ finalPrompt: 'x', backendSettings: { accioBaseUrl: base } }), /local http/);
  }
});

test('Accio errors or missing images do not fall back to Codex or retry generation', async () => {
  const { root, settings } = await fixture();
  for (const response of [() => Response.json({ error: { message: 'not logged in' } }, { status: 401 }), () => Response.json({ data: [] })]) {
    let calls = 0;
    await assert.rejects(generateAccio({ finalPrompt: 'x', outDir: root, backendSettings: settings }, async () => { calls++; return response(); }));
    assert.equal(calls, 1);
  }
});

test('image jobs expose backend selection and preserve it in completed results', async () => {
  const { root, settings } = await fixture();
  const jobs = new ImageJobs(settings, async options => {
    assert.equal(options.backendSettings.backend, 'accio');
    return { images: [{ path: join(root, 'result.png'), size: 9999999, backend: 'accio' }], failures: [] };
  });
  const submitted = await jobs.call('image_generate', { prompt: 'x' });
  assert.equal(submitted.structuredContent.backend, 'accio');
  const id = submitted.structuredContent.job_id; await jobs.active.get(id).pending;
  assert.equal((await jobs.call('image_status', { job_id: id, include_image: false })).structuredContent.backend, 'accio');
  assert.equal((await jobs.call('image_generate', { prompt: 'x', backend: 'invalid' })).isError, true);
});
