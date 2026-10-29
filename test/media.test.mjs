import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AccioImages, mediaRequest } from '../src/media.mjs';
import { createApi } from '../src/server.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const auth = { context: async () => {}, token: async () => 'synthetic-accio-token', headers: () => ({ 'x-team-id': 'synthetic-team' }) };
const reply = data => Response.json({ success: true, data: { base64: png, mimeType: 'image/png', actualModel: 'synthetic-model', ...data } });

test('Accio generation uses the existing account and native media endpoint exactly once', async () => {
  let calls = 0;
  const images = new AccioImages(auth, async (url, options) => {
    calls++; assert.equal(url.href, 'https://phoenix-gw.alibaba.com/api/media/image/generate');
    const body = JSON.parse(options.body);
    assert.equal(body.accessToken, 'synthetic-accio-token'); assert.equal(body.operation, 'IMAGE_GENERATION');
    assert.equal(body.modelCode, 'gpt-image-2'); assert.equal(body.size, '1024x1024');
    assert.equal(options.headers['x-team-id'], 'synthetic-team'); assert.equal(options.redirect, 'error');
    assert.ok(body.requestId); assert.ok(body.messageId);
    return reply({ fallbackApplied: true });
  });
  const result = await images.generate({ prompt: 'a boat' }, false, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(result.data[0].b64_json, png); assert.equal(result.accio.backend, 'accio');
  assert.equal(result.accio.fallback_applied, true); assert.equal(JSON.stringify(result).includes('synthetic-accio-token'), false);
});

test('editing forwards the reference pixels and does not force a square crop', async () => {
  const images = new AccioImages(auth, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url.pathname, '/api/media/image/edit'); assert.equal(body.operation, 'IMAGE_EDIT');
    assert.deepEqual(body.referenceImages, [{ base64: png, mimeType: 'image/png' }]); assert.equal(body.size, undefined);
    return reply({});
  });
  await images.generate({ prompt: 'change only the boat', reference_images: [{ mime_type: 'image/png', data: png }] }, true);
  assert.equal(mediaRequest({ prompt: 'portrait', aspect_ratio: '9:16' }).size, undefined);
});

test('invalid models, batches and missing references fail before any upstream call', async () => {
  const images = new AccioImages(auth, () => assert.fail('must not generate'));
  for (const [body, edit] of [[{ prompt: 'x', model: 'image_standard' }, false], [{ prompt: 'x', n: 2 }, false],
    [{ prompt: 'x' }, true], [{ prompt: 'x', response_format: 'unknown' }, false], [{ prompt: 'x', stream: true }, false]]) {
    await assert.rejects(images.generate(body, edit), e => e.status === 400);
  }
});

for (const response of [() => new Response('private upstream details', { status: 500 }),
  () => Response.json({ success: false, code: 'IMAGE_IN_PROGRESS', message: 'private upstream details' })]) {
  test('failed or ambiguous image requests are never retried and raw errors stay private', async () => {
    let calls = 0;
    const images = new AccioImages(auth, async () => { calls++; return response(); });
    await assert.rejects(images.generate({ prompt: 'x' }, false), e => e.status === 502 && !e.message.includes('private'));
    assert.equal(calls, 1);
  });
}

test('empty or malformed images cannot become successful completions', async () => {
  for (const data of [{ base64: '' }, { base64: 'garbage' }, { mimeType: 'image/jpeg' }]) {
    const images = new AccioImages(auth, async () => reply(data));
    await assert.rejects(images.generate({ prompt: 'x' }, false), e => e.code === 'image_delivery_missing');
  }
});

test('URL delivery is explicit and never downloads the URL on the API server', async () => {
  const images = new AccioImages(auth, async () => reply({ url: 'https://example.invalid/image.png' }));
  const result = await images.generate({ prompt: 'x', response_format: 'url' }, false);
  assert.deepEqual(result.data, [{ url: 'https://example.invalid/image.png' }]);
});

test('HTTP image endpoints reuse local authentication and bypass the text model catalog', async t => {
  let received;
  const server = createApi({ key: 'synthetic-private-key', auth: {}, client: { resolve: () => assert.fail('not a text model') },
    images: { generate: async (body, edit, signal) => { received = { body, edit, signal }; return { data: [{ b64_json: png }] }; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/v1/images/edits`;
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) };
  assert.equal((await fetch(url, options)).status, 401);
  const response = await fetch(url, { ...options, headers: { ...options.headers, 'x-api-key': 'synthetic-private-key' } });
  assert.equal(response.status, 200); assert.equal(received.edit, true); assert.ok(received.signal instanceof AbortSignal);
  assert.equal((await response.json()).data[0].b64_json, png);
});
